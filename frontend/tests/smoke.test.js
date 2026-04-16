/**
 * Summit — Frontend Smoke Tests
 * Runs in Node — no browser needed.
 * Catches mismatched onclick="X()" vs function X() bugs.
 *
 * Run: cd frontend/tests && npm install && npm test
 */

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '../public/index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract all function names defined in the inline <script> block */
function getDefinedFunctions(html) {
  const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  if (!scriptMatch) return new Set();
  const script = scriptMatch[1];
  const fns = new Set();
  // function foo(  async function foo(
  for (const m of script.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)) fns.add(m[1]);
  // const foo = (  const foo = async (  const foo = function
  for (const m of script.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\(|async\s*\()/g)) fns.add(m[1]);
  return fns;
}

/** Extract all onclick="X()" calls from HTML (not inside <script>) */
function getOnclickCalls(html) {
  const htmlOnly = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const calls = [];
  for (const m of htmlOnly.matchAll(/onclick="([^"]+)"/g)) {
    // Extract function name from things like: doLogin(), showScreen('login'), etc.
    const fnMatch = m[1].match(/^(\w+)\s*\(/);
    if (fnMatch) calls.push({ call: fnMatch[1], raw: m[1] });
    // Also catch: if(event.key==='Enter')doLogin()
    const enterMatch = m[1].match(/\)(\w+)\s*\(/);
    if (enterMatch) calls.push({ call: enterMatch[1], raw: m[1] });
  }
  return calls;
}

const defined = getDefinedFunctions(html);
const onclicks = getOnclickCalls(html);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Frontend — button/function wiring', () => {
  // Deduplicate, ignore built-ins
  const builtins = new Set(['event', 'this', 'document', 'window', 'location', 'history', 'setTimeout', 'clearTimeout']);
  const unique = [...new Map(onclicks.map(o => [o.call, o])).values()]
    .filter(o => !builtins.has(o.call));

  it('has onclick handlers to check', () => {
    expect(unique.length).toBeGreaterThan(10);
  });

  // Generate one test per unique function call
  unique.forEach(({ call, raw }) => {
    it(`onclick="${raw}" → function ${call}() is defined`, () => {
      expect(defined.has(call)).toBe(true);
    });
  });
});

describe('Frontend — critical auth elements', () => {
  it('has #screen-login', () => expect(html).toContain('id="screen-login"'));
  it('has #screen-register', () => expect(html).toContain('id="screen-register"'));
  it('has #screen-landing', () => expect(html).toContain('id="screen-landing"'));
  it('has #screen-app', () => expect(html).toContain('id="screen-app"'));
  it('has #login-btn', () => expect(html).toContain('id="login-btn"'));
  it('has #register-btn', () => expect(html).toContain('id="register-btn"'));
  it('has #login-username', () => expect(html).toContain('id="login-username"'));
  it('has #login-password', () => expect(html).toContain('id="login-password"'));
  it('has #reg-username', () => expect(html).toContain('id="reg-username"'));
  it('has #reg-password', () => expect(html).toContain('id="reg-password"'));
  it('has #reg-confirm', () => expect(html).toContain('id="reg-confirm"'));
});

describe('Frontend — critical app elements', () => {
  it('has #job-list', () => expect(html).toContain('id="job-list"'));
  it('has #add-modal', () => expect(html).toContain('id="add-modal"'));
  it('has #job-url input', () => expect(html).toContain('id="job-url"'));
  it('has #user-name-display', () => expect(html).toContain('id="user-name-display"'));
  it('has logout button calling doLogout', () => expect(html).toContain('doLogout()'));
});

describe('Frontend — branding', () => {
  it('title is Summit', () => expect(html).toContain('<title>Summit'));
  it('no Pursuit branding remains', () => expect(html).not.toContain('Pursuit'));
  it('has Summit in h1 or logo', () => expect(html).toMatch(/>Summit</));
});

describe('Frontend — mountain background', () => {
  it('has mountain-bg element', () => expect(html).toContain('id="mountain-bg"'));
  it('uses real Unsplash photo', () => expect(html).toContain('unsplash.com'));
  it('applies grayscale filter for duotone', () => expect(html).toContain('grayscale(100%)'));
  it('applies multiply blend for split-tone', () => expect(html).toContain('mix-blend-mode:multiply'));
});

// ─── Regression tests for known bugs ─────────────────────────────────────────

