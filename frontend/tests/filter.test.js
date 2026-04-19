/**
 * filter.test.js — Unit tests for job list filtering and watchlist toggle
 *
 * These tests extract and run the actual filtering logic from index.html
 * in a simulated DOM environment (no browser needed).
 *
 * Run: node filter.test.js
 */

const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '../public/index.html'), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try   { fn(); console.log(' ✓', name); pass++; }
  catch (e) { console.log(' ✗', name, '—', e.message.slice(0, 90)); fail++; }
};
const eq  = (a, b) => { if (a !== b) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const eqArr = (a, b) => { eq(JSON.stringify(a.sort()), JSON.stringify(b.sort())); };

// ── Minimal DOM shim ─────────────────────────────────────────────────────────
// getFilteredJobs calls document.getElementById('search-input') and
// references the globals: jobs, currentFilter
global.document = {
  getElementById: (id) => id === 'search-input' ? { value: '' } : null,
  querySelectorAll: () => ({ forEach: () => {} }),
};

// Extract and eval getFilteredJobs + setFilter + toggleWatchlist + toggleStale
// We eval each function in a scope that reads from our global state.
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in source`);
  // Find matching closing brace
  let depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

// Globals the functions depend on
global.jobs = {};
global.currentFilter = 'all';
global.scheduleSave  = () => {};
global.renderJobList = () => {};
global.renderDetail  = () => {};

// Eval the functions into global scope
eval(extractFn('getFilteredJobs'));
eval(extractFn('toggleWatchlist'));
eval(extractFn('toggleStale'));
eval(extractFn('setFilter'));

// Helper — build a minimal job object
let _id = 0;
const job = (overrides = {}) => ({
  id:        String(++_id),
  title:     'Engineer',
  company:   'Acme',
  status:    'applied',
  stale:     false,
  watchlist: false,
  createdAt: Date.now() - _id * 1000,
  notes:     [],
  ...overrides,
});

// ── getFilteredJobs — filter: all ────────────────────────────────────────────
console.log('\n── filter: all');

t('returns all jobs when filter=all', () => {
  global.jobs = { a: job(), b: job(), c: job() };
  global.currentFilter = 'all';
  eq(getFilteredJobs().length, 3);
});

t('sorted newest-first by createdAt', () => {
  const now = Date.now();
  global.jobs = {
    old: job({ createdAt: now - 10000 }),
    new: job({ createdAt: now }),
    mid: job({ createdAt: now - 5000 }),
  };
  global.currentFilter = 'all';
  const result = getFilteredJobs();
  eq(result[0].createdAt, now);
  eq(result[2].createdAt, now - 10000);
});

// ── getFilteredJobs — filter: status ────────────────────────────────────────
console.log('\n── filter: status');

t('filters to "applied" status only', () => {
  global.jobs = {
    a: job({ status: 'applied' }),
    b: job({ status: 'interview' }),
    c: job({ status: 'applied' }),
    d: job({ status: 'offer' }),
  };
  global.currentFilter = 'applied';
  const result = getFilteredJobs();
  eq(result.length, 2);
  result.forEach(j => eq(j.status, 'applied'));
});

t('filters to "interview" status', () => {
  global.jobs = {
    a: job({ status: 'applied' }),
    b: job({ status: 'interview' }),
  };
  global.currentFilter = 'interview';
  eq(getFilteredJobs().length, 1);
  eq(getFilteredJobs()[0].status, 'interview');
});

t('returns empty array when no jobs match status', () => {
  global.jobs = { a: job({ status: 'applied' }) };
  global.currentFilter = 'offer';
  eq(getFilteredJobs().length, 0);
});

t('status filter excludes stale jobs (stale is orthogonal to status)', () => {
  global.jobs = {
    a: job({ status: 'applied', stale: false }),
    b: job({ status: 'applied', stale: true }),   // stale but applied
    c: job({ status: 'interview', stale: false }),
  };
  global.currentFilter = 'applied';
  // Status filter doesn't care about stale — both applied jobs appear
  eq(getFilteredJobs().length, 2);
});

// ── getFilteredJobs — filter: stale ─────────────────────────────────────────
console.log('\n── filter: stale');

t('stale filter returns only stale jobs', () => {
  global.jobs = {
    a: job({ stale: true  }),
    b: job({ stale: false }),
    c: job({ stale: true  }),
    d: job({ stale: false }),
  };
  global.currentFilter = 'stale';
  const result = getFilteredJobs();
  eq(result.length, 2);
  result.forEach(j => eq(j.stale, true));
});

t('stale filter returns empty when no stale jobs', () => {
  global.jobs = { a: job({ stale: false }), b: job({ stale: false }) };
  global.currentFilter = 'stale';
  eq(getFilteredJobs().length, 0);
});

t('stale filter includes jobs of any status that are stale', () => {
  global.jobs = {
    a: job({ stale: true, status: 'applied'   }),
    b: job({ stale: true, status: 'interview' }),
    c: job({ stale: true, status: 'offer'     }),
    d: job({ stale: false }),
  };
  global.currentFilter = 'stale';
  eq(getFilteredJobs().length, 3);
});

// ── getFilteredJobs — filter: watchlist ─────────────────────────────────────
console.log('\n── filter: watchlist');

t('watchlist filter returns only watched jobs', () => {
  global.jobs = {
    a: job({ watchlist: true  }),
    b: job({ watchlist: false }),
    c: job({ watchlist: true  }),
    d: job({ watchlist: false }),
  };
  global.currentFilter = 'watchlist';
  const result = getFilteredJobs();
  eq(result.length, 2);
  result.forEach(j => eq(j.watchlist, true));
});

t('watchlist filter returns empty when no watched jobs', () => {
  global.jobs = {
    a: job({ watchlist: false }),
    b: job({ watchlist: false }),
  };
  global.currentFilter = 'watchlist';
  eq(getFilteredJobs().length, 0);
});

t('watchlist filter includes jobs of any status', () => {
  global.jobs = {
    a: job({ watchlist: true, status: 'to apply'  }),
    b: job({ watchlist: true, status: 'applied'   }),
    c: job({ watchlist: true, status: 'offer'     }),
    d: job({ watchlist: false }),
  };
  global.currentFilter = 'watchlist';
  eq(getFilteredJobs().length, 3);
});

t('watchlist and stale are independent — stale watched job appears in watchlist filter', () => {
  global.jobs = {
    a: job({ watchlist: true, stale: true  }),
    b: job({ watchlist: true, stale: false }),
    c: job({ watchlist: false, stale: true }),
  };
  global.currentFilter = 'watchlist';
  eq(getFilteredJobs().length, 2);
});

t('watchlist and stale are independent — stale watched job appears in stale filter', () => {
  global.jobs = {
    a: job({ watchlist: true, stale: true  }),
    b: job({ watchlist: false, stale: true }),
    c: job({ watchlist: true, stale: false }),
  };
  global.currentFilter = 'stale';
  eq(getFilteredJobs().length, 2);
});

// ── toggleWatchlist ──────────────────────────────────────────────────────────
console.log('\n── toggleWatchlist');

t('toggleWatchlist sets watchlist true on unwatched job', () => {
  const j = job({ watchlist: false });
  global.jobs = { [j.id]: j };
  toggleWatchlist(j.id);
  eq(global.jobs[j.id].watchlist, true);
});

t('toggleWatchlist sets watchlist false on watched job', () => {
  const j = job({ watchlist: true, watchlistAddedAt: Date.now() });
  global.jobs = { [j.id]: j };
  toggleWatchlist(j.id);
  eq(global.jobs[j.id].watchlist, false);
});

t('toggleWatchlist sets watchlistAddedAt when first starred', () => {
  const j = job({ watchlist: false });
  delete j.watchlistAddedAt;
  global.jobs = { [j.id]: j };
  toggleWatchlist(j.id);
  eq(typeof global.jobs[j.id].watchlistAddedAt, 'number');
});

t('toggleWatchlist does not reset watchlistAddedAt on re-star', () => {
  const ts = Date.now() - 50000;
  const j  = job({ watchlist: false, watchlistAddedAt: ts });
  global.jobs = { [j.id]: j };
  toggleWatchlist(j.id); // star
  eq(global.jobs[j.id].watchlistAddedAt, ts);
});

t('toggleWatchlist calls renderJobList to sync inline star', () => {
  let called = false;
  global.renderJobList = () => { called = true; };
  const j = job({ watchlist: false });
  global.jobs = { [j.id]: j };
  toggleWatchlist(j.id);
  eq(called, true);
  global.renderJobList = () => {};
});

t('toggleWatchlist calls renderDetail to update header button', () => {
  let called = false;
  global.renderDetail = () => { called = true; };
  const j = job({ watchlist: false });
  global.jobs = { [j.id]: j };
  toggleWatchlist(j.id);
  eq(called, true);
  global.renderDetail = () => {};
});

t('toggleWatchlist is a no-op for unknown jobId', () => {
  global.jobs = {};
  // Should not throw
  toggleWatchlist('nonexistent-id');
  eq(Object.keys(global.jobs).length, 0);
});

t('watchlist filter reflects toggleWatchlist changes immediately', () => {
  const j1 = job({ watchlist: false });
  const j2 = job({ watchlist: false });
  global.jobs = { [j1.id]: j1, [j2.id]: j2 };
  global.currentFilter = 'watchlist';
  eq(getFilteredJobs().length, 0);  // none starred
  toggleWatchlist(j1.id);
  eq(getFilteredJobs().length, 1);  // j1 starred
  toggleWatchlist(j2.id);
  eq(getFilteredJobs().length, 2);  // both starred
  toggleWatchlist(j1.id);
  eq(getFilteredJobs().length, 1);  // j1 un-starred
});

// ── toggleStale ──────────────────────────────────────────────────────────────
console.log('\n── toggleStale');

t('toggleStale sets stale true on active job', () => {
  const j = job({ stale: false });
  global.jobs = { [j.id]: j };
  toggleStale(j.id);
  eq(global.jobs[j.id].stale, true);
});

t('toggleStale sets stale false on stale job', () => {
  const j = job({ stale: true, staledByUser: true });
  global.jobs = { [j.id]: j };
  toggleStale(j.id);
  eq(global.jobs[j.id].stale, false);
});

t('toggleStale sets staledByUser=true when marking stale', () => {
  const j = job({ stale: false, staledByUser: false });
  global.jobs = { [j.id]: j };
  toggleStale(j.id);
  eq(global.jobs[j.id].staledByUser, true);
});

t('toggleStale sets staledByUser=false when un-staling (allows auto-check)', () => {
  const j = job({ stale: true, staledByUser: true });
  global.jobs = { [j.id]: j };
  toggleStale(j.id);
  eq(global.jobs[j.id].staledByUser, false);
});

t('toggleStale calls renderJobList', () => {
  let called = false;
  global.renderJobList = () => { called = true; };
  const j = job({ stale: false });
  global.jobs = { [j.id]: j };
  toggleStale(j.id);
  eq(called, true);
  global.renderJobList = () => {};
});

t('stale filter reflects toggleStale changes immediately', () => {
  const j1 = job({ stale: false });
  const j2 = job({ stale: false });
  global.jobs = { [j1.id]: j1, [j2.id]: j2 };
  global.currentFilter = 'stale';
  eq(getFilteredJobs().length, 0);
  toggleStale(j1.id);
  eq(getFilteredJobs().length, 1);
  toggleStale(j1.id);  // un-stale
  eq(getFilteredJobs().length, 0);
});

// ── Search interaction with filters ─────────────────────────────────────────
console.log('\n── search + filter interaction');

t('search within watchlist filter — matches title', () => {
  global.jobs = {
    a: job({ title: 'Frontend Engineer', watchlist: true  }),
    b: job({ title: 'Backend Engineer',  watchlist: true  }),
    c: job({ title: 'Designer',          watchlist: false }),
  };
  global.currentFilter = 'watchlist';
  // Override search-input mock
  global.document.getElementById = (id) => id === 'search-input' ? { value: 'frontend' } : null;
  const result = getFilteredJobs();
  eq(result.length, 1);
  eq(result[0].title, 'Frontend Engineer');
  global.document.getElementById = (id) => id === 'search-input' ? { value: '' } : null;
});

t('search within stale filter — matches company', () => {
  global.jobs = {
    a: job({ company: 'Acme Corp',  stale: true  }),
    b: job({ company: 'Beta Inc',   stale: true  }),
    c: job({ company: 'Gamma LLC',  stale: false }),
  };
  global.currentFilter = 'stale';
  global.document.getElementById = (id) => id === 'search-input' ? { value: 'acme' } : null;
  const result = getFilteredJobs();
  eq(result.length, 1);
  eq(result[0].company, 'Acme Corp');
  global.document.getElementById = (id) => id === 'search-input' ? { value: '' } : null;
});

// ── Source structure checks ──────────────────────────────────────────────────
console.log('\n── source structure');

t('filter tabs: all status tabs present', () => {
  const tabs = ['all', 'to apply', 'applied', 'interview', 'offer', 'rejected', 'stale', 'watchlist'];
  tabs.forEach(f => {
    if (!src.includes(`setFilter('${f}')`)) throw new Error(`missing filter tab: ${f}`);
  });
});

t('stale filter tab has data-filter attribute', () => {
  if (!src.includes('data-filter="stale"')) throw new Error('missing data-filter=stale');
});

t('watchlist filter tab has data-filter attribute', () => {
  if (!src.includes('data-filter="watchlist"')) throw new Error('missing data-filter=watchlist');
});

t('inline star uses event.stopPropagation (does not open job)', () => {
  const rl = src.slice(src.indexOf('function renderJobList'), src.indexOf('function selectJob'));
  if (!rl.includes('event.stopPropagation')) throw new Error('missing stopPropagation');
});

t('inline star has min-width for adequate hit target', () => {
  const rl = src.slice(src.indexOf('function renderJobList'), src.indexOf('function selectJob'));
  if (!rl.includes('min-width:20px')) throw new Error('hit target too small');
});

t('detail header has both star and trash in column layout', () => {
  const anchor = 'dv.innerHTML = `\n    <div class="detail-header">';
  const idx = src.indexOf(anchor);
  if (idx < 0) throw new Error('detail header template not found');
  const dh = src.slice(idx, idx + 5000);
  if (!dh.includes('flex-direction:column')) throw new Error('no column layout');
  if (!dh.includes('toggleWatchlist'))       throw new Error('no star button');
  if (!dh.includes('deleteJob'))             throw new Error('no trash button');
});


