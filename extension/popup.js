// Applied Chrome Extension - popup.js
const $ = id => document.getElementById(id);
const setStatus = (el, type, msg) => {
  el.className = 'status ' + type;
  el.textContent = msg;
};

let apiUrl = '', token = '';

async function init() {
  const stored = await chrome.storage.local.get(['apiUrl', 'token', 'username']);
  if (stored.apiUrl && stored.token) {
    apiUrl = stored.apiUrl;
    token = stored.token;
    showMain();
    detectJobInfo();
  } else {
    if (stored.apiUrl) $('api-url').value = stored.apiUrl;
    $('login-view').style.display = 'block';
  }
}

async function doLogin() {
  const url = $('api-url').value.trim().replace(/\/+$/, '');
  const user = $('username').value.trim();
  const pass = $('password').value;
  if (!url || !user || !pass) { setStatus($('login-status'), 'error', 'Fill in all fields'); return; }
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
    apiUrl = url;
    token = data.token;
    await chrome.storage.local.set({ apiUrl: url, token: data.token, username: user });
    $('login-view').style.display = 'none';
    showMain();
    detectJobInfo();
  } catch(e) {
    setStatus($('login-status'), 'error', 'Cannot connect to tracker: ' + e.message);
  }
  $('login-btn').disabled = false;
  $('login-btn').textContent = 'Sign in';
}

function showMain() {
  $('main-view').style.display = 'block';
  // Get current tab URL
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) $('detected-url').textContent = tabs[0].url;
  });
}

function detectJobInfo() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'detectJob' }, resp => {
      if (chrome.runtime.lastError || !resp) {
        // Fallback: parse from page title
        const title = tabs[0].title || '';
        $('job-title').value = title.split(' - ')[0].split(' | ')[0].trim();
        return;
      }
      if (resp.title) { $('job-title').value = resp.title; $('title-source').textContent = 'detected'; }
      if (resp.company) { $('job-company').value = resp.company; $('company-source').textContent = 'detected'; }
      if (resp.location) $('job-location').value = resp.location;
      if (resp.workType) $('job-worktype').value = resp.workType;
      if (resp.salary) $('job-salary').value = resp.salary;
    });
  });
}

async function addJob() {
  const title = $('job-title').value.trim();
  const company = $('job-company').value.trim();
  if (!title || !company) { setStatus($('add-status'), 'error', 'Job title and company are required'); return; }

  $('add-btn').disabled = true;
  $('add-btn').textContent = 'Adding...';

  try {
    // First get current jobs
    const jobsRes = await fetch(apiUrl + '/api/jobs', { headers: { Authorization: 'Bearer ' + token } });
    if (!jobsRes.ok) { doLogout(); return; }
    const jobs = await jobsRes.json();

    // Create new job
    const id = Math.random().toString(36).slice(2,10) + Date.now().toString(36);
    const url = $('detected-url').textContent;
    jobs[id] = {
      id, title, company,
      url, status: 'applied',
      location: $('job-location').value.trim(),
      workType: $('job-worktype').value,
      salary: $('job-salary').value.trim(),
      notes: [], createdAt: Date.now(),
    };

    // Save
    const saveRes = await fetch(apiUrl + '/api/jobs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(jobs),
    });

    if (!saveRes.ok) throw new Error('Save failed');
    setStatus($('add-status'), 'success', `✓ "${title}" added to Applied!`);
    $('add-btn').textContent = '✓ Added!';
    setTimeout(() => { $('add-btn').disabled = false; $('add-btn').textContent = '+ Add to Applied'; }, 2000);
  } catch(e) {
    setStatus($('add-status'), 'error', 'Error: ' + e.message);
    $('add-btn').disabled = false;
    $('add-btn').textContent = '+ Add to Applied';
  }
}

function openTracker() {
  chrome.tabs.create({ url: apiUrl });
}

async function doLogout() {
  await chrome.storage.local.clear();
  $('main-view').style.display = 'none';
  $('login-view').style.display = 'block';
  token = ''; apiUrl = '';
}

document.addEventListener('DOMContentLoaded', init);