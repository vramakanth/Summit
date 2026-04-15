const express = require('express');
const archiver = require('archiver');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// ── Zero-knowledge encryption ──
// All encryption/decryption happens in the browser via WebCrypto.
// The server stores opaque ciphertext and never sees plaintext job data or keys.
// encryptedDataKey: browser-generated, wrapped with PBKDF2(password) key — server stores only
// recoveryKeySlots: encryptedDataKey wrapped with each recovery code key — for code-based recovery
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



// ── RECOVERY CODES ──
// Generate 8 groups of 4 chars (e.g. A3X9-K2M1-PQ7R-B5N2-...)
function generateRecoveryCodes(count = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars
  return Array.from({ length: count }, () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  );
}
function formatCode(segments) { return segments.join('-'); }

// Store hashed codes alongside user; return plaintext for display
async function attachRecoveryCodes(user) {
  const codes = generateRecoveryCodes(8);
  user.recoveryCodes = await Promise.all(codes.map(c => bcrypt.hash(c, 10)));
  user.recoveryCodesCreatedAt = Date.now();
  return codes; // plaintext — shown once, never stored
}

// Verify a submitted recovery code against stored hashes
async function verifyRecoveryCode(user, submitted) {
  if (!user.recoveryCodes || !user.recoveryCodes.length) return null;
  const clean = submitted.replace(/-/g, '').toUpperCase();
  for (let i = 0; i < user.recoveryCodes.length; i++) {
    const match = await bcrypt.compare(clean, user.recoveryCodes[i]);
    if (match) {
      user.recoveryCodes.splice(i, 1); // one-time use — consume it
      return true;
    }
  }
  return false;
}

async function sendMail(to, subject, html) {
  const mailer = getMailer();
  if (!mailer) throw new Error('Email not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS');
  await mailer.sendMail({ from: `"Pursuit Job Tracker" <${SMTP_FROM}>`, to, subject, html });
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
      'X-Title': 'Pursuit Job Tracker',
    }),
  },
};

// OpenRouter free models — best 3 only for fast fallback
const OPENROUTER_FALLBACK_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',  // primary
  'nvidia/nemotron-3-super-120b-a12b:free',  // fallback 1
  'google/gemma-4-31b-it:free',              // fallback 2
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
      }, 30000);

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
        return { text: result, provider, model };
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
  }, 30000);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return { text, provider: 'google', model: GOOGLE_MODEL };
}

// Try providers in order, return first success
// Order: Groq → OpenRouter → Google (all free)
async function callAI(preferredOrder, systemPrompt, userPrompt, maxTokens = 4000) {
  const errors = [];
  for (const provider of preferredOrder) {
    try {
      const r = provider === 'google'
        ? await callGoogle(systemPrompt, userPrompt, maxTokens)
        : await callOpenAI(provider, systemPrompt, userPrompt, maxTokens);
      console.log(`callAI: success via ${r.provider} / ${r.model}`);
      return r; // {text, provider, model}
    } catch (e) {
      console.warn(`callAI: ${provider} failed — ${e.message}`);
      errors.push(`${provider}: ${e.message}`);
    }
  }
  throw new Error('All AI providers failed: ' + errors.join(' | '));
}

// Helper: call callAI and return just the text string (for routes that don't need model info)
async function callAIText(preferredOrder, systemPrompt, userPrompt, maxTokens = 4000) {
  const r = await callAI(preferredOrder, systemPrompt, userPrompt, maxTokens);
  return r.text;
}

// Fast parallel race — fires all configured providers simultaneously, returns first success
async function callAIFast(systemPrompt, userPrompt, maxTokens = 4000) {
  const providers = [];
  if (PROVIDERS.groq?.key)       providers.push('groq');
  if (PROVIDERS.openrouter?.key) providers.push('openrouter');
  if (PROVIDERS.google?.key)     providers.push('google');
  if (providers.length === 0)    throw new Error('No AI providers configured');

  // Race all providers — first to succeed wins
  return new Promise((resolve, reject) => {
    let settled = false;
    let failures = 0;
    const errors = [];
    providers.forEach(provider => {
      const call = provider === 'google'
        ? callGoogle(systemPrompt, userPrompt, maxTokens)
        : callOpenAI(provider, systemPrompt, userPrompt, maxTokens);
      call.then(result => {
        if (!settled) {
          settled = true;
          console.log(`callAIFast: won via ${result.provider} / ${result.model}`);
          resolve(result);
        }
      }).catch(e => {
        errors.push(`${provider}: ${e.message}`);
        failures++;
        if (failures === providers.length && !settled) {
          reject(new Error('All providers failed: ' + errors.join(' | ')));
        }
      });
    });
  });
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

function loadUserJobs(userId, dataKey) {
  const file = path.join(JOBS_DIR, `${userId}.json`);
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  // Support both encrypted (new) and plaintext (legacy migration) formats
  if (dataKey && raw.includes(':') && !raw.startsWith('{')) {
    try { return JSON.parse(decryptData(raw, dataKey)); } catch(e) {}
  }
  try { return JSON.parse(raw); } catch(e) { return {}; }
}

function saveUserJobs(userId, data, dataKey) {
  const file = path.join(JOBS_DIR, `${userId}.json`);
  const json = JSON.stringify(data);
  fs.writeFileSync(file, dataKey ? encryptData(json, dataKey) : json);
}



function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    // Expose the user's dataKey for encrypted storage operations
    if (req.user.wrappedKey) {
      try { req.dataKey = unwrapDataKey(req.user.wrappedKey); } catch(e) {}
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Auth Routes ---
app.post('/api/register', async (req, res) => {
  const { username, password, email, encryptedDataKey, recoveryKeySlots } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email address required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!encryptedDataKey) return res.status(400).json({ error: 'Encryption key required' });

  const users = loadUsers();
  const key = username.toLowerCase().trim();
  if (users[key]) return res.status(409).json({ error: 'Username already taken' });

  const isAdmin = key === ADMIN_USERNAME.toLowerCase();
  const hashed = await bcrypt.hash(password, 12);

  // Generate recovery codes (bcrypt hashes for server-side rate-limit verification)
  const codes = generateRecoveryCodes(8);
  const formatted = codes.map(c => c.match(/.{1,4}/g).join('-'));
  const codeHashes = await Promise.all(codes.map(c => bcrypt.hash(c, 10)));

  const userId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  users[key] = {
    id: userId,
    username: username.trim(),
    email: email.toLowerCase().trim(),   // plaintext for SMTP only
    password: hashed,
    createdAt: Date.now(),
    isActive: true,
    isAdmin,
    // Zero-knowledge encryption fields (browser-generated, server never sees plaintext key)
    encryptedDataKey,                    // dataKey wrapped with PBKDF2(password) — opaque to server
    recoveryKeySlots: recoveryKeySlots || [], // dataKey wrapped with each recovery code key
    recoveryCodes: codeHashes,           // bcrypt hashes only — for rate-limit verification
    recoveryCodesCreatedAt: Date.now(),
    encrypted: true,
  };
  saveUsers(users);

  const token = jwt.sign({ id: userId, username: username.trim(), isAdmin }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    username: username.trim(),
    recoveryCodes: formatted,            // shown once — never stored in plaintext
    recoveryCodesCreatedAt: Date.now(),
  });
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
  users[key].lastLogin = Date.now();
  saveUsers(users);

  const token = jwt.sign({ id: user.id, username: user.username, isAdmin }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    username: user.username,
    isAdmin,
    // Return encrypted key material — browser decrypts with password (server never sees plaintext)
    encryptedDataKey: user.encryptedDataKey || null,
    recoveryKeySlots: user.recoveryKeySlots || [],
    encrypted: user.encrypted || false,
  });
});

