'use strict';
const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const fs         = require('fs');
const path       = require('path');
const cors       = require('cors');
const multer     = require('multer');
const pdfParse   = require('pdf-parse');
const mammoth    = require('mammoth');
const archiver   = require('archiver');
const crypto     = require('crypto');

const app = express();

// ── Environment ──────────────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 3000;
const JWT_SECRET     = process.env.JWT_SECRET     || 'change-this-secret-please';
const DATA_DIR       = process.env.DATA_DIR       || path.join(__dirname, 'data');
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || '';
const APP_URL        = process.env.APP_URL        || 'https://job-application-tracker-hf1f.onrender.com';
const GROQ_API_KEY   = process.env.GROQ_API_KEY   || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GROQ_MODEL     = process.env.GROQ_MODEL     || 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
const GOOGLE_MODEL   = process.env.GOOGLE_MODEL   || 'gemini-2.0-flash';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Data directories ─────────────────────────────────────────────────────────
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const JOBS_DIR    = path.join(DATA_DIR, 'jobs');
const DOCS_DIR    = path.join(DATA_DIR, 'docs');
const SETTINGS_DIR = path.join(DATA_DIR, 'settings');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
for (const d of [DATA_DIR, JOBS_DIR, DOCS_DIR, SETTINGS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── Auto-migrate users: rename 'password' field to 'passwordHash' ──
// Old server stored bcrypt hash as 'password', new server uses 'passwordHash'
try {
  if (fs.existsSync(USERS_FILE)) {
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    let migrated = 0;
    for (const [k, v] of Object.entries(users)) {
      if (v.password && !v.passwordHash) {
        v.passwordHash = v.password;
        delete v.password;
        migrated++;
      }
    }
    if (migrated > 0) {
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
      console.log(`✓ Migrated ${migrated} user(s): password → passwordHash`);
    }
  }
} catch(e) { console.warn('Migration warning:', e.message); }

// ── Crypto helpers ───────────────────────────────────────────────────────────
const CIPHER = 'aes-256-gcm';

function encryptData(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv(CIPHER, key, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + enc.toString('hex');
}

function decryptData(ciphertext, keyHex) {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext');
  const key = Buffer.from(keyHex, 'hex');
  const d   = crypto.createDecipheriv(CIPHER, key, Buffer.from(parts[0], 'hex'));
  d.setAuthTag(Buffer.from(parts[1], 'hex'));
  return Buffer.concat([d.update(Buffer.from(parts[2], 'hex')), d.final()]).toString('utf8');
}

function wrapDataKey(keyHex) {
  const secret = JWT_SECRET.slice(0, 32).padEnd(32, '0');
  return encryptData(keyHex, Buffer.from(secret).toString('hex'));
}

function unwrapDataKey(wrapped) {
  const secret = JWT_SECRET.slice(0, 32).padEnd(32, '0');
  return decryptData(wrapped, Buffer.from(secret).toString('hex'));
}

// ── Storage helpers ──────────────────────────────────────────────────────────
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

function loadUserJobs(userId, dataKey) {
  const f = path.join(JOBS_DIR, `${userId}.json`);
  if (!fs.existsSync(f)) return {};
  const raw = fs.readFileSync(f, 'utf8');
  if (dataKey && raw.includes(':') && !raw.startsWith('{')) {
    try { return JSON.parse(decryptData(raw, dataKey)); } catch {}
  }
  try { return JSON.parse(raw); } catch { return {}; }
}
function saveUserJobs(userId, data, dataKey) {
  const json = JSON.stringify(data);
  fs.writeFileSync(path.join(JOBS_DIR, `${userId}.json`), dataKey ? encryptData(json, dataKey) : json);
}

function loadUserDocs(userId) {
  const f = path.join(DOCS_DIR, `${userId}.json`);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}
function saveUserDocs(userId, docs) {
  fs.writeFileSync(path.join(DOCS_DIR, `${userId}.json`), JSON.stringify(docs));
}

// ── User settings (account-level preferences like Finnhub key) ─────────────
// Mirrors jobs: body may be a plain object OR { __enc: true, data: ciphertext }
// for zero-knowledge accounts. Server stores whatever opaquely and never
// inspects the contents for encrypted accounts. Server-side at-rest encryption
// is also applied when req.dataKey is available (double-wrap, same as jobs).
function loadUserSettings(userId, dataKey) {
  const f = path.join(SETTINGS_DIR, `${userId}.json`);
  if (!fs.existsSync(f)) return {};
  const raw = fs.readFileSync(f, 'utf8');
  if (dataKey && raw.includes(':') && !raw.startsWith('{')) {
    try { return JSON.parse(decryptData(raw, dataKey)); } catch {}
  }
  try { return JSON.parse(raw); } catch { return {}; }
}
function saveUserSettings(userId, data, dataKey) {
  const json = JSON.stringify(data);
  fs.writeFileSync(path.join(SETTINGS_DIR, `${userId}.json`), dataKey ? encryptData(json, dataKey) : json);
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { return {}; }
}
function saveTokens(t) { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t)); }

function genId() { return crypto.randomBytes(8).toString('hex'); }

// ── Express setup ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend/public'), {
  setHeaders(res, fp) {
    if (fp.endsWith('sw.js'))          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (fp.endsWith('manifest.json')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = ['.pdf','.doc','.docx','.txt'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only PDF, Word, or TXT allowed'), ok);
  }
});

// ── Auth middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    if (req.user.wrappedKey) { try { req.dataKey = unwrapDataKey(req.user.wrappedKey); } catch {} }
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminMiddleware(req, res, next) {
  const s = req.headers['x-admin-secret'] || req.query.secret;
  if (!ADMIN_SECRET || s !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── AI helpers ───────────────────────────────────────────────────────────────
async function fetchTimeout(url, opts, ms = 20000) {
  const ctrl = new AbortController();
  // Belt-and-suspenders: AbortController + hard Promise.race timeout
  // Node native fetch sometimes ignores abort signals on Render's free tier
  const fetchProm = fetch(url, { ...opts, signal: ctrl.signal });
  const timeoutProm = new Promise((_, reject) =>
    setTimeout(() => { ctrl.abort(); reject(new Error(`Timeout ${ms}ms: ${url.slice(0,60)}`)); }, ms)
  );
  return Promise.race([fetchProm, timeoutProm]);
}

async function callGroq(sys, usr, maxTok = 4000) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const r = await fetchTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, max_tokens: maxTok, temperature: 0.3,
      messages: [{ role:'system', content:sys }, { role:'user', content:usr }] })
  });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0,200)}`);
  return (await r.json()).choices[0].message.content;
}

async function callOpenRouter(sys, usr, maxTok = 4000) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  const r = await fetchTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': APP_URL, 'X-Title': 'Applied Job Tracker' },
    body: JSON.stringify({ model: OPENROUTER_MODEL, max_tokens: maxTok, temperature: 0.3,
      messages: [{ role:'system', content:sys }, { role:'user', content:usr }] })
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0,200)}`);
  return (await r.json()).choices[0].message.content;
}