describe('Regression — auth button wiring (known breakage pattern)', () => {
  it('login button calls doLogin not login', () => {
    expect(html).toContain('onclick="doLogin()"');
    expect(html).not.toContain('onclick="login()"');
  });

  it('register button calls doRegister not register', () => {
    expect(html).toContain('onclick="doRegister()"');
    expect(html).not.toContain('onclick="register()"');
  });

  it('save job button calls addJob not createJob', () => {
    expect(html).toContain('onclick="addJob()"');
    expect(html).not.toContain('onclick="createJob()"');
  });

  it('enter key on login password calls doLogin', () => {
    expect(html).toContain("Enter')doLogin()");
    expect(html).not.toContain("Enter')login()");
  });

  it('enter key on register confirm calls doRegister', () => {
    expect(html).toContain("Enter')doRegister()");
    expect(html).not.toContain("Enter')register()");
  });
});

describe('Regression — extract-fields field name', () => {
  it('frontend sends postingText not text to extract-fields', () => {
    // The critical fix: frontend was sending {text: ...} but server reads postingText
    expect(html).toContain("postingText: text.slice");
    expect(html).not.toContain("body: JSON.stringify({ url, text: text.slice");
  });
});

describe('Regression — landing page CTAs', () => {
  const idx = html.indexOf('id="screen-landing"');
  const end = html.indexOf('id="screen-login"', idx);
  const landing = html.slice(idx, end);

  it('no Pursuit branding anywhere', () => expect(html).not.toContain('Pursuit'));
  it('landing has Get started CTA', () => expect(landing).toMatch(/Get started/));
  it('landing has Sign in CTA', () => expect(landing).toMatch(/Sign in/));
});

describe('Regression — showScreen displayMap', () => {
  it('app screen uses flex not empty string (empty string is falsy)', () => {
    // The bug: displayMap = {app:''} then (displayMap['app'] || 'block') = 'block'
    // which makes screen-app display:block, breaking the flex layout
    expect(html).toContain("app:'flex'");
    expect(html).not.toContain("app:''");
  });
});

describe('Regression — extension download', () => {
  it('downloadExtension function is defined in JS', () => {
    expect(html).toContain('function downloadExtension()');
  });

  it('extension download button calls downloadExtension()', () => {
    expect(html).toContain('onclick="downloadExtension()"');
  });

  it('extension folder name is summit-extension (not applied-extension)', () => {
    expect(html).toContain('summit-extension');
    expect(html).not.toContain('applied-extension');
  });
});

describe('Regression — add job modal wiring', () => {
  it('add-modal exists', () => expect(html).toContain('id="add-modal"'));

  it('save job button calls addJob() not createJob()', () => {
    expect(html).toContain('onclick="addJob()"');
    expect(html).not.toContain('onclick="createJob()"');
  });

  it('parseJobUrl sends postingText field (not text) to extract-fields', () => {
    expect(html).toContain('postingText: text.slice');
    expect(html).not.toContain('body: JSON.stringify({ url, text: text.slice');
  });
});

describe('Regression — layout: app screen flex', () => {
  it("displayMap sets app to 'flex' not '' (empty string is falsy, causes block layout)", () => {
    expect(html).toContain("app:'flex'");
    expect(html).not.toContain("app:''");
  });
});

// ─── Regression: 8-item fixes ─────────────────────────────────────────────────

describe('Regression — analytics no close button', () => {
  it('closeAnalytics() not called from renderAnalytics header (section view has no close)', () => {
    // The × button was removed — analytics is now embedded in #section-view
    const analyticsIdx = html.indexOf('Analytics Dashboard');
    const nextSection = html.indexOf('function closeAnalytics', analyticsIdx);
    // The header section (within 500 chars of the title) should not have closeAnalytics onclick
    const headerSlice = html.slice(analyticsIdx, analyticsIdx + 500);
    expect(headerSlice).not.toContain('onclick="closeAnalytics()"');
  });
});

describe('Regression — Files tab removed', () => {
  it('Files tab not in detail tabs row', () => {
    // The Files tab div should be gone
    expect(html).not.toContain("onclick=\"switchTab('files')\"");
  });

  it('Files not in tab render chain', () => {
    // Should not fall back to renderFilesTab in the chain
    expect(html).not.toContain("activeDetailTab==='files' ? renderFilesTab");
  });
});

