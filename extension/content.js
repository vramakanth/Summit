// Applied Chrome Extension - content.js
// Detects job info from common job posting sites

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'detectJob') return;

  const url = window.location.href;
  const hostname = window.location.hostname;
  let title = '', company = '', location = '', salary = '', workType = '';

  // ── LinkedIn ──
  if (hostname.includes('linkedin.com')) {
    // Job title — try multiple selector patterns across LinkedIn's changing UI
    title = (
      document.querySelector('.job-details-jobs-unified-top-card__job-title h1') ||
      document.querySelector('.job-details-jobs-unified-top-card__job-title') ||
      document.querySelector('.topcard__title') ||
      document.querySelector('h1.t-24') ||
      document.querySelector('h1[class*="title"]')
    )?.textContent?.trim() || '';

    // Company name
    company = (
      document.querySelector('.job-details-jobs-unified-top-card__company-name a') ||
      document.querySelector('.job-details-jobs-unified-top-card__company-name') ||
      document.querySelector('.topcard__org-name-link') ||
      document.querySelector('a[data-tracking-control-name*="company"]')
    )?.textContent?.trim() || '';

    // Location — extract and split workType from it
    const locationEl = (
      document.querySelector('.job-details-jobs-unified-top-card__bullet') ||
      document.querySelector('.topcard__flavor--bullet') ||
      document.querySelector('[class*="location"]')
    )?.textContent?.trim() || '';

    // Work type pill (Remote / Hybrid / On-site)
    const workTypePill = (
      document.querySelector('.job-details-jobs-unified-top-card__workplace-type') ||
      document.querySelector('[class*="workplace-type"]') ||
      document.querySelector('.job-details-jobs-unified-top-card__job-insight span')
    )?.textContent?.trim() || '';

    if (workTypePill.toLowerCase().includes('remote')) workType = 'Remote';
    else if (workTypePill.toLowerCase().includes('hybrid')) workType = 'Hybrid';
    else if (workTypePill.toLowerCase().includes('on-site') || workTypePill.toLowerCase().includes('onsite')) workType = 'On-site';

    // Clean location — remove workType from it if present
    if (locationEl) {
      location = locationEl
        .replace(/\s*(Remote|Hybrid|On-site|Onsite)\s*/gi, '')
        .replace(/·/g, '').trim();
    }

    // Salary — LinkedIn sometimes shows it in the insights section
    const insights = Array.from(document.querySelectorAll('.job-details-jobs-unified-top-card__job-insight, [class*="insight"]'));
    for (const el of insights) {
      const txt = el.textContent || '';
      const salaryMatch = txt.match(/\$[\d,.]+[kK]?\s*[-–to]+\s*\$[\d,.]+[kK]?/);
      if (salaryMatch) { salary = salaryMatch[0].trim(); break; }
    }
  }

  // ── Indeed ──
  else if (hostname.includes('indeed.com')) {
    title = document.querySelector('h1.jobsearch-JobInfoHeader-title, [data-testid="jobsearch-JobInfoHeader-title"]')?.textContent?.trim() || '';
    company = document.querySelector('[data-testid="inlineHeader-companyName"], .icl-u-lg-mr--sm')?.textContent?.trim() || '';
    location = document.querySelector('[data-testid="job-location"]')?.textContent?.trim() || '';
  }

  // ── Greenhouse ──
  else if (hostname.includes('greenhouse.io') || url.includes('greenhouse.io')) {
    title = document.querySelector('h1.app-title, h1[class*="title"]')?.textContent?.trim() || '';
    company = document.querySelector('.company-name, h2[class*="company"]')?.textContent?.trim() || '';
    location = document.querySelector('.location')?.textContent?.trim() || '';
  }

  // ── Lever ──
  else if (hostname.includes('lever.co')) {
    title = document.querySelector('h2[data-qa="posting-name"]')?.textContent?.trim() || '';
    company = document.querySelector('.main-header-logo img')?.alt?.trim() || document.title.split(' - ').slice(-1)[0]?.trim() || '';
    location = document.querySelector('[data-qa="posting-categories"] .sort-by-time')?.textContent?.trim() || '';
  }

  // ── Workday ──
  else if (hostname.includes('myworkdayjobs.com') || hostname.includes('wd1.myworkday.com')) {
    title = document.querySelector('[data-automation-id="jobPostingHeader"]')?.textContent?.trim() || '';
    location = document.querySelector('[data-automation-id="locations"]')?.textContent?.trim() || '';
  }

  // ── Generic fallback ──
  if (!title) {
    // Try h1 first
    title = document.querySelector('h1')?.textContent?.trim() || '';
    // Remove common suffixes
    title = title.replace(/\s*[|–-].*$/, '').trim();
  }
  if (!company) {
    // Try common patterns
    const ogSite = document.querySelector('meta[property="og:site_name"]')?.content;
    company = ogSite || document.title.split(' - ').slice(-1)[0]?.split(' | ').slice(-1)[0]?.trim() || '';
  }

  // Remote/hybrid detection from page text
  if (!workType) {
    const pageText = document.body?.innerText?.toLowerCase() || '';
    const first2000 = pageText.slice(0, 2000);
    if (first2000.includes('fully remote') || first2000.includes('100% remote')) workType = 'Remote';
    else if (first2000.includes('hybrid')) workType = 'Hybrid';
    else if (first2000.includes('on-site') || first2000.includes('onsite')) workType = 'On-site';
  }

  sendResponse({ title, company, location, salary, workType });
  return true;
});