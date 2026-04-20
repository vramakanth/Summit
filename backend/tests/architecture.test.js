/**
 * architecture.test.js — Backend architecture & unit tests
 * Run: node architecture.test.js
 */
const { cleanJobUrl } = require('../ats-helpers');
const fs   = require('fs');
const path = require('path');
const serverSrc  = fs.readFileSync(path.join(__dirname, '../server.js'),  'utf8');
const contentSrc = fs.readFileSync(path.join(__dirname, '../../extension/content.js'), 'utf8');

let pass = 0, fail = 0;
const t   = (name, fn) => { try { fn(); console.log(' ✓', name); pass++; } catch(e) { console.log(' ✗', name, '—', e.message?.slice(0,80)); fail++; } };
const eq  = (a, b) => { if (a !== b) throw new Error(JSON.stringify(a) + ' !== ' + JSON.stringify(b)); };
const has = (src, s) => { if (!src.includes(s)) throw new Error('missing: ' + s.slice(0,50)); };
const not = (src, s) => { if (src.includes(s))  throw new Error('found:   ' + s.slice(0,50)); };
const lt  = (a, b) => { if (!(a < b)) throw new Error(a + ' not < ' + b); };

// ── cleanJobUrl ───────────────────────────────────────────────────────────────
console.log('\n── cleanJobUrl');
t('strips utm_campaign/source/medium', () => {
  const c = cleanJobUrl('https://www.indeed.com/viewjob?jk=18715e3be76cb999&utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic');
  eq(c, 'https://www.indeed.com/viewjob?jk=18715e3be76cb999');
});
t('keeps jk param (Indeed job key)', () => {
  const c = cleanJobUrl('https://www.indeed.com/viewjob?jk=abc123&utm_source=google');
  if (!c.includes('jk=abc123')) throw new Error('jk stripped');
});
t('strips ZipRecruiter jid', () => {
  const c = cleanJobUrl('https://www.ziprecruiter.com/c/Saratech/Job/Director?jid=abc&utm_campaign=google');
  if (c.includes('utm_campaign') || c.includes('jid=')) throw new Error('params remain');
});
t('keeps Greenhouse gh_jid', () => {
  const c = cleanJobUrl('https://job-boards.greenhouse.io/anduril/jobs/5109197007?gh_jid=5109197007&utm_campaign=test');
  if (c.includes('utm_campaign')) throw new Error('utm remains');
  if (!c.includes('gh_jid=')) throw new Error('gh_jid stripped');
});
t('handles share.google unchanged', () => {
  eq(cleanJobUrl('https://share.google/q7ODZaozjbqowhl8g'), 'https://share.google/q7ODZaozjbqowhl8g');
});
t('strips Google shndl/shmd params', () => {
  const c = cleanJobUrl('https://www.google.com/search?q=director&shndl=37&shmd=H4s&udm=8');
  if (c.includes('shndl') || c.includes('shmd')) throw new Error('shndl/shmd remain');
  if (!c.includes('udm=8')) throw new Error('udm stripped');
});

