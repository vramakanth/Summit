/**
 * Summit Extension — content.js Extraction Logic Tests
 *
 * Tests the pure extraction functions used in content.js v2.1.
 * All functions are inlined here (mirroring content.js exactly) so tests
 * run in Node without needing a real browser or Chrome APIs.
 *
 * Run: cd frontend/tests && npm test
 */

// ─── Mirror content.js pure functions ────────────────────────────────────────

const fmt = (s) => {
  const n = parseFloat(String(s).replace(/[$,]/g, ''));
  return n >= 1000 ? '$' + Math.round(n / 1000) + 'k' : '$' + Math.round(n).toLocaleString();
};

/** Extract salary from JSON-LD description text (Dexcom/Eightfold pattern) */
function salaryFromDescription(text) {
  const m = text.match(
    /[Ss]alary[\s\S]{0,20}\$([\d,]+(?:\.\d+)?)\s*[-\u2013\u2014to]+\s*\$([\d,]+(?:\.\d+)?)/
  );
  return m ? fmt(m[1]) + '\u2013' + fmt(m[2]) : null;
}

/** Extract salary from structured baseSalary JSON-LD field */
function salaryFromBaseSalary(baseSalary) {
  const bv = baseSalary?.value;
  if (bv?.minValue && bv?.maxValue) return fmt(bv.minValue) + '\u2013' + fmt(bv.maxValue);
  return null;
}

/** Extract salary from visible body text — generic dollar range pattern */
function salaryFromBodyText(bodyText) {
  const sm =
    bodyText.match(/[Ss]alary[:\s]*\n*\s*(\$[\d,]+(?:\.\d+)?)\s*[-\u2013\u2014]\s*(\$[\d,]+(?:\.\d+)?)/) ||
    bodyText.match(/(\$[\d]{3}[,\d]+(?:\.\d+)?)\s*[-\u2013\u2014]\s*(\$[\d]{3}[,\d]+(?:\.\d+)?)/);
  if (sm) return fmt(sm[1]) + '\u2013' + fmt(sm[2]);
  return null;
}

/** Determine workType from JSON-LD jobLocationType */
function workTypeFromLocationType(jobLocationType) {
  if (jobLocationType === 'TELECOMMUTE') return 'Remote';
  return null;
}

/** Determine workType from page text when no structured data available */
function workTypeFromText(pageText) {
  const t = pageText.toLowerCase().slice(0, 3000);
  if (/fully remote|100% remote|remote-first/.test(t)) return 'Remote';
  if (/\bhybrid\b/.test(t)) return 'Hybrid';
  if (/on-site|onsite|in-office/.test(t)) return 'On-site';
  if (/\bremote\b/.test(t)) return 'Remote';
  return null;
}

/** Extract JSON-LD JobPosting from a script tag string */
function parseJobPostingJsonLd(scriptContent) {
  try {
    const data = JSON.parse(scriptContent.trim());
    const jobs = Array.isArray(data) ? data : [data];
    return jobs.find(d => d['@type'] === 'JobPosting') || null;
  } catch {
    return null;
  }
}

/**
 * Pick the best bodyText for AI extraction.
 * Priority: description container innerText → JSON-LD description → main/body
 */
function pickBodyText({ containerText, jsonLdDescription, fallbackText }) {
  if (containerText && containerText.length > 200) return containerText.slice(0, 6000);
  if (jsonLdDescription) return jsonLdDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  return (fallbackText || '').slice(0, 6000);
}

/** Clean a job title from h1 (strips " | Company" suffixes) */
function cleanTitle(rawTitle) {
  return (rawTitle || '').replace(/\s*[|\u2013\-].*$/, '').trim().slice(0, 80);
}

// ─── salaryFromDescription ────────────────────────────────────────────────────

