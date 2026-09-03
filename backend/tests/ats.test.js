/**
 * Summit — ats-helpers.js unit tests  v3
 *
 * v1.20.6 rewrite. The previous version (v2) had been failing in CI since
 * v1.18 without anyone noticing, because it lives in the non-blocking tier.
 * Three problems, all fixed here:
 *
 *   1. It imported `detectATS` and `slugFallback`, both deliberately removed
 *      in v1.18 (see the header comment in ats-helpers.js — slugFallback's
 *      output was silently wrong and polluted job records). 34 tests were
 *      throwing "is not a function".
 *
 *   2. It contained "mirror" copies of server-side extraction logic
 *      (extractFromHtml, salaryFromDescription) defined inside the test
 *      file and tested against themselves. Those mirrors drifted from the
 *      real code across v1.17 (Chromium render) and v1.20 (unified
 *      extractJobFields). A test that passes or fails independently of the
 *      code it claims to cover is worse than no test. The real extraction
 *      pipeline is covered by backend/tests/behavior.test.js (source guards)
 *      and backend/tests/encryption.test.js (HTTP round-trips).
 *
 *   3. It caught one REAL regression while I was cleaning it up:
 *      cleanJobUrl had stopped stripping Chrome's `#:~:text=` text-fragment
 *      directive. That's fixed in ats-helpers.js and pinned below.
 *
 * Everything in this file now tests an actual export of ats-helpers.js.
 * All tests are pure — zero network, zero server boot.
 */

const { cleanJobUrl, decodeEntities, looksLikeId, trimIdTokens } = require('../ats-helpers');

// ─── cleanJobUrl ─────────────────────────────────────────────────────────────

describe('cleanJobUrl — tracking params', () => {
  it('strips utm_* params', () => {
    const c = cleanJobUrl('https://example.com/job/1?utm_source=google&utm_medium=cpc&utm_campaign=x&id=42');
    expect(c).not.toContain('utm_');
    expect(c).toContain('id=42');
  });

  it('strips click IDs (fbclid, gclid, msclkid)', () => {
    const c = cleanJobUrl('https://example.com/job/1?fbclid=a&gclid=b&msclkid=c&keep=1');
    expect(c).not.toMatch(/fbclid|gclid|msclkid/);
    expect(c).toContain('keep=1');
  });

  it('strips generic referral params (ref, from, via, src)', () => {
    const c = cleanJobUrl('https://example.com/job/1?ref=twitter&from=feed&via=bot&src=x&real=y');
    expect(c).not.toMatch(/[?&](ref|from|via|src)=/);
    expect(c).toContain('real=y');
  });

  it('strips Indeed/Google noise (shndl, shmd, jbr, sv)', () => {
    const c = cleanJobUrl('https://www.indeed.com/viewjob?jk=abc&shndl=1&shmd=2&jbr=3&sv=4');
    expect(c).toBe('https://www.indeed.com/viewjob?jk=abc');
  });

  it('strips jid and job_id (ZipRecruiter-style session ids)', () => {
    const c = cleanJobUrl('https://www.ziprecruiter.com/c/Acme/Job/SWE?jid=abc123&job_id=999');
    expect(c).toBe('https://www.ziprecruiter.com/c/Acme/Job/SWE');
  });

  it('preserves non-tracking query params (domain=, gh_jid=)', () => {
    expect(cleanJobUrl('https://careers.dexcom.com/careers/job/41204804?domain=dexcom.com'))
      .toBe('https://careers.dexcom.com/careers/job/41204804?domain=dexcom.com');
    expect(cleanJobUrl('https://job-boards.greenhouse.io/x/jobs/5109197007?gh_jid=5109197007'))
      .toContain('gh_jid=5109197007');
  });

  it('is idempotent', () => {
    const once = cleanJobUrl('https://example.com/j?utm_source=a&id=1#:~:text=foo');
    expect(cleanJobUrl(once)).toBe(once);
  });
});

