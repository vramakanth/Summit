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
const USAGE_DIR      = path.join(DATA_DIR, 'usage');
// Per-user daily token cap. User sees a warning banner at 80%, requests are
// rejected once the cap is reached. Override via DAILY_TOKEN_CAP env var.
// Default 100K is enough for ~4 typical user sessions per day (insights +
// a few tailors + interview questions) without exhausting free-tier budgets.
const DAILY_TOKEN_CAP = parseInt(process.env.DAILY_TOKEN_CAP || '100000', 10);
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || '';
const APP_URL        = process.env.APP_URL        || 'https://job-application-tracker-hf1f.onrender.com';
const GROQ_API_KEY   = process.env.GROQ_API_KEY   || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GROQ_MODEL     = process.env.GROQ_MODEL     || 'llama-3.3-70b-versatile';
// Cheap high-TPM fallback when primary hits 429. Groq's free tier gives 8b-instant
// 25K TPM vs 12K for 70B, so it usually gets through when the big model is throttled.
const GROQ_FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant';
// OpenRouter fallback path. Using openrouter/free (an auto-router across free
// models — Nemotron Super/Nano, Trinity Large, etc.) instead of pinning
// llama-3.3-70b — the Llama free tier has the same rate limits as Groq's
// primary model, so when Groq rate-limited us the OR fallback just hit the
// same wall. The auto-router smartly filters for models supporting our
// required features (structured JSON output) and spreads load across
// providers so transient rate limits on one don't break the whole request.
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
// Google's gemini-2.0-flash was deprecated March 31, 2026 → requests return 404.
// gemini-2.5-flash is the free-tier successor. Override via GOOGLE_MODEL env var
// on Render if you want a different default (e.g. gemini-3-flash-preview).
const GOOGLE_MODEL   = process.env.GOOGLE_MODEL   || 'gemini-2.5-flash';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Data directories ─────────────────────────────────────────────────────────
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const JOBS_DIR    = path.join(DATA_DIR, 'jobs');
const NOTES_DIR   = path.join(DATA_DIR, 'notes');
const DOCS_DIR    = path.join(DATA_DIR, 'docs');
const SETTINGS_DIR = path.join(DATA_DIR, 'settings');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
for (const d of [DATA_DIR, JOBS_DIR, DOCS_DIR, SETTINGS_DIR, USAGE_DIR, NOTES_DIR]) {
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
    if (fp.endsWith('sw.js'))              res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (fp.endsWith('manifest.json')) res.setHeader('Cache-Control', 'no-cache');
    // HTML files are our single source of truth for the app's JS — they must
    // NEVER be stale. A cached index.html serving old inline JS against a new
    // backend is how users end up with a Frankenstein state. Force
    // revalidation on every request; browsers will still use If-Modified-Since
    // so the response is typically a cheap 304.
    else if (fp.endsWith('.html'))         res.setHeader('Cache-Control', 'no-cache, must-revalidate');
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

// ── Token usage tracking ────────────────────────────────────────────────────
// Two storage layers:
//   1) NDJSON append log (data/usage/YYYY-MM.log) — source of truth, every call
//      a line: {ts, user, provider, model, endpoint, prompt, completion}
//   2) Per-user daily cache (data/usage/{user}.json) — pre-aggregated so the
//      user settings pane and daily-cap checks don't scan the log on every call.

function todayKey() { return new Date().toISOString().slice(0, 10); }
function monthKey() { return new Date().toISOString().slice(0, 7); }

function appendUsageLog(entry) {
  try {
    const file = path.join(USAGE_DIR, `${monthKey()}.log`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e) { console.warn('usage log append failed:', e.message); }
}

function loadUserUsage(user) {
  const file = path.join(USAGE_DIR, `${user}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveUserUsage(user, data) {
  const file = path.join(USAGE_DIR, `${user}.json`);
  try { fs.writeFileSync(file, JSON.stringify(data, null, 0)); }
  catch (e) { console.warn('usage save failed:', e.message); }
}

function recordUsage(user, provider, model, endpoint, prompt, completion) {
  if (!user) return;
  const total = (prompt || 0) + (completion || 0);
  if (!total) return;
  const day = todayKey();
  appendUsageLog({ ts: Date.now(), user, day, provider, model, endpoint, prompt: prompt || 0, completion: completion || 0 });
  const usage = loadUserUsage(user);
  if (!usage[day]) usage[day] = { total: 0, byProvider: {}, byEndpoint: {} };
  usage[day].total                  += total;
  usage[day].byProvider[provider]    = (usage[day].byProvider[provider] || 0) + total;
  usage[day].byEndpoint[endpoint]    = (usage[day].byEndpoint[endpoint] || 0) + total;
  saveUserUsage(user, usage);
}

function todaysUsage(user) {
  if (!user) return 0;
  const usage = loadUserUsage(user);
  return usage[todayKey()]?.total || 0;
}

// Middleware: reject requests when user has hit the daily cap.
function tokenCapMiddleware(req, res, next) {
  if (!DAILY_TOKEN_CAP) return next();
  const user = req.user?.username || req.username;
  if (!user) return next();
  const used = todaysUsage(user);
  if (used >= DAILY_TOKEN_CAP) {
    return res.status(429).json({
      error: 'token_cap_reached',
      detail: `Daily AI token budget reached (${used.toLocaleString()} / ${DAILY_TOKEN_CAP.toLocaleString()}). Resets at midnight UTC.`,
      used, cap: DAILY_TOKEN_CAP,
    });
  }
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
  // Try primary model first. On 429 (rate limit), fall back to 8b-instant which
  // has a much higher TPM budget on Groq's free tier (25K vs 12K for the 70B).
  const attempt = async (model) => {
    const r = await fetchTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model, max_tokens: maxTok, temperature: 0.3,
        messages: [{ role:'system', content:sys }, { role:'user', content:usr }] })
    });
    if (!r.ok) { const err = new Error(`Groq ${r.status}: ${(await r.text()).slice(0,200)}`); err.status = r.status; throw err; }
    const data = await r.json();
    return {
      text:  data.choices[0].message.content,
      usage: { prompt: data.usage?.prompt_tokens || 0, completion: data.usage?.completion_tokens || 0 },
      model,
    };
  };
  try {
    return await attempt(GROQ_MODEL);
  } catch (e) {
    if (e.status === 429 && GROQ_MODEL !== GROQ_FALLBACK_MODEL) {
      console.warn(`Groq ${GROQ_MODEL} rate-limited — falling back to ${GROQ_FALLBACK_MODEL}`);
      return await attempt(GROQ_FALLBACK_MODEL);
    }
    throw e;
  }
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
  const data = await r.json();
  return {
    text:  data.choices[0].message.content,
    usage: { prompt: data.usage?.prompt_tokens || 0, completion: data.usage?.completion_tokens || 0 },
    model: OPENROUTER_MODEL,
  };
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
  const data = await r.json();
  return {
    text:  data.candidates[0].content.parts[0].text,
    usage: { prompt: data.usageMetadata?.promptTokenCount || 0, completion: data.usageMetadata?.candidatesTokenCount || 0 },
    model: GOOGLE_MODEL,
  };
}

// ── Public data fetchers ─────────────────────────────────────────────────────
// Replaces AI-hallucinated content with real data from public sources where
// possible. Each helper fails open (returns null/[]) so a dead source doesn't
// sink the whole insights response.

// Wikipedia REST summary — real company overview prose. Used both as the
// displayed overview text and as grounding context for the AI's structured
// fields (overview.founded/hq/industry/employees). Keyless, respects the
// W3C User-Agent requirement.
async function fetchWikipediaSummary(company) {
  if (!company) return null;
  // Wikipedia is case-insensitive for title matching but prefers the
  // canonical form. Try the company name as-is first.
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(company)}`;
    const r = await fetchTimeout(url, {
      headers: { 'User-Agent': 'Summit/1.0 (https://jobsummit.app; contact@jobsummit.app)' }
    }, 6000);
    if (!r.ok) return null;
    const data = await r.json();
    // Skip disambiguation pages and standalone redirects with no prose
    if (data.type === 'disambiguation') return null;
    if (!data.extract || data.extract.length < 80) return null;
    return {
      title:       data.title || company,
      description: data.description || '',
      extract:     data.extract,
      url:         data.content_urls?.desktop?.page || '',
      qid:         data.wikibase_item || null,  // e.g. "Q95" for Google → lets Wikidata skip its own search
    };
  } catch (e) {
    console.warn('wikipedia fail:', e.message);
    return null;
  }
}

// Wikidata structured facts — founded / HQ / industry / employees as ground
// truth, resolving entity references to human-readable labels via SPARQL.
// Takes an optional QID (from the Wikipedia REST summary) to skip the lookup
// round trip. Returns null if no entity found or SPARQL fails — caller shows
// just the cards that came back populated (renderOverviewCards already filters
// empties).
async function fetchWikidataOverview(company, qid) {
  if (!company && !qid) return null;
  const ua = 'Summit/1.0 (https://jobsummit.app; contact@jobsummit.app)';
  try {
    // Step 1: resolve the QID if we weren't handed one
    if (!qid) {
      const sr = await fetchTimeout(
        `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(company)}&language=en&format=json&type=item&limit=1&origin=*`,
        { headers: { 'User-Agent': ua } }, 6000
      );
      if (!sr.ok) return null;
      const sdata = await sr.json();
      qid = sdata.search?.[0]?.id;
      if (!qid) return null;
    }

    // Step 2: SPARQL — single query returns labels for all four properties
    //   P571 inception, P159 headquarters location, P452 industry, P1128 employees
    // `SERVICE wikibase:label` resolves entity references (e.g. Mountain View) to strings.
    const sparql = `
SELECT ?founded ?hqLabel ?industryLabel ?employees WHERE {
  OPTIONAL { wd:${qid} wdt:P571 ?founded. }
  OPTIONAL { wd:${qid} wdt:P159 ?hq. }
  OPTIONAL { wd:${qid} wdt:P452 ?industry. }
  OPTIONAL { wd:${qid} wdt:P1128 ?employees. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 1`;
    const qr = await fetchTimeout(
      `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`,
      { headers: { 'User-Agent': ua, 'Accept': 'application/sparql-results+json' } }, 8000
    );
    if (!qr.ok) return null;
    const qdata = await qr.json();
    const row = qdata.results?.bindings?.[0];
    if (!row) return null;

    // Format employees with commas (Wikidata returns raw integer as string)
    const empRaw = row.employees?.value;
    const employees = empRaw && !isNaN(empRaw)
      ? Number(empRaw).toLocaleString('en-US')
      : '';
    // Founded date comes as ISO "1998-09-04T00:00:00Z" — we only need the year
    const foundedYear = row.founded?.value
      ? new Date(row.founded.value).getUTCFullYear()
      : null;

    const result = {
      founded:  foundedYear ? String(foundedYear) : '',
      hq:       row.hqLabel?.value || '',
      industry: row.industryLabel?.value || '',
      employees,
    };
    // If Wikidata has none of the four, that's effectively null
    if (!result.founded && !result.hq && !result.industry && !result.employees) return null;
    return result;
  } catch (e) {
    console.warn('wikidata fail:', e.message);
    return null;
  }
}

async function fetchCompanyNews(company, ticker, _finnhubKey) {
  // Finnhub company-news was removed — it returned low-quality matches
  // (press releases, promotional content, unrelated items). We now query
  // two keyless RSS feeds in parallel and merge+dedupe by URL.
  //
  // Sources in priority order:
  //   1. Yahoo Finance RSS — ticker-gated, so only runs for public companies.
  //      Strong financial-specific curation; good for earnings, guidance,
  //      analyst moves, M&A. Free, no key required.
  //   2. Google News RSS — keyless, searchable by company name. Broader net;
  //      catches non-financial press (partnerships, layoffs, product news).
  //      Each <item> carries its own <source> tag naming the actual publisher
  //      (Reuters, Bloomberg, TechCrunch, etc.) which we surface to the user.
  //
  // Each item is tagged with `source` so the UI can display per-item
  // attribution. Merged list is sorted by date (newest first) and capped at 6.
  const items = [];
  const seen = new Set();

  const parseItem = (block, extract) => ({
    headline:  extract(block, 'title'),
    url:       extract(block, 'link'),
    pubDate:   extract(block, 'pubDate'),
    source:    extract(block, 'source'),
  });
  const tagExtract = (block, tag) => {
    const m = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`).exec(block);
    return m ? m[1].trim() : '';
  };
  const addItem = (headline, source, pubDate, url) => {
    if (!headline || !url) return;
    // Dedupe on URL — Yahoo and Google sometimes surface the same article
    const key = url.split('?')[0];
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      headline:  headline.trim(),
      source:    (source || 'News').trim(),
      date:      pubDate ? new Date(pubDate).toISOString().slice(0, 10) : '',
      url,
      sentiment: '',
    });
  };

  // Run both feeds in parallel. Either failing is fine — we fall back to the
  // other. If both fail, news[] is empty and the UI shows a graceful empty state.
  const tasks = [];

  // 1. Yahoo Finance RSS (ticker-only)
  if (ticker) {
    tasks.push((async () => {
      try {
        const r = await fetchTimeout(
          `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`,
          { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SummitBot/1.0)' } },
          8000
        );
        if (!r.ok) return;
        const xml = await r.text();
        const itemRe = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = itemRe.exec(xml)) && items.length < 12) {
          const it = parseItem(m[1], tagExtract);
          addItem(it.headline, 'Yahoo Finance', it.pubDate, it.url);
        }
      } catch (e) { console.warn('yahoo news fail:', e.message); }
    })());
  }

  // 2. Google News RSS (keyword-based, works for any company)
  tasks.push((async () => {
    try {
      const q = encodeURIComponent(company);
      const r = await fetchTimeout(
        `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SummitBot/1.0)' } },
        8000
      );
      if (!r.ok) return;
      const xml = await r.text();
      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = itemRe.exec(xml)) && items.length < 12) {
        const it = parseItem(m[1], tagExtract);
        // Google appends " — Publisher" to titles; strip for a clean headline
        const cleanHeadline = (it.headline || '').replace(/\s+[—-]\s+[^—-]+$/, '').trim() || it.headline;
        addItem(cleanHeadline, it.source || 'Google News', it.pubDate, it.url);
      }
    } catch (e) { console.warn('google news fail:', e.message); }
  })());

  await Promise.all(tasks);

  // Sort newest first; undated items sink to the bottom
  items.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });

  return items.slice(0, 6);
}