describe('salaryFromDescription', () => {
  it('Dexcom exact: $231,100.00 - $385,100.00 → $231k–$385k', () => {
    const desc = 'Dexcom is not responsible.\n\nSalary:\n\n$231,100.00 - $385,100.00\n';
    expect(salaryFromDescription(desc)).toBe('$231k\u2013$385k');
  });

  it('en-dash (–) separator', () => {
    expect(salaryFromDescription('Salary: $120,000 \u2013 $180,000')).toBe('$120k\u2013$180k');
  });

  it('em-dash (—) separator', () => {
    expect(salaryFromDescription('Salary: $150,000 \u2014 $200,000')).toBe('$150k\u2013$200k');
  });

  it('"to" word separator', () => {
    expect(salaryFromDescription('Salary $95,000 to $140,000')).toBe('$95k\u2013$140k');
  });

  it('outputs k-notation for large numbers', () => {
    expect(salaryFromDescription('Salary:\n$200,000 - $350,000')).toBe('$200k\u2013$350k');
  });

  it('returns null for "Competitive"', () => {
    expect(salaryFromDescription('Salary: Competitive')).toBeNull();
  });

  it('returns null for "DOE"', () => {
    expect(salaryFromDescription('Compensation: DOE')).toBeNull();
  });

  it('returns null when no salary present', () => {
    expect(salaryFromDescription('Great place to work. Apply today.')).toBeNull();
  });
});

// ─── salaryFromBaseSalary ─────────────────────────────────────────────────────

describe('salaryFromBaseSalary', () => {
  it('extracts from QuantitativeValue min/max', () => {
    const bs = { value: { minValue: 120000, maxValue: 180000 } };
    expect(salaryFromBaseSalary(bs)).toBe('$120k\u2013$180k');
  });

  it('formats sub-1000 values without k suffix', () => {
    const bs = { value: { minValue: 500, maxValue: 800 } };
    expect(salaryFromBaseSalary(bs)).toBe('$500\u2013$800');
  });

  it('returns null when baseSalary is missing', () => {
    expect(salaryFromBaseSalary(null)).toBeNull();
    expect(salaryFromBaseSalary(undefined)).toBeNull();
  });

  it('returns null when value has no min/max', () => {
    expect(salaryFromBaseSalary({ value: {} })).toBeNull();
  });
});

// ─── salaryFromBodyText ───────────────────────────────────────────────────────

describe('salaryFromBodyText', () => {
  it('extracts from visible "Salary: $X - $Y" text (Dexcom rendered page)', () => {
    const text = 'Some job description.\n\nSalary:\n\n$231,100.00 - $385,100.00\n\nSimilar jobs...';
    expect(salaryFromBodyText(text)).toBe('$231k\u2013$385k');
  });

  it('extracts bare $X - $Y range without "Salary:" label', () => {
    const text = 'Compensation: $120,000 - $160,000 annually.';
    expect(salaryFromBodyText(text)).toBe('$120k\u2013$160k');
  });

  it('ignores ranges with fewer than 6 digits (avoids matching zip codes etc)', () => {
    // Pattern requires 3+ digit numbers
    const text = 'Posted 3 years ago. 100 - 200 applications.';
    expect(salaryFromBodyText(text)).toBeNull();
  });

  it('returns null when no salary range in text', () => {
    expect(salaryFromBodyText('We offer competitive compensation and benefits.')).toBeNull();
  });
});

// ─── workTypeFromLocationType ─────────────────────────────────────────────────

describe('workTypeFromLocationType', () => {
  it('TELECOMMUTE → Remote', () => {
    expect(workTypeFromLocationType('TELECOMMUTE')).toBe('Remote');
  });

  it('undefined/null → null', () => {
    expect(workTypeFromLocationType(undefined)).toBeNull();
    expect(workTypeFromLocationType(null)).toBeNull();
  });

  it('unknown value → null', () => {
    expect(workTypeFromLocationType('ONSITE')).toBeNull();
  });
});

// ─── workTypeFromText ─────────────────────────────────────────────────────────

