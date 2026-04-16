// Summit Chrome Extension — content.js v2.1
// Extracts job info from page DOM. Runs in the browser so gets fully-rendered JS content.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'extractJob') return;

  const url = window.location.href;
  const hostname = window.location.hostname;
  let title = '', company = '', location = '', salary = '', workType = '';

  // ── 1. JSON-LD structured data (works on most modern career sites) ─────────
  // Always try this first — it's the most reliable structured source
  const ldEl = document.querySelector('script[type="application/ld+json"]');
  if (ldEl) {
    try {
      const data = JSON.parse(ldEl.textContent);
      const jobs = Array.isArray(data) ? data : [data];
      const job = jobs.find(d => d['@type'] === 'JobPosting') || jobs[0];
      if (job) {
        title   = title   || job.title || '';
        company = company || job.hiringOrganization?.name || '';

        // Location
        const loc = job.jobLocation?.address;
        const city = loc?.addressLocality, region = loc?.addressRegion;
        if (city || region) location = location || [city, region].filter(Boolean).join(', ');

        // Work type from jobLocationType
        if (!workType) {
          if (job.jobLocationType === 'TELECOMMUTE') workType = 'Remote';
        }

        // Salary — check baseSalary field first
        if (!salary && job.baseSalary?.value) {
          const bv = job.baseSalary.value;
          if (bv.minValue && bv.maxValue) {
            const fmt = n => n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString();
            salary = fmt(bv.minValue) + '–' + fmt(bv.maxValue);
          }
        }

        // Salary — check inside description text (Dexcom/Eightfold pattern)
        // e.g. "Salary:\n\n$231,100.00 - $385,100.00"
        if (!salary && job.description) {
          const descSalary = job.description.match(
            /[Ss]alary[\s\S]{0,20}\$([\d,]+(?:\.\d+)?)\s*[-–—to]+\s*\$([\d,]+(?:\.\d+)?)/
          );
          if (descSalary) {
            const fmt = s => { const n = parseFloat(s.replace(/,/g,'')); return n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString(); };
            salary = fmt(descSalary[1]) + '–' + fmt(descSalary[2]);
          }
        }
      }
    } catch {}
  }

  // ── 2. Site-specific DOM selectors ────────────────────────────────────────

  // LinkedIn
  if (hostname.includes('linkedin.com')) {
    title = title || (
      document.querySelector('.job-details-jobs-unified-top-card__job-title h1') ||
      document.querySelector('.job-details-jobs-unified-top-card__job-title') ||
      document.querySelector('.topcard__title') ||
      document.querySelector('h1')
    )?.textContent?.trim() || '';

    company = company || (
      document.querySelector('.job-details-jobs-unified-top-card__company-name a') ||
      document.querySelector('.job-details-jobs-unified-top-card__company-name') ||
      document.querySelector('.topcard__org-name-link')
    )?.textContent?.trim() || '';

    const locationEl = (
      document.querySelector('.job-details-jobs-unified-top-card__bullet') ||
      document.querySelector('.topcard__flavor--bullet')
    )?.textContent?.trim() || '';

    const workTypePill = (
      document.querySelector('.job-details-jobs-unified-top-card__workplace-type') ||
      document.querySelector('[class*="workplace-type"]')
    )?.textContent?.trim() || '';

    if (/remote/i.test(workTypePill))        workType = workType || 'Remote';
    else if (/hybrid/i.test(workTypePill))   workType = workType || 'Hybrid';
    else if (/on.?site/i.test(workTypePill)) workType = workType || 'On-site';

    location = location || locationEl.replace(/\s*(Remote|Hybrid|On-site|Onsite)\s*/gi, '').replace(/·/g, '').trim();

    // LinkedIn salary from insights
    if (!salary) {
      for (const el of document.querySelectorAll('[class*="insight"]')) {
        const m = el.textContent.match(/\$[\d,.]+ *[kK]?[ –-]+\$[\d,.]+ *[kK]?/);
        if (m) { salary = m[0].trim(); break; }
      }
    }
  }

  // Indeed
  else if (hostname.includes('indeed.com')) {
    title   = title   || document.querySelector('h1[class*="title"], [data-testid*="jobsearch-JobInfoHeader-title"]')?.textContent?.trim() || '';
    company = company || document.querySelector('[data-testid="inlineHeader-companyName"] a, [data-testid="inlineHeader-companyName"]')?.textContent?.trim() || '';
    location = location || document.querySelector('[data-testid="job-location"]')?.textContent?.trim() || '';
    if (!salary) {
      const salaryEl = document.querySelector('[id*="salaryInfoAndJobType"], [class*="salary"], [data-testid*="salary"]');
      if (salaryEl) salary = salaryEl.textContent.trim();
    }
  }

  // Greenhouse
  else if (hostname.includes('greenhouse.io')) {
    title   = title   || document.querySelector('h1.app-title, h1[class*="title"], h1')?.textContent?.trim() || '';
    company = company || document.querySelector('.company-name, [class*="company"]')?.textContent?.trim() || '';
    location = location || document.querySelector('.location, [class*="location"]')?.textContent?.trim() || '';
  }

  // Lever
  else if (hostname.includes('lever.co')) {
    title   = title   || document.querySelector('h2[data-qa="posting-name"], .posting-headline h2')?.textContent?.trim() || '';
    company = company || document.querySelector('.main-header-logo img')?.alt?.trim() || '';
    location = location || document.querySelector('[data-qa="posting-categories"] .sort-by-time')?.textContent?.trim() || '';
  }

  // Workday
  else if (hostname.includes('myworkdayjobs.com') || hostname.includes('myworkdaysite.com')) {
    title   = title   || document.querySelector('[data-automation-id="jobPostingHeader"]')?.textContent?.trim() || '';
    location = location || document.querySelector('[data-automation-id="locations"]')?.textContent?.trim() || '';
    company = company || document.querySelector('[data-automation-id="company-name"]')?.textContent?.trim() || '';
    if (!workType && /remote/i.test(location)) workType = 'Remote';
  }

  // SmartRecruiters
  else if (hostname.includes('smartrecruiters.com')) {
    title   = title   || document.querySelector('.job-title h1, h1[class*="title"]')?.textContent?.trim() || '';
    company = company || document.querySelector('.hiring-company-name, [class*="company"]')?.textContent?.trim() || '';
    location = location || document.querySelector('[class*="location"] span, .job-location')?.textContent?.trim() || '';
  }

  // Ashby
  else if (hostname.includes('ashbyhq.com')) {
    title   = title   || document.querySelector('h1')?.textContent?.trim() || '';
    location = location || document.querySelector('[class*="location"], [class*="Location"]')?.textContent?.trim() || '';
  }

  // Glassdoor
  else if (hostname.includes('glassdoor.com')) {
    title   = title   || document.querySelector('[data-test="job-title"], h1[class*="title"], h1')?.textContent?.trim() || '';
    company = company || document.querySelector('[data-test="employer-name"], [class*="employer-name"]')?.textContent?.trim() || '';
    location = location || document.querySelector('[data-test="location"], [class*="location"]')?.textContent?.trim() || '';
    if (!salary) {
      const se = document.querySelector('[data-test="salary-estimate"], [class*="salary"]');
      if (se) salary = se.textContent.trim();
    }
  }

  // ZipRecruiter
  else if (hostname.includes('ziprecruiter.com')) {
    title   = title   || document.querySelector('h1.job_title, h1[class*="title"]')?.textContent?.trim() || '';
    company = company || document.querySelector('.hiring_company_name, [class*="company"]')?.textContent?.trim() || '';
    location = location || document.querySelector('.location_name, [class*="location"]')?.textContent?.trim() || '';
  }

  // ── 3. Generic fallback — h1 + meta ───────────────────────────────────────
  if (!title) {
    title = (document.querySelector('h1')?.textContent || '').trim()
      .replace(/\s*[|–\-].*$/, '').trim().slice(0, 80);
  }
  if (!company) {
    company = document.querySelector('meta[property="og:site_name"]')?.content
      || document.title.split(/[|\-–]/).slice(-1)[0]?.trim()
      || '';
  }

  // ── 4. Work type from page text ───────────────────────────────────────────
  if (!workType) {
    const pageText = (document.body?.innerText || '').toLowerCase().slice(0, 3000);
    if (/fully remote|100% remote|remote-first/.test(pageText)) workType = 'Remote';
    else if (/\bhybrid\b/.test(pageText)) workType = 'Hybrid';
    else if (/on-site|onsite|in-office/.test(pageText)) workType = 'On-site';
    else if (/\bremote\b/.test(pageText)) workType = 'Remote';
  }

  // ── 5. Generic salary from visible page text ──────────────────────────────
  // This catches salary in any visible text on page (Dexcom shows it in body)
  if (!salary) {
    const bodyText = document.body?.innerText || '';
    // Look for "Salary: $X - $Y" or just "$X - $Y" patterns
    const sm = bodyText.match(/[Ss]alary[:\s]*\n*\s*(\$[\d,]+(?:\.\d+)?)\s*[-–—]\s*(\$[\d,]+(?:\.\d+)?)/)
            || bodyText.match(/(\$[\d]{3,3}[,\d]+(?:\.\d+)?)\s*[-–—]\s*(\$[\d]{3,3}[,\d]+(?:\.\d+)?)/);
    if (sm) {
      const fmt = s => { const n = parseFloat(s.replace(/[$,]/g,'')); return n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString(); };
      salary = fmt(sm[1]) + '–' + fmt(sm[2]);
    }
  }

  // ── 6. Body text for AI fallback ──────────────────────────────────────────
  // Priority: dedicated description container → JSON-LD description → main → full body
  const bodyText = (() => {
    // Try specific job description containers
    const sel = [
      '[class*="description"]:not(meta)',
      '[class*="job-description"]:not(meta)',
      '[id*="description"]',
      '.jobsearch-JobComponent-description',
      '[data-testid*="jobDescriptionText"]',
      'main article',
      'main',
      'article',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el && el.innerText?.length > 200) {
        return el.innerText.replace(/\s+/g, ' ').trim().slice(0, 6000);
      }
    }
    // Fall back to JSON-LD description (has full text including salary)
    if (ldEl) {
      try {
        const jld = JSON.parse(ldEl.textContent);
        const jobs = Array.isArray(jld) ? jld : [jld];
        const job = jobs.find(d => d['@type'] === 'JobPosting') || jobs[0];
        if (job?.description) {
          return job.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
        }
      } catch {}
    }
    // Last resort: full body text
    return document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 6000) || '';
  })();

  sendResponse({ title, company, location, salary, workType, bodyText });
  return true;
});
