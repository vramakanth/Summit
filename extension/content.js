// Summit Chrome Extension — content.js v3.1
// New unified architecture: browser reads rendered DOM, AI extracts fields.
// No site-specific selectors needed — works on any job board automatically.
//
// On jobsummit.app specifically, this script also acts as a bridge: the webapp
// cannot call chrome.runtime directly, so it posts window messages which we
// relay to background.js and post the response back.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'extractJob') return;

  // ── 1. Best text from rendered page ───────────────────────────────────────
  // Priority: job description section → main/article → full body
  // The browser has already run JS, handled auth, bypassed bot checks — we just read.
  const candidates = [
    '[class*="job-description"]', '[class*="jobDescription"]', '[id*="job-description"]',
    '[class*="job-detail"]',      '[class*="jobDetail"]',      '[class*="jobDesc"]',
    '[class*="description-content"]', '[class*="posting-content"]',
    'main article', 'main', 'article', '[role="main"]',
  ];
  let bodyEl = null;
  for (const sel of candidates) {
    try {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 300) { bodyEl = el; break; }
    } catch {}
  }
  const bodyText = (bodyEl || document.body).innerText
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  // ── 2. Structured fields from JSON-LD ────────────────────────────────────
  // Mirror of server-side parseJobPostingLD, but running inside the page's
  // own origin where bot-gated sites (Workable, Apple, LinkedIn) serve the
  // REAL JSON-LD rather than the bot-block shell our server sees.
  //
  // Workday occasionally prefixes company names with numeric codes like
  // "001 Manufacturers and Traders Trust Co" — we strip those. Entity
  // decoding handles "&amp;" in titles.
  const decodeEntities = s => {
    if (!s || typeof s !== 'string') return s;
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&(?:#39|apos);/g, "'").replace(/&nbsp;/g, ' ')
            .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  };
  const cleanStr = s => {
    if (!s || typeof s !== 'string') return null;
    const t = decodeEntities(s).replace(/^\d+\s+/, '').trim();
    return t || null;
  };
  const fmtSalary = (min, max) => {
    const fmt = n => n >= 1000 ? '$' + Math.round(n / 1000) + 'k' : '$' + Math.round(n).toLocaleString();
    if (min && max) return fmt(min) + '–' + fmt(max);
    if (min) return 'from ' + fmt(min);
    if (max) return 'up to ' + fmt(max);
    return null;
  };

  let fields = null;
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(el.textContent);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      const job = items.find(d => d && d['@type'] === 'JobPosting');
      if (!job) continue;

      // Title: strip Workday-style "001 " prefix
      const title = cleanStr(job.title);

      // Company can be a string or an Organization object
      let company = null;
      if (typeof job.hiringOrganization === 'string') company = cleanStr(job.hiringOrganization);
      else if (job.hiringOrganization?.name)           company = cleanStr(job.hiringOrganization.name);

      // Location: jobLocation can be array, object, or string. Pull city/region.
      let location = null;
      const locs = Array.isArray(job.jobLocation) ? job.jobLocation : (job.jobLocation ? [job.jobLocation] : []);
      for (const loc of locs) {
        if (typeof loc === 'string') { location = cleanStr(loc); break; }
        const addr = loc?.address;
        if (addr) {
          const parts = [addr.addressLocality, addr.addressRegion].filter(Boolean);
          if (parts.length) { location = parts.join(', '); break; }
          if (addr.addressCountry) { location = typeof addr.addressCountry === 'string' ? addr.addressCountry : addr.addressCountry.name; break; }
        }
      }

      const remote = job.jobLocationType === 'TELECOMMUTE' || /remote/i.test(job.applicantLocationRequirements?.name || '');

      // Salary from baseSalary.value (min/max preferred, single value tolerated)
      let salary = null;
      if (job.baseSalary?.value) {
        const v = job.baseSalary.value;
        salary = fmtSalary(v.minValue, v.maxValue) || (v.value ? fmtSalary(v.value, v.value) : null);
      }

      // Work type hint — employmentType is usually "FULL_TIME" etc.; use for workType inference
      const employmentType = typeof job.employmentType === 'string' ? job.employmentType : (Array.isArray(job.employmentType) ? job.employmentType[0] : null);
      let workType = null;
      if (remote) workType = 'Remote';
      else if (employmentType && /part/i.test(employmentType)) workType = null; // employmentType isn't the same as workType; don't force

      fields = { title, company, location, salary, workType, remote };
      break;
    } catch {}
  }

  // ── 3. Salary fallback — structured → <bdi> → body regex ─────────────────
  // Kept even when JSON-LD fields are present: if JSON-LD omitted salary we
  // still want to pick it up from the DOM.
  let salary = fields?.salary || null;

  if (!salary) {
    const bdis = [...document.querySelectorAll('bdi')]
      .map(b => b.textContent.trim())
      .filter(t => /^\$[\d,]+/.test(t));
    if (bdis.length >= 2) {
      const fmt = s => { const n = parseFloat(s.replace(/[$,]/g, '')); return n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString(); };
      salary = fmt(bdis[0]) + '–' + fmt(bdis[1]);
    }
  }

  if (!salary) {
    const m = bodyText.match(/\$([\d,]+(?:\.\d+)?)\s*[kK]?\s*[-–—to]+\s*\$([\d,]+(?:\.\d+)?)\s*[kK]?/);
    if (m) {
      const isK = /[kK]/.test(m[0]);
      const fmt = raw => {
        const n = parseFloat(raw.replace(/,/g, '')) * (isK && parseFloat(raw.replace(/,/g,'')) < 1000 ? 1000 : 1);
        return n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString();
      };
      salary = fmt(m[1]) + '–' + fmt(m[2]);
    }
  }

  // If we got JSON-LD fields but they lacked salary, backfill from DOM salary.
  if (fields && !fields.salary && salary) fields.salary = salary;

  sendResponse({ fields, bodyText, salary, url: location.href });
  return true;
});

