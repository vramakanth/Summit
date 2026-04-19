// extension.test.js — verifies the browser-fetch bridge is actually wired up.
// These tests protect against regressions like "chrome.tabs.create in the webapp"
// which looks plausible but can never work from a web page.

const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../extension/manifest.json'), 'utf8'));
const background = fs.readFileSync(path.join(__dirname, '../../extension/background.js'), 'utf8');
const content    = fs.readFileSync(path.join(__dirname, '../../extension/content.js'), 'utf8');

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

// ── v2.2: content.js returns structured fields from JSON-LD ───────────────
console.log('\n── extension v2.2 — content.js extracts full fields');
t('extractJob handler returns fields object (not just bodyText+salary)', () => {
  // Regression guard for the v2.1 bug: popup checked pageData.title but
  // content.js only returned {bodyText, salary, url}. Path 1 was silently
  // broken. v2.2 returns {fields, bodyText, salary, url}.
  const idx = content.indexOf("msg.action !== 'extractJob'");
  if (idx < 0) throw new Error('extractJob handler not found');
  // Find the sendResponse call in this handler
  const body = content.slice(idx, idx + 8000);
  const m = body.match(/sendResponse\(\s*\{[^}]*\}\s*\)/);
  if (!m) throw new Error('sendResponse call not found');
  if (!/fields/.test(m[0])) {
    throw new Error('sendResponse does not include fields — Path 1 will silently fail');
  }
});
t('extractJob parses JSON-LD JobPosting blocks', () => {
  const body = content.slice(content.indexOf("msg.action !== 'extractJob'"));
  if (!/application\/ld\+json/.test(body)) throw new Error('no ld+json script lookup');
  if (!/'JobPosting'|"JobPosting"/.test(body)) throw new Error('no JobPosting type check');
  if (!/hiringOrganization/.test(body)) throw new Error('no hiringOrganization lookup');
});
t('extractJob strips Workday-style numeric prefix from company name', () => {
  // "001 Manufacturers and Traders Trust Co" → "Manufacturers and ..."
  const body = content.slice(content.indexOf("msg.action !== 'extractJob'"));
  if (!/\/\^\\d\+\\s\+\//.test(body)) throw new Error('no numeric-prefix strip regex');
});
t('extractJob decodes HTML entities in titles', () => {
  const body = content.slice(content.indexOf("msg.action !== 'extractJob'"));
  if (!/decodeEntities|&amp;/.test(body)) throw new Error('no entity decoding');
});

// ── v2.2: popup startParsing flipped to page-first ────────────────────────
console.log('\n── extension v2.2 — popup priority');
const popup = fs.readFileSync(path.join(__dirname, '../../extension/popup.js'), 'utf8');
t('popup tries page content BEFORE server-side parse', () => {
  const idx = popup.indexOf('async function startParsing');
  if (idx < 0) throw new Error('startParsing not found');
  const body = popup.slice(idx, idx + 4000);
  const sendMsgIdx = body.indexOf("action: 'extractJob'");
  const parseJobIdx = body.indexOf("/api/parse-job");
  if (sendMsgIdx < 0) throw new Error('no content script call in startParsing');
  if (parseJobIdx < 0) throw new Error('no /api/parse-job call in startParsing');
  if (sendMsgIdx > parseJobIdx) {
    throw new Error('popup calls /api/parse-job BEFORE content script — should be page-first');
  }
});
t('popup skips /api/parse-job when page gives structured fields (zero round trip)', () => {
  const idx = popup.indexOf('async function startParsing');
  const body = popup.slice(idx, idx + 4000);
  // Find applyFields(pageData.fields,...) and verify there's a return before
  // any /api/parse-job call. Using a char-distance check is brittle due to
  // comments; instead locate the two indices directly.
  const pageApplyIdx = body.indexOf('applyFields(pageData.fields');
  if (pageApplyIdx < 0) throw new Error('no applyFields(pageData.fields) call');
  const sliceAfter = body.slice(pageApplyIdx);
  const returnIdx = sliceAfter.indexOf('return;');
  const serverIdx = sliceAfter.indexOf('/api/parse-job');
  if (returnIdx < 0) throw new Error('no return after applying page fields');
  if (serverIdx >= 0 && returnIdx > serverIdx) {
    throw new Error('/api/parse-job called BEFORE early return — wasteful round trip');
  }
});
t('popup version comment bumped to v2.3', () => {
  if (!/popup\.js v2\.3/.test(popup)) throw new Error('popup header not updated');
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
  // Sanity: every previously-inline button still needs an ID so popup.js
  // can find it and attach a listener. If someone removes an ID without
  // removing the listener wiring, the popup silently breaks again.
  for (const id of ['login-btn', 'add-btn', 'open-tracker-btn', 'sign-out-btn', 'username', 'password']) {
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
  if (!/\$\(['"]add-btn['"]\)\.addEventListener/.test(body)) {
    throw new Error('init does not wire add-btn click');
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

t('manifest version bumped to 2.3.0', () => {
  if (manifest.version !== '2.3.0') throw new Error('manifest still at ' + manifest.version);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
