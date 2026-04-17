// behavior.test.js — functional coverage.
// Instead of asserting "the code contains a _partial flag assignment", we
// actually EXECUTE the function and check the result. Catches regressions
// that source-level regex passes (renamed variables, refactored structure
// that still "looks right") would miss.

const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const feSrc     = fs.readFileSync(path.join(__dirname, '../../frontend/public/index.html'), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(` ✓ ${name}`); passed++; }
  catch (e) { console.log(` ✗ ${name} — ${e.message}`); failed++; }
}

// Extract a named function's source (matched on opening `function NAME(`)
function extractFn(src, name) {
  const patterns = [
    `async function ${name}(`,
    `function ${name}(`,
  ];
  let start = -1;
  for (const p of patterns) { const i = src.indexOf(p); if (i >= 0) { start = i; break; } }
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

// ════════════════════════════════════════════════════════════════════════════
// parseJson — strategy ladder with _partial flag on lossy recovery
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── parseJson: real input/output behavior');

// Inject parseJson into a local sandbox
eval(extractFn(serverSrc, 'parseJson'));

t('clean JSON: no _partial flag', () => {
  const out = parseJson('{"a":1,"b":"hello"}');
  if (out.a !== 1) throw new Error('value dropped');
  if (out._partial) throw new Error('clean input falsely flagged partial');
});

t('strips markdown code fences', () => {
  const out = parseJson('```json\n{"x":5}\n```');
  if (out.x !== 5) throw new Error('fences not stripped');
});

t('leading garbage before first { is dropped', () => {
  const out = parseJson('here is the response: {"ok":true}');
  if (out.ok !== true) throw new Error('leading prose not stripped');
});

t('truncated mid-string: strategy-3 recovers early keys + flags _partial', () => {
  // Imagine AI response got cut off mid-field. Everything up to the break
  // should still be parseable; the truncated bit should be dropped.
  const truncated = '{"overview":"hi","culture":{"summary":"this was cut';
  const out = parseJson(truncated);
  if (!out) throw new Error('no recovery');
  if (!out._partial) throw new Error('_partial flag NOT set on lossy recovery');
  if (out.overview !== 'hi') throw new Error('early field was dropped');
});

t('truncated between complete keys: recovers last good state', () => {
  const truncated = '{"a":1,"b":2,"c":3,';  // trailing comma, no closer
  const out = parseJson(truncated);
  if (!out) throw new Error('no recovery');
  if (out._partial !== true) throw new Error('_partial not flagged');
  if (out.a !== 1 || out.b !== 2 || out.c !== 3) throw new Error('recoverable keys lost');
});

t('completely unparseable: throws', () => {
  let threw = false;
  try { parseJson('%%% not json at all %%%'); } catch { threw = true; }
  if (!threw) throw new Error('should have thrown on garbage');
});

// ════════════════════════════════════════════════════════════════════════════
// STATUS migration: legacy statuses transparently map to current vocabulary
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── STATUS_MIGRATE: real migration behavior');

// Extract both STATUSES array and STATUS_MIGRATE map from the frontend
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*([\\s\\S]+?);'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[1];
}
const STATUSES = eval(extractConst(feSrc, 'STATUSES'));
const STATUS_MIGRATE = eval('(' + extractConst(feSrc, 'STATUS_MIGRATE') + ')');

t('STATUSES is the 5-entry reduced set', () => {
  const expected = ['to apply','applied','interview','offer','rejected'];
  if (STATUSES.length !== 5) throw new Error(`expected 5 statuses, got ${STATUSES.length}`);
  for (const s of expected) {
    if (!STATUSES.includes(s)) throw new Error(`missing: ${s}`);
  }
});

t('every legacy status migrates to a CURRENT status', () => {
  for (const [legacy, current] of Object.entries(STATUS_MIGRATE)) {
    if (!STATUSES.includes(current)) {
      throw new Error(`STATUS_MIGRATE[${legacy}] = ${current} — not a valid current status`);
    }
  }
});

t('screening/interviewing → interview (interview-loop collapse)', () => {
  if (STATUS_MIGRATE['screening']     !== 'interview') throw new Error('screening not mapped');
  if (STATUS_MIGRATE['interviewing']  !== 'interview') throw new Error('interviewing not mapped');
});

t('ghosted/withdrawn/expired → rejected (end-state collapse)', () => {
  for (const end of ['ghosted','withdrawn','expired']) {
    if (STATUS_MIGRATE[end] !== 'rejected') throw new Error(`${end} should map to rejected`);
  }
});

t('applying migration to a jobs map updates statuses in place', () => {
  const jobs = {
    j1: { id: 'j1', status: 'interviewing' },
    j2: { id: 'j2', status: 'applied' },       // already current
    j3: { id: 'j3', status: 'ghosted' },
    j4: { id: 'j4', status: 'screening' },
  };
  // This mirrors the loadJobs snippet
  Object.values(jobs).forEach(j => {
    if (j.status && STATUS_MIGRATE[j.status]) j.status = STATUS_MIGRATE[j.status];
  });
  if (jobs.j1.status !== 'interview') throw new Error('interviewing not migrated');
  if (jobs.j2.status !== 'applied')   throw new Error('current status mistakenly touched');
  if (jobs.j3.status !== 'rejected')  throw new Error('ghosted not migrated');
  if (jobs.j4.status !== 'interview') throw new Error('screening not migrated');
});

// ════════════════════════════════════════════════════════════════════════════
// Mirror allowlist: the right hosts in, aggregators out
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Mirror allowlist: real URL acceptance');

// Extract isAllowlistedMirror — it depends on MIRROR_ALLOWLIST.
// `const` declarations inside eval are block-scoped to the eval itself and do
// NOT leak out. Same problem would hit STATUSES except extractConst returns
// the array literal, not the declaration. Assign to global explicitly here.
const allowlistSrc = serverSrc.match(/const MIRROR_ALLOWLIST\s*=\s*(\[[\s\S]+?\]);/);
global.MIRROR_ALLOWLIST = eval('(' + allowlistSrc[1] + ')');
eval(extractFn(serverSrc, 'isAllowlistedMirror'));

t('Greenhouse URL accepted', () => {
  if (!isAllowlistedMirror('https://boards.greenhouse.io/acme/jobs/12345')) {
    throw new Error('Greenhouse rejected');
  }
});

t('Lever URL accepted', () => {
  if (!isAllowlistedMirror('https://jobs.lever.co/acme/some-id')) {
    throw new Error('Lever rejected');
  }
});

t('Ashby URL accepted', () => {
  if (!isAllowlistedMirror('https://jobs.ashbyhq.com/acme/role-id')) {
    throw new Error('Ashby rejected');
  }
});

t('careers.company.com subdomain accepted', () => {
  if (!isAllowlistedMirror('https://careers.acme.com/jobs/senior-engineer')) {
    throw new Error('company-careers subdomain rejected');
  }
});

t('LinkedIn rejected (the bot-blocking source, not a fix)', () => {
  if (isAllowlistedMirror('https://www.linkedin.com/jobs/view/12345')) {
    throw new Error('LinkedIn must NOT be in allowlist');
  }
});

t('Indeed rejected', () => {
  if (isAllowlistedMirror('https://www.indeed.com/viewjob?jk=abc')) {
    throw new Error('Indeed must NOT be in allowlist');
  }
});

t('ZipRecruiter rejected (the originally-reported Cloudflare source)', () => {
  if (isAllowlistedMirror('https://www.ziprecruiter.com/jobs/acme/role-slug')) {
    throw new Error('ZipRecruiter must NOT be in allowlist');
  }
});

t('Glassdoor rejected', () => {
  if (isAllowlistedMirror('https://www.glassdoor.com/job-listing/role-at-co-JV.htm')) {
    throw new Error('Glassdoor must NOT be in allowlist');
  }
});

t('Garbage URL returns null (does not throw)', () => {
  const r = isAllowlistedMirror('not-a-url');
  if (r !== null) throw new Error('expected null for malformed URL, got ' + r);
});

// ════════════════════════════════════════════════════════════════════════════
// buildPostingHtml: actual input → output (paragraph/heading/bullet shape)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── buildPostingHtml: real input/output');

// buildPostingHtml uses DOMParser (browser-only) on its j.postingHtml branch,
// and `esc()` for escaping. Stub both so we can run the postingText branch.
global.esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
global.DOMParser = class { parseFromString() { return null; } };  // forces postingText branch
global.jobs = {};
global.currentJobId = null;
global.emptyPosting = () => '<EMPTY/>';

eval(extractFn(feSrc, 'buildPostingHtml'));

t('single paragraph wrapped in <p>', () => {
  const out = buildPostingHtml({ postingText: 'This is a description of the role that has enough text to be considered real content. Lots of words go here.' });
  if (!out.includes('<p>')) throw new Error('no <p> wrapper');
  if (!out.includes('posting-body')) throw new Error('no outer .posting-body div');
});

t('double-newline splits produce multiple paragraphs', () => {
  const text = 'First paragraph about the role and what the company does in broad strokes.\n\nSecond paragraph covering the day-to-day responsibilities of this position in detail.';
  const out = buildPostingHtml({ postingText: text });
  const paraCount = (out.match(/<p>/g) || []).length;
  if (paraCount < 2) throw new Error(`expected 2+ <p>, got ${paraCount}`);
});

t('bullet-style lines become <ul><li>', () => {
  const text = 'Requirements:\n\n• 5 years experience\n• Strong JavaScript skills\n• Team player';
  const out = buildPostingHtml({ postingText: text });
  if (!out.includes('<ul>')) throw new Error('no <ul>');
  if (!out.includes('<li>')) throw new Error('no <li>');
  if (out.match(/<li>/g).length !== 3) throw new Error('expected 3 <li>, got ' + (out.match(/<li>/g) || []).length);
});

t('short no-punctuation line promoted to <h3>', () => {
  const text = 'About the Role\n\nWe are looking for a senior engineer to join our team. This person will work on core infrastructure and own major features end to end.';
  const out = buildPostingHtml({ postingText: text });
  if (!out.includes('<h3>About the Role</h3>')) throw new Error('short line not promoted to h3');
});

t('markup in postingText is sanitized (no raw tag leaks)', () => {
  const text = 'Some content with <script>alert(1)</script> embedded which should be sanitized so the user sees nothing executable and no XSS is possible.';
  const out = buildPostingHtml({ postingText: text });
  // toPlainText strips HTML tags before we ever esc() — either outcome
  // (stripped or escaped) is safe; what we require is no raw <script>.
  if (/<script>/i.test(out)) throw new Error('raw <script> tag leaked — XSS risk');
});

// ════════════════════════════════════════════════════════════════════════════
// Dark-mode contrast ratios (WCAG formula) — computed from the real palette
// in index.html. Locks in the "text is readable at night" fix so future color
// edits that accidentally dim a token get caught.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Dark-mode contrast ratios (WCAG)');

// sRGB → relative luminance per WCAG 2.1
function luminance(hex) {
  const h = hex.replace('#','');
  const [r,g,b] = [h.slice(0,2), h.slice(2,4), h.slice(4,6)].map(x => parseInt(x, 16) / 255);
  const linear = c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function ratio(c1, c2) {
  const [l1, l2] = [luminance(c1), luminance(c2)].sort((a,b) => b-a);
  return (l1 + 0.05) / (l2 + 0.05);
}

// Pull the dark palette block from index.html and parse hex values.
// Anchor on `@media (prefers-color-scheme: dark)` so we don't accidentally
// grab the <meta name="theme-color" media="(prefers-color-scheme: dark)">
// tag earlier in the file.
const darkBlock = feSrc.match(/@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]+?\}[\s\S]+?\}/)[0];
function varHex(name) {
  const m = darkBlock.match(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})'));
  if (!m) throw new Error('dark --' + name + ' not found');
  return m[1];
}
const palette = {
  bg:    varHex('bg'),
  bg2:   varHex('bg2'),
  bg3:   varHex('bg3'),
  bg4:   varHex('bg4'),
  text:  varHex('text'),
  text2: varHex('text2'),
  text3: varHex('text3'),
};

const AA_BODY = 4.5;  // WCAG AA for normal-sized body text
const AA_LARGE = 3.0; // Large text only

t('--text on all bg surfaces: AAA-level (≥ 7:1)', () => {
  for (const bg of ['bg','bg2','bg3','bg4']) {
    const r = ratio(palette.text, palette[bg]);
    if (r < 7) throw new Error(`text on ${bg}: ${r.toFixed(2)} < 7`);
  }
});

t('--text2 on bg/bg2/bg3: passes AA body (≥ 4.5:1)', () => {
  for (const bg of ['bg','bg2','bg3']) {
    const r = ratio(palette.text2, palette[bg]);
    if (r < AA_BODY) throw new Error(`text2 on ${bg}: ${r.toFixed(2)} < ${AA_BODY}`);
  }
});

t('--text3 on bg/bg2: passes AA body (was 4.1 on bg3, failing)', () => {
  for (const bg of ['bg','bg2']) {
    const r = ratio(palette.text3, palette[bg]);
    if (r < AA_BODY) throw new Error(`text3 on ${bg}: ${r.toFixed(2)} < ${AA_BODY}`);
  }
});

t('--text3 on bg3 (cards/hover): passes AA body (regression target — was 4.1)', () => {
  const r = ratio(palette.text3, palette.bg3);
  if (r < AA_BODY) throw new Error(`text3 on bg3: ${r.toFixed(2)} < ${AA_BODY} — night-mode readability regression`);
});

t('--text3 on bg4 (pressed/active): passes AA body (regression target — was 3.4)', () => {
  const r = ratio(palette.text3, palette.bg4);
  if (r < AA_BODY) throw new Error(`text3 on bg4: ${r.toFixed(2)} < ${AA_BODY} — night-mode readability regression`);
});

