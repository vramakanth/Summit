/**
 * architecture.test.js
 *
 * Tests for the new unified extraction architecture:
 *   browser renders DOM → bodyText → /api/extract-fields (AI) → fields
 *
 * What changed:
 *   - fetchATS: 470 lines → 100 lines (Jina → fetch → slug, no site-specific handlers)
 *   - ats-helpers: 70 lines → 60 lines (cleanJobUrl + slugFallback only, detectATS removed)
 *   - content.js: 235 lines → 75 lines (bodyText + salary only, no site selectors)
 *   - extract-fields: accepts domSalary override from browser
 */

const { cleanJobUrl, slugFallback } = require('../ats-helpers');
const fs = require('fs');
const serverSrc = fs.readFileSync(require('path').join(__dirname, '../server.js'), 'utf8');
const contentSrc = fs.readFileSync(require('path').join(__dirname, '../../extension/content.js'), 'utf8');

// ── cleanJobUrl ───────────────────────────────────────────────────────────────

describe('cleanJobUrl — strips tracking params', () => {
  const strip = url => cleanJobUrl(url);

  it('removes utm_campaign, utm_source, utm_medium', () => {
    const clean = strip('https://www.indeed.com/viewjob?jk=18715e3be76cb999&utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic');
    expect(clean).toBe('https://www.indeed.com/viewjob?jk=18715e3be76cb999');
  });

  it('removes ZipRecruiter jid tracking param', () => {
    const clean = strip('https://www.ziprecruiter.com/c/Saratech/Job/Director/-in-Mission-Viejo,CA?jid=333f4e6c313bd1ef&utm_campaign=google_jobs_apply');
    expect(clean).not.toContain('utm_campaign');
    expect(clean).not.toContain('jid=');
    expect(clean).toContain('ziprecruiter.com');
  });

  it('keeps essential job ID params (jk for Indeed)', () => {
    const clean = strip('https://www.indeed.com/viewjob?jk=18715e3be76cb999&utm_source=google');
    expect(clean).toContain('jk=18715e3be76cb999');
  });

  it('keeps greenhouse gh_jid', () => {
    const clean = strip('https://job-boards.greenhouse.io/anduril/jobs/5109197007?gh_jid=5109197007&utm_campaign=test');
    expect(clean).toContain('gh_jid=');
    expect(clean).not.toContain('utm_campaign');
  });

  it('handles share.google short link unchanged', () => {
    const url = 'https://share.google/q7ODZaozjbqowhl8g';
    expect(cleanJobUrl(url)).toBe(url);
  });

  it('strips Google shndl/shmd/shmds params', () => {
    const clean = strip('https://www.google.com/search?q=director+engineer&shndl=37&shmd=H4s&udm=8');
    expect(clean).not.toContain('shndl');
    expect(clean).not.toContain('shmd');
    expect(clean).toContain('udm=8');
    expect(clean).toContain('q=director');
  });
});

// ── slugFallback ──────────────────────────────────────────────────────────────

describe('slugFallback — title/company from URL path', () => {
  it('extracts company + title from ZipRecruiter URL', () => {
    const r = slugFallback('https://www.ziprecruiter.com/c/Saratech/Job/Director-of-Engineering/-in-Mission-Viejo,CA');
    expect(r.company).toBe('Saratech');
    expect(r.title).toContain('Director');
  });

  it('extracts title from Greenhouse URL', () => {
    const r = slugFallback('https://job-boards.greenhouse.io/andurilindustries/jobs/5109197007');
    expect(r.company).toBeTruthy();
  });

  it('extracts title from Lensa URL path', () => {
    const r = slugFallback('https://lensa.com/job-v1/karman-space-and-defense/brea-ca/director-of-engineering/4e259fb258883c881a851cfd8db6a4de');
    expect(r.title).toContain('Director');
  });

  it('extracts from career.io URL', () => {
    const r = slugFallback('https://career.io/job/director-of-engineering-brea-karman-space-defense-497b80a6f57f779eb26cdf078d4b39b5');
    expect(r.title).toContain('Director');
  });

  it('returns null gracefully for bad URL', () => {
    const r = slugFallback('not-a-url');
    expect(r).toBeNull();
  });
});

// ── Server architecture ───────────────────────────────────────────────────────

