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

      // Requisition / job ID from JobPosting.identifier. Same extraction
      // semantics as the server-side parseJobPostingLD: accept short
      // alphanumerics, reject URL-shaped values.
      let reqId = null, reqIdLabel = null;
      const idField = job.identifier;
      const idCandidates = Array.isArray(idField) ? idField : (idField ? [idField] : []);
      for (const cand of idCandidates) {
        let v = null, label = null;
        if (typeof cand === 'string') v = cand;
        else if (cand && typeof cand === 'object') {
          v = cand.value != null ? String(cand.value) : null;
          label = cand.name ? String(cand.name) : null;
        }
        if (!v) continue;
        v = v.trim();
        if (/^https?:\/\//i.test(v)) continue;
        if (!/^[A-Za-z0-9][A-Za-z0-9._\-]{2,40}$/.test(v)) continue;
        reqId = v;
        reqIdLabel = label || 'Job Identifier';
        break;
      }

      fields = { title, company, location, salary, workType, remote, reqId, reqIdLabel };
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

  // v1.19.13: use the shared text-extraction helper that mirrors the
  // server's extractSalaryFromText. The previous ad-hoc regex here
  // required a $ prefix on BOTH numbers in a range ("$X - $Y"), which
  // missed the common "$X - Y" form used by many Phenom/PCSX sites
  // including Dexcom. The helper supports:
  //   - $/£/€ currency symbols
  //   - "$X - Y", "$X to $Y", "$Xk – $Yk", etc.
  //   - single-value "$N per year" / "$N/hour"
  //   - sanity filters (lo ≥ 15, hi/lo ≤ 5) to reject things like
  //     "$1M - $10M ARR" or "5–10 years"
  if (!salary) {
    salary = _extractSalaryFromText(bodyText);
  }

  // If we got JSON-LD fields but they lacked salary, backfill from DOM salary.
  if (fields && !fields.salary && salary) fields.salary = salary;

  // ── 4. Requisition ID fallback — label-anchored DOM scrape ───────────────
  // For pages where JSON-LD didn't carry a JobPosting.identifier. We look
  // for elements whose text is a known label ("Job ID", "Requisition Number",
  // etc.) and pull the value from the element's sibling/next/parent-next
  // structure. Very conservative — we require a true label anchor rather
  // than matching "#123" anywhere in the body (which would false-positive on
  // reference numbers in job descriptions).
  if (!(fields && fields.reqId)) {
    const domReq = _extractReqIdFromDom();
    if (domReq) {
      fields = fields || { title:null, company:null, location:null, salary:null, workType:null, remote:false };
      fields.reqId = domReq.reqId;
      fields.reqIdLabel = domReq.label;
    }
  }

  sendResponse({ fields, bodyText, salary, url: location.href });
  return true;
});