describe('cleanJobUrl — text-fragment directive (#:~:text=)', () => {
  // Chrome's "Copy link to highlight" appends `#:~:text=...`. It's not part
  // of the resource identity; leaving it in poisons URL-based dedupe.
  // REGRESSION: this was silently broken from v1.18 until v1.20.6.

  it('strips #:~:text= (Dexcom/Chrome share link)', () => {
    const c = cleanJobUrl('https://careers.dexcom.com/careers/job/41204804?domain=dexcom.com#:~:text=As%20the%20Senior,algorithms.');
    expect(c).not.toContain(':~:');
    expect(c).toContain('domain=dexcom.com');
    expect(c).toBe('https://careers.dexcom.com/careers/job/41204804?domain=dexcom.com');
  });

  it('strips fragment but keeps all query params', () => {
    const c = cleanJobUrl('https://example.com/job?id=123&domain=co.com#:~:text=foo');
    expect(c).toContain('id=123');
    expect(c).toContain('domain=co.com');
    expect(c).not.toContain(':~:');
  });

  it('preserves regular hash anchors', () => {
    expect(cleanJobUrl('https://example.com/job#apply')).toBe('https://example.com/job#apply');
  });

  it('preserves the anchor part when anchor + directive are both present', () => {
    // Spec: everything before `:~:` is the ordinary fragment.
    expect(cleanJobUrl('https://example.com/job#apply:~:text=foo')).toBe('https://example.com/job#apply');
  });

  it('clears an empty hash left behind', () => {
    expect(cleanJobUrl('https://example.com/job#')).toBe('https://example.com/job');
  });

  it('two Chrome-share URLs of the same posting normalise to the same string (dedupe key)', () => {
    const a = cleanJobUrl('https://example.com/job/1?domain=x#:~:text=first%20highlight');
    const b = cleanJobUrl('https://example.com/job/1?domain=x#:~:text=different%20highlight');
    expect(a).toBe(b);
  });
});

describe('cleanJobUrl — malformed input', () => {
  it('does not throw on an unparseable string', () => {
    expect(() => cleanJobUrl('not-a-url')).not.toThrow();
    expect(() => cleanJobUrl('')).not.toThrow();
  });

  it('still strips the text-fragment directive from an unparseable string', () => {
    expect(cleanJobUrl('not-a-url#:~:text=foo')).toBe('not-a-url');
  });

  it('trims surrounding whitespace', () => {
    expect(cleanJobUrl('   https://example.com/job   ')).toBe('https://example.com/job');
  });
});

// ─── decodeEntities ──────────────────────────────────────────────────────────

describe('decodeEntities', () => {
  it('decodes &amp; (the original bug: "Validation &amp; Verification")', () => {
    expect(decodeEntities('Validation &amp; Verification')).toBe('Validation & Verification');
  });

  it('decodes the common named entities', () => {
    expect(decodeEntities('&lt;b&gt;&quot;x&quot;&#39;y&apos;&nbsp;z')).toBe('<b>"x"\'y\' z');
  });

  it('decodes numeric and hex entities', () => {
    expect(decodeEntities('&#8211; &#x2013;')).toBe('\u2013 \u2013');
  });

  it('passes through non-strings and empty values unchanged', () => {
    expect(decodeEntities(null)).toBe(null);
    expect(decodeEntities(undefined)).toBe(undefined);
    expect(decodeEntities('')).toBe('');
    expect(decodeEntities(42)).toBe(42);
  });

  it('leaves already-plain text alone', () => {
    expect(decodeEntities('Senior Engineer, Platform')).toBe('Senior Engineer, Platform');
  });
});

// ─── looksLikeId ─────────────────────────────────────────────────────────────

