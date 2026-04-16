/**
 * Summit — ATS Parsing Unit Tests  v2
 * Covers: cleanJobUrl, detectATS, slugFallback,
 *         salary extraction (baseSalary, description text, script-tag, body text),
 *         JSON-LD field extraction, SPA shell fallback to jsonLdText.
 * All tests are pure — zero network calls.
 */

const { cleanJobUrl, detectATS, slugFallback } = require('../ats-helpers');

// ─── Shared helpers (mirror server-side logic) ────────────────────────────────
const fmt = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return n >= 1000 ? '$' + Math.round(n / 1000) + 'k' : '$' + Math.round(n).toLocaleString();
};

function salaryFromDescription(text) {
  const m = text.match(
    /[Ss]alary[\s\S]{0,20}\$([\d,]+(?:\.\d+)?)\s*[-\u2013\u2014to]+\s*\$([\d,]+(?:\.\d+)?)/
  );
  return m ? fmt(m[1]) + '\u2013' + fmt(m[2]) : null;
}

function extractFromHtml(html) {
  let scriptSalary = null, jsonLdText = '', jsonLdFields = null;
  const scriptTags = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, sc] of scriptTags) {
    if (sc.length < 50) continue;
    if (sc.includes('"@type"') && sc.includes('JobPosting')) {
      try {
        const jld = JSON.parse(sc.trim());
        const jobs = Array.isArray(jld) ? jld : [jld];
        const job = jobs.find(d => d['@type'] === 'JobPosting') || jobs[0];
        if (job) {
          const loc = job.jobLocation?.address;
          jsonLdFields = {
            title:    job.title || null,
            company:  job.hiringOrganization?.name || null,
            location: [loc?.addressLocality, loc?.addressRegion].filter(Boolean).join(', ') || null,
            workType: job.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null,
            remote:   job.jobLocationType === 'TELECOMMUTE',
          };
          if (job.description) {
            jsonLdText = job.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
            if (!scriptSalary) scriptSalary = salaryFromDescription(jsonLdText);
          }
          if (!scriptSalary && job.baseSalary?.value) {
            const bv = job.baseSalary.value;
            if (bv.minValue && bv.maxValue) scriptSalary = fmt(bv.minValue) + '\u2013' + fmt(bv.maxValue);
          }
        }
      } catch {}
    }
    if (!scriptSalary) {
      const m = sc.match(/"Salary":\s*"\$([\d,.]+ ?[-\u2013\u2014] ?\$?[\d,.]+)"/)
             || sc.match(/"minValue":\s*([\d.]+)[\s\S]{0,100}"maxValue":\s*([\d.]+)/);
      if (m) scriptSalary = m[2] ? fmt(m[1]) + '\u2013' + fmt(m[2]) : m[1].trim();
    }
  }
  const bodyMatch = html.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  const bodyText = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
  const isSpaShell = bodyText.length < 200;
  const text = isSpaShell && jsonLdText ? jsonLdText : bodyText;
  const fields = scriptSalary ? { ...(jsonLdFields || {}), salary: scriptSalary } : jsonLdFields;
  return { fields, text, isSpaShell };
}

// ─── cleanJobUrl ──────────────────────────────────────────────────────────────

describe('cleanJobUrl', () => {
  it('strips #:~:text= text fragment (Dexcom/Chrome share link)', () => {
    const clean = cleanJobUrl('https://careers.dexcom.com/careers/job/41204804?domain=dexcom.com#:~:text=As%20the%20Senior,algorithms.');
    expect(clean).not.toContain('#:~:text');
    expect(clean).toContain('domain=dexcom.com');
  });

  it('preserves regular hash anchors', () => {
    const url = 'https://example.com/jobs/123#description';
    expect(cleanJobUrl(url)).toBe(url);
  });

  it('handles invalid URL gracefully', () => {
    expect(() => cleanJobUrl('not-a-url#:~:text=foo')).not.toThrow();
    expect(cleanJobUrl('not-a-url#:~:text=foo')).toBe('not-a-url');
  });

  it('preserves query params', () => {
    expect(cleanJobUrl('https://careers.dexcom.com/careers/job/123?domain=dexcom.com')).toContain('domain=dexcom.com');
  });

  it('strips fragment but keeps all query params', () => {
    const clean = cleanJobUrl('https://example.com/job?id=123&domain=co.com#:~:text=foo');
    expect(clean).toContain('id=123');
    expect(clean).not.toContain('#:~:text');
  });
});

// ─── detectATS ────────────────────────────────────────────────────────────────

