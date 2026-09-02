// Summit Chrome Extension — popup.js v2.6.0
//
// Two-stage flow:
//   Stage A (initial)    — show URL, "Add to Summit" button
//   Stage B (extracting) — spinner, 15s hard timeout
//   Stage C (review)     — editable form with extracted fields + Save/Cancel
//   Stage D (saved)      — success message, auto-close
//
// POSTs:
//   /api/extract-job-fields — reader payload (url + gzipped html + text + jsonLd + meta)
//   /api/jobs/inbox         — finalized fields (title + company + ...) after user review

const $ = id => document.getElementById(id);
const TRACKER_URL = 'https://jobsummit.app';
const EXTRACT_TIMEOUT_MS = 15000;

let token = '', currentTabUrl = '', currentTab = null;

// v1.20.1: after extraction, we hold onto the plain text of the posting so
// the subsequent inbox POST can carry it forward. This lets the job's
// description tab populate immediately without another server fetch.
let _capturedPostingText = '';

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStatus(el, type, msg) {
  el.className = 'status show ' + type;
  el.textContent = msg;
}
function hideStatus(el) { el.className = 'status'; }

function showStage(name) {
  for (const s of ['initial', 'extracting', 'review']) {
    const el = $('stage-' + s);
    if (el) el.style.display = s === name ? 'block' : 'none';
  }
}

// Gzip a string and return it as base64. Uses CompressionStream, which has
// been available in Chrome since 80 (2020). If for some reason the API is
// missing or throws, returns null and caller falls back to sending raw.
async function gzipBase64(str) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const blob = new Blob([str], { type: 'text/plain' });
    const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    // arrayBuffer → base64 — done in chunks to avoid call-stack overflow
    // for large buffers (btoa(String.fromCharCode(...arr)) blows up ~100KB).
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  } catch { return null; }
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  // Wire all handlers (MV3 CSP blocks inline handlers in popup HTML)
  $('login-btn').addEventListener('click', doLogin);
  $('password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('username').addEventListener('keydown', e => { if (e.key === 'Enter') $('password').focus(); });
  $('extract-btn').addEventListener('click', startExtract);
  $('cancel-btn').addEventListener('click', cancelReview);
  $('confirm-btn').addEventListener('click', saveJob);
  $('open-tracker-btn').addEventListener('click', openTracker);
  $('sign-out-btn').addEventListener('click', signOut);

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0];
  currentTabUrl = currentTab?.url || '';

  const urlDisplay = currentTabUrl.replace(/^https?:\/\/(www\.)?/, '').slice(0, 55);
  $('detected-url').textContent = urlDisplay || 'No URL';

  if (currentTab?.favIconUrl) {
    $('favicon').src = currentTab.favIconUrl;
    $('favicon').style.display = 'block';
  }

  // Block obviously-invalid pages
  if (!currentTabUrl || currentTabUrl.startsWith('chrome://') || currentTabUrl.startsWith('chrome-extension://')) {
    $('extract-btn').disabled = true;
    $('extract-btn').textContent = 'Not a webpage';
  }

  const stored = await chrome.storage.local.get(['token', 'username']);
  if (stored.token) {
    token = stored.token;
    showMainView(stored.username);
  } else {
    $('login-view').style.display = 'block';
    $('header-sub').textContent = 'Sign in to your account';
  }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
