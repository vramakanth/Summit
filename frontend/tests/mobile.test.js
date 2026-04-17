/**
 * mobile.test.js — Mobile layout regression tests
 * Run: node mobile.test.js
 */
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

let pass = 0, fail = 0;
const t   = (name, fn) => { try { fn(); console.log(' ✓', name); pass++; } catch(e) { console.log(' ✗', name, '—', e.message.slice(0, 90)); fail++; } };
const has = (s) => { if (!src.includes(s)) throw new Error('missing: ' + s.slice(0, 60)); };
const not = (s) => { if (src.includes(s)) throw new Error('found:   ' + s.slice(0, 60)); };

// ── Duplicate avatar ─────────────────────────────────────────────────────────
console.log('\n── Duplicate user avatar');

t('mobile-avatar-btn has exactly one id attribute', () => {
  // Regression: button had id="..." id="..." (declared twice on same element)
  const btnStart = src.indexOf('id="mobile-avatar-btn"');
  if (btnStart < 0) throw new Error('mobile-avatar-btn not found');
  const btnTag = src.slice(btnStart - 10, btnStart + 200);
  // Count id= occurrences within the opening tag
  const tagClose = btnTag.indexOf('>');
  const tag = btnTag.slice(0, tagClose);
  const idCount = (tag.match(/\bid=/g) || []).length;
  if (idCount > 1) throw new Error(`button has ${idCount} id attributes — duplicate`);
});

t('user-avatar hidden on mobile (prevents duplicate circles)', () => {
  // On mobile, #user-avatar must be hidden so only mobile-avatar-btn shows
  const mobileSection = src.slice(
    src.indexOf('@media (max-width'),
    src.indexOf('@media (max-width') + 4000
  );
  if (!mobileSection.includes('#user-avatar') || !mobileSection.includes('display: none')) {
    throw new Error('#user-avatar not hidden in mobile CSS');
  }
});

t('mobile-avatar-btn shown on mobile', () => {
  const mobileSection = src.slice(
    src.indexOf('@media (max-width'),
    src.indexOf('@media (max-width') + 4000
  );
  if (!mobileSection.includes('#mobile-avatar-btn') || !mobileSection.includes('display: flex')) {
    throw new Error('mobile-avatar-btn not shown in mobile CSS');
  }
});

t('only one element with id=mobile-avatar-btn', () => {
  const matches = [...src.matchAll(/id="mobile-avatar-btn"/g)];
  // Should appear in the HTML element exactly once, plus CSS references
  const htmlMatches = matches.filter(m => {
    const ctx = src.slice(m.index - 5, m.index + 30);
    return !ctx.includes('#mobile-avatar-btn') && !ctx.includes("'mobile-avatar-btn'");
  });
  if (htmlMatches.length > 1) throw new Error(`Found ${htmlMatches.length} HTML elements with id=mobile-avatar-btn`);
});

// ── Bottom bar z-index stacking ──────────────────────────────────────────────
console.log('\n── Bottom bar z-index stacking');

// Parse all z-index values for comparison
function getZIndex(cssText) {
  const m = cssText.match(/z-index:\s*(\d+)/);
  return m ? parseInt(m[1]) : null;
}

const bottomBarZ = (() => {
  const m = src.match(/\.mobile-bottom-bar\s*\{[^}]+z-index:\s*(\d+)/);
  return m ? parseInt(m[1]) : null;
})();

t('mobile bottom bar has z-index defined', () => {
  if (bottomBarZ === null) throw new Error('no z-index on .mobile-bottom-bar');
});

t('bottom bar z-index is NOT 1100 (old bug — covered everything)', () => {
  if (bottomBarZ === 1100) throw new Error('z-index still 1100 — will cover all panels');
});

t('bottom bar z-index is below overlay panels (500+)', () => {
  if (bottomBarZ >= 500) throw new Error(`z-index ${bottomBarZ} ≥ 500 — will cover overlays`);
});

t('bottom bar z-index is above base app content (200)', () => {
  // Bar must be visible above .sidebar/.main (z-index 200 on mobile)
  if (bottomBarZ <= 200) throw new Error(`z-index ${bottomBarZ} ≤ 200 — hidden behind content`);
});