describe('detectATS', () => {
  const cases = [
    ['https://boards.greenhouse.io/stripe/jobs/5678901',        'greenhouse',      'Greenhouse boards subdomain'],
    ['https://stripe.greenhouse.io/jobs/5678901',               'greenhouse',      'Greenhouse company subdomain'],
    ['https://jobs.lever.co/airbnb/abc-123-def-456',            'lever',           'Lever'],
    ['https://amazon.wd5.myworkdayjobs.com/en-US/Ext/job/S/T',  'workday',         'Workday wd5'],
    ['https://amazon.wd1.myworkdayjobs.com/en-US/Ext/job/S/T',  'workday',         'Workday wd1'],
    ['https://jobs.myworkdaysite.com/recruiting/co/site/job/x', 'workday',         'Workday myworkdaysite'],
    ['https://acme.bamboohr.com/jobs/view.php?id=123',          'bamboohr',        'BambooHR'],
    ['https://jobs.ashbyhq.com/openai/abc-123',                 'ashby',           'Ashby'],
    ['https://jobs.smartrecruiters.com/Salesforce/12345-sr',    'smartrecruiters', 'SmartRecruiters'],
    ['https://www.linkedin.com/jobs/view/3912345678/',          'linkedin',        'LinkedIn'],
    ['https://careers.dexcom.com/careers/job/41204804-sr-director-algorithm-engineering-remote-united-states?domain=dexcom.com',
                                                                'eightfold',       'Dexcom (Eightfold, ?domain= param)'],
    ['https://careers.google.com/jobs/results/1234?domain=google.com', 'eightfold', 'Generic Eightfold ?domain='],
    ['https://app.eightfold.ai/careers?domain=co.com',          'eightfold',       'eightfold.ai domain'],
    ['https://careers.nvidia.com/careers/job/9999?domain=nvidia.com', 'eightfold', 'Nvidia (Eightfold)'],
    ['https://www.indeed.com/viewjob?jk=abc123',                'indeed',          'Indeed viewjob'],
    ['https://www.indeed.com/jobs?q=engineer',                  'indeed',          'Indeed search'],
    ['https://www.glassdoor.com/job-listing/engineer-JV.htm',   'glassdoor',       'Glassdoor'],
    ['https://company.icims.com/jobs/123/job',                  'icims',           'iCIMS direct domain'],
    ['https://apply.workable.com/acme/j/abc123/',               'workable',        'Workable'],
    ['https://www.ziprecruiter.com/c/Co/Job/x',                 'generic',         'ZipRecruiter → generic'],
    ['https://wellfound.com/jobs/12345678-senior-engineer',     'generic',         'Wellfound → generic'],
    ['https://www.dice.com/jobs/detail/abc123',                 'generic',         'Dice → generic'],
    ['https://randomcompany.com/open-positions/42',             'generic',         'Unknown → generic'],
  ];

  cases.forEach(([url, expected, desc]) => {
    it(`${desc}: → ${expected}`, () => {
      expect(detectATS(url)).toBe(expected);
    });
  });

  it('Dexcom is NOT icims (regression — was misclassified before fix)', () => {
    expect(detectATS('https://careers.dexcom.com/careers/job/41204804?domain=dexcom.com')).not.toBe('icims');
    expect(detectATS('https://careers.dexcom.com/careers/job/41204804?domain=dexcom.com')).toBe('eightfold');
  });

  it('works after cleanJobUrl strips text fragment', () => {
    expect(detectATS(cleanJobUrl('https://careers.dexcom.com/careers/job/41204804?domain=dexcom.com#:~:text=foo'))).toBe('eightfold');
  });
});

// ─── slugFallback ─────────────────────────────────────────────────────────────

