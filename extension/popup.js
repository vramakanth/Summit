// Summit Chrome Extension — popup.js v2.0
const $ = id => document.getElementById(id);
const TRACKER_URL = 'https://jobsummit.app';

let token = '', currentTabUrl = '', currentTab = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStatus(el, type, msg) {
  el.className = 'status show ' + type;
  el.textContent = msg;
}
function hideStatus(el) { el.className = 'status'; }

function setProgress(pct, label) {
  $('parse-bar').classList.add('active');
  $('parse-bar-fill').style.width = pct + '%';
  if (label) $('parse-inline').textContent = label;
}
function clearProgress() {
  $('parse-bar').classList.remove('active');
  $('parse-bar-fill').style.width = '0%';
  $('parse-inline').textContent = '';
}

function setBadge(fieldId, label) {
  const b = $(fieldId + '-badge');
  if (b && label) { b.textContent = label; b.style.display = 'inline-block'; }
}

function fillField(id, val, badge) {
  if (val && typeof val === 'string' && val.trim()) {
    $(id).value = val.trim();
    if (badge) setBadge(id.replace('job-',''), badge);
    return true;
  }
  return false;
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0];
  currentTabUrl = currentTab?.url || '';

  // Show URL chip
  const urlDisplay = currentTabUrl.replace(/^https?:\/\/(www\.)?/, '').slice(0, 55);
  $('detected-url').textContent = urlDisplay || 'No URL';

  // Show favicon
  if (currentTab?.favIconUrl) {
    $('favicon').src = currentTab.favIconUrl;
    $('favicon').style.display = 'block';
  }

  // Check auth
  const stored = await chrome.storage.local.get(['token', 'username']);
  if (stored.token) {
    token = stored.token;
    showMainView(stored.username);
    startParsing();
  } else {
    $('login-view').style.display = 'block';
    $('header-sub').textContent = 'Sign in to your account';
  }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
async function doLogin() {
  const user = $('username').value.trim();
  const pass = $('password').value;
  if (!user || !pass) { showStatus($('login-status'), 'error', 'Fill in all fields'); return; }

  $('login-btn').disabled = true;
  $('login-btn').textContent = 'Signing in...';
  try {
    const res = await fetch(TRACKER_URL + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    const data = await res.json();
    if (!res.ok) { showStatus($('login-status'), 'error', data.error || 'Login failed'); return; }
    token = data.token;
    await chrome.storage.local.set({ token: data.token, username: user });
    showMainView(user);
    startParsing();
  } catch(e) {
    showStatus($('login-status'), 'error', 'Cannot connect to Summit');
  }
  $('login-btn').disabled = false;
  $('login-btn').textContent = 'Sign in';
}

function showMainView(username) {
  $('login-view').style.display = 'none';
  $('main-view').style.display = 'block';
  $('header-sub').textContent = username ? `Signed in as ${username}` : 'Job Tracker';
}

// ── SMART PARSING — 2-path approach ──────────────────────────────────────────
async function startParsing() {
  if (!currentTabUrl || currentTabUrl.startsWith('chrome://') || currentTabUrl.startsWith('chrome-extension://')) {
    $('parse-inline').textContent = '⚠ Browser page';
    return;
  }

  setProgress(15, 'Reading page...');

  // Path 1: Ask content script for what it can read from the DOM
  let pageData = null;
  try {
    pageData = await new Promise((resolve) => {
      chrome.tabs.sendMessage(currentTab.id, { action: 'extractJob' }, resp => {
        resolve(chrome.runtime.lastError ? null : resp);
      });
    });
  } catch {}

  const isLinkedIn = /linkedin\.com\/jobs/i.test(currentTabUrl);
  const isGlassdoor = /glassdoor\.com/i.test(currentTabUrl);

  // If page content has good fields already (non-LinkedIn), use them right away
  if (pageData?.title && !isLinkedIn) {
    applyFields(pageData, 'page');
  }

  // Path 2: Server-side parse (better for most ATS platforms)
  setProgress(40, isLinkedIn ? 'Using page content...' : 'Parsing with AI...');

  try {
    const parseRes = await fetch(TRACKER_URL + '/api/parse-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ url: currentTabUrl }),
    });

    if (parseRes.ok) {
      const parsed = await parseRes.json();
      const isBlocked = parsed._linkedinBlocked || parsed._spaShell;

      if (!isBlocked && parsed.fields) {
        // Server gave us structured fields directly (Greenhouse, Lever, Workday etc.)
        setProgress(75, 'Extracting details...');
        applyFields(parsed.fields, parsed._ats || 'api');
        setProgress(100, '✓');
        setTimeout(clearProgress, 1200);
        return;
      }

      // We have text — ask AI to extract fields
      const textToUse = parsed.text || pageData?.bodyText || '';
      if (textToUse && textToUse.length > 100) {
        setProgress(65, 'Extracting with AI...');
        try {
          const aiRes = await fetch(TRACKER_URL + '/api/extract-fields', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ url: currentTabUrl, text: textToUse.slice(0, 5000) }),
          });
          if (aiRes.ok) {
            const aiFields = await aiRes.json();
            if (aiFields) applyFields(aiFields, 'ai');
          }
        } catch {}
      }

      // If URL parsing failed but we have page fields from content script, use those
      if (isBlocked && pageData?.title) {
        applyFields(pageData, 'page');
        $('parse-inline').textContent = isLinkedIn ? '⚠ LinkedIn — from page' : '⚠ From page';
        setTimeout(clearProgress, 2000);
        return;
      }
    }
  } catch(e) {
    // Network error — fall back to page content only
    if (pageData?.title) applyFields(pageData, 'page');
  }

  setProgress(100, '✓');
  setTimeout(clearProgress, 1000);
}