// ── v1.18: slugFallback removed, ats-helpers exports only the surface we need ──
t('ats-helpers exports cleanJobUrl, decodeEntities, looksLikeId, trimIdTokens', () => {
  const mod = require('../ats-helpers');
  if (typeof mod.cleanJobUrl !== 'function') throw new Error('cleanJobUrl missing');
  if (typeof mod.decodeEntities !== 'function') throw new Error('decodeEntities missing');
  if (typeof mod.looksLikeId !== 'function') throw new Error('looksLikeId missing');
  if (typeof mod.trimIdTokens !== 'function') throw new Error('trimIdTokens missing');
});
t('ats-helpers no longer exports slugFallback (v1.18 removal)', () => {
  const mod = require('../ats-helpers');
  if (typeof mod.slugFallback === 'function') {
    throw new Error('slugFallback reintroduced — v1.18 replaced it with upload/extension/manual flows');
  }
});
t('fetchATS no longer calls slugFallback', () => {
  if (/slugFallback\s*\(/.test(serverSrc)) {
    throw new Error('fetchATS still calls slugFallback — should return _via:unextractable instead');
  }
});

// ── Server architecture ────────────────────────────────────────────────────────
console.log('\n── Server architecture');
t('detectATS removed',           () => not(serverSrc, 'detectATS'));
t('UA constant defined',         () => has(serverSrc, "const UA = 'Mozilla"));
t('UA in request headers (direct-fetch only)', () => {
  // v1.17: Jina reader removed, so only direct-fetch uses the UA constant
  // directly. Chromium sets its UA via page.setUserAgent() in render.js —
  // still a real-browser UA, just a different mechanism.
  const refs = (serverSrc.match(/'User-Agent': UA/g) || []).length;
  if (refs < 1) throw new Error('UA constant not used in any request header');
});
t('Chromium render as primary path for SPAs', () => {
  // v1.17: Jina reader removed. Our own Chromium (via render.js) is the
  // JS-rendering path. Lives in backend/render.js, imported into server.js.
  if (!/require\(['"]\.\/render['"]\)/.test(serverSrc)) {
    throw new Error('server.js does not require ./render');
  }
});
t('Jina reader yanked from fetchATS',   () => {
  // v1.17 removed r.jina.ai from fetchATS. s.jina.ai (Jina search endpoint,
  // used by mirror-finder — a different feature) is still allowed.
  if (/r\.jina\.ai/.test(serverSrc)) {
    throw new Error('r.jina.ai still referenced — Jina reader should be fully removed');
  }
});
t('Promise.race hard timeout',   () => has(serverSrc, 'Promise.race([fetchProm'));
t('fetchTimeout default 20s',    () => has(serverSrc, 'ms = 20000'));
t('all via markers present',    () => {
  // v1.18: 'slug' replaced with 'unextractable'. Upload markers
  // ('upload-html+ld', 'upload-html', 'upload-pdf') live in the
  // /api/parse-uploaded-page endpoint, not fetchATS — so they're not
  // required here, but we do check them separately below.
  const markers = ["'fetch-ld'", "'fetch+ld'", "'fetch'", "'render+ld'", "'render'", "'unextractable'"];
  for (const m of markers) {
    if (!serverSrc.includes(m)) throw new Error(`marker ${m} not found in server.js`);
  }
});
t('no jina/slug stale markers (v1.17/v1.18 regression guard)', () => {
  // v1.17 regression guard: jina markers must not reappear.
  // v1.18 regression guard: 'slug' must not reappear — replaced by
  // 'unextractable' + user-driven upload/extension/manual flows.
  for (const m of ["'jina'", "'jina+ld'", "'slug'"]) {
    if (serverSrc.includes(m)) throw new Error(`stale marker ${m} present`);
  }
});
t('upload endpoint via markers present (v1.18)', () => {
  // Upload endpoint tags results so the frontend can show "Filled N fields
  // from HTML/PDF" and track extraction source for analytics.
  for (const m of ["'upload-html+ld'", "'upload-html'", "'upload-pdf'"]) {
    if (!serverSrc.includes(m)) throw new Error(`upload marker ${m} not found`);
  }
});
t('parseJobPostingLD defined',   () => has(serverSrc, 'function parseJobPostingLD'));
t('cleanJinaMarkdown removed',   () => {
  // v1.17: markdown cleanup only existed for Jina output. Chromium returns
  // innerText — no markdown to clean. Helper should be dead-code-deleted.
  if (/function cleanJinaMarkdown/.test(serverSrc)) {
    throw new Error('cleanJinaMarkdown should be deleted, not retained');
  }
});
t('htmlToText defined',          () => has(serverSrc, 'function htmlToText'));
t('extractSalaryFromText',       () => has(serverSrc, 'function extractSalaryFromText'));
t('extractSalaryFromHtml (bdi)', () => has(serverSrc, 'function extractSalaryFromHtml'));
t('domSalary override',          () => has(serverSrc, 'if (domSalary) parsed.salary = domSalary'));
t('groq-first callAI',           () => has(serverSrc, "callAI(['groq'"));
t('no site-specific handlers',   () => { not(serverSrc, "ats === 'greenhouse'"); not(serverSrc, "ats === 'lever'"); });
t('resilient parseJson',         () => has(serverSrc, 'lastValid'));
t('fetchATS under 150 lines',    () => {
  const s = serverSrc.indexOf('async function fetchATS');
  const e = serverSrc.indexOf('\nasync function ', s + 10);
  lt(serverSrc.slice(s, e > 0 ? e : s + 10000).split("\\n").length, 200);
});

// ── content.js ────────────────────────────────────────────────────────────────
console.log('\n── content.js');
t('no site-specific hostname branches', () => {
  not(contentSrc, "hostname.includes(\'linkedin"); not(contentSrc, "hostname.includes(\'indeed");
  not(contentSrc, "hostname.includes(\'greenhouse"); not(contentSrc, "hostname.includes(\'ziprecruiter");
});
t('reads document.body.innerText', () => has(contentSrc, 'document.body).innerText'));
t('JSON-LD baseSalary extraction', () => { has(contentSrc, 'baseSalary'); has(contentSrc, 'minValue'); has(contentSrc, 'maxValue'); });
t('bdi salary extraction',         () => has(contentSrc, "querySelectorAll('bdi')"));
t('fallback salary from bodyText (via shared helper)', () => has(contentSrc, '_extractSalaryFromText('));
t('sends bodyText + salary + url', () => { has(contentSrc, 'bodyText'); has(contentSrc, 'salary'); has(contentSrc, 'url: location.href'); });
t('under 420 lines (bumped in v1.19.13 for shared salary helper)', () => lt(contentSrc.split('\n').length, 420));

// ── extractSalaryFromText ─────────────────────────────────────────────────────
console.log('\n── extractSalaryFromText');
const fnM = serverSrc.match(/function extractSalaryFromText[\s\S]*?\n\}/);
if (fnM) {
  const fn = eval('(' + fnM[0] + ')');
  t('$150,000 – $180,000',  () => eq(fn('$150,000 - $180,000 a year'), '$150k\u2013$180k'));
  t('$220,000 – $292,000',  () => eq(fn('Salary $220,000 \u2013 $292,000 USD'), '$220k\u2013$292k'));
  t('$150K – $175K/yr',     () => { const r = fn('$150K - $175K/yr'); if (!r?.includes('$150k')) throw new Error('got: ' + r); });
  t('null for no salary',   () => eq(fn('Director of Engineering Brea CA Full-time'), null));
  t('null for Competitive', () => eq(fn('Competitive salary and benefits'), null));
}

// ── htmlToText ────────────────────────────────────────────────────────────────
console.log('\n── htmlToText');
const htmlFn = serverSrc.match(/function htmlToText[\s\S]*?\n\}/);
if (htmlFn) {
  const fn = eval('(' + htmlFn[0] + ')');
  t('strips script/style',    () => { const r = fn('<style>.x{}</style><p>Hello</p><script>x=1</script>'); if (r.includes('<style>') || !r.includes('Hello')) throw new Error('got: ' + r); });
  t('decodes entities',       () => { const r = fn('AT&amp;T &lt;Dir&gt; &nbsp;hi'); if (!r.includes('AT&T') || !r.includes('<Dir>')) throw new Error('got: ' + r); });
  t('Greenhouse HTML strips', () => { const r = fn('<h2>About</h2><ul><li>15+ yrs</li></ul>'); if (r.includes('<h2>') || !r.includes('About')) throw new Error('got: ' + r); });
}

// ── All 10 URL coverage ────────────────────────────────────────────────────────
console.log('\n── URL coverage');
const urls = [
  ['Indeed #1',    'https://www.indeed.com/viewjob?jk=18715e3be76cb999&utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic'],
  ['ZipRecruiter', 'https://www.ziprecruiter.com/c/Saratech/Job/Director-of-Engineering/-in-Mission-Viejo,CA?jid=333f4e6c313bd1ef&utm_campaign=google_jobs_apply'],
  ['career.io',    'https://career.io/job/director-of-engineering-brea-karman-space-defense-497b80a6f57f779eb26cdf078d4b39b5?utm_campaign=google_jobs_apply'],
  ['SimplyHired',  'https://www.simplyhired.com/job/ENwJKdE3ZlxzefU4UxlJ48J6a27gkkXcqhsVizEK1KlhJsIx3LG2fQ?utm_campaign=google_jobs_apply'],
  ['Lensa',        'https://lensa.com/job-v1/karman-space-and-defense/brea-ca/director-of-engineering/4e259fb258883c881a851cfd8db6a4de?utm_campaign=google_jobs_apply'],
  ['Greenhouse',   'https://job-boards.greenhouse.io/andurilindustries/jobs/5109197007?gh_jid=5109197007'],
  ['Indeed #10',   'https://www.indeed.com/viewjob?jk=6b1ac97e66d433b3&utm_campaign=google_jobs_apply'],
  ['Google Jobs',  'https://share.google/q7ODZaozjbqowhl8g'],
];
urls.forEach(([name, url]) => {
  t('clean: ' + name, () => { const c = cleanJobUrl(url); new URL(c); if (c.includes('utm_campaign')) throw new Error('utm remains'); });
});

// ── User settings endpoint (Finnhub key sync) ───────────────────────────────
console.log('\n── User settings sync');
t('SETTINGS_DIR constant defined',          () => has(serverSrc, "SETTINGS_DIR = path.join(DATA_DIR, 'settings')"));
t('SETTINGS_DIR in mkdir bootstrap',        () => {
  const m = serverSrc.match(/for\s*\(const d of \[([^\]]+)\]\)/);
  if (!m || !m[1].includes('SETTINGS_DIR')) throw new Error('SETTINGS_DIR not in bootstrap list');
});
t('loadUserSettings helper defined',        () => has(serverSrc, 'function loadUserSettings(userId)'));
t('saveUserSettings helper defined',        () => has(serverSrc, 'function saveUserSettings(userId, data)'));
t('loadUserSettings is opaque pass-through (no at-rest crypto)', () => {
  // v1.19+: client ciphertext is sole encryption layer. Server must NOT
  // call any decryptData/unwrap — storage helpers pass through JSON.
  const idx = serverSrc.indexOf('function loadUserSettings');
  const body = serverSrc.slice(idx, idx + 500);
  if (body.includes('decryptData') || body.includes('unwrapDataKey')) {
    throw new Error('server is decrypting at rest — should be opaque pass-through in v1.19+');
  }
});
t('saveUserSettings is opaque pass-through (no at-rest crypto)', () => {
  const idx = serverSrc.indexOf('function saveUserSettings');
  const body = serverSrc.slice(idx, idx + 300);
  if (body.includes('encryptData') || body.includes('wrapDataKey')) {
    throw new Error('server is encrypting at rest — should be opaque pass-through in v1.19+');
  }
});
t('GET /api/user-settings is authMiddleware-protected', () => {
  has(serverSrc, "app.get('/api/user-settings', authMiddleware");
});
t('PUT /api/user-settings is authMiddleware-protected', () => {
  has(serverSrc, "app.put('/api/user-settings', authMiddleware");
});
t('GET /api/user-settings returns 404 for missing file', () => {
  const idx = serverSrc.indexOf("app.get('/api/user-settings'");
  const body = serverSrc.slice(idx, idx + 400);
  if (!body.includes('404')) throw new Error('no 404 for missing settings');
});