// ── setFilter ────────────────────────────────────────────────────────────────
// Regression: setFilter(f, el) was called with ONE arg from onclick="setFilter('x')"
// causing el.classList.add to throw TypeError: Cannot read properties of undefined
console.log('\n── setFilter');

// Build a minimal DOM shim with .filter-tab elements that have data-filter attributes
function makeFilterDOM(activeFilter) {
  const filters = ['all', 'to apply', 'applied', 'interview', 'stale', 'watchlist'];
  const tabs = filters.map(f => ({
    dataset: { filter: f },
    classList: {
      _classes: new Set(f === activeFilter ? ['filter-tab','active'] : ['filter-tab']),
      add(c)    { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      toggle(c, force) { force ? this._classes.add(c) : this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    },
  }));
  return tabs;
}

{
  let tabs = makeFilterDOM('all');
  global.document.querySelectorAll = (sel) =>
    sel === '.filter-tab' ? { forEach: (fn) => tabs.forEach(fn) } : { forEach: () => {} };

  t('setFilter("applied") works with ONE argument (no el param)', () => {
    // This is the exact call pattern used by onclick="setFilter('applied')"
    // Previously crashed: TypeError: Cannot read properties of undefined (reading 'classList')
    try {
      setFilter('applied');  // ONE argument — must not throw
    } catch(e) {
      throw new Error('setFilter threw with 1 arg: ' + e.message);
    }
    eq(global.currentFilter, 'applied');
  });

  t('setFilter sets correct currentFilter', () => {
    ['all','to apply','applied','interview','stale','watchlist'].forEach(f => {
      setFilter(f);
      eq(global.currentFilter, f);
    });
  });

  t('setFilter marks matching tab active via data-filter', () => {
    setFilter('stale');
    const staleTab = tabs.find(t => t.dataset.filter === 'stale');
    eq(staleTab.classList.contains('active'), true);
  });

  t('setFilter removes active from all other tabs', () => {
    setFilter('interview');
    tabs.filter(t => t.dataset.filter !== 'interview').forEach(tab => {
      if (tab.classList.contains('active')) {
        throw new Error(`tab "${tab.dataset.filter}" still has active class`);
      }
    });
  });

  t('setFilter calls renderJobList', () => {
    let called = false;
    global.renderJobList = () => { called = true; };
    setFilter('applied');
    eq(called, true);
    global.renderJobList = () => {};
  });

  t('filter tabs use single-arg onclick format (no el parameter)', () => {
    // Verify the HTML uses setFilter('x') not setFilter('x', this) or setFilter('x', el)
    const src2 = require('fs').readFileSync(require('path').join(__dirname,'../public/index.html'),'utf8');
    const badCalls = src2.match(/setFilter\('[^']+',\s*(?:this|el)[^)]*\)/g);
    if (badCalls) throw new Error('Found two-arg setFilter calls: ' + badCalls.join(', '));
  });

  // Restore querySelectorAll
  global.document.querySelectorAll = () => ({ forEach: () => {} });
}

// ── Version ──────────────────────────────────────────────────────────────────
console.log('\n── version');
t('App version is v1.18.3', () => {
  const src2 = require('fs').readFileSync(require('path').join(__dirname,'../public/index.html'),'utf8');
  if (!src2.includes('v1.18.3')) throw new Error('version not updated to v1.18.3');
  if (src2.includes('v1.18.2')) throw new Error('old version v1.18.2 still present');
});
// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} passed${fail ? ' ← FAILURES' : '  ✓'}`);
if (fail) process.exit(1);