async function callGoogle(sys, usr, maxTok = 4000) {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;
  const r = await fetchTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: usr }] }],
      generationConfig: { maxOutputTokens: maxTok, temperature: 0.3 }
    })
  });
  if (!r.ok) throw new Error(`Google ${r.status}: ${(await r.text()).slice(0,200)}`);
  return (await r.json()).candidates[0].content.parts[0].text;
}

async function callAI(order, sys, usr, maxTok = 4000) {
  const fns = { groq: callGroq, openrouter: callOpenRouter, google: callGoogle };
  const errs = [];
  for (const name of order) {
    try {
      const text = await fns[name](sys, usr, maxTok);
      console.log(`AI ok: ${name}`);
      return text;
    } catch (e) {
      console.warn(`AI ${name} fail: ${e.message}`);
      errs.push(`${name}: ${e.message}`);
    }
  }
  throw new Error('All AI failed: ' + errs.join(' | '));
}

function parseJson(raw) {
  // Strip markdown fences
  let s = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  // Remove any leading text before the first {
  const brace = s.indexOf('{');
  if (brace > 0) s = s.slice(brace);
  // Try straight parse first — clean success, no partial flag
  try { return JSON.parse(s); } catch {}
  // Strategy 2: truncate at the last valid closing brace
  // Handles cases where the AI appended trailing garbage after a complete object
  let depth = 0, lastValid = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { lastValid = i; break; } }
  }
  if (lastValid > 0) {
    try { return JSON.parse(s.slice(0, lastValid + 1)); } catch {}
  }
  // Strategy 3: truncate at last complete top-level key-value pair (LOSSY)
  // Walk back from end to find a position where JSON is valid.
  // This silently drops any fields after the truncation point — so we flag it.
  for (let i = s.length - 1; i > 100; i--) {
    if (s[i] === ',' || s[i] === '}') {
      const attempt = s.slice(0, i).replace(/,\s*$/, '') + '}';
      try {
        const parsed = JSON.parse(attempt);
        // Mark as partial so callers can surface a retry UI
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsed._partial = true;
        }
        return parsed;
      } catch {}
    }
  }
  throw new Error('JSON parse failed after repair attempts');
}

// ════════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3)    return res.status(400).json({ error: 'Username must be 3+ chars' });
  if (password.length < 6)    return res.status(400).json({ error: 'Password must be 6+ chars' });
  const users = loadUsers();
  const uid = username.toLowerCase();
  if (users[uid]) return res.status(409).json({ error: 'Username already taken' });
  users[uid] = { username, passwordHash: await bcrypt.hash(password, 12), createdAt: Date.now() };
  saveUsers(users);
  const token = jwt.sign({ id: uid, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username });
});

app.get('/api/ping', (req, res) => res.json({ ok: true, version: '1.5.0', dataDir: DATA_DIR, usersExist: fs.existsSync(USERS_FILE) }));

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const users = loadUsers();
  const uid = username.toLowerCase();
  // Support lookup by lowercase username key OR by 'id' field
  let user = users[uid];
  if (!user) {
    // fallback: search by username field
    user = Object.values(users).find(u => (u.username||'').toLowerCase() === uid || (u.id||'').toLowerCase() === uid);
  }
  if (!user) {
    console.log(`Login failed: user '${uid}' not found. Known users: ${Object.keys(users).join(', ')}`);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  // Old server stored hash as 'password', new as 'passwordHash'
  const hashField = user.password || user.passwordHash;
  if (!hashField || !(await bcrypt.compare(password, hashField)))
    return res.status(401).json({ error: 'Invalid username or password' });
  // When saving future logins, normalise to passwordHash
  if (user.password && !user.passwordHash) {
    user.passwordHash = user.password;
  }
  const payload = { id: username.toLowerCase(), username: user.username };
  if (user.wrappedKey) payload.wrappedKey = user.wrappedKey;
  res.json({ token: jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' }), username: user.username });
});

app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password too short' });
  const users = loadUsers();
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const existingHash = user.passwordHash || user.password;
  if (!(await bcrypt.compare(currentPassword, existingHash)))
    return res.status(401).json({ error: 'Current password incorrect' });
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  delete user.password; // normalise field name
  saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/delete-account', authMiddleware, (req, res) => {
  const { username } = req.body;
  if (username?.toLowerCase() !== req.user.id)
    return res.status(400).json({ error: 'Username mismatch' });
  const users = loadUsers();
  delete users[req.user.id];
  saveUsers(users);
  for (const f of [path.join(JOBS_DIR,`${req.user.id}.json`), path.join(DOCS_DIR,`${req.user.id}.json`)]) {
    try { fs.unlinkSync(f); } catch {}
  }
  res.json({ ok: true });
});