describe('slugFallback', () => {
  it('Dexcom URL: title, company=Dexcom, workType=Remote, remote=true', () => {
    const r = slugFallback('https://careers.dexcom.com/careers/job/41204804-sr-director-algorithm-engineering-remote-united-states?domain=dexcom.com');
    expect(r).not.toBeNull();
    expect(r.title).toMatch(/director|algorithm|engineering/i);
    expect(r.company).toBe('Dexcom');
    expect(r.workType).toBe('Remote');
    expect(r.remote).toBe(true);
  });

  it('careers.stripe.com → company=Stripe', () => {
    expect(slugFallback('https://careers.stripe.com/jobs/123-senior-software-engineer')?.company).toBe('Stripe');
  });

  it('jobs.netflix.com → company=Netflix', () => {
    expect(slugFallback('https://jobs.netflix.com/jobs/42-senior-engineer')?.company).toBe('Netflix');
  });

  it('detects Hybrid from slug', () => {
    expect(slugFallback('https://careers.acme.com/job/123-engineer-hybrid-new-york')?.workType).toBe('Hybrid');
  });

  it('strips 8-digit numeric job ID prefix', () => {
    const r = slugFallback('https://careers.acme.com/job/41204804-product-manager-remote');
    expect(r?.title).toMatch(/product|manager/i);
    expect(r?.title ?? '').not.toMatch(/\d{8}/);
  });

  it('strips JR-prefixed IDs from Workday slugs', () => {
    expect(slugFallback('https://amazon.wd5.myworkdayjobs.com/External/job/Seattle-WA/SDE_JR-12345')?.title ?? '').not.toContain('JR');
  });

  it('returns null for very short slugs', () => {
    expect(slugFallback('https://example.com/jobs/123')).toBeNull();
  });

  it('returns null for invalid URL without throwing', () => {
    expect(() => slugFallback('not-a-url')).not.toThrow();
    expect(slugFallback('not-a-url')).toBeNull();
  });
});

// ─── salaryFromDescription ────────────────────────────────────────────────────

describe('salaryFromDescription — salary buried in description text', () => {
  it('Dexcom exact pattern: $231,100.00 - $385,100.00 → $231k–$385k', () => {
    const desc = 'Dexcom is not responsible...\n\nSalary:\n\n$231,100.00 - $385,100.00\n';
    expect(salaryFromDescription(desc)).toBe('$231k\u2013$385k');
  });

  it('en-dash (–) separator', () => {
    expect(salaryFromDescription('Salary: $120,000.00 \u2013 $180,000.00')).toBe('$120k\u2013$180k');
  });

  it('em-dash (—) separator', () => {
    expect(salaryFromDescription('Salary: $150,000 \u2014 $200,000')).toBe('$150k\u2013$200k');
  });

  it('"to" word separator', () => {
    expect(salaryFromDescription('Salary $95,000 to $140,000 per year')).toBe('$95k\u2013$140k');
  });

  it('formats in k notation for large numbers', () => {
    const r = salaryFromDescription('Salary:\n$200,000 - $350,000');
    expect(r).toBe('$200k\u2013$350k');
    expect(r).not.toContain('200,000');
  });

  it('returns null for "Competitive"', () => {
    expect(salaryFromDescription('Salary: Competitive.')).toBeNull();
  });

  it('returns null for "DOE"', () => {
    expect(salaryFromDescription('Compensation: DOE')).toBeNull();
  });

  it('returns null when no salary text', () => {
    expect(salaryFromDescription('Great benefits and culture.')).toBeNull();
  });
});

// ─── extractFromHtml ──────────────────────────────────────────────────────────

