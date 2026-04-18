// ats-helpers.js — URL cleaning, slug-based fallback extraction, shared utilities.
// All extractors here are deterministic (no AI, no network) and safe to call
// from any code path.

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
 * Decode the most common HTML entities. Used to clean JSON-LD values and
 * other extractor outputs before storing — previously "&amp;" was leaking
 * through to displayed titles (e.g. "Validation &amp; Verification").
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
 * Heuristic: does this URL path segment look like a machine ID rather than
 * a human-readable word? Used to prevent garbage like
 *   "7c185ae4 3fdd 4613 8152 3ede45d2b7c0"
 *   "BFAAE89AEF"
 *   "5313690004"
 * from being promoted to job titles in the slug fallback.
 *
 * Returns true if the segment shouldn't be used as a title/company.
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
 * Segments from the URL that are almost never meaningful — don't contribute
 * to title or company extraction.
 */
const GENERIC_PATH_SEGMENTS = new Set([
  'jobs', 'job', 'careers', 'career', 'apply', 'application',
  'position', 'positions', 'opening', 'openings', 'role', 'roles',
  'opportunity', 'opportunities', 'details', 'view',
  'en', 'en-us', 'en-gb', 'en-ca', 'ca', 'us', 'uk', 'de', 'fr',
  'c', 'a', 'j', 'p', // single-letter ATS routing prefixes
]);

function cleanToProseCase(p) {
  return p
    // Percent-decode common artifacts (e.g. "%E2%80%93" en-dash) by dropping
    // them — they rarely belong in a clean title.
    .replace(/%[0-9a-f]{2}/gi, ' ')
    .replace(/[-_+]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/**
 * After a slug has been cleaned to prose case, strip off leading and
 * trailing tokens that look like IDs. Handles cases like
 *   "Senior Software Engineer Java 8 Azure Migration R83098"
 *     → "Senior Software Engineer Java 8 Azure Migration"
 *   "Software Engineer JR 000555"
 *     → "Software Engineer"
 */
function trimIdTokens(title) {
  if (!title) return title;
  const words = title.split(/\s+/).filter(Boolean);
  while (words.length && looksLikeId(words[words.length - 1])) words.pop();
  while (words.length && looksLikeId(words[0])) words.shift();
  return words.join(' ');
}

/**
 * Heuristic: does this cleaned, prose-cased string look like a real job
 * title rather than a munged URL slug? Requires at least 2 substantial
 * words (4+ chars, non-numeric leading).
 */
function looksLikeRealTitle(s) {
  if (!s) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const substantial = words.filter(w => w.length >= 4 && !/^\d/.test(w)).length;
  return substantial >= 2;
}

// ────────────────────────────────────────────────────────────────────────────
// Slug fallback — extract title/company from URL path only
// ────────────────────────────────────────────────────────────────────────────

/**
 * Last-resort extractor: when both Jina and direct fetch fail to produce
 * usable page contents, we guess title/company from the URL path. Produces
 * something usable for clean slugs like
 *   boards.greenhouse.io/figma/jobs/early-career-software-engineer-2026
 *     → { company: "Figma", title: "Early Career Software Engineer 2026" }
 * and deliberately leaves `title` null for URLs with machine IDs where a
 * good guess isn't available, instead of hallucinating garbage:
 *   jobs.lever.co/voleon/7c185ae4-3fdd-4613-8152-3ede45d2b7c0
 *     → { company: "Voleon", title: null }
 */
function slugFallback(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const h = u.hostname.toLowerCase();

    // First pass: drop generic routing segments and machine IDs. Keep the
    // original path index so hostname-specific rules still work.
    const indexed = parts
      .map((p, i) => ({ raw: p, i }))
      .filter(({ raw }) =>
        !GENERIC_PATH_SEGMENTS.has(raw.toLowerCase()) && !looksLikeId(raw));

    if (indexed.length === 0) return { title: null, company: null };

    // Per-host structural rules for known URL shapes.
    if (h.includes('ziprecruiter') && parts[0] === 'c') {
      const company = indexed.find(x => x.i === 1);
      const title = indexed.find(x => x.i > 2);
      return {
        company: company ? cleanToProseCase(company.raw) : null,
        title: title ? validateTitle(cleanToProseCase(title.raw)) : null,
      };
    }

    if (h.includes('greenhouse') || h.includes('lever') || h.includes('ashby')) {
      // First meaningful = company, last = title (if distinct + looks real).
      const company = indexed[0];
      const titleSeg = indexed.length > 1 ? indexed[indexed.length - 1] : null;
      return {
        company: cleanToProseCase(company.raw),
        title: titleSeg ? validateTitle(cleanToProseCase(titleSeg.raw)) : null,
      };
    }

    if (h.includes('linkedin')) {
      // LinkedIn /jobs/view/<id> pattern. Title/company are rendered by JS
      // and not in the URL path — no safe fallback.
      return { title: null, company: null };
    }

    // Generic fallback.
    if (indexed.length === 1) {
      // A single meaningful segment is ambiguous. If it's multi-word and
      // looks like a title ("technology-services-designer-i-ii"), call it
      // a title. Otherwise treat it as the company.
      const cleaned = cleanToProseCase(indexed[0].raw);
      const asTitle = validateTitle(cleaned);
      if (asTitle && cleaned.split(/\s+/).length >= 3) {
        return { title: asTitle, company: null };
      }
      return { company: cleaned, title: null };
    }

    // Multiple meaningful segments: first = company, last = title
    const companyStr = cleanToProseCase(indexed[0].raw);
    const titleStr = validateTitle(cleanToProseCase(indexed[indexed.length - 1].raw));
    return {
      company: companyStr,
      title: titleStr && titleStr !== companyStr ? titleStr : null,
    };
  } catch {
    return { title: null, company: null };
  }
}

/** Strip leading/trailing ID tokens and reject if what remains isn't a real title. */
function validateTitle(cleaned) {
  const trimmed = trimIdTokens(cleaned);
  return looksLikeRealTitle(trimmed) ? trimmed : null;
}

module.exports = {
  cleanJobUrl,
  slugFallback,
  decodeEntities,
  // Exported for server.js to reuse on JSON-LD values
  looksLikeId,
  trimIdTokens,
};
