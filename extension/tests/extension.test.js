// extension.test.js — verifies the browser-fetch bridge is actually wired up.
// These tests protect against regressions like "chrome.tabs.create in the webapp"
// which looks plausible but can never work from a web page.

const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../extension/manifest.json'), 'utf8'));
const background = fs.readFileSync(path.join(__dirname, '../../extension/background.js'), 'utf8');
const content    = fs.readFileSync(path.join(__dirname, '../../extension/content.js'), 'utf8');
const popup      = fs.readFileSync(path.join(__dirname, '../../extension/popup.js'), 'utf8');

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(` ✓ ${name}`); passed++; }
  catch (e) { console.log(` ✗ ${name} — ${e.message}`); failed++; }
};

console.log('── extension — manifest');
t('manifest v3', () => { if (manifest.manifest_version !== 3) throw new Error('not MV3'); });
t('background service_worker defined', () => {
  if (!manifest.background?.service_worker) throw new Error('no background worker');
});
t('externally_connectable lists jobsummit.app', () => {
  const matches = manifest.externally_connectable?.matches || [];
  if (!matches.some(m => m.includes('jobsummit.app'))) throw new Error('jobsummit.app not in externally_connectable');
});
t('tabs permission present (needed for chrome.tabs.create in background)', () => {
  if (!(manifest.permissions || []).includes('tabs')) throw new Error('no tabs permission');
});
t('host_permissions cover arbitrary sites (needed to read any job page)', () => {
  const hp = manifest.host_permissions || [];
  if (!hp.some(p => p.includes('*/*'))) throw new Error('no wildcard host permission');
});