app.post('/api/forgot', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const users = loadUsers();
  const user  = users[username.toLowerCase()];
  if (!user) return res.json({ ok: true }); // don't reveal existence
  const token = crypto.randomBytes(32).toString('hex');
  const tokens = loadTokens();
  tokens[token] = { username: username.toLowerCase(), expiresAt: Date.now() + 3600000 };
  saveTokens(tokens);
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  console.log(`Reset URL for ${username}: ${resetUrl}`);
  res.json({ ok: true, resetUrl });
});

app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword required' });
  const tokens = loadTokens();
  const entry  = tokens[token];
  if (!entry || Date.now() > entry.expiresAt) {
    delete tokens[token]; saveTokens(tokens);
    return res.status(400).json({ error: 'Reset link invalid or expired' });
  }
  const users = loadUsers();
  const user  = users[entry.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  saveUsers(users);
  delete tokens[token]; saveTokens(tokens);
  res.json({ ok: true, username: user.username });
});

// ════════════════════════════════════════════════════════════════════════════════
// JOB DATA
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/jobs', authMiddleware, (req, res) => {
  res.json(loadUserJobs(req.user.id, req.dataKey));
});

app.put('/api/jobs', authMiddleware, (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid data' });
  saveUserJobs(req.user.id, req.body, req.dataKey);
  res.json({ ok: true });
});

// ── User settings (Finnhub key and future account-level prefs) ──────────────
app.get('/api/user-settings', authMiddleware, (req, res) => {
  const f = path.join(SETTINGS_DIR, `${req.user.id}.json`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'No settings saved' });
  res.json(loadUserSettings(req.user.id, req.dataKey));
});

app.put('/api/user-settings', authMiddleware, (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid data' });
  saveUserSettings(req.user.id, req.body, req.dataKey);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// FILE PARSING
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/parse-file', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  let text = '', html = '';
  try {
    if (ext === '.pdf') {
      text = (await pdfParse(req.file.buffer)).text;
    } else if (ext === '.docx' || ext === '.doc') {
      const r = await mammoth.convertToHtml({ buffer: req.file.buffer });
      html = r.value;
      text = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    } else {
      text = req.file.buffer.toString('utf8');
    }
  } catch { text = req.file.buffer.toString('utf8'); }
  res.json({ text, html, name: req.file.originalname, size: req.file.size });
});

// ── ATS helpers ──────────────────────────────────────────────────────────────
const { cleanJobUrl, slugFallback } = require('./ats-helpers');

async function fetchATS(rawUrl) {
  const url = cleanJobUrl(rawUrl);

  // 1. Jina.ai reader renders JS and bypasses most bot blocks
  try {
    const r = await fetchTimeout('https://r.jina.ai/' + url, {
      headers: { 'User-Agent': UA, Accept: 'text/plain,*/*', 'X-Return-Format': 'text' }
    }, 12000);
    if (r.ok) {
      const raw = await r.text();
      // Jina returns MARKDOWN. Strip all markdown syntax to leave clean prose —
      // not just links — otherwise **bold**, ##headers, >quotes, - bullets leak
      // through to the posting tab as literal characters.
      const text = raw
        // Frontmatter-style lines Jina prepends
        .replace(/^(Title|URL Source|URL|Published Time|Markdown Content|Description):[^\n]*\n/gim, '')
        // Links and images — keep link text, drop URLs
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // Reference-style links
        .replace(/^\s*\[[^\]]+\]:\s*\S.*$/gm, '')
        // Headings (# to ######) — keep text, drop hashes
        .replace(/^\s*#{1,6}\s+/gm, '')
        // Blockquote markers
        .replace(/^\s*>\s?/gm, '')
        // Unordered list markers → bullet, ordered list markers → stripped
        .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
        .replace(/^(\s*)\d+\.\s+/gm, '$1')
        // Horizontal rules
        .replace(/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/gm, '')
        // Emphasis: ***x***, **x**, __x__, *x*, _x_ → x
        .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(?<!\w)[*_]([^*_\n]+?)[*_](?!\w)/g, '$1')
        // Inline code and code fences
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        // Strikethrough ~~x~~
        .replace(/~~(.+?)~~/g, '$1')
        // Tidy whitespace
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
      if (text.length > 200) {
        return { text, salary: extractSalaryFromText(text), html: '', _via: 'jina' };
      }
    }
  } catch {}

  // 2. Direct fetch with real browser UA — works for SSR pages
  try {
    const r = await fetchTimeout(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.google.com/',
      }
    }, 15000);
    if (r.ok) {
      const html = await r.text();
      const text = htmlToText(html);
      const salary = extractSalaryFromText(text) || extractSalaryFromHtml(html);
      let fields = null;
      const ldBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
      for (const block of ldBlocks) {
        try {
          const data = JSON.parse(block.replace(/<script[^>]*>|<\/script>/gi,'').trim());
          const job = Array.isArray(data)
            ? data.find(d => d['@type'] === 'JobPosting')
            : (data['@type'] === 'JobPosting' ? data : null);
          if (job && job.title) {
            const loc = job.jobLocation && job.jobLocation.address;
            fields = {
              title:    job.title,
              company:  (job.hiringOrganization && job.hiringOrganization.name) || null,
              location: loc ? [loc.addressLocality, loc.addressRegion].filter(Boolean).join(', ') || null : null,
              workType: job.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null,
              salary,
            };
            break;
          }
        } catch {}
      }
      if (text.length > 200) {
        return { fields, text, html: html.slice(0, 200000), salary, _via: 'fetch' };
      }
    }
  } catch {}

  // 3. Slug fallback — title/company from URL path only
  return { fields: slugFallback(url), text: '', html: '', salary: null, _via: 'slug' };
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/p>/gi,'\n\n')
    .replace(/<\/li>/gi,'\n')
    .replace(/<li[^>]*>/gi,'\u2022 ')
    .replace(/<\/h[1-6]>/gi,'\n\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")
    .replace(/&[a-z0-9]+;/gi,' ')
    .replace(/[ \t]+/g,' ').replace(/\n{4,}/g,'\n\n\n').trim();
}