describe('extractFromHtml — full HTML extraction', () => {
  it('Dexcom: all fields + salary from JSON-LD description text', () => {
    const html = `<html><head>
      <script type="application/ld+json">
        {"@context":"http://schema.org","@type":"JobPosting",
         "title":"Sr Director Algorithm Engineering",
         "description":"Job duties...\n\nSalary:\n\n$231,100.00 - $385,100.00\n",
         "hiringOrganization":{"@type":"Organization","name":"Dexcom"},
         "jobLocationType":"TELECOMMUTE"}
      </script>
    </head><body><div id="app">Loading...</div></body></html>`;

    const { fields, isSpaShell } = extractFromHtml(html);
    expect(fields?.title).toBe('Sr Director Algorithm Engineering');
    expect(fields?.company).toBe('Dexcom');
    expect(fields?.workType).toBe('Remote');
    expect(fields?.remote).toBe(true);
    expect(fields?.salary).toBe('$231k\u2013$385k');
    expect(isSpaShell).toBe(true);
  });

  it('uses structured baseSalary when no salary in description', () => {
    const html = `<html><head>
      <script type="application/ld+json">
        {"@type":"JobPosting","title":"Engineer","hiringOrganization":{"name":"Acme"},
         "baseSalary":{"@type":"MonetaryAmount","currency":"USD",
           "value":{"@type":"QuantitativeValue","minValue":120000,"maxValue":180000}}}
      </script>
    </head><body><div id="app"></div></body></html>`;
    expect(extractFromHtml(html).fields?.salary).toBe('$120k\u2013$180k');
  });

  it('description salary takes priority over baseSalary', () => {
    const html = `<html><head>
      <script type="application/ld+json">
        {"@type":"JobPosting","title":"Engineer",
         "description":"Salary:\n\n$200,000 - $300,000\n",
         "baseSalary":{"value":{"minValue":100000,"maxValue":150000}}}
      </script>
    </head><body><div id="app"></div></body></html>`;
    expect(extractFromHtml(html).fields?.salary).toBe('$200k\u2013$300k');
  });

  it('workType=Remote from jobLocationType TELECOMMUTE', () => {
    const html = `<html><head>
      <script type="application/ld+json">
        {"@type":"JobPosting","title":"Remote Engineer","jobLocationType":"TELECOMMUTE",
         "hiringOrganization":{"name":"RemoteCo"}}
      </script>
    </head><body><div id="app"></div></body></html>`;
    const { fields } = extractFromHtml(html);
    expect(fields?.workType).toBe('Remote');
    expect(fields?.remote).toBe(true);
  });

  it('SPA shell: text falls back to JSON-LD description for AI', () => {
    const desc = 'We need a great engineer. Salary:\n\n$150,000 - $250,000\n';
    const html = `<html><head>
      <script type="application/ld+json">
        {"@type":"JobPosting","title":"Staff Engineer","description":${JSON.stringify(desc)},
         "hiringOrganization":{"name":"Acme"}}
      </script>
    </head><body><div id="app">Loading...</div></body></html>`;
    const { isSpaShell, text } = extractFromHtml(html);
    expect(isSpaShell).toBe(true);
    expect(text).toContain('Salary');
    expect(text).toContain('150');
  });

  it('non-SPA page: uses body text, not JSON-LD description', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"JobPosting","title":"Engineer","description":"Short."}</script>
    </head><body>
      <main>
        <h1>Senior Engineer</h1>
        <p>We are looking for a talented engineer to join our team and build amazing products
        with modern technologies. Great opportunity for growth and learning in a fast-paced environment.</p>
      </main>
    </body></html>`;
    const { isSpaShell, text } = extractFromHtml(html);
    expect(isSpaShell).toBe(false);
    expect(text).toContain('Senior Engineer');
  });

  it('non-JSON-LD script with embedded "Salary" key', () => {
    const html = `<html><body>
      <script>window.__d = {"Salary":"$180,000 - $240,000","title":"Director"};</script>
      <div>Loading...</div>
    </body></html>`;
    expect(extractFromHtml(html).fields?.salary).toMatch(/180|240/);
  });

  it('returns null salary when only "Competitive" in scripts', () => {
    const html = `<html><head>
      <script type="application/ld+json">
        {"@type":"JobPosting","title":"Engineer","description":"Competitive salary."}
      </script>
    </head><body><div></div></body></html>`;
    expect(extractFromHtml(html).fields?.salary).toBeFalsy();
  });
});

// ─── End-to-end regression ────────────────────────────────────────────────────

describe('End-to-end regression: Dexcom URL with text fragment', () => {
  const url = 'https://careers.dexcom.com/careers/job/41204804-sr-director-algorithm-engineering-remote-united-states?domain=dexcom.com#:~:text=As%20the%20Senior%20Director%20Engineering,cloud%2Dbased%20predictive%20analytic%20algorithms.';

  it('clean → no text fragment, keeps domain param', () => {
    const c = cleanJobUrl(url);
    expect(c).not.toContain('#:~:text');
    expect(c).toContain('domain=dexcom.com');
  });

  it('detect → eightfold (not icims)', () => {
    expect(detectATS(cleanJobUrl(url))).toBe('eightfold');
  });

  it('slug → company=Dexcom, remote=true', () => {
    const r = slugFallback(cleanJobUrl(url));
    expect(r?.company).toBe('Dexcom');
    expect(r?.remote).toBe(true);
  });

  it('full HTML → title + company + remote + salary $231k–$385k', () => {
    const html = `<html><head>
      <script type="application/ld+json">
        {"@context":"http://schema.org","@type":"JobPosting",
         "title":"Sr Director Algorithm Engineering",
         "description":"Meet the team...\\n\\nSalary:\\n\\n$231,100.00 - $385,100.00\\n",
         "hiringOrganization":{"@type":"Organization","name":"Dexcom"},
         "jobLocation":{"@type":"Place","address":{"addressLocality":"","addressRegion":""}},
         "jobLocationType":"TELECOMMUTE","employmentType":"FULL_TIME"}
      </script>
    </head><body><div id="app">Loading...</div></body></html>`;

    const { fields, isSpaShell } = extractFromHtml(html);
    expect(fields?.title).toBe('Sr Director Algorithm Engineering');
    expect(fields?.company).toBe('Dexcom');
    expect(fields?.workType).toBe('Remote');
    expect(fields?.salary).toBe('$231k\u2013$385k');
    expect(isSpaShell).toBe(true);
  });
});
