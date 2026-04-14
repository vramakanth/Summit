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

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_MODEL = process.env.GOOGLE_MODEL || 'gemini-2.0-flash';

// ── Admin & Email config ──
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';

const APP_URL       = process.env.APP_URL || 'https://job-application-tracker-hf1f.onrender.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL    = process.env.FROM_EMAIL || 'Applied <noreply@applied.app>';
const resetTokens   = {};



async function sendMail(to, subject, html) {
  const mailer = getMailer();
  if (!mailer) throw new Error('Email not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS');
  await mailer.sendMail({ from: `"Applied Job Tracker" <${SMTP_FROM}>`, to, subject, html });
}

// Admin middleware


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

// OpenRouter free models to rotate through when rate limited
// Updated April 2026 — verified available via /api/v1/models
const OPENROUTER_FALLBACK_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',     // primary — Llama 3.3 70B
  'nvidia/nemotron-3-super-120b-a12b:free',      // 120B, 262K ctx
  'qwen/qwen3-next-80b-a3b-instruct:free',       // 80B, 262K ctx
  'google/gemma-4-31b-it:free',                  // 31B, 262K ctx
  'google/gemma-3-27b-it:free',                  // 27B, 131K ctx
  'openai/gpt-oss-20b:free',                     // 20B, 131K ctx (fallback)
];