function extractSalaryFromText(text) {
  const m = text.match(/\$([\d,]+(?:\.\d+)?)\s*[kK]?\s*[-\u2013\u2014to]+\s*\$([\d,]+(?:\.\d+)?)\s*[kK]?/);
  if (!m) return null;
  const isK = /[kK]/.test(m[0]);
  const fmt = (raw) => {
    const n = parseFloat(raw.replace(/,/g,'')) * (isK && parseFloat(raw.replace(/,/g,'')) < 1000 ? 1000 : 1);
    return n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString();
  };
  return fmt(m[1]) + '\u2013' + fmt(m[2]);
}

function extractSalaryFromHtml(html) {
  const m = html.match(/<bdi>\s*\$([\d,]+(?:\.\d+)?)\s*<\/bdi>\s*-\s*<bdi>\s*\$([\d,]+(?:\.\d+)?)\s*<\/bdi>/i);
  if (!m) return null;
  const fmt = s => { const n = parseFloat(s.replace(/,/g,'')); return n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n).toLocaleString(); };
  return fmt(m[1]) + '\u2013' + fmt(m[2]);
}

app.post('/api/parse-job', authMiddleware, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    res.json(await fetchATS(url));
  } catch (e) { res.json({ html:'', text:'', error: e.message }); }
});

// ── Public mirror finder ────────────────────────────────────────────────────
// When the original posting URL is blocked (Cloudflare etc.), search the web for
// the same job on an unprotected source (company careers, Greenhouse, Lever,
// Ashby, Workable, SmartRecruiters, BreezyHR, Recruitee). Verify the match via
// AI before returning, so we don't hand back "a different Senior Engineer role."
//
// Returns { ok, mirrorUrl, via, reason? }. Called lazily on refetch failure —
// once found, the client caches it on the job as j.fallbackUrl and reuses it.

// Strict allowlist. Left side is a domain substring; right side is a label for UI.
// Order matters — higher-quality sources first. Blocked aggregators (LinkedIn,
// Indeed, ZipRecruiter, Glassdoor) are deliberately NOT here — they are usually
// the SOURCE of the Cloudflare problem, not a solution to it.
const MIRROR_ALLOWLIST = [
  // ATS platforms — clean public pages, rarely bot-protected
  { match: 'boards.greenhouse.io',     label: 'Greenhouse' },
  { match: 'job-boards.greenhouse.io', label: 'Greenhouse' },
  { match: 'jobs.lever.co',            label: 'Lever' },
  { match: 'jobs.ashbyhq.com',         label: 'Ashby' },
  { match: 'apply.workable.com',       label: 'Workable' },
  { match: 'careers.smartrecruiters.com', label: 'SmartRecruiters' },
  { match: 'breezy.hr',                label: 'Breezy' },
  { match: 'recruitee.com',            label: 'Recruitee' },
  { match: 'pinpointhq.com',           label: 'Pinpoint' },
  { match: 'jobvite.com',              label: 'Jobvite' },
  { match: 'bamboohr.com/jobs',        label: 'BambooHR' },
  { match: 'teamtailor.com',           label: 'Teamtailor' },
  { match: 'applytojob.com',           label: 'JazzHR' },
];

function isAllowlistedMirror(url) {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    for (const entry of MIRROR_ALLOWLIST) {
      if (host.includes(entry.match.split('/')[0]) &&
          (!entry.match.includes('/') || u.pathname.includes(entry.match.split('/').slice(1).join('/')))) {
        return entry.label;
      }
    }
    // Also allow company careers pages: careers.<company>.com or <company>.com/careers
    if (/(^|\.)careers\./i.test(host)) return 'Company careers';
    // Company root domain + /careers or /jobs path — accept if the company slug is in the URL
    return null;
  } catch { return null; }
}

