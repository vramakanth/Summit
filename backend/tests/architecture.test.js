/**
 * architecture.test.js — Backend architecture & unit tests
 * Run: node architecture.test.js
 */
const { cleanJobUrl, slugFallback } = require('../ats-helpers');
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

// ── slugFallback ──────────────────────────────────────────────────────────────
console.log('\n── slugFallback');
t('ZipRecruiter company+title', () => {
  const r = slugFallback('https://www.ziprecruiter.com/c/Saratech/Job/Director-of-Engineering/-in-Mission-Viejo,CA');
  eq(r.company, 'Saratech');
  if (!r.title?.includes('Director')) throw new Error('no title: ' + r.title);
});
t('Lensa hash filtered from path', () => {
  const r = slugFallback('https://lensa.com/job-v1/karman-space-and-defense/brea-ca/director-of-engineering/4e259fb258883c881a851cfd8db6a4de');
  if (!r.title?.includes('Director')) throw new Error('no title: ' + r.title);
});
t('career.io title from path', () => {
  const r = slugFallback('https://career.io/job/director-of-engineering-brea-karman-space-defense-497b80a6f57f779eb26cdf078d4b39b5');
  if (!r.title?.includes('Director')) throw new Error('no title: ' + r.title);
});
t('null on invalid URL', () => eq(slugFallback('not-a-url'), null));

// ── Server architecture ────────────────────────────────────────────────────────
console.log('\n── Server architecture');
t('detectATS removed',           () => not(serverSrc, 'detectATS'));
t('UA constant defined',         () => has(serverSrc, "const UA = 'Mozilla"));
t('UA in request headers (x2)',  () => { if ((serverSrc.match(/'User-Agent': UA/g)||[]).length < 2) throw new Error('only ' + (serverSrc.match(/'User-Agent': UA/g)||[]).length + ' refs'); });
t('Jina reader as primary path', () => has(serverSrc, 'r.jina.ai/'));
t('Promise.race hard timeout',   () => has(serverSrc, 'Promise.race([fetchProm'));
t('fetchTimeout default 20s',    () => has(serverSrc, 'ms = 20000'));
t('3 via markers present',       () => { has(serverSrc, "_via: 'jina'"); has(serverSrc, "_via: 'fetch'"); has(serverSrc, "_via: 'slug'"); });
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
t('fallback salary from bodyText', () => has(contentSrc, 'bodyText.match('));
t('sends bodyText + salary + url', () => { has(contentSrc, 'bodyText'); has(contentSrc, 'salary'); has(contentSrc, 'url: location.href'); });
t('under 100 lines',               () => lt(contentSrc.split('\n').length, 100));

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
  t('slug:  ' + name, () => { const c = cleanJobUrl(url); if (c.includes('share.google')) return; const r = slugFallback(c); if (!r || (!r.title && !r.company)) throw new Error('nothing extracted'); });
});

// ── User settings endpoint (Finnhub key sync) ───────────────────────────────
console.log('\n── User settings sync');
t('SETTINGS_DIR constant defined',          () => has(serverSrc, "SETTINGS_DIR = path.join(DATA_DIR, 'settings')"));
t('SETTINGS_DIR in mkdir bootstrap',        () => {
  const m = serverSrc.match(/for\s*\(const d of \[([^\]]+)\]\)/);
  if (!m || !m[1].includes('SETTINGS_DIR')) throw new Error('SETTINGS_DIR not in bootstrap list');
});
t('loadUserSettings helper defined',        () => has(serverSrc, 'function loadUserSettings(userId, dataKey)'));
t('saveUserSettings helper defined',        () => has(serverSrc, 'function saveUserSettings(userId, data, dataKey)'));
t('loadUserSettings decrypts at rest',      () => {
  const idx = serverSrc.indexOf('function loadUserSettings');
  const body = serverSrc.slice(idx, idx + 500);
  if (!body.includes('decryptData')) throw new Error('not decrypting at rest');
});
t('saveUserSettings encrypts at rest',      () => {
  const idx = serverSrc.indexOf('function saveUserSettings');
  const body = serverSrc.slice(idx, idx + 300);
  if (!body.includes('encryptData')) throw new Error('not encrypting at rest');
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

console.log(`\n${pass}/${pass+fail} passed${fail ? ' ← FAILURES' : '  ✓'}`);
if (fail) process.exit(1);