// callAI(order, sys, usr, maxTok, req, endpoint)
// When req and endpoint are provided, token usage is recorded against the
// authenticated user for that feature. Returns just the text string — usage
// bookkeeping is a side effect so the ten existing call sites don't need
// their unwrapping patterns changed.
async function callAI(order, sys, usr, maxTok = 4000, req = null, endpoint = null) {
  const fns     = { groq: callGroq, openrouter: callOpenRouter, google: callGoogle };
  const models  = { groq: GROQ_MODEL, openrouter: OPENROUTER_MODEL, google: GOOGLE_MODEL };
  const errs = [];
  for (const name of order) {
    try {
      const result = await fns[name](sys, usr, maxTok);
      // result = {text, usage: {prompt, completion}, model}
      console.log(`AI ok: ${name} (${result.model || models[name]}) — ${result.usage?.prompt || 0}+${result.usage?.completion || 0} tokens`);
      // Record usage against the authenticated user, if request context provided
      const user = req?.user?.username || req?.username || null;
      if (user && endpoint) {
        recordUsage(user, name, result.model || models[name], endpoint,
                    result.usage?.prompt || 0, result.usage?.completion || 0);
      }
      return result.text;
    } catch (e) {
      console.warn(`AI ${name} fail [${models[name]}]: ${e.message}`);
      errs.push(`${name}(${models[name]}): ${e.message}`);
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
  // Lower bound is i > 1 (not 100 — that was a bug that prevented short
  // truncated inputs from ever being salvaged; the loop never iterated).
  for (let i = s.length - 1; i > 1; i--) {
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

// ── Simple rate limiter for sensitive endpoints ─────────────────────────────
// In-memory sliding window keyed by username OR remote IP. Zero external
// dependencies (no redis) — fine for a single-instance Render deploy.
// For multi-instance or production-scale, swap for a real distributed store.
//
// ⚠️ Must be declared BEFORE any app.post/get that references the limiters
// below (login, recover). Moving these further down triggers a temporal
// dead zone ReferenceError at module load — const bindings can't be
// referenced before their init line even though the VM hoists the name.
const _rateBuckets = new Map();
function rateLimit({ windowMs, max, keyFn, label }) {
  return (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next();
    const now = Date.now();
    let bucket = _rateBuckets.get(key);
    if (!bucket) { bucket = []; _rateBuckets.set(key, bucket); }
    // Drop entries older than the window
    while (bucket.length && bucket[0] < now - windowMs) bucket.shift();
    if (bucket.length >= max) {
      const retryAfter = Math.ceil((bucket[0] + windowMs - now) / 1000);
      console.warn(`rate-limit hit on ${label}: key=${key} count=${bucket.length}`);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: 'rate_limited',
        detail: `Too many ${label} attempts. Try again in ${retryAfter} seconds.`,
      });
    }
    bucket.push(now);
    next();
  };
}
// Periodic cleanup — prevent unbounded growth of the bucket map
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of _rateBuckets) {
    while (bucket.length && bucket[0] < now - 3600 * 1000) bucket.shift();
    if (bucket.length === 0) _rateBuckets.delete(key);
  }
}, 15 * 60 * 1000).unref();