// Call an OpenAI-compatible provider (Groq, OpenRouter)
async function callOpenAI(provider, systemPrompt, userPrompt, maxTokens = 4000) {
  const cfg = PROVIDERS[provider];
  if (!cfg.key) throw new Error(`${provider} API key not configured`);

  // For OpenRouter: try primary model then rotate through fallbacks on rate limit
  const modelsToTry = provider === 'openrouter'
    ? [cfg.model, ...OPENROUTER_FALLBACK_MODELS.filter(m => m !== cfg.model)]
    : [cfg.model];

  let lastErr = null;
  for (const model of modelsToTry) {
    try {
      const res = await fetchWithTimeout(cfg.baseUrl, {
        method: 'POST',
        headers: cfg.headers(cfg.key),
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
        }),
      }, 90000);

      if (!res.ok) {
        const errText = await res.text();
        // Rate limited or model quota — try next model
        if (res.status === 429 || res.status === 402 || errText.includes('rate limit') || errText.includes('quota')) {
          console.warn(`${provider} model ${model} rate limited, trying next...`);
          lastErr = new Error(`${provider}/${model} rate limited (${res.status})`);
          continue;
        }
        throw new Error(`${provider} error ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const result = data.choices?.[0]?.message?.content || '';
      if (result) {
        console.log(`${provider} success with model: ${model}`);
        return result;
      }
      lastErr = new Error(`${provider}/${model} returned empty response`);
    } catch(e) {
      if (e.message.includes('rate limit') || e.message.includes('quota')) {
        lastErr = e;
        continue;
      }
      throw e; // non-rate-limit errors bubble up immediately
    }
  }
  throw lastErr || new Error(`${provider}: all models exhausted`);
}

// Call Google Gemini (free tier — gemini-2.0-flash)
// Get free key at: https://aistudio.google.com/apikey
async function callGoogle(systemPrompt, userPrompt, maxTokens = 4000) {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
    }),
  }, 90000);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Try providers in order, return first success
// Order: Groq → OpenRouter → Google (all free)
async function callAI(preferredOrder, systemPrompt, userPrompt, maxTokens = 4000) {
  const errors = [];
  for (const provider of preferredOrder) {
    try {
      let result;
      if (provider === 'google') {
        result = await callGoogle(systemPrompt, userPrompt, maxTokens);
      } else {
        result = await callOpenAI(provider, systemPrompt, userPrompt, maxTokens);
      }
      console.log(`callAI: success via ${provider}`);
      return result;
    } catch (e) {
      console.warn(`callAI: ${provider} failed — ${e.message}`);
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
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email address required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = loadUsers();
  const key = username.toLowerCase().trim();
  if (users[key]) return res.status(409).json({ error: 'Username already taken' });

  const isAdmin = key === ADMIN_USERNAME.toLowerCase();
  const hashed = await bcrypt.hash(password, 12);
  const userId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  users[key] = { id: userId, username: username.trim(), email: email.toLowerCase().trim(), password: hashed, createdAt: Date.now(), isActive: true, isAdmin };
  saveUsers(users);

  const token = jwt.sign({ id: userId, username: username.trim(), isAdmin }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: username.trim() });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = loadUsers();
  const key = username.toLowerCase().trim();
  const user = users[key];
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  if (user.isActive === false) return res.status(403).json({ error: 'Account deactivated. Contact the administrator.' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

  const isAdmin = user.isAdmin || key === ADMIN_USERNAME.toLowerCase();
  const token = jwt.sign({ id: user.id, username: user.username, isAdmin }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username, isAdmin });
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
    let text = '', docHtml = '';
    if (ext === '.txt') {
      text = buf.toString('utf8');
    } else if (ext === '.pdf') {
      const data = await pdfParse(buf);
      text = data.text;
    } else if (ext === '.docx' || ext === '.doc') {
      try {
        // Extract both HTML (for formatting) and plain text
        const [htmlResult, textResult] = await Promise.all([
          mammoth.convertToHtml({ buffer: buf }),
          mammoth.extractRawText({ buffer: buf }),
        ]);
        docHtml = htmlResult.value;
        text = textResult.value;
      } catch(e) {
        return res.status(422).json({ error: 'Could not parse this Word file. Try saving as .docx or .txt.' });
      }
    }
    text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return res.status(422).json({ error: 'No text could be extracted. The file may be scanned or image-based.' });
    res.json({ html: docHtml || null, name: req.file.originalname, size: req.file.size, text });
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
    google: !!GOOGLE_API_KEY,
  });
});

// ── Extract job fields from page text (OpenRouter → Groq → Anthropic) ──
app.post('/api/extract-fields', authMiddleware, async (req, res) => {
  const { url, text } = req.body;
  if (!text) return res.json(null);
  try {
    const result = await callAI(
      ['openrouter', 'groq', 'google'],
      'Extract job details from this job posting. Respond ONLY with valid JSON, no markdown. Fields: title (string), company (string), location (physical city/state/country only, no work type), workType (one of: Remote, Hybrid, On-site, or null), salary (string), remote (boolean). Use null if not found.',
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
  const { company, title, location, salary, postingText, content: docContent, docType, context } = req.body;
  // docType: 'resume' or 'cover'
  if (!docContent || !docType) return res.status(400).json({ error: 'content and docType required' });

  const jobCtx = postingText ? '\nJob posting content:\n' + postingText.slice(0, 3000) : '';
  const docLabel = docType === 'resume' ? 'RESUME' : 'COVER LETTER';
  const outputLabel = docType === 'resume' ? 'TAILORED RESUME' : 'TAILORED COVER LETTER';

  const systemPrompt = 'You are a professional career coach and resume writer. Return ONLY the tailored document as clean HTML. Use <h1>, <h2>, <h3> for headings, <p> for paragraphs, <strong> for bold, <em> for italic, <ul>/<li> for bullet lists. Preserve all section structure and formatting from the original. No preamble, no labels, no explanation, no markdown, no backticks — just valid HTML starting with the first element.';
  const userPrompt = `Tailor this ${docLabel} for the following role. Return ONLY valid HTML with formatting preserved. Use proper heading tags, bold, lists etc.

Company: ${company}
Role: ${title}
${location ? 'Location: ' + location : ''}
${salary ? 'Target salary: ' + salary : ''}
${context ? 'Additional context: ' + context : ''}
${jobCtx}

${docLabel} TO TAILOR (may be HTML or plain text — preserve all structure and formatting):
${docContent}`;

  try {
    const result = await callAI(['openrouter', 'groq', 'google'], systemPrompt, userPrompt, 3000);
    res.json({ result: result.trim(), docType });
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
      ['groq', 'openrouter', 'google'],  // Insights: Groq first
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
// ── Document Library ──
// Each user has a docs file: DATA_DIR/docs/<userId>.json
// Structure: { id, name, type ('resume'|'cover'), content, createdAt, updatedAt }

// Send email via Resend API
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — email not sent to', to);
    return { ok: false, error: 'Email not configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + RESEND_API_KEY,
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Resend error');
    return { ok: true, id: data.id };
  } catch(e) {
    console.error('Email error:', e.message);
    return { ok: false, error: e.message };
  }
}

// Admin middleware — checks JWT AND isAdmin flag
function adminMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = require('jsonwebtoken').verify(auth.slice(7), JWT_SECRET);
    if (!payload.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    req.user = payload;
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

const DOCS_DIR = path.join(DATA_DIR, 'docs');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

function loadUserDocs(userId) {
  const f = path.join(DOCS_DIR, `${userId}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
}
function saveUserDocs(userId, docs) {
  fs.writeFileSync(path.join(DOCS_DIR, `${userId}.json`), JSON.stringify(docs));
}
function docId() { return Math.random().toString(36).slice(2, 10); }

// GET /api/docs — list all docs
app.get('/api/docs', authMiddleware, (req, res) => {
  const docs = loadUserDocs(req.user.id);
  // Return without content for list view (save bandwidth)
  res.json(docs.map(d => ({ id: d.id, name: d.name, type: d.type, size: d.content?.length || 0, createdAt: d.createdAt, updatedAt: d.updatedAt })));
});

// GET /api/docs/:id — get full doc with content
app.get('/api/docs/:id', authMiddleware, (req, res) => {
  const docs = loadUserDocs(req.user.id);
  const doc = docs.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(doc);
});

// POST /api/docs — create or update a doc
app.post('/api/docs', authMiddleware, (req, res) => {
  const { id, name, type, content, html } = req.body;
  if (!name || !type || !content) return res.status(400).json({ error: 'name, type, content required' });
  const docs = loadUserDocs(req.user.id);
  const now = Date.now();
  if (id) {
    // Update existing
    const idx = docs.findIndex(d => d.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    docs[idx] = { ...docs[idx], name, type, content, html, updatedAt: now };
    saveUserDocs(req.user.id, docs);
    res.json(docs[idx]);
  } else {
    // Create new
    const doc = { id: docId(), name, type, content, html, createdAt: now, updatedAt: now };
    docs.push(doc);
    saveUserDocs(req.user.id, docs);
    res.json(doc);
  }
});

// DELETE /api/docs/:id — delete a doc
app.delete('/api/docs/:id', authMiddleware, (req, res) => {
  const docs = loadUserDocs(req.user.id);
  const filtered = docs.filter(d => d.id !== req.params.id);
  if (filtered.length === docs.length) return res.status(404).json({ error: 'Not found' });
  saveUserDocs(req.user.id, filtered);
  res.json({ ok: true });
});

// POST /api/docs/upload — upload a file and create a doc entry
app.post('/api/docs/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { type = 'resume' } = req.body;
  let content = '', html = '';
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  try {
    if (ext === 'pdf') {
      const pdfData = await pdfParse(req.file.buffer);
      content = pdfData.text;
    } else if (ext === 'docx') {
      const result = await mammoth.convertToHtml({ buffer: req.file.buffer });
      html = result.value;
      content = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    } else {
      content = req.file.buffer.toString('utf8');
    }
  } catch(e) { content = req.file.buffer.toString('utf8'); }

  const docs = loadUserDocs(req.user.id);
  const now = Date.now();
  const doc = { id: docId(), name: req.file.originalname, type, content, html, createdAt: now, updatedAt: now };
  docs.push(doc);
  saveUserDocs(req.user.id, docs);
  res.json(doc);
});

// ── Download tailored doc as DOCX ──
app.post('/api/download-docx', authMiddleware, async (req, res) => {
  const { html, text, filename } = req.body;
  if (!html && !text) return res.status(400).json({ error: 'No content provided' });
  try {
    const HTMLtoDOCX = require('html-to-docx');
    const htmlContent = html || `<html><body>${(text||'').split('\n').map(l => `<p>${l}</p>`).join('')}</body></html>`;
    const docxBuffer = await HTMLtoDOCX(htmlContent, null, {
      table: { row: { cantSplit: true } },
      footer: false,
      pageNumber: false,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${(filename || 'document').replace(/[^a-z0-9_-]/gi, '_')}.docx"`);
    res.send(docxBuffer);
  } catch(e) {
    console.error('DOCX generation error:', e);
    res.status(500).json({ error: 'Failed to generate DOCX: ' + e.message });
  }
});

// ── Download tailored doc as DOCX ──
app.post('/api/download-docx', authMiddleware, async (req, res) => {
  const { content: htmlContent, filename = 'tailored-document' } = req.body;
  if (!htmlContent) return res.status(400).json({ error: 'No content provided' });

  try {
    const HTMLtoDOCX = require('html-to-docx');
    // Wrap in a full HTML structure if not already
    const fullHtml = htmlContent.trim().startsWith('<!DOCTYPE') ? htmlContent :
      `<!DOCTYPE html><html><body>${htmlContent}</body></html>`;

    const docxBuffer = await HTMLtoDOCX(fullHtml, null, {
      table: { row: { cantSplit: true } },
      footer: false,
      pageNumber: false,
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
    res.send(Buffer.from(docxBuffer));
  } catch(e) {
    console.error('Download DOCX error:', e.message);
    // Fallback: send as plain text
    const text = htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`);
    res.send(text);
  }
});

// ── Check if job posting is still active ──
app.post('/api/check-posting', authMiddleware, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    // Fetch the page with a realistic user agent
    const pageRes = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    }, 15000);

    if (!pageRes.ok) {
      // 404 = definitely gone
      if (pageRes.status === 404) return res.json({ expired: true, reason: '404 Not Found' });
      // 403/429 = blocked but likely still exists
      return res.json({ expired: false, reason: `HTTP ${pageRes.status}` });
    }

    const html = await pageRes.text();
    const lowerHtml = html.toLowerCase();

    // Common signals that a job is closed/expired
    const expiredSignals = [
      'this job is no longer available',
      'this job has expired',
      'job no longer available',
      'position has been filled',
      'posting has expired',
      'this position is no longer',
      'no longer accepting applications',
      'job listing has been removed',
      'this listing is expired',
      'requisition is closed',
      'position is closed',
      'job is closed',
    ];

    const expired = expiredSignals.some(s => lowerHtml.includes(s));
    res.json({ expired, reason: expired ? 'Expired signals found' : 'Active' });
  } catch(e) {
    // Network error - can't determine
    res.json({ expired: false, reason: 'Could not reach URL: ' + e.message });
  }
});

// ── Template injection: tailor DOCX preserving all formatting ──
// Strategy: paragraph-by-paragraph mapping so formatting is never disturbed
app.post('/api/tailor-docx', authMiddleware, async (req, res) => {
  const { docxBase64, company, title, location, salary, postingText, docType, context } = req.body;
  if (!docxBase64) return res.status(400).json({ error: 'DOCX data required' });

  try {
    const AdmZip = require('adm-zip');
    const docxBuffer = Buffer.from(docxBase64, 'base64');
    const zip = new AdmZip(docxBuffer);

    const docXmlEntry = zip.getEntry('word/document.xml');
    if (!docXmlEntry) return res.status(422).json({ error: 'Invalid DOCX file' });
    let docXml = docXmlEntry.getData().toString('utf8');

    // ── Step 1: Extract all non-empty paragraphs with their XML ──
    const paraMatches = [...docXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)];
    const paragraphs = paraMatches.map(m => {
      // Get all text content (strip XML tags)
      const text = m[0]
        .replace(/<w:t[^>]*\/>/g, '')  // empty self-closing tags
        .replace(/<\/w:t>/g, '\u0001') // mark end of each run text
        .replace(/<[^>]+>/g, '')
        .replace(/\u0001/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ').trim();
      return { xml: m[0], text, index: m.index };
    }).filter(p => p.text.length > 0);

    if (paragraphs.length === 0) return res.status(422).json({ error: 'No text found in document' });

    // ── Step 2: Send numbered paragraphs to AI ──
    const numberedInput = paragraphs.map((p, i) => `[${i}] ${p.text}`).join('\n');
    const jobCtx = postingText ? '\nJob posting:\n' + postingText.slice(0, 2000) : '';
    const docLabel = docType === 'resume' ? 'resume' : 'cover letter';

    const systemPrompt = `You are a professional career coach tailoring a ${docLabel}. You will receive numbered paragraphs from the original document. Return ONLY the same numbered paragraphs with updated content tailored for the job. Keep EVERY paragraph number — same count, same order. Do not merge, split, add or remove paragraphs. Only change the words.`;
    const userPrompt = `Tailor for:\nCompany: ${company}\nRole: ${title}\n${location ? 'Location: ' + location : ''}\n${salary ? 'Salary: ' + salary : ''}\n${context ? 'Notes: ' + context : ''}${jobCtx}\n\nPARAGRAPHS:\n${numberedInput}`;

    const tailoredRaw = await callAI(['openrouter', 'groq', 'google'], systemPrompt, userPrompt, 4000);

    // ── Step 3: Parse AI response back to paragraph array ──
    const newParas = {};
    const lineRegex = /^\[(\d+)\]\s*([\s\S]*?)(?=^\[\d+\]|\s*$)/gm;
    let lm;
    while ((lm = lineRegex.exec(tailoredRaw + '\n')) !== null) {
      newParas[parseInt(lm[1])] = lm[2].trim();
    }
    // Fallback: split by lines starting with [N]
    if (Object.keys(newParas).length === 0) {
      tailoredRaw.split('\n').forEach(line => {
        const m = line.match(/^\[(\d+)\]\s*(.*)/);
        if (m) newParas[parseInt(m[1])] = m[2].trim();
      });
    }

    // ── Step 4: Replace text in each paragraph's runs ──
    let modifiedXml = docXml;

    for (let i = paragraphs.length - 1; i >= 0; i--) {
      const para = paragraphs[i];
      const newText = newParas[i];
      if (!newText || !newText.trim()) continue;

      const paraXml = para.xml;

      // Get all <w:t> elements in this paragraph
      const runMatches = [...paraXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
      if (runMatches.length === 0) continue;

      // Strategy: put ALL new text into the first non-empty run, clear remaining runs.
      // This avoids all inter-run spacing issues (no xml:space="preserve" needed,
      // no word boundary gaps between adjacent runs).
      // Paragraph-level formatting (font, size, color, indent, spacing) is preserved.
      let modifiedPara = paraXml;
      let placedText = false;
      const escaped = newText
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      for (let r = 0; r < runMatches.length; r++) {
        const runMatch = runMatches[r];
        if (!placedText && runMatch[1].trim()) {
          // First non-empty run: inject full paragraph text with xml:space="preserve"
          // Ensure the <w:t> tag has xml:space="preserve" so spaces aren't stripped
          let newRunXml = runMatch[0];
          // Replace the <w:t> opening tag to ensure xml:space="preserve"
          newRunXml = newRunXml.replace(
            /<w:t(?:\s[^>]*)?>/, 
            '<w:t xml:space="preserve">'
          );
          // Replace the text content
          newRunXml = newRunXml.replace(
            /<w:t[^>]*>[^<]*<\/w:t>/,
            `<w:t xml:space="preserve">${escaped}</w:t>`
          );
          modifiedPara = modifiedPara.replace(runMatch[0], newRunXml);
          placedText = true;
        } else if (placedText && runMatch[1].trim()) {
          // Subsequent runs with text: clear the text (keep run properties for formatting)
          modifiedPara = modifiedPara.replace(
            runMatch[0],
            runMatch[0].replace(/<w:t[^>]*>[^<]*<\/w:t>/, '<w:t/>')
          );
        }
      }

      // Replace the paragraph in the full XML (work backwards so indices stay valid)
      modifiedXml = modifiedXml.slice(0, para.index) + modifiedPara + modifiedXml.slice(para.index + para.xml.length);
    }

    // ── Step 5: Write back and send ──
    zip.updateFile('word/document.xml', Buffer.from(modifiedXml, 'utf8'));
    const outputBuffer = zip.toBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="tailored-${docType}.docx"`);
    res.send(outputBuffer);
  } catch(e) {
    console.error('DOCX template injection error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ── Download tailored doc as DOCX ──
app.post('/api/download-docx', authMiddleware, async (req, res) => {
  const { html, text, filename } = req.body;
  if (!html && !text) return res.status(400).json({ error: 'No content provided' });
  try {
    const HTMLtoDOCX = require('html-to-docx');
    const htmlContent = html || `<html><body>${(text||'').split('\n').map(l => `<p>${l}</p>`).join('')}</body></html>`;
    const docxBuffer = await HTMLtoDOCX(htmlContent, null, {
      table: { row: { cantSplit: true } },
      footer: false,
      pageNumber: false,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${(filename || 'document').replace(/[^a-z0-9_-]/gi, '_')}.docx"`);
    res.send(docxBuffer);
  } catch(e) {
    console.error('DOCX generation error:', e);
    res.status(500).json({ error: 'Failed to generate DOCX: ' + e.message });
  }
});

// ── Download tailored doc as DOCX ──
app.post('/api/download-docx', authMiddleware, async (req, res) => {
  const { content: htmlContent, filename = 'tailored-document' } = req.body;
  if (!htmlContent) return res.status(400).json({ error: 'No content provided' });

  try {
    const HTMLtoDOCX = require('html-to-docx');
    // Wrap in a full HTML structure if not already
    const fullHtml = htmlContent.trim().startsWith('<!DOCTYPE') ? htmlContent :
      `<!DOCTYPE html><html><body>${htmlContent}</body></html>`;

    const docxBuffer = await HTMLtoDOCX(fullHtml, null, {
      table: { row: { cantSplit: true } },
      footer: false,
      pageNumber: false,
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
    res.send(Buffer.from(docxBuffer));
  } catch(e) {
    console.error('Download DOCX error:', e.message);
    // Fallback: send as plain text
    const text = htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`);
    res.send(text);
  }
});

// ── Check if job posting is still active ──
app.post('/api/check-posting', authMiddleware, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    // Fetch the page with a realistic user agent
    const pageRes = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    }, 15000);

    if (!pageRes.ok) {
      // 404 = definitely gone
      if (pageRes.status === 404) return res.json({ expired: true, reason: '404 Not Found' });
      // 403/429 = blocked but likely still exists
      return res.json({ expired: false, reason: `HTTP ${pageRes.status}` });
    }

    const html = await pageRes.text();
    const lowerHtml = html.toLowerCase();

    // Common signals that a job is closed/expired
    const expiredSignals = [
      'this job is no longer available',
      'this job has expired',
      'job no longer available',
      'position has been filled',
      'posting has expired',
      'this position is no longer',
      'no longer accepting applications',
      'job listing has been removed',
      'this listing is expired',
      'requisition is closed',
      'position is closed',
      'job is closed',
    ];

    const expired = expiredSignals.some(s => lowerHtml.includes(s));
    res.json({ expired, reason: expired ? 'Expired signals found' : 'Active' });
  } catch(e) {
    // Network error - can't determine
    res.json({ expired: false, reason: 'Could not reach URL: ' + e.message });
  }
});

// ── Template injection: tailor DOCX preserving all formatting ──
// Receives original DOCX as base64, replaces text content via XML patching
app.post('/api/tailor-docx', authMiddleware, async (req, res) => {
  const { docxBase64, company, title, location, salary, postingText, docType, context } = req.body;
  if (!docxBase64) return res.status(400).json({ error: 'DOCX data required' });

  try {
    const AdmZip = require('adm-zip');
    const docxBuffer = Buffer.from(docxBase64, 'base64');
    const zip = new AdmZip(docxBuffer);

    // Extract text from document.xml for AI to work with
    const docXmlEntry = zip.getEntry('word/document.xml');
    if (!docXmlEntry) return res.status(422).json({ error: 'Invalid DOCX file' });
    const docXml = docXmlEntry.getData().toString('utf8');

    // Extract readable text from XML (strip tags)
    const rawText = docXml
      .replace(/<w:br[^/]*/g, '\n')
      .replace(/<w:p[ >]/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n\n+/g, '\n').trim();

    const jobCtx = postingText ? '\nJob posting:\n' + postingText.slice(0, 2000) : '';
    const docLabel = docType === 'resume' ? 'resume' : 'cover letter';
    const systemPrompt = 'You are a professional career coach. You will receive a document as plain text with section markers. Rewrite it to be tailored for the job, keeping the exact same structure and sections. Return ONLY the rewritten plain text - same sections, same order, nothing added or removed.';
    const userPrompt = `Tailor this ${docLabel} for:\nCompany: ${company}\nRole: ${title}\n${location?'Location: '+location:''}\n${salary?'Salary: '+salary:''}\n${context?'Notes: '+context:''}${jobCtx}\n\nDOCUMENT TO TAILOR:\n${rawText}`;

    const tailoredText = await callAI(['openrouter', 'groq', 'google'], systemPrompt, userPrompt, 3000);

    // Now do a paragraph-level replacement in the XML
    // Split both texts into lines for mapping
    const origLines = rawText.split('\n').filter(l => l.trim());
    const newLines = tailoredText.split('\n').filter(l => l.trim());

    // Simple approach: replace all text runs with tailored content
    // Find all <w:t> elements and rebuild with new content proportionally
    let modifiedXml = docXml;

    // Extract all text runs
    const runRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    const runs = [];
    let m;
    while ((m = runRegex.exec(docXml)) !== null) {
      runs.push({ match: m[0], text: m[1], index: m.index });
    }

    // Get all non-empty text from original
    const origWords = rawText.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const newWords = tailoredText.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

    // Map proportionally: each run gets its proportional share of new words
    const totalChars = origWords.join(' ').length || 1;
    let usedNewChars = 0;
    let runIndex = 0;

    for (const run of runs) {
      if (!run.text.trim()) continue;
      const proportion = run.text.length / totalChars;
      const newWordsCount = Math.max(1, Math.round(proportion * newWords.length));
      const start = Math.round((run.index / totalChars) * newWords.length);
      const slice = newWords.slice(
        Math.min(start, newWords.length - 1),
        Math.min(start + newWordsCount, newWords.length)
      ).join(' ');
      if (slice) {
        const escapedSlice = slice.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const newRun = run.match.replace(/>([^<]*)<\/w:t>/, '>' + escapedSlice + '</w:t>');
        modifiedXml = modifiedXml.replace(run.match, newRun);
      }
      runIndex++;
    }

    // Update the zip with modified XML
    zip.updateFile('word/document.xml', Buffer.from(modifiedXml, 'utf8'));
    const outputBuffer = zip.toBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="tailored-${docType}.docx"`);
    res.send(outputBuffer);
  } catch(e) {
    console.error('DOCX template injection error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN ROUTES ──

// POST /api/admin/deactivate — deactivate a user account
app.post('/api/admin/deactivate', adminMiddleware, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  if (username === ADMIN_USERNAME) return res.status(400).json({ error: 'Cannot deactivate admin account' });
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });
  users[username].active = false;
  saveUsers(users);
  res.json({ ok: true });
});

// POST /api/admin/reactivate — reactivate a user account
app.post('/api/admin/reactivate', adminMiddleware, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });
  users[username].active = true;
  saveUsers(users);
  res.json({ ok: true });
});

// POST /api/admin/reset-password — admin sets a new password directly
app.post('/api/admin/reset-password', adminMiddleware, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!username || !newPassword) return res.status(400).json({ error: 'username and newPassword required' });
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });
  users[username].passwordHash = await bcrypt.hash(newPassword, 12);
  saveUsers(users);
  // Notify user by email if they have one
  const email = users[username].email;
  if (email) {
    try {
      await sendMail(email, 'Your Applied password has been reset',
        `<p>Hi ${username},</p><p>An administrator has reset your Applied Job Tracker password.</p><p>Please <a href="${APP_URL}">sign in</a> with the new password provided to you.</p><p>If you didn't expect this, contact your administrator.</p>`
      );
    } catch(e) { console.warn('Email send failed:', e.message); }
  }
  res.json({ ok: true, emailSent: !!email });
});

// POST /api/admin/send-reset-link — generate a reset token and email it
app.post('/api/admin/send-reset-link', adminMiddleware, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const users = loadUsers();
  const user = users[username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.email) return res.status(400).json({ error: 'User has no email address' });

  const token = require('crypto').randomBytes(32).toString('hex');
  const tokens = loadTokens();
  tokens[token] = { username, expiresAt: Date.now() + 3600000 }; // 1 hour
  saveTokens(tokens);

  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  try {
    await sendMail(user.email, 'Reset your Applied password',
      `<p>Hi ${username},</p><p>A password reset was requested for your Applied Job Tracker account.</p><p><a href="${resetUrl}" style="padding:10px 20px;background:#a3e635;color:#1a1917;border-radius:6px;text-decoration:none;font-weight:600">Reset Password</a></p><p>This link expires in 1 hour. If you didn't request this, ignore this email.</p><p><small>Or paste this URL: ${resetUrl}</small></p>`
    );
    res.json({ ok: true, resetUrl });
  } catch(e) {
    res.status(500).json({ error: 'Email failed: ' + e.message });
  }
});

// POST /api/admin/update-email — update a user's email
app.post('/api/admin/update-email', adminMiddleware, async (req, res) => {
  const { username, email } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });
  users[username].email = email || '';
  saveUsers(users);
  res.json({ ok: true });
});

// POST /api/admin/delete-user — delete a user and all their data
app.post('/api/admin/delete-user', adminMiddleware, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  if (username === ADMIN_USERNAME) return res.status(400).json({ error: 'Cannot delete admin account' });
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });
  delete users[username];
  saveUsers(users);
  // Clean up user data files
  [
    path.join(DATA_DIR, 'jobs', `${username}.json`),
    path.join(DATA_DIR, 'docs', `${username}.json`),
  ].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  res.json({ ok: true });
});