// ── Salary text extractor ────────────────────────────────────────────────────
// Mirrors server-side extractSalaryFromText (see backend/server.js). Kept in
// sync by test: both should return the same output for the same input.
// Shared here via inline duplication rather than a shared module because
// MV3 content scripts don't easily import from the server bundle.
//
// Handles:
//   - $/£/€ currency symbols (anchored on symbol, not currency code)
//   - Range: "$X - Y", "$X – $Y", "$Xk to $Yk", "$X to Y"
//   - Single: "$N per year", "$N/hour", "$Nk annually"
//   - Sanity filters: lo ≥ 15, hi/lo ≤ 5, hourly range requires hour keyword
function _extractSalaryFromText(text) {
  if (!text) return null;
  const CUR = '[$£€]';
  const NUM = '\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
  const KSFX = '\\s*[kK]?';
  const JOIN = '\\s*(?:[-\\u2013\\u2014]|\\bto\\b)\\s*';
  // Range — single symbol required on first number; optional on second (common:
  // "$120k - 150k" without $ on second half, or "$180,000 to 250,000").
  const rangeRe = new RegExp(
    `(${CUR})\\s*(${NUM})${KSFX}${JOIN}(?:${CUR})?\\s*(${NUM})${KSFX}`,
    'g'
  );
  let m;
  while ((m = rangeRe.exec(text)) !== null) {
    const sym = m[1];
    const raw1 = m[2], raw2 = m[3];
    const hasK = /k/i.test(m[0]);
    const n1 = parseFloat(raw1.replace(/,/g, '')) * (hasK && parseFloat(raw1.replace(/,/g, '')) < 1000 ? 1000 : 1);
    const n2 = parseFloat(raw2.replace(/,/g, '')) * (hasK && parseFloat(raw2.replace(/,/g, '')) < 1000 ? 1000 : 1);
    const lo = Math.min(n1, n2), hi = Math.max(n1, n2);
    if (lo < 15) continue;
    if (hi / lo > 5) continue;
    if (hi < 25 && lo < 25) {
      const ctx = text.slice(Math.max(0, m.index - 40), Math.min(text.length, m.index + m[0].length + 40));
      if (!/hour|hr\b|hourly/i.test(ctx)) continue;
    }
    const fmt = (n) => n >= 1000 ? sym + Math.round(n/1000) + 'k' : sym + Math.round(n).toLocaleString();
    return fmt(Math.min(n1, n2)) + '\u2013' + fmt(Math.max(n1, n2));
  }
  // Single salary with explicit period
  const singleRe = new RegExp(
    `(${CUR})\\s*(${NUM})${KSFX}\\s*(?:USD|CAD|GBP|EUR)?\\s*(annually|per\\s*year|/\\s*year|/\\s*yr|yearly|annual|hourly|per\\s*hour|/\\s*hour|/\\s*hr)`,
    'i'
  );
  const sm = text.match(singleRe);
  if (sm) {
    const sym = sm[1];
    const hasK = /k/i.test(sm[0]);
    const n = parseFloat(sm[2].replace(/,/g, '')) * (hasK && parseFloat(sm[2].replace(/,/g, '')) < 1000 ? 1000 : 1);
    if (n < 15) return null;
    return n >= 1000 ? sym + Math.round(n/1000) + 'k' : sym + Math.round(n).toLocaleString();
  }
  return null;
}