// Rate limiters for auth-sensitive endpoints. Key by username where we have it,
// fall back to IP. Limits chosen to be tight enough to block brute-force but
// loose enough that a legitimate user hitting "forgot password" a few times
// in a row won't get locked out.
const _recoverLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour sliding window
  max:      10,               // 10 recovery attempts per hour per username
  keyFn:    req => `recover:${(req.body?.username || '').toLowerCase() || req.ip}`,
  label:    'recovery',
});
const _loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max:      20,               // generous — legit users sometimes fat-finger passwords
  keyFn:    req => `login:${(req.body?.username || '').toLowerCase() || req.ip}`,
  label:    'login',
});

app.post('/api/register', async (req, res) => {
  const { username, password, email, encryptedDataKey, recoveryKeySlots } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3)    return res.status(400).json({ error: 'Username must be 3+ chars' });
  if (password.length < 6)    return res.status(400).json({ error: 'Password must be 6+ chars' });
  const users = loadUsers();
  const uid = username.toLowerCase();
  if (users[uid]) return res.status(409).json({ error: 'Username already taken' });
  // Build the user record. For zero-knowledge accounts the client ships
  // encryptedDataKey + recoveryKeySlots; we store them opaquely — the server
  // never sees the underlying dataKey or the plaintext recovery codes.
  const rec = {
    username,
    passwordHash: await bcrypt.hash(password, 12),
    createdAt: Date.now(),
  };
  if (email && typeof email === 'string' && email.includes('@')) rec.email = email.trim();
  if (encryptedDataKey && typeof encryptedDataKey === 'string') {
    rec.encrypted        = true;
    rec.encryptedDataKey = encryptedDataKey;
    // Slots: [{index, slot}]. We add a `used:false` flag to each so recovery
    // can consume them one at a time without losing the array shape.
    rec.recoveryKeySlots = Array.isArray(recoveryKeySlots)
      ? recoveryKeySlots.map(s => ({ index: s.index, slot: s.slot, used: false }))
      : [];
    rec.recoveryCodesGeneratedAt = Date.now();
  }
  users[uid] = rec;
  saveUsers(users);
  const token = jwt.sign({ id: uid, username }, JWT_SECRET, { expiresIn: '30d' });
  const response = { token, username };
  if (rec.encrypted) response.encryptedDataKey = rec.encryptedDataKey;
  res.json(response);
});

app.get('/api/ping', (req, res) => res.json({ ok: true, version: '1.5.0', dataDir: DATA_DIR, usersExist: fs.existsSync(USERS_FILE) }));

app.post('/api/login', _loginLimiter, async (req, res) => {
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
    // Log only that the attempt failed, never the attempted or existing
    // usernames. Anyone with log access could otherwise enumerate accounts.
    console.log('Login failed: unknown user');
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
  const response = { token: jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' }), username: user.username };
  // Zero-knowledge accounts: return the wrapped dataKey. The client derives
  // its password key locally and unwraps. Server never sees the plain dataKey.
  if (user.encrypted && user.encryptedDataKey) {
    response.encrypted        = true;
    response.encryptedDataKey = user.encryptedDataKey;
  }
  res.json(response);
});

app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword, newEncryptedDataKey } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password too short' });
  const users = loadUsers();
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const existingHash = user.passwordHash || user.password;
  if (!(await bcrypt.compare(currentPassword, existingHash)))
    return res.status(401).json({ error: 'Current password incorrect' });
  // Zero-knowledge: if the account is encrypted, the client MUST supply the
  // re-wrapped data key (wrapped with the new password-derived key).
  // Without it, login after password change would fail because the old wrapped
  // key can no longer be unwrapped by the new password.
  if (user.encrypted && user.encryptedDataKey) {
    if (!newEncryptedDataKey || typeof newEncryptedDataKey !== 'string') {
      return res.status(400).json({ error: 'Encrypted account requires newEncryptedDataKey (client must re-wrap)' });
    }
    user.encryptedDataKey = newEncryptedDataKey;
  }
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  delete user.password; // normalise field name
  saveUsers(users);
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// All key material (dataKey, recovery codes) is generated in the browser.
// The server stores only opaque ciphertext blobs (encryptedDataKey) and
// wrapped-with-recovery-code blobs (recoveryKeySlots). It CANNOT decrypt
// user data with any data it holds.

app.get('/api/recovery-codes', authMiddleware, (req, res) => {
  const users = loadUsers();
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.encrypted) {
    // Account isn't encrypted yet — no recovery codes exist.
    return res.json({ count: 0, createdAt: null, encrypted: false });
  }
  // Count unused slots
  const slots = user.recoveryKeySlots || [];
  const count = slots.filter(s => !s.used).length;
  res.json({
    count,
    createdAt: user.recoveryCodesGeneratedAt || user.createdAt || null,
    encrypted: true,
  });
});

app.post('/api/recovery-codes/generate', authMiddleware, async (req, res) => {
  const { password, encryptedDataKey, recoveryKeySlots } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  const users = loadUsers();
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const hash = user.passwordHash || user.password;
  if (!(await bcrypt.compare(password, hash)))
    return res.status(401).json({ error: 'Password incorrect' });
  if (!user.encrypted) return res.status(400).json({ error: 'Account is not encrypted' });
  if (!Array.isArray(recoveryKeySlots) || recoveryKeySlots.length < 1) {
    return res.status(400).json({ error: 'recoveryKeySlots required' });
  }
  // Replace all slots with the new set (old codes become invalid immediately).
  // If the client also re-wrapped the dataKey (rare but allowed), update that too.
  user.recoveryKeySlots = recoveryKeySlots.map(s => ({ index: s.index, slot: s.slot, used: false }));
  user.recoveryCodesGeneratedAt = Date.now();
  if (encryptedDataKey && typeof encryptedDataKey === 'string') {
    user.encryptedDataKey = encryptedDataKey;
  }
  saveUsers(users);
  res.json({ ok: true, count: user.recoveryKeySlots.length, createdAt: user.recoveryCodesGeneratedAt });
});