// POST /api/reset-password — user resets via token (public endpoint)
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword required' });
  const tokens = loadTokens();
  const entry = tokens[token];
  if (!entry) return res.status(400).json({ error: 'Invalid or expired reset link' });
  if (Date.now() > entry.expiresAt) {
    delete tokens[token]; saveTokens(tokens);
    return res.status(400).json({ error: 'Reset link has expired' });
  }
  const users = loadUsers();
  const user = users[entry.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  saveUsers(users);
  delete tokens[token]; saveTokens(tokens);
  res.json({ ok: true, username: entry.username });
});

// GET /api/admin/status — check if requester is admin
app.get('/api/admin/status', adminMiddleware, (req, res) => {
  res.json({ admin: true, username: req.user.username });
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/admin.html'));
});

// Serve password reset page
app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/reset-password.html'));
});

// ═══════════════════════════════════════════
// ── ADMIN ROUTES (admin JWT required) ──
// ═══════════════════════════════════════════

// GET /api/admin/users — list all users
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = loadUsers();
  const userList = Object.values(users).map(u => {
    // Count jobs for this user
    const jobsFile = path.join(DATA_DIR, 'jobs', u.id + '.json');
    let jobCount = 0;
    try {
      if (fs.existsSync(jobsFile)) {
        jobCount = Object.keys(JSON.parse(fs.readFileSync(jobsFile, 'utf8'))).length;
      }
    } catch(e) {}
    return {
      username: u.username,
      email: u.email || '',
      createdAt: u.createdAt,
      isActive: u.isActive !== false,
      isAdmin: u.isAdmin || false,
      lastLogin: u.lastLogin || null,
      jobCount,
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
  res.json(userList);
});

// POST /api/admin/deactivate — toggle user active status
app.post('/api/admin/deactivate', adminMiddleware, (req, res) => {
  const { username, active } = req.body;
  const users = loadUsers();
  const key = username.toLowerCase();
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  if (users[key].isAdmin) return res.status(400).json({ error: 'Cannot deactivate admin account' });
  users[key].isActive = !!active;
  saveUsers(users);
  // Optionally notify the user
  if (!active && users[key].email) {
    sendEmail(
      users[key].email,
      'Your Applied account has been deactivated',
      `<p>Hi ${users[key].username},</p><p>Your Applied Job Tracker account has been deactivated. Please contact the administrator if you believe this is an error.</p>`
    );
  }
  res.json({ ok: true, isActive: !!active });
});

// POST /api/admin/reset-password — force set a new password
app.post('/api/admin/reset-password', adminMiddleware, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const users = loadUsers();
  const key = username.toLowerCase();
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  users[key].password = await bcrypt.hash(newPassword, 12);
  saveUsers(users);
  // Email the user
  if (users[key].email) {
    await sendEmail(
      users[key].email,
      'Your Applied password has been reset',
      `<p>Hi ${users[key].username},</p><p>Your Applied Job Tracker password has been reset by an administrator.</p><p>Your new temporary password is: <strong>${newPassword}</strong></p><p>Please log in and change your password immediately.</p><p><a href="${APP_URL}">Open Applied</a></p>`
    );
  }
  res.json({ ok: true });
});

