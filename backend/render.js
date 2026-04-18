// render.js — Puppeteer-based DOM rendering for SPAs that Jina can't handle.
//
// We launch a single long-lived Chromium instance (@sparticuz/chromium — a
// minified serverless-optimized build) and create a fresh incognito context
// per request. Memory budget on Render Starter (512MB) is tight:
//   - Summit Express server resident: ~150MB
//   - Idle Chromium after first launch: ~60MB
//   - During a render: ~150-200MB (context + page)
//   - Peak combined: ~350MB
// Leaving ~150MB headroom before the OOM killer. Good enough for single-user
// traffic with serialized rendering (max concurrency = 1).
//
// To disable rendering entirely (e.g. if it's crashing or the tier can't
// afford the memory) set DISABLE_RENDER=1 — fetchATS will skip the renderer
// and fall through to its existing Jina + slug paths.

const DISABLE_RENDER = process.env.DISABLE_RENDER === '1';
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

let _browser = null;
let _launchPromise = null;
let _renderMutex = Promise.resolve();
let _consecutiveFailures = 0;
let _circuitOpenedAt = 0;

/**
 * Lazy-launch a shared browser instance. All callers await the same promise
 * so we only pay the ~500ms launch cost once. If the browser ever crashes
 * (disconnected event), we reset so the next caller triggers a fresh launch.
 */
async function getBrowser() {
  if (DISABLE_RENDER) throw new Error('Rendering disabled (DISABLE_RENDER=1)');
  if (_browser && _browser.isConnected()) return _browser;
  if (_launchPromise) return _launchPromise;

  _launchPromise = (async () => {
    const chromium = require('@sparticuz/chromium');
    const puppeteer = require('puppeteer-core');

    // @sparticuz ships a minified Chromium + predefined args for serverless.
    // We have to filter out '--single-process' — it collapses all renderer
    // processes into the browser process, which sounds like a memory win
    // but is actually the main reason Chromium crashes under puppeteer on
    // Render Starter. Symptom seen in v1.17.0 logs: "Target closed" errors
    // immediately after every browser.createBrowserContext() — the single
    // process dies the moment it tries to spawn a renderer target.
    //
    // Chromium upstream says single-process is for Android WebView only
    // and breaks when Chrome is the content embedder, which is our case.
    // Removing it lets Chromium fork a renderer process as designed.
    // Memory peak goes up ~50MB but stays within Render Starter's budget
    // with aggressive resource blocking + serialized renders.
    const safeChromiumArgs = chromium.args.filter(
      a => !/^--single-process\b/.test(a)
    );

    const browser = await puppeteer.launch({
      args: [
        ...safeChromiumArgs,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
      ],
      defaultViewport: { width: 1280, height: 720 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    browser.on('disconnected', () => {
      console.warn('[render] browser disconnected — will relaunch on next call');
      _browser = null;
      _launchPromise = null;
    });

    _browser = browser;
    _launchPromise = null;
    console.log('[render] Chromium launched');
    return browser;
  })();

  try {
    return await _launchPromise;
  } catch (e) {
    _launchPromise = null;
    throw e;
  }
}

/**
 * Render a URL in Chromium and return the post-hydration DOM + visible text.
 * All heavy resources (images, fonts, stylesheets, media) are blocked — we
 * only need the text content + JSON-LD script tags, so we save bandwidth
 * and rendering time by refusing anything non-essential.
 *
 * Returns { html, text, final_url, status } on success, null on any failure
 * (caller falls back to Jina / slug). Serialized via _renderMutex so Render
 * Starter's 0.5 CPU doesn't get saturated by parallel renders.
 */
async function renderPage(url, { timeoutMs = 8000 } = {}) {
  if (DISABLE_RENDER) return null;

  // Serialize all renders — single-CPU Render tier chokes on parallel
  // Chromium work, and we only need one at a time for a single-user app.
  const prev = _renderMutex;
  let release;
  _renderMutex = new Promise(r => { release = r; });
  await prev;

  try {
    // Circuit breaker: if the last 3 renders have failed in a row, stop
    // trying for 60 seconds so we don't repeatedly pay the launch cost on
    // a broken browser. After the cooldown window, the next call tries
    // fresh — if it fails again, the circuit re-opens.
    if (_consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      if (Date.now() - _circuitOpenedAt < CIRCUIT_BREAKER_COOLDOWN_MS) {
        return null;
      }
      // Cooldown passed — reset and give it another shot.
      console.log('[render] circuit-breaker cooldown elapsed — retrying');
      _consecutiveFailures = 0;
      _circuitOpenedAt = 0;
    }

    const browser = await getBrowser();
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
      // Block every resource type we don't need. document + script are
      // required (to execute the SPA) — xhr/fetch is sometimes needed for
      // the posting data to arrive post-hydration. Everything else is noise.
      await page.setRequestInterception(true);
      page.on('request', req => {
        const type = req.resourceType();
        if (type === 'image' || type === 'font' || type === 'media' ||
            type === 'stylesheet' || type === 'texttrack' ||
            type === 'imageset' || type === 'manifest' || type === 'other') {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Spoof a real browser UA — some sites detect headless via UA.
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      );

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      // Give the SPA up to 2s of additional hydration time — most inject
      // their JSON-LD and populate content synchronously after DOMContentLoaded.
      // networkidle0 is more reliable but often hangs on analytics beacons.
      try {
        await page.waitForFunction(
          () => !!document.querySelector('script[type="application/ld+json"]')
                || (document.body?.innerText || '').length > 500,
          { timeout: 2000 }
        );
      } catch {}

      const html = await page.content();
      const text = await page.evaluate(() => document.body?.innerText || '');
      const final_url = page.url();
      const status = response ? response.status() : 0;

      _consecutiveFailures = 0;
      return { html, text, final_url, status };
    } finally {
      // Always close page + context so memory is released. Even on success —
      // the point of incognito context is isolation, not reuse.
      try { await page.close(); } catch {}
      try { await context.close(); } catch {}
    }
  } catch (e) {
    _consecutiveFailures++;
    if (_consecutiveFailures === CIRCUIT_BREAKER_THRESHOLD) {
      _circuitOpenedAt = Date.now();
      console.warn(`[render] circuit-breaker opened after ${CIRCUIT_BREAKER_THRESHOLD} failures — pausing for ${CIRCUIT_BREAKER_COOLDOWN_MS/1000}s`);
    }
    console.warn(`[render] failed (${_consecutiveFailures}): ${e.message}`);
    return null;
  } finally {
    release();
  }
}

/**
 * Gracefully shut down the browser. Called by server.js on SIGTERM so
 * Render's restart cycle doesn't leave zombie Chromium processes. Returns
 * a promise that resolves whether or not the browser was running.
 */
async function shutdownBrowser() {
  if (_browser) {
    const b = _browser;
    _browser = null;
    try { await b.close(); } catch {}
  }
}

module.exports = { renderPage, shutdownBrowser };