async function doLogin() {
  const user = $('username').value.trim();
  const pass = $('password').value;
  const btn = $('login-btn');
  if (!user || !pass) { showStatus($('login-status'), 'error', 'Fill in all fields'); return; }

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  try {
    const res = await fetch(TRACKER_URL + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = res.status === 401
        ? 'Incorrect username or password'
        : (data.error || data.detail || `Login failed (${res.status})`);
      showStatus($('login-status'), 'error', msg);
      return;
    }
    token = data.token;
    await chrome.storage.local.set({ token: data.token, username: user });
    showMainView(user);
  } catch(e) {
    showStatus($('login-status'), 'error', 'Cannot connect to Summit');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

function showMainView(username) {
  $('login-view').style.display = 'none';
  $('main-view').style.display = 'block';
  $('header-sub').textContent = username ? `Signed in as ${username}` : 'Job Tracker';
  showStage('initial');
}

// ── STAGE B: extract ─────────────────────────────────────────────────────────
async function startExtract() {
  if (!currentTabUrl || currentTabUrl.startsWith('chrome://') || currentTabUrl.startsWith('chrome-extension://')) {
    showStatus($('initial-status'), 'error', 'Not a job posting URL');
    return;
  }
  hideStatus($('initial-status'));
  showStage('extracting');
  $('extracting-msg').textContent = 'Reading page...';

  // Progressive status hints while the server works. Not tied to actual
  // pipeline stages — just lets the user know we're still alive.
  const hintTimer1 = setTimeout(() => { $('extracting-msg').textContent = 'Extracting details...'; }, 1500);
  const hintTimer2 = setTimeout(() => { $('extracting-msg').textContent = 'Almost done...'; }, 6000);

  try {
    // Ask content.js for the reader payload
    const reader = await new Promise((resolve) => {
      chrome.tabs.sendMessage(currentTab.id, { action: 'extractJob' }, r => {
        resolve(chrome.runtime.lastError ? null : r);
      });
    });

    // v1.20.1: stash the plain text for the subsequent inbox POST so the
    // job's description tab gets populated without another fetch. Cap the
    // size — 50KB is plenty for any realistic posting and keeps the inbox
    // entry small.
    _capturedPostingText = reader?.text ? String(reader.text).slice(0, 50000) : '';

    // Build the server payload. If content script is blocked (some browser
    // pages, some CSP-strict sites), we still post with url only and let
    // the server fall back to its own fetch.
    const body = { url: currentTabUrl };
    if (reader) {
      body.text   = reader.text   || '';
      body.jsonLd = reader.jsonLd || [];
      body.meta   = reader.meta   || {};
      body.title  = reader.title  || '';
      // Gzip the html — it's by far the biggest field. If gzip fails
      // (old browser, edge case), skip html entirely; text+jsonLd often
      // have enough signal for extraction on their own.
      if (reader.html) {
        const compressed = await gzipBase64(reader.html);
        if (compressed) {
          body.html = compressed;
          body.compressed = 'gzip';
        }
        // If compression failed, we omit html rather than ship 1MB raw.
      }
    }

    // 15s hard timeout via AbortController
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), EXTRACT_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(TRACKER_URL + '/api/extract-job-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (res.status === 401) { await signOut(); return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + res.status));
    }
    const data = await res.json();
    const f = data.fields || {};

    // Populate the review form
    $('rev-title').value    = f.title    || '';
    $('rev-company').value  = f.company  || '';
    $('rev-location').value = f.location || '';
    $('rev-worktype').value = f.workType || '';
    $('rev-salary').value   = f.salary   || '';
    // Store reqId/label on the form for the subsequent inbox POST
    $('rev-title').dataset.reqId      = f.reqId      || '';
    $('rev-title').dataset.reqIdLabel = f.reqIdLabel || '';

    showStage('review');
    setTimeout(() => $('rev-title').focus(), 60);
  } catch(e) {
    // Extraction failed — show initial stage with error, let user try again
    showStage('initial');
    const msg = e.name === 'AbortError'
      ? 'Extraction took too long. Try again or open Summit to add manually.'
      : 'Could not extract: ' + e.message;
    showStatus($('initial-status'), 'error', msg);
  } finally {
    clearTimeout(hintTimer1);
    clearTimeout(hintTimer2);
  }
}

// ── STAGE C cancel ───────────────────────────────────────────────────────────
function cancelReview() {
  // Back to initial. Nothing was saved — extract is stateless on the server.
  hideStatus($('review-status'));
  // Clear form so a subsequent extract shows clean state
  $('rev-title').value = '';
  $('rev-company').value = '';
  $('rev-location').value = '';
  $('rev-worktype').value = '';
  $('rev-salary').value = '';
  $('rev-title').dataset.reqId = '';
  $('rev-title').dataset.reqIdLabel = '';
  _capturedPostingText = '';
  showStage('initial');
}

// ── STAGE C save → inbox POST ────────────────────────────────────────────────
async function saveJob() {
  const title   = $('rev-title').value.trim();
  const company = $('rev-company').value.trim();
  if (!title || !company) {
    showStatus($('review-status'), 'error', 'Title and company are required');
    return;
  }
  $('confirm-btn').disabled = true;
  $('cancel-btn').disabled  = true;
  $('confirm-btn').textContent = 'Saving...';
  hideStatus($('review-status'));

  try {
    const body = {
      title, company,
      url:      currentTabUrl,
      location: $('rev-location').value.trim(),
      workType: $('rev-worktype').value,
      salary:   $('rev-salary').value.trim(),
    };
    // v1.20.1: forward the captured posting text so the description tab
    // populates immediately. Server stores it on the inbox entry; drain
    // carries it onto the job record.
    if (_capturedPostingText) body.postingText = _capturedPostingText;
    const reqId      = $('rev-title').dataset.reqId;
    const reqIdLabel = $('rev-title').dataset.reqIdLabel;
    if (reqId) body.reqId = reqId;
    if (reqIdLabel) body.reqIdLabel = reqIdLabel;

    const res = await fetch(TRACKER_URL + '/api/jobs/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { await signOut(); return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + res.status));
    }

    showStatus($('review-status'), 'success', `\u2713 "${title}" added to Summit!`);
    $('confirm-btn').textContent = '\u2713 Saved';
    // Auto-close the popup shortly after success
    setTimeout(() => { window.close(); }, 1400);

  } catch(e) {
    showStatus($('review-status'), 'error', 'Error: ' + e.message);
    $('confirm-btn').disabled = false;
    $('cancel-btn').disabled  = false;
    $('confirm-btn').textContent = 'Save to Summit';
  }
}

function openTracker() { chrome.tabs.create({ url: TRACKER_URL }); }

async function signOut() {
  await chrome.storage.local.clear();
  token = '';
  $('main-view').style.display = 'none';
  $('login-view').style.display = 'block';
  $('header-sub').textContent = 'Sign in to your account';
}

document.addEventListener('DOMContentLoaded', init);
