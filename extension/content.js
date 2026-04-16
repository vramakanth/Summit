// Summit Chrome Extension — content.js v2.0
// Extracts job info from page DOM for popup to use as fallback

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'extractJob') return;

  const url = window.location.href;
  const hostname = window.location.hostname;
  let title = '', company = '', location = '', salary = '', workType = '';

  // ── LinkedIn ──────────────────────────────────────────────────────────────
  if (hostname.includes('linkedin.com')) {
    title = (
      document.querySelector('.job-details-jobs-unified-top-card__job-title h1') ||
      document.querySelector('.job-details-jobs-unified-top-card__job-title') ||
      document.querySelector('.topcard__title') ||
      document.querySelector('h1.t-24') ||
      document.querySelector('h1[class*="job-title"]') ||
      document.querySelector('h1')
    )?.textContent?.trim() || '';

    company = (
      document.querySelector('.job-details-jobs-unified-top-card__company-name a') ||
      document.querySelector('.job-details-jobs-unified-top-card__company-name') ||
      document.querySelector('.topcard__org-name-link') ||
      document.querySelector('a[data-tracking-control-name*="company"]') ||
      document.querySelector('[class*="company-name"]')
    )?.textContent?.trim() || '';

    const locationEl = (
      document.querySelector('.job-details-jobs-unified-top-card__bullet') ||
      document.querySelector('.topcard__flavor--bullet')
    )?.textContent?.trim() || '';

    const workTypePill = (
      document.querySelector('.job-details-jobs-unified-top-card__workplace-type') ||
      document.querySelector('[class*="workplace-type"]')
    )?.textContent?.trim() || '';

    if (/remote/i.test(workTypePill))         workType = 'Remote';
    else if (/hybrid/i.test(workTypePill))    workType = 'Hybrid';
    else if (/on.?site/i.test(workTypePill))  workType = 'On-site';

    location = locationEl.replace(/\s*(Remote|Hybrid|On-site|Onsite)\s*/gi, '').replace(/·/g, '').trim();

    // Salary from insights
    const insights = document.querySelectorAll('[class*="insight"]');
    for (const el of insights) {
      const m = el.textContent.match(/\$[\d,.]+ *[kK]?[ –-]+\$[\d,.]+ *[kK]?/);
      if (m) { salary = m[0].trim(); break; }
    }
  }

  // ── Indeed ────────────────────────────────────────────────────────────────
  else if (hostname.includes('indeed.com')) {
    title    = document.querySelector('h1.jobsearch-JobInfoHeader-title, [data-testid="jobsearch-JobInfoHeader-title"], h1[class*="title"]')?.textContent?.trim() || '';
    company  = document.querySelector('[data-testid="inlineHeader-companyName"] a, [data-testid="inlineHeader-companyName"]')?.textContent?.trim() || '';
    location = document.querySelector('[data-testid="job-location"], [class*="location"]')?.textContent?.trim() || '';
    const salaryEl = document.querySelector('[id*="salaryInfoAndJobType"], [class*="salary"]');
    if (salaryEl) salary = salaryEl.textContent.trim();
  }

  // ── Greenhouse ────────────────────────────────────────────────────────────
  else if (hostname.includes('greenhouse.io')) {
    title    = document.querySelector('h1.app-title, h1[class*="title"], h1')?.textContent?.trim() || '';
    company  = document.querySelector('.company-name, [class*="company"]')?.textContent?.trim() || '';
    location = document.querySelector('.location, [class*="location"]')?.textContent?.trim() || '';
  }

  // ── Lever ─────────────────────────────────────────────────────────────────
  else if (hostname.includes('lever.co')) {
    title    = document.querySelector('h2[data-qa="posting-name"], .posting-headline h2')?.textContent?.trim() || '';
    company  = document.querySelector('.main-header-logo img')?.alt?.trim() || '';
    location = document.querySelector('[data-qa="posting-categories"] .sort-by-time, .posting-categories .sort-by-time')?.textContent?.trim() || '';
  }

  // ── Workday ───────────────────────────────────────────────────────────────
  else if (hostname.includes('myworkdayjobs.com') || hostname.includes('myworkdaysite.com')) {
    title    = document.querySelector('[data-automation-id="jobPostingHeader"]')?.textContent?.trim() || '';
    location = document.querySelector('[data-automation-id="locations"]')?.textContent?.trim() || '';
    company  = document.querySelector('[data-automation-id="company-name"]')?.textContent?.trim() || '';
    const remoteEl = document.querySelector('[data-automation-id="Time_Type_facet_1_0"]');
    if (/remote/i.test(location || '')) workType = 'Remote';
  }

  // ── SmartRecruiters ───────────────────────────────────────────────────────
  else if (hostname.includes('smartrecruiters.com')) {
    title    = document.querySelector('.job-title h1, h1[class*="title"]')?.textContent?.trim() || '';
    company  = document.querySelector('.hiring-company-name, [class*="company"]')?.textContent?.trim() || '';
    location = document.querySelector('[class*="location"] span, .job-location')?.textContent?.trim() || '';
  }

  // ── Ashby ─────────────────────────────────────────────────────────────────
  else if (hostname.includes('ashbyhq.com')) {
    title    = document.querySelector('h1')?.textContent?.trim() || '';
    location = document.querySelector('[class*="location"], [class*="Location"]')?.textContent?.trim() || '';
  }

  // ── Workable ──────────────────────────────────────────────────────────────
  else if (hostname.includes('workable.com')) {
    title    = document.querySelector('h1[class*="title"], h1')?.textContent?.trim() || '';
    company  = document.querySelector('[class*="company"] h2, [class*="company-name"]')?.textContent?.trim() || '';
    location = document.querySelector('[class*="location"] li, [class*="location"]')?.textContent?.trim() || '';
  }

  // ── Glassdoor ─────────────────────────────────────────────────────────────
  else if (hostname.includes('glassdoor.com')) {
    title    = document.querySelector('[data-test="job-title"], h1[class*="title"], h1')?.textContent?.trim() || '';
    company  = document.querySelector('[data-test="employer-name"], [class*="employer-name"]')?.textContent?.trim() || '';
    location = document.querySelector('[data-test="location"], [class*="location"]')?.textContent?.trim() || '';
  }

  // ── ZipRecruiter ──────────────────────────────────────────────────────────
  else if (hostname.includes('ziprecruiter.com')) {
    title    = document.querySelector('h1.job_title, h1[class*="title"]')?.textContent?.trim() || '';
    company  = document.querySelector('.hiring_company_name, [class*="company"]')?.textContent?.trim() || '';
    location = document.querySelector('.location_name, [class*="location"]')?.textContent?.trim() || '';
  }

  // ── Generic fallback ──────────────────────────────────────────────────────
  if (!title) {
    // Try JSON-LD first
    const ld = document.querySelector('script[type="application/ld+json"]');
    if (ld) {
      try {
        const data = JSON.parse(ld.textContent);
        const job = Array.isArray(data) ? data.find(d => d['@type'] === 'JobPosting') : data['@type'] === 'JobPosting' ? data : null;
        if (job) {
          title   = title   || job.title || '';
          company = company || job.hiringOrganization?.name || '';
          const loc = job.jobLocation?.address;
          location = location || [loc?.addressLocality, loc?.addressRegion].filter(Boolean).join(', ');
          if (job.jobLocationType === 'TELECOMMUTE') workType = 'Remote';
        }
      } catch {}
    }
  }
  if (!title) {
    title = (document.querySelector('h1')?.textContent || '').trim();
    title = title.replace(/\s*[|–\-].*$/, '').trim().slice(0, 80);
  }
  if (!company) {
    company = document.querySelector('meta[property="og:site_name"]')?.content
      || document.title.split(/[|\-–]/).slice(-1)[0]?.trim()
      || '';
  }

  // Work type from page text if not found
  if (!workType) {
    const pageText = (document.body?.innerText || '').toLowerCase().slice(0, 3000);
    if (/fully remote|100% remote|remote-first/.test(pageText)) workType = 'Remote';
    else if (/\bhybrid\b/.test(pageText)) workType = 'Hybrid';
    else if (/on-site|onsite|in-office/.test(pageText)) workType = 'On-site';
    else if (/\bremote\b/.test(pageText)) workType = 'Remote';
  }

  // Extract job description body text for AI fallback
  const bodyText = (() => {
    // Try specific containers first
    const containers = [
      document.querySelector('[class*="description"]'),
      document.querySelector('[class*="job-description"]'),
      document.querySelector('.jobsearch-JobComponent-description'),
      document.querySelector('[data-testid="jobsearch-jobDescriptionText"]'),
      document.querySelector('main article'),
      document.querySelector('main'),
      document.querySelector('article'),
    ].filter(Boolean);
    const el = containers[0];
    if (el) return el.innerText?.replace(/\s+/g, ' ').trim().slice(0, 6000) || '';
    // Last resort: body text
    return document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 6000) || '';
  })();

  sendResponse({ title, company, location, salary, workType, bodyText });
  return true;
});
