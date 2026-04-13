const express = require('express');
const archiver = require('archiver');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();

// ── AI Provider Configuration ──
// Insights: Groq (free, fast) → fallback OpenRouter → fallback Anthropic
// Documents: OpenRouter (free) → fallback Groq → fallback Anthropic
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const ANTHROPIC_API_KEY_ENV = process.env.ANTHROPIC_API_KEY || '';

const PROVIDERS = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    key: GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    key: OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://job-application-tracker-hf1f.onrender.com',
      'X-Title': 'Applied Job Tracker',
    }),
  },
};

// Call an OpenAI-compatible provider
async function callOpenAI(provider, systemPrompt, userPrompt, maxTokens = 4000) {
  const cfg = PROVIDERS[provider];
  if (!cfg.key) throw new Error(`${provider} API key not configured`);
  const res = await fetchWithTimeout(cfg.baseUrl, {
    method: 'POST',
    headers: cfg.headers(cfg.key),
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    }),
  }, 90000);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${provider} error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Call Anthropic (fallback, no web search)
async function callAnthropic(systemPrompt, userPrompt, maxTokens = 4000) {
  if (!ANTHROPIC_API_KEY_ENV) throw new Error('ANTHROPIC_API_KEY not configured');
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY_ENV,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  }, 90000);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
}

// Try providers in order, return first success
async function callAI(preferredOrder, systemPrompt, userPrompt, maxTokens = 4000) {
  const errors = [];
  for (const provider of preferredOrder) {
    try {
      if (provider === 'anthropic') {
        return await callAnthropic(systemPrompt, userPrompt, maxTokens);
      }
      return await callOpenAI(provider, systemPrompt, userPrompt, maxTokens);
    } catch (e) {
      console.warn(`${provider} failed: ${e.message}`);
      errors.push(`${provider}: ${e.message}`);
    }
  }
  throw new Error('All AI providers failed: ' + errors.join(' | '));
}
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production-please';
// DATA_DIR: controlled by environment variable so disk mount path is explicit.
// On Render: set DATA_DIR to match your disk mount path exactly.
// If disk mounted at /app/data → DATA_DIR=/app/data
// If disk mounted at /app/backend/data → DATA_DIR=/app/backend/data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR);

// Multer: memory storage, 10MB max, PDF/Word/txt only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.pdf', '.doc', '.docx', '.txt'];
    if (allowedExts.includes(ext)) cb(null, true);
    else cb(new Error('Only PDF, Word (.doc/.docx), and .txt files are supported'));
  }
});

