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
t('popup version comment bumped to v2.2', () => {
  if (!/popup\.js v2\.2/.test(popup)) throw new Error('popup header not updated');
});
t('manifest version bumped to 2.2.0', () => {
  if (manifest.version !== '2.2.0') throw new Error('manifest still at ' + manifest.version);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