describe('Regression — sidebar button labels', () => {
  it('sidebar button says Library not Documents', () => {
    // The sidebar action button for the library section should say Library
    const btnIdx = html.indexOf("data-section=\"library\"");
    const btnSlice = html.slice(btnIdx, btnIdx + 400); // SVG is long, need wider window
    expect(btnSlice).toContain('Library');
    expect(btnSlice).not.toContain('>Documents<');
  });
});

describe('Regression — interview questions API', () => {
  it('request body includes count and existingQuestions fields', () => {
    expect(html).toContain('existingQuestions: existing.map(q => q.question)');
    expect(html).toContain('count: isAdding ? 10 : 15');
  });

  it('no self-referential postingText bug', () => {
    // Was: postingText: j.postingText || j.postingText (bug — references itself)
    expect(html).not.toContain('postingText: j.postingText || j.postingText');
    expect(html).toContain("postingText: j.postingText || ''");
  });
});

describe('Regression — job posting HTML rendering', () => {
  it('buildPostingHtml prefers clean text over raw HTML', () => {
    // The new code checks for substantial postingText first
    expect(html).toContain('const cleanText = j.postingText && j.postingText.length > 200');
  });

  it('strips HTML tags from postingText before display', () => {
    expect(html).toContain("replace(/<[^>]+>/g, ' ')");
  });
});

describe('Regression — encryption always on', () => {
  it('enc-upgrade-area removed from settings UI', () => {
    // The enable-encryption upgrade path should be gone
    expect(html).not.toContain('<div id="enc-upgrade-area"></div>');
  });
});

describe('Regression — workforce demographics', () => {
  it('renderAgeDistribution function defined', () => {
    expect(html).toContain('function renderAgeDistribution(wf)');
  });

  it('age brackets rendered (under30, 30to40, 40to50, over50)', () => {
    expect(html).toContain("key: 'under30'");
    expect(html).toContain("key: '30to40'");
    expect(html).toContain("key: 'over50'");
  });

  it('employee growth bar chart rendered from headcountHistory', () => {
    expect(html).toContain('EMPLOYEE GROWTH');
    expect(html).toContain('headcountHistory');
  });
});

// ─── Regression: 6-item fixes ─────────────────────────────────────────────────

describe('Regression — Settings as sidebar section', () => {
  it('settings sidebar-action-btn exists with data-section="settings"', () => {
    expect(html).toContain('data-section="settings"');
    expect(html).toContain('onclick="openSettings()"');
  });

  it('stale jobs button removed from sidebar', () => {
    // data-section="stale" should not be in sidebar-action-btns anymore
    const sidebarIdx = html.indexOf('class="sidebar-action-btns"');
    const sidebarEnd = html.indexOf('<!-- User bar -->', sidebarIdx);
    const sidebar = html.slice(sidebarIdx, sidebarEnd);
    expect(sidebar).not.toContain('data-section="stale"');
    expect(sidebar).not.toContain('showStaleJobs()');
  });

  it('settings panel has slide-in transition', () => {
    expect(html).toContain('settings-panel-inner');
    expect(html).toContain('translateX(100%)');
    expect(html).toContain('transition:transform 0.25s');
  });
});

describe('Regression — Stale as separate boolean field', () => {
  it('stale is NOT in STATUSES (it is a separate field, not a status)', () => {
    // stale is now j.stale boolean, not in the status dropdown
    expect(html).not.toContain(",'stale']");
    // STATUSES should end with expired
    expect(html).toContain("'expired']");
  });

  it('stale filter tab exists (filters on j.stale===true)', () => {
    expect(html).toContain("setFilter('stale')");
  });

  it('filter logic uses j.stale field not j.status', () => {
    expect(html).toContain("currentFilter === 'stale') { if (!j.stale)");
  });

  it('stale badge shown in job list when j.stale===true', () => {
    expect(html).toContain("j.stale ? '<span");
    expect(html).toContain("stale</span>'");
  });

  it('toggleStale function defined', () => {
    expect(html).toContain('function toggleStale(jobId)');
  });

  it('toggleStale sets staledByUser flag', () => {
    expect(html).toContain('j.staledByUser = true');
    expect(html).toContain('j.staledByUser = false');
  });

  it('stale toggle button rendered in detail header', () => {
    expect(html).toContain("toggleStale('${j.id}')");
  });

  it('auto-check checks staledByUser before overwriting', () => {
    expect(html).toContain('!j.staledByUser');
  });

  it('auto-check sets j.stale not j.status', () => {
    expect(html).toContain('j.stale = true');
    // Should NOT set stale as status
    expect(html).not.toContain("j.status = 'stale'");
  });

  it('stale not a color in statusColor function', () => {
    // statusColor only covers actual statuses
    const scIdx = html.indexOf('function statusColor');
    const scSlice = html.slice(scIdx, scIdx + 250);
    expect(scSlice).not.toContain("stale:'#ea580c'");
  });

  it('auto-check toggle exists in settings', () => {
    expect(html).toContain('auto-check-toggle');
    expect(html).toContain('JOB POSTING AUTO-CHECK');
  });

  it('autoCheckStaleJobs function defined', () => {
    expect(html).toContain('function autoCheckStaleJobs()');
  });

  it('setAutoCheck function defined', () => {
    expect(html).toContain('function setAutoCheck(enabled)');
  });
});