// POST /api/admin/send-reset-link — email a self-service reset link
app.post('/api/admin/send-reset-link', adminMiddleware, async (req, res) => {
  const { username } = req.body;
  const users = loadUsers();
  const key = username.toLowerCase();
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  if (!users[key].email) return res.status(400).json({ error: 'No email on file for this user' });

  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  resetTokens[token] = { username: key, expires: Date.now() + 60 * 60 * 1000 }; // 1 hour

  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  const result = await sendEmail(
    users[key].email,
    'Reset your Applied password',
    `<p>Hi ${users[key].username},</p><p>Click the link below to reset your Applied Job Tracker password. This link expires in 1 hour.</p><p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#a3e635;color:#1a1917;text-decoration:none;border-radius:6px;font-weight:600">Reset Password</a></p><p>Or copy this URL: ${resetUrl}</p><p>If you didn't request this, ignore this email.</p>`
  );
  res.json({ ok: result.ok, error: result.error });
});

// POST /api/admin/delete-user — permanently delete a user
app.delete('/api/admin/users/:username', adminMiddleware, (req, res) => {
  const users = loadUsers();
  const key = req.params.username.toLowerCase();
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  if (users[key].isAdmin) return res.status(400).json({ error: 'Cannot delete admin account' });
  const userId = users[key].id;
  delete users[key];
  saveUsers(users);
  // Remove their data files
  try { fs.unlinkSync(path.join(DATA_DIR, 'jobs', userId + '.json')); } catch(e) {}
  try { fs.unlinkSync(path.join(DOCS_DIR, userId + '.json')); } catch(e) {}
  res.json({ ok: true });
});

// GET /api/reset-password-check — validate reset token
app.get('/api/reset-password-check', (req, res) => {
  const { token } = req.query;
  const entry = resetTokens[token];
  if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'Invalid or expired reset link' });
  res.json({ valid: true, username: entry.username });
});

// POST /api/reset-password — apply new password from reset link
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  const entry = resetTokens[token];
  if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'Invalid or expired reset link' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const users = loadUsers();
  const user = users[entry.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.password = await bcrypt.hash(newPassword, 12);
  saveUsers(users);
  delete resetTokens[token];
  res.json({ ok: true });
});

// Track last login
app.use((req, res, next) => {
  if (req.path === '/api/login' && req.method === 'POST') {
    res.on('finish', () => {
      if (res.statusCode === 200) {
        const key = (req.body?.username || '').toLowerCase();
        const users = loadUsers();
        if (users[key]) { users[key].lastLogin = Date.now(); saveUsers(users); }
      }
    });
  }
  next();
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/admin.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/reset-password.html'));
});

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
