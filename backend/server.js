const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production-please';
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// --- Helpers ---
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function loadUserJobs(userId) {
  const file = path.join(JOBS_DIR, `${userId}.json`);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveUserJobs(userId, jobs) {
  const file = path.join(JOBS_DIR, `${userId}.json`);
  fs.writeFileSync(file, JSON.stringify(jobs, null, 2));
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Auth Routes ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = loadUsers();
  const key = username.toLowerCase().trim();
  if (users[key]) return res.status(409).json({ error: 'Username already taken' });

  const hashed = await bcrypt.hash(password, 12);
  const userId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  users[key] = { id: userId, username: username.trim(), password: hashed, createdAt: Date.now() };
  saveUsers(users);

  const token = jwt.sign({ id: userId, username: username.trim() }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: username.trim() });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = loadUsers();
  const key = username.toLowerCase().trim();
  const user = users[key];
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

// --- Jobs Routes ---
app.get('/api/jobs', authMiddleware, (req, res) => {
  res.json(loadUserJobs(req.user.id));
});

app.put('/api/jobs', authMiddleware, (req, res) => {
  const jobs = req.body;
  if (typeof jobs !== 'object') return res.status(400).json({ error: 'Invalid data' });
  saveUserJobs(req.user.id, jobs);
  res.json({ ok: true });
});

// ── Job URL parsing proxy ──
// Tries to extract job data intelligently based on ATS platform
app.post('/api/parse-job', authMiddleware, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const result = await parseJobFromUrl(url);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message, fields: {}, html: null, text: null });
  }
});

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    return r;
  } finally {
    clearTimeout(timer);
  }
}

async function parseJobFromUrl(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // ── Eightfold / Dexcom-style ATS ──
  if (hostname.includes('eightfold') || /\/careers\/job\/(\d+)/.test(parsed.pathname)) {
    const match = parsed.pathname.match(/\/careers\/job\/(\d+)/);
    if (match) {
      const jobId = match[1];
      const apiBase = `${parsed.protocol}//${parsed.hostname}`;
      try {
        const apiUrl = `${apiBase}/api/apply/v2/jobs/${jobId}?domain=${parsed.hostname.replace(/^careers\./,'')}`;
        const apiRes = await fetchWithTimeout(apiUrl, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (apiRes.ok) {
          const data = await apiRes.json();
          const job = data.job || data;

          // Description may be HTML or plain text
          const descHtml = job.job_description || job.description || job.desc || null;
          const descText = descHtml ? stripHtml(descHtml) : null;

          // Try many possible salary field names from Eightfold's API
          let salary = job.salary_range || job.compensation || job.pay_range
            || job.min_pay || job.salary || job.base_salary || null;

          // Format min/max pay fields into a range string
          if (!salary && (job.min_pay || job.max_pay)) {
            const min = job.min_pay ? `$${Number(job.min_pay).toLocaleString()}` : null;
            const max = job.max_pay ? `$${Number(job.max_pay).toLocaleString()}` : null;
            salary = [min, max].filter(Boolean).join(' – ');
          }

          // If still no salary, scan the job description text for dollar ranges
          if (!salary && descText) {
            salary = extractSalaryFromText(descText);
          }

          // Build location string — Eightfold may return city/state/country separately or as "location"
          let location = null;
          if (job.location && typeof job.location === 'string') {
            location = job.location;
          } else if (job.locations && Array.isArray(job.locations) && job.locations.length > 0) {
            location = job.locations.map(l => l.name || l.city || l).filter(Boolean).join(', ');
          } else {
            location = formatLocation(job.city, job.state, job.country);
          }

          return {
            fields: {
              title: job.name || job.title || null,
              company: job.company_name || job.company || extractCompanyFromHost(hostname),
              location,
              salary,
              remote: job.is_remote || job.work_location_option === 'remote'
                || (job.name || '').toLowerCase().includes('remote')
                || (location || '').toLowerCase().includes('remote') || false,
            },
            html: descHtml,
            text: descText,
          };
        }
      } catch(e) { console.error('Eightfold API error:', e.message); }
    }
  }

  // ── Greenhouse ──
  if (hostname.includes('greenhouse.io') || hostname.includes('boards.greenhouse')) {
    const match = url.match(/jobs\/(\d+)/);
    if (match) {
      try {
        const company = parsed.pathname.split('/')[1];
        const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${match[1]}`;
        const apiRes = await fetchWithTimeout(apiUrl);
        if (apiRes.ok) {
          const data = await apiRes.json();
          return {
            fields: {
              title: data.title || null,
              company: extractCompanyFromHost(hostname) || company,
              location: data.location?.name || null,
              salary: null, remote: null,
            },
            html: data.content || null,
            text: data.content ? stripHtml(data.content) : null,
          };
        }
      } catch(e) {}
    }
  }

  // ── Lever ──
  if (hostname.includes('jobs.lever.co')) {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      try {
        const company = parts[0], jobId = parts[1];
        const apiUrl = `https://api.lever.co/v0/postings/${company}/${jobId}`;
        const apiRes = await fetchWithTimeout(apiUrl);
        if (apiRes.ok) {
          const data = await apiRes.json();
          return {
            fields: {
              title: data.text || null,
              company: data.company || extractCompanyFromHost(hostname) || company,
              location: data.categories?.location || data.workplaceType || null,
              salary: data.salaryRange ? `${data.salaryRange.min}–${data.salaryRange.max}` : null,
              remote: data.workplaceType === 'remote',
            },
            html: data.descriptionBody || data.description || null,
            text: data.descriptionBody ? stripHtml(data.descriptionBody) : null,
          };
        }
      } catch(e) {}
    }
  }

  // ── Workday ──
  if (hostname.includes('myworkdayjobs.com') || hostname.includes('wd1.myworkday') || hostname.includes('wd3.myworkday')) {
    // Workday uses path like /company/job/Location/Title_JR123456
    const titleMatch = parsed.pathname.match(/\/([^/]+)\/job\/[^/]+\/([^/]+)/);
    if (titleMatch) {
      const rawTitle = titleMatch[2].replace(/_[A-Z0-9]+$/, '').replace(/-/g,' ').replace(/_/g,' ');
      return {
        fields: {
          title: toTitleCase(rawTitle),
          company: extractCompanyFromHost(hostname),
          location: null, salary: null, remote: null,
        },
        html: null, text: null,
      };
    }
  }

  // ── Indeed ──
  if (hostname.includes('indeed.com')) {
    const jk = parsed.searchParams.get('jk');
    if (jk) {
      try {
        const apiRes = await fetchWithTimeout(`https://www.indeed.com/viewjob?jk=${jk}&api=1`);
        if (apiRes.ok) {
          const text = await apiRes.text();
          const titleMatch = text.match(/"jobTitle":"([^"]+)"/);
          const compMatch  = text.match(/"companyName":"([^"]+)"/);
          const locMatch   = text.match(/"jobLocationCity":"([^"]+)"/);
          const stateMatch = text.match(/"jobLocationState":"([^"]+)"/);
          return {
            fields: {
              title: titleMatch?.[1] || null,
              company: compMatch?.[1] || null,
              location: locMatch ? `${locMatch[1]}${stateMatch ? ', '+stateMatch[1] : ''}` : null,
              salary: null, remote: null,
            },
            html: null, text: null,
          };
        }
      } catch(e) {}
    }
  }

  // ── Generic fallback: CORS proxy + heuristic scrape ──
  let html = null, text = null;
  const proxies = [
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
  ];

  for (const proxyUrl of proxies) {
    try {
      const pr = await fetchWithTimeout(proxyUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!pr.ok) continue;
      const pd = await pr.json();
      const raw = pd.contents || (typeof pd === 'string' ? pd : null);
      if (raw && raw.length > 500) {
        html = raw;
        text = stripHtml(raw).slice(0, 8000);
        break;
      }
    } catch(e) { continue; }
  }

  // Extract fields from JSON-LD structured data if present
  const fields = extractStructuredData(html) || { title: null, company: null, location: null, salary: null, remote: null };

  // Fill in company from hostname if missing
  if (!fields.company) fields.company = extractCompanyFromHost(hostname);

  // If no salary from structured data, scan the page text
  if (!fields.salary && text) {
    fields.salary = extractSalaryFromText(text);
  }

  return { fields, html, text };
}