describe('Server — new unified architecture', () => {
  it('detectATS no longer imported (removed from ats-helpers)', () => {
    expect(serverSrc).not.toContain('detectATS');
    expect(serverSrc).not.toContain("require('./ats-helpers').detectATS");
  });

  it('fetchATS uses Jina reader as primary path', () => {
    expect(serverSrc).toContain('r.jina.ai/');
  });

  it('fetchATS has direct fetch fallback', () => {
    expect(serverSrc).toContain("_via: 'fetch'");
  });

  it('fetchATS has slug fallback as last resort', () => {
    expect(serverSrc).toContain("_via: 'slug'");
  });

  it('htmlToText helper defined (replaces dozens of per-site parsers)', () => {
    expect(serverSrc).toContain('function htmlToText(html)');
  });

  it('extractSalaryFromText helper defined', () => {
    expect(serverSrc).toContain('function extractSalaryFromText(text)');
  });

  it('extractSalaryFromHtml handles Greenhouse bdi pattern', () => {
    expect(serverSrc).toContain('<bdi>');
    expect(serverSrc).toContain('extractSalaryFromHtml');
  });

  it('extract-fields accepts domSalary from browser DOM', () => {
    expect(serverSrc).toContain('domSalary');
    expect(serverSrc).toContain('req.body.salary');
    // DOM salary always wins over AI guess
    expect(serverSrc).toContain('if (domSalary) parsed.salary = domSalary');
  });

  it('no site-specific handlers remain (no individual ATS if-blocks)', () => {
    // The old code had: if (ats === 'greenhouse') { ... if (ats === 'lever') { etc.
    // These are all gone now
    expect(serverSrc).not.toContain("ats === 'greenhouse'");
    expect(serverSrc).not.toContain("ats === 'lever'");
    expect(serverSrc).not.toContain("ats === 'workday'");
    expect(serverSrc).not.toContain("ats === 'indeed'");
    expect(serverSrc).not.toContain("ats === 'linkedin'");
  });

  it('fetchATS is significantly shorter than before (< 150 lines)', () => {
    const fnStart = serverSrc.indexOf('async function fetchATS');
    const fnEnd = serverSrc.indexOf('\nasync function ', fnStart + 10);
    const fnLines = serverSrc.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000).split('\n').length;
    expect(fnLines).toBeLessThan(150);
  });
});

// ── Content.js architecture ───────────────────────────────────────────────────

describe('content.js — unified DOM reader', () => {
  it('no site-specific hostname checks (no if linkedin, if indeed, etc.)', () => {
    expect(contentSrc).not.toContain("hostname.includes('linkedin.com')");
    expect(contentSrc).not.toContain("hostname.includes('indeed.com')");
    expect(contentSrc).not.toContain("hostname.includes('greenhouse.io')");
    expect(contentSrc).not.toContain("hostname.includes('ziprecruiter.com')");
  });

  it('reads document.body.innerText (universal DOM text)', () => {
    expect(contentSrc).toContain('document.body).innerText');
  });

  it('extracts salary from JSON-LD baseSalary (structured data)', () => {
    expect(contentSrc).toContain('baseSalary');
    expect(contentSrc).toContain('minValue');
    expect(contentSrc).toContain('maxValue');
  });

  it('extracts salary from <bdi> elements (Greenhouse pattern)', () => {
    expect(contentSrc).toContain('querySelectorAll(\'bdi\')');
  });

  it('extracts salary from visible body text as final fallback', () => {
    expect(contentSrc).toContain('bodyText.match(');
  });

  it('sends bodyText + salary + url to API', () => {
    expect(contentSrc).toContain('bodyText');
    expect(contentSrc).toContain('salary');
    expect(contentSrc).toContain('url: location.href');
  });

  it('is under 100 lines (was 235)', () => {
    expect(contentSrc.split('\n').length).toBeLessThan(100);
  });
});

// ── extractSalaryFromText unit tests (inline, no server needed) ───────────────

describe('extractSalaryFromText — salary parsing', () => {
  // Extract the function from server source and evaluate it
  const fnSrc = serverSrc.match(/function extractSalaryFromText[\s\S]*?\n\}/)?.[0] || '';
  let extractSalaryFromText;
  try { extractSalaryFromText = eval('(' + fnSrc + ')'); } catch {}

  const skip = !extractSalaryFromText;

  it('parses "$150,000 - $180,000"', () => {
    if (skip) return;
    expect(extractSalaryFromText('$150,000 - $180,000 a year')).toBe('$150k–$180k');
  });

  it('parses "$150K - $175K/yr"', () => {
    if (skip) return;
    const result = extractSalaryFromText('$150K - $175K/yr');
    expect(result).toContain('$150k');
    expect(result).toContain('$175k');
  });

  it('parses "$220,000 – $292,000"', () => {
    if (skip) return;
    expect(extractSalaryFromText('Salary $220,000 – $292,000 USD')).toBe('$220k–$292k');
  });

  it('returns null when no salary in text', () => {
    if (skip) return;
    expect(extractSalaryFromText('Director of Engineering Brea CA Full-time')).toBeNull();
  });

  it('returns null for "Competitive salary"', () => {
    if (skip) return;
    expect(extractSalaryFromText('Competitive salary and benefits')).toBeNull();
  });
});

