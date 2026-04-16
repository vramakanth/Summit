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

// ── Data directories ─────────────────────────────────────────────────────────
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const JOBS_DIR    = path.join(DATA_DIR, 'jobs');
const DOCS_DIR    = path.join(DATA_DIR, 'docs');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
for (const d of [DATA_DIR, JOBS_DIR, DOCS_DIR]) {
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
async function fetchTimeout(url, opts, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
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
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
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
const { cleanJobUrl, detectATS, slugFallback } = require('./ats-helpers');

async function fetchATS(rawUrl) {
  const url  = cleanJobUrl(rawUrl);
  const ats  = detectATS(url);
  const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  const JSON_H = { Accept: 'application/json', 'Content-Type': 'application/json' };

  // ── Google Jobs ─────────────────────────────────────────────────────────────
  if (ats === 'googlejobs') {
    // share.google links redirect to google.com/search?...&udm=8
    // Server-side we can't render the JS SPA, but we can follow the redirect
    // and extract job info from the URL params and page meta
    let resolvedUrl = url;
    if (/share\.google/i.test(url)) {
      try {
        const r = await fetchTimeout(url, {
          headers: { 'User-Agent': UA },
          redirect: 'follow',
        }, 8000);
        resolvedUrl = r.url || url;
      } catch {}
    }
    // Extract kgs (Knowledge Graph entity) and search query
    try {
      const u = new URL(resolvedUrl);
      const query = u.searchParams.get('q') || '';
      const kgs = u.searchParams.get('kgs') || '';
      // Try to fetch the Google Jobs page to get structured data from meta tags
      const r = await fetchTimeout(resolvedUrl, {
        headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
      }, 10000);
      if (r.ok) {
        const html = await r.text();
        // Extract title from og:title or title tag
        const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]
                     || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/ - Google Search$/, '').trim();
        // Extract any JSON-LD (Google sometimes embeds it)
        const ldMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
        let ldFields = null;
        if (ldMatch) {
          try {
            const ld = JSON.parse(ldMatch[1].trim());
            const jobs = Array.isArray(ld) ? ld : [ld];
            const job = jobs.find(d => d['@type'] === 'JobPosting');
            if (job) {
              ldFields = {
                title: job.title,
                company: job.hiringOrganization?.name,
                location: job.jobLocation?.address?.addressLocality || null,
                workType: job.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null,
                salary: null,
              };
            }
          } catch {}
        }
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
        return {
          fields: ldFields || (ogTitle ? { title: ogTitle.replace(/ \| Google Jobs$/, '').trim() } : null),
          text,
          html: '',
          _ats: 'googlejobs',
          _resolvedUrl: resolvedUrl !== url ? resolvedUrl : undefined,
        };
      }
    } catch {}
    return { html: '', text: '', fields: null, _ats: 'googlejobs' };
  }

  // ── LinkedIn ────────────────────────────────────────────────────────────────
  if (ats === 'linkedin') {
    return { html:'', text:'', fields: null, _ats:'linkedin', _linkedinBlocked: true };
  }

  // ── Greenhouse ──────────────────────────────────────────────────────────────
  if (ats === 'greenhouse') {
    try {
      // Handles both boards.greenhouse.io and job-boards.greenhouse.io
      const m = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/) ||
                url.match(/greenhouse\.io\/([^/?#]+)\?.*gh_jid=(\d+)/);
      if (m) {
        const company = m[1], jobId = m[2];
        const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${jobId}`;
        const r = await fetchTimeout(apiUrl, { headers: JSON_H }, 10000);
        if (r.ok) {
          const d = await r.json();
          const text = (d.content||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
          // Extract salary from job description text
          let salary = null;
          const sm = text.match(/\$([\d,]+(?:\.\d+)?)\s*[-\u2013\u2014]\s*\$([\d,]+(?:\.\d+)?)/);
          if (sm) {
            const fmt = s => { const n=parseFloat(s.replace(/,/g,'')); return n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n).toLocaleString(); };
            salary = fmt(sm[1])+'\u2013'+fmt(sm[2]);
          }
          // Fallback: fetch page HTML to find salary in <bdi> elements
          if (!salary) {
            try {
              const pr = await fetchTimeout(url, { headers: { 'User-Agent': UA } }, 8000);
              if (pr.ok) {
                const ph = await pr.text();
                const bm = ph.match(/<bdi>\$([\d,]+(?:\.\d+)?)<\/bdi>\s*-\s*<bdi>\$([\d,]+(?:\.\d+)?)<\/bdi>/);
                if (bm) {
                  const fmt = s => { const n=parseFloat(s.replace(/,/g,'')); return n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n).toLocaleString(); };
                  salary = fmt(bm[1])+'\u2013'+fmt(bm[2]);
                }
              }
            } catch {}
          }
          if (!salary) salary = 'not found';
          return { fields:{ title:d.title, company:d.company_name||company, location:d.location?.name, salary }, text, html:d.content||'', _ats:'greenhouse' };
        }
      }
    } catch {}
  }

  // ── Lever ───────────────────────────────────────────────────────────────────
  if (ats === 'lever') {
    try {
      const m = url.match(/lever\.co\/([^/?#]+)\/([a-f0-9-]{36})/i);
      if (m) {
        const [, company, id] = m;
        const r = await fetchTimeout(`https://api.lever.co/v0/postings/${company}/${id}`, { headers: JSON_H }, 10000);
        if (r.ok) {
          const d = await r.json();
          const text = [d.text||'', d.descriptionPlain||'', ...(d.lists||[]).map(l=>l.content)].join(' ').replace(/\s+/g,' ').slice(0,8000);
          return { fields:{ title:d.text, company:d.company||company, location:d.categories?.location }, text, html:d.description||'', _ats:'lever' };
        }
      }
    } catch {}
  }

  // ── Workday ─────────────────────────────────────────────────────────────────
  if (ats === 'workday') {
    try {
      // Pattern: https://{tenant}.wd{N}.myworkdayjobs.com/{locale}/{site}/job/{externalPath}
      const m = url.match(/https?:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z-]+\/)?([^/]+)\/job\/(.+?)(?:\?|$)/i)
             || url.match(/https?:\/\/jobs\.myworkdaysite\.com\/recruiting\/([^/]+)\/([^/]+)\/job\/(.+?)(?:\?|$)/i);
      if (m) {
        const tenant = m[1], wdN = m[2], site = m[3], externalPath = m[4];
        const apiUrl = `https://${tenant}.${wdN}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${externalPath}`;
        const r = await fetchTimeout(apiUrl, {
          headers: { ...JSON_H, 'User-Agent': UA, Referer: url }
        }, 12000);
        if (r.ok) {
          const d = await r.json();
          const jp = d.jobPostingInfo || d;
          const title = jp.title || jp.jobPostingId?.replace(/_[A-Z]{2}-?\d+$/, '').replace(/[-_]/g,' ');
          const location = jp.location || jp.jobRequisitionLocation?.descriptor;
          const isRemote = jp.remoteType === 'Full_Remote' || /remote/i.test(location||'');
          const html = jp.jobDescription || jp.description || '';
          const text = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
          return { fields:{ title, company: tenant.charAt(0).toUpperCase()+tenant.slice(1), location: isRemote ? null : location, workType: isRemote ? 'Remote' : jp.remoteType === 'Hybrid_Remote' ? 'Hybrid' : null, remote: isRemote }, text, html, _ats:'workday' };
        }
      }
    } catch {}
    // Slug fallback for Workday if API failed
    const sf = slugFallback(url);
    if (sf) return { fields: sf, html:'', text:'', _ats:'workday', _slugFallback:true };
  }

  // ── SmartRecruiters ─────────────────────────────────────────────────────────
  if (ats === 'smartrecruiters') {
    try {
      // URL: jobs.smartrecruiters.com/{Company}/{numericId}-{slug}
      const m = url.match(/smartrecruiters\.com\/([^/?#]+)\/(\d+)/);
      if (m) {
        const [, company, id] = m;
        const r = await fetchTimeout(`https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`, { headers: JSON_H }, 10000);
        if (r.ok) {
          const d = await r.json();
          const loc = d.location;
          const location = [loc?.city, loc?.region, loc?.country?.toUpperCase()].filter(Boolean).join(', ');
          const sections = (d.jobAd?.sections || []).map(s => (s.content||'').replace(/<[^>]+>/g,' ')).join(' ');
          return { fields:{ title:d.name, company:d.company?.name||company, location: loc?.remote ? null : location, workType: loc?.remote ? 'Remote' : null, remote: !!loc?.remote }, text:sections.trim().slice(0,8000), html:'', _ats:'smartrecruiters' };
        }
      }
    } catch {}
  }

  // ── Ashby ───────────────────────────────────────────────────────────────────
  if (ats === 'ashby') {
    try {
      const m = url.match(/ashbyhq\.com\/([^/?#]+)\/([^/?#]+)/);
      if (m) {
        const [, company, jobId] = m;
        const r = await fetchTimeout('https://jobs.ashbyhq.com/api/non-user-graphql', {
          method:'POST', headers: JSON_H,
          body: JSON.stringify({ operationName:'ApiJobPosting', variables:{ organizationHostedJobsPageName:company, jobPostingId:jobId },
            query:'query ApiJobPosting($organizationHostedJobsPageName:String!,$jobPostingId:String!){jobPosting(organizationHostedJobsPageName:$organizationHostedJobsPageName,jobPostingId:$jobPostingId){title descriptionHtml isRemote locationName compensationTierSummary}}'
          })
        }, 10000);
        if (r.ok) {
          const d = await r.json();
          const p = d?.data?.jobPosting;
          if (p) {
            const text = (p.descriptionHtml||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
            return { fields:{ title:p.title, company, location:p.isRemote?null:p.locationName, workType:p.isRemote?'Remote':null, remote:p.isRemote, salary:p.compensationTierSummary||null }, text, html:p.descriptionHtml||'', _ats:'ashby' };
          }
        }
      }
    } catch {}
  }

  // ── Workable ────────────────────────────────────────────────────────────────
  if (ats === 'workable') {
    try {
      // apply.workable.com/company/j/uuid or company.workable.com/jobs/uuid
      const m = url.match(/workable\.com\/([^/?#]+)\/j\/([^/?#]+)/) ||
                url.match(/workable\.com\/jobs\/([^/?#]+)/);
      if (m) {
        const [, company, jobSlug] = m;
        const r = await fetchTimeout(`https://apply.workable.com/api/v3/accounts/${company}/jobs/${jobSlug}`, { headers: JSON_H }, 10000);
        if (r.ok) {
          const d = await r.json();
          const loc = d.location_str || [d.city, d.state, d.country].filter(Boolean).join(', ');
          const text = (d.full_description||d.description||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
          return { fields:{ title:d.title, company:d.full_title||company, location:d.remote?null:loc, workType:d.remote?'Remote':null, remote:d.remote }, text, html:d.full_description||'', _ats:'workable' };
        }
      }
    } catch {}
  }

  // ── iCIMS / slug-extractable ─────────────────────────────────────────────────
  if (ats === 'icims') {
    const sf = slugFallback(url);
    // Try HTML fetch first
    try {
      const r = await fetchTimeout(url, { headers:{ 'User-Agent':UA, Accept:'text/html', 'Accept-Language':'en-US,en;q=0.9' } }, 12000);
      if (r.ok) {
        const html = await r.text();
        const text = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
        if (text.length > 300) return { fields: sf||null, html:html.slice(0,500000), text, _ats:'icims' };
      }
    } catch {}
    if (sf) return { fields:sf, html:'', text:'', _ats:'icims', _slugFallback:true };
  }

  // ── Eightfold AI (careers.company.com, Dexcom etc.) ────────────────────────
  // Eightfold embeds full JSON-LD in the initial HTML — server-side fetch works.
  // Fall through to generic HTML handler which extracts JSON-LD.

  // ── Indeed ─────────────────────────────────────────────────────────────────
  // Indeed is JS-rendered and blocks bots, but sometimes returns usable JSON in page
  if (ats === 'indeed') {
    try {
      // Extract job key from URL
      const jk = new URL(url).searchParams.get('jk');
      if (jk) {
        // Try Indeed's internal job API endpoint
        const apiR = await fetchTimeout(`https://www.indeed.com/m/basecamp/viewjob?viewtype=embedded&jk=${jk}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
        }, 12000);
        if (apiR.ok) {
          const html = await apiR.text();
          // Extract from JSON-LD
          const ldMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
          if (ldMatch) {
            try {
              const ld = JSON.parse(ldMatch[1].trim());
              const job = Array.isArray(ld) ? ld.find(d => d['@type'] === 'JobPosting') : ld['@type'] === 'JobPosting' ? ld : null;
              if (job?.title) {
                const loc = job.jobLocation?.address;
                const location = [loc?.addressLocality, loc?.addressRegion].filter(Boolean).join(', ');
                let salary = null;
                if (job.baseSalary?.value?.minValue && job.baseSalary?.value?.maxValue) {
                  const fmt = n => n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString();
                  salary = fmt(job.baseSalary.value.minValue) + '\u2013' + fmt(job.baseSalary.value.maxValue);
                }
                const text = (job.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                // Try salary from description if not in baseSalary
                if (!salary && text) {
                  const sm = text.match(/\$([\d,]+(?:\.\d+)?)\s*[-\u2013\u2014]\s*\$([\d,]+(?:\.\d+)?)/);
                  if (sm) {
                    const fmt = s => { const n = parseFloat(s.replace(/,/g,'')); return n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n).toLocaleString(); };
                    salary = fmt(sm[1]) + '\u2013' + fmt(sm[2]);
                  }
                }
                return { fields:{ title:job.title, company:job.hiringOrganization?.name, location:location||null, workType:job.jobLocationType==='TELECOMMUTE'?'Remote':null, salary }, text, html:'', _ats:'indeed' };
              }
            } catch {}
          }
          // Fallback: extract from Indeed's JS data blob
          const titleMatch = html.match(/"jobTitle"\s*:\s*"([^"]+)"/);
          const companyMatch = html.match(/"companyName"\s*:\s*"([^"]+)"/);
          const locMatch = html.match(/"formattedLocation"\s*:\s*"([^"]+)"/);
          if (titleMatch) {
            return { fields:{ title:titleMatch[1], company:companyMatch?.[1]||null, location:locMatch?.[1]||null, salary:null }, text:'', html:'', _ats:'indeed' };
          }
        }
      }
    } catch {}
    // Fall through to slug fallback if all else fails
    const sf = slugFallback(url);
    if (sf?.title) return { fields:sf, html:'', text:'', _ats:'indeed', _slugFallback:true };
  }

  // ── ZipRecruiter, SimplyHired, Lensa, career.io ──────────────────────────────
  // These all have JSON-LD and serve server-side rendered HTML
  // The generic handler covers them but we add URL cleanup first
  if (['ziprecruiter','simplyhired','lensa','careerdotio'].includes(ats)) {
    // Strip all UTM and tracking params — they cause redirects on some sites
    try {
      const u = new URL(url);
      ['utm_campaign','utm_source','utm_medium','utm_term','utm_content',
       'jid','ref','from','via','src'].forEach(p => u.searchParams.delete(p));
      // Fall through to generic handler with clean URL
      const cleanedUrl = u.toString();
      const r = await fetchTimeout(cleanedUrl, {
        headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
      }, 15000);
      if (r.ok) {
        const html = await r.text();
        // Extract JSON-LD
        let jsonLdFields = null, scriptSalary = null, jsonLdText = '';
        const ldMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
        if (ldMatch) {
          for (const block of ldMatch) {
            try {
              const data = JSON.parse(block.replace(/<script[^>]*>|<\/script>/gi,'').trim());
              const jobs = Array.isArray(data)?data:[data];
              const job = jobs.find(d=>d['@type']==='JobPosting');
              if (job) {
                const loc = job.jobLocation?.address;
                const city = loc?.addressLocality, region = loc?.addressRegion;
                const location = [city,region].filter(Boolean).join(', ') || null;
                // Structured salary
                if (job.baseSalary?.value?.minValue && job.baseSalary?.value?.maxValue) {
                  const fmt = n => n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n).toLocaleString();
                  scriptSalary = fmt(job.baseSalary.value.minValue)+'\u2013'+fmt(job.baseSalary.value.maxValue);
                }
                // Salary from description
                if (!scriptSalary && job.description) {
                  jsonLdText = job.description.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
                  const dm = jsonLdText.match(/[Ss]alary[\s\S]{0,20}\$([\d,]+(?:\.\d+)?)\s*[-\u2013\u2014to]+\s*\$([\d,]+(?:\.\d+)?)/);
                  if (dm) {
                    const fmt = s => { const n=parseFloat(s.replace(/,/g,'')); return n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n).toLocaleString(); };
                    scriptSalary = fmt(dm[1])+'\u2013'+fmt(dm[2]);
                  }
                }
                jsonLdFields = { title:job.title, company:job.hiringOrganization?.name, location, workType:job.jobLocationType==='TELECOMMUTE'?'Remote':null, remote:job.jobLocationType==='TELECOMMUTE' };
                break;
              }
            } catch {}
          }
        }
        // If no salary from JSON-LD, search first dollar range in MAIN job section body text
        if (!scriptSalary) {
          const bodyMatch = html.match(/<(?:main|article|section)[^>]*>([\s\S]*?)<\/(?:main|article|section)>/i);
          const bodyText = (bodyMatch?.[1]||html).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,3000);
          const sm = bodyText.match(/\$([\d,]+(?:\.\d+)?)\s*[-\u2013\u2014]\s*\$([\d,]+(?:\.\d+)?)/);
          if (sm) {
            const fmt = s => { const n=parseFloat(s.replace(/,/g,'')); return n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n).toLocaleString(); };
            scriptSalary = fmt(sm[1])+'\u2013'+fmt(sm[2]);
          }
        }
        const bodyText2 = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
        const text = jsonLdText || bodyText2;
        const fields = scriptSalary ? {...(jsonLdFields||{}), salary:scriptSalary} : jsonLdFields;
        if (fields && fields.salary == null) fields.salary = 'not found';
        return { fields, text, html:'', _ats:ats };
      }
    } catch(e) { /* fall through to generic */ }
  }

  // ── Generic HTML fetch (Indeed, Glassdoor, ZipRecruiter, Dice, Wellfound, etc.) ──
  const slugFields = slugFallback(url);
  try {
    const r = await fetchTimeout(url, {
      headers:{ 'User-Agent':UA, Accept:'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language':'en-US,en;q=0.9', 'Cache-Control':'no-cache' }
    }, 15000);
    if (!r.ok) {
      if (slugFields) return { fields:slugFields, html:'', text:'', _ats:ats, _slugFallback:true };
      return { html:'', text:'', error:`HTTP ${r.status}`, _ats:ats };
    }
    const html = await r.text();
    // Extract JSON-LD structured data (job boards often embed this)
    let jsonLdFields = null;
    const ldMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (ldMatch) {
      for (const block of ldMatch) {
        try {
          const data = JSON.parse(block.replace(/<script[^>]*>|<\/script>/gi,'').trim());
          const job = Array.isArray(data) ? data.find(d=>d['@type']==='JobPosting') : data['@type']==='JobPosting' ? data : null;
          if (job) {
            const loc = job.jobLocation?.address;
            const city = loc?.addressLocality, region = loc?.addressRegion, country = loc?.addressCountry;
            const location = [city, region, country].filter(Boolean).join(', ');
            jsonLdFields = {
              title: job.title,
              company: job.hiringOrganization?.name,
              location: job.jobLocationType === 'TELECOMMUTE' ? null : location || null,
              workType: job.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null,
              salary: job.baseSalary ? `${job.baseSalary.value?.minValue||''}${job.baseSalary.value?.maxValue?`–${job.baseSalary.value.maxValue}`:''}${job.baseSalary.currency?' '+job.baseSalary.currency:''}`.trim() : null,
              remote: job.jobLocationType === 'TELECOMMUTE',
            };
            break;
          }
        } catch {}
      }
    }
    // Scan ALL script tags for salary and job data
    let scriptSalary = null;
    let jsonLdText = '';  // description text from JSON-LD (useful when body is SPA shell)
    const scriptTags = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    for (const [, scriptContent] of scriptTags) {
      if (scriptContent.length < 50) continue;

      // --- JSON-LD: extract description text AND salary from it ---
      if (scriptContent.includes('"@type"') && scriptContent.includes('JobPosting')) {
        try {
          const jld = JSON.parse(scriptContent.trim());
          const job = Array.isArray(jld) ? jld.find(d => d['@type'] === 'JobPosting') : jld['@type'] === 'JobPosting' ? jld : null;
          if (job) {
            // Get full description text for AI extraction later
            if (job.description) jsonLdText = job.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
            // Check for salary in description text (common: "Salary:\n\n$231,100.00 - $385,100.00")
            if (!scriptSalary && jsonLdText) {
              const descSalary = jsonLdText.match(/[Ss]alary[:\s]+\$([\d,]+(?:\.\d+)?)\s*[-–—to]+\s*\$([\d,]+(?:\.\d+)?)/);
              if (descSalary) {
                const fmt = (s) => {
                  const n = parseFloat(s.replace(/,/g,''));
                  return n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString();
                };
                scriptSalary = fmt(descSalary[1]) + '–' + fmt(descSalary[2]);
              }
            }
            // baseSalary structured field
            if (!scriptSalary && job.baseSalary?.value) {
              const bv = job.baseSalary.value;
              if (bv.minValue && bv.maxValue) {
                const fmt = (n) => n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString();
                scriptSalary = fmt(bv.minValue) + '–' + fmt(bv.maxValue);
              }
            }
          }
        } catch {}
      }

      // --- Non-JSON-LD script: look for salary patterns in embedded data ---
      if (!scriptSalary) {
        const salaryMatch = scriptContent.match(/"Salary":\s*"(\$[\d,.]+ ?[-\u2013\u2014] ?\$[\d,.]+)"/)
          || scriptContent.match(/"salary_range":\s*"([^"]+)"/i)
          || scriptContent.match(/"minValue":\s*([\d.]+)[\s\S]{0,100}"maxValue":\s*([\d.]+)/);
        if (salaryMatch) {
          if (salaryMatch[2]) {
            const min = Math.round(parseFloat(salaryMatch[1])).toLocaleString();
            const max = Math.round(parseFloat(salaryMatch[2])).toLocaleString();
            scriptSalary = `$${min}–$${max}`;
          } else {
            scriptSalary = salaryMatch[1].trim();
          }
        }
      }
    }

    // Extract main content text
    const bodyMatch = html.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : html;
    const bodyText = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
    const isSpaShell = bodyText.length < 200;
    // Use JSON-LD description as text fallback when body is a SPA shell (e.g. Dexcom/Eightfold)
    const text = isSpaShell && jsonLdText ? jsonLdText : bodyText;
    const baseFields = jsonLdFields || (isSpaShell ? slugFields : null);
    // Merge script-extracted salary into fields
    const fields = scriptSalary ? { ...(baseFields || {}), salary: scriptSalary } : baseFields;
    // If salary couldn't be extracted, mark it explicitly
    if (fields && fields.salary == null) fields.salary = 'not found';
    return { fields, html:html.slice(0,500000), text, _ats:ats, _spaShell:isSpaShell&&!jsonLdFields };
  } catch(e) {
    if (slugFields) return { fields:slugFields, html:'', text:'', _ats:ats, _slugFallback:true };
    return { html:'', text:'', error:e.message, _ats:ats };
  }
}

app.post('/api/parse-job', authMiddleware, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    res.json(await fetchATS(url));
  } catch (e) { res.json({ html:'', text:'', error: e.message }); }
});

app.post('/api/extract-fields', authMiddleware, async (req, res) => {
  const postingText = req.body.postingText || req.body.text || '';
  if (!postingText) return res.status(400).json({ error: 'postingText required' });
  const sys = 'Extract job posting details. Return ONLY valid JSON, no markdown, no explanation. Fields: title(string), company(string), location(city+state only, null if remote-only), workType("Remote"|"Hybrid"|"On-site"|null), remote(boolean), salary(ONLY real dollar amounts like "$120k-$150k/yr" or null — never invent, never use "Competitive" or "DOE").';
  const usr = `Extract from this job posting:\n\n${postingText.slice(0, 4000)}`;
  try {
    res.json(parseJson(await callAI(['openrouter','groq','google'], sys, usr, 400)));
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
    const result = await callAI(['openrouter','groq','google'], sys, usr, 3000);
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
    const tailored = await callAI(['openrouter','groq','google'], sys, usr, 3000);
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
"workforce":{"headcount":"N,NNN","headcountTrend":"growing","avgTenure":"2.5 years","fullTimePct":85,"remoteRatio":40,"recentLayoffs":"None","headcountHistory":[{"year":2019,"count":5000},{"year":2020,"count":5200},{"year":2021,"count":7000},{"year":2022,"count":9000},{"year":2023,"count":10500},{"year":2024,"count":12000}],"genderSplit":{"female":42,"male":56,"other":2},"ageBrackets":{"under30":28,"30to40":38,"40to50":22,"over50":12},"ethnicityMix":{"asian":28,"white":48,"hispanic":12,"black":8,"other":4},"visaSponsorship":"yes","visaNote":"Sponsors H-1B; green card support for qualified candidates","topLocations":["City, ST","Remote"],"glassdoorDiversity":4.1,"note":"Estimated from public data."},
"culture":{"overallRating":3.8,"workLifeBalance":3.5,"cultureValues":3.8,"careerOpp":3.6,"compensation":3.4,"leadership":3.5,"numRatings":"1,234","ceoApproval":72,"recommend":68,"summary":"Culture summary paragraph"},
"roleIntel":"2-3 paragraphs about this specific role and team",
"flags":{"green":["positive signal"],"red":["concern to watch"]},
"linkedin":{"suggestedContacts":[{"name":"Hiring Manager Title","role":"Engineering Manager","company":"${company}","tip":"Why to reach out"}],"outreachTip":"Strategy","messageTemplate":"Hi [Name], ..."},
"news":[{"headline":"Recent headline","source":"Source","date":"2024-01","url":"","sentiment":"positive"}],
"interviewTips":"Role-specific interview preparation tips"}`
  try {
    const raw = await callAI(['groq','openrouter','google'], sys, usr, 4000);
    const data = parseJson(raw);
    res.json({ ...data, stock, generatedAt: Date.now() });
  } catch (e) { console.error('insights:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/outreach-targets', authMiddleware, async (req, res) => {
  const { company, title } = req.body;
  try {
    const raw = await callAI(['openrouter','groq','google'],
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
    const raw = await callAI(['openrouter','groq','google'],
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
    const raw = await callAI(['openrouter','groq','google'],
      'Return valid JSON only, no markdown.',
      `Find keyword gaps between this resume and job posting.\nPosting: ${(postingText||'').slice(0,2000)}\nResume: ${(resumeText||'').slice(0,2000)}\nReturn: {"matched":["keyword"],"missing":["keyword"],"score":75,"suggestions":["add X to Y"]}`,
      800);
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/email-template', authMiddleware, async (req, res) => {
  const { company, title, type, context } = req.body;
  try {
    const raw = await callAI(['openrouter','groq','google'],
      'Return valid JSON only, no markdown.',
      `Write a ${type||'follow-up'} email for ${title} at ${company}. ${context||''}\nReturn: {"subject":"...","body":"..."}`,
      500);
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/salary-benchmark', authMiddleware, async (req, res) => {
  const { title, location, company } = req.body;
  try {
    const raw = await callAI(['openrouter','groq','google'],
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