// --- Jobs Routes ---
app.get('/api/jobs', authMiddleware, (req, res) => {
  // Returns opaque blob — browser decrypts with its own key
  const file = path.join(JOBS_DIR, `${req.user.id}.json`);
  if (!fs.existsSync(file)) return res.json({ __enc: false, data: {} });
  const raw = fs.readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    // If already a zero-knowledge blob, return as-is
    if (parsed.__enc !== undefined) return res.json(parsed);
    // Legacy plaintext — return as-is for migration
    return res.json({ __enc: false, data: parsed });
  } catch(e) {
    // Raw ciphertext string (old server-side encrypted format) — treat as legacy
    return res.json({ __enc: false, data: {} });
  }
});

app.put('/api/jobs', authMiddleware, (req, res) => {
  const jobs = req.body;
  if (typeof jobs !== 'object') return res.status(400).json({ error: 'Invalid data' });
  // Accept either zero-knowledge blob {__enc, data} or plaintext — store as-is
  const file = path.join(JOBS_DIR, `${req.user.id}.json`);
  if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(jobs));
  return res.json({ ok: true });
  // Legacy path below — kept for reference but not reached
  saveUserJobs(req.user.id, jobs, req.dataKey);
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

  // ── LinkedIn — extract job ID from URL, use public JSON endpoint ──
  if (hostname.includes('linkedin.com') && parsed.pathname.includes('/jobs/view/')) {
    const jobIdMatch = parsed.pathname.match(/\/jobs\/view\/(\d+)/);
    const jobId = jobIdMatch ? jobIdMatch[1] : null;

    // Try LinkedIn's public job posting page (sometimes accessible without login)
    // and extract structured data from it
    if (jobId) {
      try {
        const liUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;
        const liRes = await fetchWithTimeout(liUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          }
        }, 10000);

        if (liRes.ok) {
          const liHtml = await liRes.text();

          // Try JSON-LD structured data first
          const structured = extractStructuredData(liHtml);
          if (structured && structured.title) {
            return {
              fields: structured,
              html: liHtml.slice(0, 50000),
              text: stripHtml(liHtml).slice(0, 8000),
            };
          }

          // Parse LinkedIn's page title format:
          // "{Company} hiring {Job Title} in {City, State} | LinkedIn"
          // OR "{Job Title} at {Company} | LinkedIn"
          const rawTitle = liHtml.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || '';
          const ogTitle = liHtml.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]?.trim() || '';
          const pageTitle = (ogTitle || rawTitle).replace(' | LinkedIn', '').trim();

          let title = null, company = null, location = null;

          // Pattern 1: "Company hiring Title in Location"  e.g. "Roche hiring Director in Carlsbad, CA"
          const hiringInMatch = pageTitle.match(/^(.+?)\s+hiring\s+(.+?)\s+in\s+(.+)$/i);
          // Pattern 1b: "Company hiring Title" (remote — no location)
          const hiringMatch   = !hiringInMatch && pageTitle.match(/^(.+?)\s+hiring\s+(.+)$/i);
          // Pattern 2: "Title at Company"
          const atMatch       = !hiringInMatch && !hiringMatch && pageTitle.match(/^(.+?)\s+at\s+(.+)$/i);

          if (hiringInMatch) {
            company  = hiringInMatch[1].trim();
            title    = hiringInMatch[2].trim();
            location = hiringInMatch[3].trim();
          } else if (hiringMatch) {
            company  = hiringMatch[1].trim();
            title    = hiringMatch[2].trim();
          } else if (atMatch) {
            title    = atMatch[1].trim();
            company  = atMatch[2].trim();
          } else {
            // Pattern 3: "Title - Company" or "Title | Company" (generic dash/pipe)
            const dashMatch = pageTitle.match(/^(.+?)\s*[-–|]\s*(.+)$/);
            if (dashMatch && dashMatch[2].length < 40) {
              title   = dashMatch[1].trim();
              company = dashMatch[2].trim();
            } else {
              title = pageTitle;
            }
          }

          // Work type from location or hiring pattern
          let remote = null;
          if (hiringMatch && !hiringInMatch) remote = true; // "Company hiring Title" = Remote
          if (location) {
            if (/remote/i.test(location)) { remote = true; location = location.replace(/[,\s]*remote[,\s]*/i, '').trim(); }
            else if (/hybrid/i.test(location)) { location = location; }
          }

          // Also try og:description for more context
          const desc = liHtml.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] || '';
          if (!company && desc) {
            const compFromDesc = desc.match(/at ([^.]+)\./i)?.[1]?.trim();
            if (compFromDesc) company = compFromDesc;
          }

          if (title) {
            return {
              fields: { title, company, location: location || null, salary: null, remote },
              html: liHtml.slice(0, 50000),
              text: stripHtml(liHtml).slice(0, 8000),
            };
          }
        }
      } catch(e) { /* fall through to generic */ }
    }

    // LinkedIn blocked — return what we can from the URL itself
    return {
      fields: { title: null, company: 'LinkedIn', location: null, salary: null, remote: null },
      html: null, text: null,
      _linkedinBlocked: true,
    };
  }

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
  const { currentPassword, newPassword, newEncryptedDataKey } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

  const users = loadUsers();
  const userEntry = Object.values(users).find(u => u.id === req.user.id);
  if (!userEntry) return res.status(404).json({ error: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, userEntry.password);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  userEntry.password = await bcrypt.hash(newPassword, 12);

  // Zero-knowledge: browser re-wraps the dataKey with new password and sends new encryptedDataKey
  // Server just stores the new opaque wrapper — never sees the actual dataKey
  if (newEncryptedDataKey) {
    userEntry.encryptedDataKey = newEncryptedDataKey;
  }

  saveUsers(users);
  res.json({ ok: true });
});