describe('looksLikeId — machine IDs that should not appear in titles/companies', () => {
  // Cases lifted from the doc comment in ats-helpers.js.

  it('empty / very short tokens are IDs (locale codes, grades)', () => {
    expect(looksLikeId('')).toBe(true);
    expect(looksLikeId(null)).toBe(true);
    expect(looksLikeId('US')).toBe(true);
    expect(looksLikeId('L5')).toBe(true);
  });

  it('pure digit strings are IDs (Workday "001", "005" prefixes)', () => {
    expect(looksLikeId('001')).toBe(true);
    expect(looksLikeId('005')).toBe(true);
    expect(looksLikeId('12345678')).toBe(true);
  });

  it('...except 4-digit years, which are legitimate title qualifiers', () => {
    expect(looksLikeId('2026')).toBe(false);
    expect(looksLikeId('2025')).toBe(false);
    expect(looksLikeId('1999')).toBe(false);
    // Outside the plausible range → still an ID
    expect(looksLikeId('1800')).toBe(true);
    expect(looksLikeId('3000')).toBe(true);
  });

  it('UUIDs are IDs (Lever / Ashby)', () => {
    expect(looksLikeId('7c185ae4-3fdd-4613-8152-3ede45d2b7c0')).toBe(true);
    expect(looksLikeId('7c185ae43fdd461381523ede45d2b7c0')).toBe(true);
  });

  it('long hex blobs are IDs', () => {
    expect(looksLikeId('4e259fb258883c881a851cfd8db6a4de')).toBe(true);
  });

  it('uppercase alphanumeric codes are IDs (Workable "BFAAE89AEF")', () => {
    expect(looksLikeId('BFAAE89AEF')).toBe(true);
    expect(looksLikeId('20E43B7913')).toBe(true);
  });

  it('...but case matters — "Firecrawl" is a real word, not a code', () => {
    expect(looksLikeId('Firecrawl')).toBe(false);
    expect(looksLikeId('ANTHROPIC')).toBe(true);   // all-caps 8+ → code by the rule; documented trade-off
  });

  it('digit-heavy short tokens are IDs (Workday suffixes)', () => {
    expect(looksLikeId('R-056359')).toBe(true);
    expect(looksLikeId('JR-0104403-1')).toBe(true);
    expect(looksLikeId('R83098')).toBe(true);
    expect(looksLikeId('2503435-2')).toBe(true);
  });

  it('ordinary words and job-title tokens are NOT IDs', () => {
    for (const w of ['Senior', 'Software', 'Engineer', 'Java', 'Azure', 'Migration', 'Dexcom', 'Director', 'Platform']) {
      expect(looksLikeId(w)).toBe(false);
    }
  });

  it('short version-like tokens in titles are preserved ("Java 8", "C++")', () => {
    // "8" is ≤2 chars so it IS flagged — but trimIdTokens only strips from
    // the ends, so "Java 8 Azure" keeps its "8". Pin that interaction below.
    expect(looksLikeId('C++')).toBe(false);
  });
});

// ─── trimIdTokens ────────────────────────────────────────────────────────────

describe('trimIdTokens — strip leading/trailing ID tokens, keep the middle', () => {
  it('strips a trailing Workday requisition code', () => {
    expect(trimIdTokens('Senior Software Engineer Java 8 Azure Migration R83098'))
      .toBe('Senior Software Engineer Java 8 Azure Migration');
  });

  it('strips a leading Workday company prefix ("001 MTB Inc.")', () => {
    expect(trimIdTokens('001 MTB Inc.')).toBe('MTB Inc.');
  });

  it('strips from both ends at once', () => {
    expect(trimIdTokens('005 Director of Engineering JR-0104403-1')).toBe('Director of Engineering');
  });

  it('preserves ID-like tokens in the MIDDLE (e.g. "Java 8")', () => {
    expect(trimIdTokens('Java 8 Developer')).toBe('Java 8 Developer');
  });

  it('preserves 4-digit years anywhere', () => {
    expect(trimIdTokens('Summer 2026 Intern')).toBe('Summer 2026 Intern');
    expect(trimIdTokens('2026 New Grad Engineer')).toBe('2026 New Grad Engineer');
  });

  it('collapses runs of whitespace', () => {
    expect(trimIdTokens('  Senior   Engineer  ')).toBe('Senior Engineer');
  });

  it('returns falsy input unchanged', () => {
    expect(trimIdTokens('')).toBe('');
    expect(trimIdTokens(null)).toBe(null);
  });

  it('returns empty string if every token is an ID', () => {
    expect(trimIdTokens('001 R83098')).toBe('');
  });
});