describe('Regression — Landing page icons', () => {
  it('feature card icons use currentColor not hardcoded orange', () => {
    const landingIdx = html.indexOf('id="screen-landing"');
    const loginIdx = html.indexOf('id="screen-login"');
    const landing = html.slice(landingIdx, loginIdx);
    // Should not have hardcoded orange stroke in feature SVGs
    expect(landing).not.toContain('stroke="#e8a838"');
    // Should have currentColor
    expect(landing).toContain('stroke="currentColor"');
  });
});

describe('Regression — Mobile transitions', () => {
  it('settings panel uses CSS transform transition (consistent with other sections)', () => {
    expect(html).toContain("transition:transform 0.25s cubic-bezier(0.4,0,0.2,1)");
  });
});

// ─── Regression: 9-item fixes ─────────────────────────────────────────────────

describe('Regression — Settings UX cleanup (items 1-4)', () => {
  it('gear icon removed from user-bar', () => {
    const userBarIdx = html.indexOf('class="user-bar"');
    const userBarEnd = html.indexOf('<!-- MAIN CONTENT -->', userBarIdx);
    const userBar = html.slice(userBarIdx, userBarEnd);
    // gear icon had a specific SVG path for the cog
    expect(userBar).not.toContain('onclick="openSettings()" title="Settings"');
  });

  it('settings sidebar button exists (replaced gear)', () => {
    expect(html).toContain('data-section="settings"');
    expect(html).toContain('onclick="openSettings()"');
  });

  it('settings uses section-view (openSection called)', () => {
    const openSettingsIdx = html.indexOf('function openSettings(section)');
    const openSettingsBody = html.slice(openSettingsIdx, openSettingsIdx + 500);
    expect(openSettingsBody).toContain('openSection(\'settings\')');
  });

  it('username/count removed from settings header', () => {
    const settingsPanel = html.indexOf('id="settings-panel-inner"');
    const settingsNav = html.slice(settingsPanel, settingsPanel + 2000);
    // The user-avatar and s-username should not appear at the very top of the nav
    expect(settingsPanel).toBeGreaterThan(0);
    // The old user header block should be removed
    expect(settingsNav).not.toContain('id="s-username"');
  });

  it('settings close button at bottom removed', () => {
    // The "Close" button inside settings left nav should be gone
    const inner = html.indexOf('id="settings-panel-inner"');
    const innerContent = html.slice(inner, inner + 5000);
    expect(innerContent).not.toContain('>Close</button>');
  });
});

describe('Regression — Settings structure (items 7, 6)', () => {
  it('settings nav order: Account first, Danger Zone last', () => {
    const navStart = html.indexOf('id="snav-account"');
    const navDanger = html.indexOf('id="snav-danger"', navStart);
    expect(navStart).toBeLessThan(navDanger);
  });

  it('Browser Extensions comes before Help', () => {
    const extIdx = html.indexOf('id="snav-extension"');
    const helpIdx = html.indexOf('id="snav-help"');
    expect(extIdx).toBeLessThan(helpIdx);
  });

  it('Tailoring comes before Financial Data', () => {
    const tailorIdx = html.indexOf('id="snav-tailoring"');
    const finIdx = html.indexOf('id="snav-financial"');
    expect(tailorIdx).toBeLessThan(finIdx);
  });

  it('HOW IT WORKS removed from Tailoring pane', () => {
    const tailorPane = html.slice(html.indexOf('id="spane-tailoring"'), html.indexOf('id="spane-financial"'));
    expect(tailorPane).not.toContain('HOW IT WORKS');
  });

  it('How it works added to Help & Support', () => {
    const helpPane = html.slice(html.indexOf('id="spane-help"'), html.indexOf('id="spane-feedback"'));
    expect(helpPane).toContain('AI Resume Tailoring');
  });
});