// ── Export all user data as human-readable formats ──
app.get('/api/export-data', authMiddleware, async (req, res) => {
  const format = req.query.format || 'zip';
  try {
    const userJobs = loadUserJobs(req.user.id, req.dataKey);
    const jobList  = Object.values(userJobs).sort((a,b) => b.createdAt - a.createdAt);

    const csvRow = arr => arr.map(v => v == null ? '' : '"' + String(v).replace(/"/g,'""') + '"').join(',');

    if (format === 'csv') {
      const headers = 'Title,Company,Location,Work Type,Salary,Status,Source,Referred By,Deadline,Follow-Up,URL,Date Added,Notes,Contacts';
      const rows = jobList.map(j => csvRow([
        j.title, j.company, j.location, j.workType, j.salary, j.status,
        j.source, j.referredBy, j.deadline, j.followUpDate, j.url,
        j.createdAt ? new Date(j.createdAt).toISOString().slice(0,10) : '',
        (j.notes||[]).length, (j.contacts||[]).length
      ]));
      res.setHeader('Content-Type','text/csv');
      res.setHeader('Content-Disposition',`attachment; filename="pursuit-jobs-${Date.now()}.csv"`);
      return res.send([headers,...rows].join('\n'));
    }

    if (format === 'txt') {
      const lines = ['PURSUIT — JOB APPLICATION EXPORT','='.repeat(50),
        `Exported: ${new Date().toISOString()}`,`Total: ${jobList.length} applications`,''];
      for (const j of jobList) {
        lines.push('-'.repeat(50));
        lines.push(`${j.title} @ ${j.company}`);
        lines.push(`Status: ${j.status}${j.location?' | '+j.location:''}${j.workType?' | '+j.workType:''}${j.salary?' | '+j.salary:''}`);
        if (j.source) lines.push(`Source: ${j.source}${j.referredBy?' (via '+j.referredBy+')':''}`);
        if (j.deadline) lines.push(`Deadline: ${j.deadline}`);
        if (j.followUpDate) lines.push(`Follow-up: ${j.followUpDate}`);
        if (j.url) lines.push(`URL: ${j.url}`);
        if (j.notes&&j.notes.length) { lines.push('','NOTES:'); j.notes.forEach(n=>lines.push(`  [${new Date(n.ts).toISOString().slice(0,10)}] ${n.text}`)); }
        if (j.contacts&&j.contacts.length) { lines.push('','CONTACTS:'); j.contacts.forEach(c=>lines.push(`  ${c.name||''}${c.role?' — '+c.role:''}${c.email?' | '+c.email:''}`)); }
        if (j.interviews&&j.interviews.length) { lines.push('','INTERVIEW PREP:'); j.interviews.forEach(q=>lines.push(`  [${q.category}] ${q.practiced?'✓':'○'} ${q.question}`)); }
        if (j.tailoredResume) lines.push('','TAILORED RESUME (excerpt):',j.tailoredResume.slice(0,300)+'...');
        lines.push('');
      }
      res.setHeader('Content-Type','text/plain');
      res.setHeader('Content-Disposition',`attachment; filename="pursuit-export-${Date.now()}.txt"`);
      return res.send(lines.join('\n'));
    }

    // JSON — machine-readable full export for reimport
    if (format === 'json') {
      const exportData = {
        __version: 2,
        __app: 'applied-tracker',
        exportedAt: new Date().toISOString(),
        exportedBy: req.user.username,
        jobCount: jobList.length,
        jobs: jobList.map(j => ({
          // Identity
          title:       j.title       || '',
          company:     j.company     || '',
          location:    j.location    || '',
          workType:    j.workType    || '',
          salary:      j.salary      || '',
          status:      j.status      || 'applied',
          url:         j.url         || '',
          source:      j.source      || '',
          referredBy:  j.referredBy  || '',
          deadline:    j.deadline    || '',
          followUpDate:j.followUpDate|| '',
          createdAt:   j.createdAt   || Date.now(),
          // Content
          notes:       (j.notes || []).map(n => ({ text: String(n.text||''), ts: Number(n.ts||0) })),
          contacts:    (j.contacts || []).map(c => ({
            name: String(c.name||''), role: String(c.role||''),
            email: String(c.email||''), linkedin: String(c.linkedin||''),
            notes: String(c.notes||''), lastContact: c.lastContact||null,
          })),
          interviews:  (j.interviews || []).map(q => ({
            question: String(q.question||''), category: String(q.category||'general'),
            practiced: !!q.practiced, notes: String(q.notes||''),
          })),
          tailoredResume: j.tailoredResume ? String(j.tailoredResume) : null,
          tailoredCover:  j.tailoredCover  ? String(j.tailoredCover)  : null,
          // Deliberately EXCLUDED: resume binary, insights (stale data), tailored HTML (can be regenerated)
        })),
      };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="applied-export-${Date.now()}.json"`);
      return res.send(JSON.stringify(exportData, null, 2));
    }

    // ZIP (default) — all-applications.csv + per-job folders
    const archive = archiver('zip',{zlib:{level:6}});
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition',`attachment; filename="pursuit-export-${Date.now()}.zip"`);
    archive.pipe(res);

    const csvHeaders = 'Title,Company,Location,Work Type,Salary,Status,Source,Referred By,Deadline,Follow-Up,URL,Date Added';
    const csvRows = jobList.map(j=>csvRow([j.title,j.company,j.location,j.workType,j.salary,j.status,j.source,j.referredBy,j.deadline,j.followUpDate,j.url,j.createdAt?new Date(j.createdAt).toISOString().slice(0,10):'']));
    archive.append([csvHeaders,...csvRows].join('\n'),{name:'all-applications.csv'});

    for (const j of jobList) {
      const safe = `${j.company||'unknown'}_${j.title||'unknown'}`.replace(/[^a-zA-Z0-9_ -]/g,'_').slice(0,60);
      const f = safe+'/';
      const sumLines = [`${j.title} @ ${j.company}`,`Status: ${j.status}`,j.location?`Location: ${j.location}${j.workType?' ('+j.workType+')':''}`:null,j.salary?`Salary: ${j.salary}`:null,j.source?`Source: ${j.source}${j.referredBy?' via '+j.referredBy:''}`:null,j.deadline?`Deadline: ${j.deadline}`:null,j.followUpDate?`Follow-up: ${j.followUpDate}`:null,j.url?`URL: ${j.url}`:null,`Added: ${new Date(j.createdAt||Date.now()).toISOString().slice(0,10)}`].filter(Boolean);
      archive.append(sumLines.join('\n'),{name:f+'summary.txt'});
      if (j.notes&&j.notes.length) archive.append(j.notes.map(n=>`[${new Date(n.ts||Date.now()).toISOString().slice(0,10)}]\n${n.text}`).join('\n\n---\n\n'),{name:f+'notes.txt'});
      if (j.contacts&&j.contacts.length) archive.append(['Name,Role,Email,LinkedIn,Last Contact,Notes',...j.contacts.map(c=>csvRow([c.name,c.role,c.email,c.linkedin,c.lastContact,c.notes]))].join('\n'),{name:f+'contacts.csv'});
      if (j.interviews&&j.interviews.length) archive.append(j.interviews.map(q=>`[${q.category}] ${q.practiced?'✓ Practiced':'○ Not practiced'}\n${q.question}${q.notes?'\nNotes: '+q.notes:''}`).join('\n\n'),{name:f+'interview-prep.txt'});
      if (j.tailoredResume) archive.append(j.tailoredResume,{name:f+'tailored-resume.txt'});
      if (j.tailoredCover) archive.append(j.tailoredCover,{name:f+'tailored-cover-letter.txt'});
      if (j.insights) { const ins=j.insights; archive.append([`INSIGHTS: ${j.title} @ ${j.company}`,ins.overview?'\nOVERVIEW\n'+ins.overview:'',ins.companyOverview?'\nCOMPANY\n'+ins.companyOverview:'',ins.roleIntel?'\nROLE\n'+ins.roleIntel:'',ins.culture&&ins.culture.summary?'\nCULTURE\n'+ins.culture.summary:'',ins.interviewTips?'\nINTERVIEW TIPS\n'+ins.interviewTips:'',ins.flags&&ins.flags.length?'\nFLAGS\n'+ins.flags.map(f=>'• '+f).join('\n'):''].filter(Boolean).join('\n'),{name:f+'insights.txt'}); }
    }
    archive.finalize();
  } catch(e) {
    console.error('Export error:',e);
    if (!res.headersSent) res.status(500).json({error:e.message});
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
    const { text: result } = await callAIFast(
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
// POST /api/outreach-targets — AI suggests who to reach out to at a company
app.post('/api/outreach-targets', authMiddleware, async (req, res) => {
  const { title, company, postingText, existingContacts } = req.body;
  if (!company) return res.status(400).json({ error: 'Company required' });

  const jobInfo = 'Role: ' + (title || 'Not specified') + '\nCompany: ' + company +
    (postingText ? '\nJob posting:\n' + postingText.slice(0, 2500) : '') +
    (existingContacts ? '\nAlready tracking: ' + existingContacts : '');

  const systemPrompt = 'You are a career coach expert at networking and referrals. Return only valid JSON, no markdown.';
  const userPrompt = 'Suggest 4 specific types of people the candidate should reach out to at this company for a referral or inside connection.' +
    '\n\n' + jobInfo +
    '\n\nReturn a JSON array of exactly 4 objects:' +
    '\n[{"role":"exact job title to find","priority":"High|Medium","why":"one sentence on why this person matters","how":"one sentence on how to approach them","searchTip":"LinkedIn search string to find them"}]' +
    '\nBe specific to this role and company. Make role titles realistic and searchable on LinkedIn.';

  try {
    const { text: raw } = await callAIFast(systemPrompt, userPrompt, 1000);
    let targets;
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      targets = JSON.parse(clean);
    } catch(e) {
      const match = raw.match(/\[[\s\S]*\]/);
      targets = match ? JSON.parse(match[0]) : [];
    }
    if (!Array.isArray(targets)) targets = [];
    res.json({ targets });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/interview-questions — generate tailored interview questions
app.post('/api/interview-questions', authMiddleware, async (req, res) => {
  const { title, company, postingText } = req.body;
  if (!title && !company) return res.status(400).json({ error: 'Job info required' });

  const jobInfo = postingText ? 'Job Posting:\n' + postingText.slice(0, 3000) : '';
  const prompt = 'Generate 15 interview preparation questions for this job.\n\n' +
    'Job Title: ' + (title || 'Not specified') + '\n' +
    'Company: ' + (company || 'Not specified') + '\n' +
    jobInfo + '\n\n' +
    'Return ONLY a valid JSON array with objects having "category" and "question" fields. ' +
    'Categories: Behavioral, Technical, Culture Fit, Role-Specific, Questions to Ask. ' +
    '3 questions per category. Make them specific to this role and company.';

  try {
    const { text: result } = await callAIFast(
      'You are an expert interview coach. Return only valid JSON arrays, no markdown.',
      prompt, 2000);
    // Parse JSON from result
    const clean = result.replace(/```json|```/g, '').trim();
    let questions;
    try { questions = JSON.parse(clean); }
    catch(e) {
      const match = clean.match(/\[[\s\S]*\]/);
      questions = match ? JSON.parse(match[0]) : [];
    }
    res.json({ questions });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tailor', authMiddleware, async (req, res) => {
  const { company, title, location, salary, postingText, content: rawDocContent, docType, context } = req.body;
  if (!rawDocContent || !docType) return res.status(400).json({ error: 'content and docType required' });
  // Strip any HTML tags that may have been stored in the document
  const hasHtml = rawDocContent.includes('<') && rawDocContent.includes('>');
  const docContent = hasHtml ? stripHtml(rawDocContent) : rawDocContent;

  const jobCtx = postingText ? '\nJob posting content:\n' + postingText.slice(0, 3000) : '';
  const docLabel = docType === 'resume' ? 'RESUME' : 'COVER LETTER';
  const outputLabel = docType === 'resume' ? 'TAILORED RESUME' : 'TAILORED COVER LETTER';

  const systemPrompt = 'You are a professional career coach and resume writer. Return ONLY the tailored document as plain text. Preserve the structure using plain text formatting: use ALL CAPS for section headings, hyphens for bullet points, and blank lines between sections. No HTML tags, no markdown, no backticks, no preamble, no explanation — just the plain text document starting immediately.';
  const userPrompt = 'Tailor this ' + docLabel + ' for the following role. Return ONLY the plain text document — no HTML, no markdown, no labels, no explanation.' +
    '\n\nCompany: ' + company +
    '\nRole: ' + title +
    (location ? '\nLocation: ' + location : '') +
    (salary ? '\nTarget salary: ' + salary : '') +
    (context ? '\nAdditional context: ' + context : '') +
    jobCtx +
    '\n\n' + docLabel + ' TO TAILOR:\n' + docContent;

  try {
    const aiResponse = await callAIFast(systemPrompt, userPrompt, 3000);
    const rawResult = aiResponse.text || aiResponse; // handle both {text} and plain string
    // Strip any HTML the AI may have returned despite instructions
    const hasHtmlOutput = rawResult.includes('<') && rawResult.includes('>') && /<[a-z][\s\S]*>/i.test(rawResult);
    const result = hasHtmlOutput ? stripHtml(rawResult) : rawResult;
    res.json({
      result: result.trim(),
      docType,
      provider: aiResponse.provider || 'unknown',
      model: aiResponse.model || 'unknown',
    });
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

  const userPrompt = `Research this job application for a candidate:

Company: ${company}
Role: ${title}
Location: ${location || 'Not specified'}
Salary target: ${salary || 'Not specified'}
${postingText ? `Job posting excerpt:\n${postingText.slice(0, 1500)}` : ''}

Return ONLY a valid JSON object with these exact fields (no markdown, no backticks):
{
  "overview": { "founded": "year or ~decade", "employees": "range e.g. 5,000-10,000", "hq": "city, country", "industry": "sector" },
  "companyOverview": "3-4 paragraph overview: mission, business model, financial health, recent layoffs or growth, market position, key products. Use specific numbers and recent data.",
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
  "roleIntel": "2-3 paragraphs: how often this role has been posted (turnover signal?), typical career trajectory from this role, what makes a strong candidate, level of seniority.",
  "flags": {
    "green": ["4-6 genuine positives: financial stability, culture, growth, benefits, mission"],
    "red": ["3-5 genuine concerns: layoffs, glassdoor issues, role reposted frequently, management problems, runway"]
  },
  "compensation": {
    "currency": "USD",
    "salaryRange": {
      "p25": 90000,
      "p50": 115000,
      "p75": 145000,
      "p90": 175000,
      "note": "1-sentence source note e.g. 'Based on Levels.fyi, Glassdoor, and LinkedIn Salary data for ${title} roles in ${location || 'US'}'"
    },
    "totalComp": {
      "p50": 145000,
      "breakdown": {
        "basePct": 72,
        "equityPct": 18,
        "bonusPct": 8,
        "benefitsPct": 2
      },
      "note": "1-sentence explaining total comp context for this company tier"
    },
    "equity": {
      "type": "RSU or Options or None (choose one)",
      "vestingSchedule": "e.g. 4-year vest, 1-year cliff",
      "typicalGrantUSD": 80000,
      "refreshCycle": "e.g. Annual performance refreshes",
      "note": "1-sentence context e.g. 'Pre-IPO options or public RSUs? Stage of company matters.'"
    },
    "geoContext": {
      "multiplier": 1.15,
      "description": "1 sentence: how ${location || 'this location'} affects pay vs. national average for this role. Include cost-of-living note if remote.",
      "remotePremium": "hub-rate (choose: location-adjusted, hub-rate, or mixed)"
    },
    "companyTier": {
      "tier": "above (choose: top, above, at, or below)",
      "label": "e.g. Top-of-market (FAANG-tier) | Above market | At market | Below market",
      "note": "1-2 sentences on why this company's pay lands where it does in the market"
    },
    "negotiationContext": {
      "leverage": "high (choose: high, medium, or low)",
      "signals": ["signal 1 e.g. Role has been open 3+ months", "signal 2 e.g. Competitive market for this skill set"],
      "tactic": "1-2 sentences of specific negotiation advice for this role/company combination"
    },
    "benchmarkSources": ["Levels.fyi", "Glassdoor", "LinkedIn Salary"]
  },
  "news": [
    {"headline": "Real recent headline", "source": "Source name", "date": "YYYY-MM-DD", "url": "https://real-url.com", "sentiment": "positive"},
    {"headline": "...", "source": "...", "date": "...", "url": "...", "sentiment": "negative"},
    {"headline": "...", "source": "...", "date": "...", "url": "...", "sentiment": "neutral"}
  ]
}`;

  try {
    const aiResponse = await callAIFast(systemPrompt, userPrompt, 4000);
    const finalText = (aiResponse.text || aiResponse || '').trim();
    console.log(`Insights: provider=${aiResponse.provider} model=${aiResponse.model} length=${finalText.length}`);
    if (!finalText) throw new Error('Empty response from AI');

    // Strip markdown fences and find outermost { }
    const cleaned = finalText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('Insights: no JSON braces. Raw response:', finalText.slice(0, 300));
      throw new Error('AI did not return JSON. Got: ' + finalText.slice(0, 150));
    }

    let jsonStr = cleaned.slice(start, end + 1);

    // Repair common truncation: if JSON is incomplete (no closing brace pair), try to close it
    let insights;
    try {
      insights = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('Insights: JSON parse failed:', parseErr.message);
      console.error('Insights: raw snippet:', jsonStr.slice(-300));
      // Try trimming to last complete top-level field
      const lastComma = jsonStr.lastIndexOf('"');
      if (lastComma > 0) {
        try {
          insights = JSON.parse(jsonStr.slice(0, lastComma + 1) + '}');
        } catch(e2) {
          throw new Error('JSON parse failed: ' + parseErr.message + '. Response may have been truncated at ' + finalText.length + ' chars.');
        }
      } else {
        throw new Error('JSON parse failed: ' + parseErr.message);
      }
    }
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

    const { text: tailoredRaw } = await callAIFast(systemPrompt, userPrompt, 4000);

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

    const { text: tailoredText } = await callAIFast(systemPrompt, userPrompt, 3000);

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
        `<p>Hi ${username},</p><p>An administrator has reset your Pursuit Job Tracker password.</p><p>Please <a href="${APP_URL}">sign in</a> with the new password provided to you.</p><p>If you didn't expect this, contact your administrator.</p>`
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
      `<p>Hi ${username},</p><p>A password reset was requested for your Pursuit Job Tracker account.</p><p><a href="${resetUrl}" style="padding:10px 20px;background:#a3e635;color:#1a1917;border-radius:6px;text-decoration:none;font-weight:600">Reset Password</a></p><p>This link expires in 1 hour. If you didn't request this, ignore this email.</p><p><small>Or paste this URL: ${resetUrl}</small></p>`
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
// ── Serve Chrome Extension as a clean zip with embedded tracker URL ──
app.get('/extension.zip', (req, res) => {
  const AdmZip = require('adm-zip');
  const extDir = path.join(__dirname, '../extension');

  try {
    const zip = new AdmZip();
    const trackerUrl = APP_URL;

    // popup.js — inject the live tracker URL
    const popupJs = fs.readFileSync(path.join(extDir, 'popup.js'), 'utf8')
      .replace(
        /const TRACKER_URL = '[^']*';/,
        `const TRACKER_URL = '${trackerUrl}';`
      );
    zip.addFile('popup.js', Buffer.from(popupJs, 'utf8'));

    // Other files added as-is
    for (const file of ['manifest.json', 'popup.html', 'content.js']) {
      const fp = path.join(extDir, file);
      if (fs.existsSync(fp)) zip.addLocalFile(fp);
    }
    for (const icon of ['icon16.png', 'icon48.png', 'icon128.png']) {
      const fp = path.join(extDir, icon);
      if (fs.existsSync(fp)) zip.addLocalFile(fp);
    }

    const zipBuffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="applied-extension.zip"');
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch(e) {
    console.error('Extension zip error:', e);
    res.status(500).json({ error: 'Could not build extension zip' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/admin.html'));
});

// Serve password reset page
app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/reset-password.html'));
});

// POST /api/forgot — recover username or send password reset link by email
app.post('/api/forgot', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const users = loadUsers();
  const normalEmail = email.toLowerCase().trim();

  // Find user(s) with this email
  const matches = Object.values(users).filter(u => u.email && u.email.toLowerCase() === normalEmail);

  // Always return success regardless (prevents email enumeration)
  const successMsg = "If an account exists with that email, we've sent recovery instructions.";

  if (matches.length === 0) {
    return res.json({ ok: true, message: successMsg });
  }

  const user = matches[0];
  const crypto = require('crypto');

  // Generate reset token
  const token = crypto.randomBytes(32).toString('hex');
  resetTokens[token] = { username: user.username.toLowerCase(), expires: Date.now() + 60 * 60 * 1000 };

  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  const emailHtml = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="font-size:20px;font-weight:600;margin-bottom:8px">Recover your Pursuit account</h2>
      <p style="color:#666;margin-bottom:16px">We received a request to recover access to your account.</p>
      <div style="background:#f5f5f3;border-radius:8px;padding:16px;margin-bottom:16px">
        <div style="font-size:12px;color:#888;margin-bottom:4px;font-family:monospace">YOUR USERNAME</div>
        <div style="font-size:18px;font-weight:600">${user.username}</div>
      </div>
      <p style="color:#444;margin-bottom:16px">To reset your password, click the button below. This link expires in <strong>1 hour</strong>.</p>
      <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#a3e635;color:#1a1917;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">Reset my password</a>
      <p style="color:#888;font-size:12px;margin-top:20px">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
    </div>`;

  await sendEmail(user.email, 'Recover your Pursuit account', emailHtml);

  res.json({ ok: true, message: successMsg });
});

// ═══════════════════════════════════════════
// ── ADMIN ROUTES (admin JWT required) ──
// ═══════════════════════════════════════════

// POST /api/admin/update-user — update email and other profile fields
app.post('/api/admin/update-user', adminMiddleware, (req, res) => {
  const { username, email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  const users = loadUsers();
  const key = username.toLowerCase();
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  users[key].email = email.toLowerCase().trim();
  saveUsers(users);
  res.json({ ok: true });
});

// GET /api/admin/users — list all users
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = loadUsers();
  // Admin sees ONLY public profile fields — no job data, no password hashes, no encryption keys
  const userList = Object.values(users).map(u => ({
    username: u.username,
    email: u.email || '',
    createdAt: u.createdAt,
    isActive: u.isActive !== false,
    isAdmin: u.isAdmin || false,
    lastLogin: u.lastLogin || null,
    // Note: job count intentionally omitted — job data is encrypted and private
  })).sort((a, b) => b.createdAt - a.createdAt);
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
      `<p>Hi ${users[key].username},</p><p>Your Pursuit Job Tracker account has been deactivated. Please contact the administrator if you believe this is an error.</p>`
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
      `<p>Hi ${users[key].username},</p><p>Your Pursuit Job Tracker password has been reset by an administrator.</p><p>Your new temporary password is: <strong>${newPassword}</strong></p><p>Please log in and change your password immediately.</p><p><a href="${APP_URL}">Open Pursuit</a></p>`
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
    `<p>Hi ${users[key].username},</p><p>Click the link below to reset your Pursuit Job Tracker password. This link expires in 1 hour.</p><p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#a3e635;color:#1a1917;text-decoration:none;border-radius:6px;font-weight:600">Reset Password</a></p><p>Or copy this URL: ${resetUrl}</p><p>If you didn't request this, ignore this email.</p>`
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

// ── Account recovery with recovery code ──
app.post('/api/recover', async (req, res) => {
  // Zero-knowledge recovery:
  // 1. Browser submits code — server verifies bcrypt hash (rate limiting), returns matching slot
  // 2. Browser decrypts slot with PBKDF2(code) to get dataKey
  // 3. Browser re-wraps dataKey with PBKDF2(newPassword) → newEncryptedDataKey
  // 4. Browser sends newEncryptedDataKey back — server stores it without ever seeing the key
  const { username, recoveryCode, newPassword, newEncryptedDataKey, slotIndex } = req.body;
  if (!username || !recoveryCode || !newPassword)
    return res.status(400).json({ error: 'username, recoveryCode, and newPassword required' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters' });

  const users = loadUsers();
  const key = username.toLowerCase().trim();
  const user = users[key];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.recoveryCodes || user.recoveryCodes.length === 0)
    return res.status(400).json({ error: 'No recovery codes on file. Contact admin.' });

  // Verify code against bcrypt hashes (prevents brute force)
  const clean = recoveryCode.replace(/-/g, '').toUpperCase();
  let matchedIndex = -1;
  for (let i = 0; i < user.recoveryCodes.length; i++) {
    const ok = await bcrypt.compare(clean, user.recoveryCodes[i]);
    if (ok) { matchedIndex = i; break; }
  }
  if (matchedIndex < 0) return res.status(400).json({ error: 'Invalid or already-used recovery code' });

  // If browser sent the new encrypted data key, store it (zero-knowledge recovery complete)
  // If not, return the recovery key slot so the browser can derive the new key
  if (newEncryptedDataKey) {
    // Phase 2: store the re-wrapped key and complete recovery
    user.recoveryCodes.splice(matchedIndex, 1); // consume code
    user.password = await bcrypt.hash(newPassword, 12);
    user.encryptedDataKey = newEncryptedDataKey;
    user.recoveryUsedAt = Date.now();
    saveUsers(users);
    const token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ ok: true, token, username: user.username, codesRemaining: user.recoveryCodes.length, encryptedDataKey: newEncryptedDataKey });
  } else {
    // Phase 1: return the matching recovery slot so browser can decrypt the dataKey
    const slot = user.recoveryKeySlots?.[matchedIndex] || null;
    return res.json({ ok: true, phase: 1, slot, slotIndex: matchedIndex, encrypted: user.encrypted || false });
  }
});

// ── Generate fresh recovery codes (requires password confirmation) ──
app.post('/api/recovery-codes/regenerate', authMiddleware, async (req, res) => {
  const { password, recoveryKeySlots } = req.body;
  if (!password) return res.status(400).json({ error: 'Current password required' });

  const users = loadUsers();
  const user = users[req.user.username.toLowerCase()];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Incorrect password' });

  // Generate 8 new codes (plaintext returned once, bcrypt hashes stored)
  const codes = generateRecoveryCodes(8);
  const formatted = codes.map(c => c.match(/.{1,4}/g).join('-'));
  user.recoveryCodes = await Promise.all(codes.map(c => bcrypt.hash(c, 10)));
  user.recoveryCodesCreatedAt = Date.now();
  // Zero-knowledge: store browser-generated key slots (opaque to server)
  if (recoveryKeySlots && recoveryKeySlots.length) {
    user.recoveryKeySlots = recoveryKeySlots;
  }
  saveUsers(users);

  res.json({ recoveryCodes: formatted, createdAt: user.recoveryCodesCreatedAt });
});

// ── Get recovery code metadata (count remaining, created date) ──
app.get('/api/recovery-codes', authMiddleware, (req, res) => {
  const users = loadUsers();
  const user = users[req.user.username.toLowerCase()];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    count: user.recoveryCodes?.length || 0,
    createdAt: user.recoveryCodesCreatedAt || null,
  });
});

// ── Admin: reset a user's recovery codes ──
app.post('/api/admin/reset-recovery-codes', adminMiddleware, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const users = loadUsers();
  const key = username.toLowerCase();
  if (!users[key]) return res.status(404).json({ error: 'User not found' });

  const codes = generateRecoveryCodes(8);
  const formatted = codes.map(c => c.match(/.{1,4}/g).join('-'));
  users[key].recoveryCodes = await Promise.all(codes.map(c => bcrypt.hash(c, 10)));
  users[key].recoveryCodesCreatedAt = Date.now();
  saveUsers(users);

  // Optionally email them if SMTP configured
  if (users[key].email) {
    try {
      await sendMail(users[key].email, 'New recovery codes for your Applied account',
        `<p>Hi ${users[key].username},</p>
        <p>An admin has generated new recovery codes for your account. Store these somewhere safe — each can only be used once:</p>
        <pre style="font-size:16px;letter-spacing:2px;line-height:2">${formatted.join('\n')}</pre>
        <p>If you did not request this, contact your admin immediately.</p>`
      );
    } catch(e) { console.warn('Could not email recovery codes:', e.message); }
  }

  res.json({ ok: true, recoveryCodes: formatted });
});

// ── Data Import — strict validation and sanitization ──
const ALLOWED_STATUSES = new Set(['to apply','applied','screening','interviewing','offer','rejected','ghosted','withdrawn','expired']);
const MAX_IMPORT_SIZE  = 10 * 1024 * 1024; // 10MB hard limit
const MAX_JOBS         = 2000;             // sanity cap
const MAX_STR          = 2000;             // max chars per string field
const MAX_NOTE_TEXT    = 50000;            // notes can be longer
const MAX_RESUME_TEXT  = 200000;          // tailored docs

function sanitizeStr(v, maxLen = MAX_STR) {
  if (v == null) return '';
  // Strip all HTML tags — import is plaintext only
  return String(v).replace(/<[^>]*>/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, maxLen).trim();
}

function sanitizeUrl(v) {
  if (!v) return '';
  const s = sanitizeStr(v, 2048);
  // Only allow http/https URLs
  if (!/^https?:\/\//i.test(s)) return '';
  // Block local/internal addresses
  if (/localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./i.test(s)) return '';
  return s;
}

function sanitizeNote(n) {
  if (!n || typeof n !== 'object') return null;
  const text = sanitizeStr(n.text, MAX_NOTE_TEXT);
  const ts   = Number(n.ts) || 0;
  if (!text) return null;
  if (ts < 0 || ts > Date.now() + 86400000) return null; // reject future timestamps (>1d ahead)
  return { text, ts };
}

function sanitizeContact(c) {
  if (!c || typeof c !== 'object') return null;
  const name = sanitizeStr(c.name, 200);
  if (!name) return null;
  return {
    name,
    role:        sanitizeStr(c.role,        200),
    email:       sanitizeStr(c.email,       200).replace(/[^a-zA-Z0-9@._+-]/g, ''),
    linkedin:    sanitizeUrl(c.linkedin),
    notes:       sanitizeStr(c.notes,       2000),
    lastContact: c.lastContact ? sanitizeStr(String(c.lastContact), 50) : null,
  };
}

function sanitizeInterview(q) {
  if (!q || typeof q !== 'object') return null;
  const question = sanitizeStr(q.question, 2000);
  if (!question) return null;
  const allowedCats = new Set(['general','behavioral','technical','situational','company','custom']);
  return {
    question,
    category:  allowedCats.has(q.category) ? q.category : 'general',
    practiced: !!q.practiced,
    notes:     sanitizeStr(q.notes, 2000),
  };
}

function sanitizeJob(j, index) {
  if (!j || typeof j !== 'object') throw new Error(`Job ${index}: not an object`);
  const title   = sanitizeStr(j.title,   300);
  const company = sanitizeStr(j.company, 300);
  if (!title && !company) throw new Error(`Job ${index}: must have at least a title or company`);

  const status = ALLOWED_STATUSES.has(j.status) ? j.status : 'applied';
  const createdAt = (Number(j.createdAt) > 0 && Number(j.createdAt) < Date.now() + 86400000)
    ? Number(j.createdAt) : Date.now();

  const notes      = (Array.isArray(j.notes)      ? j.notes      : []).map(sanitizeNote).filter(Boolean).slice(0, 500);
  const contacts   = (Array.isArray(j.contacts)   ? j.contacts   : []).map(sanitizeContact).filter(Boolean).slice(0, 200);
  const interviews = (Array.isArray(j.interviews) ? j.interviews : []).map(sanitizeInterview).filter(Boolean).slice(0, 500);

  return {
    id:          'imp_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36),
    title,
    company,
    location:    sanitizeStr(j.location,     300),
    workType:    sanitizeStr(j.workType,     50),
    salary:      sanitizeStr(j.salary,       100),
    status,
    url:         sanitizeUrl(j.url),
    source:      sanitizeStr(j.source,       200),
    referredBy:  sanitizeStr(j.referredBy,   200),
    deadline:    sanitizeStr(j.deadline,     50),
    followUpDate:sanitizeStr(j.followUpDate, 50),
    createdAt,
    importedAt:  Date.now(),
    notes,
    contacts,
    interviews,
    tailoredResume: j.tailoredResume ? sanitizeStr(String(j.tailoredResume), MAX_RESUME_TEXT) : null,
    tailoredCover:  j.tailoredCover  ? sanitizeStr(String(j.tailoredCover),  MAX_RESUME_TEXT) : null,
  };
}

app.post('/api/import-data', authMiddleware, express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const body = req.body;

    // ── Structural validation ──
    if (!body || typeof body !== 'object')        throw new Error('Invalid format: expected JSON object');
    if (body.__app !== 'applied-tracker')         throw new Error('Invalid file: not an Applied export');
    if (!Number.isInteger(body.__version) || body.__version < 1 || body.__version > 10)
                                                  throw new Error('Invalid or unsupported export version');
    if (!Array.isArray(body.jobs))                throw new Error('Invalid format: jobs must be an array');
    if (body.jobs.length > MAX_JOBS)              throw new Error(`Import exceeds maximum of ${MAX_JOBS} jobs`);

    // ── Sanitize every job (throws on bad data) ──
    const sanitized = body.jobs.map((j, i) => sanitizeJob(j, i));

    // ── Merge strategy: append imported jobs (don't overwrite existing) ──
    const { mode = 'append' } = body;
    if (!['append', 'replace'].includes(mode))   throw new Error('mode must be "append" or "replace"');

    // Load current jobs (server just sees the raw blob for zero-knowledge accounts)
    const jobsFile = path.join(JOBS_DIR, `${req.user.id}.json`);
    let currentBlob = { __enc: false, data: {} };
    if (fs.existsSync(jobsFile)) {
      try { currentBlob = JSON.parse(fs.readFileSync(jobsFile, 'utf8')); } catch(e) {}
    }

    // For zero-knowledge accounts the server can't merge into the ciphertext —
    // the client must handle that. Signal this back.
    if (currentBlob.__enc === true) {
      // Return the sanitized jobs for the browser to encrypt+merge
      return res.json({ ok: true, zerKnowledge: true, sanitizedJobs: sanitized, mode, count: sanitized.length });
    }

    // Plaintext merge
    const current = (currentBlob.__enc === false ? currentBlob.data : currentBlob) || {};
    let merged;
    if (mode === 'replace') {
      merged = Object.fromEntries(sanitized.map(j => [j.id, j]));
    } else {
      // append — give imported jobs new IDs to avoid conflicts
      merged = { ...current, ...Object.fromEntries(sanitized.map(j => [j.id, j])) };
    }

    fs.writeFileSync(jobsFile, JSON.stringify({ __enc: false, data: merged }));
    res.json({ ok: true, count: sanitized.length, mode, zerKnowledge: false });

  } catch(e) {
    console.error('Import error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── Enable zero-knowledge encryption for existing plaintext accounts ──
app.post('/api/enable-encryption', authMiddleware, async (req, res) => {
  const { password, encryptedDataKey, recoveryKeySlots, encryptedJobs } = req.body;
  if (!password || !encryptedDataKey || !encryptedJobs)
    return res.status(400).json({ error: 'password, encryptedDataKey, and encryptedJobs required' });

  const users = loadUsers();
  const userKey = Object.keys(users).find(k => users[k].id === req.user.id);
  if (!userKey) return res.status(404).json({ error: 'User not found' });
  const user = users[userKey];

  // Verify password
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  // Already encrypted — don't double-encrypt
  if (user.encrypted) return res.status(400).json({ error: 'Account is already encrypted' });

  // Generate fresh recovery codes (bcrypt hashes for rate limiting)
  const codes = generateRecoveryCodes(8);
  const codeHashes = await Promise.all(codes.map(c => bcrypt.hash(c, 10)));

  // Update user with encryption metadata
  user.encrypted = true;
  user.encryptedDataKey = encryptedDataKey;
  user.recoveryKeySlots = recoveryKeySlots || [];
  user.recoveryCodes = codeHashes;
  user.recoveryCodesCreatedAt = Date.now();
  user.encryptedAt = Date.now();
  saveUsers(users);

  // Store the encrypted jobs blob
  const jobsFile = path.join(JOBS_DIR, `${req.user.id}.json`);
  if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(jobsFile, JSON.stringify({ __enc: true, data: encryptedJobs }));

  res.json({ ok: true });
});


// ══════════════════════════════════════════
// FEATURE: Keyword Gap Analysis
// ══════════════════════════════════════════
app.post('/api/keyword-gap', authMiddleware, async (req, res) => {
  const { resumeText, jobPosting, jobTitle, company } = req.body;
  if (!resumeText || !jobPosting) return res.status(400).json({ error: 'resumeText and jobPosting required' });

  const systemPrompt = 'You are an expert ATS analyst and career coach. Return ONLY valid JSON with no markdown.';
  const userPrompt = `Analyze keyword gaps between this resume and job posting.

JOB: ${company} — ${jobTitle}

JOB POSTING:
${jobPosting.slice(0, 3000)}

RESUME:
${resumeText.slice(0, 3000)}

Return ONLY this JSON:
{
  "missingCritical": ["keyword1", "keyword2"],
  "missingNice": ["keyword3"],
  "present": ["keyword4", "keyword5"],
  "matchScore": 72,
  "topRecommendations": ["Add 'Python' to skills section", "Mention 'agile' in experience"],
  "atsRisk": "medium"
}`;

  try {
    const { text: raw } = await callAI(['openrouter', 'groq', 'google'], systemPrompt, userPrompt, 1500);
    const clean = raw.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// FEATURE: Email Templates
// ══════════════════════════════════════════
app.post('/api/email-template', authMiddleware, async (req, res) => {
  const { type, company, title, contactName, context } = req.body;
  const templates = {
    'thank-you':  `Write a concise, genuine thank-you email after a job interview at ${company} for the ${title} role${contactName ? ' addressed to ' + contactName : ''}. ${context || ''} Be warm but professional, 3-4 sentences, no clichés.`,
    'follow-up':  `Write a polite follow-up email to ${company} about the ${title} application I submitted 2 weeks ago. ${context || ''} Express continued interest, ask for an update, 2-3 sentences.`,
    'decline':    `Write a gracious email declining the ${title} offer from ${company}. ${context || ''} Keep the door open, be appreciative, brief.`,
    'negotiate':  `Write a salary negotiation email for the ${title} offer from ${company}. ${context || ''} Be confident but collaborative, provide a counter range.`,
    'referral':   `Write an outreach email to ${contactName || 'a contact'} at ${company} asking about the ${title} role. ${context || ''} Brief, genuine, not pushy.`,
    'withdraw':   `Write a professional email withdrawing my application for ${title} at ${company}. ${context || ''} Brief, appreciative, leaves good impression.`,
  };
  if (!templates[type]) return res.status(400).json({ error: 'Invalid template type' });

  const systemPrompt = 'You are a professional career coach who writes authentic, human-sounding emails. Never use generic AI phrases. Return only the email body text, no subject line.';
  try {
    const { text: body } = await callAI(['openrouter', 'groq', 'google'], systemPrompt, templates[type], 500);
    // Generate subject line too
    const { text: subject } = await callAI(['groq', 'openrouter', 'google'], 'Write only a concise email subject line, no quotes.', `Type: ${type}, Company: ${company}, Role: ${title}`, 80);
    res.json({ subject: subject.trim(), body: body.trim() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// FEATURE: Salary Benchmarking
// ══════════════════════════════════════════
app.post('/api/salary-benchmark', authMiddleware, async (req, res) => {
  const { title, location, company, experience } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const systemPrompt = 'You are a compensation analyst with deep knowledge of market salaries. Return ONLY valid JSON, no markdown.';
  const userPrompt = `Provide salary benchmarking data for:
Role: ${title}
Location: ${location || 'United States'}
Company: ${company || 'unknown'}
Experience level: ${experience || 'mid-level'}

Return ONLY this JSON (use realistic current market data):
{
  "p25": 95000,
  "p50": 115000,
  "p75": 140000,
  "p90": 170000,
  "currency": "USD",
  "totalComp50": 130000,
  "notes": "Senior roles at FAANG pay 30-50% above market",
  "sources": ["Levels.fyi", "Glassdoor", "LinkedIn Salary"],
  "negotiationTips": ["tip1", "tip2"]
}`;

  try {
    const { text: raw } = await callAI(['openrouter', 'groq', 'google'], systemPrompt, userPrompt, 800);
    const clean = raw.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
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