t('analytics-overlay z-index is above bottom bar', () => {
  const m = src.match(/analytics-overlay[^}]+z-index:\s*(\d+)/);
  const z = m ? parseInt(m[1]) : null;
  if (!z) throw new Error('analytics-overlay z-index not found');
  if (z <= bottomBarZ) throw new Error(`analytics z:${z} ≤ bar z:${bottomBarZ} — bar will cover it`);
});

t('watchlist-overlay z-index is above bottom bar', () => {
  // watchlist-overlay uses inline style z-index
  const m = src.match(/id="watchlist-overlay"[^>]+z-index:\s*(\d+)/);
  const z = m ? parseInt(m[1]) : null;
  if (!z) throw new Error('watchlist-overlay z-index not found');
  if (z <= bottomBarZ) throw new Error(`watchlist z:${z} ≤ bar z:${bottomBarZ}`);
});

t('settings-overlay z-index is above bottom bar', () => {
  const m = src.match(/\.settings-overlay\s*\{[^}]+z-index:\s*(\d+)/);
  const z = m ? parseInt(m[1]) : null;
  if (!z) throw new Error('settings-overlay z-index not found');
  if (z <= bottomBarZ) throw new Error(`settings z:${z} ≤ bar z:${bottomBarZ}`);
});

t('modal-overlay z-index is above bottom bar', () => {
  const m = src.match(/\.modal-overlay[^}]+z-index:\s*(\d+)/);
  const z = m ? parseInt(m[1]) : null;
  if (!z) throw new Error('modal-overlay z-index not found');
  if (z <= bottomBarZ) throw new Error(`modal z:${z} ≤ bar z:${bottomBarZ}`);
});

t('doc-editor z-index is above bottom bar', () => {
  const m = src.match(/\.doc-editor-panel[^}]+z-index:\s*(\d+)/);
  const z = m ? parseInt(m[1]) : null;
  if (!z) throw new Error('doc-editor-panel z-index not found');
  if (z <= bottomBarZ) throw new Error(`doc-editor z:${z} ≤ bar z:${bottomBarZ}`);
});

// ── Content padding — content must not hide behind the bar ───────────────────
console.log('\n── Content clear of bottom bar');

t('job-list has padding-bottom on mobile', () => {
  const mobileSection = src.slice(
    src.indexOf('body.in-app .mobile-bottom-bar'),
    src.indexOf('body.in-app .mobile-bottom-bar') + 500
  );
  if (!mobileSection.includes('#job-list') || !mobileSection.includes('padding-bottom')) {
    throw new Error('#job-list missing padding-bottom on mobile');
  }
});

t('detail-view has padding-bottom on mobile', () => {
  const mobileSection = src.slice(
    src.indexOf('body.in-app .mobile-bottom-bar'),
    src.indexOf('body.in-app .mobile-bottom-bar') + 500
  );
  if (!mobileSection.includes('#detail-view') || !mobileSection.includes('padding-bottom')) {
    throw new Error('#detail-view missing padding-bottom on mobile');
  }
});

t('section-view has padding-bottom on mobile', () => {
  const mobileSection = src.slice(
    src.indexOf('body.in-app .mobile-bottom-bar'),
    src.indexOf('body.in-app .mobile-bottom-bar') + 500
  );
  if (!mobileSection.includes('#section-view') || !mobileSection.includes('padding-bottom')) {
    throw new Error('#section-view missing padding-bottom on mobile');
  }
});

// ── Bottom bar structure ─────────────────────────────────────────────────────
console.log('\n── Bottom bar structure');

t('bottom bar has exactly 5 buttons', () => {
  const barStart = src.indexOf('id="mobile-bottom-bar"');
  const barEnd   = src.indexOf('</div>', barStart);
  const bar = src.slice(barStart, barEnd);
  const buttons = (bar.match(/class="mobile-bottom-btn"/g) || []).length;
  if (buttons !== 5) throw new Error(`expected 5 buttons, found ${buttons}`);
});