app.post('/api/enable-encryption', authMiddleware, async (req, res) => {
  const { password, encryptedDataKey, recoveryKeySlots, encryptedJobs } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!encryptedDataKey) return res.status(400).json({ error: 'encryptedDataKey required' });
  if (!Array.isArray(recoveryKeySlots) || recoveryKeySlots.length < 1) {
    return res.status(400).json({ error: 'recoveryKeySlots required' });
  }
  const users = loadUsers();
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const hash = user.passwordHash || user.password;
  if (!(await bcrypt.compare(password, hash)))
    return res.status(401).json({ error: 'Password incorrect' });
  if (user.encrypted) return res.status(400).json({ error: 'Account already encrypted' });
  // Flip the account to encrypted. If client shipped pre-encrypted jobs blob,
  // atomically overwrite the jobs file with the ciphertext envelope.
  user.encrypted            = true;
  user.encryptedDataKey     = encryptedDataKey;
  user.recoveryKeySlots     = recoveryKeySlots.map(s => ({ index: s.index, slot: s.slot, used: false }));
  user.recoveryCodesGeneratedAt = Date.now();
  saveUsers(users);
  if (encryptedJobs && typeof encryptedJobs === 'string') {
    // Store in the client's expected envelope shape: {__enc:true, data:ciphertext}
    const file = path.join(JOBS_DIR, `${req.user.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ __enc: true, data: encryptedJobs }));
  }
  res.json({ ok: true });
});

app.post('/api/recover', _recoverLimiter, async (req, res) => {
  const { username, recoveryCode, newPassword, newEncryptedDataKey, slotIndex } = req.body;
  if (!username || !recoveryCode) return res.status(400).json({ error: 'username and recoveryCode required' });
  // Rate limiting is handled by the _recoverLimiter middleware: 10 attempts
  // per hour per username. Tight enough to block brute-force/enumeration,
  // loose enough that a user who genuinely needs recovery a couple of times
  // in a day isn't locked out.
  const uid = username.toLowerCase();
  const users = loadUsers();
  const user  = users[uid] || Object.values(users).find(u => (u.username||'').toLowerCase() === uid);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Non-encrypted accounts — this route only exists for zero-knowledge ones.
  if (!user.encrypted) return res.status(400).json({ error: 'Account is not encrypted; use /api/forgot instead' });

  // Zero-knowledge recovery: the server CANNOT verify a recovery code — it
  // has never seen the plaintext code, only wrapped data keys. Protocol is:
  //   Phase 1: client POSTs {username, recoveryCode} with no newPassword.
  //            Server returns ALL unused slots as an array.
  //            Client tries to unwrap each with the code; exactly one succeeds.
  //   Phase 2: client POSTs {username, recoveryCode, newPassword,
  //            newEncryptedDataKey, slotIndex} — the index of the slot it
  //            successfully unwrapped. Server marks that specific slot used,
  //            updates the password hash, and swaps in the new wrapped key.
  //
  // Sending recoveryCode in phase 1 serves as a rate-limiting gate — we
  // don't expose wrapped slots to anonymous clients without at least a
  // plausible token. A future hardening step could hash-verify the code
  // itself, but that would weaken the zero-knowledge property.

  if (newPassword && newEncryptedDataKey) {
    // Phase 2: consume the specific slot the client successfully unwrapped.
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password too short' });
    const slots = user.recoveryKeySlots || [];
    // Accept the index from the client. Fall back to first-unused if missing
    // (legacy behavior) but that's wrong for multi-slot cases.
    let slotToConsume = null;
    if (typeof slotIndex === 'number') {
      slotToConsume = slots.find(s => s.index === slotIndex && !s.used);
    }
    if (!slotToConsume) slotToConsume = slots.find(s => !s.used);
    if (!slotToConsume) return res.status(400).json({ error: 'No unused recovery slots remain' });
    slotToConsume.used    = true;
    user.passwordHash     = await bcrypt.hash(newPassword, 12);
    user.encryptedDataKey = newEncryptedDataKey;
    delete user.password;
    saveUsers(users);
    const token = jwt.sign({ id: uid, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    const remaining = (user.recoveryKeySlots || []).filter(s => !s.used).length;
    return res.json({ token, username: user.username, codesRemaining: remaining });
  }

  // Phase 1: return ALL unused slots so the client can try each
  const slots = (user.recoveryKeySlots || []).filter(s => !s.used);
  if (!slots.length) return res.status(400).json({ error: 'No unused recovery codes remain' });
  return res.json({
    phase:     1,
    encrypted: true,
    slots:     slots.map(s => ({ index: s.index, slot: s.slot })),
  });
});

// ────────────────────────────────────────────────────────────────────────────

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
  // Remove notes directory (contains one file per job with notes)
  try { fs.rmSync(path.join(NOTES_DIR, req.user.id), { recursive: true, force: true }); } catch {}
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
  // Do not log the reset URL — Render captures server logs and anyone with
  // log access could use the URL to reset any account. The URL is returned
  // in the response (for the admin flow) and also emailed via /api/admin/send-reset-link.
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

// ── Notes (rich-text per-job documents with history) ───────────────────────
// Storage: one JSON file per (user, jobId) at data/notes/{userId}/{jobId}.json
// Shape: { current: <opaque blob>, history: [ { version, createdAt, blob }, ... ], nextVersion: N }
// For zero-knowledge accounts the blobs are ciphertext from the client — server
// stores opaquely, never inspects content. For plaintext accounts the blobs are
// the JSON doc object. Server treats both the same way.

const MAX_NOTE_VERSIONS = 20;  // retain last N snapshots per note doc

function _notesUserDir(userId) {
  const d = path.join(NOTES_DIR, userId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function _notesFilePath(userId, jobId) {
  // jobId is client-generated. Reject anything that could escape the dir.
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return null;
  return path.join(_notesUserDir(userId), `${jobId}.json`);
}
function _loadNotes(userId, jobId) {
  const f = _notesFilePath(userId, jobId);
  if (!f || !fs.existsSync(f)) return { current: null, history: [], nextVersion: 1 };
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return { current: null, history: [], nextVersion: 1 }; }
}
function _saveNotes(userId, jobId, data) {
  const f = _notesFilePath(userId, jobId);
  if (!f) return false;
  fs.writeFileSync(f, JSON.stringify(data));
  return true;
}

// GET current doc — returns {current, version, updatedAt}
app.get('/api/notes/:jobId', authMiddleware, (req, res) => {
  const { jobId } = req.params;
  const f = _notesFilePath(req.user.id, jobId);
  if (!f) return res.status(400).json({ error: 'Invalid jobId' });
  const d = _loadNotes(req.user.id, jobId);
  res.json({
    current:   d.current || null,
    version:   d.current?.version || 0,
    updatedAt: d.current?.updatedAt || null,
  });
});

// PUT (autosave). Body: { blob, createSnapshot: bool }
// - `blob` is stored opaquely as the current doc. Client sends ciphertext for
//   zero-knowledge accounts, plaintext JSON otherwise.
// - If `createSnapshot` is true, the PREVIOUS current is promoted into history
//   before being replaced. This way the client controls when a version is
//   committed (based on pause + content-changed heuristic).
// - History capped at MAX_NOTE_VERSIONS — oldest pruned.
app.put('/api/notes/:jobId', authMiddleware, (req, res) => {
  const { jobId } = req.params;
  const f = _notesFilePath(req.user.id, jobId);
  if (!f) return res.status(400).json({ error: 'Invalid jobId' });
  const { blob, createSnapshot } = req.body || {};
  if (blob === undefined) return res.status(400).json({ error: 'blob required' });
  const d = _loadNotes(req.user.id, jobId);
  // Promote previous current into history when snapshot requested
  if (createSnapshot && d.current) {
    d.history.push({
      version:   d.current.version,
      createdAt: d.current.updatedAt,
      blob:      d.current.blob,
    });
    // Prune oldest if over cap
    while (d.history.length > MAX_NOTE_VERSIONS) d.history.shift();
  }
  d.current = {
    version:   d.nextVersion || 1,
    updatedAt: Date.now(),
    blob,
  };
  d.nextVersion = (d.nextVersion || 1) + 1;
  _saveNotes(req.user.id, jobId, d);
  res.json({ ok: true, version: d.current.version, updatedAt: d.current.updatedAt,
             historyCount: d.history.length });
});

// GET history — returns [{version, createdAt}] metadata only. Client fetches
// individual snapshots on demand. Keeps the response small for long histories.
app.get('/api/notes/:jobId/history', authMiddleware, (req, res) => {
  const { jobId } = req.params;
  const f = _notesFilePath(req.user.id, jobId);
  if (!f) return res.status(400).json({ error: 'Invalid jobId' });
  const d = _loadNotes(req.user.id, jobId);
  // Include `current` as the newest "version" too so history list shows current state
  const items = d.history.map(h => ({ version: h.version, createdAt: h.createdAt }));
  if (d.current) items.push({ version: d.current.version, createdAt: d.current.updatedAt, isCurrent: true });
  // Newest first
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ versions: items });
});

// GET specific version — returns the opaque blob for that version
app.get('/api/notes/:jobId/version/:v', authMiddleware, (req, res) => {
  const { jobId, v } = req.params;
  const f = _notesFilePath(req.user.id, jobId);
  if (!f) return res.status(400).json({ error: 'Invalid jobId' });
  const d = _loadNotes(req.user.id, jobId);
  const version = parseInt(v, 10);
  if (d.current && d.current.version === version) {
    return res.json({ version, createdAt: d.current.updatedAt, blob: d.current.blob });
  }
  const hist = d.history.find(h => h.version === version);
  if (!hist) return res.status(404).json({ error: 'Version not found' });
  res.json({ version: hist.version, createdAt: hist.createdAt, blob: hist.blob });
});

// POST restore — makes a historical version the new current (doesn't discard
// anything; the existing current is pushed into history like a normal snapshot).
app.post('/api/notes/:jobId/restore', authMiddleware, (req, res) => {
  const { jobId } = req.params;
  const f = _notesFilePath(req.user.id, jobId);
  if (!f) return res.status(400).json({ error: 'Invalid jobId' });
  const { version } = req.body || {};
  if (typeof version !== 'number') return res.status(400).json({ error: 'version required' });
  const d = _loadNotes(req.user.id, jobId);
  const hist = d.history.find(h => h.version === version);
  if (!hist) return res.status(404).json({ error: 'Version not found' });
  // Snapshot current state first (lossless restore)
  if (d.current) {
    d.history.push({ version: d.current.version, createdAt: d.current.updatedAt, blob: d.current.blob });
    while (d.history.length > MAX_NOTE_VERSIONS) d.history.shift();
  }
  d.current = {
    version:   d.nextVersion || 1,
    updatedAt: Date.now(),
    blob:      hist.blob,  // restore the historical blob as new current
  };
  d.nextVersion = (d.nextVersion || 1) + 1;
  _saveNotes(req.user.id, jobId, d);
  res.json({ ok: true, version: d.current.version, updatedAt: d.current.updatedAt });
});

// ────────────────────────────────────────────────────────────────────────────

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
const { cleanJobUrl, slugFallback, decodeEntities } = require('./ats-helpers');
const { renderPage, shutdownBrowser } = require('./render');

// Known SPA hosts where direct-fetch returns an empty shell and Jina's
// script-tag-stripping makes JSON-LD invisible. For these we skip the
// Jina path entirely and route through our own Chromium renderer, which
// returns the post-hydration DOM (including JSON-LD script tags).
//
// Everything NOT on this list keeps the existing direct-fetch → Jina flow
// — SSR sites like Greenhouse, iCIMS, Lever-with-content render fine in
// Jina and don't need the memory overhead of a headless browser.
const SPA_HOSTS = [
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'myworkdayjobs.com',          // all *.myworkdayjobs.com subdomains
  'bamboohr.com',               // *.bamboohr.com/jobs
  'jobs.apple.com',
  'jobs.bd.com',                // Workday-based BD careers site
];

function isSpaHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SPA_HOSTS.some(spa => host.includes(spa));
  } catch { return false; }
}

/**
 * Parse the first JobPosting JSON-LD block out of a raw HTML string.
 * Returns a normalized { title, company, location, workType, salary } object
 * or null if no parseable JobPosting is present. All values are entity-decoded
 * and have been stripped of common noise patterns (e.g. Workday's internal
 * numeric company-code prefix).
 */
function parseJobPostingLD(html) {
  if (!html) return null;
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const block of blocks) {
    try {
      const raw = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
      const data = JSON.parse(raw);
      // Can be: single object, array of objects, or @graph wrapper
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      const job = items.find(d => d && d['@type'] === 'JobPosting');
      if (!job || !job.title) continue;

      // Company: Workday embeds internal prefixes like "001 Manufacturers and
      // Traders Trust Co" or "005 Robert Half Inc." — strip the leading
      // digits/space before displaying. Generic cleanup, not workday-specific.
      const rawCompany = job.hiringOrganization?.name || null;
      const company = rawCompany
        ? (decodeEntities(rawCompany).replace(/^\d+\s+/, '').trim() || null)
        : null;

      // Location: addressLocality + addressRegion is the most reliable.
      // Some sites omit region but populate only locality.
      const addr = job.jobLocation?.address || (job.jobLocation?.[0]?.address) || null;
      const locStr = addr
        ? [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ') || null
        : null;

      // baseSalary.value → formatted $Nk / $Nk-$Nk. Employers emit this as
      // a MonetaryAmount: { minValue, maxValue, unitText } or { value }.
      let salary = null;
      const bs = job.baseSalary?.value;
      if (bs && typeof bs === 'object') {
        const min = Number(bs.minValue ?? bs.value);
        const max = Number(bs.maxValue ?? bs.value);
        if (!isNaN(min) && !isNaN(max) && min > 0) {
          const fmt = n => n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString();
          salary = min === max ? fmt(min) : fmt(min) + '\u2013' + fmt(max);
        }
      }

      // jobLocationType === 'TELECOMMUTE' is the schema.org flag for remote.
      return {
        title:    decodeEntities(job.title).trim() || null,
        company:  company,
        location: locStr ? decodeEntities(locStr).trim() : null,
        workType: job.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null,
        salary:   salary,
      };
    } catch {}
  }
  return null;
}

/**
 * Strip Jina's markdown output down to clean prose for downstream AI
 * extraction. Extracted into its own function so the cleanup is reusable
 * and testable.
 */
function cleanJinaMarkdown(raw) {
  return raw
    .replace(/^(Title|URL Source|URL|Published Time|Markdown Content|Description):[^\n]*\n/gim, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\[[^\]]+\]:\s*\S.*$/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/^(\s*)\d+\.\s+/gm, '$1')
    .replace(/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/gm, '')
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<!\w)[*_]([^*_\n]+?)[*_](?!\w)/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/**
 * Fetch a job posting's content from any ATS. Tries three paths, harvesting
 * whatever each produces and merging:
 *
 *   1. Direct fetch (fast, ~2-3s):
 *      Grabs raw HTML. Harvests JSON-LD (JobPosting structured data) which
 *      most ATS platforms embed for SEO even on SPA pages. Also gets the
 *      stripped text — usable for SSR sites, a shell for SPAs.
 *
 *   2. Jina reader (slow, ~3-18s):
 *      Server-side renders the page and returns visible text as markdown.
 *      Needed for SPAs where direct-fetch text is just a skeleton. Does
 *      NOT see JSON-LD (markdown format), so we always merge any JSON-LD
 *      we harvested from step 1.
 *
 *   3. Slug fallback:
 *      Guesses title/company from the URL path when neither fetch produced
 *      usable content. Deliberately conservative — leaves fields null
 *      rather than inventing garbage from UUID path segments.
 *
 * Fast path: if step 1 returns complete JSON-LD + substantive text, skip
 * Jina entirely. Saves a Jina call on SSR sites (Greenhouse, iCIMS, etc.).
 */
async function fetchATS(rawUrl) {
  const url = cleanJobUrl(rawUrl);

  // ── Step 1: direct fetch ────────────────────────────────────────────────
  // Fast (~2-3s typically) and often carries JSON-LD even on SPA sites that
  // can't be read as plain text. We always do this first so JSON-LD is
  // available to merge with whatever Jina produces.
  let direct = null;
  try {
    const r = await fetchTimeout(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.google.com/',
      }
    }, 10000);
    if (r.ok) {
      const html = await r.text();
      const text = htmlToText(html);
      const ldFields = parseJobPostingLD(html);
      direct = { html, text, ldFields };
    }
  } catch {}

  // ── Early exit: JSON-LD + substantive text means we don't need Jina ────
  // "Substantive" = >500 chars of text. Avoids early-exiting on SPA shells
  // that happen to embed JSON-LD but have no body content yet.
  if (direct && direct.ldFields?.title && direct.ldFields?.company && direct.text.length > 500) {
    const salary = direct.ldFields.salary
      || extractSalaryFromText(direct.text)
      || extractSalaryFromHtml(direct.html)
      || null;
    const fields = { ...direct.ldFields, salary };
    return {
      fields,
      text: direct.text,
      html: direct.html.slice(0, 200000),
      salary,
      _via: 'fetch-ld',
    };
  }

  // ── Step 1.5: Chromium render for known SPA hosts ───────────────────────
  // For Ashby, Workable, Workday, BambooHR, Apple — direct-fetch returns
  // an empty shell and Jina strips <script> tags. Render the page in our
  // own Chromium to get the post-hydration DOM with JSON-LD intact.
  //
  // Only runs for hosts in SPA_HOSTS to avoid the Chromium memory overhead
  // on SSR sites that don't need it. Falls through to Jina if rendering
  // fails (browser not launched, timeout, circuit-breaker open, etc.).
  if (isSpaHost(url)) {
    const rendered = await renderPage(url);
    if (rendered && rendered.text.length > 200) {
      const ldFields = parseJobPostingLD(rendered.html);
      const salary = (ldFields && ldFields.salary)
        || extractSalaryFromText(rendered.text)
        || extractSalaryFromHtml(rendered.html)
        || null;
      const fields = ldFields ? { ...ldFields, salary } : null;
      return {
        fields,
        text: rendered.text,
        html: rendered.html.slice(0, 200000),
        salary,
        _via: fields ? 'render+ld' : 'render',
      };
    }
    // If render failed or returned nothing useful, continue to Jina + slug —
    // no regression vs pre-v1.16 behavior.
  }

  // ── Step 2: Jina ─────────────────────────────────────────────────────────
  // Renders JS. Needed for SPAs. Asks for markdown text (not HTML) because:
  //   1. Jina strips <script> tags from HTML responses regardless of format,
  //      so X-Return-Format:'html' doesn't actually give us SPA JSON-LD.
  //      (v1.15 tried this — didn't work, reverted in v1.15.1.)
  //   2. Markdown responses are smaller and process faster.
  //
  // Single attempt. A retry loop sounds defensive but two 18s attempts plus
  // a 1s pause blew past the audit script's 30s per-URL timeout in v1.15,
  // causing 90% of URLs to fail. If Jina is rate-limited we fall through to
  // direct-fetch (step 3) or slug fallback (step 4) instead.
  let jina = null;
  try {
    const r = await fetchTimeout('https://r.jina.ai/' + url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/plain,*/*',
        'X-Return-Format': 'text',
      }
    }, 18000);
    if (r.ok) {
      const raw = await r.text();
      const text = cleanJinaMarkdown(raw);
      if (text.length > 200) jina = { text };
    }
  } catch {}

  if (jina) {
    // Merge with any JSON-LD direct-fetch harvested in step 1. Direct-fetch
    // JSON-LD works for SSR sites (Greenhouse, iCIMS) and for SPAs that
    // pre-render JSON-LD in their shell HTML (many do for SEO).
    const mergedLd = (direct && direct.ldFields) || null;
    const salary = (mergedLd && mergedLd.salary)
      || extractSalaryFromText(jina.text)
      || null;
    const fields = mergedLd ? { ...mergedLd, salary } : null;
    return {
      fields,
      text: jina.text,
      html: '',
      salary,
      _via: fields ? 'jina+ld' : 'jina',
    };
  }

  // ── Step 3: use direct-fetch result if we have one ──────────────────────
  // Happens on SSR sites where direct-fetch returned usable text but Jina
  // failed. Still usable.
  if (direct && direct.text.length > 200) {
    const salary = (direct.ldFields && direct.ldFields.salary)
      || extractSalaryFromText(direct.text)
      || extractSalaryFromHtml(direct.html)
      || null;
    const fields = direct.ldFields
      ? { ...direct.ldFields, salary }
      : null;
    return {
      fields,
      text: direct.text,
      html: direct.html.slice(0, 200000),
      salary,
      _via: fields ? 'fetch+ld' : 'fetch',
    };
  }

  // ── Step 4: slug fallback ────────────────────────────────────────────────
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

// Extract a salary range or single annualized/hourly salary from free text.
// Intentionally general — handles variations across every posting we've seen,
// with zero site-specific branching.
//
// Patterns covered:
//   $120,000 - $150,000           (comma, hyphen)
//   $120,000.00 – $150,000.00     (en-dash, trailing decimals)
//   $120k – $150k                 (K-suffix)
//   $120,000 to $150,000          (spelled-out "to")
//   £80,000 - £120,000            (GBP)
//   €80,000 - €120,000            (EUR)
//   $124,700 USD Annual           (single, with period hint)
//   $60/hour                      (hourly single)
//   Salary Range $120k - $150k    (label-prefixed — regex doesn't care)
//
// Returns a normalized string like "$120k–$150k" (using en-dash).
function extractSalaryFromText(text) {
  if (!text) return null;
  // Accept $, £, € as currency symbols. ISO codes (USD/GBP/EUR/CAD) can
  // appear after the numbers — still fine, we anchor on the symbol.
  const CUR = '[$£€]';
  const NUM = '\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
  const KSFX = '\\s*[kK]?';
  // Separator: hyphen, en-dash, em-dash, or " to " (spaces matter for "to"
  // to avoid matching a random "to" inside prose).
  const JOIN = '\\s*(?:[-\\u2013\\u2014]|\\bto\\b)\\s*';

  // Range pattern — single currency symbol on first number; optional on second
  // (common: "$120k - 150k" without $ on second half).
  const rangeRe = new RegExp(
    `(${CUR})\\s*(${NUM})${KSFX}${JOIN}(?:${CUR})?\\s*(${NUM})${KSFX}`,
    'g'
  );

  // Walk all matches — many postings mention incidental dollar figures
  // (e.g. "1000+ customers", "$100 gift card"). A salary range has TWO
  // numbers both >= 30 (treating k-notation) and the larger should be
  // within 3× of the smaller. This filters out false positives like
  // "$1M ARR to $10M ARR" (revenue ranges) or $50-$500 (product prices).
  let best = null;
  let m;
  while ((m = rangeRe.exec(text)) !== null) {
    const sym = m[1];
    const raw1 = m[2], raw2 = m[3];
    const hasK = /k/i.test(m[0]);
    const n1 = parseFloat(raw1.replace(/,/g, '')) * (hasK && parseFloat(raw1.replace(/,/g, '')) < 1000 ? 1000 : 1);
    const n2 = parseFloat(raw2.replace(/,/g, '')) * (hasK && parseFloat(raw2.replace(/,/g, '')) < 1000 ? 1000 : 1);
    // Sanity filters. Hourly salary floors are ~$15; annual ~$20k.
    const lo = Math.min(n1, n2), hi = Math.max(n1, n2);
    if (lo < 15) continue;                    // rules out "1-10 years"
    if (hi / lo > 5) continue;                // rules out out-of-band ranges
    if (hi < 25 && lo < 25) {
      // Looks like an hourly range (both under $25) — OK if the surrounding
      // text has an hourly hint; otherwise skip to avoid grabbing "5-10" etc.
      const ctx = text.slice(Math.max(0, m.index - 40), Math.min(text.length, m.index + m[0].length + 40));
      if (!/hour|hr\b|hourly/i.test(ctx)) continue;
    }
    const fmt = (n) => n >= 1000 ? sym + Math.round(n/1000) + 'k' : sym + Math.round(n).toLocaleString();
    // Prefer the FIRST credible match (salary labels typically come before
    // the body) — return immediately rather than iterating.
    best = fmt(Math.min(n1, n2)) + '\u2013' + fmt(Math.max(n1, n2));
    return best;
  }

  // Single salary with explicit period — "$150,000 per year", "$60/hour"
  const singleRe = new RegExp(
    `(${CUR})\\s*(${NUM})${KSFX}\\s*(?:USD|CAD|GBP|EUR)?\\s*(annually|per\\s*year|/\\s*year|/\\s*yr|yearly|annual|hourly|per\\s*hour|/\\s*hour|/\\s*hr)`,
    'i'
  );
  const sm = text.match(singleRe);
  if (sm) {
    const sym = sm[1];
    const hasK = /k/i.test(sm[0]);
    const n = parseFloat(sm[2].replace(/,/g, '')) * (hasK && parseFloat(sm[2].replace(/,/g, '')) < 1000 ? 1000 : 1);
    if (n < 15) return null;
    return n >= 1000 ? sym + Math.round(n/1000) + 'k' : sym + Math.round(n).toLocaleString();
  }

  return null;
}

function extractSalaryFromHtml(html) {
  const m = html.match(/<bdi>\s*\$([\d,]+(?:\.\d+)?)\s*<\/bdi>\s*-\s*<bdi>\s*\$([\d,]+(?:\.\d+)?)\s*<\/bdi>/i);
  if (!m) return null;
  const fmt = s => { const n = parseFloat(s.replace(/,/g,'')); return n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n).toLocaleString(); };
  return fmt(m[1]) + '\u2013' + fmt(m[2]);
}

// parse-job is pure network I/O (direct-fetch + Jina + slug). It never
// invokes AI, so it should not count against the daily token cap. A cap hit
// on /api/extract-fields should still 429 that endpoint (the AI one), but
// parse-job returning slug fallbacks is always preferable to 429-ing the
// whole extraction pipeline and hiding genuine deployment state.
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
async function verifyMirrorMatch({ claimedTitle, claimedCompany, claimedLocation, candidateText }, req = null) {
  const sys = 'You verify whether two job postings describe the same role. Return ONLY valid compact JSON.';
  const usr = `Claimed: title="${claimedTitle}", company="${claimedCompany}"${claimedLocation ? `, location="${claimedLocation}"` : ''}.

Candidate posting (first 1500 chars):
${(candidateText || '').slice(0, 1500)}

Do these describe the SAME job? Return {"match": true|false, "confidence": 0.0-1.0, "reason": "brief"}.
- Company must match exactly (same employer).
- Title must be equivalent (minor wording differences OK; different seniority or function = NOT a match).
- Location should be compatible if both specified.`;
  try {
    const raw = await callAI(['groq','google','openrouter'], sys, usr, 150, req, 'verify-mirror');
    return parseJson(raw);
  } catch { return { match: false, confidence: 0, reason: 'verify-failed' }; }
}

app.post('/api/find-posting-mirror', authMiddleware, tokenCapMiddleware, async (req, res) => {
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
    }, req);
    if (verdict?.match && (verdict.confidence ?? 0) >= 0.7) {
      return res.json({ ok: true, mirrorUrl: c.url, via: c.label, confidence: verdict.confidence });
    }
  }
  res.json({ ok: false, reason: 'no-verified-match' });
});

app.post('/api/extract-fields', authMiddleware, tokenCapMiddleware, async (req, res) => {
  const postingText = req.body.postingText || req.body.text || '';
  const tailText    = req.body.tailText || '';
  // domSalary: precise salary pre-extracted by the client (from JSON-LD, <bdi>
  // tags, or a regex pass on the untruncated fetchATS text). Always trusted
  // over AI guesses — AI tends to hallucinate round numbers.
  let domSalary = req.body.salary || null;
  if (!postingText) return res.status(400).json({ error: 'postingText required' });

  // Belt-and-suspenders: re-scan the text we have for a salary range using the
  // same extractor fetchATS uses. Most postings leak the salary in a "Salary
  // Range Information $X – $Y" footer that sits AFTER the main job description
  // — so we also scan the tail slice if provided. Cheaper + more reliable than
  // the AI for literal numeric extraction.
  if (!domSalary) {
    domSalary = extractSalaryFromText(postingText) || extractSalaryFromText(tailText) || null;
  }

  const salaryHint = domSalary ? `The salary is already confirmed as ${domSalary} — use this exactly.` : '';
  const sys = `Extract job posting details. Return ONLY valid JSON, no markdown.
Fields: title(string), company(string), location(city+state only, null if remote-only), workType("Remote"|"Hybrid"|"On-site"|null), remote(boolean), salary(ONLY real dollar amounts like "$120k–$150k" or null — never invent, never use "Competitive" or "DOE"). ${salaryHint}`;
  // If we have tail text, include it in the AI input — compensation/pay-range
  // blocks commonly appear below the main description and would otherwise be
  // truncated out of the slice.
  const payload = tailText
    ? `${postingText.slice(0, 3000)}\n\n[...]\n\n${tailText.slice(0, 1500)}`
    : postingText.slice(0, 4000);
  const usr = `Extract from this job posting:\n\n${payload}`;
  try {
    const parsed = parseJson(await callAI(['groq','openrouter','google'], sys, usr, 400, req, 'extract-fields'));
    // Always prefer DOM-extracted salary over AI-guessed salary
    if (domSalary) parsed.salary = domSalary;
    res.json(parsed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Parse a pasted email signature / contact block into structured fields.
// Handles formats ranging from traditional "name / title / company / email /
// phone" signatures to informal LinkedIn bios and intro-email openers.
// Returns null values for anything the text doesn't contain — we never
// fabricate. The frontend presents results in an editable form for the user
// to correct before saving.
app.post('/api/parse-contact-signature', authMiddleware, tokenCapMiddleware, async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 4000) return res.status(400).json({ error: 'text too long (max 4000 chars)' });

  const sys = `You extract contact information from email signatures, LinkedIn bios, or similar text blocks.
Return ONLY valid JSON (no markdown fences, no commentary).
Fields (use null for anything not present — NEVER guess or infer):
- name (string): person's full name
- role (string): job title like "Senior Recruiter" or "Head of Engineering"
- company (string): employer name
- email (string): email address — exactly as written, no cleanup
- phoneCell (string): cell/mobile/direct phone number — exactly as written. Look for labels like "cell:", "mobile:", "m:", "direct:", "c:".
- phoneOffice (string): office/work phone number — exactly as written. Look for labels like "office:", "work:", "w:", "tel:", "o:".
- linkedin (string): full LinkedIn profile URL. If you see only "linkedin.com/in/xxx" without https://, prepend "https://"
- location (string): city or city+state like "San Francisco, CA" — null for country-only or generic

Phone parsing rules:
- If a signature has only ONE phone with no label (just digits or a generic "phone:"), put it in phoneCell and leave phoneOffice null.
- If you see two phones and one is clearly labeled cell/mobile, use that labeling. Uncertain → prefer phoneCell.
- If a phone is labeled "fax" ignore it entirely (fax is not a useful contact channel).

Hard rules: do not fabricate. If a field isn't clearly in the text, return null for it. Don't combine unrelated text into a field.`;

  const usr = `Parse this signature:\n\n${text}`;

  try {
    const raw = await callAI(['groq','openrouter','google'], sys, usr, 300, req, 'parse-contact-signature');
    const parsed = parseJson(raw);
    // Sanity-filter: the AI sometimes emits empty strings instead of nulls
    for (const k of Object.keys(parsed)) {
      if (parsed[k] === '' || parsed[k] === 'null' || parsed[k] === 'N/A') parsed[k] = null;
    }
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// AI FEATURES
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/tailor', authMiddleware, tokenCapMiddleware, async (req, res) => {
  const { company, title, location, salary, postingText, content, docType, context } = req.body;
  if (!content || !docType) return res.status(400).json({ error: 'content and docType required' });
  const label = docType === 'resume' ? 'RESUME' : 'COVER LETTER';
  const sys = 'You are a professional career coach. Return ONLY the tailored document as clean HTML using <h1>,<h2>,<h3>,<p>,<strong>,<ul>,<li>. Preserve all section structure. No preamble, no labels, no backticks.';
  const usr = `Tailor this ${label} for the role. Return only clean HTML.\n\nCompany: ${company}\nRole: ${title}\n${location?`Location: ${location}`:''}${salary?`\nSalary: ${salary}`:''}${context?`\nNotes: ${context}`:''}${postingText?`\n\nJob posting:\n${postingText.slice(0,3000)}`:''}\n\n${label} TO TAILOR:\n${content}`;
  try {
    const result = await callAI(['groq','openrouter','google'], sys, usr, 3000, req, 'tailor');
    res.json({ result: result.trim(), docType });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tailor-docx', authMiddleware, tokenCapMiddleware, async (req, res) => {
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
    const tailored = await callAI(['groq','openrouter','google'], sys, usr, 3000, req, 'tailor-docx');
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

app.post('/api/insights', authMiddleware, tokenCapMiddleware, async (req, res) => {
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
  // Fetch Wikipedia first so we can pass the extract to the AI as grounding
  // context AND hand its QID to Wikidata to skip one round trip.
  const wiki = await fetchWikipediaSummary(company);
  const wikiContext = wiki?.extract ? `Wikipedia excerpt about ${company}:\n"""${wiki.extract.slice(0, 1200)}"""\n\n` : '';
  // Schema trimmed aggressively. AI is now responsible ONLY for the fields
  // that genuinely need synthesis (workforce, culture, roleIntel, flags).
  // Everything else comes from public structured sources:
  //   - companyOverview → Wikipedia (fetchWikipediaSummary)
  //   - overview.founded/hq/industry/employees → Wikidata (fetchWikidataOverview)
  //   - stock → Finnhub
  //   - news → Finnhub company-news or Google News RSS
  // If Wikipedia doesn't have an extract for the company (common for startups
  // and small firms), we ALSO ask AI for a company overview + overview facts
  // in a secondary field. Flagged with companyOverviewSource: 'ai' so the UI
  // can label it.
  const needAiCompanyFallback = !wiki?.extract || wiki.extract.length < 150;
  const companyFallbackSchema = needAiCompanyFallback ? `
"companyFallback":{"overview":"2-paragraph description","founded":"YYYY or null","hq":"City, Country or null","industry":"industry or null","employees":"range like '50-200' or null"},` : '';
  const usr = `${wikiContext}Research ${company} (${title} role). Return ONLY valid compact JSON.
${postingText?'Job posting context: '+postingText.slice(0,600):''}
${needAiCompanyFallback ? `\nNOTE: Wikipedia has no good article for this company — use your own knowledge + the job posting to fill "companyFallback". If you don't know, use null.` : ''}

{"workforce":{"headcount":"N,NNN","headcountTrend":"growing","avgTenure":"2.5 years","remoteRatio":40,"recentLayoffs":"None","visaSponsorship":"yes","visaNote":"H-1B support","topLocations":["City, ST","Remote"],"note":"Estimated from public data."},
"culture":{"overallRating":3.8,"workLifeBalance":3.5,"careerOpp":3.6,"leadership":3.5,"numRatings":"1,234","ceoApproval":72,"recommend":68,"summary":"Culture summary paragraph"},
"roleIntel":"2-3 paragraphs about this role and team",
${companyFallbackSchema}"flags":{"green":["positive signal"],"red":["concern to watch"]}}`
  try {
    const ticker = stock && !stock.error ? stock.ticker : null;
    const [raw, news, wikidataOverview] = await Promise.all([
      callAI(['groq','openrouter','google'], sys, usr, 2000, req, 'insights'),
      fetchCompanyNews(company, ticker, finnhubKey),
      fetchWikidataOverview(company, wiki?.qid || null),
    ]);
    const data = parseJson(raw);
    // Merge Wikipedia + Wikidata + AI fallback into a single picture.
    // Priority: Wikipedia prose > AI overview. Wikidata facts > AI facts.
    let companyOverview = wiki?.extract || '';
    let overview = wikidataOverview;
    let companyOverviewSource = 'wikipedia';
    if (!companyOverview && data.companyFallback?.overview) {
      companyOverview = data.companyFallback.overview;
      companyOverviewSource = 'ai';
    }
    if (!overview && data.companyFallback) {
      const fb = data.companyFallback;
      const aiFacts = {
        founded:   fb.founded && fb.founded !== 'null' ? String(fb.founded) : '',
        hq:        fb.hq && fb.hq !== 'null' ? fb.hq : '',
        industry:  fb.industry && fb.industry !== 'null' ? fb.industry : '',
        employees: fb.employees && fb.employees !== 'null' ? fb.employees : '',
      };
      if (aiFacts.founded || aiFacts.hq || aiFacts.industry || aiFacts.employees) {
        overview = aiFacts;
      }
    }
    // Strip the fallback from the data payload — it's merged, shouldn't leak
    delete data.companyFallback;
    res.json({
      ...data,
      overview:               overview || null,
      companyOverview,
      companyOverviewSource,                          // 'wikipedia' | 'ai' — UI labels AI-sourced content
      wikipediaUrl:           wiki?.url || '',
      news,
      stock,
      generatedAt:            Date.now(),
      dynamicUpdatedAt:       Date.now(),             // news + stock freshness — same ts on initial research
    });
  } catch (e) {
    console.error('insights:', e.message);
    // 429 on all providers — surface a specific error the UI can recognize
    const allRateLimited = /All AI failed:/.test(e.message) && !/^(?!.*429)/.test(e.message)
                         && (e.message.match(/429/g) || []).length >= 2;
    if (allRateLimited) {
      return res.status(429).json({
        error: 'rate_limited',
        detail: 'All AI providers are currently rate-limited. Please wait a minute and try again.',
        raw: e.message,
      });
    }
    res.status(500).json({ error: e.message });
  }
});

// Dynamic-only refresh: re-fetches news + stock without running AI.
// Purpose: keep fast-changing signals fresh without spending AI tokens. UI
// calls this on tab open if last refresh is >30 min old, and on explicit
// "Refresh prices & news" button click. NO tokenCapMiddleware since no AI.
app.post('/api/insights/refresh-dynamic', authMiddleware, async (req, res) => {
  const { company, ticker: providedTicker, finnhubKey } = req.body;
  if (!company) return res.status(400).json({ error: 'company required' });

  let stock = null;
  let ticker = providedTicker || null;
  if (finnhubKey) {
    try {
      // If we don't have a ticker from the prior research, resolve one now.
      // (This makes the endpoint self-sufficient — can be called even if
      //  the stored insights didn't persist a ticker for some reason.)
      if (!ticker) {
        const sr = await fetchTimeout(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(company)}&token=${finnhubKey}`);
        if (sr.ok) {
          const sd = await sr.json();
          const match = (sd.result||[]).find(r => r.type==='Common Stock' && !r.symbol.includes('.'));
          if (match) ticker = match.symbol;
        }
      }
      if (ticker) {
        const [qr,pr] = await Promise.allSettled([
          fetchTimeout(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`),
          fetchTimeout(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubKey}`),
        ]);
        const q = qr.status==='fulfilled'&&qr.value.ok ? await qr.value.json() : {};
        const p = pr.status==='fulfilled'&&pr.value.ok ? await pr.value.json() : {};
        stock = { ticker, price: q.c, change: q.d, changePct: q.dp,
                  marketCap: p.marketCapitalization ? p.marketCapitalization*1e6 : null };
      } else {
        stock = { error: 'No public ticker found' };
      }
    } catch (e) {
      stock = { error: e.message };
    }
  }

  // News is free (Finnhub if ticker+key, Google News RSS otherwise)
  let news = [];
  try { news = await fetchCompanyNews(company, ticker, finnhubKey); }
  catch (e) { console.warn('refresh-dynamic news fail:', e.message); }

  res.json({ stock, news, dynamicUpdatedAt: Date.now() });
});