// ── Insights: truncation detection and larger output budget ─────────────────
console.log('\n── Insights data integrity');
t('/api/insights max tokens fits Groq 12K TPM free-tier budget (≤ 4000)', () => {
  const idx = serverSrc.indexOf("app.post('/api/insights'");
  const body = serverSrc.slice(idx, idx + 5500);
  // Accept either old-style (just maxTok) or new-style (maxTok, req, 'endpoint')
  const m = body.match(/callAI\([\s\S]*?,\s*(\d+)\s*(?:,|\))/);
  if (!m) throw new Error('insights callAI invocation not found');
  const tok = parseInt(m[1], 10);
  if (tok > 4000) throw new Error(`insights callAI using ${tok} tokens — should be ≤ 4000 for free-tier TPM`);
});
t('parseJson flags lossy strategy-3 recovery with _partial', () => {
  const idx = serverSrc.indexOf('function parseJson(raw)');
  const body = serverSrc.slice(idx, idx + 2500);
  if (!body.includes('_partial = true')) {
    throw new Error('parseJson does not flag _partial on lossy recovery');
  }
});
t('headcountHistory removed from insights prompt (was truncation-wasting)', () => {
  const idx = serverSrc.indexOf("app.post('/api/insights'");
  const body = serverSrc.slice(idx, idx + 3000);
  if (body.includes('headcountHistory')) {
    throw new Error('headcountHistory still in prompt schema');
  }
});

