/**
 * Summit — ATS Helpers
 * Pure functions for URL detection and slug extraction.
 * Exported separately so they can be unit-tested without starting the server.
 */

function cleanJobUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hash.startsWith('#:~:')) u.hash = '';
    return u.toString();
  } catch { return raw.split('#')[0]; }
}

function detectATS(url) {
  if (/boards?\.greenhouse\.io|\.greenhouse\.io\/jobs/i.test(url))  return 'greenhouse';
  if (/jobs\.lever\.co/i.test(url))                                  return 'lever';
  if (/myworkdayjobs\.com|myworkdaysite\.com/i.test(url))           return 'workday';
  if (/bamboohr\.com\/jobs/i.test(url))                             return 'bamboohr';
  if (/ashbyhq\.com/i.test(url))                                    return 'ashby';
  if (/jobs\.smartrecruiters\.com/i.test(url))                      return 'smartrecruiters';
  if (/linkedin\.com\/jobs/i.test(url))                             return 'linkedin';
  // Eightfold AI: powers many company career sites; identified by ?domain= param or /careers/job/ path
  if (/eightfold\.ai|vscdn\.net/i.test(url))                       return 'eightfold';
  if (/[?&]domain=[^&]+$|[?&]domain=[^&]+&|\/careers\/job\/\d+/i.test(url)) return 'eightfold';
  if (/indeed\.com/i.test(url))                                     return 'indeed';
  if (/glassdoor\.com/i.test(url))                                  return 'glassdoor';
  if (/icims\.com/i.test(url))                                      return 'icims';
  if (/jobvite\.com/i.test(url))                                    return 'jobvite';
  if (/workable\.com/i.test(url))                                   return 'workable';
  if (/recruitee\.com/i.test(url))                                  return 'recruitee';
  if (/pinpointhq\.com/i.test(url))                                 return 'pinpoint';
  return 'generic';
}

/** Extract title+company from a URL slug as last-resort fallback */
function slugFallback(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const slug = segments[segments.length - 1] || segments[segments.length - 2] || '';
    if (!slug || slug.length < 5) return null;
    const cleaned = slug.replace(/^[\dA-Z]+-\d+-?/, '').replace(/^[\d]+-/, '');
    const words = cleaned.split(/[-_]/).filter(w => w.length > 1);
    const stopWords = new Set(['remote','united','states','us','usa','ca','uk','au','hybrid','onsite','in']);
    let titleWords = [], isRemote = false, isHybrid = false;
    for (const w of words) {
      const lw = w.toLowerCase();
      if (lw === 'remote') { isRemote = true; continue; }
      if (lw === 'hybrid') { isHybrid = true; continue; }
      if (!stopWords.has(lw)) titleWords.push(w.charAt(0).toUpperCase() + w.slice(1));
    }
    const title = titleWords.join(' ');
    const host = u.hostname.replace(/^(careers|jobs|apply|www)\./, '');
    const company = host.split('.')[0];
    const companyName = company.charAt(0).toUpperCase() + company.slice(1);
    return title.length > 3 ? {
      title, company: companyName,
      workType: isRemote ? 'Remote' : isHybrid ? 'Hybrid' : null,
      remote: isRemote,
    } : null;
  } catch { return null; }
}

module.exports = { cleanJobUrl, detectATS, slugFallback };