// ── Label-anchored req ID scraper ─────────────────────────────────────────────
// Walks the DOM looking for text that matches a known req-ID label pattern,
// then inspects adjacent DOM positions for a value that fits the shape.
// Returns { reqId, label } or null. Designed to err on the side of null —
// a false positive here would corrupt dedupe and confuse the user.
const _REQ_LABEL_RE = /^(?:\s*(?:job\s*id|job\s*number|job\s*code|req(?:uisition)?\s*(?:id|number|code|#)|posting\s*id|reference\s*id|requisition|req\s*#)\s*[:.\-]?\s*)$/i;
const _REQ_VALUE_RE = /^[A-Z0-9][A-Z0-9._\-]{2,40}$/i;

function _extractReqIdFromDom() {
  // Prefer <dt>/<dd> and <th>/<td> pairs first — they're the most reliably
  // structured and give us the cleanest label→value association.
  for (const dt of document.querySelectorAll('dt, th')) {
    const labelText = (dt.textContent || '').trim();
    if (!_REQ_LABEL_RE.test(labelText)) continue;
    // Matching value: next dd for dt; sibling td for th.
    let valNode = null;
    if (dt.tagName === 'DT' && dt.nextElementSibling?.tagName === 'DD') {
      valNode = dt.nextElementSibling;
    } else if (dt.tagName === 'TH' && dt.parentElement) {
      // Same-row <td>: look at siblings in the same <tr>
      const cells = [...dt.parentElement.children];
      const idx = cells.indexOf(dt);
      if (idx >= 0 && cells[idx + 1]) valNode = cells[idx + 1];
    }
    if (!valNode) continue;
    const v = (valNode.textContent || '').trim();
    if (_REQ_VALUE_RE.test(v)) {
      return { reqId: v, label: labelText.replace(/[:.\-]\s*$/, '').trim() };
    }
  }
  // Looser fallback: any element whose text IS the label (no surrounding content)
  // and whose immediately following sibling has a value matching the shape.
  const candidates = document.querySelectorAll('span, div, p, label, strong, b');
  for (const el of candidates) {
    const labelText = (el.textContent || '').trim();
    if (!_REQ_LABEL_RE.test(labelText)) continue;
    // Try next element sibling first
    let sib = el.nextElementSibling;
    let v = sib ? (sib.textContent || '').trim() : '';
    // If no next sibling, try parent's next sibling (common in <div><label>Label</label></div><div>Value</div>)
    if (!_REQ_VALUE_RE.test(v) && el.parentElement?.nextElementSibling) {
      v = (el.parentElement.nextElementSibling.textContent || '').trim();
    }
    // Still nothing — maybe the label and value are both in the parent
    // as text nodes: "<p><b>Job ID</b> R-12345</p>". Pull parent text,
    // strip the label, see what's left.
    if (!_REQ_VALUE_RE.test(v) && el.parentElement) {
      const parentTxt = (el.parentElement.textContent || '').trim();
      const stripped = parentTxt.replace(labelText, '').replace(/^[\s:.\-]+/, '').trim();
      if (_REQ_VALUE_RE.test(stripped)) v = stripped;
    }
    if (_REQ_VALUE_RE.test(v)) {
      return { reqId: v, label: labelText.replace(/[:.\-]\s*$/, '').trim() };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// BRIDGE — only active on jobsummit.app
// Webapp can't use chrome.runtime directly. We relay window.postMessage → background.
// ──────────────────────────────────────────────────────────────────────────────
(function initBridge() {
  const host = location.hostname;
  const isAppOrigin = host === 'jobsummit.app' || host === 'localhost' || host === '127.0.0.1';
  if (!isAppOrigin) return;

  // ── Session sync (webapp → extension) ───────────────────────────────────
  // When the user signs in on jobsummit.app, their token lives in
  // localStorage as `applied_token`. The extension is a separate process
  // with its own chrome.storage.local; without sync, the user has to log
  // into the extension separately. Here we snapshot on every page load
  // and listen for cross-tab storage events so the extension tracks the
  // website's session automatically. Signs out cascade too — clearing the
  // token in the site triggers a clear in the extension.
  //
  // One-way by design (site → extension). The reverse (extension →
  // website) would need conflict resolution when the two diverge, and
  // doesn't solve registration (new users always sign up via the site).
  const pushSession = () => {
    try {
      const stored = localStorage.getItem('applied_token');
      const username = localStorage.getItem('applied_user');
      chrome.runtime.sendMessage({
        action: 'syncSession',
        token: stored || null,
        username: username || null,
      });
    } catch (e) { /* extension may not be reachable; harmless */ }
  };
  // Push once on initial injection. If the user reloads jobsummit.app, the
  // extension gets a fresh copy of the token.
  pushSession();
  // Storage events fire in OTHER tabs when the source tab writes to
  // localStorage. So a login/logout in tab A will sync tab B's extension
  // state. The source tab's own write doesn't emit this event — which is
  // why pushSession() runs again on page load there.
  window.addEventListener('storage', (e) => {
    if (e.key === 'applied_token' || e.key === 'applied_user' || e.key === null) {
      pushSession();
    }
  });

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

    // Webapp-initiated session sync trigger. The webapp posts this after
    // login/logout so the extension picks up the change immediately
    // (otherwise, in the source tab, we'd wait until next page load —
    // the `storage` event only fires in OTHER tabs).
    if (msg.type === 'summit-session-changed') {
      pushSession();
      return;
    }

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