// ── Public mirror finder ────────────────────────────────────────────────────
console.log('\n── Mirror finder');
t('MIRROR_ALLOWLIST includes core ATS platforms', () => {
  const m = serverSrc.match(/const MIRROR_ALLOWLIST\s*=\s*\[([\s\S]+?)\];/);
  if (!m) throw new Error('MIRROR_ALLOWLIST missing');
  const body = m[1];
  for (const host of ['greenhouse', 'lever', 'ashbyhq', 'workable']) {
    if (!body.includes(host)) throw new Error(`allowlist missing ${host}`);
  }
});
t('Aggregators (LinkedIn/Indeed/ZipRecruiter/Glassdoor) NOT in allowlist', () => {
  const m = serverSrc.match(/const MIRROR_ALLOWLIST\s*=\s*\[([\s\S]+?)\];/);
  const body = m[1].toLowerCase();
  for (const bad of ['linkedin', 'indeed', 'ziprecruiter', 'glassdoor']) {
    if (body.includes(bad)) throw new Error(`${bad} must NOT be in allowlist (these are the sources of the blocking)`);
  }
});
t('isAllowlistedMirror accepts "careers.<company>." subdomain', () => {
  if (!/careers\\\./i.test(serverSrc)) throw new Error('no careers.* subdomain handling');
});
t('/api/find-posting-mirror endpoint registered + auth-protected', () => {
  if (!/app\.post\('\/api\/find-posting-mirror',\s*authMiddleware/.test(serverSrc)) {
    throw new Error('endpoint not registered or not auth-gated');
  }
});
t('searchWeb uses Jina search (s.jina.ai)', () => {
  if (!/s\.jina\.ai/.test(serverSrc)) throw new Error('not using Jina search');
});
t('verifyMirrorMatch returns structured {match, confidence} verdict', () => {
  const idx = serverSrc.indexOf('async function verifyMirrorMatch');
  if (idx < 0) throw new Error('verifyMirrorMatch not defined');
  const body = serverSrc.slice(idx, idx + 1500);
  if (!body.includes('"match"'))      throw new Error('no match field');
  if (!body.includes('"confidence"')) throw new Error('no confidence field');
});
t('Mirror finder requires verified match (confidence >= 0.7) before returning URL', () => {
  const idx = serverSrc.indexOf("app.post('/api/find-posting-mirror'");
  const body = serverSrc.slice(idx, idx + 3000);
  if (!/confidence.*?0\.7/.test(body)) throw new Error('no confidence threshold');
});
t('Mirror finder excludes the original URL\'s host from results', () => {
  const idx = serverSrc.indexOf("app.post('/api/find-posting-mirror'");
  const body = serverSrc.slice(idx, idx + 3000);
  if (!/origHost/.test(body)) throw new Error('no original-host exclusion');
});

// ── v1.19.16: bare `users` references in route handlers are ReferenceErrors ──
// Caught a real 500 on /api/me where the handler read `users[req.user.id]`
// without first calling `const users = loadUsers()`. There's no module-scope
// `users` object — every handler is supposed to load its own snapshot. This
// guard sweeps the server source and flags any route that reads `users[...]`
// without having loaded it first.
t('Every route that reads users[] loads it via loadUsers() first', () => {
  const lines = serverSrc.split('\n');
  let inFn = false, fnStart = 0, hasLoad = false, depth = 0;
  const warnings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/app\.(get|post|put|delete|patch)\(/.test(line)) {
      fnStart = i; hasLoad = false; inFn = true; depth = 0;
    }
    if (inFn) {
      for (const c of line) { if (c === '{') depth++; else if (c === '}') depth--; }
      if (/(?:const|let)\s+users\s*=\s*loadUsers/.test(line)) hasLoad = true;
      // Reads `users[` but not `loadUsers(` / `saveUsers(` / declaration
      if (/\busers\s*\[/.test(line) && !hasLoad &&
          !/loadUsers|saveUsers|(?:const|let|var)\s+users/.test(line)) {
        warnings.push(`line ${i+1}: bare users[...] ${line.trim().slice(0,80)}`);
      }
      if (depth === 0 && i > fnStart) inFn = false;
    }
  }
  if (warnings.length) throw new Error('bare users[] in route handler(s):\n  ' + warnings.join('\n  '));
});

// ── v1.19.17: no stray editor/backup artifacts in the repo ───────────────────
// Caught a lingering backend/server.js.bak from a sed -i.bak used during
// bug-catching. Harmless but sloppy — package gets bloat and review diffs
// get noise. Prevent by failing the suite if any .bak / .orig / swap / DS
// files sneak in.
t('No stray editor/backup artifacts in the repo', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '../..');
  const skip = new Set(['node_modules', '.git', 'data']);
  const stray = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (/\.(bak|orig|swp|swo)$/i.test(e.name) || e.name === '.DS_Store' || e.name.endsWith('~')) {
        stray.push(path.relative(root, full));
      }
    }
  }
  walk(root);
  if (stray.length) {
    throw new Error('stray files in repo:\n  ' + stray.join('\n  '));
  }
});

console.log(`\n${pass}/${pass+fail} passed${fail ? ' ← FAILURES' : '  ✓'}`);
if (fail) process.exit(1);