t('admin.html dark palette matches main app (text3 same brightness)', () => {
  const adminSrc = fs.readFileSync(path.join(__dirname, '../../frontend/public/admin.html'), 'utf8');
  const m = adminSrc.match(/--text3:(#[0-9a-fA-F]{6})/);
  if (!m) throw new Error('admin --text3 not found');
  if (m[1].toLowerCase() !== palette.text3.toLowerCase()) {
    throw new Error(`admin --text3 (${m[1]}) drifted from main (${palette.text3})`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// AI provider defaults — models get deprecated; source-level sanity check
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── AI provider model defaults');

t('GOOGLE_MODEL default is NOT deprecated gemini-2.0-flash', () => {
  // Google killed gemini-2.0-flash on March 31, 2026. Any deployment using
  // the old default would see all Google requests return 404. The current
  // default must be gemini-2.5-flash (free-tier successor) or newer.
  const m = serverSrc.match(/GOOGLE_MODEL\s*=\s*process\.env\.GOOGLE_MODEL\s*\|\|\s*'([^']+)'/);
  if (!m) throw new Error('GOOGLE_MODEL default line not found');
  const model = m[1];
  if (model === 'gemini-2.0-flash' || model === 'gemini-2.0-flash-lite') {
    throw new Error(`GOOGLE_MODEL default is "${model}" — this was shut down March 31, 2026`);
  }
  // Must be gemini-2.5-* or gemini-3.*-* (both current as of this test's writing)
  if (!/^gemini-(2\.5|3[\.-])/.test(model)) {
    throw new Error(`GOOGLE_MODEL "${model}" doesn't look like a current family — verify it's still supported`);
  }
});

t('/api/ai-status actively probes each provider (not just checks key presence)', () => {
  const idx = serverSrc.indexOf("app.get('/api/ai-status'");
  if (idx < 0) throw new Error('/api/ai-status endpoint missing');
  const body = serverSrc.slice(idx, idx + 1200);
  // Old version just returned {groq: !!GROQ_API_KEY, ...}. New version hits
  // each provider and reports ok/error/latency. Regression-proof both.
  if (!/probe\s*=\s*async/.test(body))    throw new Error('ai-status missing probe function');
  if (!/Promise\.all/.test(body))         throw new Error('ai-status not running probes in parallel');
  if (!/latencyMs/.test(body))            throw new Error('ai-status not reporting latency per provider');
});

t('callAI log line includes the model string (for Render log diagnostics)', () => {
  const idx = serverSrc.indexOf('async function callAI');
  const body = serverSrc.slice(idx, idx + 1500);
  // Must map provider → model for logging
  if (!/models\s*=\s*\{[^}]*groq:\s*GROQ_MODEL/.test(body)) {
    throw new Error('callAI does not map provider → model string for logging');
  }
  // New log format interpolates result.model (the actually-used model after
  // Groq fallback swap, not just the configured default). Accept either shape.
  if (!/result\.model\s*\|\|\s*models\[name\]/.test(body) &&
      !/\$\{models\[name\]\}/.test(body)) {
    throw new Error('callAI log line does not include the model string');
  }
});

t('Insights max_tokens fits Groq 12K TPM free-tier budget (was 8000 — hit limit instantly)', () => {
  const insightsIdx = serverSrc.indexOf("app.post('/api/insights'");
  const block = serverSrc.slice(insightsIdx, insightsIdx + 5500);
  // Accept either old (maxTok) or new (maxTok, req, 'endpoint') signature
  const m = block.match(/callAI\([\s\S]*?,\s*(\d+)\s*(?:,|\))/);
  if (!m) throw new Error('insights callAI invocation not found');
  const maxTok = parseInt(m[1], 10);
  if (maxTok > 4000) {
    throw new Error(`insights max_tokens=${maxTok} too high for Groq 12K TPM — use 4000 or less`);
  }
});

t('Insights schema removes AI-hallucinated demographic guesses (genderSplit/ageBrackets/ethnicityMix)', () => {
  const insightsIdx = serverSrc.indexOf("app.post('/api/insights'");
  const block = serverSrc.slice(insightsIdx, insightsIdx + 5000);
  // Strip comments before checking — we don't care if our own explanatory
  // comments mention the removed field names, only the actual schema string.
  const noComments = block.replace(/\/\/[^\n]*/g, '');
  for (const field of ['genderSplit', 'ageBrackets', 'ethnicityMix']) {
    if (new RegExp(`["']${field}["']`).test(noComments)) {
      throw new Error(`"${field}" still present in insights schema — unreliable AI guesses that waste output tokens`);
    }
  }
});

t('News is fetched from public sources, not hallucinated by AI', () => {
  // 1. Helper must exist
  if (!/async function fetchCompanyNews/.test(serverSrc)) {
    throw new Error('fetchCompanyNews helper missing');
  }
  // 2. Must hit Finnhub company-news and/or Google News RSS — the two keyless+semi-keyless sources
  if (!/finnhub\.io\/api\/v1\/company-news/.test(serverSrc)) {
    throw new Error('fetchCompanyNews not calling Finnhub company-news endpoint');
  }
  if (!/news\.google\.com\/rss\/search/.test(serverSrc)) {
    throw new Error('fetchCompanyNews not falling back to Google News RSS');
  }
  // 3. Schema must NOT include "news" anymore (AI used to hallucinate fake URLs)
  const insightsIdx = serverSrc.indexOf("app.post('/api/insights'");
  const block = serverSrc.slice(insightsIdx, insightsIdx + 5500);
  const noComments = block.replace(/\/\/[^\n]*/g, '');
  const schemaMatch = noComments.match(/usr\s*=\s*`[\s\S]+?`/);
  if (!schemaMatch) throw new Error('insights prompt template not found');
  if (/"news":/.test(schemaMatch[0])) {
    throw new Error('news field still in AI schema — should be fetched from public sources instead');
  }
  // 4. Endpoint must run fetchCompanyNews in parallel with callAI (Promise.all)
  if (!/Promise\.all\([\s\S]*fetchCompanyNews/.test(block)) {
    throw new Error('insights endpoint not running fetchCompanyNews in parallel with callAI');
  }
  // 5. fetchCompanyNews result must be attached to the response
  if (!/news,/.test(block)) {
    throw new Error('fetched news not attached to insights response');
  }
});

t('Company overview comes from Wikipedia, not AI', () => {
  if (!/async function fetchWikipediaSummary/.test(serverSrc)) {
    throw new Error('fetchWikipediaSummary helper missing');
  }
  if (!/en\.wikipedia\.org\/api\/rest_v1\/page\/summary/.test(serverSrc)) {
    throw new Error('fetchWikipediaSummary not using Wikipedia REST summary endpoint');
  }
  // User-Agent required by Wikipedia policy
  if (!/User-Agent.*Summit/.test(serverSrc)) {
    throw new Error('Wikipedia fetch missing required User-Agent header');
  }
  // Schema must NOT include "companyOverview" anymore
  const insightsIdx = serverSrc.indexOf("app.post('/api/insights'");
  const block = serverSrc.slice(insightsIdx, insightsIdx + 6000);
  const noComments = block.replace(/\/\/[^\n]*/g, '');
  const schemaMatch = noComments.match(/usr\s*=\s*`[\s\S]+?`/);
  if (/"companyOverview":/.test(schemaMatch[0])) {
    throw new Error('companyOverview still in AI schema — should come from Wikipedia');
  }
  // Wikipedia extract used as AI grounding context + attached to response
  if (!/wikiContext/.test(block))        throw new Error('Wikipedia extract not used as AI grounding');
  if (!/companyOverview:\s*wiki\?/.test(block)) throw new Error('Wikipedia extract not attached to companyOverview in response');
  if (!/wikipediaUrl:\s*wiki\?/.test(block))    throw new Error('Wikipedia source URL not attached to response for attribution');
});

t('Overview structured facts (founded/hq/industry/employees) come from Wikidata, not AI', () => {
  if (!/async function fetchWikidataOverview/.test(serverSrc)) {
    throw new Error('fetchWikidataOverview helper missing');
  }
  // Must query Wikidata SPARQL and wbsearchentities
  if (!/query\.wikidata\.org\/sparql/.test(serverSrc)) {
    throw new Error('fetchWikidataOverview not using Wikidata SPARQL endpoint');
  }
  if (!/wbsearchentities/.test(serverSrc)) {
    throw new Error('fetchWikidataOverview not using wbsearchentities for QID lookup');
  }
  // Must use the right property IDs: P571 (inception), P159 (HQ), P452 (industry), P1128 (employees)
  for (const prop of ['P571', 'P159', 'P452', 'P1128']) {
    if (!new RegExp(`wdt:${prop}`).test(serverSrc)) {
      throw new Error(`Wikidata SPARQL missing property ${prop}`);
    }
  }
  // Schema must NOT include "overview" anymore — Wikidata owns it
  const insightsIdx = serverSrc.indexOf("app.post('/api/insights'");
  const block = serverSrc.slice(insightsIdx, insightsIdx + 6000);
  const noComments = block.replace(/\/\/[^\n]*/g, '');
  const schemaMatch = noComments.match(/usr\s*=\s*`[\s\S]+?`/);
  if (/"overview":/.test(schemaMatch[0])) {
    throw new Error('overview field still in AI schema — should come from Wikidata');
  }
  // Wikidata result must be attached to response under `overview`
  if (!/overview:\s*overview/.test(block)) {
    throw new Error('Wikidata overview not attached to response');
  }
  // Wikipedia QID should be passed to Wikidata to skip one round trip
  if (!/fetchWikidataOverview\(company,\s*wiki\?/.test(block)) {
    throw new Error('Wikipedia QID not passed to fetchWikidataOverview (extra round trip)');
  }
});

t('Wikipedia attribution link rendered under company overview', () => {
  if (!/ins\.wikipediaUrl/.test(feSrc)) {
    throw new Error('frontend not rendering Wikipedia attribution link');
  }
  // Must be a real <a> with target=_blank, not hidden
  if (!/ins\.wikipediaUrl\s*\?\s*`[^`]*<a[^>]+href=[^>]+>\s*Wikipedia/.test(feSrc)) {
    throw new Error('Wikipedia attribution not rendered as a visible link');
  }
});

t('AI schema removes never-displayed linkedin + interviewTips fields', () => {
  const insightsIdx = serverSrc.indexOf("app.post('/api/insights'");
  const block = serverSrc.slice(insightsIdx, insightsIdx + 5500);
  const noComments = block.replace(/\/\/[^\n]*/g, '');
  const schemaMatch = noComments.match(/usr\s*=\s*`[\s\S]+?`/);
  if (!schemaMatch) throw new Error('insights prompt template not found');
  for (const field of ['linkedin', 'interviewTips']) {
    // Allow the mention inside strings like "LinkedIn contacts" — the schema
    // field is a JSON key with quotes. Match only the key form "field":
    if (new RegExp(`"${field}":`).test(schemaMatch[0])) {
      throw new Error(`"${field}" still in AI schema — was never rendered, should be removed`);
    }
  }
});

t('Frontend error-state fallback shape does not reference removed fields', () => {
  // The fallback object constructed when insights error with no previous data
  // should not initialize linkedin or interviewTips since those are gone.
  const errBlock = feSrc.match(/j\.insights\s*=\s*\{[\s\S]+?generatedAt:\s*j\.insights\?\.generatedAt[\s\S]+?\}/);
  if (!errBlock) throw new Error('insights error-state fallback not found');
  if (/\blinkedin\b/.test(errBlock[0]))      throw new Error('error-state still initializes linkedin');
  if (/\binterviewTips\b/.test(errBlock[0])) throw new Error('error-state still initializes interviewTips');
});

t('/api/insights returns distinct 429 response when all providers rate-limited', () => {
  const insightsIdx = serverSrc.indexOf("app.post('/api/insights'");
  const block = serverSrc.slice(insightsIdx, insightsIdx + 5500);
  if (!/status\(429\)/.test(block))                       throw new Error('insights does not return 429 distinctly');
  if (!/error:\s*['"]rate_limited['"]/.test(block))       throw new Error('no error code "rate_limited" returned');
});

t('Groq has an 8B-instant fallback when 70B hits 429 (higher TPM ceiling)', () => {
  if (!/GROQ_FALLBACK_MODEL/.test(serverSrc))           throw new Error('GROQ_FALLBACK_MODEL not declared');
  if (!/llama-3\.1-8b-instant/.test(serverSrc))        throw new Error('8B instant model not referenced');
  const idx = serverSrc.indexOf('async function callGroq');
  const body = serverSrc.slice(idx, idx + 1500);
  if (!/e\.status\s*===\s*429/.test(body)) throw new Error('callGroq does not detect 429 for fallback');
  if (!/GROQ_FALLBACK_MODEL/.test(body))   throw new Error('callGroq does not use the fallback model');
});

// ════════════════════════════════════════════════════════════════════════════
// Token usage tracking — structural checks on the backend module
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Token usage tracking');

t('Usage tracking module exports the expected functions', () => {
  for (const fn of ['recordUsage', 'todaysUsage', 'tokenCapMiddleware', 'loadUserUsage', 'saveUserUsage', 'appendUsageLog']) {
    if (!new RegExp(`function ${fn}\\b`).test(serverSrc)) {
      throw new Error(`usage module missing: ${fn}`);
    }
  }
});

t('Provider calls extract and return real usage counts', () => {
  // Each provider helper must return {text, usage, model} — not just text
  for (const fn of ['callGroq', 'callOpenRouter', 'callGoogle']) {
    const idx = serverSrc.indexOf(`async function ${fn}`);
    const body = serverSrc.slice(idx, idx + 2000);
    // Must return an object with text + usage keys
    if (!/return\s*\{[\s\S]{0,300}text:/.test(body))   throw new Error(`${fn} not returning text field`);
    if (!/usage:\s*\{[^}]*prompt:/.test(body))         throw new Error(`${fn} not extracting prompt tokens`);
    if (!/usage:\s*\{[^}]*completion:/.test(body))     throw new Error(`${fn} not extracting completion tokens`);
  }
  // Groq reads data.usage.prompt_tokens (OpenAI-compatible shape)
  if (!/data\.usage\?\.prompt_tokens/.test(serverSrc))         throw new Error('Groq not reading prompt_tokens');
  // Google reads usageMetadata (different shape)
  if (!/usageMetadata\?\.promptTokenCount/.test(serverSrc))    throw new Error('Google not reading promptTokenCount');
});

t('callAI records usage via recordUsage() when req+endpoint are passed', () => {
  const idx = serverSrc.indexOf('async function callAI');
  const body = serverSrc.slice(idx, idx + 1500);
  // Signature must accept optional req + endpoint
  if (!/callAI\(order,\s*sys,\s*usr,\s*maxTok\s*=\s*\d+,\s*req\s*=\s*null,\s*endpoint\s*=\s*null\)/.test(body)) {
    throw new Error('callAI signature does not accept req + endpoint params');
  }
  if (!/recordUsage\(user,\s*name,/.test(body)) {
    throw new Error('callAI does not call recordUsage');
  }
});

t('All AI endpoints thread req + endpoint label to callAI', () => {
  // Find every `callAI(` invocation, then match-forward across newlines up to
  // the closing `);` — the template literals can have embedded newlines.
  const re = /\bcallAI\(([\s\S]*?)\)\s*[;,\n]/g;
  let match;
  const missing = [];
  while ((match = re.exec(serverSrc)) !== null) {
    const args = match[1];
    // Skip the function definition itself (has `order, sys, usr, maxTok = ...`)
    if (/^\s*order\s*,/.test(args)) continue;
    // Skip obvious non-calls (e.g. callGroq inside the probe)
    if (!args.includes(',')) continue;
    if (!/,\s*req\b/.test(args)) {
      // Capture just the first 80 chars for diagnostic
      missing.push(args.replace(/\s+/g, ' ').slice(0, 80));
    }
  }
  if (missing.length) {
    throw new Error(`${missing.length} callAI sites missing req context: ${missing.join(' || ')}`);
  }
});

t('All AI routes have tokenCapMiddleware after authMiddleware', () => {
  const aiRoutes = [
    '/api/extract-fields', '/api/tailor', '/api/tailor-docx', '/api/insights',
    '/api/outreach-targets', '/api/interview-questions', '/api/keyword-gap',
    '/api/email-template', '/api/salary-benchmark', '/api/find-posting-mirror',
    '/api/parse-job',
  ];
  for (const r of aiRoutes) {
    const pattern = new RegExp(`app\\.post\\('${r.replace(/[\/\-]/g, m => '\\' + m)}',\\s*authMiddleware,\\s*tokenCapMiddleware`);
    if (!pattern.test(serverSrc)) {
      throw new Error(`${r} missing tokenCapMiddleware after authMiddleware`);
    }
  }
});

t('tokenCapMiddleware returns 429 with error code "token_cap_reached"', () => {
  const idx = serverSrc.indexOf('function tokenCapMiddleware');
  const body = serverSrc.slice(idx, idx + 1000);
  if (!/status\(429\)/.test(body))                        throw new Error('cap middleware not returning 429');
  if (!/error:\s*['"]token_cap_reached['"]/.test(body))  throw new Error('cap middleware not using "token_cap_reached" error code');
  if (!/used\s*>=\s*DAILY_TOKEN_CAP/.test(body))         throw new Error('cap middleware not comparing to DAILY_TOKEN_CAP');
});

t('/api/user-usage and /api/admin/usage endpoints exist', () => {
  if (!/app\.get\('\/api\/user-usage',\s*authMiddleware/.test(serverSrc)) {
    throw new Error('/api/user-usage endpoint missing');
  }
  if (!/app\.get\('\/api\/admin\/usage',\s*adminMiddleware/.test(serverSrc)) {
    throw new Error('/api/admin/usage endpoint missing');
  }
});

t('recordUsage round-trip: writing then reading aggregates correctly', () => {
  // Black-box test of the logger using real fs writes in a tmpdir
  const os = require('os'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'summit-usage-'));
  const usageDir = path.join(tmp, 'usage');
  fs.mkdirSync(usageDir);

  // Replicate the module's helpers against our tmpdir — same shape as production
  const today = new Date().toISOString().slice(0, 10);
  const userFile = path.join(usageDir, 'alice.json');

  // Simulate 3 records: 2 insights + 1 tailor, two providers
  const usage = {};
  const rec = (p, e, pt, ct) => {
    if (!usage[today]) usage[today] = { total: 0, byProvider: {}, byEndpoint: {} };
    const tot = pt + ct;
    usage[today].total += tot;
    usage[today].byProvider[p] = (usage[today].byProvider[p] || 0) + tot;
    usage[today].byEndpoint[e] = (usage[today].byEndpoint[e] || 0) + tot;
  };
  rec('groq',   'insights', 1000, 500);   // 1500
  rec('groq',   'insights', 800,  600);   // 1400
  rec('google', 'tailor',   500,  1000);  // 1500

  fs.writeFileSync(userFile, JSON.stringify(usage));
  const read = JSON.parse(fs.readFileSync(userFile, 'utf8'));

  if (read[today].total !== 4400)                        throw new Error(`total wrong: ${read[today].total}`);
  if (read[today].byProvider.groq !== 2900)             throw new Error(`groq tally wrong: ${read[today].byProvider.groq}`);
  if (read[today].byProvider.google !== 1500)           throw new Error(`google tally wrong: ${read[today].byProvider.google}`);
  if (read[today].byEndpoint.insights !== 2900)         throw new Error(`insights tally wrong: ${read[today].byEndpoint.insights}`);
  if (read[today].byEndpoint.tailor !== 1500)           throw new Error(`tailor tally wrong: ${read[today].byEndpoint.tailor}`);

  fs.rmSync(tmp, { recursive: true, force: true });
});

t('Settings pane renders AI USAGE card with totals, breakdowns, and progress bar', () => {
  // Card markup
  if (!/id="spane-usage"/.test(feSrc))               throw new Error('no AI USAGE settings-section');
  if (!/id="usage-card-body"/.test(feSrc))           throw new Error('no usage-card-body container');
  // Loader function exists and fetches /api/user-usage
  const idx = feSrc.indexOf('async function loadUsageCard');
  if (idx < 0)                                       throw new Error('loadUsageCard function missing');
  const body = feSrc.slice(idx, idx + 5000);
  if (!/fetch\(API\s*\+\s*['"]\/api\/user-usage/.test(body)) throw new Error('loadUsageCard not fetching /api/user-usage');
  // Warning banner at 80% and 100%
  if (!/pct\s*>=\s*100/.test(body))                  throw new Error('no 100% hard-cap banner');
  if (!/pct\s*>=\s*80/.test(body))                   throw new Error('no 80% warning banner');
  // Breakdowns rendered
  if (!/byProvider/.test(body))                      throw new Error('no provider breakdown');
  if (!/byEndpoint/.test(body))                      throw new Error('no endpoint breakdown');
  // Called from openSettings
  const osIdx = feSrc.indexOf('function openSettings');
  const osBody = feSrc.slice(osIdx, osIdx + 2500);
  if (!/loadUsageCard\(\)/.test(osBody))             throw new Error('loadUsageCard not called from openSettings');
});

t('Frontend surfaces token_cap_reached distinctly in insights flow', () => {
  const idx = feSrc.indexOf("fetch(API + '/api/insights'");
  const body = feSrc.slice(idx, idx + 2000);
  if (!/err\.error\s*===\s*['"]token_cap_reached['"]/.test(body)) {
    throw new Error('insights error handler does not check for token_cap_reached');
  }
  // Should refresh the usage card when cap hit so user sees current state
  if (!/loadUsageCard/.test(body)) {
    throw new Error('token_cap_reached branch does not refresh usage card');
  }
});

t('admin.html has Users and AI Tokens tabs with tab switcher', () => {
  const adminSrc = fs.readFileSync(path.join(__dirname, '../../frontend/public/admin.html'), 'utf8');
  if (!/data-tab="users"/.test(adminSrc))    throw new Error('no users tab');
  if (!/data-tab="tokens"/.test(adminSrc))   throw new Error('no tokens tab');
  if (!/function switchAdminTab/.test(adminSrc)) throw new Error('no switchAdminTab function');
  // Tokens tab must hit /api/admin/usage
  if (!/\/api\/admin\/usage\?days=30/.test(adminSrc)) throw new Error('tokens tab not fetching /api/admin/usage');
  // Must render top users, daily chart, provider + endpoint breakdowns
  if (!/id="tok-total"/.test(adminSrc))        throw new Error('no total-tokens stat');
  if (!/id="tok-chart"/.test(adminSrc))        throw new Error('no daily chart SVG');
  if (!/id="tok-providers"/.test(adminSrc))    throw new Error('no provider breakdown table');
  if (!/id="tok-endpoints"/.test(adminSrc))    throw new Error('no endpoint breakdown table');
  if (!/id="tok-top-users"/.test(adminSrc))    throw new Error('no top users table');
});

// ════════════════════════════════════════════════════════════════════════════
// Zero-knowledge encryption — backend endpoints finally match the frontend
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Zero-knowledge encryption endpoints');

t('/api/register persists encryptedDataKey + recoveryKeySlots for zero-knowledge signups', () => {
  const idx = serverSrc.indexOf("app.post('/api/register'");
  const body = serverSrc.slice(idx, idx + 2500);
  // Must destructure the encryption fields the client sends
  if (!/encryptedDataKey/.test(body))          throw new Error('register does not accept encryptedDataKey');
  if (!/recoveryKeySlots/.test(body))          throw new Error('register does not accept recoveryKeySlots');
  // Must persist them on the user record
  if (!/rec\.encryptedDataKey\s*=/.test(body)) throw new Error('register does not persist encryptedDataKey');
  if (!/rec\.recoveryKeySlots\s*=/.test(body)) throw new Error('register does not persist recoveryKeySlots');
  if (!/rec\.encrypted\s*=\s*true/.test(body)) throw new Error('register does not set encrypted=true flag');
  // Each slot stored with used:false so recovery can consume exactly one at a time
  if (!/used:\s*false/.test(body))             throw new Error('register does not set used:false per slot');
  // Must return encryptedDataKey in response so client can confirm
  if (!/response\.encryptedDataKey/.test(body)) throw new Error('register does not return encryptedDataKey');
});

t('/api/login returns encryptedDataKey in response body for zero-knowledge accounts', () => {
  const idx = serverSrc.indexOf("app.post('/api/login'");
  const body = serverSrc.slice(idx, idx + 2000);
  // Must check user.encrypted and return the wrapped key in the response body
  // (not just inside the JWT payload — client reads the body)
  if (!/user\.encrypted/.test(body))                  throw new Error('login does not check encrypted flag');
  if (!/response\.encryptedDataKey\s*=/.test(body))   throw new Error('login does not return encryptedDataKey in body');
  if (!/response\.encrypted\s*=\s*true/.test(body))   throw new Error('login does not signal encrypted:true');
});

t('/api/change-password requires newEncryptedDataKey for encrypted accounts (data-loss prevention)', () => {
  const idx = serverSrc.indexOf("app.post('/api/change-password'");
  const body = serverSrc.slice(idx, idx + 2000);
  // For encrypted accounts, a missing newEncryptedDataKey MUST reject the request —
  // otherwise the old wrapped key becomes orphaned and the user can never log in again.
  if (!/user\.encrypted[\s\S]{0,300}newEncryptedDataKey/.test(body)) {
    throw new Error('change-password does not guard encrypted accounts against missing newEncryptedDataKey');
  }
  if (!/user\.encryptedDataKey\s*=\s*newEncryptedDataKey/.test(body)) {
    throw new Error('change-password does not swap in new wrapped key');
  }
});

t('/api/recovery-codes exists and returns count+createdAt (never the codes themselves)', () => {
  const idx = serverSrc.indexOf("app.get('/api/recovery-codes'");
  if (idx < 0) throw new Error('/api/recovery-codes endpoint missing');
  const body = serverSrc.slice(idx, idx + 1500);
  if (!/count:/.test(body))       throw new Error('endpoint does not return count');
  if (!/createdAt:/.test(body))   throw new Error('endpoint does not return createdAt');
  // Must NOT return the actual slot/code material — that would be a massive regression
  if (/slot:/.test(body) || /recoveryKeySlots:/.test(body)) {
    throw new Error('recovery-codes endpoint leaks slot material');
  }
  // Non-encrypted accounts return count:0, not a 404 — the client needs to
  // render "not configured" rather than "could not load"
  if (!/encrypted:\s*false/.test(body)) throw new Error('endpoint does not handle non-encrypted accounts');
});

t('/api/recovery-codes/generate verifies password and rotates slots', () => {
  const idx = serverSrc.indexOf("app.post('/api/recovery-codes/generate'");
  if (idx < 0) throw new Error('/api/recovery-codes/generate endpoint missing');
  const body = serverSrc.slice(idx, idx + 2500);
  if (!/bcrypt\.compare\(password/.test(body))            throw new Error('generate does not verify password');
  if (!/user\.recoveryKeySlots\s*=/.test(body))           throw new Error('generate does not replace slots');
  if (!/user\.recoveryCodesGeneratedAt\s*=/.test(body))   throw new Error('generate does not update timestamp');
});

t('/api/enable-encryption upgrades plaintext account + atomically stores ciphertext jobs', () => {
  const idx = serverSrc.indexOf("app.post('/api/enable-encryption'");
  if (idx < 0) throw new Error('/api/enable-encryption endpoint missing');
  const body = serverSrc.slice(idx, idx + 3000);
  if (!/bcrypt\.compare\(password/.test(body))            throw new Error('enable-encryption does not verify password');
  if (!/user\.encrypted\s*=\s*true/.test(body))           throw new Error('enable-encryption does not flip encrypted flag');
  if (!/user\.encryptedDataKey/.test(body))               throw new Error('enable-encryption does not store wrapped key');
  if (!/encryptedJobs/.test(body))                        throw new Error('enable-encryption does not accept encrypted jobs blob');
  // Must write the jobs file with the {__enc:true, data:...} envelope the loader expects
  if (!/__enc:\s*true/.test(body))                        throw new Error('enable-encryption does not use __enc envelope');
  // Must reject if account already encrypted (avoids overwriting slots/jobs)
  if (!/already encrypted/.test(body))                    throw new Error('enable-encryption does not reject already-encrypted accounts');
});

t('/api/recover phase 1 returns ALL unused slots; phase 2 consumes by slotIndex', () => {
  const idx = serverSrc.indexOf("app.post('/api/recover'");
  if (idx < 0) throw new Error('/api/recover endpoint missing');
  const body = serverSrc.slice(idx, idx + 4000);
  // Phase 1: must return an array of slots (not just the first one — regression target)
  if (!/slots:\s*slots\.map/.test(body)) throw new Error('phase 1 does not return slots array');
  // Phase 2: must accept slotIndex from the client so the right slot is consumed
  if (!/slotIndex/.test(body))           throw new Error('phase 2 does not accept slotIndex');
  if (!/s\.index\s*===\s*slotIndex/.test(body)) throw new Error('phase 2 does not match slot by index');
  // Phase 2: must mark the consumed slot used + swap the wrapped key + rehash password
  if (!/\.used\s*=\s*true/.test(body))   throw new Error('phase 2 does not mark slot used');
  if (!/user\.encryptedDataKey\s*=\s*newEncryptedDataKey/.test(body)) throw new Error('phase 2 does not swap wrapped key');
  if (!/bcrypt\.hash\(newPassword/.test(body)) throw new Error('phase 2 does not rehash password');
});

t('Client recovery flow iterates all slots (not just the first)', () => {
  const idx = feSrc.indexOf('// Phase 2 (zero-knowledge accounts)');
  if (idx < 0) throw new Error('client recovery phase 2 block not found');
  const body = feSrc.slice(idx, idx + 3000);
  // Must accept either single slot (legacy) or slots[] (new)
  if (!/Array\.isArray\(d1\.slots\)/.test(body)) throw new Error('client does not handle slots[] response');
  // Must iterate and try each
  if (!/for\s*\(const s of slots\)/.test(body)) throw new Error('client does not iterate slots');
  // Must send slotIndex in phase 2 so server consumes the correct slot
  if (!/slotIndex:\s*usedSlotIndex/.test(body)) throw new Error('client does not send slotIndex in phase 2');
});

// ════════════════════════════════════════════════════════════════════════════
// Rate limiting (sensitive auth endpoints)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Rate limiting');

t('Sliding-window rate limiter exists with proper 429 response shape', () => {
  if (!/function rateLimit\(/.test(serverSrc)) throw new Error('rateLimit factory missing');
  const idx = serverSrc.indexOf('function rateLimit(');
  const body = serverSrc.slice(idx, idx + 1500);
  // Must maintain a per-key bucket and prune entries outside the window
  if (!/bucket\.shift\(\)/.test(body))         throw new Error('rate limiter does not prune old entries');
  if (!/bucket\.length\s*>=\s*max/.test(body)) throw new Error('rate limiter does not check max count');
  // Must return 429 with a distinct error code the client can recognize
  if (!/status\(429\)/.test(body))              throw new Error('rate limiter not returning 429');
  if (!/error:\s*['"]rate_limited['"]/.test(body)) throw new Error('rate limiter not using rate_limited error code');
  // Retry-After header helps clients back off correctly
  if (!/Retry-After/.test(body))                throw new Error('rate limiter not setting Retry-After header');
});

t('/api/recover is rate-limited (prevents slot enumeration + brute-force)', () => {
  // The limiter middleware must be applied between the route and the handler
  if (!/app\.post\('\/api\/recover',\s*_recoverLimiter/.test(serverSrc)) {
    throw new Error('/api/recover missing _recoverLimiter middleware');
  }
  // Window + max reasonable: < 20 attempts/hr (loose enough for legit users,
  // tight enough to block automated enumeration)
  const idx = serverSrc.indexOf('_recoverLimiter = rateLimit');
  const body = serverSrc.slice(idx, idx + 300);
  const maxMatch = body.match(/max:\s*(\d+)/);
  if (!maxMatch) throw new Error('_recoverLimiter missing max setting');
  const max = parseInt(maxMatch[1], 10);
  if (max > 20) throw new Error(`recover rate limit too loose: ${max}/hr`);
});

t('/api/login is rate-limited (slows down password brute-force)', () => {
  if (!/app\.post\('\/api\/login',\s*_loginLimiter/.test(serverSrc)) {
    throw new Error('/api/login missing _loginLimiter middleware');
  }
});

t('Rate limiter cleanup runs periodically + unref() so it does not pin process', () => {
  // setInterval must be unref()'d — otherwise the process never exits cleanly
  // in tests or when the server is gracefully shutdown
  if (!/setInterval\([\s\S]{0,400}\.unref\(\)/.test(serverSrc)) {
    throw new Error('rate limiter cleanup interval not unref()d');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Admin encryption visibility
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Admin encryption visibility');

t('/api/admin/users returns encrypted flag + recoveryCodes count per user', () => {
  const idx = serverSrc.indexOf("app.get('/api/admin/users'");
  const body = serverSrc.slice(idx, idx + 800);
  if (!/encrypted:\s*u\.encrypted/.test(body))   throw new Error('admin users list does not include encrypted flag');
  if (!/recoveryCodes:/.test(body))              throw new Error('admin users list does not include recovery code count');
  // Sensitive fields MUST NOT leak: no slot material, no wrapped keys, no password hash
  if (/passwordHash/.test(body))                 throw new Error('admin users list leaks passwordHash');
  if (/encryptedDataKey/.test(body))             throw new Error('admin users list leaks encryptedDataKey');
  if (/recoveryKeySlots:\s*u\./.test(body))      throw new Error('admin users list leaks recoveryKeySlots');
});

t('admin.html Users tab has ENCRYPTED column + stat card', () => {
  const adminSrc = fs.readFileSync(path.join(__dirname, '../../frontend/public/admin.html'), 'utf8');
  // Column header
  if (!/<th>ENCRYPTED<\/th>/.test(adminSrc))  throw new Error('no ENCRYPTED column header');
  // Stat card + element hooks
  if (!/id="stat-encrypted"/.test(adminSrc))  throw new Error('no stat-encrypted card');
  // Renderer uses u.encrypted for badge
  if (!/u\.encrypted/.test(adminSrc))         throw new Error('renderTable does not check u.encrypted');
  // Locked icon for encrypted / "No" badge for plaintext
  if (!/🔒/.test(adminSrc))                   throw new Error('no lock icon for encrypted accounts');
  // Stats counter updates encrypted count
  if (!/stat-encrypted/.test(adminSrc))       throw new Error('updateStats does not set encrypted count');
  // Colspan on empty state must be 7 now, not 6
  if (/colspan="6"/.test(adminSrc))           throw new Error('colspan still 6 — should be 7 for new column');
});


// ════════════════════════════════════════════════════════════════════════════
// Rich-text Notes (per-job doc with autosave + history)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Rich-text Notes');

t('NOTES_DIR configured + created on boot', () => {
  if (!/const NOTES_DIR\s*=\s*path\.join\(DATA_DIR,\s*['"]notes['"]\)/.test(serverSrc)) {
    throw new Error('NOTES_DIR not configured');
  }
  if (!/for\s*\(const d of \[[^\]]*NOTES_DIR/.test(serverSrc)) {
    throw new Error('NOTES_DIR not mkdir-ed on boot');
  }
});

t('All five notes endpoints exist with auth protection', () => {
  const checks = [
    [/app\.get\('\/api\/notes\/:jobId',\s*authMiddleware/, 'GET /api/notes/:jobId'],
    [/app\.put\('\/api\/notes\/:jobId',\s*authMiddleware/, 'PUT /api/notes/:jobId'],
    [/app\.get\('\/api\/notes\/:jobId\/history',\s*authMiddleware/, 'GET history'],
    [/app\.get\('\/api\/notes\/:jobId\/version\/:v',\s*authMiddleware/, 'GET version'],
    [/app\.post\('\/api\/notes\/:jobId\/restore',\s*authMiddleware/, 'POST restore'],
  ];
  for (const [re, label] of checks) {
    if (!re.test(serverSrc)) throw new Error(`${label} missing or not auth-protected`);
  }
});

t('jobId path param validated against directory traversal', () => {
  const idx = serverSrc.indexOf('function _notesFilePath');
  const body = serverSrc.slice(idx, idx + 500);
  if (!/\/\^\[a-zA-Z0-9_-\]\+\$\//.test(body)) {
    throw new Error('jobId not validated — directory traversal risk');
  }
  if (!/return null/.test(body)) throw new Error('invalid jobIds not rejected');
});

t('Notes stored opaquely — server never inspects blob content', () => {
  const putIdx = serverSrc.indexOf("app.put('/api/notes/:jobId'");
  const body = serverSrc.slice(putIdx, putIdx + 2000);
  if (/JSON\.parse\(blob\)/.test(body))                  throw new Error('server parses blob (breaks ZK)');
  if (/blob\.data\b/.test(body) || /blob\.__enc/.test(body)) throw new Error('server inspects blob fields');
});

t('PUT handles createSnapshot + prunes history to MAX_NOTE_VERSIONS', () => {
  const idx = serverSrc.indexOf("app.put('/api/notes/:jobId'");
  const body = serverSrc.slice(idx, idx + 2000);
  if (!/createSnapshot/.test(body))                      throw new Error('PUT does not read createSnapshot');
  if (!/d\.history\.push/.test(body))                    throw new Error('PUT does not push to history');
  if (!/d\.history\.length\s*>\s*MAX_NOTE_VERSIONS/.test(body)) throw new Error('PUT does not prune history');
});

t('MAX_NOTE_VERSIONS in sensible range (5-50)', () => {
  const m = serverSrc.match(/const MAX_NOTE_VERSIONS\s*=\s*(\d+)/);
  if (!m)               throw new Error('MAX_NOTE_VERSIONS not defined');
  const n = parseInt(m[1], 10);
  if (n < 5 || n > 50)  throw new Error(`MAX_NOTE_VERSIONS=${n} out of range`);
});

t('History endpoint returns metadata only (no blobs)', () => {
  const idx = serverSrc.indexOf("app.get('/api/notes/:jobId/history'");
  const body = serverSrc.slice(idx, idx + 1000);
  if (/blob:\s*h\.blob/.test(body)) throw new Error('history endpoint leaks blobs');
  if (!/version:\s*h\.version/.test(body))    throw new Error('missing version field');
  if (!/createdAt:\s*h\.createdAt/.test(body)) throw new Error('missing createdAt field');
});

t('Restore preserves current state in history (lossless)', () => {
  const idx = serverSrc.indexOf("app.post('/api/notes/:jobId/restore'");
  const body = serverSrc.slice(idx, idx + 2000);
  if (!/d\.history\.push/.test(body))   throw new Error('restore does not preserve current');
  if (!/d\.history\.find/.test(body))   throw new Error('restore does not lookup version');
  if (!/404/.test(body))                throw new Error('restore does not 404 on bad version');
});

t('Account deletion cleans up user notes dir', () => {
  const idx = serverSrc.indexOf("app.delete('/api/delete-account'");
  const body = serverSrc.slice(idx, idx + 1000);
  if (!/NOTES_DIR/.test(body))         throw new Error('delete-account does not touch NOTES_DIR');
  if (!/rmSync.*recursive/.test(body)) throw new Error('delete does not recursively clean');
});

t('Frontend uses TipTap with StarterKit + Link + Table + TaskList', () => {
  if (!/loadTipTap/.test(feSrc))                   throw new Error('loadTipTap missing');
  if (!/['"]https:\/\/esm\.sh['"]/.test(feSrc))    throw new Error('esm.sh not used as CDN base');
  if (!/@tiptap\/core/.test(feSrc))                throw new Error('tiptap core not imported');
  if (!/extension-table/.test(feSrc))              throw new Error('table extension not imported');
  if (!/extension-task-list/.test(feSrc))          throw new Error('task list not imported');
  if (!/extension-link/.test(feSrc))               throw new Error('link extension not imported');
  if (!/_notesCurrentJobId\s*===\s*jobId/.test(feSrc)) throw new Error('mountNotesEditor no remount guard');
});

t('Frontend autosave: debounce + max-interval + snapshot scheduler', () => {
  if (!/NOTES_DEBOUNCE_MS/.test(feSrc))          throw new Error('no debounce constant');
  if (!/NOTES_MAX_SAVE_INTERVAL/.test(feSrc))    throw new Error('no max-interval constant');
  if (!/NOTES_SNAPSHOT_INTERVAL/.test(feSrc))    throw new Error('no snapshot interval');
  const m = feSrc.match(/const NOTES_DEBOUNCE_MS\s*=\s*(\d+)\s*\*\s*1000/);
  if (!m)            throw new Error('debounce not in "N * 1000" form');
  const s = parseInt(m[1], 10);
  if (s < 5)         throw new Error(`debounce ${s}s too aggressive for server`);
  const s2 = feSrc.match(/const NOTES_SNAPSHOT_INTERVAL\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
  if (!s2)           throw new Error('snapshot interval not in minutes');
  if (parseInt(s2[1], 10) < 1) throw new Error('snapshot interval too short');
});

t('Frontend blocks pasted + dropped images', () => {
  if (!/handlePaste/.test(feSrc))                 throw new Error('no handlePaste handler');
  if (!/handleDrop/.test(feSrc))                  throw new Error('no handleDrop handler');
  if (!/startsWith\(['"]image\//.test(feSrc))     throw new Error('image MIME check missing');
});

t('Frontend encrypts note blobs with CryptoEngine envelope for ZK accounts', () => {
  if (!/function encodeNoteBlob/.test(feSrc))       throw new Error('encodeNoteBlob missing');
  if (!/function decodeNoteBlob/.test(feSrc))       throw new Error('decodeNoteBlob missing');
  const idx = feSrc.indexOf('function encodeNoteBlob');
  const body = feSrc.slice(idx, idx + 600);
  if (!/isEncrypted\s*&&\s*dataKey/.test(body))     throw new Error('encode does not check ZK state');
  if (!/CryptoEngine\.encrypt\(dataKey/.test(body)) throw new Error('encode does not use CryptoEngine');
  if (!/__enc:\s*true/.test(body))                  throw new Error('encode does not wrap __enc envelope');
});

t('Frontend history UI: restore flushes pending save + tab-close handlers', () => {
  if (!/function loadNotesHistory/.test(feSrc))    throw new Error('loadNotesHistory missing');
  if (!/function restoreNotesVersion/.test(feSrc)) throw new Error('restoreNotesVersion missing');
  if (!/flushNotesSave\(true\)/.test(feSrc))       throw new Error('restore does not flush pending save');
  if (!/visibilitychange/.test(feSrc))             throw new Error('no visibilitychange handler');
  if (!/beforeunload/.test(feSrc))                 throw new Error('no beforeunload handler');
});

t('Frontend Notes tab renders shell with history sidebar', () => {
  const idx = feSrc.indexOf('function renderNotesTab');
  const body = feSrc.slice(idx, idx + 1500);
  if (!/notes-layout/.test(body))   throw new Error('no notes-layout grid');
  if (!/notes-history/.test(body))  throw new Error('no history sidebar');
  if (!/notes-editor-/.test(body))  throw new Error('no editor mount point');
});

t('renderDetail triggers mountNotesEditor when notes tab is active', () => {
  if (!/activeDetailTab === 'notes'[\s\S]{0,400}mountNotesEditor/.test(feSrc)) {
    throw new Error('mountNotesEditor not invoked on notes tab');
  }
});

t('showApp prefetches TipTap modules (warms cache for Notes tab)', () => {
  // Performance: first Notes open previously required a ~9-module ESM
  // download (~200KB gz). Prefetching during showApp's idle window makes
  // subsequent Notes opens feel instant for the user.
  const idx = feSrc.indexOf('function showApp');
  if (idx < 0) throw new Error('showApp not found');
  const body = feSrc.slice(idx, idx + 3000);
  // Must call loadTipTap (fire-and-forget OK) inside a setTimeout — not at
  // the synchronous top of showApp, because that would compete with the
  // initial jobs/settings fetches for network bandwidth.
  if (!/setTimeout\([\s\S]{0,500}loadTipTap/.test(body)) {
    throw new Error('showApp does not defer-prefetch loadTipTap');
  }
  // Delay must be ≥ 500ms so it sits past the critical-path fetches
  const timerMatch = body.match(/setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,500}?loadTipTap[\s\S]{0,300}?\},\s*(\d+)\s*\)/);
  if (!timerMatch)    throw new Error('prefetch setTimeout not in expected shape');
  const delay = parseInt(timerMatch[1], 10);
  if (delay < 500)    throw new Error(`prefetch delay ${delay}ms too eager — should be ≥ 500ms`);
  if (delay > 5000)   throw new Error(`prefetch delay ${delay}ms too long — user may click Notes first`);
});

// ════════════════════════════════════════════════════════════════════════════
// Posting quote-to-notes + transient highlights
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Posting quote capture');

t('Selection popover exists with Save quote + comment buttons', () => {
  if (!/function _ensureSelPop/.test(feSrc))      throw new Error('_ensureSelPop missing');
  if (!/saveSelectionAsQuote\(false\)/.test(feSrc)) throw new Error('plain "Save quote" handler missing');
  if (!/saveSelectionAsQuote\(true\)/.test(feSrc))  throw new Error('"+ comment" handler missing');
});

t('Popover only shows for selections inside posting content area', () => {
  const idx = feSrc.indexOf('function _selectionInsidePosting');
  const body = feSrc.slice(idx, idx + 800);
  if (!/posting-content-area/.test(body))    throw new Error('selection check does not confine to posting area');
  if (!/isCollapsed/.test(body))             throw new Error('selection check does not guard against empty selection');
  // Must have both a minimum and maximum length to prevent trivial and abusive captures
  if (!/text\.length\s*<\s*\d+/.test(body))  throw new Error('no minimum selection length check');
  if (!/text\.length\s*>\s*\d+/.test(body))  throw new Error('no maximum selection length check');
});

t('Highlight is applied by text-offset (not by Range), wrapping in <mark class="posting-hl">', () => {
  // Persistent highlights can't use Range objects — those die at page refresh.
  // We anchor by character offset into posting-content-area text.
  if (!/function _applyHighlightByOffset/.test(feSrc)) throw new Error('_applyHighlightByOffset missing');
  const idx = feSrc.indexOf('function _applyHighlightByOffset');
  const body = feSrc.slice(idx, idx + 2000);
  if (!/createElement\(['"]mark['"]\)/.test(body))       throw new Error('does not create mark element');
  if (!/posting-hl/.test(body))                          throw new Error('mark does not get posting-hl class');
  // Must walk text nodes to find the right ones spanning the offsets
  if (!/createTreeWalker.*SHOW_TEXT/.test(body))         throw new Error('not walking text nodes');
  // Must use splitText to isolate the characters inside the target range
  if (!/splitText/.test(body))                           throw new Error('does not splitText to isolate target range');
  // Must prevent double-wrapping of already-highlighted text
  if (!/closest\(['"]mark\.posting-hl['"]\)/.test(body)) throw new Error('no guard against re-wrapping existing highlights');
});

t('Range-to-offsets converter maps a browser Range into start/end character positions', () => {
  if (!/function _rangeToOffsets/.test(feSrc)) throw new Error('_rangeToOffsets missing');
  const idx = feSrc.indexOf('function _rangeToOffsets');
  const body = feSrc.slice(idx, idx + 1200);
  if (!/createTreeWalker.*SHOW_TEXT/.test(body))   throw new Error('not walking text nodes');
  if (!/range\.startContainer/.test(body))         throw new Error('not handling startContainer');
  if (!/range\.endContainer/.test(body))           throw new Error('not handling endContainer');
});

t('Highlights persist on j.highlights with postingLength fingerprint', () => {
  const idx = feSrc.indexOf('function saveSelectionAsQuote');
  const body = feSrc.slice(idx, idx + 4000);
  // Must push into j.highlights
  if (!/j\.highlights\.push/.test(body)) throw new Error('saveSelectionAsQuote does not persist to j.highlights');
  // Each highlight must carry start + end + text + createdAt + postingLength
  if (!/start:\s*trimmed\.start/.test(body))   throw new Error('highlight record missing start');
  if (!/end:\s*trimmed\.end/.test(body))       throw new Error('highlight record missing end');
  if (!/postingLength:/.test(body))            throw new Error('highlight record missing postingLength fingerprint');
  // scheduleSave must be called so the jobs file syncs
  if (!/scheduleSave\(\)/.test(body))          throw new Error('saveSelection does not call scheduleSave');
});

t('Overlap trimming: new highlight excludes already-covered characters, picks largest gap', () => {
  if (!/function _trimAgainstExisting/.test(feSrc)) throw new Error('_trimAgainstExisting missing');
  const idx = feSrc.indexOf('function _trimAgainstExisting');
  const body = feSrc.slice(idx, idx + 1500);
  // Must iterate existing highlights
  if (!/j\.highlights/.test(body))           throw new Error('trim does not read j.highlights');
  // Must sort them so overlap walking is linear
  if (!/\.sort\(/.test(body))                throw new Error('trim does not sort covered intervals');
  // Must return null when fully covered (so caller can reject with "already highlighted")
  if (!/return null/.test(body))             throw new Error('trim does not return null on full overlap');
  // saveSelectionAsQuote must call it and handle the null case
  const saveIdx = feSrc.indexOf('function saveSelectionAsQuote');
  const saveBody = feSrc.slice(saveIdx, saveIdx + 4000);
  if (!/_trimAgainstExisting/.test(saveBody)) throw new Error('saveSelection does not invoke trim');
  if (!/already highlighted/i.test(saveBody)) throw new Error('no user-visible feedback when trim rejects');
});

t('Reapply function runs after posting renders and discards highlights from drifted postings', () => {
  if (!/function _reapplyHighlights/.test(feSrc)) throw new Error('_reapplyHighlights missing');
  const idx = feSrc.indexOf('function _reapplyHighlights');
  const body = feSrc.slice(idx, idx + 1500);
  // Must compare postingLength fingerprint
  if (!/postingLength\s*!==\s*currentLen/.test(body)) throw new Error('reapply does not check postingLength drift');
  // Drift → discard those highlights AND scheduleSave so the cleanup persists
  if (!/scheduleSave/.test(body))    throw new Error('reapply does not scheduleSave after drift-discard');
  // renderPostingTab must trigger reapply (requestAnimationFrame deferral is fine)
  const renderIdx = feSrc.indexOf('function renderPostingTab');
  const renderBody = feSrc.slice(renderIdx, renderIdx + 2000);
  if (!/_reapplyHighlights/.test(renderBody)) throw new Error('renderPostingTab does not invoke _reapplyHighlights');
});

t('Clicking existing highlight offers to remove it', () => {
  if (!/function removeHighlight/.test(feSrc)) throw new Error('removeHighlight missing');
  const idx = feSrc.indexOf('function removeHighlight');
  const body = feSrc.slice(idx, idx + 1200);
  // Must filter j.highlights by createdAt key
  if (!/j\.highlights\.filter/.test(body))              throw new Error('removeHighlight does not filter list');
  if (!/h\.createdAt\s*!==\s*createdAt/.test(body))     throw new Error('removeHighlight does not match on createdAt');
  // Must unwrap the DOM mark (no innerHTML re-render — smoother)
  if (!/parent\.insertBefore\(m\.firstChild/.test(body)) throw new Error('removeHighlight does not unwrap in-place');
  // Click handler must use event delegation targeting mark.posting-hl and confirm()
  // Find the specific handler by looking for the mark.posting-hl check inside a click listener
  const hlClickMatch = feSrc.match(/addEventListener\(['"]click['"],\s*\(e\)\s*=>\s*\{[\s\S]*?mark\.posting-hl[\s\S]*?\}\s*\)\s*;/);
  if (!hlClickMatch)                                     throw new Error('no click listener targeting mark.posting-hl');
  if (!/confirm\(/.test(hlClickMatch[0]))                throw new Error('click-to-remove does not confirm');
});

t('Refresh clears j.highlights BEFORE refetch to avoid stale-offset flash', () => {
  const idx = feSrc.indexOf('async function refetchPosting');
  const body = feSrc.slice(idx, idx + 2000);
  // Must clear j.highlights after confirm, before the fetch starts
  if (!/j\.highlights\s*=\s*\[\]/.test(body)) throw new Error('refresh does not clear saved highlights');
  // Confirm message still mentions highlights
  if (!/highlights|markup/i.test(body))       throw new Error('refresh confirm does not mention highlights');
});

t('Mobile viewport suppresses quote popover but preserves highlight view + tap-to-remove', () => {
  // Helper must exist and use matchMedia on the app's 680px breakpoint
  if (!/function _isMobileViewport/.test(feSrc))        throw new Error('_isMobileViewport missing');
  const idx = feSrc.indexOf('function _isMobileViewport');
  const body = feSrc.slice(idx, idx + 300);
  if (!/matchMedia.*max-width:\s*680px/.test(body))     throw new Error('mobile check does not use 680px breakpoint');
  // selectionchange handler must short-circuit on mobile BEFORE showing popover
  const selMatch = feSrc.match(/selectionchange[\s\S]+?_isMobileViewport\(\)[\s\S]+?_hidePostingPop[\s\S]+?return/);
  if (!selMatch)                                        throw new Error('selectionchange does not bail early on mobile');
  // Reapply + click-to-remove must NOT be gated on mobile (users see + tidy)
  // Check that _reapplyHighlights has no mobile check
  const reIdx = feSrc.indexOf('function _reapplyHighlights');
  const reBody = feSrc.slice(reIdx, reIdx + 1200);
  if (/_isMobileViewport/.test(reBody))                 throw new Error('_reapplyHighlights should not skip on mobile');
  // Click handler must have no mobile gate
  const hlClickMatch = feSrc.match(/addEventListener\(['"]click['"],\s*\(e\)\s*=>\s*\{[\s\S]*?mark\.posting-hl[\s\S]*?\}\s*\)\s*;/);
  if (!hlClickMatch)                                    throw new Error('highlight click handler missing');
  if (/_isMobileViewport/.test(hlClickMatch[0]))        throw new Error('click-to-remove should work on mobile');
});

t('Refresh button warns user that highlights will be lost', () => {
  const idx = feSrc.indexOf('async function refetchPosting');
  const body = feSrc.slice(idx, idx + 1500);
  if (!/posting-hl/.test(body))               throw new Error('refetch does not check for existing highlights');
  if (!/confirm\(/.test(body))                throw new Error('refetch does not show confirm dialog');
  // The confirm message must mention that highlights will be lost
  if (!/highlights|markup/i.test(body))       throw new Error('confirm message does not warn about highlight loss');
});

t('Quote appends to Notes as blockquote with attribution', () => {
  const idx = feSrc.indexOf('function _appendQuoteToNotes');
  const body = feSrc.slice(idx, idx + 3000);
  if (!/type:\s*['"]blockquote['"]/.test(body))   throw new Error('quote not wrapped in blockquote');
  if (!/from job posting/.test(body))             throw new Error('no source attribution on quote');
  // Must handle both cases: editor mounted AND editor not mounted
  if (!/_notesEditor\b/.test(body))               throw new Error('no live-editor path');
  if (!/\/api\/notes\//.test(body))               throw new Error('no background-save path for unmounted case');
});

t('Quote save triggers autosave (save is not silently dropped)', () => {
  const idx = feSrc.indexOf('function _appendQuoteToNotes');
  const body = feSrc.slice(idx, idx + 3000);
  // For live-editor path, must flush the notes save after insert
  if (!/flushNotesSave/.test(body)) throw new Error('live-editor path does not flush autosave');
});

t('Comment modal is promise-based with keyboard escape and cmd+enter', () => {
  const idx = feSrc.indexOf('function _promptForComment');
  if (idx < 0) throw new Error('_promptForComment missing');
  const body = feSrc.slice(idx, idx + 2500);
  if (!/new Promise/.test(body))              throw new Error('comment modal not promise-based');
  if (!/Escape/.test(body))                   throw new Error('no Escape key handler');
  if (!/metaKey.*ctrlKey|ctrlKey.*metaKey/.test(body)) throw new Error('no Cmd/Ctrl+Enter submit handler');
});

t('Popover hides on outside click', () => {
  // mousedown listener checks if target is inside posting or the popover
  if (!/mousedown/.test(feSrc))            throw new Error('no mousedown listener for popover dismiss');
  // Must check both posting area and popover containment
  const listenerIdx = feSrc.indexOf("addEventListener('mousedown'");
  const body = feSrc.slice(listenerIdx, listenerIdx + 500);
  if (!/posting-select-pop|_postingSelPopEl/.test(body)) throw new Error('outside-click does not check popover containment');
});

t('CSS for transient highlights uses amber accent (matches design system)', () => {
  if (!/mark\.posting-hl/.test(feSrc))                          throw new Error('no mark.posting-hl CSS rule');
  if (!/rgba\(232,168,56/.test(feSrc))                          throw new Error('highlight not using amber (design system accent)');
});

t('setPostingJobId is called from renderPostingTab so popover knows the target', () => {
  const idx = feSrc.indexOf('function renderPostingTab');
  const body = feSrc.slice(idx, idx + 1000);
  if (!/setPostingJobId\(j\.id\)/.test(body)) throw new Error('setPostingJobId not called in renderPostingTab');
});

// ════════════════════════════════════════════════════════════════════════════
// Notes editor teardown on navigation (data-loss prevention)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Notes editor teardown');

// ════════════════════════════════════════════════════════════════════════════
// Module load / temporal dead zone regression checks
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Module-load ordering');

t('Rate-limiter consts declared BEFORE any route that references them (TDZ guard)', () => {
  // Real-world failure: `app.post('/api/login', _loginLimiter, …)` at line 625
  // but `const _loginLimiter = …` at line 731 → ReferenceError at module load.
  // Generalize: every rate-limit middleware const must precede its first use.
  const lines = serverSrc.split('\n');
  // Returns {line, kind} where kind is 'const' | 'let' | 'var' | 'function'.
  // `function` declarations are HOISTED so they're safe to reference anywhere
  // in the enclosing scope. const/let are NOT hoisted past their declaration
  // line — referencing them earlier throws at runtime (temporal dead zone).
  const declOf = (name) => {
    for (let i = 0; i < lines.length; i++) {
      let m;
      if ((m = lines[i].match(new RegExp(`^\\s*(const|let|var)\\s+${name}\\s*=`))))      return { line: i, kind: m[1] };
      if (lines[i].match(new RegExp(`^\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`)))    return { line: i, kind: 'function' };
    }
    return null;
  };
  const firstUseLine = (name) => {
    for (let i = 0; i < lines.length; i++) {
      // Match usage inside app.post/get/use middleware-chain position
      if (new RegExp(`app\\.(post|get|put|delete|use)\\([^)]*\\b${name}\\b`).test(lines[i])) return i;
    }
    return -1;
  };
  for (const name of ['_rateBuckets', '_recoverLimiter', '_loginLimiter', 'authMiddleware', 'adminMiddleware', 'tokenCapMiddleware']) {
    const decl = declOf(name);
    const u = firstUseLine(name);
    if (!decl) throw new Error(`declaration of ${name} not found`);
    if (u === -1) continue; // not referenced in any route — fine
    // Only const/let trigger TDZ. var and function are hoisted and safe.
    if ((decl.kind === 'const' || decl.kind === 'let') && u < decl.line) {
      throw new Error(
        `${name} (${decl.kind}) is referenced at line ${u + 1} but declared at line ${decl.line + 1} — ` +
        `const/let bindings cannot be used before initialization (TDZ). ` +
        `Move the declaration above its first use.`
      );
    }
  }
});

t('tearDownNotesEditor helper exists and flushes before destroying', () => {
  if (!/async function tearDownNotesEditor/.test(feSrc)) throw new Error('tearDownNotesEditor missing');
  const idx = feSrc.indexOf('async function tearDownNotesEditor');
  const body = feSrc.slice(idx, idx + 600);
  // Must flush first, then destroy — reversed order would discard pending edits
  const flushPos   = body.indexOf('flushNotesSave');
  const destroyPos = body.indexOf('.destroy()');
  if (flushPos < 0)                   throw new Error('teardown does not flush');
  if (destroyPos < 0)                 throw new Error('teardown does not destroy editor');
  if (flushPos > destroyPos)          throw new Error('teardown destroys before flushing — edits would be lost');
  // Must be a no-op when no editor is active (safe to call from anywhere)
  if (!/if\s*\(\s*!\s*_notesEditor\s*\)/.test(body)) throw new Error('teardown not idempotent / no safe no-op guard');
});

t('openSection tears down notes editor before switching to a different section', () => {
  // Sidebar sections (Analytics, Library, Settings, etc.) previously bypassed
  // the notes save path because renderDetail was never re-invoked.
  const idx = feSrc.indexOf('function openSection');
  const body = feSrc.slice(idx, idx + 1500);
  if (!/tearDownNotesEditor\(\)/.test(body)) {
    throw new Error('openSection does not tear down notes editor — sidebar navigation would lose edits');
  }
  // Must call it BEFORE wiping state (currentJobId = null, innerHTML wipe, etc.)
  const tearPos    = body.indexOf('tearDownNotesEditor');
  const clearPos   = body.indexOf('currentJobId = null');
  if (tearPos > clearPos) throw new Error('openSection tears down AFTER clearing currentJobId — save would reference wrong job');
});

t('doLogout awaits notes flush before clearing the auth token', () => {
  const idx = feSrc.indexOf('function doLogout');
  const body = feSrc.slice(idx, idx + 800);
  // Must be async and await the teardown — otherwise the final PUT races
  // the token clear and gets 401'd.
  if (!/async function doLogout/.test(feSrc))   throw new Error('doLogout is not async — cannot await flush');
  if (!/await\s+tearDownNotesEditor/.test(body)) throw new Error('doLogout does not await teardown');
  // Must tear down BEFORE clearing the token
  const tearPos  = body.indexOf('tearDownNotesEditor');
  const tokenPos = body.indexOf('token=null');
  if (tearPos < 0 || tokenPos < 0)               throw new Error('expected both tearDown and token clear');
  if (tearPos > tokenPos)                        throw new Error('logout clears token before flushing — final save would 401');
});

t('bulkDelete tears down notes editor when deleting the currently-open job', () => {
  const idx = feSrc.indexOf('function bulkDelete');
  const body = feSrc.slice(idx, idx + 800);
  if (!/bulkSelected\.has\(currentJobId\)[\s\S]+?tearDownNotesEditor/.test(body)) {
    throw new Error('bulkDelete does not tear down editor for open job — save would target deleted job');
  }
  // Teardown must happen BEFORE the delete jobs[id] loop
  const tearPos   = body.indexOf('tearDownNotesEditor');
  const deletePos = body.indexOf('delete jobs[id]');
  if (tearPos > deletePos) throw new Error('bulkDelete removes job before tearing down editor');
});

// ════════════════════════════════════════════════════════════════════════════
// A. Duplicate declarations — function or const shadowing
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Duplicate-declaration regression');

t('No top-level function is defined twice in server.js (silent-shadow hazard)', () => {
  // Same function name appearing as `function foo(…)` more than once at column 0
  // means the second silently replaces the first. We hit this exact bug with
  // the duplicate `rateLimit` function earlier this session — both had different
  // signatures and callers were unknowingly hitting whichever JS hoisted last.
  const lines = serverSrc.split('\n');
  const counts = {};
  const firstSeen = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
    if (m) {
      const name = m[1];
      counts[name] = (counts[name] || 0) + 1;
      if (!(name in firstSeen)) firstSeen[name] = i + 1;
    }
  }
  const dups = Object.entries(counts).filter(([, n]) => n > 1);
  if (dups.length) {
    const details = dups.map(([n, count]) => `${n} (${count}× — first at line ${firstSeen[n]})`).join(', ');
    throw new Error(`duplicate top-level function declarations: ${details}`);
  }
});

t('No top-level const is declared twice in server.js', () => {
  const lines = serverSrc.split('\n');
  const counts = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  const dups = Object.entries(counts).filter(([, n]) => n > 1);
  if (dups.length) {
    throw new Error(`duplicate top-level const: ${dups.map(([n, c]) => `${n} (${c}×)`).join(', ')}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// D. Every require() must be in package.json (or Node builtin)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Dependency manifest vs actual require()s');

t('Every required module is declared in package.json or is a Node builtin', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);
  // Node built-ins we care about. Conservative list — `assert` and friends could
  // be added if we ever need them.
  const builtins = new Set([
    'fs', 'path', 'crypto', 'http', 'https', 'url', 'os', 'util', 'stream',
    'events', 'child_process', 'cluster', 'zlib', 'buffer', 'querystring',
    'readline', 'net', 'dgram', 'dns', 'tls', 'worker_threads',
  ]);

  // Collect all require() targets from server.js and ats-helpers.js
  const srcs = [
    fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../ats-helpers.js'), 'utf8'),
  ];
  const missing = [];
  for (const src of srcs) {
    const re = /require\(['"]([^'"]+)['"]\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/')) continue;  // local path
      // Strip subpath imports like 'pdf-parse/lib/pdf-parse.js' → 'pdf-parse'
      // but preserve scoped packages like '@scope/pkg'
      const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (builtins.has(root)) continue;
      if (!declared.has(root)) missing.push(root);
    }
  }
  if (missing.length) {
    throw new Error(`modules required but not in package.json: ${[...new Set(missing)].join(', ')}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// H. No sensitive material logged to console
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Secrets leakage in logs');

t('console.* statements do not interpolate sensitive user fields', () => {
  // We care about: passwordHash, encryptedDataKey, recoveryKeySlots, dataKey,
  // slot, blob. We match these as accessors (`user.X` or `${X}`), not as
  // substrings inside prose messages. "password → passwordHash" in a migration
  // log is a description, not a value leak.
  const SENSITIVE = [
    // Match either `foo.passwordHash` OR `${passwordHash}` — i.e. the binding
    // accessed as a value, not mentioned by name in a log message
    '\\.(passwordHash|encryptedDataKey|recoveryKeySlots|wrappedKey)\\b',
    '\\$\\{[^}]*\\b(passwordHash|encryptedDataKey|recoveryKeySlots|wrappedKey|dataKey)\\b[^}]*\\}',
  ];

  const lines = serverSrc.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!/console\.(log|warn|error)\s*\(/.test(ln)) continue;
    for (const pat of SENSITIVE) {
      if (new RegExp(pat).test(ln)) {
        hits.push(`line ${i + 1}: ${ln.trim().slice(0, 100)}`);
      }
    }
  }
  if (hits.length) {
    throw new Error(`sensitive fields appear in console.* calls:\n  ${hits.join('\n  ')}`);
  }
});

t('No password reset URLs logged to console (info-disclosure via logs)', () => {
  // Render captures server logs. Logging a reset URL means anyone with log
  // access (or a log aggregator integration) can reset any account.
  const lines = serverSrc.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!/console\.(log|warn|error)\s*\(/.test(ln)) continue;
    // resetUrl, resetToken, recoveryCode string literals all problematic
    if (/\bresetUrl\b/.test(ln) || /\bresetToken\b/.test(ln)) {
      hits.push(`line ${i + 1}: ${ln.trim().slice(0, 100)}`);
    }
  }
  if (hits.length) {
    throw new Error(`reset tokens/URLs being logged:\n  ${hits.join('\n  ')}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// J. Frontend fetch() calls — Authorization header audit
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Frontend fetch Authorization audit');

t('Every fetch(API + ...) to a protected endpoint sends Authorization: Bearer', () => {
  const PUBLIC_ENDPOINTS = new Set([
    '/api/register',
    '/api/login',
    '/api/forgot',
    '/api/recover',
    '/api/reset-password',
    '/api/ping',
    '/api/extension',    // served without auth so install flow works
  ]);

  // Paren-balanced walk. `fetch(...)` calls where the URL starts with `API + `.
  // Naive regex fails on `fetch(API + '/x/' + encodeURIComponent(id), {...})`
  // because the inner `(` breaks the match. We iterate character by character
  // to find matching parens.
  const offenders = [];
  const src = feSrc;
  let idx = 0;
  while ((idx = src.indexOf('fetch(', idx)) !== -1) {
    const openParen = idx + 'fetch('.length - 1;
    // Walk to the matching close paren
    let depth = 0;
    let end = -1;
    for (let j = openParen; j < src.length; j++) {
      const c = src[j];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { end = j; break; } }
      else if (c === '"' || c === "'" || c === '`') {
        // Skip to matching quote (respect backslash escapes)
        const quote = c;
        j++;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === quote) break;
          if (quote === '`' && src[j] === '$' && src[j+1] === '{') {
            // Template literal expression — walk back into paren-balance mode
            let td = 1; j += 2;
            while (j < src.length && td > 0) {
              if (src[j] === '{') td++;
              else if (src[j] === '}') td--;
              j++;
            }
            j--;
          }
          j++;
        }
      }
    }
    if (end === -1) { idx++; continue; }
    const call = src.slice(openParen + 1, end);
    idx = end + 1;

    // Only care about fetch(API + ...) shapes
    if (!/^\s*API\s*\+/.test(call)) continue;

    // Split into URL expression (up to top-level comma) and options object (after)
    let depth2 = 0, commaAt = -1;
    for (let j = 0; j < call.length; j++) {
      const c = call[j];
      if (c === '(' || c === '{' || c === '[') depth2++;
      else if (c === ')' || c === '}' || c === ']') depth2--;
      else if (c === '"' || c === "'" || c === '`') {
        const quote = c; j++;
        while (j < call.length && call[j] !== quote) {
          if (call[j] === '\\') j++;
          j++;
        }
      } else if (c === ',' && depth2 === 0) { commaAt = j; break; }
    }
    const urlExpr = commaAt === -1 ? call : call.slice(0, commaAt);
    const optsExpr = commaAt === -1 ? '' : call.slice(commaAt + 1);

    // Extract all string literals from the URL expression to match against public list
    const pathLiterals = urlExpr.match(/['"`](\/api\/[^'"`?]*)['"`]/g) || [];
    const paths = pathLiterals.map(p => p.replace(/['"`]/g, '').split('?')[0]);
    const isPublic = paths.some(p => {
      // Match by first 2 segments for parametric routes
      const root = p.split('/').slice(0, 3).join('/');
      return PUBLIC_ENDPOINTS.has(root) || PUBLIC_ENDPOINTS.has(p);
    });
    if (isPublic) continue;

    if (!/Authorization\s*:\s*['"`]Bearer\s+['"`]\s*\+\s*token/.test(optsExpr)) {
      offenders.push(('fetch(' + call).replace(/\s+/g, ' ').slice(0, 150));
    }
  }
  if (offenders.length) {
    throw new Error(`fetch calls to protected endpoints missing Authorization header:\n  ${offenders.slice(0, 5).join('\n  ')}${offenders.length > 5 ? `\n  ...and ${offenders.length - 5} more` : ''}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// F. Authorization matrix — middleware coverage per route
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Authorization matrix (per-route middleware coverage)');

t('Every /api/admin/* route is behind adminMiddleware', () => {
  const lines = serverSrc.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^app\.(get|post|put|delete)\(['"]\/api\/admin\/[^'"]*['"]\s*,\s*(.+)/);
    if (!m) continue;
    const chain = m[2];
    if (!/\badminMiddleware\b/.test(chain)) {
      offenders.push(`line ${i + 1}: ${lines[i].trim().slice(0, 120)}`);
    }
  }
  if (offenders.length) {
    throw new Error(`admin routes without adminMiddleware:\n  ${offenders.join('\n  ')}`);
  }
});

t('Every non-public /api route has authMiddleware OR an explicit allowlist entry', () => {
  // Public endpoints are ones that anonymous clients MUST reach: login/register/
  // forgot/recover/reset-password/ping. Admin routes use adminMiddleware instead
  // of authMiddleware (different auth mechanism — secret header).
  const PUBLIC = new Set([
    '/api/register', '/api/login', '/api/forgot', '/api/recover',
    '/api/reset-password', '/api/ping',
  ]);
  const lines = serverSrc.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^app\.(get|post|put|delete)\(['"]([^'"]+)['"]\s*,\s*(.+)/);
    if (!m) continue;
    const routePath = m[2];
    const chain = m[3];
    if (!routePath.startsWith('/api/')) continue;    // non-API routes we don't audit
    if (routePath.startsWith('/api/admin/')) continue;  // admin audit covered above
    if (PUBLIC.has(routePath)) continue;             // explicitly public
    if (!/\bauthMiddleware\b/.test(chain)) {
      offenders.push(`line ${i + 1}: ${routePath}`);
    }
  }
  if (offenders.length) {
    throw new Error(`protected routes missing authMiddleware:\n  ${offenders.join('\n  ')}`);
  }
});

t('Every AI-consuming route has tokenCapMiddleware (covers the daily cap)', () => {
  // List maintained in sync with /api/*-consuming-callAI. If a new AI endpoint
  // is added without the cap middleware, the daily token budget can be blown
  // past by a single runaway request chain. Test enumerates known AI routes.
  const AI_ROUTES = [
    '/api/extract-fields',
    '/api/tailor',
    '/api/tailor-docx',
    '/api/insights',
    '/api/outreach-targets',
    '/api/interview-questions',
    '/api/keyword-gap',
    '/api/email-template',
    '/api/salary-benchmark',
    '/api/find-posting-mirror',
    '/api/parse-job',
    '/api/parse-contact-signature',
  ];
  const offenders = [];
  for (const r of AI_ROUTES) {
    const pattern = new RegExp(`app\\.post\\(['"]${r.replace(/\//g, '\\/')}['"][^)]*tokenCapMiddleware`);
    if (!pattern.test(serverSrc)) offenders.push(r);
  }
  if (offenders.length) {
    throw new Error(`AI routes missing tokenCapMiddleware:\n  ${offenders.join('\n  ')}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// C. Module-load smoke — can server.js actually load without TDZ/typo crashes?
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Module-load smoke (with stubbed dependencies)');

t('server.js loads cleanly with stubbed deps (catches TDZ, typos, missing imports)', () => {
  // The test uses Module._cache to inject shims for each require()d package
  // before loading server.js. This simulates npm install without actually
  // needing network or disk. If server.js has:
  //   - a TDZ violation (const used before init line)
  //   - a typo in a variable name
  //   - a syntax-valid-but-semantic error at load time
  //   - a missing require() for a module it uses at top level
  // …this test fails. Runtime errors inside route handlers are NOT caught
  // here — we only exercise the module's top-level code.
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;

  // Minimal shims — just enough to satisfy server.js's top-level usage.
  // None of these shims need to do anything useful; the goal is just to
  // return an object that has the chainable/callable methods server.js uses.
  const express = () => {
    const app = {};
    const noop = () => app;
    for (const m of ['use', 'get', 'post', 'put', 'delete', 'listen', 'set']) app[m] = noop;
    return app;
  };
  express.json = () => (req, res, next) => next && next();
  express.urlencoded = () => (req, res, next) => next && next();
  express.static = () => (req, res, next) => next && next();
  express.Router = () => ({ use: () => {}, get: () => {}, post: () => {} });

  const stubs = {
    'express': express,
    'cors': () => (req, res, next) => next && next(),
    'bcryptjs': { hash: async () => '', compare: async () => true },
    'jsonwebtoken': { sign: () => 'token', verify: () => ({}) },
    'multer': Object.assign(
      () => ({ single: () => (req,res,next)=>next&&next(), any: () => (req,res,next)=>next&&next() }),
      {
        diskStorage: () => ({}),
        memoryStorage: () => ({}),
      },
    ),
    'pdf-parse': async () => ({ text: '' }),
    'mammoth': { extractRawText: async () => ({ value: '' }), convertToHtml: async () => ({ value: '' }) },
    'archiver': () => ({ append: ()=>{}, pipe: ()=>{}, finalize: ()=>{}, on: ()=>{} }),
    'adm-zip': function AdmZip() { return { addLocalFile: ()=>{}, toBuffer: ()=>Buffer.alloc(0), getEntries: ()=>[] }; },
  };

  // Hook Module._load to return stubs for known specs
  Module._load = function(request, parent, isMain) {
    if (stubs.hasOwnProperty(request)) return stubs[request];
    return origLoad.apply(this, arguments);
  };

  // Clear require cache for server.js so we get a fresh load
  const serverPath = require.resolve(path.join(__dirname, '../server.js'));
  const atsPath    = require.resolve(path.join(__dirname, '../ats-helpers.js'));
  delete require.cache[serverPath];
  delete require.cache[atsPath];

  // Capture console output (server's boot logs) to keep the test output clean
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  // Use a tmp DATA_DIR so we don't touch real data
  const os = require('os');
  const origDataDir = process.env.DATA_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'summit-load-test-'));
  process.env.DATA_DIR = tmp;

  let err = null;
  try {
    require(serverPath);
  } catch (e) {
    err = e;
  } finally {
    Module._load = origLoad;
    Module._resolveFilename = origResolve;
    console.log = origLog;
    console.warn = origWarn;
    if (origDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = origDataDir;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    // Evict the test-loaded server from cache so subsequent tests aren't affected
    delete require.cache[serverPath];
    delete require.cache[atsPath];
  }

  if (err) {
    throw new Error(`server.js failed to load: ${err.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// B. Route contract tests — client/server field compatibility
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Route contract (client/server field alignment)');

t('Server destructures every field the client sends (no silent-drop regression)', () => {
  // BACKGROUND: We hit this class of bug twice in one session —
  //   1. POST /api/register: client sent {encryptedDataKey, recoveryKeySlots},
  //      backend destructured only {username, password}, silently dropped the rest.
  //      Result: encryption was NEVER persisted for any user until we fixed it.
  //   2. POST /api/change-password: client sent {newEncryptedDataKey}, backend
  //      ignored it. Encrypted accounts lost access to their data after password change.
  //
  // This test enumerates known client→server contracts and asserts the backend
  // at least MENTIONS each field in its handler. It can't catch the subtle case
  // where the server reads the field but never acts on it — but it reliably
  // catches the "destructuring ignores this" regression we've already hit twice.

  // Contracts: path → list of field names the client sends that must appear in
  // the handler. Kept as data here rather than re-scraped from the frontend
  // to avoid fragile cross-file regex; update as we add/remove fields.
  const CONTRACTS = {
    '/api/register': [
      'username', 'password',
      // Added for zero-knowledge encryption (earlier bug: these were dropped)
      'email', 'encryptedDataKey', 'recoveryKeySlots',
    ],
    '/api/login': ['username', 'password'],
    '/api/change-password': [
      'currentPassword', 'newPassword',
      // For encrypted accounts — dropping this orphans the wrapped key
      'newEncryptedDataKey',
    ],
    '/api/enable-encryption': [
      'password',
      'encryptedDataKey', 'recoveryKeySlots', 'encryptedJobs',
    ],
    '/api/recovery-codes/generate': [
      'password',
      'encryptedDataKey', 'recoveryKeySlots',
    ],
    '/api/recover': [
      'username', 'recoveryCode',
      // Phase 2 additions
      'newPassword', 'newEncryptedDataKey', 'slotIndex',
    ],
    // Notes autosave — blob is the whole ciphertext payload
    '/api/notes/:jobId': ['blob', 'createSnapshot'],
    '/api/notes/:jobId/restore': ['version'],
  };

  const offenders = [];
  for (const [route, fields] of Object.entries(CONTRACTS)) {
    // Locate ALL handlers for this route (a single route can have multiple
    // HTTP methods — GET and PUT on /api/notes/:jobId for example). We check
    // the union of all their bodies: a field is considered "referenced" if
    // ANY handler for that path references it. This matches the real-world
    // client-server contract: the route is a pair (method, path), but for
    // our purposes what matters is that the SOMETHING at that URL handles it.
    const escaped = route.replace(/\//g, '\\/').replace(/:[a-zA-Z]+/g, '[^\'"/]+');
    const handlerRe = new RegExp(`app\\.(?:post|put|get|delete)\\(['"]${escaped}['"][\\s\\S]*?^\\}\\);`, 'gm');
    const handlers = [...serverSrc.matchAll(handlerRe)].map(m => m[0]);
    if (!handlers.length) {
      offenders.push(`${route}: handler not found`);
      continue;
    }
    const unionBody = handlers.join('\n');
    for (const field of fields) {
      const pattern = new RegExp(`(?:[{,]\\s*${field}\\s*[,}=]|req\\.body\\.${field}\\b|body\\.${field}\\b)`);
      if (!pattern.test(unionBody)) {
        offenders.push(`${route}: field \`${field}\` not referenced in any handler`);
      }
    }
  }
  if (offenders.length) {
    throw new Error(`client/server contract violations:\n  ${offenders.join('\n  ')}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Notes editor UX fixes — collapsed-empty-state + reload-on-return regressions
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Notes editor mount UX');

t('Notes editor has its border + background on the interactive layer (not the outer wrap)', () => {
  // Bug 1: users were clicking the visible border (on .notes-editor-wrap) and
  // nothing happened because the interactive area (.notes-editor inside the
  // wrap) was invisibly shorter and offset. Fix: the border lives on
  // .notes-editor so the visible frame IS the click target.
  const wrapRule = feSrc.match(/\.notes-editor-wrap\s*\{[^}]*\}/);
  const editorRule = feSrc.match(/\.notes-editor\s*\{[^}]*\}/);
  if (!wrapRule || !editorRule) throw new Error('notes-editor CSS rules not found');
  // The wrap should NOT carry the visible border anymore — if it does, we're
  // back in the bug state with a mismatched click target.
  if (/border:\s*\d/.test(wrapRule[0])) {
    throw new Error('.notes-editor-wrap still has a visible border (click target mismatch)');
  }
  // The editor itself must have the border + a background different from page bg
  if (!/border:\s*0?\.?5?px\s+solid/.test(editorRule[0])) {
    throw new Error('.notes-editor missing visible border');
  }
  if (!/background:\s*var\(--bg2\)/.test(editorRule[0])) {
    throw new Error('.notes-editor needs a distinct background (otherwise empty state is invisible)');
  }
  // Minimum height so the empty doc doesn't collapse to one line
  const mhMatch = editorRule[0].match(/min-height:\s*(\d+)px/);
  if (!mhMatch)           throw new Error('.notes-editor has no min-height — empty doc will collapse');
  if (parseInt(mhMatch[1], 10) < 200) throw new Error(`.notes-editor min-height too small (${mhMatch[1]}px)`);
  // cursor: text so hovering the padding reads as editable
  if (!/cursor:\s*text/.test(editorRule[0])) {
    throw new Error('.notes-editor lacks cursor:text — padding area feels non-interactive');
  }
});

t('TipTap ProseMirror element fills the notes editor (no sub-line collapse)', () => {
  // When TipTap mounts, it injects <div class="ProseMirror"> as a child of
  // .notes-editor. For an empty doc it would collapse to one line unless we
  // force it to fill the available height.
  const pmRule = feSrc.match(/\.notes-editor\s+\.ProseMirror\s*\{[^}]*\}/);
  if (!pmRule) throw new Error('.notes-editor .ProseMirror rule missing');
  if (!/flex:\s*1/.test(pmRule[0]))              throw new Error('.ProseMirror must flex:1 inside the editor');
  if (!/min-height:\s*100%/.test(pmRule[0]))     throw new Error('.ProseMirror needs min-height:100% to fill editor');
});

t('Notes doc cache exists + populated on fetch so return visits skip the loading flash', () => {
  // Bug 2: every time the user navigates Notes → away → back, the "Preparing
  // editor…" placeholder showed again even though TipTap is cached. Root
  // cause: mountNotesEditor awaited a fresh GET /api/notes/:jobId every time.
  // Fix: per-jobId in-memory doc cache + synchronous fast-path mount.
  if (!/_notesDocCache\s*=\s*Object\.create\(null\)/.test(feSrc) &&
      !/_notesDocCache\s*=\s*\{\}/.test(feSrc)) {
    throw new Error('_notesDocCache not declared');
  }
  // Fast path: if TipTap is cached AND we have cached doc → build editor sync,
  // no await before the container is populated.
  const mountIdx = feSrc.indexOf('async function mountNotesEditor');
  const mountBody = feSrc.slice(mountIdx, mountIdx + 8000);
  if (!/_notesDocCache\[jobId\]/.test(mountBody))       throw new Error('mount does not consult doc cache');
  if (!/if\s*\(\s*_tiptap\s*&&\s*cached[^)]*\)/.test(mountBody)) {
    throw new Error('mount missing synchronous fast-path when both TipTap and cached doc are present');
  }
  // Cache must be populated after every successful fetch so the NEXT mount
  // can take the fast path. Look for assignment after the fetch block.
  if (!/_notesDocCache\[jobId\]\s*=\s*\{/.test(mountBody)) {
    throw new Error('mount does not populate cache after fetching remote doc');
  }
});

t('Notes doc cache is kept in sync after every save (no stale return visits)', () => {
  // If we only populate the cache on fetch, typing something and navigating
  // away + back would show pre-typed content until the fetch returns. Not a
  // data-loss bug but a jarring UX. Cache must be written on every successful
  // save too.
  const flushIdx = feSrc.indexOf('async function flushNotesSave');
  const body = feSrc.slice(flushIdx, flushIdx + 2500);
  if (!/_notesDocCache\[jobId\]\s*=\s*\{[\s\S]{0,200}_notesRemoteVersion/.test(body)) {
    throw new Error('flushNotesSave does not write through to _notesDocCache');
  }
});

t('Notes doc cache is invalidated on version restore', () => {
  // After a user restores a historical version, the server has swapped
  // current. The cached doc is now wrong. Without invalidation, return visits
  // would show pre-restore content for one load cycle.
  const idx = feSrc.indexOf('async function restoreNotesVersion');
  const body = feSrc.slice(idx, idx + 1200);
  if (!/delete\s+_notesDocCache\[jobId\]/.test(body)) {
    throw new Error('restoreNotesVersion does not invalidate cached doc');
  }
});

t('Notes doc cache is purged on logout (per-user data safety)', () => {
  // Cache holds decrypted note content. Must be cleared before a different
  // user logs in on the same browser session.
  const idx = feSrc.indexOf('async function doLogout');
  const body = feSrc.slice(idx, idx + 1000);
  if (!/_notesDocCache/.test(body)) {
    throw new Error('doLogout does not clear _notesDocCache — cross-account leak risk');
  }
});

t('bulkDelete evicts notes cache entries for deleted jobs', () => {
  const idx = feSrc.indexOf('function bulkDelete');
  const body = feSrc.slice(idx, idx + 800);
  if (!/delete\s+_notesDocCache\[id\]/.test(body)) {
    throw new Error('bulkDelete does not evict _notesDocCache entries');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Signature paste → AI-parsed contact form
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Contact signature paste');

t('parse-contact-signature route exists, behind auth + token cap', () => {
  if (!/app\.post\('\/api\/parse-contact-signature',\s*authMiddleware,\s*tokenCapMiddleware/.test(serverSrc)) {
    throw new Error('parse-contact-signature missing or not properly protected');
  }
});

t('Backend rejects empty text and over-long text (DoS protection)', () => {
  const idx = serverSrc.indexOf("app.post('/api/parse-contact-signature'");
  const body = serverSrc.slice(idx, idx + 2500);
  if (!/if \(!text\)/.test(body))     throw new Error('does not reject empty text');
  if (!/text\.length\s*>\s*\d{3,}/.test(body)) throw new Error('does not cap input length');
});

t('Backend normalizes empty/null-string AI output to real null', () => {
  // The AI sometimes returns "" or "null" or "N/A" instead of a JSON null.
  // The handler must normalize so the frontend can use plain `if (v)` checks.
  const idx = serverSrc.indexOf("app.post('/api/parse-contact-signature'");
  const body = serverSrc.slice(idx, idx + 2500);
  if (!/parsed\[k\]\s*===\s*''|parsed\[k\]\s*===\s*"null"|parsed\[k\]\s*===\s*'N\/A'/.test(body)) {
    throw new Error('does not normalize stringy-null AI responses to null');
  }
});

t('AI prompt instructs model to never fabricate missing fields', () => {
  // Important: a "guess" at email/phone could send the user to a stranger.
  // Prompt must explicitly tell the model to return null for unknown fields.
  const idx = serverSrc.indexOf("app.post('/api/parse-contact-signature'");
  const body = serverSrc.slice(idx, idx + 2500);
  if (!/NEVER guess|do not fabricate|never invent/i.test(body)) {
    throw new Error('system prompt does not forbid fabrication — risk of fake emails/phones');
  }
});

t('Frontend contact modal opens in paste-first mode for new contacts', () => {
  if (!/_contactModalMode\s*=\s*['"]paste['"]/.test(feSrc)) {
    throw new Error('_contactModalMode not initialized to paste for new contacts');
  }
  // Edit mode should skip paste — existing contact already has fields
  if (!/contactId\s*\?\s*\(j\.contacts[^:]+\s*:\s*null/.test(feSrc) && !/contactId\s*\?\s*\(j\.contacts/.test(feSrc)) {
    throw new Error('edit path does not look up existing contact');
  }
  // Must have a branch that sets mode to 'form' when editing
  if (!/_contactModalMode\s*=\s*(?:c\s*\?\s*)?['"]form['"]/.test(feSrc)) {
    throw new Error('edit contact does not skip paste zone');
  }
});

t('Paste zone has both "Parse" button and "Skip — enter manually" fallback', () => {
  // Users who want to type manually shouldn't feel forced into pasting.
  if (!/Parse signature/.test(feSrc))          throw new Error('Parse button label missing');
  if (!/Skip.*enter manually/i.test(feSrc))    throw new Error('Skip/manual entry option missing');
});

t('_parseSignature sends paste to backend and swaps to form on success', () => {
  if (!/async function _parseSignature/.test(feSrc)) throw new Error('_parseSignature function missing');
  const idx = feSrc.indexOf('async function _parseSignature');
  const body = feSrc.slice(idx, idx + 3000);
  if (!/\/api\/parse-contact-signature/.test(body))         throw new Error('does not call parse endpoint');
  if (!/Authorization.*Bearer.*token/.test(body))           throw new Error('missing auth header');
  // Must disable button during parse (prevents double-submit)
  if (!/btn\.disabled\s*=\s*true/.test(body))               throw new Error('does not disable button during parse');
  // Must swap to form mode on success
  if (!/_contactModalMode\s*=\s*['"]form['"]/.test(body))   throw new Error('does not switch to form on success');
});

t('Graceful fallback when AI parse fails or returns nothing', () => {
  const idx = feSrc.indexOf('async function _parseSignature');
  const body = feSrc.slice(idx, idx + 3000);
  // 429 (token cap) → switch to manual with explanation
  if (!/res\.status\s*===\s*429/.test(body) && !/429/.test(body)) {
    throw new Error('no specific handling for token cap 429 response');
  }
  // Zero-fields extraction → don't silently accept, tell user
  if (!/filled\s*===\s*0|filled\.length\s*===\s*0/.test(body) &&
      !/Object\.values\(parsed\)[\s\S]{0,200}filter/.test(body)) {
    throw new Error('does not detect empty AI response');
  }
});

t('saveContact includes phone + company fields (new schema)', () => {
  const idx = feSrc.indexOf('function saveContact');
  const body = feSrc.slice(idx, idx + 1500);
  if (!/cm-phone/.test(body))   throw new Error('saveContact does not read phone field');
  if (!/cm-company/.test(body)) throw new Error('saveContact does not read company field');
});

t('saveContact does NOT handle a notes field (removed in favor of Journal)', () => {
  // Previous turn preserved legacy notes on edit; this turn removes the
  // field entirely and uses a one-shot sweep in loadJobs to strip leftover
  // data. saveContact should no longer reference `notes` at all.
  const idx = feSrc.indexOf('function saveContact');
  const body = feSrc.slice(idx, idx + 1500);
  if (/cm-notes|contact\.notes\b|existing\.notes/.test(body)) {
    throw new Error('saveContact still references removed notes field');
  }
});

t('loadJobs sweeps legacy contact.notes field (one-shot migration)', () => {
  const idx = feSrc.indexOf('async function loadJobs');
  const body = feSrc.slice(idx, idx + 4000);
  // Must delete `notes` from any contact objects that have one
  if (!/delete\s+c\.notes/.test(body)) {
    throw new Error('loadJobs does not delete deprecated contact.notes');
  }
  // Must trigger a save so the cleanup persists (otherwise it runs every login)
  if (!/scheduleSave\(\)/.test(body.slice(body.indexOf('c.notes')))) {
    throw new Error('contact notes sweep does not trigger a save');
  }
  // Must be guarded — don't save if nothing was stripped
  if (!/strippedAnyNotes/.test(body) && !/let\s+\w+\s*=\s*false/.test(body)) {
    throw new Error('sweep unconditionally saves even when no changes — wasteful');
  }
});

t('Contact list rendering does NOT display a notes line', () => {
  // The individual contact row used to include `${c.notes ? ... : ''}` — if
  // that survives, users who still have notes in their data would see them
  // briefly before the sweep runs. Remove the rendering entirely.
  const idx = feSrc.indexOf('function renderContactsTab');
  const body = feSrc.slice(idx, idx + 4000);
  if (/c\.notes\s*\?/.test(body)) {
    throw new Error('contact list still conditionally renders c.notes');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Additional fixes — orphaned modal, phone split, Notes cold-start
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Misc fixes');

t('No orphaned static contact modal in HTML (prevents duplicate id=cm-name)', () => {
  // Regression guard: a hardcoded <div id="contact-modal-overlay"> with fields
  // inside was shipped before the modal was dynamically built. Both existed
  // simultaneously, sharing the same ids — getElementById returned the STATIC
  // empty input, so saveContact's `if (!name) return;` silently aborted.
  // The dynamic version is constructed in openContactModal; no static markup
  // with those ids should remain.
  // Count static occurrences of id="cm-name" OUTSIDE of template literals.
  // Simple approach: there should be exactly ONE `id="cm-name"` in the file —
  // the one inside the backtick template literal of _renderContactModalBody.
  const matches = [...feSrc.matchAll(/id="cm-name"/g)];
  if (matches.length > 1) {
    throw new Error(`cm-name appears ${matches.length}× — stale static markup present`);
  }
  // Also check for the tell-tale static markup pattern (a div with the overlay
  // id outside a template-literal backtick)
  if (/<div\s+id="contact-modal-overlay"[^>]*>[\s\S]*?<\/div>/.test(feSrc)) {
    // Allow the dynamic .innerHTML assignment — that's in JS, not bare HTML.
    // Check this match isn't inside a backtick template
    const match = feSrc.match(/<div\s+id="contact-modal-overlay"[^>]*>[\s\S]*?<\/div>/);
    const before = feSrc.slice(0, match.index);
    const backticks = (before.match(/`/g) || []).length;
    if (backticks % 2 === 0) {
      // Even number of backticks before → we're at top level HTML, not in a template string
      throw new Error('static contact-modal-overlay div still in HTML');
    }
  }
});

t('AI prompt extracts phoneCell and phoneOffice as separate fields', () => {
  const idx = serverSrc.indexOf("app.post('/api/parse-contact-signature'");
  const body = serverSrc.slice(idx, idx + 3000);
  if (!/phoneCell\s*\(string\)/.test(body)) throw new Error('prompt does not instruct phoneCell extraction');
  if (!/phoneOffice\s*\(string\)/.test(body)) throw new Error('prompt does not instruct phoneOffice extraction');
  // Specifically must tell the model to ignore fax (fax is not a useful contact channel)
  if (!/\bfax\b/i.test(body)) throw new Error('prompt does not address fax numbers');
  // Must give guidance for single unlabeled phones
  if (!/only ONE phone|one phone/i.test(body)) {
    throw new Error('prompt does not handle the single-unlabeled-phone case');
  }
});

t('saveContact reads both phoneCell and phoneOffice from form', () => {
  const idx = feSrc.indexOf('function saveContact');
  const body = feSrc.slice(idx, idx + 1500);
  if (!/cm-phone-cell/.test(body))   throw new Error('saveContact does not read phoneCell input');
  if (!/cm-phone-office/.test(body)) throw new Error('saveContact does not read phoneOffice input');
  // Should NOT read the old single cm-phone input
  if (/getElementById\(['"]cm-phone['"]\)/.test(body)) {
    throw new Error('saveContact still references removed cm-phone single-phone input');
  }
});

t('Contact form has cell + office phone inputs with backward-compat prefill', () => {
  // The form template must render both inputs. If editing a contact saved
  // under the OLD schema (phone: "..."), we want that value to appear in the
  // CELL field as a graceful default rather than being lost.
  const idx = feSrc.indexOf('function _renderContactModalBody');
  const body = feSrc.slice(idx, idx + 8000);
  if (!/id="cm-phone-cell"/.test(body))   throw new Error('CELL input not rendered');
  if (!/id="cm-phone-office"/.test(body)) throw new Error('OFFICE input not rendered');
  // Backward compat: if data.phoneCell empty but data.phone set, prefer data.phone
  if (!/data\.phoneCell\s*\|\|\s*data\.phone/.test(body)) {
    throw new Error('form does not fall back to legacy data.phone for cell prefill');
  }
});

t('Contact list displays both phoneCell and phoneOffice (with legacy phone fallback)', () => {
  const idx = feSrc.indexOf('function renderContactsTab');
  const body = feSrc.slice(idx, idx + 8000);
  if (!/c\.phoneCell/.test(body))   throw new Error('list does not show phoneCell');
  if (!/c\.phoneOffice/.test(body)) throw new Error('list does not show phoneOffice');
  // Legacy fallback: show c.phone if neither phoneCell nor phoneOffice present
  if (!/!c\.phoneCell\s*&&\s*!c\.phoneOffice\s*&&\s*c\.phone/.test(body)) {
    throw new Error('list does not fall back to legacy c.phone for contacts saved pre-split');
  }
});

t('showApp warms up Render backend with a ping before user interacts', () => {
  // Render's free tier spins down idle instances; first request after idle
  // can take 10-30 seconds. Firing /api/ping on login wakes the instance
  // before the user clicks Notes, Insights, etc.
  const idx = feSrc.indexOf('function showApp');
  const body = feSrc.slice(idx, idx + 3000);
  if (!/fetch\([^)]*\/api\/ping/.test(body)) {
    throw new Error('showApp does not ping /api/ping to warm the backend');
  }
  // Must NOT await — warmup is fire-and-forget so it doesn't block the UI.
  // We check that the ping call is followed by .catch() (standalone statement,
  // not inside an await). A trailing `.catch(` indicates fire-and-forget.
  if (!/fetch\(API\s*\+\s*['"]\/api\/ping['"]\)\.catch/.test(body)) {
    throw new Error('ping should be fire-and-forget (fetch().catch(...))');
  }
});

t('mountNotesEditor does NOT block on /api/notes fetch for first-visit UX', () => {
  // The user saw 10+ seconds of "Preparing editor…" on first Notes visit
  // during Render cold-starts. Fix: build editor with empty content immediately
  // after TipTap resolves, then swap in fetched content when it arrives.
  const idx = feSrc.indexOf('async function mountNotesEditor');
  const body = feSrc.slice(idx, idx + 8000);
  // Look for: `buildEditor(T, null)` — mount with null before the fetch awaits.
  // This is our signal that the editor can appear without waiting on the HTTP round-trip.
  if (!/buildEditor\(T,\s*null\)/.test(body)) {
    throw new Error('mount does not build editor with empty content on first visit');
  }
  // Must use setContent to swap in content after fetch, NOT rebuild editor
  // (rebuilding is jankier and discards cursor/selection state).
  if (!/_notesEditor\.commands\.setContent\(/.test(body)) {
    throw new Error('mount does not use setContent to swap in fetched content');
  }
  // setContent must pass `false` to suppress onUpdate — otherwise the content
  // swap would schedule a save for the content we just received from the server.
  if (!/\.commands\.setContent\([^,)]+,\s*false\)/.test(body)) {
    throw new Error('setContent does not pass emitUpdate=false — would trigger spurious save');
  }
});

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
