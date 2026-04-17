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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