// ──────────────────────────────────────────────────────────────────────────────
// BRIDGE — only active on jobsummit.app
// Webapp can't use chrome.runtime directly. We relay window.postMessage → background.
// ──────────────────────────────────────────────────────────────────────────────
(function initBridge() {
  const host = location.hostname;
  const isAppOrigin = host === 'jobsummit.app' || host === 'localhost' || host === '127.0.0.1';
  if (!isAppOrigin) return;

  // Announce ourselves so the webapp knows the extension is installed and reachable
  const announce = () => window.postMessage(
    { type: 'summit-ext-ready', version: chrome.runtime.getManifest().version },
    location.origin
  );
  announce();
  // Also respond to explicit pings (covers late-loading webapp scripts)
  // and re-announce if the webapp asks us to.

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'summit-bridge') return;
    const { nonce, action, url } = msg;
    if (!nonce) return;

    if (action === 'ping') {
      window.postMessage({ type: 'summit-bridge-response', nonce, ok: true, version: chrome.runtime.getManifest().version }, location.origin);
      return;
    }

    if (action === 'fetchPosting' && typeof url === 'string') {
      try {
        chrome.runtime.sendMessage({ action: 'fetchPosting', url }, (resp) => {
          if (chrome.runtime.lastError) {
            window.postMessage({ type: 'summit-bridge-response', nonce, ok: false, error: chrome.runtime.lastError.message || 'runtime-error' }, location.origin);
            return;
          }
          window.postMessage({ type: 'summit-bridge-response', nonce, ...(resp || { ok: false, error: 'no-response' }) }, location.origin);
        });
      } catch (e) {
        window.postMessage({ type: 'summit-bridge-response', nonce, ok: false, error: String(e?.message || e) }, location.origin);
      }
    }
  });
})();
