// ats-helpers.js — URL cleaning + extraction utilities used across fetchATS
// and the uploaded-page endpoint. All helpers are deterministic (no AI,
// no network) and safe to call from any code path.
//
// v1.18 removed slugFallback and its dependencies (GENERIC_PATH_SEGMENTS,
// cleanToProseCase, looksLikeRealTitle, validateTitle). Slug-from-URL was
// the final fallback when direct-fetch + Chromium both failed, but its
// output was often wrong in subtle ways ("Lago 1" vs the real "Lago",
// "Bystadium" vs "Stadium") and silently polluted job records. It was
// replaced by an honest "we couldn't parse this page" response which
// prompts the user to use the browser extension, upload a saved HTML/PDF,
// or fill in manually — all of which produce strictly better results.
//
// looksLikeId + trimIdTokens are kept because parseJobPostingLD in server.js
// still uses them to sanitize JSON-LD values (e.g. Workday's "001 MTB Inc."
// company names).

// ────────────────────────────────────────────────────────────────────────────
// URL cleaning
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip tracking params and normalise a job URL. Idempotent.
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
      'shndl','shmd','shmds','jbr','sv',
    ];
    REMOVE.forEach(p => u.searchParams.delete(p));
    if (u.hash === '#' || u.hash === '') u.hash = '';
    return u.toString();
  } catch {
    return raw.trim();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Shared utilities
// ────────────────────────────────────────────────────────────────────────────

/**
 * Decode the most common HTML entities. Used to clean JSON-LD values before
 * storing — previously "&amp;" was leaking through to displayed titles
 * (e.g. "Validation &amp; Verification").
 */
function decodeEntities(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

/**
 * Heuristic: does this token look like a machine ID rather than human-
 * readable text? Used by parseJobPostingLD to strip internal codes out of
 * JSON-LD values (e.g. Workday prefixes its company names with "001 ",
 * "005 ", and title text sometimes has trailing "R83098" kind of codes).
 *
 * Returns true if the token shouldn't appear in a user-visible title/company.
 */
function looksLikeId(s) {
  if (!s) return true;
  // 2 chars or fewer — almost always a locale code, grade indicator, etc.
  if (s.length <= 2) return true;
  // Pure digits — but 4-digit years (1900-2100) are almost always legitimate
  // title qualifiers on new-grad / internship / batch postings ("Summer 2026",
  // "2026 New Grad"), so preserve those.
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    const isYear = s.length === 4 && n >= 1900 && n <= 2100;
    if (!isYear) return true;
  }
  // UUID with or without hyphens (Lever / Ashby IDs:
  //   "7c185ae4-3fdd-4613-8152-3ede45d2b7c0")
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) return true;
  // Hex blob 16+ chars (shorter ATS IDs)
  if (/^[0-9a-f]{16,}$/i.test(s.replace(/-/g, ''))) return true;
  // Uppercase alphanumeric 8+ chars (Workable job codes: "BFAAE89AEF",
  // "20E43B7913"). Case-sensitive on purpose — "Firecrawl" shouldn't trip.
  if (/^[A-Z0-9]{8,}$/.test(s)) return true;
  // >=60% digits over a short string (Workday suffixes: "R-056359",
  // "JR-0104403-1", "R83098", "2503435-2")
  const digits = (s.match(/\d/g) || []).length;
  if (s.length >= 5 && digits / s.length > 0.6) return true;
  return false;
}

/**
 * Strip leading and trailing ID-like tokens from a whitespace-separated
 * string. Preserves ID-like tokens in the middle (rare but possible).
 *   "Senior Software Engineer Java 8 Azure Migration R83098"
 *     → "Senior Software Engineer Java 8 Azure Migration"
 */
function trimIdTokens(title) {
  if (!title) return title;
  const words = title.split(/\s+/).filter(Boolean);
  while (words.length && looksLikeId(words[words.length - 1])) words.pop();
  while (words.length && looksLikeId(words[0])) words.shift();
  return words.join(' ');
}

module.exports = {
  cleanJobUrl,
  decodeEntities,
  looksLikeId,
  trimIdTokens,
};