app.use(cors());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
// Serve static files with PWA-appropriate cache headers
app.use(express.static(path.join(__dirname, '../frontend/public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      // Service worker must not be cached by browser
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    } else if (filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.match(/\.(?:png|ico|jpg|svg)$/)) {
      // Icons can be cached for a day
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

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

// ── File text extraction ──
app.post('/api/parse-file', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  const buf = req.file.buffer;
  try {
    let text = '';
    if (ext === '.txt') {
      text = buf.toString('utf8');
    } else if (ext === '.pdf') {
      const data = await pdfParse(buf);
      text = data.text;
    } else if (ext === '.docx' || ext === '.doc') {
      try {
        const result = await mammoth.extractRawText({ buffer: buf });
        text = result.value;
      } catch(e) {
        return res.status(422).json({ error: 'Could not parse this Word file. Try saving as .docx or .txt.' });
      }
    }
    text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return res.status(422).json({ error: 'No text could be extracted. The file may be scanned or image-based.' });
    res.json({ name: req.file.originalname, size: req.file.size, text });
  } catch(e) {
    console.error('File parse error:', e.message);
    res.status(500).json({ error: 'Failed to parse file: ' + e.message });
  }
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


// ── Change password ──
app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const users = loadUsers();
  const userEntry = Object.values(users).find(u => u.id === req.user.id);
  if (!userEntry) return res.status(404).json({ error: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, userEntry.password);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  userEntry.password = await bcrypt.hash(newPassword, 12);
  saveUsers(users);
  res.json({ ok: true });
});

// ── Export all user data as zip ──
app.get('/api/export-data', authMiddleware, async (req, res) => {
  try {
    const userJobs = loadUserJobs(req.user.id);
    const archive = archiver('zip', { zlib: { level: 6 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="applied-export-${Date.now()}.zip"`);
    archive.pipe(res);

    for (const job of Object.values(userJobs)) {
      const safeName = `${job.company}_${job.title}`.replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 60);
      const folder = `${safeName}/`;

      // Job metadata as JSON
      const meta = {
        id: job.id, title: job.title, company: job.company,
        location: job.location, salary: job.salary, status: job.status,
        url: job.url, createdAt: new Date(job.createdAt).toISOString(),
        notes: (job.notes || []).map(n => ({
          date: new Date(n.ts).toISOString(),
          text: n.text
        }))
      };
      archive.append(JSON.stringify(meta, null, 2), { name: folder + 'job.json' });

      // Resume
      if (job.resume?.content) {
        const ext = job.resume.name?.split('.').pop() || 'txt';
        archive.append(job.resume.content, { name: folder + `resume.${ext}` });
      }

      // Cover letter
      if (job.cover?.content) {
        const ext = job.cover.name?.split('.').pop() || 'txt';
        archive.append(job.cover.content, { name: folder + `cover_letter.${ext}` });
      }

      // Tailored resume
      if (job.tailoredResume) {
        archive.append(job.tailoredResume, { name: folder + 'resume_tailored.txt' });
      }

      // Tailored cover letter
      if (job.tailoredCover) {
        archive.append(job.tailoredCover, { name: folder + 'cover_letter_tailored.txt' });
      }

      // Insights summary
      if (job.insights) {
        const insightsSummary = {
          generatedAt: job.insights.generatedAt ? new Date(job.insights.generatedAt).toISOString() : null,
          overview: job.insights.overview,
          companyOverview: job.insights.companyOverview,
          roleIntel: job.insights.roleIntel,
          flags: job.insights.flags,
          interviewTips: job.insights.interviewTips,
          culture: job.insights.culture ? {
            overallRating: job.insights.culture.overallRating,
            summary: job.insights.culture.summary
          } : null
        };
        archive.append(JSON.stringify(insightsSummary, null, 2), { name: folder + 'insights.json' });
      }

      // Notes as plain text
      if (job.notes?.length) {
        const notesText = job.notes.map(n =>
          `[${new Date(n.ts).toISOString()}]\n${n.text}\n`
        ).join('\n---\n\n');
        archive.append(notesText, { name: folder + 'notes.txt' });
      }
    }

    archive.finalize();
  } catch(e) {
    console.error('Export error:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── Delete account and all data ──
app.delete('/api/delete-account', authMiddleware, (req, res) => {
  try {
    const users = loadUsers();
    // Find and remove user
    const userKey = Object.keys(users).find(k => users[k].id === req.user.id);
    if (userKey) delete users[userKey];
    saveUsers(users);

    // Delete user's jobs file
    const jobsFile = path.join(JOBS_DIR, `${req.user.id}.json`);
    if (fs.existsSync(jobsFile)) fs.unlinkSync(jobsFile);

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI provider status check ──
app.get('/api/ai-status', authMiddleware, (req, res) => {
  res.json({
    groq: !!GROQ_API_KEY,
    openrouter: !!OPENROUTER_API_KEY,
    anthropic: !!ANTHROPIC_API_KEY_ENV,
  });
});

// ── Extract job fields from page text (OpenRouter → Groq → Anthropic) ──
app.post('/api/extract-fields', authMiddleware, async (req, res) => {
  const { url, text } = req.body;
  if (!text) return res.json(null);
  try {
    const result = await callAI(
      ['openrouter', 'groq', 'anthropic'],
      'Extract job details. Respond ONLY with valid JSON, no markdown. Fields: title, company, location, salary, remote (boolean). Use null if not found.',
      `URL: ${url}\n\nPage text:\n${text}`,
      300
    );
    const clean = result.replace(/```json|```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    res.json(match ? JSON.parse(match[0]) : null);
  } catch(e) {
    console.warn('extract-fields failed:', e.message);
    res.json(null);
  }
});

// ── Document tailoring (OpenRouter → Groq → Anthropic) ──
app.post('/api/tailor', authMiddleware, async (req, res) => {
  const { company, title, location, salary, postingText, resume, cover, context, tailorResume, tailorCover } = req.body;
  if (!tailorResume && !tailorCover) return res.status(400).json({ error: 'Select at least one document to tailor' });

  const parts = [];
  if (tailorResume && resume) parts.push('RESUME:\n' + resume);
  if (tailorCover && cover) parts.push('COVER LETTER TEMPLATE:\n' + cover);

  const jobCtx = postingText ? '\nJob posting content:\n' + postingText.slice(0, 3000) : '';
  const systemPrompt = 'You are a professional career coach and resume writer. Tailor job application documents to be compelling, specific, and keyword-optimized.';
  const userPrompt = `Tailor these documents for this role:

Company: ${company}
Role: ${title}
${location ? 'Location: ' + location : ''}
${salary ? 'Salary: ' + salary : ''}
${context ? 'Extra context: ' + context : ''}
${jobCtx}

Documents to tailor:

${parts.join('\n\n')}

Respond with clearly labeled sections: "TAILORED RESUME:" and/or "TAILORED COVER LETTER:". Make it compelling, specific, and keyword-optimized for this role.`;

  try {
    // OpenRouter first for documents, then Groq, then Anthropic
    const result = await callAI(['openrouter', 'groq', 'anthropic'], systemPrompt, userPrompt, 3000);
    res.json({ result });
  } catch (e) {
    console.error('Tailor error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Insights research endpoint ──
// Calls Anthropic API server-side with web_search tool, handles multi-turn tool loop
app.post('/api/insights', authMiddleware, async (req, res) => {
  const { company, title, location, salary, url, postingText, finnhubKey } = req.body;
  if (!company || !title) return res.status(400).json({ error: 'company and title required' });

  // ── 1. Fetch Finnhub stock data if key provided ──
  let stockData = null;
  if (finnhubKey) {
    try {
      const searchR = await fetchWithTimeout(
        `https://finnhub.io/api/v1/search?q=${encodeURIComponent(company)}&token=${finnhubKey}`
      );
      if (searchR.ok) {
        const sd = await searchR.json();
        const match = (sd.result || []).find(r => r.type === 'Common Stock' && r.symbol && !r.symbol.includes('.'));
        if (match) {
          const ticker = match.symbol;
          const [qR, pR, mR, tR] = await Promise.allSettled([
            fetchWithTimeout(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`),
            fetchWithTimeout(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubKey}`),
            fetchWithTimeout(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${finnhubKey}`),
            fetchWithTimeout(`https://finnhub.io/api/v1/stock/price-target?symbol=${ticker}&token=${finnhubKey}`),
          ]);
          const q = qR.status === 'fulfilled' && qR.value.ok ? await qR.value.json() : {};
          const p = pR.status === 'fulfilled' && pR.value.ok ? await pR.value.json() : {};
          const m = mR.status === 'fulfilled' && mR.value.ok ? await mR.value.json() : { metric: {} };
          const t = tR.status === 'fulfilled' && tR.value.ok ? await tR.value.json() : {};
          stockData = {
            ticker, price: q.c, change: q.d, changePct: q.dp,
            marketCap: p.marketCapitalization ? p.marketCapitalization * 1e6 : null,
            peRatio: m.metric?.peBasicExclExtraTTM,
            week52High: m.metric?.['52WeekHigh'],
            week52Low: m.metric?.['52WeekLow'],
            analystTarget: t.targetMean,
            recommendation: t.targetMean
              ? (q.c < t.targetMean ? 'Upside potential' : 'Trading above target')
              : null,
          };
        } else {
          stockData = { error: 'No public stock ticker found for this company' };
        }
      }
    } catch (e) {
      stockData = { error: 'Stock fetch failed: ' + e.message };
    }
  }

  // ── 2. Call AI (Groq → OpenRouter → Anthropic fallback) ──
  const today = new Date().toISOString().split('T')[0];
  const systemPrompt = `You are a career research assistant. Today is ${today}. You have strong knowledge of companies, industry trends, Glassdoor ratings, and job markets. Always return valid JSON only with no markdown.`;

  const userPrompt = `Research this job for a candidate who has applied:

Company: ${company}
Role: ${title}
Location: ${location || 'Not specified'}
Salary: ${salary || 'Not specified'}
Job URL: ${url || 'Not provided'}
${postingText ? `Job posting excerpt:\n${postingText.slice(0, 1500)}` : ''}

Search for: Glassdoor ratings, recent news, layoffs, funding, culture reviews, interview process, LinkedIn contacts to reach out to.

Return ONLY a valid JSON object with these exact fields (no markdown, no backticks):
{
  "overview": { "founded": "year", "employees": "range e.g. 5,000-10,000", "hq": "city, country", "industry": "sector" },
  "companyOverview": "3-4 paragraph overview: mission, business model, financial health, recent layoffs or growth, market position, key products. Use specific numbers.",
  "culture": {
    "overallRating": 3.8,
    "workLifeBalance": 3.5,
    "cultureValues": 4.0,
    "careerOpp": 3.2,
    "compensation": 3.8,
    "leadership": 3.1,
    "ceoApproval": 72,
    "recommend": 65,
    "numRatings": "~2,400",
    "summary": "2-3 paragraphs on what employees say about culture, management, work-life balance, growth opportunities."
  },
  "roleIntel": "3-4 paragraphs: how often this role has been posted (turnover signal?), typical day-to-day, career trajectory, interview difficulty, salary benchmarking.",
  "flags": {
    "green": ["4-6 genuine positives: financial stability, culture, growth, benefits"],
    "red": ["3-5 genuine concerns: layoffs, glassdoor issues, role reposted frequently, management problems"]
  },
  "linkedin": {
    "suggestedContacts": [
      {"name": "Type of person e.g. Hiring Manager", "role": "Specific role title at ${company}", "company": "${company}", "tip": "Why contact them and what to say"},
      {"name": "Type of person e.g. Recruiter", "role": "Technical Recruiter", "company": "${company}", "tip": "What to ask them"},
      {"name": "Type of person e.g. Team Peer", "role": "Peer-level engineer/role", "company": "${company}", "tip": "What to learn from them"}
    ],
    "outreachTip": "Specific timing and strategy for LinkedIn outreach at this company.",
    "messageTemplate": "Hi [Name],\\n\\nI recently applied for the ${title} role at ${company} and noticed your background — [specific observation].\\n\\nWould you be open to a quick 15-min chat about the team?\\n\\nThanks,\\n[Your name]"
  },
  "news": [
    {"headline": "Real recent headline", "source": "Source name", "date": "YYYY-MM-DD", "url": "https://real-url.com", "sentiment": "positive"},
    {"headline": "...", "source": "...", "date": "...", "url": "...", "sentiment": "negative"},
    {"headline": "...", "source": "...", "date": "...", "url": "...", "sentiment": "neutral"}
  ],
  "interviewTips": "4-5 paragraphs: interview stages and format at this company, what they look for, common questions, how to stand out. Be specific to this company and role."
}`;

  try {
    const finalText = await callAI(
      ['groq', 'openrouter', 'anthropic'],  // Insights: Groq first
      systemPrompt,
      userPrompt,
      5000
    );
    console.log('Insights response length:', finalText.length);
    if (!finalText) throw new Error('Empty response from AI');
    const cleaned = finalText.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON in response. Got: ' + finalText.slice(0, 200));
    const jsonStr = cleaned.slice(start, end + 1);
    const insights = JSON.parse(jsonStr);
    insights.generatedAt = Date.now();
    if (stockData) insights.stock = stockData;

    res.json(insights);
  } catch (e) {
    console.error('Insights error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Applied Tracker running on http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Users file: ${USERS_FILE}`);
  console.log(`Jobs directory: ${JOBS_DIR}`);
  // Warn if data dir doesn't look like a mounted disk
  const isDisk = DATA_DIR.startsWith('/app/data') || DATA_DIR.startsWith('/mnt');
  if (!isDisk) {
    console.warn('⚠️  DATA_DIR appears to be ephemeral. Set DATA_DIR env var to your Render disk mount path to persist data.');
  } else {
    console.log('✓  Data is stored on persistent disk.');
  }
});