app.post('/api/outreach-targets', authMiddleware, tokenCapMiddleware, async (req, res) => {
  const { company, title } = req.body;
  try {
    const raw = await callAI(['groq','openrouter','google'],
      'Return valid JSON only, no markdown.',
      `Suggest 3 LinkedIn contacts to reach out to when applying for ${title} at ${company}. Return: {"contacts":[{"title":"...","reason":"...","searchTip":"..."}]}`,
      500, req, 'outreach-targets');
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/interview-questions', authMiddleware, tokenCapMiddleware, async (req, res) => {
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
      1500, req, 'interview-questions');
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/keyword-gap', authMiddleware, tokenCapMiddleware, async (req, res) => {
  const { resumeText, postingText } = req.body;
  try {
    const raw = await callAI(['groq','openrouter','google'],
      'Return valid JSON only, no markdown.',
      `Find keyword gaps between this resume and job posting.\nPosting: ${(postingText||'').slice(0,2000)}\nResume: ${(resumeText||'').slice(0,2000)}\nReturn: {"matched":["keyword"],"missing":["keyword"],"score":75,"suggestions":["add X to Y"]}`,
      800, req, 'keyword-gap');
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/email-template', authMiddleware, tokenCapMiddleware, async (req, res) => {
  const { company, title, type, context } = req.body;
  try {
    const raw = await callAI(['groq','openrouter','google'],
      'Return valid JSON only, no markdown.',
      `Write a ${type||'follow-up'} email for ${title} at ${company}. ${context||''}\nReturn: {"subject":"...","body":"..."}`,
      500, req, 'email-template');
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/salary-benchmark', authMiddleware, tokenCapMiddleware, async (req, res) => {
  const { title, location, company } = req.body;
  try {
    const raw = await callAI(['groq','openrouter','google'],
      'Return valid JSON only, no markdown.',
      `Salary benchmarks for ${title} in ${location||'United States'}${company?` at ${company}`:''}.\nReturn: {"low":120000,"median":150000,"high":180000,"currency":"USD","notes":"..."}`,
      300, req, 'salary-benchmark');
    res.json(parseJson(raw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Token usage endpoints ───────────────────────────────────────────────────

// User's own usage: last 30 days, pre-aggregated from their daily cache.
// Returns enough for the settings-pane card (totals + provider + endpoint breakdowns).
app.get('/api/user-usage', authMiddleware, (req, res) => {
  const user = req.user.username;
  const usage = loadUserUsage(user);
  // Collect last 30 days in order
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ day: d, data: usage[d] || { total: 0, byProvider: {}, byEndpoint: {} } });
  }
  const today = usage[todayKey()] || { total: 0, byProvider: {}, byEndpoint: {} };
  // Last 7 days aggregated
  const week = { total: 0, byProvider: {}, byEndpoint: {} };
  for (const d of days.slice(-7)) {
    week.total += d.data.total;
    for (const [k, v] of Object.entries(d.data.byProvider || {})) week.byProvider[k] = (week.byProvider[k] || 0) + v;
    for (const [k, v] of Object.entries(d.data.byEndpoint || {})) week.byEndpoint[k] = (week.byEndpoint[k] || 0) + v;
  }
  // Last 30 days aggregated
  const month = { total: 0, byProvider: {}, byEndpoint: {} };
  for (const d of days) {
    month.total += d.data.total;
    for (const [k, v] of Object.entries(d.data.byProvider || {})) month.byProvider[k] = (month.byProvider[k] || 0) + v;
    for (const [k, v] of Object.entries(d.data.byEndpoint || {})) month.byEndpoint[k] = (month.byEndpoint[k] || 0) + v;
  }
  res.json({
    today, week, month, days,
    cap: DAILY_TOKEN_CAP,
    pct: DAILY_TOKEN_CAP ? Math.round((today.total / DAILY_TOKEN_CAP) * 1000) / 10 : 0,
  });
});

// Admin usage: aggregate across all users. Reads the NDJSON month logs so we
// can produce per-user and per-endpoint breakdowns.
app.get('/api/admin/usage', adminMiddleware, (req, res) => {
  const days = parseInt(req.query.days || '30', 10);
  const cutoff = Date.now() - days * 86400000;
  // Collect the relevant month log files (current + potentially previous)
  let lines = [];
  try {
    const files = fs.readdirSync(USAGE_DIR).filter(f => f.endsWith('.log'));
    // Sort descending (newest month first) and read last 2 months' worth
    files.sort().reverse();
    for (const f of files.slice(0, 3)) {
      const content = fs.readFileSync(path.join(USAGE_DIR, f), 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try { lines.push(JSON.parse(line)); } catch {}
      }
    }
  } catch (e) { console.warn('admin usage read fail:', e.message); }
  lines = lines.filter(e => e.ts >= cutoff);

  // Aggregate
  const byDay      = {};
  const byUser     = {};
  const byProvider = {};
  const byEndpoint = {};
  let totalTokens = 0;
  for (const e of lines) {
    const total = (e.prompt || 0) + (e.completion || 0);
    totalTokens += total;
    byDay[e.day]          = (byDay[e.day] || 0) + total;
    byUser[e.user]        = (byUser[e.user] || 0) + total;
    byProvider[e.provider] = (byProvider[e.provider] || 0) + total;
    byEndpoint[e.endpoint] = (byEndpoint[e.endpoint] || 0) + total;
  }
  // Top 10 users by tokens
  const topUsers = Object.entries(byUser)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([user, total]) => ({ user, total }));

  // Produce ordered day series for charting (oldest → newest)
  const daySeries = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daySeries.push({ day: d, total: byDay[d] || 0 });
  }

  res.json({
    days, totalTokens, callCount: lines.length,
    byProvider, byEndpoint, topUsers, daySeries,
    cap: DAILY_TOKEN_CAP,
  });
});

app.get('/api/ai-status', authMiddleware, async (req, res) => {
  // Active probe: hit each provider with a tiny request, report model + error.
  // Helpful for diagnosing insights failures without tailing Render logs.
  const probe = async (name, fn, model) => {
    if (!model) return { key: false, ok: false, model: null };
    const t0 = Date.now();
    try {
      await fn('You are a test.', 'Say "ok" and nothing else.', 20);
      return { key: true, ok: true, model, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { key: true, ok: false, model, error: e.message.slice(0, 200), latencyMs: Date.now() - t0 };
    }
  };
  const [groq, openrouter, google] = await Promise.all([
    GROQ_API_KEY       ? probe('groq',       callGroq,       GROQ_MODEL)       : { key: false, ok: false, model: GROQ_MODEL },
    OPENROUTER_API_KEY ? probe('openrouter', callOpenRouter, OPENROUTER_MODEL) : { key: false, ok: false, model: OPENROUTER_MODEL },
    GOOGLE_API_KEY     ? probe('google',     callGoogle,     GOOGLE_MODEL)     : { key: false, ok: false, model: GOOGLE_MODEL },
  ]);
  const anyOk = groq.ok || openrouter.ok || google.ok;
  res.json({ anyOk, groq, openrouter, google });
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
    id,
    username:  u.username,
    email:     u.email || '',
    createdAt: u.createdAt,
    lastLogin: u.lastLogin || null,
    active:    u.active !== false,
    encrypted: u.encrypted === true,
    recoveryCodes: u.encrypted ? (u.recoveryKeySlots || []).filter(s => !s.used).length : null,
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

  // Shut down Chromium cleanly on Render's redeploy signal — otherwise the
  // browser process lingers and eats memory across restarts.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      console.log(`[shutdown] ${sig} received, closing browser…`);
      await shutdownBrowser();
      process.exit(0);
    });
  }
}

module.exports = app;
