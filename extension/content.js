// Summit Chrome Extension — content.js v3.0
// New unified architecture: browser reads rendered DOM, AI extracts fields.
// No site-specific selectors needed — works on any job board automatically.

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

  // ── 2. Salary — prefer structured sources over body text ──────────────────
  let salary = null;

  // a) JSON-LD baseSalary (most precise)
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(el.textContent);
      const jobs = Array.isArray(data) ? data : [data];
      const job = jobs.find(d => d && d['@type'] === 'JobPosting');
      if (job && job.baseSalary && job.baseSalary.value) {
        const v = job.baseSalary.value;
        if (v.minValue && v.maxValue) {
          const fmt = n => n >= 1000 ? '$' + Math.round(n / 1000) + 'k' : '$' + Math.round(n).toLocaleString();
          salary = fmt(v.minValue) + '–' + fmt(v.maxValue);
          break;
        }
      }
    } catch {}
  }

  // b) <bdi>$220,000</bdi> pattern (Greenhouse)
  if (!salary) {
    const bdis = [...document.querySelectorAll('bdi')]
      .map(b => b.textContent.trim())
      .filter(t => /^\$[\d,]+/.test(t));
    if (bdis.length >= 2) {
      const fmt = s => { const n = parseFloat(s.replace(/[$,]/g, '')); return n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString(); };
      salary = fmt(bdis[0]) + '–' + fmt(bdis[1]);
    }
  }

  // c) First dollar range visible in the job section
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

  sendResponse({ bodyText, salary, url: location.href });
  return true;
});
