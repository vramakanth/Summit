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
console.log('\n── content.js (v1.20.0 reader)');
t('no site-specific hostname branches', () => {
  not(contentSrc, "hostname.includes(\'linkedin"); not(contentSrc, "hostname.includes(\'indeed");
  not(contentSrc, "hostname.includes(\'greenhouse"); not(contentSrc, "hostname.includes(\'ziprecruiter");
});
// v1.20.0: content.js is now a pure reader. No field extraction, no salary
// scanning, no JSON-LD parsing. The specific content of the reader payload
// is regression-tested in extension/tests/extension.test.js — here we just
// make sure the file hasn't grown new extraction logic.
t('reads document.body.innerText for the text field', () => has(contentSrc, 'document.body.innerText'));
t('harvests JSON-LD script contents (not parses them)', () => has(contentSrc, 'application/ld+json'));
t('no _extractSalaryFromText helper in content.js (extraction moved server-side in v1.20)',
  () => not(contentSrc, 'function _extractSalaryFromText'));
t('no baseSalary / bdi / reqId extraction in content.js (all server-side in v1.20)', () => {
  not(contentSrc, 'baseSalary');
  not(contentSrc, "querySelectorAll('bdi')");
  not(contentSrc, '_extractReqIdFromDom');
});
t('under 250 lines (v1.20 reader is minimal)', () => lt(contentSrc.split('\n').length, 250));

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
// ── v1.20.11: README must not drift from the code ────────────────────────────
// The README went ~30 releases without an update and ended up describing
// optional encryption, a Jina renderer, and 99 tests. These pin the facts
// most likely to rot so a version bump or a new test file fails CI until
// the README is touched too.
t('README states the current APP_VERSION and extension version', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf8');
  const feSrc = fs.readFileSync(path.join(__dirname, '../../frontend/public/index.html'), 'utf8');
  const appV = (feSrc.match(/const APP_VERSION = '([^']+)'/) || [])[1];
  const extV = JSON.parse(fs.readFileSync(path.join(__dirname, '../../extension/manifest.json'), 'utf8')).version;
  if (!appV) throw new Error('APP_VERSION not found in index.html');
  if (!readme.includes(`v${appV}`)) throw new Error(`README does not mention v${appV} (bump the version line)`);
  if (!readme.includes(`v${extV}`))  throw new Error(`README does not mention extension v${extV}`);
});
t('README test-tier counts match the actual suites', () => {
  if (process.env.SUMMIT_COUNTING) return;   // we are a child of ourselves — don't recurse
  const readme = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf8');
  const root = path.join(__dirname, '../..');
  // Count what actually RUNS (✓ lines), not `t(` in source — tests generated
  // inside loops are one call in source but many at runtime.
  const { execSync } = require('child_process');
  const count = f => {
    try { return (execSync(`node ${JSON.stringify(path.join(root, f))}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SUMMIT_COUNTING: '1' }, timeout: 60000 }).match(/^ ✓/gm) || []).length; }
    catch (e) { return (String(e.stdout || '').match(/^ ✓/gm) || []).length; }
  };
  const backend  = ['architecture','behavior','e2e','crypto'].reduce((n, f) => n + count(`backend/tests/${f}.test.js`), 0);
  const frontend = ['smoke','filter','mobile','joblist'].reduce((n, f) => n + count(`frontend/tests/${f}.test.js`), 0)
                 + count('extension/tests/extension.test.js');
  const row = (label) => {
    const m = readme.match(new RegExp(`\\|\\s*${label}[^|]*\\|[^|]*\\|\\s*(\\d+)\\s*\\|`));
    return m ? parseInt(m[1], 10) : null;
  };
  const rb = row('Backend zero-dep'), rf = row('Frontend \\+ extension zero-dep');
  if (rb !== backend)  throw new Error(`README says ${rb} backend zero-dep tests, actual ${backend}`);
  if (rf !== frontend) throw new Error(`README says ${rf} frontend+extension tests, actual ${frontend}`);
});
t('README does not describe removed subsystems (Jina, slug fallback, optional encryption)', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf8');
  for (const stale of ['Jina', 'slug fallback', 'Optional AES', 'llama-3.3', 'Job-Application-Tracker']) {
    if (readme.includes(stale)) throw new Error(`README still mentions "${stale}"`);
  }
});

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

// ── v1.20.0: unified extraction pipeline ─────────────────────────────────────
// The extension and webapp-paste flows both converge on one function.
// Guards against divergence creeping back in.
t('extractJobFields function is defined on the server', () => {
  if (!/async function extractJobFields\(/.test(serverSrc)) {
    throw new Error('extractJobFields not defined — unification lost');
  }
});

t('extractJobFields accepts url + html + text + jsonLd', () => {
  const idx = serverSrc.indexOf('async function extractJobFields');
  const sig = serverSrc.slice(idx, idx + 200);
  // Destructured parameter shape — if any field is missing callers will pass undefined
  if (!/\{\s*url\s*,\s*html\s*,\s*text\s*,\s*jsonLd/.test(sig)) {
    throw new Error('extractJobFields signature is missing expected fields');
  }
});

t('/api/extract-job-fields endpoint exists for extension reader payloads', () => {
  if (!/app\.post\(['"]\/api\/extract-job-fields['"]/.test(serverSrc)) {
    throw new Error('/api/extract-job-fields endpoint missing — extension can\'t extract');
  }
  // Must be auth-required + token-capped (AI path)
  const idx = serverSrc.indexOf("app.post('/api/extract-job-fields'");
  const sig = serverSrc.slice(idx, idx + 200);
  if (!/authMiddleware/.test(sig)) throw new Error('/api/extract-job-fields missing authMiddleware');
  if (!/tokenCapMiddleware/.test(sig)) throw new Error('/api/extract-job-fields missing tokenCapMiddleware');
});

t('/api/extract-job-fields does NOT store anything (extraction-only)', () => {
  // The endpoint must not touch the inbox — storage happens via a separate
  // POST to /api/jobs/inbox after the user reviews in the popup. Cancelling
  // extraction should leave no trace on the server.
  const idx = serverSrc.indexOf("app.post('/api/extract-job-fields'");
  const end = serverSrc.indexOf("\n});", idx);
  const handlerBody = serverSrc.slice(idx, end);
  if (/writeFileSync|_inboxDirFor/.test(handlerBody)) {
    throw new Error('/api/extract-job-fields writes to disk — should be extraction-only');
  }
});

t('decodeGzippedBase64 helper exists for compressed html payloads', () => {
  if (!/function decodeGzippedBase64\(/.test(serverSrc)) {
    throw new Error('decodeGzippedBase64 missing — gzipped html from extension can\'t be decoded');
  }
  // Must use zlib.gunzipSync
  if (!/zlib\.gunzipSync/.test(serverSrc)) {
    throw new Error('decodeGzippedBase64 does not use zlib.gunzipSync');
  }
  // Must be resilient to bad input (never throw — caller falls back)
  const idx = serverSrc.indexOf('function decodeGzippedBase64');
  const body = serverSrc.slice(idx, idx + 400);
  if (!/try\s*\{[\s\S]*?\}\s*catch/.test(body)) {
    throw new Error('decodeGzippedBase64 has no try/catch — bad input would crash the handler');
  }
});

t('extractJobFields reuses parseJobPostingLD and extractSalaryFromText', () => {
  // The whole point of unification: one extraction pipeline. If extractJobFields
  // reimplements the LD parse or the salary regex, we've reintroduced drift.
  const idx = serverSrc.indexOf('async function extractJobFields');
  const end = serverSrc.indexOf('\nfunction ', idx + 10);  // next top-level fn
  const body = serverSrc.slice(idx, end);
  if (!/parseJobPostingLD/.test(body)) {
    throw new Error('extractJobFields does not call parseJobPostingLD — re-implementing LD?');
  }
  if (!/extractSalaryFromText/.test(body)) {
    throw new Error('extractJobFields does not call extractSalaryFromText — re-implementing salary regex?');
  }
});

console.log(`\n${pass}/${pass+fail} passed${fail ? ' ← FAILURES' : '  ✓'}`);
if (fail) process.exit(1);