console.log('\n── extension — background.js');
t('background handles ping action', () => {
  if (!background.includes("msg.action === 'ping'")) throw new Error('no ping handler');
});
t('background handles fetchPosting action', () => {
  if (!background.includes("msg.action === 'fetchPosting'")) throw new Error('no fetchPosting handler');
});
t('background opens tab inactive (background) so user not yanked away', () => {
  if (!/chrome\.tabs\.create\(\s*\{[^}]*active:\s*false/.test(background)) {
    throw new Error('tab not opened in background (active:false missing)');
  }
});
t('background cleans up the tab it opened (even on error)', () => {
  if (!background.includes('finally')) throw new Error('no finally block for cleanup');
  if (!background.includes('chrome.tabs.remove')) throw new Error('no tab cleanup');
});
t('background falls back to executeScript when content.js injection is blocked', () => {
  if (!background.includes('chrome.scripting.executeScript')) {
    throw new Error('no executeScript fallback for sites that block content scripts');
  }
});
t('background listens on BOTH onMessage (internal) and onMessageExternal', () => {
  if (!background.includes('chrome.runtime.onMessage.addListener')) throw new Error('no internal listener');
  if (!background.includes('chrome.runtime.onMessageExternal.addListener')) throw new Error('no external listener');
});

console.log('\n── extension — content.js bridge');
t('content.js announces itself on jobsummit.app with summit-ext-ready', () => {
  if (!content.includes("'summit-ext-ready'")) throw new Error('no ready announcement');
});
t('content.js bridge listens for summit-bridge window messages', () => {
  if (!content.includes("'summit-bridge'")) throw new Error('no bridge listener');
});
t('content.js only activates bridge on jobsummit.app / localhost (not every site)', () => {
  if (!/jobsummit\.app/.test(content)) throw new Error('no jobsummit.app check');
  if (!/hostname/.test(content))       throw new Error('no hostname check');
});
t('content.js relays fetchPosting to background via chrome.runtime.sendMessage', () => {
  const idx = content.indexOf("'fetchPosting'");
  const body = content.slice(idx, idx + 1000);
  if (!body.includes('chrome.runtime.sendMessage')) throw new Error('does not relay via chrome.runtime');
});
t('content.js sends bridge responses with nonce (so webapp can match them)', () => {
  if (!/nonce/.test(content)) throw new Error('no nonce in bridge responses');
});

// ── v2.2: webapp bridge fallback in parseJobUrl ───────────────────────────
console.log('\n── extension v2.2 — webapp parseJobUrl bridge fallback');
const webapp = fs.readFileSync(path.join(__dirname, '../../frontend/public/index.html'), 'utf8');
t('parseJobUrl calls _browserFetchPosting when server returns unextractable', () => {
  // When the server couldn't read the page AND the extension is available,
  // the add-job modal should hit the bridge as a fallback — same as
  // refetchPosting does for the job detail tab. v2.2 wires this up.
  const idx = webapp.indexOf('async function parseJobUrl');
  if (idx < 0) throw new Error('parseJobUrl not found');
  const body = webapp.slice(idx, idx + 12000);
  if (!/_browserFetchPosting/.test(body)) {
    throw new Error('parseJobUrl does not call _browserFetchPosting — extension bridge unused in add-job');
  }
  if (!/_extensionAvailable/.test(body)) {
    throw new Error('parseJobUrl does not check _extensionAvailable before bridge call');
  }
});
t('parseJobUrl marks extension-bridge source on success', () => {
  const idx = webapp.indexOf('async function parseJobUrl');
  const body = webapp.slice(idx, idx + 12000);
  if (!/extension-bridge/.test(body)) {
    throw new Error('no extension-bridge source marker — user will see generic success message');
  }
});

// ── v1.18.2: bridge trigger broadened + stale-extension detection ─────────
console.log('\n── webapp v1.18.2 — bridge trigger + stale-ext detection');
t('bridge fires on ANY zero-field parse, not just unextractable (v1.18.2)', () => {
  // Earlier: bridge only fired when `_via === unextractable || _linkedinBlocked
  // || (filled === 0 && !text)`. Sites like ZipRecruiter that return short
  // shell text fell into the gap — filled was 0 but text was non-empty, so
  // bridge was skipped. v1.18.2 widens the trigger.
  const idx = webapp.indexOf('async function parseJobUrl');
  const body = webapp.slice(idx, idx + 12000);
  // Extract the serverGaveUpOnPage definition and verify it doesn't require
  // text to be empty.
  const m = body.match(/const\s+serverGaveUpOnPage\s*=[\s\S]*?;/);
  if (!m) throw new Error('serverGaveUpOnPage not found');
  if (/!\s*text/.test(m[0])) {
    throw new Error('serverGaveUpOnPage still gates on !text — should fire on any zero-field parse');
  }
  if (!/filled\s*===\s*0/.test(m[0])) {
    throw new Error('serverGaveUpOnPage no longer checks filled === 0');
  }
});

t('MIN_EXTENSION_VERSION constant defined (v1.18.2)', () => {
  if (!/const\s+MIN_EXTENSION_VERSION\s*=\s*['"][\d.]+['"]/.test(webapp)) {
    throw new Error('MIN_EXTENSION_VERSION constant not declared');
  }
});

t('semver comparator + _extIsStale helper defined (v1.18.2)', () => {
  if (!/function\s+_compareSemver\s*\(/.test(webapp)) {
    throw new Error('_compareSemver helper not defined');
  }
  if (!/function\s+_extIsStale\s*\(/.test(webapp)) {
    throw new Error('_extIsStale helper not defined');
  }
});

t('_compareSemver returns correct relative ordering (v1.18.2)', () => {
  // Extract the function body and eval it in a clean scope to verify the
  // algorithm. We simulate the function in isolation.
  const m = webapp.match(/function\s+_compareSemver[\s\S]*?\n\}/);
  if (!m) throw new Error('_compareSemver not found');
  const _compareSemver = eval('(' + m[0] + ')');
  // Equal versions
  if (_compareSemver('2.2.0', '2.2.0') !== 0) throw new Error('equal should return 0');
  // Strictly less
  if (_compareSemver('2.1.0', '2.2.0') !== -1) throw new Error('2.1.0 < 2.2.0 should return -1');
  if (_compareSemver('2.2.0', '2.2.1') !== -1) throw new Error('patch bump');
  if (_compareSemver('1.9.9', '2.0.0') !== -1) throw new Error('major bump');
  // Strictly greater
  if (_compareSemver('2.3.0', '2.2.0') !== 1) throw new Error('2.3.0 > 2.2.0 should return 1');
  // Shorthand tolerance
  if (_compareSemver('2.2', '2.2.0') !== 0) throw new Error('2.2 should equal 2.2.0');
  // Malformed input tolerance
  if (_compareSemver(null, '2.2.0') !== -1) throw new Error('null should compare as 0.0.0');
});

t('stale-extension banner renderer defined and auto-fires on ready event (v1.18.2)', () => {
  if (!/function\s+_renderStaleExtensionBanner\s*\(/.test(webapp)) {
    throw new Error('_renderStaleExtensionBanner not defined');
  }
  // The banner must be triggered when summit-ext-ready comes in with a stale
  // version, not just at app-start
  const readyBlock = webapp.match(/msg\.type\s*===\s*['"]summit-ext-ready['"][\s\S]{0,500}/);
  if (!readyBlock) throw new Error('summit-ext-ready handler not found');
  if (!/_extIsStale\s*\(\)/.test(readyBlock[0]) || !/_renderStaleExtensionBanner/.test(readyBlock[0])) {
    throw new Error('summit-ext-ready handler does not check staleness + render banner');
  }
});

t('stale-extension banner is dismissible + per-version remembered (v1.18.2)', () => {
  const m = webapp.match(/function\s+_renderStaleExtensionBanner[\s\S]*?\n\}/);
  if (!m) throw new Error('renderer not found');
  const body = m[0];
  if (!/localStorage\.getItem/.test(body) || !/applied_stale_ext_dismissed/.test(body)) {
    throw new Error('dismissal not persisted in localStorage');
  }
  // Dismissal key must include both the current extension version and the
  // min version — otherwise a future MIN_VERSION bump wouldn't re-alert
  // users who dismissed for an older mismatch.
  if (!/_extensionVersion\}[^`]*\$\{MIN_EXTENSION_VERSION\}|MIN_EXTENSION_VERSION\}[^`]*\$\{_extensionVersion/.test(body)) {
    throw new Error('dismissal key does not include both versions — bumps wont re-alert');
  }
});

t('stale extension suppresses bridge fallback attempt (v1.18.2)', () => {
  // Stale extension's bridge response is unreliable (pre-v2.2 content.js
  // doesn't return structured fields). The add-job modal should skip the
  // bridge call entirely rather than spending the 25-30s tab-fetch budget
  // on an extension that probably won't help, and surface the update
  // prompt immediately.
  const idx = webapp.indexOf('async function parseJobUrl');
  const body = webapp.slice(idx, idx + 12000);
  // Find the bridge-call branch and verify it guards on !_extIsStale()
  const triggerLine = body.match(/if\s*\(\s*serverGaveUpOnPage\s*&&\s*_extensionAvailable[^)]*\)/);
  if (!triggerLine) throw new Error('bridge-call gate not found');
  if (!/!_extIsStale/.test(triggerLine[0])) {
    throw new Error('bridge fires even on stale extension — wastes time and misleads user');
  }
});

t('parse failure message offers stale-update link when extension is stale (v1.18.2)', () => {
  const idx = webapp.indexOf('async function parseJobUrl');
  const body = webapp.slice(idx, idx + 14000);
  // The consolidated zero-filled branch must check _extIsStale and include
  // both the current version and MIN_EXTENSION_VERSION in the message.
  if (!/_extIsStale\s*\(\)/.test(body)) {
    throw new Error('no staleness check in failure branch');
  }
  if (!/update to v[\$\{]/.test(body)) {
    throw new Error('no "update to" copy in failure branch');
  }
});

// ── v2.3.0: CSP-safe popup (no inline handlers) ──────────────────────────
console.log('\n── extension v2.3.0 — CSP-safe popup');
const popupHtml = fs.readFileSync(path.join(__dirname, '../../extension/popup.html'), 'utf8');
t('popup.html has zero inline handlers (MV3 CSP fix)', () => {
  // MV3's default extension CSP (`script-src 'self'; object-src 'self'`)
  // blocks inline onclick/onkeydown handlers. Before v2.3 the popup relied
  // on them — clicking Sign in did NOTHING because the handler was silently
  // rejected by CSP. Regression guard: no inline handlers, period.
  if (/\bonclick\s*=/i.test(popupHtml)) throw new Error('popup.html still has onclick= handler(s) — blocked by MV3 CSP');
  if (/\bonkeydown\s*=/i.test(popupHtml)) throw new Error('popup.html still has onkeydown= handler(s) — blocked by MV3 CSP');
  if (/\bonchange\s*=/i.test(popupHtml)) throw new Error('popup.html still has onchange= handler(s) — blocked by MV3 CSP');
  if (/\bonsubmit\s*=/i.test(popupHtml)) throw new Error('popup.html still has onsubmit= handler(s) — blocked by MV3 CSP');
});

t('popup.html has required IDs for JS event wiring', () => {
  // v1.20.0: three-stage popup. Stage A button is extract-btn; stage C
  // has confirm-btn + cancel-btn. Previous single add-btn is gone.
  for (const id of ['login-btn', 'extract-btn', 'confirm-btn', 'cancel-btn', 'open-tracker-btn', 'sign-out-btn', 'username', 'password']) {
    if (!new RegExp(`id="${id}"`).test(popupHtml)) {
      throw new Error(`popup.html missing required id="${id}"`);
    }
  }
});

t('popup.js init() wires login-btn + password Enter via addEventListener', () => {
  const idx = popup.indexOf('async function init');
  if (idx < 0) throw new Error('init() not found');
  const body = popup.slice(idx, idx + 2500);
  if (!/\$\(['"]login-btn['"]\)\.addEventListener\(['"]click['"]\s*,\s*doLogin\s*\)/.test(body)) {
    throw new Error('init does not addEventListener click → doLogin on login-btn');
  }
  if (!/\$\(['"]password['"]\)\.addEventListener\(['"]keydown['"]/.test(body)) {
    throw new Error('init does not wire password Enter via addEventListener');
  }
  // v1.20.0: stage A trigger is extract-btn (was add-btn pre-v1.20)
  if (!/\$\(['"]extract-btn['"]\)\.addEventListener/.test(body)) {
    throw new Error('init does not wire extract-btn click');
  }
  if (!/\$\(['"]sign-out-btn['"]\)\.addEventListener/.test(body)) {
    throw new Error('init does not wire sign-out-btn click');
  }
});

t('doLogin uses try/finally so button always resets', () => {
  // Previous bug: early return inside try on a 401 skipped the button reset,
  // leaving "Signing in..." forever. The try/finally pattern guarantees the
  // button returns to "Sign in" whether the call succeeds, fails, or throws.
  const idx = popup.indexOf('async function doLogin');
  if (idx < 0) throw new Error('doLogin not found');
  const body = popup.slice(idx, idx + 2000);
  if (!/\}\s*finally\s*\{/.test(body)) {
    throw new Error('doLogin does not use try/finally — button can get stuck');
  }
  // Inside the finally block, the button must be reset. Grab the finally
  // body and verify it touches btn.disabled + btn.textContent.
  const finM = body.match(/\}\s*finally\s*\{([\s\S]*?)\}\s*\n/);
  if (!finM) throw new Error('finally body not parseable');
  if (!/disabled\s*=\s*false/.test(finM[1]) || !/textContent\s*=/.test(finM[1])) {
    throw new Error('doLogin finally block does not reset button state');
  }
});

t('doLogin shows specific "Incorrect username or password" on 401', () => {
  // Server returns plain "Invalid username or password" but we prefer a
  // friendlier copy client-side. Guard that a 401 branch is in place.
  const idx = popup.indexOf('async function doLogin');
  const body = popup.slice(idx, idx + 2000);
  if (!/res\.status\s*===\s*401/.test(body)) {
    throw new Error('doLogin does not branch on 401 status');
  }
  if (!/Incorrect username or password/i.test(body)) {
    throw new Error('doLogin does not show user-friendly 401 message');
  }
});

// ── v2.3.0: Website → extension session sync ─────────────────────────────
console.log('\n── extension v2.3.0 — session sync');
t('content.js pushes session from localStorage on load', () => {
  // On every jobsummit.app page load, content.js reads applied_token +
  // applied_user from localStorage and pings background.js with them.
  // Without this the extension popup has its own independent auth state.
  if (!/const\s+pushSession\s*=|function\s+pushSession\s*\(/.test(content)) {
    throw new Error('content.js has no pushSession function');
  }
  if (!/localStorage\.getItem\(['"]applied_token['"]\)/.test(content)) {
    throw new Error('content.js does not read applied_token from localStorage');
  }
  if (!/chrome\.runtime\.sendMessage\([\s\S]{0,200}syncSession/.test(content)) {
    throw new Error('content.js does not call syncSession action');
  }
});

t('content.js listens for storage events (cross-tab sync)', () => {
  // Cross-tab case: login in tab A updates localStorage → tab B's content.js
  // gets a storage event → pushes the new token to the extension.
  if (!/addEventListener\(\s*['"]storage['"]/.test(content)) {
    throw new Error('content.js does not listen for storage events');
  }
});

t('content.js listens for summit-session-changed postMessage (same-tab sync)', () => {
  // Same-tab case: storage events don't fire in the source tab. The webapp
  // posts summit-session-changed after its own login/logout so content.js
  // picks up changes without waiting for a page reload.
  if (!/summit-session-changed/.test(content)) {
    throw new Error('content.js does not handle summit-session-changed messages');
  }
});

t('background.js handles syncSession action and writes to chrome.storage.local', () => {
  if (!/msg\.action\s*===\s*['"]syncSession['"]/.test(background)) {
    throw new Error('background.js has no syncSession handler');
  }
  if (!/chrome\.storage\.local\.set/.test(background)) {
    throw new Error('syncSession handler does not write to chrome.storage.local');
  }
  if (!/chrome\.storage\.local\.remove/.test(background)) {
    throw new Error('syncSession handler does not clear storage on logout (null token)');
  }
});

t('webapp has _notifyExtensionSessionChanged helper', () => {
  if (!/function\s+_notifyExtensionSessionChanged\s*\(/.test(webapp)) {
    throw new Error('_notifyExtensionSessionChanged helper not defined');
  }
  // Must postMessage summit-session-changed so content.js can listen for it
  const idx = webapp.indexOf('function _notifyExtensionSessionChanged');
  const body = webapp.slice(idx, idx + 400);
  if (!/summit-session-changed/.test(body)) {
    throw new Error('_notifyExtensionSessionChanged does not post summit-session-changed');
  }
});

t('doLogin/doLogout/doRegister/doRecover all call _notifyExtensionSessionChanged', () => {
  // Every code path that writes or clears applied_token in the webapp must
  // notify the extension — otherwise same-tab auth state diverges. Scans
  // for each such localStorage operation and verifies a notify call
  // appears within the next 200 chars (i.e., right after the setItem
  // pair).
  const writeRe = /localStorage\.setItem\(['"]applied_token['"]|localStorage\.removeItem\(['"]applied_token['"]/g;
  let m, missing = [];
  while ((m = writeRe.exec(webapp)) !== null) {
    const windowAfter = webapp.slice(m.index, m.index + 400);
    if (!/_notifyExtensionSessionChanged/.test(windowAfter)) {
      const lineNo = webapp.slice(0, m.index).split('\n').length;
      // Skip the error-rollback case inside the try (line ~1534) where
      // the account is rejected — we roll the write back AND the user
      // never considered signed in, so no notification needed.
      const line = webapp.slice(webapp.lastIndexOf('\n', m.index) + 1, webapp.indexOf('\n', m.index));
      if (/removeItem.*applied_token.*removeItem.*applied_user/.test(line)) continue; // rollback line
      missing.push(`line ~${lineNo}: ${line.trim().slice(0, 80)}`);
    }
  }
  if (missing.length) {
    throw new Error('applied_token writes without session notify:\n  ' + missing.join('\n  '));
  }
});

t('manifest version bumped to 2.6.1', () => {
  if (manifest.version !== '2.6.1') throw new Error('manifest still at ' + manifest.version);
});

// v1.20.2: catch drift between popup.js header comment and manifest version.
// If popup.js changes behavior (as in v1.20.1's postingText forwarding) but
// manifest.json doesn't bump, users on the old bundle keep the stale behavior
// and the stale-ext banner never fires. Pinning the header to manifest.version
// makes the tests fail if you ship popup changes without a manifest bump.
t('popup.js header version matches manifest.version', () => {
  const headerMatch = popup.match(/popup\.js v(\d+\.\d+\.\d+)/);
  if (!headerMatch) throw new Error('popup.js header does not declare a version');
  if (headerMatch[1] !== manifest.version) {
    throw new Error(`popup.js header says v${headerMatch[1]} but manifest is ${manifest.version} — bump one to match`);
  }
});

// v1.20.2: content.js was collapsing ALL whitespace (including newlines) into
// single spaces, so postingText arrived as one giant line and the description
// tab rendered as an unreadable wall of text (buildPostingHtml splits on
// double-newlines to form paragraphs, and got nothing to split on).
t('content.js text field preserves newlines for paragraph structure', () => {
  // Must NOT use the greedy /\s+/g on innerText — that eats newlines.
  const idx = content.indexOf('const text = document.body.innerText');
  if (idx < 0) throw new Error('cannot locate text field derivation');
  const decl = content.slice(idx, idx + 500);
  if (/\.replace\(\s*\/\\s\+\/g\s*,\s*['"] ['"]\s*\)/.test(decl)) {
    throw new Error('text field uses /\\s+/g which destroys newlines');
  }
  // Should collapse horizontal whitespace specifically
  if (!/\[ \\t/.test(decl)) {
    throw new Error('text field does not target horizontal whitespace specifically');
  }
});

// ── v1.20.0: two-stage extract → review flow ─────────────────────────────────
t('saveJob POSTs finalized fields to /api/jobs/inbox', () => {
  // v1.20.0 renamed addJob → saveJob. It's called from stage C (review)
  // after the user has confirmed the extracted fields. Takes title/company
  // from the review form inputs (rev-*), not from content.js directly.
  const idx = popup.indexOf('async function saveJob');
  if (idx < 0) throw new Error('saveJob function missing');
  const body = popup.slice(idx, idx + 3500);
  if (!/\/api\/jobs\/inbox/.test(body))     throw new Error('saveJob does not POST to /api/jobs/inbox');
  if (!/method:\s*['"]POST['"]/.test(body)) throw new Error('saveJob not using POST');
  // Must read from review-form inputs, not stale content.js payload
  if (!/rev-title/.test(body)) throw new Error('saveJob does not read rev-title from review form');
});

t('startExtract POSTs reader payload to /api/extract-job-fields', () => {
  const idx = popup.indexOf('async function startExtract');
  if (idx < 0) throw new Error('startExtract function missing (stage B trigger)');
  const body = popup.slice(idx, idx + 4000);
  if (!/\/api\/extract-job-fields/.test(body)) {
    throw new Error('startExtract does not POST to /api/extract-job-fields');
  }
  // Must gzip html before sending — raw HTML is 500KB-1.5MB per page
  if (!/gzipBase64|compressed:\s*['"]gzip['"]/.test(body)) {
    throw new Error('startExtract does not gzip-compress the html field');
  }
  // Must use a hard timeout so popup doesn't hang forever on AI outages
  if (!/AbortController|EXTRACT_TIMEOUT_MS/.test(body)) {
    throw new Error('startExtract has no timeout — popup could hang indefinitely');
  }
});

t('saveJob does NOT do GET+modify+PUT on /api/jobs (would corrupt encrypted blob)', () => {
  // Same bug as before v2.4.0 — extension must never touch the encrypted
  // jobs blob directly. Inbox-only.
  const idx = popup.indexOf('async function saveJob');
  const body = popup.slice(idx, idx + 3500);
  if (/method:\s*['"]PUT['"][\s\S]{0,200}\/api\/jobs['"]/.test(body)) {
    throw new Error('saveJob still PUTs to /api/jobs — this corrupts encrypted accounts');
  }
  if (/fetch\([^)]*\/api\/jobs['"]\s*,\s*\{[\s\S]{0,100}Authorization/.test(body)) {
    const matches = body.match(/fetch\([^)]*\/api\/jobs[^)]*\)/g) || [];
    for (const m of matches) {
      if (!/inbox/.test(m)) {
        throw new Error('saveJob still reads /api/jobs directly — should only POST to /inbox');
      }
    }
  }
});

// ── v1.20.0: content.js reader payload, server extractor, edit modal ───────
console.log('\n── v1.20.0 architecture');

t('content.js returns reader payload (url + html + text + jsonLd + title + meta)', () => {
  // The extension is now a "reader" — zero extraction, just capture. The
  // sendResponse must include every field the server's unified extractor
  // can use. Missing any of them silently degrades extraction quality.
  const idx = content.indexOf("msg.action !== 'extractJob'");
  if (idx < 0) throw new Error('extractJob handler not found');
  const body = content.slice(idx, idx + 4000);
  // Must return html (gzipped on the wire, but the field still named html here)
  if (!/sendResponse\([\s\S]*?html[\s\S]*?\)/.test(body)) {
    throw new Error('content.js sendResponse does not include html');
  }
  if (!/sendResponse\([\s\S]*?text[\s\S]*?\)/.test(body)) {
    throw new Error('content.js sendResponse does not include text');
  }
  if (!/sendResponse\([\s\S]*?jsonLd[\s\S]*?\)/.test(body)) {
    throw new Error('content.js sendResponse does not include jsonLd');
  }
  if (!/sendResponse\([\s\S]*?meta[\s\S]*?\)/.test(body)) {
    throw new Error('content.js sendResponse does not include meta');
  }
});

t('content.js strips <script>/<style>/<svg> from html before sending', () => {
  // Pre-wire content cleaning: scripts/styles/svg can be 60-80% of a
  // typical page, carry zero job-posting signal, and bloat the POST.
  // This is NOT semantic extraction — the stripping rules are fixed
  // (no field inference).
  const idx = content.indexOf("msg.action !== 'extractJob'");
  const body = content.slice(idx, idx + 4000);
  // Check source literal presence of the strip regexes
  if (!body.includes('<script\\b') && !body.includes('<script\\\\b')) {
    throw new Error('content.js does not strip <script> tags');
  }
  if (!body.includes('<style\\b') && !body.includes('<style\\\\b')) {
    throw new Error('content.js does not strip <style> tags');
  }
});

t('content.js preserves JSON-LD script contents before stripping', () => {
  // Subtle: the strip-scripts regex would also nuke <script type="application/
  // ld+json"> blocks. We harvest those FIRST into a separate jsonLd array.
  const idx = content.indexOf("msg.action !== 'extractJob'");
  const body = content.slice(idx, idx + 4000);
  if (!/application\/ld\+json/.test(body)) {
    throw new Error('content.js does not harvest JSON-LD before stripping scripts');
  }
  // The harvesting must happen before the html strip runs, or the
  // structured data is lost. Check that jsonLd is derived from a
  // querySelectorAll call that precedes the .replace for <script>.
  const jsonLdIdx = body.indexOf('application/ld+json');
  const scriptStripIdx = body.indexOf('<script');
  // jsonLdIdx should appear in source BEFORE the replace(/<script.../) code.
  // The replace is inside the html-cleaning block which is at the top.
  // Actually the simpler invariant: jsonLd variable is assigned from
  // document.querySelectorAll somewhere in the handler.
  if (!/jsonLd\s*=\s*\[\.\.\.document\.querySelectorAll/.test(body)) {
    throw new Error('jsonLd not harvested via querySelectorAll — may have been stripped');
  }
});

t('popup has gzipBase64 helper using CompressionStream', () => {
  if (!/function\s+gzipBase64|const\s+gzipBase64\s*=/.test(popup)) {
    throw new Error('gzipBase64 helper not defined');
  }
  if (!/CompressionStream\(['"]gzip['"]\)/.test(popup)) {
    throw new Error('gzipBase64 does not use CompressionStream("gzip")');
  }
  // Must handle missing CompressionStream without crashing (old browsers)
  if (!/typeof\s+CompressionStream/.test(popup)) {
    throw new Error('gzipBase64 does not guard against missing CompressionStream');
  }
});

t('popup has three stages: initial, extracting, review', () => {
  // Enumerated in the showStage function — if any stage is missing, the
  // UX flow breaks silently (clicking a button leaves nothing visible).
  if (!/showStage\s*\(\s*['"]initial['"]/.test(popup))    throw new Error('no showStage("initial") call');
  if (!/showStage\s*\(\s*['"]extracting['"]/.test(popup)) throw new Error('no showStage("extracting") call');
  if (!/showStage\s*\(\s*['"]review['"]/.test(popup))     throw new Error('no showStage("review") call');
  // And the HTML must have the corresponding DOM elements
  for (const id of ['stage-initial', 'stage-extracting', 'stage-review']) {
    if (!new RegExp(`id="${id}"`).test(popupHtml)) {
      throw new Error(`popup.html missing stage element id="${id}"`);
    }
  }
});

t('popup 15s hard timeout is wired via AbortController', () => {
  // Without a timeout, AI outages would hang the popup forever.
  if (!/EXTRACT_TIMEOUT_MS\s*=\s*\d+/.test(popup)) {
    throw new Error('EXTRACT_TIMEOUT_MS constant missing');
  }
  if (!/new AbortController\(\)/.test(popup)) {
    throw new Error('AbortController not used to enforce the timeout');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
