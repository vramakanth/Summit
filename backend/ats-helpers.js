// ats-helpers.js — URL cleaning only.
// Field extraction is now done by AI against rendered page text.

/**
 * Strip tracking params and normalise a job URL.
 * Returns the cleaned URL string.
 */
function cleanJobUrl(raw) {
  try {
    const u = new URL(raw.trim());
    const REMOVE = [
      'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
      'utm_id','ref','from','via','src','fbclid','gclid','msclkid',
      'mc_cid','mc_eid','_hsenc','_hsmi','hsCtaTracking',
      'jid','job_id',
      // indeed / google-specific noise
      'shndl','shmd','shmds','shmd','jbr','sv',
    ];
    REMOVE.forEach(p => u.searchParams.delete(p));
    // Remove empty fragments
    if (u.hash === '#' || u.hash === '') u.hash = '';
    return u.toString();
  } catch {
    return raw.trim();
  }
}

/**
 * Best-effort slug extraction from URL path when all fetch methods fail.
 * e.g. "ziprecruiter.com/c/Saratech/Job/Director-of-Engineering"
 *   → { company: "Saratech", title: "Director of Engineering" }
 */
function slugFallback(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    // Generic: title is the longest readable segment
    const readable = parts
      .map(p => p.replace(/[-_+]/g,' ').replace(/\b\w/g,c=>c.toUpperCase()).trim())
      .filter(p => p.length > 4 && !/^\d+$/.test(p) && !/^[a-f0-9]{20,}$/.test(p) && !/^[A-Z0-9]{8,}$/.test(p));

    // Heuristics per hostname
    const h = u.hostname;
    if (h.includes('ziprecruiter') && parts[0]==='c') {
      return { company: readable[0]||null, title: readable[1]||null };
    }
    if (h.includes('greenhouse') || h.includes('lever') || h.includes('ashby')) {
      return { company: readable[0]||null, title: readable[readable.length-1]||null };
    }
    if (h.includes('linkedin')) {
      const ti = parts.indexOf('view');
      return { title: ti>=0 ? readable[ti+1]||null : readable[readable.length-1]||null };
    }
    // Generic: last meaningful segment = title, second-to-last = company (if different)
    const title = readable[readable.length-1] || null;
    const company = readable.length > 1 ? readable[readable.length-2] : null;
    return { title, company: company !== title ? company : null };
  } catch { return null; }
}

module.exports = { cleanJobUrl, slugFallback };