describe('workTypeFromText', () => {
  it('"fully remote" → Remote', () => expect(workTypeFromText('This is a fully remote position.')).toBe('Remote'));
  it('"100% remote" → Remote', () => expect(workTypeFromText('100% remote work.')).toBe('Remote'));
  it('"remote-first" → Remote', () => expect(workTypeFromText('We are a remote-first company.')).toBe('Remote'));
  it('"hybrid" → Hybrid', () => expect(workTypeFromText('This is a hybrid role.')).toBe('Hybrid'));
  it('"on-site" → On-site', () => expect(workTypeFromText('Position is on-site in NYC.')).toBe('On-site'));
  it('"onsite" → On-site', () => expect(workTypeFromText('Work onsite at our HQ.')).toBe('On-site'));
  it('"in-office" → On-site', () => expect(workTypeFromText('This is an in-office position.')).toBe('On-site'));
  it('"remote" alone → Remote', () => expect(workTypeFromText('Apply for this remote role.')).toBe('Remote'));
  it('no keywords → null', () => expect(workTypeFromText('Great opportunity at our company.')).toBeNull());
});

// ─── parseJobPostingJsonLd ────────────────────────────────────────────────────

describe('parseJobPostingJsonLd', () => {
  it('parses valid JobPosting JSON-LD', () => {
    const script = JSON.stringify({
      '@context': 'http://schema.org',
      '@type': 'JobPosting',
      title: 'Sr Director Algorithm Engineering',
      hiringOrganization: { name: 'Dexcom' },
      jobLocationType: 'TELECOMMUTE',
    });
    const job = parseJobPostingJsonLd(script);
    expect(job?.title).toBe('Sr Director Algorithm Engineering');
    expect(job?.hiringOrganization?.name).toBe('Dexcom');
    expect(job?.jobLocationType).toBe('TELECOMMUTE');
  });

  it('finds JobPosting inside an array of schemas', () => {
    const script = JSON.stringify([
      { '@type': 'Organization', name: 'Dexcom' },
      { '@type': 'JobPosting', title: 'Engineer' },
    ]);
    expect(parseJobPostingJsonLd(script)?.title).toBe('Engineer');
  });

  it('returns null for non-JobPosting schema', () => {
    const script = JSON.stringify({ '@type': 'Organization', name: 'Acme' });
    expect(parseJobPostingJsonLd(script)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseJobPostingJsonLd('{ bad json }')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseJobPostingJsonLd('')).toBeNull();
  });
});

// ─── pickBodyText ─────────────────────────────────────────────────────────────

describe('pickBodyText — bodyText priority', () => {
  const long = (s) => s.repeat(50); // make strings > 200 chars

  it('prefers description container text when long enough', () => {
    const result = pickBodyText({
      containerText: long('Description text. '),
      jsonLdDescription: 'JSON-LD description.',
      fallbackText: 'Body fallback.',
    });
    expect(result).toContain('Description text');
  });

  it('falls back to JSON-LD description when container is short', () => {
    const result = pickBodyText({
      containerText: 'Short.',
      jsonLdDescription: 'Full job description from JSON-LD with salary info.',
      fallbackText: 'Body fallback.',
    });
    expect(result).toContain('JSON-LD description');
  });

  it('falls back to JSON-LD description when container is absent', () => {
    const result = pickBodyText({
      containerText: null,
      jsonLdDescription: 'JSON-LD text with Salary:\n\n$200,000 - $300,000',
      fallbackText: 'Body fallback.',
    });
    expect(result).toContain('Salary');
  });

  it('falls back to body text when both container and JSON-LD absent', () => {
    const result = pickBodyText({
      containerText: null,
      jsonLdDescription: null,
      fallbackText: 'Body fallback text from document.body.innerText.',
    });
    expect(result).toContain('Body fallback');
  });

  it('strips HTML tags from JSON-LD description', () => {
    const result = pickBodyText({
      containerText: null,
      jsonLdDescription: '<p>Job <strong>description</strong>. Salary: $100k.</p>',
      fallbackText: '',
    });
    expect(result).not.toContain('<p>');
    expect(result).not.toContain('<strong>');
    expect(result).toContain('Job');
  });

  it('truncates to 6000 chars', () => {
    const result = pickBodyText({
      containerText: 'x'.repeat(9000),
      jsonLdDescription: null,
      fallbackText: '',
    });
    expect(result.length).toBe(6000);
  });
});

