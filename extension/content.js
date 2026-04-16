// Summit Chrome Extension — content.js v2.2
// Extracts job info from page DOM. Runs in the browser so gets fully-rendered content.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'extractJob') return;

  const url = window.location.href;
  const hostname = window.location.hostname;
  let title = '', company = '', location = '', salary = '', workType = '';

  // ── 1. JSON-LD structured data (most reliable — try first on every page) ────
  const ldEls = document.querySelectorAll('script[type="application/ld+json"]');
  for (const el of ldEls) {
    try {
      const data = JSON.parse(el.textContent);
      const jobs = Array.isArray(data) ? data : [data];
      const job = jobs.find(d => d['@type'] === 'JobPosting') || null;
      if (job) {
        title   = title   || job.title || '';
        company = company || job.hiringOrganization?.name || '';
        const loc = job.jobLocation?.address;
        if (!location && (loc?.addressLocality || loc?.addressRegion)) {
          location = [loc.addressLocality, loc.addressRegion].filter(Boolean).join(', ');
        }
        if (!workType && job.jobLocationType === 'TELECOMMUTE') workType = 'Remote';

        // Structured salary
        if (!salary && job.baseSalary?.value?.minValue && job.baseSalary?.value?.maxValue) {
          const fmt = n => n >= 1000 ? '$' + Math.round(n/1000) + 'k' : '$' + Math.round(n).toLocaleString();
          salary = fmt(job.baseSalary.value.minValue) + '–' + fmt(job.baseSalary.value.maxValue);
        }
        // Salary from description text (Dexcom/Eightfold pattern)
        if (!salary && job.description) {
          const dm = job.description.match(
            /[Ss]alary[\s\S]{0,20}\$([\d,]+(?:\.\d+)?)\s*[-–—to]+\s*\$([\d,]+(?:\.\d+)?)/
          );
          if (dm) {
            const fmt = s => { const n = parseFloat(s.replace(/,/g,'')); return n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n).toLocaleString(); };
            salary = fmt(dm[1]) + '–' + fmt(dm[2]);
          }
        }
        if (title) break; // Found a good job posting
      }
    } catch {}
  }

  // ── 2. Site-specific selectors ────────────────────────────────────────────

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
    const locationEl = document.querySelector('.job-details-jobs-unified-top-card__bullet')?.textContent?.trim() || '';
    const workTypePill = document.querySelector('.job-details-jobs-unified-top-card__workplace-type')?.textContent?.trim() || '';
    if (/remote/i.test(workTypePill)) workType = workType || 'Remote';
    else if (/hybrid/i.test(workTypePill)) workType = workType || 'Hybrid';
    else if (/on.?site/i.test(workTypePill)) workType = workType || 'On-site';
    location = location || locationEl.replace(/\s*(Remote|Hybrid|On-site|Onsite)\s*/gi, '').replace(/·/g, '').trim();
    if (!salary) {
      for (const el of document.querySelectorAll('[class*="insight"]')) {
        const m = el.textContent.match(/\$[\d,.]+ *[kK]?[ –-]+\$[\d,.]+ *[kK]?/);
        if (m) { salary = m[0].trim(); break; }
      }
    }
  }

  // Google Jobs
  else if (hostname.includes('google.com') && (url.includes('udm=8') || url.includes('vssid=jobs'))) {
    title   = title   || document.querySelector('.tNxQIb, [data-jobid] h2, .I9lvk')?.textContent?.trim() || '';
    company = company || document.querySelector('.I2Cbhb, .vNEEBe')?.textContent?.trim() || '';
    location = location || document.querySelector('.Qk80Jf, .sMzDkb')?.textContent?.trim() || '';
  }

  // Indeed
  else if (hostname.includes('indeed.com')) {
    title   = title   || document.querySelector('h1.jobsearch-JobInfoHeader-title, [data-testid="jobsearch-JobInfoHeader-title"], h1[class*="jobTitle"]')?.textContent?.trim() || '';
    company = company || document.querySelector('[data-testid="inlineHeader-companyName"] a, [data-testid="inlineHeader-companyName"], [class*="companyName"]')?.textContent?.trim() || '';
    location = location || document.querySelector('[data-testid="job-location"], [class*="companyLocation"]')?.textContent?.trim() || '';
    if (!salary) {
      const se = document.querySelector('[id*="salaryInfoAndJobType"], [class*="salary"], [data-testid="attribute_snippet_testid"]');
      if (se && /\$/.test(se.textContent)) salary = se.textContent.trim();
    }
  }

  // Greenhouse (job-boards.greenhouse.io and boards.greenhouse.io)
  else if (hostname.includes('greenhouse.io')) {
    title   = title   || document.querySelector('h1.app-title, h1[class*="title"], h1')?.textContent?.trim() || '';
    company = company || document.querySelector('.company-name, [class*="company"]')?.textContent?.trim() || '';
    location = location || document.querySelector('.location, [class*="location"]')?.textContent?.trim() || '';
    // Greenhouse shows salary in <bdi> elements
    if (!salary) {
      const bdis = document.querySelectorAll('bdi');
      const salaryBdis = Array.from(bdis).filter(b => /^\$[\d,]+/.test(b.textContent.trim()));
      if (salaryBdis.length >= 2) {
        const fmt = s => { const n = parseFloat(s.replace(/[\$,]/g,'')); return n>=1000?'$'+Math.round(n/1000)+'k':'$'+n; };
        salary = fmt(salaryBdis[0].textContent.trim()) + '–' + fmt(salaryBdis[1].textContent.trim());
      }
    }
  }

  // Lever
  else if (hostname.includes('lever.co')) {
    title   = title   || document.querySelector('h2[data-qa="posting-name"]')?.textContent?.trim() || '';
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
    location = location || document.querySelector('[class*="location"] span')?.textContent?.trim() || '';
  }

  // Ashby
  else if (hostname.includes('ashbyhq.com')) {
    title   = title   || document.querySelector('h1')?.textContent?.trim() || '';
    location = location || document.querySelector('[class*="location"], [class*="Location"]')?.textContent?.trim() || '';
  }

  // Glassdoor
  else if (hostname.includes('glassdoor.com')) {
    title   = title   || document.querySelector('[data-test="job-title"], h1')?.textContent?.trim() || '';
    company = company || document.querySelector('[data-test="employer-name"], [class*="employer-name"]')?.textContent?.trim() || '';
    location = location || document.querySelector('[data-test="location"]')?.textContent?.trim() || '';
    if (!salary) { const se = document.querySelector('[data-test="salary-estimate"]'); if(se) salary = se.textContent.trim(); }
  }

  // ZipRecruiter
  else if (hostname.includes('ziprecruiter.com')) {
    title   = title   || document.querySelector('h1.job_title, h1[class*="title"], h1')?.textContent?.trim() || '';
    company = company || document.querySelector('.hiring_company_name, [class*="hiringCompany"], [class*="company"]')?.textContent?.trim() || '';
    location = location || document.querySelector('.location_name, [class*="location"]')?.textContent?.trim() || '';
    if (!salary) {
      const se = document.querySelector('[class*="salary"], [class*="compensation"]');
      if (se && /\$/.test(se.textContent)) salary = se.textContent.trim();
    }
  }

  // SimplyHired
  else if (hostname.includes('simplyhired.com')) {
    title   = title   || document.querySelector('h1[data-testid="jobViewJobTitle"], h1[class*="title"], h1')?.textContent?.trim() || '';
    company = company || document.querySelector('[data-testid="companyName"], [class*="company"]')?.textContent?.trim() || '';
    location = location || document.querySelector('[data-testid="companyLocation"], [class*="location"]')?.textContent?.trim() || '';
    // SimplyHired shows salary for the CURRENT job at top, then similar jobs — take the first match
    if (!salary) {
      const se = document.querySelector('[class*="salary"], [data-testid*="salary"]');
      if (se && /\$/.test(se.textContent)) salary = se.textContent.trim();
    }
  }

  // Lensa
  else if (hostname.includes('lensa.com')) {
    title   = title   || document.querySelector('h1[class*="title"], h1')?.textContent?.trim() || '';
    company = company || document.querySelector('[class*="company"], [class*="employer"]')?.textContent?.trim() || '';
    location = location || document.querySelector('[class*="location"]')?.textContent?.trim() || '';
  }

  // career.io
  else if (hostname.includes('career.io')) {
    title   = title   || document.querySelector('h1[class*="title"], h1')?.textContent?.trim() || '';
    company = company || document.querySelector('[class*="company"], [class*="employer"]')?.textContent?.trim() || '';
    location = location || document.querySelector('[class*="location"]')?.textContent?.trim() || '';
  }

  // ── 3. Generic fallback ───────────────────────────────────────────────────
  if (!title) {
    title = (document.querySelector('h1')?.textContent || '').trim()
      .replace(/\s*[|–\-].*$/, '').trim().slice(0, 80);
  }
  if (!company) {
    company = document.querySelector('meta[property="og:site_name"]')?.content
      || document.title.split(/[|\-–]/).slice(-1)[0]?.trim() || '';
  }

  // ── 4. Work type from page text ───────────────────────────────────────────
  if (!workType) {
    const pageText = (document.body?.innerText || '').toLowerCase().slice(0, 3000);
    if (/fully remote|100% remote|remote-first/.test(pageText)) workType = 'Remote';
    else if (/\bhybrid\b/.test(pageText)) workType = 'Hybrid';
    else if (/on-site|onsite|in-office/.test(pageText)) workType = 'On-site';
    else if (/\bremote\b/.test(pageText)) workType = 'Remote';
  }

  // ── 5. Generic salary from visible body text (catches Greenhouse, Dexcom, etc.) ──
  if (!salary) {
    const bodyText = document.body?.innerText || '';
    const sm = bodyText.match(/[Ss]alary[:\s]*\n*\s*(\$[\d,]+(?:\.\d+)?)\s*[-–—]\s*(\$[\d,]+(?:\.\d+)?)/)
            || bodyText.match(/(\$[\d]{3}[,\d]+(?:\.\d+)?)\s*[-–—]\s*(\$[\d]{3}[,\d]+(?:\.\d+)?)/);
    if (sm) {
      const fmt = s => { const n = parseFloat(s.replace(/[$,]/g,'')); return n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n).toLocaleString(); };
      salary = fmt(sm[1]) + '–' + fmt(sm[2]);
    }
  }

  // ── 6. bodyText for AI extraction ────────────────────────────────────────
  const bodyText = (() => {
    const sel = ['[class*="description"]:not(meta)', '[class*="job-description"]:not(meta)',
      '[id*="description"]', 'main article', 'main', 'article'];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el && el.innerText?.length > 200) return el.innerText.replace(/\s+/g,' ').trim().slice(0, 6000);
    }
    // JSON-LD description as fallback
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(el.textContent);
        const jobs = Array.isArray(data) ? data : [data];
        const job = jobs.find(d => d['@type'] === 'JobPosting');
        if (job?.description) return job.description.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,6000);
      } catch {}
    }
    return document.body?.innerText?.replace(/\s+/g,' ').trim().slice(0, 6000) || '';
  })();

  sendResponse({ title, company, location, salary, workType, bodyText });
  return true;
});