describe('Regression — Referrals removed (item 5)', () => {
  it('referrals sidebar button removed', () => {
    const sidebarIdx = html.indexOf('class="sidebar-action-btns"');
    const sidebarEnd = html.indexOf('<!-- User bar -->', sidebarIdx);
    const sidebar = html.slice(sidebarIdx, sidebarEnd);
    expect(sidebar).not.toContain('showReferralPipeline()');
  });

  it('mobile settings nav has no referral button', () => {
    expect(html).not.toContain('id="mobile-referral-btn"');
  });
});

describe('Regression — Detail tabs reordered (item 8)', () => {
  it('Insights tab comes first', () => {
    const tabsStart = html.indexOf('class="detail-tabs"');
    const insightsTab = html.indexOf("switchTab('insights')", tabsStart);
    const notesTab = html.indexOf("switchTab('notes')", tabsStart);
    expect(insightsTab).toBeLessThan(notesTab);
  });

  it('Job Posting comes after Notes', () => {
    const tabsStart = html.indexOf('class="detail-tabs"');
    const notesTab = html.indexOf("switchTab('notes')", tabsStart);
    const postingTab = html.indexOf("switchTab('posting')", tabsStart);
    expect(notesTab).toBeLessThan(postingTab);
  });

  it('Interview Prep comes before Contacts', () => {
    const tabsStart = html.indexOf('class="detail-tabs"');
    const interviewTab = html.indexOf("switchTab('interview')", tabsStart);
    const contactsTab = html.indexOf("switchTab('contacts')", tabsStart);
    expect(interviewTab).toBeLessThan(contactsTab);
  });
});

describe('Regression — Feedback monochrome (item 3)', () => {
  it('feedback cards use SVG icons not emoji', () => {
    const feedback = html.slice(html.indexOf('id="spane-feedback"'), html.indexOf('id="spane-danger"'));
    expect(feedback).not.toContain('font-size:28px'); // emoji were in 28px divs
    expect(feedback).toContain('<svg'); // SVG icons instead
  });

  it('feedback cards use var(--bg3) not colored backgrounds', () => {
    const feedback = html.slice(html.indexOf('id="spane-feedback"'), html.indexOf('id="spane-danger"'));
    expect(feedback).not.toContain('rgba(239,68,68,0.06)');
    expect(feedback).not.toContain('rgba(59,130,246,0.06)');
    expect(feedback).toContain('var(--bg3)');
  });
});

// ─── Job posting and salary fixes ─────────────────────────────────────────────

describe('Regression — buildPostingHtml markup fix (item 9)', () => {
  it('toPlainText helper defined inside buildPostingHtml', () => {
    expect(html).toContain('function toPlainText(raw)');
  });

  it('strips HTML tags including li, br, p in toPlainText', () => {
    expect(html).toContain("replace(/<br\\s*\\/?>/gi, '\\n')");
    expect(html).toContain("replace(/<li[^>]*>/gi, '• ')");
    expect(html).toContain("replace(/<[^>]+>/g, '')");
  });

  it('HTML entities decoded in toPlainText', () => {
    expect(html).toContain("replace(/&amp;/gi, '&')");
    expect(html).toContain("replace(/&lt;/gi, '<')");
    expect(html).toContain("replace(/&nbsp;/gi, ' ')");
  });

  it('buildPostingHtml falls back from postingHtml to postingText if HTML parse gives nothing', () => {
    expect(html).toContain('rawSource.trim().length < 100 && j.postingText');
  });
});

describe('Regression — salary not-found marker (item 8)', () => {
  it('server sets salary to not found in generic handler', () => {
    const srv = require('fs').readFileSync('/home/claude/applied-tracker/backend/server.js', 'utf8');
    expect(srv).toContain("fields.salary = 'not found'");
  });

  it('multiple handlers set not-found salary', () => {
    const srv = require('fs').readFileSync('/home/claude/applied-tracker/backend/server.js', 'utf8');
    const count = (srv.match(/salary = 'not found'/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