function extractSalaryFromText(text) {
  if (!text) return null;

  // Match patterns like:
  // $231,100.00 - $385,100.00
  // $120,000 – $160,000
  // $120k - $160k
  // $50/hr - $75/hr
  // USD 120,000 to 160,000
  const patterns = [
    // $X,XXX.XX - $X,XXX.XX  (full dollar amounts with decimals)
    /\$[\d,]+(?:\.\d{2})?\s*[-–—to]+\s*\$[\d,]+(?:\.\d{2})?(?:\s*(?:per year|\/yr|annually|\/hour|\/hr))?/i,
    // $XXXk - $XXXk
    /\$\d+(?:\.\d+)?[kK]\s*[-–—to]+\s*\$\d+(?:\.\d+)?[kK]/i,
    // Single amount: $231,100
    /\$[\d,]{6,}(?:\.\d{2})?/,
    // Salary: $X label
    /(?:salary|compensation|pay)[:\s]+(\$[\d,k]+(?:\.\d{2})?(?:\s*[-–]\s*\$[\d,k]+(?:\.\d{2})?)?)/i,
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      // Clean up the match
      const raw = (m[1] || m[0]).trim();
      // Normalize dashes/en-dashes to " – "
      return raw.replace(/\s*[-–—]\s*/g, ' – ');
    }
  }
  return null;
}

function extractStructuredData(html) {
  if (!html) return null;
  const matches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (!matches) return null;
  for (const block of matches) {
    try {
      const json = block.replace(/<[^>]+>/g, '').trim();
      const data = JSON.parse(json);
      const job = data['@type'] === 'JobPosting' ? data : null;
      if (job) {
        let salary = null;
        const bs = job.baseSalary;
        if (bs?.value) {
          const v = bs.value;
          if (v.minValue && v.maxValue) {
            salary = `$${Number(v.minValue).toLocaleString()} – $${Number(v.maxValue).toLocaleString()}`;
          } else if (v.value) {
            salary = `$${Number(v.value).toLocaleString()}`;
          }
        }
        return {
          title: job.title || null,
          company: job.hiringOrganization?.name || null,
          location: job.jobLocation?.address?.addressLocality
            ? `${job.jobLocation.address.addressLocality}${job.jobLocation.address.addressRegion ? ', '+job.jobLocation.address.addressRegion : ''}`
            : null,
          salary,
          remote: job.jobLocationType === 'TELECOMMUTE' || false,
        };
      }
    } catch(e) {}
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatLocation(city, state, country) {
  if (!city && !state && !country) return null;
  const parts = [city, state, country].filter(Boolean);
  return parts.join(', ');
}

function extractCompanyFromHost(hostname) {
  const clean = hostname.replace(/^(careers|jobs|www)\./, '').split('.')[0];
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function toTitleCase(str) {
  return str.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Applied Tracker running on http://localhost:${PORT}`);
});