// Use Jina's search endpoint — returns top-10 organic results as structured JSON.
// Free tier is fine for our volume (one call per refetch failure).
async function searchWeb(query) {
  try {
    const r = await fetchTimeout(
      'https://s.jina.ai/?q=' + encodeURIComponent(query),
      { headers: { 'Accept': 'application/json', 'X-Respond-With': 'no-content' } },
      10000
    );
    if (!r.ok) return [];
    const data = await r.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.map(r => ({ url: r.url, title: r.title || '', snippet: r.description || '' }))
               .filter(r => r.url);
  } catch { return []; }
}

// Ask AI to judge whether a candidate posting is the SAME job as the claimed
// title/company/location. Low token count — we only need a yes/no + confidence.
async function verifyMirrorMatch({ claimedTitle, claimedCompany, claimedLocation, candidateText }) {
  const sys = 'You verify whether two job postings describe the same role. Return ONLY valid compact JSON.';
  const usr = `Claimed: title="${claimedTitle}", company="${claimedCompany}"${claimedLocation ? `, location="${claimedLocation}"` : ''}.

Candidate posting (first 1500 chars):
${(candidateText || '').slice(0, 1500)}

Do these describe the SAME job? Return {"match": true|false, "confidence": 0.0-1.0, "reason": "brief"}.
- Company must match exactly (same employer).
- Title must be equivalent (minor wording differences OK; different seniority or function = NOT a match).
- Location should be compatible if both specified.`;
  try {
    const raw = await callAI(['groq','google','openrouter'], sys, usr, 150);
    return parseJson(raw);
  } catch { return { match: false, confidence: 0, reason: 'verify-failed' }; }
}

app.post('/api/find-posting-mirror', authMiddleware, async (req, res) => {
  const { title, company, location, originalUrl } = req.body || {};
  if (!title || !company) return res.status(400).json({ error: 'title and company required' });

  // Build a focused query. Quoting company + title usually finds exact matches.
  const query = `"${company}" "${title}"${location ? ' ' + location : ''}`;
  const results = await searchWeb(query);
  if (!results.length) return res.json({ ok: false, reason: 'no-search-results' });

  // Don't return the URL we already know is blocked
  let origHost = '';
  try { origHost = new URL(originalUrl || '').host.toLowerCase(); } catch {}

  // Score candidates: allowlisted sources first, skip the original host
  const candidates = [];
  for (const r of results) {
    if (!r.url) continue;
    try {
      const h = new URL(r.url).host.toLowerCase();
      if (origHost && h === origHost) continue;
    } catch { continue; }
    const label = isAllowlistedMirror(r.url);
    if (label) candidates.push({ ...r, label });
  }
  if (!candidates.length) return res.json({ ok: false, reason: 'no-allowlisted-candidates' });

  // Try up to 3 candidates — fetch, verify, return first match
  for (const c of candidates.slice(0, 3)) {
    let fetched;
    try { fetched = await fetchATS(c.url); } catch { continue; }
    if (!fetched?.text || fetched.text.length < 300) continue;

    const verdict = await verifyMirrorMatch({
      claimedTitle: title, claimedCompany: company, claimedLocation: location,
      candidateText: fetched.text,
    });
    if (verdict?.match && (verdict.confidence ?? 0) >= 0.7) {
      return res.json({ ok: true, mirrorUrl: c.url, via: c.label, confidence: verdict.confidence });
    }
  }
  res.json({ ok: false, reason: 'no-verified-match' });
});