// ─── cleanTitle ───────────────────────────────────────────────────────────────

describe('cleanTitle', () => {
  it('strips " | Company" suffix', () => {
    expect(cleanTitle('Senior Engineer | Google')).toBe('Senior Engineer');
  });

  it('strips " - Company" suffix', () => {
    expect(cleanTitle('Product Manager - Stripe')).toBe('Product Manager');
  });

  it('strips " – Company" suffix (en-dash)', () => {
    expect(cleanTitle('Staff Engineer \u2013 OpenAI')).toBe('Staff Engineer');
  });

  it('returns the title unchanged when no suffix', () => {
    expect(cleanTitle('Software Engineer')).toBe('Software Engineer');
  });

  it('truncates to 80 chars', () => {
    const long = 'Senior Principal Distinguished Staff Engineer Extraordinaire Level VI'.repeat(2);
    expect(cleanTitle(long).length).toBeLessThanOrEqual(80);
  });

  it('handles null/undefined without throwing', () => {
    expect(() => cleanTitle(null)).not.toThrow();
    expect(() => cleanTitle(undefined)).not.toThrow();
    expect(cleanTitle(null)).toBe('');
  });
});

// ─── Dexcom end-to-end scenario ───────────────────────────────────────────────

describe('Dexcom page end-to-end (content.js simulation)', () => {
  // Mirrors exactly what the extension does when opened on the Dexcom job page

  const dexcomJsonLd = {
    '@context': 'http://schema.org',
    '@type': 'JobPosting',
    title: 'Sr Director Algorithm Engineering',
    description: 'Meet the team...\n\nDexcom is not responsible for any fees.\n\nSalary:\n\n$231,100.00 - $385,100.00\n',
    hiringOrganization: { '@type': 'Organization', name: 'Dexcom' },
    jobLocation: { '@type': 'Place', address: { addressLocality: '', addressRegion: '' } },
    jobLocationType: 'TELECOMMUTE',
    employmentType: 'FULL_TIME',
  };

  it('step 1: parse JSON-LD → gets JobPosting', () => {
    const job = parseJobPostingJsonLd(JSON.stringify(dexcomJsonLd));
    expect(job?.title).toBe('Sr Director Algorithm Engineering');
    expect(job?.hiringOrganization?.name).toBe('Dexcom');
  });

  it('step 2: workType from TELECOMMUTE → Remote', () => {
    expect(workTypeFromLocationType(dexcomJsonLd.jobLocationType)).toBe('Remote');
  });

  it('step 3: salary from JSON-LD description text → $231k–$385k', () => {
    expect(salaryFromDescription(dexcomJsonLd.description)).toBe('$231k\u2013$385k');
  });

  it('step 4: salary also found in rendered body text', () => {
    const bodyText = '...Dexcom is not responsible for any fees.\n\nSalary:\n\n$231,100.00 - $385,100.00\nSimilar jobs...';
    expect(salaryFromBodyText(bodyText)).toBe('$231k\u2013$385k');
  });

  it('step 5: bodyText falls back to JSON-LD description (SPA shell body)', () => {
    const jsonLdDesc = dexcomJsonLd.description;
    const result = pickBodyText({
      containerText: 'Loading...',  // SPA shell — too short
      jsonLdDescription: jsonLdDesc,
      fallbackText: '',
    });
    expect(result).toContain('Salary');
    expect(result).toContain('231');
  });

  it('combined: all fields extracted correctly', () => {
    const job = parseJobPostingJsonLd(JSON.stringify(dexcomJsonLd));
    const title   = job?.title || '';
    const company = job?.hiringOrganization?.name || '';
    const workType = workTypeFromLocationType(job?.jobLocationType);
    const salary   = salaryFromDescription(job?.description || '') || salaryFromBodyText(job?.description || '');

    expect(title).toBe('Sr Director Algorithm Engineering');
    expect(company).toBe('Dexcom');
    expect(workType).toBe('Remote');
    expect(salary).toBe('$231k\u2013$385k');
  });
});
