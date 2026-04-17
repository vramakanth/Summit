/**
 * smoke.test.js — UI regression tests
 * Run: node smoke.test.js
 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname,'../public/index.html'), 'utf8');
let pass=0, fail=0;
const t = (name, fn) => { try { fn(); console.log(' ✓', name); pass++; } catch(e) { console.log(' ✗', name, '—', e.message.slice(0,80)); fail++; } };
const has  = s => { if (!src.includes(s)) throw new Error('missing: ' + s.slice(0,60)); };
const not  = s => { if (src.includes(s))  throw new Error('found:   ' + s.slice(0,60)); };
const count = (s, n) => { const c=(src.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length; if(c!==n) throw new Error(`expected ${n}, got ${c}`); };

// ── Core function names ─────────────────────────────────────────────────────
console.log('\n── Core function names');
t('addJob (not createJob)',    () => has('function addJob('));
t('doLogin (not login)',       () => has('function doLogin('));
t('displayMap app:flex',        () => has("app:'flex'"));
t('postingText: text.slice',   () => has('postingText: text.slice'));
t('stale is boolean field',    () => has('j.stale'));
t('stale not in STATUSES',     () => { if (src.match(/STATUSES.*stale|stale.*STATUSES/)) throw new Error('stale in STATUSES'); });

// ── Tab default ─────────────────────────────────────────────────────────────
console.log('\n── Tab behaviour');
t("Default tab = 'insights'",  () => has("activeDetailTab = 'insights'"));
t("selectJob sets insights tab",() => { const idx=src.indexOf("function selectJob"); const body=src.slice(idx,idx+600); if(!body.includes("'insights'")) throw new Error("selectJob doesn't set insights"); });
t('Insights tab exists',       () => has("switchTab('insights')"));
t('Notes tab exists',          () => has("switchTab('notes')"));

// ── Landing page ────────────────────────────────────────────────────────────
console.log('\n── Landing page');
t('Get started before Sign in in top-right', () => {
  const gs = src.indexOf("Get started</button>\n      <button onclick=\"showScreen('login')");
  if (gs < 0) throw new Error('order wrong — Get started must precede Sign in');
});
t('Sign in button present',    () => has("showScreen('login')"));
t('Get started button present',() => has("showScreen('register')"));

// ── Footer / logo labels removed ───────────────────────────────────────────
console.log('\n── Branding');
t('No "job tracker" auth-logo-sub',  () => not('<div class="auth-logo-sub">job tracker</div>'));
t('No "job tracker" logo-sub',       () => not('<div class="logo-sub">job tracker</div>'));

// ── Settings ────────────────────────────────────────────────────────────────
console.log('\n── Settings');
t('No X close button in settings content header', () => {
  // The inline close button with closeSettings() title=Close should be gone
  if (src.includes('title="Close"') && src.includes('closeSettings()') && src.includes('&#x2715;')) {
    throw new Error('X close button still present');
  }
});
t("Finnhub link opens Financial tab directly", () => has("openSettings('financial')"));
t('showSettingsSection re-populates finnhub key', () => {
  const idx = src.indexOf('function showSettingsSection');
  const body = src.slice(idx, idx + 300);
  if (!body.includes('finnhub_key')) throw new Error('finnhub re-populate missing');
});

// ── Insights ────────────────────────────────────────────────────────────────
console.log('\n── Insights');
t('Financial section exists',  () => has('Financial Data'));
t('Stock section exists',      () => has('Stock &amp; financials'));
t('Finnhub key in localStorage', () => has("finnhub_key"));

// ── Extension ───────────────────────────────────────────────────────────────
console.log('\n── Extension');
t('Extension download link exists', () => has('/api/extension'));

// ── No removed features ────────────────────────────────────────────────────
console.log('\n── Removed features absent');
t('No referral pipeline',      () => not('referralPipeline'));

console.log(`\n${pass}/${pass+fail} passed${fail ? ' ← FAILURES' : '  ✓'}`);
if (fail) process.exit(1);

// ── Landing page features (editorial layout) ────────────────────────────────
console.log('\n── Feature sections');
t('I. Company intelligence',      () => has('Company intelligence'));
t('II. Compensation research',    () => has('Compensation research'));
t('III. Resume tailoring',        () => has('Resume tailoring'));
t('IV. Interview prep',           () => has('Interview prep'));
t('V. Pipeline tracking',         () => has('Pipeline tracking'));
t('VI. Library section',          () => has('>Library</h3>'));
t('Features ordered I → II → III → IV → V → VI', () => {
  const order = ['Company intelligence','Compensation research','Resume tailoring','Interview prep','Pipeline tracking','>Library</h3>'];
  const idxs = order.map(s => src.indexOf(s));
  for (let i = 1; i < idxs.length; i++) {
    if (idxs[i] < 0)          throw new Error('missing: ' + order[i]);
    if (idxs[i] <= idxs[i-1]) throw new Error('order wrong at ' + order[i]);
  }
});
t('No Roman numeral markers in features (removed)', () => {
  // Roman numerals used to live as standalone <div> markers with amber 0.25em letter-spacing.
  // Feature titles must not carry per-section roman numerals anymore.
  if (/letter-spacing:0\.25em">(?:I|II|III|IV|V|VI)</.test(src)) {
    throw new Error('roman numeral marker still present');
  }
});
t('No per-column top rules above features', () => {
  // The per-column amber hairline was: border-top:1px solid rgba(232,168,56,0.3)
  if (src.includes('border-top:1px solid rgba(232,168,56,0.3)')) {
    throw new Error('per-column amber top rule still present');
  }
});
t('No feature cards (glass/backdrop-filter tile pattern removed)', () => {
  if (src.includes('backdrop-filter:blur(14px)')) throw new Error('old card pattern still present');
});
t('No legacy tile SVG icons in landing features', () => {
  if (src.includes('M3 9l9-7 9 7v11')) throw new Error('old house icon still in source');
});
t('Section-opening hairline rule above features (still present)', () => {
  if (!src.includes('border-top:1px solid rgba(242,234,216,0.12)')) throw new Error('section hairline missing');
});
t('No "Formatting preserved"',    () => not('Formatting preserved'));
t('No "Salary intelligence"',     () => not('Salary intelligence'));

// ── Hero: eyebrow + wordmark + tagline ──────────────────────────────────────
console.log('\n── Hero');
t('Eyebrow: "A JOB SEARCH WORKSPACE" above wordmark', () => {
  if (!src.includes('A JOB SEARCH WORKSPACE')) throw new Error('eyebrow missing');
  // Must come before the Summit wordmark in source order
  const eb = src.indexOf('A JOB SEARCH WORKSPACE');
  const wm = src.indexOf('>Summit</h1>');
  if (eb < 0 || wm < 0 || eb > wm) throw new Error('eyebrow not above wordmark');
});
t('Eyebrow uses mono + amber', () => {
  const idx = src.indexOf('A JOB SEARCH WORKSPACE');
  const tag = src.slice(Math.max(0, idx - 300), idx);
  if (!tag.includes('var(--mono)')) throw new Error('eyebrow not in mono');
  if (!tag.includes('#e8a838'))     throw new Error('eyebrow not amber');
});

// ── Landing hero tagline (mountaineering, not SaaS product-bullets) ─────────
console.log('\n── Hero tagline');
t('New tagline: Study the mountain',   () => has('Study the mountain'));
t('New tagline: Prepare the climb',    () => has('Prepare the climb'));
t('New tagline: Reach the summit',     () => has('Reach the summit'));
t('Old SaaS tagline removed: "Track every application"', () => not('Track every application'));
t('Old SaaS tagline removed: "Tailor every resume"',     () => not('Tailor every resume'));
t('Old SaaS tagline removed: "Land the role"',           () => not('Land the role'));

// ── Footer colophon (no CTA — sticky nav handles conversion) ───────────────
console.log('\n── Footer colophon');
t('No "Begin the climb" CTA button',   () => not('Begin the climb'));
t('No "Get started for free" CTA',     () => not('Get started for free'));
t('No "No credit card" pitch text',    () => not('NO CREDIT CARD'));
t('JOBSUMMIT.APP colophon present',    () => has('JOBSUMMIT.APP'));
t('No section rule framing the old CTA', () => {
  // That framing rule was the only 0.08-opacity border on the page
  if (src.includes('border-top:1px solid rgba(242,234,216,0.08)')) {
    throw new Error('old CTA-framing rule still present');
  }
});

// ── People & Diversity section ──────────────────────────────────────────────
console.log('\n── People & Diversity section');
t('No visa badge/pill in workforce', () => {
  const wfStart = src.indexOf('function renderWorkforceSection');
  const wfEnd   = src.indexOf('\nfunction renderCompensationSection');
  const wf = src.slice(wfStart, wfEnd);
  if (wf.includes('Sponsors visas') || wf.includes('visaLabel') || wf.includes('visaColor')) {
    throw new Error('visa badge still present');
  }
});
t('No headcountHistory growth chart', () => {
  const wfStart = src.indexOf('function renderWorkforceSection');
  const wfEnd   = src.indexOf('\nfunction renderCompensationSection');
  const wf = src.slice(wfStart, wfEnd);
  if (wf.includes('EMPLOYEE GROWTH') || wf.includes('headcountHistory')) throw new Error('growth chart still present');
});
t('No growing/shrinking trend badge in section header', () => {
  const wfStart = src.indexOf('function renderWorkforceSection');
  const wfEnd   = src.indexOf('\nfunction renderCompensationSection');
  const wf = src.slice(wfStart, wfEnd);
  if (wf.includes('insight-section-badge') && wf.includes('trendColor')) throw new Error('trend badge in header');
});
t('Stat cards use consistent border layout', () => {
  const wfStart = src.indexOf('function renderWorkforceSection');
  const wfEnd   = src.indexOf('\nfunction renderCompensationSection');
  const wf = src.slice(wfStart, wfEnd);
  if (!wf.includes('border-right:1px solid var(--border)')) throw new Error('no bordered stat cards');
});
t('avgTenure is a stat card (not tiny sub-label)', () => {
  const wfStart = src.indexOf('function renderWorkforceSection');
  const wfEnd   = src.indexOf('\nfunction renderCompensationSection');
  const wf = src.slice(wfStart, wfEnd);
  if (!wf.includes("'AVG TENURE'")) throw new Error('avgTenure not a stat card');
});
t('Layoff banner has proper 13px text', () => {
  const wfStart = src.indexOf('function renderWorkforceSection');
  const wfEnd   = src.indexOf('\nfunction renderCompensationSection');
  const wf = src.slice(wfStart, wfEnd);
  if (!wf.includes('font-size:13px;color:var(--text2)')) throw new Error('layoff text still low contrast');
});
t('Locations shown as pill chips', () => {
  const wfStart = src.indexOf('function renderWorkforceSection');
  const wfEnd   = src.indexOf('\nfunction renderCompensationSection');
  const wf = src.slice(wfStart, wfEnd);
  if (!wf.includes('OFFICE LOCATIONS')) throw new Error('no locations block');
  if (!wf.includes('border-radius:100px')) throw new Error('no pill chips');
});
t('renderAgeDistribution removed (inlined)', () => not('function renderAgeDistribution'));

// ── Watchlist & job list ─────────────────────────────────────────────────────
console.log('\n── Watchlist & job list');
t('Watchlist filter tab exists',       () => has("setFilter('watchlist')"));
t('getFilteredJobs handles watchlist', () => {
  const idx = src.indexOf("currentFilter === 'watchlist'");
  if (idx < 0) throw new Error('watchlist filter logic missing');
});
t('toggleWatchlist calls renderJobList (syncs inline star)', () => {
  const idx = src.indexOf('function toggleWatchlist');
  const body = src.slice(idx, idx + 300);
  if (!body.includes('renderJobList')) throw new Error('renderJobList not called — inline star wont update');
});
t('Inline star has adequate hit target (padding)', () => {
  const rl = src.slice(src.indexOf('function renderJobList'), src.indexOf('function selectJob'));
  if (!rl.includes('min-width:20px')) throw new Error('star hit target too small');
});
t('Inline star in job list item',      () => {
  // Star button inside renderJobList — uses event.stopPropagation to avoid selecting job
  const rl = src.slice(src.indexOf('function renderJobList'), src.indexOf('function selectJob'));
  if (!rl.includes('event.stopPropagation')) throw new Error('no stopPropagation on star');
  if (!rl.includes('toggleWatchlist')) throw new Error('no toggleWatchlist in job list');
});
t('Star+trash in aligned column in detail header', () => {
  // Both buttons in a flex-direction:column wrapper
  const dh = src.slice(src.indexOf('dv.innerHTML'), src.indexOf('dv.innerHTML') + 5000);
  if (!dh.includes('flex-direction:column')) throw new Error('no column wrapper for buttons');
  if (!dh.includes('toggleWatchlist') || !dh.includes('deleteJob')) throw new Error('missing buttons');
});
t('★ watchlist label on filter tab',   () => has('★ watchlist'));

// ── Finnhub key fix ──────────────────────────────────────────────────────────
console.log('\n── Finnhub key');
t('saveFinnhubKeySetting calls renderDetail after save', () => {
  const idx = src.indexOf('function saveFinnhubKeySetting');
  const body = src.slice(idx, idx + 400);
  if (!body.includes('renderDetail')) throw new Error('renderDetail not called after save — insights tab stays stale');
});
t('clearFinnhubKey calls renderDetail after clear', () => {
  const idx = src.indexOf('function clearFinnhubKey');
  const body = src.slice(idx, idx + 400);
  if (!body.includes('renderDetail')) throw new Error('renderDetail not called after clear');
});
t('hasFinnhub reads from localStorage in renderInsightsTab', () => {
  const idx = src.indexOf('function renderInsightsTab');
  const body = src.slice(idx, idx + 300);
  if (!body.includes("localStorage.getItem('finnhub_key')")) throw new Error('hasFinnhub not reading from localStorage');
});

// ── Browser fetch fallback ───────────────────────────────────────────────────
console.log('\n── Browser fetch fallback (job posting)');
t('refetchPosting tries server first then browser', () => {
  const idx = src.indexOf('async function refetchPosting');
  const body = src.slice(idx, idx + 4000);
  if (!body.includes('/api/parse-job')) throw new Error('missing server-side parse-job call');
  if (!body.includes('_browserFetchPosting')) throw new Error('missing browser fetch fallback');
});
t('_browserFetchPosting goes through postMessage bridge (NOT chrome.tabs.create)', () => {
  has('async function _browserFetchPosting');
  const idx = src.indexOf('async function _browserFetchPosting');
  const body = src.slice(idx, idx + 600);
  // chrome.tabs is unavailable to web pages — the old implementation could never work
  if (body.includes('chrome.tabs.create')) throw new Error('still uses chrome.tabs.create (unreachable from web page)');
  if (!body.includes('_bridgeCall')) throw new Error('not using _bridgeCall bridge');
});
t('_browserFetchPosting checks isExtensionInstalled before calling bridge', () => {
  const idx = src.indexOf('async function _browserFetchPosting');
  const body = src.slice(idx, idx + 400);
  if (!body.includes('_extensionAvailable')) throw new Error('no extension-presence check');
});
t('refetchPosting has a purpose-built blocked-site fallback card', () => {
  const idx = src.indexOf('async function refetchPosting');
  const body = src.slice(idx, idx + 4000);
  if (!body.includes('_renderPostingBlockedCard')) throw new Error('missing fallback card helper');
});
t('_renderPostingBlockedCard covers both "no extension" and "already-tried-extension" paths', () => {
  const idx = src.indexOf('function _renderPostingBlockedCard');
  if (idx < 0) throw new Error('_renderPostingBlockedCard not defined');
  const body = src.slice(idx, idx + 3500);
  if (!body.includes("'no-extension'")) throw new Error('no-extension branch missing');
  if (!/Notes/.test(body)) throw new Error('no fallback CTA to paste into Notes');
  if (!/Install the Summit browser extension/i.test(body)) throw new Error('install-extension CTA missing');
});

// ── Lazy mirror fallback in refetchPosting ──────────────────────────────────
console.log('\n── Mirror fallback (lazy, on refetch failure)');
t('refetchPosting flow: original → cached mirror → search → extension → card', () => {
  const idx = src.indexOf('async function refetchPosting');
  const body = src.slice(idx, idx + 5000);
  // All five steps must appear in order
  if (!body.includes('_serverFetch(j.url)'))          throw new Error('step 1 (original) missing');
  if (!body.includes('j.fallbackUrl'))                 throw new Error('step 2 (cached mirror) missing');
  if (!body.includes('_findMirror'))                   throw new Error('step 3 (search for mirror) missing');
  if (!body.includes('isExtensionInstalled()'))        throw new Error('step 4 (extension) missing');
  if (!body.includes('_renderPostingBlockedCard'))     throw new Error('step 5 (fallback card) missing');
  // Order check: server fetch before cached mirror, before search
  const i1 = body.indexOf('_serverFetch(j.url)');
  const i2 = body.indexOf('j.fallbackUrl');
  const i3 = body.indexOf('_findMirror');
  if (!(i1 < i2 && i2 < i3)) throw new Error('steps out of order');
});
t('Successful primary fetch clears stale mirror (trust the original)', () => {
  const idx = src.indexOf('async function refetchPosting');
  const body = src.slice(idx, idx + 3000);
  if (!/delete j\.fallbackUrl;/.test(body)) throw new Error('no fallback-invalidation on primary success');
});
t('Stale mirror (404/blocked on cached fallbackUrl) is cleared so next refetch re-searches', () => {
  const idx = src.indexOf('async function refetchPosting');
  const body = src.slice(idx, idx + 4000);
  // Two delete sites expected: one on primary success, one when cached mirror fails
  const deletes = (body.match(/delete j\.fallbackUrl/g) || []).length;
  if (deletes < 2) throw new Error('cached-mirror failure does not clear stale fallbackUrl');
});
t('_findMirror POSTs title+company+location+originalUrl to /api/find-posting-mirror', () => {
  const idx = src.indexOf('async function _findMirror');
  if (idx < 0) throw new Error('_findMirror not defined');
  const body = src.slice(idx, idx + 800);
  if (!body.includes('/api/find-posting-mirror')) throw new Error('wrong endpoint');
  for (const field of ['title', 'company', 'location', 'originalUrl']) {
    if (!body.includes(field)) throw new Error(`missing field: ${field}`);
  }
});
t('_renderMirrorBadge shows when reading from j.fallbackUrl (so user knows)', () => {
  const idx = src.indexOf('function _renderMirrorBadge');
  if (idx < 0) throw new Error('_renderMirrorBadge not defined');
  const body = src.slice(idx, idx + 1000);
  if (!body.includes('j.fallbackUrl')) throw new Error('badge does not check for fallbackUrl');
  if (!body.includes('j.fallbackVia')) throw new Error('badge does not surface the mirror source');
});

// ── Help in sidebar ──────────────────────────────────────────────────────────
console.log('\n── Help in sidebar');
t('Help button in sidebar action buttons', () => {
  // Must be a sidebar-action-btn with data-section="help" calling showHelp()
  const sidebarStart = src.indexOf('class="sidebar-action-btns"');
  const sidebarEnd   = src.indexOf('</div>', sidebarStart + 100) + 6;
  const bar = src.slice(sidebarStart, sidebarEnd + 600); // wide enough to catch all buttons
  if (!bar.includes("data-section=\"help\"")) throw new Error('no data-section=help in sidebar');
  if (!bar.includes("showHelp()"))           throw new Error('no showHelp() call in sidebar');
});
t('showHelp() function exists', () => has('function showHelp()'));
t('showHelp() calls openSection("help")', () => {
  const idx  = src.indexOf('function showHelp()');
  const body = src.slice(idx, idx + 200);
  if (!body.includes("openSection('help')")) throw new Error('openSection not called');
});
t('Help removed from settings nav', () => not('snav-help'));
t('Settings Help pane has redirect to sidebar', () => {
  const idx  = src.indexOf('id="spane-help"');
  const body = src.slice(idx, idx + 600);
  if (!body.includes('showHelp()')) throw new Error('no showHelp link in settings pane');
});

// ── Typography (Fraunces + Lato) ────────────────────────────────────────────
console.log('\n── Typography');
t('Google Fonts loads Fraunces',        () => has('family=Fraunces'));
t('Google Fonts loads Lato',            () => has('Lato:'));
t('Google Fonts loads DM Mono',         () => has('DM+Mono'));
t('No DM Sans reference',               () => not('DM+Sans'));
t('No Geist font reference',            () => { if (/'Geist'|"Geist"/.test(src)) throw new Error('Geist still referenced'); });
t('--font-display CSS var declared',    () => has('--font-display:'));
t('--font uses Lato',                   () => { if (!/--font:\s*'Lato'/.test(src)) throw new Error('--font not Lato'); });
t('.detail-title uses display serif',   () => {
  const m = src.match(/\.detail-title\s*\{[^}]*\}/);
  if (!m || !m[0].includes('var(--font-display)')) throw new Error('.detail-title missing font-display');
});
t('.auth-heading uses display serif',   () => {
  const m = src.match(/\.auth-heading\s*\{[^}]*\}/);
  if (!m || !m[0].includes('var(--font-display)')) throw new Error('.auth-heading missing font-display');
});
t('.modal-title uses display serif',    () => {
  const m = src.match(/\.modal-title\s*\{[^}]*\}/);
  if (!m || !m[0].includes('var(--font-display)')) throw new Error('.modal-title missing font-display');
});
t('.insight-card-value uses display serif', () => {
  const m = src.match(/\.insight-card-value\s*\{[^}]*\}/);
  if (!m || !m[0].includes('var(--font-display)')) throw new Error('.insight-card-value missing font-display');
});

// ── Insights tab: editorial layout + readable type ──────────────────────────
console.log('\n── Insights tab layout');
t('Overview strip uses hairline top/bottom — no card box', () => {
  const m = src.match(/\.insights-grid\s*\{[^}]*\}/);
  if (!m) throw new Error('.insights-grid rule missing');
  if (/\bborder\s*:\s*1px/.test(m[0])) throw new Error('outer box border still present on .insights-grid');
  if (!/border-top:\s*1px/.test(m[0]))    throw new Error('top hairline missing');
  if (!/border-bottom:\s*1px/.test(m[0])) throw new Error('bottom hairline missing');
});
t('.insight-card has no right-border or background', () => {
  const m = src.match(/^\.insight-card\s*\{[^}]*\}/m);
  if (!m) throw new Error('.insight-card rule missing');
  if (/border-right/.test(m[0]))         throw new Error('per-field right-border still present');
  if (/background:\s*var\(--bg2\)/.test(m[0])) throw new Error('per-field background still present');
});
t('.insight-section has no bottom border (editorial de-box)', () => {
  const m = src.match(/^\.insight-section\s*\{[^}]*\}/m);
  if (!m) throw new Error('.insight-section rule missing');
  if (/border-bottom/.test(m[0])) throw new Error('section bottom border still present');
});
t('.insight-section-header has amber leading tick (::before)', () => {
  if (!/\.insight-section-header::before\s*\{[^}]*background:\s*var\(--accent-bg\)/s.test(src)) {
    throw new Error('amber tick ::before missing');
  }
});
t('.insight-section-icon hidden (replaced by tick)', () => {
  const m = src.match(/\.insight-section-icon\s*\{[^}]*\}/);
  if (!m || !m[0].includes('display: none')) throw new Error('.insight-section-icon not hidden');
});
t('.insight-card-label bumped to 11px (was 9px)', () => {
  const m = src.match(/\.insight-card-label\s*\{[^}]*\}/);
  if (!m || !/font-size:\s*11px/.test(m[0])) throw new Error('.insight-card-label not 11px');
});
t('.insight-card-value bumped to 20px (was 18px)', () => {
  const m = src.match(/\.insight-card-value\s*\{[^}]*\}/);
  if (!m || !/font-size:\s*20px/.test(m[0])) throw new Error('.insight-card-value not 20px');
});
t('.insight-section-title bumped to 12px (was 11px)', () => {
  const m = src.match(/\.insight-section-title\s*\{[^}]*\}/);
  if (!m || !/font-size:\s*12px/.test(m[0])) throw new Error('.insight-section-title not 12px');
});
t('.insight-ai-text bumped to 15px (was 13px)', () => {
  const m = src.match(/\.insight-ai-text\s*\{[^}]*\}/);
  if (!m || !/font-size:\s*15px/.test(m[0])) throw new Error('.insight-ai-text not 15px');
});
t('.insight-news-headline bumped to 15px (was 13px)', () => {
  const m = src.match(/\.insight-news-headline\s*\{[^}]*\}/);
  if (!m || !/font-size:\s*15px/.test(m[0])) throw new Error('.insight-news-headline not 15px');
});
t('Orphan .insight-section radius override removed', () => {
  if (src.includes('.insight-section { border-radius: 8px !important; }')) {
    throw new Error('orphan radius override still present');
  }
});
t('Partial-data warning banner rendered when ins._partial', () => {
  if (!src.includes('ins._partial ?')) throw new Error('no ins._partial check in renderInsightsTab');
  // The banner should reference "Partial research" and point at Refresh
  const idx = src.indexOf('ins._partial ?');
  const body = src.slice(idx, idx + 600);
  if (!body.includes('Partial research')) throw new Error('banner copy missing');
  if (!body.includes('Refresh'))          throw new Error('banner does not direct to refresh');
});

// ── Status simplification (5 statuses; filter pills match dropdown) ─────────
console.log('\n── Status system');
t('STATUSES reduced to 5 (to apply/applied/interview/offer/rejected)', () => {
  const m = src.match(/const STATUSES\s*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error('STATUSES not found');
  const list = m[1];
  for (const s of ['to apply', 'applied', 'interview', 'offer', 'rejected']) {
    if (!list.includes(`'${s}'`)) throw new Error(`${s} missing from STATUSES`);
  }
  // Make sure legacy ones are gone
  for (const s of ['screening', 'interviewing', 'ghosted', 'withdrawn', 'expired']) {
    if (new RegExp(`'${s}'`).test(list)) throw new Error(`legacy status ${s} still in STATUSES`);
  }
});
t('STATUS_MIGRATE map handles all legacy statuses', () => {
  const m = src.match(/const STATUS_MIGRATE\s*=\s*\{([^}]+)\}/);
  if (!m) throw new Error('STATUS_MIGRATE not found');
  for (const s of ['screening', 'interviewing', 'ghosted', 'withdrawn', 'expired']) {
    if (!m[1].includes(`'${s}'`)) throw new Error(`${s} not in STATUS_MIGRATE`);
  }
});
t('loadJobs applies STATUS_MIGRATE on every load', () => {
  const idx = src.indexOf('async function loadJobs');
  const body = src.slice(idx, idx + 3000);
  if (!/STATUS_MIGRATE\[j\.status\]/.test(body)) {
    throw new Error('loadJobs does not apply status migration');
  }
});
t('filter pill "interview" (not "interviewing")', () => {
  // Regression: the pill used to read "interview" but STATUSES had "interviewing",
  // so the pill filtered to zero jobs. Now both are unified on "interview".
  if (!src.includes("data-filter=\"interview\"")) throw new Error('no interview pill');
  if (!src.includes("'interview'"))              throw new Error('no "interview" string literal');
  // Assert no lingering "interviewing" in STATUSES
  const m = src.match(/const STATUSES\s*=\s*\[([^\]]+)\]/);
  if (/'interviewing'/.test(m[1])) throw new Error('legacy interviewing still in STATUSES');
});

// ── Settings panel: survives navigate-away-and-return ───────────────────────
console.log('\n── Settings render-safety');
t('openSettings rescues settings-panel-inner before openSection wipes section-view', () => {
  const idx = src.indexOf('function openSettings');
  const body = src.slice(idx, idx + 1800);
  // Must move inner back to overlay BEFORE calling openSection (which does sv.innerHTML = '')
  const safeIdx = body.indexOf('overlayPre.appendChild(innerPre)');
  // Match the STATEMENT with semicolon, not the mention inside the SAFEGUARD comment
  const openIdx = body.indexOf("openSection('settings');");
  if (safeIdx < 0) throw new Error('no rescue step for settings-panel-inner');
  if (openIdx < 0) throw new Error('no openSection call');
  if (safeIdx > openIdx) throw new Error('rescue must happen BEFORE openSection wipe');
});

// ── Settings nav: consolidated groups instead of flat list ──────────────────
console.log('\n── Settings nav grouping');
t('.snav-group-label CSS class defined', () => has('.snav-group-label'));
t('Settings sidebar has 3 group labels (Security, Preferences, Your data)', () => {
  for (const label of ['>SECURITY<', '>PREFERENCES<', '>YOUR DATA<']) {
    if (!src.includes(label)) throw new Error(`missing group label: ${label}`);
  }
});

// ── Help redesign: mountain-bg + editorial layout ───────────────────────────
console.log('\n── Help redesign');
t('showHelp shows the mountain-bg', () => {
  const idx = src.indexOf('function showHelp');
  const body = src.slice(idx, idx + 8000);
  if (!/getElementById\('mountain-bg'\)/.test(body)) throw new Error('showHelp does not reference mountain-bg');
  if (!/bg\.style\.display\s*=\s*''/.test(body)) throw new Error('showHelp does not show mountain-bg');
});
t('closeHelp hides the mountain-bg', () => {
  const idx = src.indexOf('function closeHelp');
  if (idx < 0) throw new Error('closeHelp not defined');
  const body = src.slice(idx, idx + 400);
  if (!body.includes("bg.style.display = 'none'")) throw new Error('closeHelp does not hide mountain-bg');
});
t('Help has "FIELD GUIDE" mono eyebrow', () => {
  const idx = src.indexOf('function showHelp');
  const body = src.slice(idx, idx + 8000);
  if (!body.includes('FIELD GUIDE')) throw new Error('FIELD GUIDE eyebrow missing');
});
t('Help uses Fraunces display for the "Help" title', () => {
  const idx = src.indexOf('function showHelp');
  const body = src.slice(idx, idx + 8000);
  if (!/font-family:var\(--font-display\).*?>Help</s.test(body)) throw new Error('Help title not in display serif');
});

// ── Analytics redesign: de-boxed + refined metrics ──────────────────────────
console.log('\n── Analytics redesign');
t('Analytics no longer has "Analytics Dashboard" header', () => {
  if (src.includes('>Analytics Dashboard<')) throw new Error('old dashboard header still present');
});
t('Analytics uses Fraunces "Analytics" title + "THE CLIMB" eyebrow', () => {
  const idx = src.indexOf('function renderAnalytics');
  const body = src.slice(idx, idx + 10000);
  if (!body.includes('THE CLIMB')) throw new Error('THE CLIMB eyebrow missing');
  if (!/font-family:var\(--font-display\)[^>]*>Analytics</.test(body)) throw new Error('Analytics title not in display serif');
});
t('Analytics uses stat-strip (analytics-kpi-grid + kpi-card classes)', () => {
  const idx = src.indexOf('function renderAnalytics');
  const body = src.slice(idx, idx + 10000);
  if (!body.includes('class="analytics-kpi-grid"'))    throw new Error('analytics-kpi-grid missing');
  if (!body.includes('class="analytics-kpi-card"'))    throw new Error('analytics-kpi-card missing');
});
t('Analytics dropped work-type distribution', () => {
  const idx = src.indexOf('function renderAnalytics');
  const body = src.slice(idx, idx + 10000);
  if (body.includes('Work type distribution')) throw new Error('work-type still present');
});
t('Analytics dropped "All applications" list (redundant with job list)', () => {
  const idx = src.indexOf('function renderAnalytics');
  const body = src.slice(idx, idx + 10000);
  if (body.includes('All applications')) throw new Error('all-applications list still present');
});
t('Analytics shows weekly cadence (last 12 weeks)', () => {
  const idx = src.indexOf('function renderAnalytics');
  const body = src.slice(idx, idx + 10000);
  if (!body.includes('Last 12 weeks')) throw new Error('weekly cadence section missing');
});
t('Analytics filterAndClose uses data-filter (not textContent match)', () => {
  const idx = src.indexOf('function filterAndClose');
  const body = src.slice(idx, idx + 500);
  if (!body.includes('dataset.filter')) throw new Error('filterAndClose should use dataset.filter');
});

// ── Posting tab: markdown scrub + paragraph fix ─────────────────────────────
console.log('\n── Posting tab: markdown + paragraphs');
t('buildPostingHtml splits paragraphs on \\n\\n', () => {
  const idx = src.indexOf('function buildPostingHtml');
  const codeStart = src.indexOf('if (rawSource.trim().length > 0)', idx);
  if (codeStart < 0) throw new Error('buildPostingHtml body not found');
  const body = src.slice(codeStart, codeStart + 2000);
  // Positive check: must split on double-newline. If someone accidentally
  // reintroduces the old single-line filter trap, paragraphs won't form and
  // the visual regression will catch it — no need for a fragile negative regex.
  if (!/split\(\/\\n\{2,\}\/\)/.test(body)) {
    throw new Error('double-newline paragraph split missing');
  }
});
t('buildPostingHtml promotes short punctuation-less lines to <h3>', () => {
  const idx = src.indexOf('function buildPostingHtml');
  const body = src.slice(idx, idx + 4000);
  if (!/<h3>/.test(body)) throw new Error('no h3 promotion for headings');
});

// ── Interview tab: scrollable wrapper preserves tabs ─────────────────────────
console.log('\n── Interview tab nav preservation');
t('renderInterviewTab wraps output in .interview-wrap (inner scroll)', () => {
  const idx = src.indexOf('function renderInterviewTab');
  const body = src.slice(idx, idx + 2500);
  if (!body.includes('class="interview-wrap"')) {
    throw new Error('.interview-wrap wrapper missing — tabs will scroll out of view');
  }
});
t('Interview tab is NOT inside .tab-pane wrapper (needs to be direct flex child of .detail-view)', () => {
  // In renderDetail, the interview branch should render bare, like posting — not wrapped
  const idx = src.indexOf("activeDetailTab === 'interview'");
  if (idx < 0) throw new Error('interview branch not found in renderDetail');
  const body = src.slice(idx, idx + 200);
  if (/tab-pane[^<]*\$\{renderInterviewTab/.test(body)) {
    throw new Error('renderInterviewTab still wrapped in tab-pane — will prevent inner scroll');
  }
});

// ── Extension bridge (webapp ↔ content.js ↔ background) ─────────────────────
console.log('\n── Extension bridge');
t('isExtensionInstalled() helper defined and driven by summit-ext-ready message', () => {
  if (!src.includes('function isExtensionInstalled'))  throw new Error('isExtensionInstalled missing');
  if (!src.includes("msg.type === 'summit-ext-ready'")) throw new Error('no summit-ext-ready listener');
  if (!src.includes('_extensionAvailable'))             throw new Error('no _extensionAvailable flag');
});
t('_browserFetchPosting uses _bridgeCall (postMessage) — NOT chrome.tabs.create', () => {
  const idx = src.indexOf('async function _browserFetchPosting');
  const body = src.slice(idx, idx + 600);
  if (body.includes('chrome.tabs.create')) throw new Error('still using chrome.tabs.create (unavailable to web pages)');
  if (!body.includes('_bridgeCall')) throw new Error('not using _bridgeCall');
});
t('_bridgeCall uses nonce + timeout for safety', () => {
  const idx = src.indexOf('function _bridgeCall');
  const body = src.slice(idx, idx + 800);
  if (!body.includes('nonce'))         throw new Error('no nonce');
  if (!body.includes('bridge-timeout')) throw new Error('no timeout path');
});
t('refetchPosting only shows "browser fetch" step if extension installed', () => {
  const idx = src.indexOf('async function refetchPosting');
  const body = src.slice(idx, idx + 3500);
  // Must guard the browser-fetch step behind isExtensionInstalled()
  if (!/if \(isExtensionInstalled\(\)\)/.test(body)) {
    throw new Error('refetchPosting does not gate browser-fetch step on extension presence');
  }
  // Should render a distinct "install extension" card when not installed
  if (!body.includes('_renderPostingBlockedCard')) throw new Error('fallback card helper missing');
});

// ── App-wide typography consistency with insights pass ──────────────────────
console.log('\n── App-wide body text scale');
t('.notes-textarea bumped to 15px', () => {
  const m = src.match(/\.notes-textarea\s*\{[^}]*\}/);
  if (!m || !/font-size:\s*15px/.test(m[0])) throw new Error('notes textarea not 15px');
});
t('.posting-body bumped to 15px + text color (was 13px/text2)', () => {
  const m = src.match(/\.posting-body\s*\{[^}]*\}/);
  if (!m) throw new Error('.posting-body rule missing');
  if (!/font-size:\s*15px/.test(m[0]))      throw new Error('posting-body not 15px');
  if (!/color:\s*var\(--text\)/.test(m[0])) throw new Error('posting-body not var(--text)');
  if (/var\(--text2\)/.test(m[0]))          throw new Error('posting-body still using low-contrast text2');
});
t('.doc-list-name bumped to 15px', () => {
  const m = src.match(/\.doc-list-name\s*\{[^}]*\}/);
  if (!m || !/font-size:\s*15px/.test(m[0])) throw new Error('doc-list-name not 15px');
});
t('.interview-q-text bumped to 15px', () => {
  const m = src.match(/\.interview-q-text\s*\{[^}]*\}/);
  if (!m || !/font-size:\s*15px/.test(m[0])) throw new Error('interview-q-text not 15px');
});
t('.contact-name bumped to 15px', () => {
  const m = src.match(/\.contact-name\s*\{[^}]*\}/);
  if (!m || !/font-size:\s*15px/.test(m[0])) throw new Error('contact-name not 15px');
});

console.log('\n── App-wide display-number consistency (Fraunces)');
t('.analytics-kpi-value uses Fraunces display serif', () => {
  const m = src.match(/\.analytics-kpi-value\s*\{[^}]*\}/);
  if (!m || !m[0].includes('var(--font-display)')) throw new Error('analytics-kpi-value missing font-display');
});
t('.analytics-kpi-card de-boxed (no background/border/radius)', () => {
  const m = src.match(/\.analytics-kpi-card\s*\{[^}]*\}/);
  if (!m) throw new Error('.analytics-kpi-card rule missing');
  if (/background:\s*var\(--bg2\)/.test(m[0])) throw new Error('kpi card still has bg2 background');
  if (/\bborder:\s*1px/.test(m[0]))            throw new Error('kpi card still has border');
  if (/border-radius:/.test(m[0]))             throw new Error('kpi card still has radius');
});
t('.analytics-kpi-grid uses hairline top/bottom (stat-strip pattern)', () => {
  const m = src.match(/\.analytics-kpi-grid\s*\{[^}]*\}/);
  if (!m || !/border-top:\s*1px/.test(m[0]) || !/border-bottom:\s*1px/.test(m[0])) {
    throw new Error('analytics grid not using hairline strip pattern');
  }
});

console.log('\n── App-wide page titles (Fraunces display)');
t('.docs-title uses Fraunces display', () => {
  const m = src.match(/\.docs-title\s*\{[^}]*\}/);
  if (!m || !m[0].includes('var(--font-display)')) throw new Error('docs-title missing font-display');
});
t('.interview-title uses Fraunces display', () => {
  const m = src.match(/\.interview-title\s*\{[^}]*\}/);
  if (!m || !m[0].includes('var(--font-display)')) throw new Error('interview-title missing font-display');
});

console.log('\n── App-wide section headers (amber tick pattern)');
t('.docs-section-header has amber tick', () => {
  if (!/\.docs-section-header::before\s*\{[^}]*background:\s*var\(--accent-bg\)/s.test(src)) {
    throw new Error('docs section-header amber tick missing');
  }
});
t('.interview-category has amber tick', () => {
  if (!/\.interview-category::before\s*\{[^}]*background:\s*var\(--accent-bg\)/s.test(src)) {
    throw new Error('interview-category amber tick missing');
  }
});
t('.docs-section-title matches insight-section-title scale (12px mono uppercase)', () => {
  const m = src.match(/\.docs-section-title\s*\{[^}]*\}/);
  if (!m) throw new Error('docs-section-title rule missing');
  if (!/font-size:\s*12px/.test(m[0]))     throw new Error('not 12px');
  if (!/var\(--mono\)/.test(m[0]))         throw new Error('not mono');
  if (!/text-transform:\s*uppercase/.test(m[0])) throw new Error('not uppercase');
});
t('.auth-logo-text uses display serif', () => {
  const m = src.match(/\.auth-logo-text\s*\{[^}]*\}/);
  if (!m || !m[0].includes('var(--font-display)')) throw new Error('.auth-logo-text missing font-display');
});
t('.empty-state h2 uses display serif', () => {
  const m = src.match(/\.empty-state h2\s*\{[^}]*\}/);
  if (!m || !m[0].includes('var(--font-display)')) throw new Error('.empty-state h2 missing font-display');
});
t('Landing hero <h1>Summit uses display serif', () => {
  const idx = src.indexOf('>Summit</h1>');
  if (idx < 0) throw new Error('Summit <h1> not found');
  const tag = src.slice(Math.max(0, idx - 400), idx);
  if (!tag.includes('var(--font-display)')) throw new Error('hero h1 missing font-display');
});
t('font-optical-sizing enabled on body', () => has('font-optical-sizing: auto'));
t('text-rendering optimizeLegibility on body', () => has('text-rendering: optimizeLegibility'));

// ── User settings sync (Finnhub key server-synced via zero-knowledge) ──────
console.log('\n── User settings sync');
t('SYNCED_SETTING_KEYS array declared',      () => has('SYNCED_SETTING_KEYS ='));
t('finnhub_key listed in SYNCED_SETTING_KEYS', () => {
  const m = src.match(/SYNCED_SETTING_KEYS\s*=\s*\[([^\]]+)\]/);
  if (!m || !m[1].includes("'finnhub_key'")) throw new Error('finnhub_key not in SYNCED_SETTING_KEYS');
});
t('loadUserSettings() function exists',      () => has('async function loadUserSettings()'));
t('saveUserSettings() function exists',      () => has('async function saveUserSettings()'));
t('loadUserSettings hits /api/user-settings', () => {
  const idx = src.indexOf('async function loadUserSettings');
  const body = src.slice(idx, idx + 2000);
  if (!body.includes("'/api/user-settings'")) throw new Error('wrong endpoint');
});
t('loadUserSettings handles 404 as migration', () => {
  const idx = src.indexOf('async function loadUserSettings');
  const body = src.slice(idx, idx + 2000);
  if (!body.includes('404')) throw new Error('no 404 branch');
  if (!body.includes('saveUserSettings()')) throw new Error('404 branch does not push localStorage up');
});
t('loadUserSettings decrypts for zero-knowledge accounts', () => {
  const idx = src.indexOf('async function loadUserSettings');
  const body = src.slice(idx, idx + 2000);
  if (!body.includes('CryptoEngine.decrypt(dataKey')) throw new Error('no client-side decrypt');
});
t('loadUserSettings removes cleared keys from localStorage (clear propagation)', () => {
  const idx = src.indexOf('async function loadUserSettings');
  const body = src.slice(idx, idx + 2000);
  if (!body.includes('localStorage.removeItem(k)')) throw new Error('missing clear-propagation');
});
t('saveUserSettings encrypts for zero-knowledge accounts', () => {
  const idx = src.indexOf('async function saveUserSettings');
  const body = src.slice(idx, idx + 1200);
  if (!body.includes('isEncrypted && dataKey')) throw new Error('no encrypted branch');
  if (!body.includes('CryptoEngine.encrypt(dataKey')) throw new Error('no client-side encrypt');
  if (!body.includes('__enc: true')) throw new Error('no __enc wrapper');
});
t('saveUserSettings PUTs to /api/user-settings', () => {
  const idx = src.indexOf('async function saveUserSettings');
  const body = src.slice(idx, idx + 1200);
  if (!body.includes("method: 'PUT'") && !body.includes('method:"PUT"')) throw new Error('not PUT');
  if (!body.includes("'/api/user-settings'")) throw new Error('wrong endpoint');
});
t('saveFinnhubKeySetting calls saveUserSettings', () => {
  const idx = src.indexOf('function saveFinnhubKeySetting');
  const body = src.slice(idx, idx + 600);
  if (!body.includes('saveUserSettings()')) throw new Error('no sync call on save');
});
t('clearFinnhubKey calls saveUserSettings', () => {
  const idx = src.indexOf('function clearFinnhubKey');
  const body = src.slice(idx, idx + 400);
  if (!body.includes('saveUserSettings()')) throw new Error('no sync call on clear');
});
t('loadUserSettings wired into session restore', () => {
  // The page-load branch: if (token && currentUser) { ... loadUserSettings(); }
  const m = src.match(/if \(token && currentUser\) \{[^}]*loadUserSettings\(\)[^}]*\}/);
  if (!m) throw new Error('loadUserSettings not called on session restore');
});
t('loadUserSettings wired into login success', () => {
  const idx = src.indexOf('async function doLogin');
  const body = src.slice(idx, idx + 3000);
  if (!body.includes('loadUserSettings()')) throw new Error('loadUserSettings not called after login');
});
t('enableEncryption re-encrypts settings after upgrade', () => {
  const idx = src.indexOf('async function enableEncryption');
  const body = src.slice(idx, idx + 3500);
  if (!body.includes('saveUserSettings()')) throw new Error('no saveUserSettings call after upgrade');
});