t('bottom bar buttons: Add, Jobs, Library, Stats, Settings', () => {
  const barStart = src.indexOf('id="mobile-bottom-bar"');
  const barEnd   = src.indexOf('</div>', barStart + 100) + 6;
  const bar = src.slice(barStart, barEnd + 200); // a bit more to catch all buttons
  ['Add', 'Jobs', 'Library', 'Stats', 'Settings'].forEach(label => {
    if (!bar.includes(label)) throw new Error(`Missing bottom bar button: ${label}`);
  });
});

t('bottom bar is position:fixed at bottom:0', () => {
  const m = src.match(/\.mobile-bottom-bar\s*\{([^}]+)\}/);
  if (!m) throw new Error('.mobile-bottom-bar CSS not found');
  const css = m[1];
  if (!css.includes('position: fixed') && !css.includes('position:fixed')) throw new Error('not position:fixed');
  if (!css.includes('bottom: 0') && !css.includes('bottom:0')) throw new Error('not bottom:0');
});

t('bottom bar hidden on desktop (display:none)', () => {
  const m = src.match(/\.mobile-bottom-bar\s*\{([^}]+)\}/);
  if (!m) throw new Error('.mobile-bottom-bar CSS not found');
  if (!m[1].includes('display: none') && !m[1].includes('display:none')) {
    throw new Error('bottom bar not hidden by default — will show on desktop');
  }
});

t('bottom bar shown only in mobile media query', () => {
  const mobileSection = src.slice(
    src.indexOf('@media (max-width'),
    src.indexOf('@media (max-width') + 4000
  );
  if (!mobileSection.includes('mobile-bottom-bar')) {
    throw new Error('mobile-bottom-bar not enabled in media query');
  }
});

// ── Top-right user cluster (mobile avatar + logout moved out of user-bar) ────
console.log('\n── Mobile user cluster at top-right');

t('#mobile-user-cluster exists and is inline-hidden on desktop', () => {
  has('id="mobile-user-cluster"');
  const m = src.match(/id="mobile-user-cluster"[^>]*style="([^"]+)"/);
  if (!m) throw new Error('no inline style on cluster');
  if (!/display:\s*none/.test(m[1])) throw new Error('cluster should be hidden by default (desktop)');
  if (!/margin-left:\s*auto/.test(m[1])) throw new Error('cluster should push right via margin-left:auto');
});

t('Mobile cluster contains BOTH logout button and avatar button', () => {
  const idx = src.indexOf('id="mobile-user-cluster"');
  // The cluster is short; peek 2000 chars forward
  const cluster = src.slice(idx, idx + 2000);
  // End of cluster is the first </div> at the depth we care about — but
  // easier to just check whether the logout + avatar markup appear before
  // any sibling element that would mean we've exited the cluster.
  if (!/onclick="doLogout\(\)"[\s\S]{0,800}id="mobile-avatar-btn"/.test(cluster)) {
    throw new Error('cluster markup order broken — expected logout button then avatar button');
  }
  if (!/onclick="openSettings\(\)"/.test(cluster)) throw new Error('avatar button not wired to openSettings');
});

t('Mobile CSS shows the cluster AND hides the entire .user-bar (frees the row)', () => {
  const mobileBlock = src.slice(
    src.indexOf('@media (max-width: 680px)'),
    src.indexOf('@media (max-width: 680px)') + 3000
  );
  if (!/#mobile-user-cluster\s*\{[^}]*display:\s*flex\s*!important/.test(mobileBlock)) {
    throw new Error('cluster not shown in mobile media query');
  }
  if (!/\.user-bar\s*\{[^}]*display:\s*none\s*!important/.test(mobileBlock)) {
    throw new Error('.user-bar not hidden on mobile — row not freed');
  }
});

t('No duplicate #mobile-avatar-btn in DOM', () => {
  const matches = src.match(/id="mobile-avatar-btn"/g) || [];
  if (matches.length !== 1) throw new Error(`expected exactly 1 mobile-avatar-btn, found ${matches.length}`);
});

t('No duplicate #mobile-avatar span in DOM', () => {
  const matches = src.match(/id="mobile-avatar"/g) || [];
  if (matches.length !== 1) throw new Error(`expected exactly 1 mobile-avatar span, found ${matches.length}`);
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} passed${fail ? ' ← FAILURES' : '  ✓'}`);
if (fail) process.exit(1);
