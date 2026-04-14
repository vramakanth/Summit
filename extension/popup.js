// Applied Chrome Extension - popup.js
const $ = id => document.getElementById(id);
const setStatus = (el, type, msg) => { el.className = 'status ' + type; el.textContent = msg; };

const TRACKER_URL = 'https://job-application-tracker-hf1f.onrender.com';
let apiUrl = TRACKER_URL, token = '', currentTabUrl = '';

// ── INIT — runs on every popup open ──
async function init() {
  // Always grab the current tab URL immediately
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tabs[0]?.url || '';
  $('detected-url').textContent = currentTabUrl || 'No URL detected';

  // Check if already signed in — URL is always hardcoded to TRACKER_URL
  const stored = await chrome.storage.local.get(['token', 'username']);
  if (stored.token) {
    token = stored.token;
    apiUrl = TRACKER_URL;
    // Verify token is still valid
    try {
      const r = await fetch(apiUrl + '/api/jobs', { headers: { Authorization: 'Bearer ' + token } });
      if (r.status === 401) { await signOut(); return; }
    } catch(e) { /* offline — still show main */ }
    showMain();
    detectJobInfo(tabs[0]);
  } else {
    if (stored.apiUrl) $('api-url').value = stored.apiUrl;
    $('login-view').style.display = 'block';
  }
}

// ── LOGIN — only needed once, credentials saved permanently ──
async function doLogin() {
  const url = TRACKER_URL;
  const user = $('username').value.trim();
  const pass = $('password').value;
  if (!user || !pass) { setStatus($('login-status'), 'error', 'Fill in all fields'); return; }
  $('login-btn').disabled = true;
  $('login-btn').textContent = 'Signing in...';
  try {
    const res = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    const data = await res.json();
    if (!res.ok) { setStatus($('login-status'), 'error', data.error || 'Login failed'); return; }
    apiUrl = url; token = data.token;
    // Save permanently — never need to log in again
    await chrome.storage.local.set({ token: data.token, username: user });
    $('login-view').style.display = 'none';
    showMain();
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    detectJobInfo(tabs[0]);
  } catch(e) {
    setStatus($('login-status'), 'error', 'Cannot connect: ' + e.message);
  }
  $('login-btn').disabled = false;
  $('login-btn').textContent = 'Sign in';
}

// ── SHOW MAIN VIEW ──
function showMain() {
  $('main-view').style.display = 'block';
  // Show the live URL from address bar (updated in init)
  $('detected-url').textContent = currentTabUrl || 'No URL detected';
}

// ── DETECT JOB INFO from page content ──
function detectJobInfo(tab) {
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { action: 'detectJob' }, resp => {
    if (chrome.runtime.lastError || !resp) {
      // Fallback: parse title from tab
      const title = tab.title || '';
      $('job-title').value = title.split(' - ')[0].split(' | ')[0].trim();
      return;
    }
    if (resp.title)    { $('job-title').value = resp.title;    $('title-source').textContent = 'auto-detected'; }
    if (resp.company)  { $('job-company').value = resp.company; $('company-source').textContent = 'auto-detected'; }
    if (resp.location) $('job-location').value = resp.location;
    if (resp.workType) $('job-worktype').value = resp.workType;
    if (resp.salary)   $('job-salary').value = resp.salary;
  });
}

// ── ADD JOB — uses currentTabUrl captured on open ──
async function addJob() {
  const title   = $('job-title').value.trim();
  const company = $('job-company').value.trim();
  if (!title || !company) { setStatus($('add-status'), 'error', 'Title and company required'); return; }

  $('add-btn').disabled = true;
  $('add-btn').textContent = 'Adding...';

  try {
    const jobsRes = await fetch(apiUrl + '/api/jobs', { headers: { Authorization: 'Bearer ' + token } });
    if (jobsRes.status === 401) { await signOut(); return; }
    const jobs = await jobsRes.json();

    const id = Math.random().toString(36).slice(2,10) + Date.now().toString(36);
    jobs[id] = {
      id, title, company,
      url:      currentTabUrl,   // ← always from the address bar
      status:   'to apply',
      location: $('job-location').value.trim(),
      workType: $('job-worktype').value,
      salary:   $('job-salary').value.trim(),
      notes:    [],
      createdAt: Date.now(),
    };

    const saveRes = await fetch(apiUrl + '/api/jobs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(jobs),
    });
    if (!saveRes.ok) throw new Error('Save failed');

    setStatus($('add-status'), 'success', `✓ "${title}" added!`);
    $('add-btn').textContent = '✓ Added!';
    setTimeout(() => { $('add-btn').disabled = false; $('add-btn').textContent = '+ Add to Applied'; }, 2500);
  } catch(e) {
    setStatus($('add-status'), 'error', 'Error: ' + e.message);
    $('add-btn').disabled = false;
    $('add-btn').textContent = '+ Add to Applied';
  }
}

function openTracker() { chrome.tabs.create({ url: apiUrl }); }

async function signOut() {
  await chrome.storage.local.clear();
  token = ''; apiUrl = '';
  $('main-view').style.display = 'none';
  $('login-view').style.display = 'block';
}

document.addEventListener('DOMContentLoaded', init);