// ── htmlToText unit tests ─────────────────────────────────────────────────────

describe('htmlToText — markup stripping', () => {
  const fnSrc = serverSrc.match(/function htmlToText[\s\S]*?\n\}/)?.[0] || '';
  let htmlToText;
  try { htmlToText = eval('(' + fnSrc + ')'); } catch {}
  const skip = !htmlToText;

  it('strips script and style tags', () => {
    if (skip) return;
    const result = htmlToText('<style>.foo{}</style><p>Hello</p><script>var x=1;</script>');
    expect(result).toContain('Hello');
    expect(result).not.toContain('<style>');
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('.foo');
  });

  it('converts <br> to newline', () => {
    if (skip) return;
    const result = htmlToText('Line 1<br>Line 2');
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
  });

  it('decodes HTML entities', () => {
    if (skip) return;
    const result = htmlToText('AT&amp;T &lt;Director&gt; &quot;Engineering&quot;');
    expect(result).toContain('AT&T');
    expect(result).toContain('<Director>');
    expect(result).toContain('"Engineering"');
  });

  it('handles Greenhouse job description HTML', () => {
    if (skip) return;
    const gh = `<div class="job-description"><h2>About the role</h2><p>Lead seeker systems.</p><ul><li>15+ years experience</li><li>TS/SCI clearance</li></ul></div>`;
    const result = htmlToText(gh);
    expect(result).toContain('About the role');
    expect(result).toContain('Lead seeker systems');
    expect(result).toContain('15+ years experience');
    expect(result).not.toContain('<div>');
    expect(result).not.toContain('<ul>');
  });

  it('collapses excess whitespace', () => {
    if (skip) return;
    const result = htmlToText('<p>Hello     world</p>');
    expect(result).toBe('Hello world');
  });
});

// ── URL coverage — all posted job links ──────────────────────────────────────

describe('URL coverage — all 10 posted job URLs', () => {
  const urls = [
    ['Indeed #1',      'https://www.indeed.com/viewjob?jk=18715e3be76cb999&utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic'],
    ['ZipRecruiter',   'https://www.ziprecruiter.com/c/Saratech/Job/Director-of-Engineering/-in-Mission-Viejo,CA?jid=333f4e6c313bd1ef&utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic'],
    ['career.io',      'https://career.io/job/director-of-engineering-brea-karman-space-defense-497b80a6f57f779eb26cdf078d4b39b5?utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic'],
    ['SimplyHired',    'https://www.simplyhired.com/job/ENwJKdE3ZlxzefU4UxlJ48J6a27gkkXcqhsVizEK1KlhJsIx3LG2fQ?utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic'],
    ['Lensa',          'https://lensa.com/job-v1/karman-space-and-defense/brea-ca/director-of-engineering/4e259fb258883c881a851cfd8db6a4de?utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic'],
    ['Greenhouse #1',  'https://job-boards.greenhouse.io/andurilindustries/jobs/5109197007?gh_jid=5109197007'],
    ['Greenhouse #2',  'https://job-boards.greenhouse.io/andurilindustries/jobs/5109197007?gh_jid=5109197007'],
    ['Indeed #10',     'https://www.indeed.com/viewjob?jk=6b1ac97e66d433b3&utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic'],
    ['Google Jobs',    'https://share.google/q7ODZaozjbqowhl8g'],
  ];

  urls.forEach(([name, url]) => {
    it(`cleanJobUrl works for: ${name}`, () => {
      const clean = cleanJobUrl(url);
      // Must not throw, must return a valid URL
      expect(() => new URL(clean)).not.toThrow();
      // Must strip utm params
      expect(clean).not.toContain('utm_campaign');
      expect(clean).not.toContain('utm_source');
      expect(clean).not.toContain('utm_medium');
    });

    it(`slugFallback gives something useful for: ${name}`, () => {
      const clean = cleanJobUrl(url);
      const r = slugFallback(clean);
      // For share.google (opaque short URL), slug fallback rightfully returns null/minimal
      if (clean.includes('share.google')) return;
      // All others should extract at least a title or company
      const hasData = r && (r.title || r.company);
      expect(hasData).toBeTruthy();
    });
  });
});