function applyFields(fields, source) {
  if (!fields) return;
  const badge = source === 'ai' ? 'ai' : source === 'page' ? 'page' : source;
  // Only overwrite if field is currently empty OR new value is better
  const overwrite = (id, val) => {
    if (val && typeof val === 'string' && val.trim()) {
      if (!$(id).value || source === 'ai') {
        fillField(id, val, badge);
      }
    }
  };
  overwrite('job-title',   fields.title);
  overwrite('job-company', fields.company);
  overwrite('job-location', fields.location);
  overwrite('job-salary',  fields.salary);
  if (fields.workType && !$('job-worktype').value) {
    $('job-worktype').value = fields.workType;
  }
  if (fields.remote && !$('job-worktype').value) {
    $('job-worktype').value = 'Remote';
  }
}

// ── ADD JOB ───────────────────────────────────────────────────────────────────
async function addJob() {
  const title   = $('job-title').value.trim();
  const company = $('job-company').value.trim();
  if (!title || !company) {
    showStatus($('add-status'), 'error', 'Title and company are required');
    return;
  }

  $('add-btn').disabled = true;
  $('add-btn').textContent = 'Adding...';
  hideStatus($('add-status'));

  try {
    // Fetch current jobs (returns object keyed by id)
    const jobsRes = await fetch(TRACKER_URL + '/api/jobs', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (jobsRes.status === 401) { await signOut(); return; }
    const jobs = await jobsRes.json();

    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const newJob = {
      id, title, company,
      url:      currentTabUrl,
      status:   'to apply',
      location: $('job-location').value.trim(),
      workType: $('job-worktype').value,
      salary:   $('job-salary').value.trim(),
      notes:    [],
      createdAt: Date.now(),
      source:   'extension',
    };

    // Add to object and save
    if (Array.isArray(jobs)) {
      // Handle array format
      jobs.push(newJob);
    } else {
      jobs[id] = newJob;
    }

    const saveRes = await fetch(TRACKER_URL + '/api/jobs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(jobs),
    });
    if (!saveRes.ok) throw new Error('Save failed');

    showStatus($('add-status'), 'success', `✓ "${title}" added to Summit!`);
    $('add-btn').textContent = '✓ Added!';
    setTimeout(() => {
      $('add-btn').disabled = false;
      $('add-btn').textContent = '+ Add to Summit';
    }, 3000);

  } catch(e) {
    showStatus($('add-status'), 'error', 'Error: ' + e.message);
    $('add-btn').disabled = false;
    $('add-btn').textContent = '+ Add to Summit';
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