app.post('/api/extract-fields', authMiddleware, async (req, res) => {
  const postingText = req.body.postingText || req.body.text || '';
  const domSalary = req.body.salary || null; // pre-extracted from DOM (bdi, JSON-LD)
  if (!postingText) return res.status(400).json({ error: 'postingText required' });
  // If the browser already extracted salary precisely, tell AI to use it
  const salaryHint = domSalary ? `The salary is already confirmed as ${domSalary} — use this exactly.` : '';
  const sys = `Extract job posting details. Return ONLY valid JSON, no markdown.
Fields: title(string), company(string), location(city+state only, null if remote-only), workType("Remote"|"Hybrid"|"On-site"|null), remote(boolean), salary(ONLY real dollar amounts like "$120k–$150k" or null — never invent, never use "Competitive" or "DOE"). ${salaryHint}`;
  const usr = `Extract from this job posting:\n\n${postingText.slice(0, 4000)}`;
  try {
    const parsed = parseJson(await callAI(['groq','openrouter','google'], sys, usr, 400));
    // Always prefer DOM-extracted salary over AI-guessed salary
    if (domSalary) parsed.salary = domSalary;
    res.json(parsed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// AI FEATURES
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/tailor', authMiddleware, async (req, res) => {
  const { company, title, location, salary, postingText, content, docType, context } = req.body;
  if (!content || !docType) return res.status(400).json({ error: 'content and docType required' });
  const label = docType === 'resume' ? 'RESUME' : 'COVER LETTER';
  const sys = 'You are a professional career coach. Return ONLY the tailored document as clean HTML using <h1>,<h2>,<h3>,<p>,<strong>,<ul>,<li>. Preserve all section structure. No preamble, no labels, no backticks.';
  const usr = `Tailor this ${label} for the role. Return only clean HTML.\n\nCompany: ${company}\nRole: ${title}\n${location?`Location: ${location}`:''}${salary?`\nSalary: ${salary}`:''}${context?`\nNotes: ${context}`:''}${postingText?`\n\nJob posting:\n${postingText.slice(0,3000)}`:''}\n\n${label} TO TAILOR:\n${content}`;
  try {
    const result = await callAI(['groq','openrouter','google'], sys, usr, 3000);
    res.json({ result: result.trim(), docType });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tailor-docx', authMiddleware, async (req, res) => {
  const { docxBase64, company, title, location, salary, postingText, docType, context } = req.body;
  if (!docxBase64) return res.status(400).json({ error: 'DOCX data required' });
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(Buffer.from(docxBase64, 'base64'));
    const entry = zip.getEntry('word/document.xml');
    if (!entry) return res.status(422).json({ error: 'Invalid DOCX' });
    const xml = entry.getData().toString('utf8');
    const rawText = xml.replace(/<w:br[^/]*/g,'\n').replace(/<[^>]+>/g,'')
                       .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    const label = docType === 'resume' ? 'RESUME' : 'COVER LETTER';
    const sys = `You are a professional career coach. Tailor this ${label}. Return ONLY the tailored text, same length and structure.`;
    const usr = `Company: ${company}\nRole: ${title}\n${location||''}\n${salary||''}\n${context||''}\n${postingText?postingText.slice(0,2000):''}\n\nOriginal ${label}:\n${rawText.slice(0,3000)}\n\nReturn ONLY the tailored text.`;
    const tailored = await callAI(['groq','openrouter','google'], sys, usr, 3000);
    // Replace text content in XML runs proportionally
    const textRuns = [...xml.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map(m=>m[0]).filter(r=>/<w:t[ >]/.test(r));
    if (textRuns.length === 0) return res.status(422).json({ error: 'No text runs in DOCX' });
    const words = tailored.trim().split(/\s+/);
    const perRun = Math.max(1, Math.floor(words.length / textRuns.length));
    let wi = 0, newXml = xml;
    for (const run of textRuns) {
      const chunk = words.slice(wi, wi + perRun).join(' ');
      wi += perRun;
      const safe = chunk.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      newXml = newXml.replace(run, run.replace(/<w:t[ >][^<]*<\/w:t>/, `<w:t xml:space="preserve">${safe}</w:t>`));
    }
    zip.updateFile('word/document.xml', Buffer.from(newXml, 'utf8'));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="tailored-${docType}.docx"`);
    res.send(zip.toBuffer());
  } catch (e) { console.error('tailor-docx:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/insights', authMiddleware, async (req, res) => {
  const { company, title, location, salary, postingText, finnhubKey } = req.body;
  if (!company || !title) return res.status(400).json({ error: 'company and title required' });
  let stock = null;
  if (finnhubKey) {
    try {
      const sr = await fetchTimeout(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(company)}&token=${finnhubKey}`);
      if (sr.ok) {
        const sd = await sr.json();
        const match = (sd.result||[]).find(r => r.type==='Common Stock' && !r.symbol.includes('.'));
        if (match) {
          const [qr,pr] = await Promise.allSettled([
            fetchTimeout(`https://finnhub.io/api/v1/quote?symbol=${match.symbol}&token=${finnhubKey}`),
            fetchTimeout(`https://finnhub.io/api/v1/stock/profile2?symbol=${match.symbol}&token=${finnhubKey}`),
          ]);
          const q = qr.status==='fulfilled'&&qr.value.ok ? await qr.value.json() : {};
          const p = pr.status==='fulfilled'&&pr.value.ok ? await pr.value.json() : {};
          stock = { ticker: match.symbol, price: q.c, change: q.d, changePct: q.dp,
                    marketCap: p.marketCapitalization ? p.marketCapitalization*1e6 : null };
        } else { stock = { error: 'No public ticker found' }; }
      }
    } catch (e) { stock = { error: e.message }; }
  }
  const today = new Date().toISOString().split('T')[0];
  const sys = `You are a career research assistant. Today is ${today}. Return valid JSON only, no markdown, no backticks.`;
  const usr = `Research ${company} (${title} role). Return ONLY valid compact JSON — no truncation.
${postingText?'Job posting context: '+postingText.slice(0,800):''}

{"overview":{"founded":"year","employees":"N,NNN","hq":"city","industry":"sector"},
"companyOverview":"3-4 paragraphs about company mission, products, culture, recent developments",
"workforce":{"headcount":"N,NNN","headcountTrend":"growing","avgTenure":"2.5 years","fullTimePct":85,"remoteRatio":40,"recentLayoffs":"None","genderSplit":{"female":42,"male":56,"other":2},"ageBrackets":{"under30":28,"30to40":38,"40to50":22,"over50":12},"ethnicityMix":{"asian":28,"white":48,"hispanic":12,"black":8,"other":4},"visaSponsorship":"yes","visaNote":"Sponsors H-1B; green card support for qualified candidates","topLocations":["City, ST","Remote"],"glassdoorDiversity":4.1,"note":"Estimated from public data."},
"culture":{"overallRating":3.8,"workLifeBalance":3.5,"cultureValues":3.8,"careerOpp":3.6,"compensation":3.4,"leadership":3.5,"numRatings":"1,234","ceoApproval":72,"recommend":68,"summary":"Culture summary paragraph"},
"roleIntel":"2-3 paragraphs about this specific role and team",
"flags":{"green":["positive signal"],"red":["concern to watch"]},
"linkedin":{"suggestedContacts":[{"name":"Hiring Manager Title","role":"Engineering Manager","company":"${company}","tip":"Why to reach out"}],"outreachTip":"Strategy","messageTemplate":"Hi [Name], ..."},
"news":[{"headline":"Recent headline","source":"Source","date":"2024-01","url":"","sentiment":"positive"}],
"interviewTips":"Role-specific interview preparation tips"}`
  try {
    const raw = await callAI(['groq','openrouter','google'], sys, usr, 8000);
    const data = parseJson(raw);
    res.json({ ...data, stock, generatedAt: Date.now() });
  } catch (e) { console.error('insights:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/outreach-targets', authMiddleware, async (req, res) => {
  const { company, title } = req.body;
  try {
    const raw = await callAI(['groq','openrouter','google'],
      'Return valid JSON only, no markdown.',
      `Suggest 3 LinkedIn contacts to reach out to when applying for ${title} at ${company}. Return: {"contacts":[{"title":"...","reason":"...","searchTip":"..."}]}`,
      500);
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/interview-questions', authMiddleware, async (req, res) => {
  const { company, title, postingText, count = 15, existingQuestions = [] } = req.body;
  const avoidSection = existingQuestions.length > 0
    ? `\n\nDO NOT repeat these existing questions:\n${existingQuestions.map(q => '- ' + q).join('\n')}` : '';
  try {
    const raw = await callAI(['groq','openrouter','google'],
      'Return valid JSON only, no markdown, no backticks.',
      `Generate ${count} interview questions for the role: ${title} at ${company}.${postingText ? '\nJob posting context: ' + postingText.slice(0, 1500) : ''}${avoidSection}

Include 3-4 questions per category. Categories must be exactly: Behavioral, Technical, Culture Fit, Role-Specific, Questions to Ask.
"Questions to Ask" = thoughtful questions the candidate should ask the interviewer.
Make questions specific to this role and company.

Return ONLY this JSON:
{"questions":[{"category":"Behavioral","question":"..."},{"category":"Technical","question":"..."},{"category":"Culture Fit","question":"..."},{"category":"Role-Specific","question":"..."},{"category":"Questions to Ask","question":"..."}]}`,
      1500);
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/keyword-gap', authMiddleware, async (req, res) => {
  const { resumeText, postingText } = req.body;
  try {
    const raw = await callAI(['groq','openrouter','google'],
      'Return valid JSON only, no markdown.',
      `Find keyword gaps between this resume and job posting.\nPosting: ${(postingText||'').slice(0,2000)}\nResume: ${(resumeText||'').slice(0,2000)}\nReturn: {"matched":["keyword"],"missing":["keyword"],"score":75,"suggestions":["add X to Y"]}`,
      800);
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/email-template', authMiddleware, async (req, res) => {
  const { company, title, type, context } = req.body;
  try {
    const raw = await callAI(['groq','openrouter','google'],
      'Return valid JSON only, no markdown.',
      `Write a ${type||'follow-up'} email for ${title} at ${company}. ${context||''}\nReturn: {"subject":"...","body":"..."}`,
      500);
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/salary-benchmark', authMiddleware, async (req, res) => {
  const { title, location, company } = req.body;
  try {
    const raw = await callAI(['groq','openrouter','google'],
      'Return valid JSON only, no markdown.',
      `Salary benchmarks for ${title} in ${location||'United States'}${company?` at ${company}`:''}.\nReturn: {"low":120000,"median":150000,"high":180000,"currency":"USD","notes":"..."}`,
      300);
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ai-status', authMiddleware, (req, res) => {
  res.json({ groq: !!GROQ_API_KEY, openrouter: !!OPENROUTER_API_KEY, google: !!GOOGLE_API_KEY });
});

// ════════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/check-posting', authMiddleware, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const r = await fetchTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' } }, 15000);
    if (r.status === 404) return res.json({ expired: true, reason: '404 Not Found' });
    if (!r.ok) return res.json({ expired: false, reason: `HTTP ${r.status}` });
    const html = (await r.text()).toLowerCase();
    const expired = ['no longer available','has expired','position has been filled',
      'posting has expired','no longer accepting','requisition is closed','job is closed',
      'listing has been removed'].some(s => html.includes(s));
    res.json({ expired, reason: expired ? 'Expired signals found' : 'Active' });
  } catch (e) { res.json({ expired: false, reason: 'Could not reach: ' + e.message }); }
});

app.get('/api/extension', authMiddleware, async (req, res) => {
  // Dynamically package and serve the Chrome extension as a zip
  const extDir = path.join(__dirname, '..', 'extension');
  if (!fs.existsSync(extDir)) {
    return res.status(404).json({ error: 'Extension files not found on server' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="summit-extension.zip"');
  const arc = archiver('zip', { zlib: { level: 9 } });
  arc.on('error', err => { console.error('Extension zip error:', err); res.end(); });
  arc.pipe(res);
  arc.directory(extDir, 'summit-extension');
  await arc.finalize();
});

app.get('/api/export-data', authMiddleware, async (req, res) => {
  const jobs = loadUserJobs(req.user.id, req.dataKey);
  const arc  = archiver('zip', { zlib: { level: 9 } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="applied-export-${Date.now()}.zip"`);
  arc.pipe(res);
  arc.append(JSON.stringify(jobs, null, 2), { name: 'jobs.json' });
  arc.append(JSON.stringify(loadUserDocs(req.user.id), null, 2), { name: 'docs.json' });
  await arc.finalize();
});

app.post('/api/import-data', authMiddleware, express.json({ limit: '10mb' }), async (req, res) => {
  const { jobs } = req.body;
  if (!jobs || typeof jobs !== 'object') return res.status(400).json({ error: 'Invalid data' });
  saveUserJobs(req.user.id, jobs, req.dataKey);
  res.json({ ok: true, count: Object.keys(jobs).length });
});

// ════════════════════════════════════════════════════════════════════════════════
// DOCUMENT LIBRARY
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/docs', authMiddleware, (req, res) => {
  res.json(loadUserDocs(req.user.id).map(d => ({
    id: d.id, name: d.name, type: d.type, size: (d.content||'').length,
    createdAt: d.createdAt, updatedAt: d.updatedAt
  })));
});

app.get('/api/docs/:id', authMiddleware, (req, res) => {
  const doc = loadUserDocs(req.user.id).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(doc);
});

// POST /api/docs/upload must come before POST /api/docs/:id
app.post('/api/docs/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { type = 'resume' } = req.body;
  let content = '', html = '';
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    if (ext === '.pdf') {
      content = (await pdfParse(req.file.buffer)).text;
    } else if (ext === '.docx' || ext === '.doc') {
      const r = await mammoth.convertToHtml({ buffer: req.file.buffer });
      html = r.value;
      content = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    } else {
      content = req.file.buffer.toString('utf8');
    }
  } catch { content = req.file.buffer.toString('utf8'); }
  const docs = loadUserDocs(req.user.id);
  const now  = Date.now();
  const doc  = { id: genId(), name: req.file.originalname, type, content, html, createdAt: now, updatedAt: now };
  docs.push(doc);
  saveUserDocs(req.user.id, docs);
  res.json(doc);
});

app.post('/api/docs', authMiddleware, (req, res) => {
  const { id, name, type, content = '', html = '' } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  const docs = loadUserDocs(req.user.id);
  const now  = Date.now();
  if (id) {
    const idx = docs.findIndex(d => d.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    docs[idx] = { ...docs[idx], name, type, content, html, updatedAt: now };
    saveUserDocs(req.user.id, docs);
    return res.json(docs[idx]);
  }
  const doc = { id: genId(), name, type, content, html, createdAt: now, updatedAt: now };
  docs.push(doc);
  saveUserDocs(req.user.id, docs);
  res.json(doc);
});

app.delete('/api/docs/:id', authMiddleware, (req, res) => {
  const docs = loadUserDocs(req.user.id);
  const next = docs.filter(d => d.id !== req.params.id);
  if (next.length === docs.length) return res.status(404).json({ error: 'Not found' });
  saveUserDocs(req.user.id, next);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// ADMIN
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  res.json(Object.entries(loadUsers()).map(([id, u]) => ({
    id, username: u.username, createdAt: u.createdAt, active: u.active !== false
  })));
});

app.post('/api/admin/deactivate', adminMiddleware, (req, res) => {
  const { username } = req.body;
  const users = loadUsers();
  if (!users[username?.toLowerCase()]) return res.status(404).json({ error: 'Not found' });
  users[username.toLowerCase()].active = false;
  saveUsers(users);
  res.json({ ok: true });
});

app.post('/api/admin/reset-password', adminMiddleware, async (req, res) => {
  const { username, newPassword = 'TempPass123!' } = req.body;
  const users = loadUsers();
  if (!users[username?.toLowerCase()]) return res.status(404).json({ error: 'Not found' });
  users[username.toLowerCase()].passwordHash = await bcrypt.hash(newPassword, 12);
  saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:username', adminMiddleware, (req, res) => {
  const users = loadUsers();
  const id = req.params.username.toLowerCase();
  if (!users[id]) return res.status(404).json({ error: 'Not found' });
  delete users[id];
  saveUsers(users);
  res.json({ ok: true });
});

app.get('/api/admin/status', adminMiddleware, (req, res) => {
  res.json({ ok: true, users: Object.keys(loadUsers()).length });
});

// ════════════════════════════════════════════════════════════════════════════════
// STATIC & EXTENSION
// ════════════════════════════════════════════════════════════════════════════════

app.get('/extension.zip', (req, res) => {
  try {
    const AdmZip = require('adm-zip');
    const extDir = path.join(__dirname, '../extension');
    if (!fs.existsSync(extDir)) return res.status(404).send('Extension not built');
    const zip = new AdmZip();
    for (const file of fs.readdirSync(extDir)) {
      let buf = fs.readFileSync(path.join(extDir, file));
      if (file === 'popup.js') {
        buf = Buffer.from(buf.toString('utf8')
          .replace(/const TRACKER_URL = '[^']*'/, `const TRACKER_URL = '${APP_URL}'`));
      }
      zip.addFile(file, buf);
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="applied-extension.zip"');
    res.send(zip.toBuffer());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin', (req, res) => {
  const f = path.join(__dirname, '../frontend/public/admin.html');
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).send('Not found');
});

app.get('/reset-password', (req, res) => {
  const f = path.join(__dirname, '../frontend/public/reset-password.html');
  fs.existsSync(f) ? res.sendFile(f) : res.redirect('/');
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ════════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Applied Tracker on port ${PORT}`);
    console.log(`Data: ${DATA_DIR}`);
    console.log(`AI: groq=${!!GROQ_API_KEY} openrouter=${!!OPENROUTER_API_KEY} google=${!!GOOGLE_API_KEY}`);
  });
}

module.exports = app;
