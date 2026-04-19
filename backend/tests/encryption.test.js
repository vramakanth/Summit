/**
 * encryption.test.js — End-to-end zero-knowledge encryption smoke test
 *
 * Boots the real server on a random port in a tempdir, then runs the full
 * client-side crypto ritual against it. Uses Node's native fetch + webcrypto,
 * no external test deps — keeps CI green without npm install.
 *
 * Run: node backend/tests/encryption.test.js
 */
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

// ── Setup: run server against a tempdir so we don't touch real data ─────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'summit-enc-'));
process.env.DATA_DIR   = TMP;
process.env.JWT_SECRET = 'encryption-test-secret';
process.env.PORT       = '0';
process.env.GROQ_API_KEY = '';  // no AI calls in this test
process.env.OPENROUTER_API_KEY = '';
process.env.GOOGLE_API_KEY = '';
// Silence the server's startup logs during tests
const _origLog = console.log; console.log = () => {};
const _origWarn = console.warn; console.warn = () => {};

const app = require('../server');
const crypto = require('crypto').webcrypto;

let server, base;
let passed = 0, failed = 0;
const results = [];

function t(name, fn) {
  return fn().then(
    () => { _origLog.call(console, ` ✓ ${name}`); passed++; },
    (e) => { _origLog.call(console, ` ✗ ${name} — ${e.message}`); failed++; results.push({name, err: e}); }
  );
}

// ── Client-side CryptoEngine port (mirrors frontend/public/index.html) ──────
// This is the exact same ritual the browser runs; if this test passes end-to-
// end, the frontend flow works against the backend.

async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const raw = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(String(salt).toLowerCase()), iterations: 100000, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}
async function generateDataKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
function b64encode(bytes) { return Buffer.from(bytes).toString('base64'); }
function b64decode(s) { return new Uint8Array(Buffer.from(s, 'base64')); }
async function wrapKey(dataKey, wrappingKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const rawKey = await crypto.subtle.exportKey('raw', dataKey);
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawKey);
  const combined = new Uint8Array(12 + enc.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(enc), 12);
  return b64encode(combined);
}
async function unwrapKey(b64, wrappingKey) {
  const combined = b64decode(b64);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const rawKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, data);
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function encryptWith(dataKey, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, enc.encode(plaintext));
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ct), 12);
  return b64encode(combined);
}

// Recovery code generator — same alphabet as the frontend
function generateRecoveryCodes(n = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length: n}, () =>
    Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  );
}

async function buildRecoveryKeySlots(rawCodes, dataKey, username) {
  return Promise.all(rawCodes.map(async (code, i) => {
    const codeKey = await deriveKey(code, username);
    return { index: i, slot: await wrapKey(dataKey, codeKey) };
  }));
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}
async function get(path, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + path, { headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

// ── The test suite ──────────────────────────────────────────────────────────
async function main() {
  // Boot the server
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  _origLog.call(console, '\n── Zero-knowledge encryption: full E2E ritual');

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 1: Register a zero-knowledge account, log out, log back in,
  //             unwrap dataKey, store/retrieve encrypted jobs round-trip.
  // ────────────────────────────────────────────────────────────────────────
  let alicePassword = 'correct horse battery staple';
  let aliceDataKey;
  let aliceRawCodes;
  let aliceToken;

  await t('register: zero-knowledge account persists encryptedDataKey + slots', async () => {
    aliceDataKey = await generateDataKey();
    const pwKey = await deriveKey(alicePassword, 'alice');
    const encryptedDataKey = await wrapKey(aliceDataKey, pwKey);
    aliceRawCodes = generateRecoveryCodes(8);
    const recoveryKeySlots = await buildRecoveryKeySlots(aliceRawCodes, aliceDataKey, 'alice');
    const r = await post('/api/register', {
      username: 'alice',
      email: 'alice@example.com',
      password: alicePassword,
      encryptedDataKey,
      recoveryKeySlots,
    });
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.token)                    throw new Error('no token returned');
    if (!r.body.encryptedDataKey)         throw new Error('register did not return encryptedDataKey');
    if (r.body.encryptedDataKey !== encryptedDataKey) throw new Error('encryptedDataKey round-trip mismatch');
    aliceToken = r.body.token;
  });

  await t('login: zero-knowledge account returns encrypted:true + encryptedDataKey in body', async () => {
    const r = await post('/api/login', { username: 'alice', password: alicePassword });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (r.body.encrypted !== true)        throw new Error('encrypted flag missing');
    if (!r.body.encryptedDataKey)         throw new Error('encryptedDataKey missing from login response');
    // Verify we can actually unwrap it with the password
    const pwKey = await deriveKey(alicePassword, 'alice');
    const unwrapped = await unwrapKey(r.body.encryptedDataKey, pwKey);
    if (!unwrapped)                       throw new Error('unwrap failed');
    aliceToken = r.body.token;
  });

  await t('jobs round-trip: client stores ciphertext envelope, reads identical shape back', async () => {
    const jobs = { 'j1': { id: 'j1', title: 'Engineer', company: 'Acme', status: 'applied' } };
    const ciphertext = await encryptWith(aliceDataKey, jobs);
    const put = await fetch(base + '/api/jobs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aliceToken },
      body: JSON.stringify({ __enc: true, data: ciphertext }),
    });
    if (put.status !== 200) throw new Error(`PUT failed: ${put.status}`);
    const g = await get('/api/jobs', aliceToken);
    if (g.status !== 200)              throw new Error(`GET failed: ${g.status}`);
    if (g.body.__enc !== true)         throw new Error('server did not preserve __enc envelope');
    if (!g.body.data)                  throw new Error('ciphertext not preserved');
    // Verify we can actually decrypt
    const combined = b64decode(g.body.data);
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aliceDataKey, data);
    const parsed = JSON.parse(new TextDecoder().decode(pt));
    if (parsed.j1.title !== 'Engineer') throw new Error('decrypted content wrong');
  });

  await t('recovery-codes: returns correct count (8) + createdAt', async () => {
    const r = await get('/api/recovery-codes', aliceToken);
    if (r.status !== 200)             throw new Error(`status ${r.status}`);
    if (r.body.count !== 8)           throw new Error(`expected 8 codes, got ${r.body.count}`);
    if (!r.body.createdAt)            throw new Error('no createdAt timestamp');
    if (r.body.encrypted !== true)    throw new Error('encrypted flag missing');
    // Must NOT leak slot material
    if (r.body.slot || r.body.slots || r.body.recoveryKeySlots) throw new Error('recovery-codes leaked slot material!');
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 2: Change password — must re-wrap the dataKey atomically,
  //             old password stops working, new one unwraps correctly.
  // ────────────────────────────────────────────────────────────────────────
  const aliceNewPassword = 'new strong password 123';

  await t('change-password: rejects encrypted account when newEncryptedDataKey missing', async () => {
    const r = await post('/api/change-password', {
      currentPassword: alicePassword,
      newPassword: aliceNewPassword,
      // Intentionally omit newEncryptedDataKey — server must refuse
    }, aliceToken);
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
    if (!/newEncryptedDataKey/i.test(r.body.error || '')) {
      throw new Error(`wrong error: ${r.body.error}`);
    }
  });

  await t('change-password: succeeds with re-wrapped key; old password stops working', async () => {
    const newPwKey = await deriveKey(aliceNewPassword, 'alice');
    const newEncryptedDataKey = await wrapKey(aliceDataKey, newPwKey);
    const r = await post('/api/change-password', {
      currentPassword: alicePassword,
      newPassword: aliceNewPassword,
      newEncryptedDataKey,
    }, aliceToken);
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);

    // Old password must fail
    const oldLogin = await post('/api/login', { username: 'alice', password: alicePassword });
    if (oldLogin.status === 200) throw new Error('old password still works after change');

    // New password must unwrap the same dataKey
    const newLogin = await post('/api/login', { username: 'alice', password: aliceNewPassword });
    if (newLogin.status !== 200) throw new Error(`new password login failed: ${newLogin.status}`);
    const verifyKey = await deriveKey(aliceNewPassword, 'alice');
    await unwrapKey(newLogin.body.encryptedDataKey, verifyKey);
    aliceToken = newLogin.body.token;
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 3: Recovery — simulate forgot password, use a recovery code,
  //             set a new password, verify login works with the new password.
  // ────────────────────────────────────────────────────────────────────────
  const aliceRecoveryPassword = 'recovery was needed 456';

  await t('recover phase 1: returns all 8 unused slots as array', async () => {
    const r = await post('/api/recover', {
      username: 'alice',
      recoveryCode: aliceRawCodes[3],  // try the 4th code
    });
    if (r.status !== 200)                       throw new Error(`status ${r.status}`);
    if (r.body.phase !== 1)                     throw new Error('phase != 1');
    if (!Array.isArray(r.body.slots))           throw new Error('slots not returned as array');
    if (r.body.slots.length !== 8)              throw new Error(`expected 8 slots, got ${r.body.slots.length}`);
  });

  await t('recover phase 2: client unwraps, sends slotIndex, consumes exactly that slot', async () => {
    const targetCode = aliceRawCodes[3];  // 4th code (index 3)
    // Phase 1
    const p1 = await post('/api/recover', { username: 'alice', recoveryCode: targetCode });
    // Client tries each slot
    const codeKey = await deriveKey(targetCode, 'alice');
    let recoveredKey = null;
    let matchedIdx = null;
    for (const s of p1.body.slots) {
      try {
        recoveredKey = await unwrapKey(s.slot, codeKey);
        matchedIdx = s.index;
        break;
      } catch {}
    }
    if (recoveredKey === null)              throw new Error('no slot unwrapped with code #3');
    if (matchedIdx !== 3)                   throw new Error(`expected idx 3, got ${matchedIdx}`);

    // Phase 2
    const newPwKey = await deriveKey(aliceRecoveryPassword, 'alice');
    const newEncryptedDataKey = await wrapKey(recoveredKey, newPwKey);
    const p2 = await post('/api/recover', {
      username: 'alice',
      recoveryCode: targetCode,
      newPassword: aliceRecoveryPassword,
      newEncryptedDataKey,
      slotIndex: matchedIdx,
    });
    if (p2.status !== 200)                  throw new Error(`phase 2 failed: ${p2.status} ${JSON.stringify(p2.body)}`);
    if (!p2.body.token)                     throw new Error('no token after recovery');
    if (p2.body.codesRemaining !== 7)       throw new Error(`expected 7 remaining, got ${p2.body.codesRemaining}`);
    aliceToken = p2.body.token;
  });

  await t('after recovery: login works with new password, old passwords dead', async () => {
    // New password works
    const newLogin = await post('/api/login', { username: 'alice', password: aliceRecoveryPassword });
    if (newLogin.status !== 200)            throw new Error('recovery password login failed');

    // Both prior passwords dead
    const oldLogin1 = await post('/api/login', { username: 'alice', password: alicePassword });
    if (oldLogin1.status === 200)           throw new Error('original password still works');
    const oldLogin2 = await post('/api/login', { username: 'alice', password: aliceNewPassword });
    if (oldLogin2.status === 200)           throw new Error('first changed password still works');
  });

  await t('recover phase 2: the specific slot we used is now used=true, others unchanged', async () => {
    // Read the users file directly
    const usersFile = path.join(TMP, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    const slots = users.alice.recoveryKeySlots;
    if (!slots || slots.length !== 8)       throw new Error('slots malformed');
    const usedCount = slots.filter(s => s.used).length;
    if (usedCount !== 1)                    throw new Error(`expected 1 used, got ${usedCount}`);
    if (!slots[3].used)                     throw new Error('slot index 3 should be marked used');
  });

  await t('recovery-codes count drops to 7 after consumption', async () => {
    // Login fresh to get a token that reflects the current password
    const login = await post('/api/login', { username: 'alice', password: aliceRecoveryPassword });
    const r = await get('/api/recovery-codes', login.body.token);
    if (r.body.count !== 7)                 throw new Error(`expected 7, got ${r.body.count}`);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 4: v1.19 — encryption-always-on. Plaintext registration is
  //             rejected (400). /api/enable-encryption is 410 Gone. The
  //             old /api/forgot + /api/reset-password are 410 Gone
  //             (incompatible with zero-knowledge encryption).
  // ────────────────────────────────────────────────────────────────────────

  await t('register: rejects body without encryptedDataKey (v1.19)', async () => {
    const r = await post('/api/register', { username: 'bob', password: 'bobpass123' });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    if (!/encryptedDataKey required/i.test(r.body.error || '')) {
      throw new Error(`wrong error message: ${r.body.error}`);
    }
  });

  await t('register: rejects body without recoveryKeySlots (v1.19)', async () => {
    const r = await post('/api/register', {
      username: 'bob',
      password: 'bobpass123',
      encryptedDataKey: 'somebase64ciphertext',
      // recoveryKeySlots missing
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
    if (!/recoveryKeySlots required/i.test(r.body.error || '')) {
      throw new Error(`wrong error message: ${r.body.error}`);
    }
  });

  await t('/api/enable-encryption returns 410 Gone (v1.19 removal)', async () => {
    // Endpoint removed in v1.19 — all accounts encrypted at registration.
    // The 410 stub exists so old clients surfacing the call see a clear error.
    // Re-use alice's token (authed call).
    const r = await post('/api/enable-encryption', { password: aliceRecoveryPassword }, aliceToken);
    if (r.status !== 410) throw new Error(`expected 410, got ${r.status}`);
  });

  await t('/api/forgot returns 410 Gone (v1.19 removal)', async () => {
    // Email-based password reset is fundamentally incompatible with
    // zero-knowledge encryption (resetting the password hash orphans the
    // wrapped dataKey). Replaced by recovery-code flow.
    const r = await post('/api/forgot', { username: 'alice' });
    if (r.status !== 410) throw new Error(`expected 410, got ${r.status}`);
  });

  await t('/api/reset-password returns 410 Gone (v1.19 removal)', async () => {
    const r = await post('/api/reset-password', { token: 'irrelevant', newPassword: 'x' });
    if (r.status !== 410) throw new Error(`expected 410, got ${r.status}`);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 5: Recovery-codes regenerate — rotate all slots
  // ────────────────────────────────────────────────────────────────────────

  await t('recovery-codes/generate: regenerates all slots, old codes invalidated', async () => {
    // Alice already consumed one code; login fresh
    const login = await post('/api/login', { username: 'alice', password: aliceRecoveryPassword });
    const token = login.body.token;
    const pwKey = await deriveKey(aliceRecoveryPassword, 'alice');
    const dk = await unwrapKey(login.body.encryptedDataKey, pwKey);

    const newRawCodes = generateRecoveryCodes(8);
    const newSlots = await buildRecoveryKeySlots(newRawCodes, dk, 'alice');
    const r = await post('/api/recovery-codes/generate', {
      password: aliceRecoveryPassword,
      recoveryKeySlots: newSlots,
    }, token);
    if (r.status !== 200)                     throw new Error(`generate failed: ${r.status}`);
    if (r.body.count !== 8)                   throw new Error(`expected 8, got ${r.body.count}`);

    // Old codes must no longer work for recovery
    const oldCodeAttempt = await post('/api/recover', { username: 'alice', recoveryCode: aliceRawCodes[0] });
    // Phase 1 still returns slots (server can't know the code is wrong without trying)
    // but the NEW slots won't unwrap with the old code
    const oldKey = await deriveKey(aliceRawCodes[0], 'alice');
    let anyWorked = false;
    for (const s of oldCodeAttempt.body.slots) {
      try { await unwrapKey(s.slot, oldKey); anyWorked = true; break; } catch {}
    }
    if (anyWorked) throw new Error('old recovery code still works after regeneration');
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 6: Inbox handoff (v1.19.2) — extension POSTs plaintext,
  //             webapp drains. This is the one plaintext-OK path by design:
  //             public job URL + title/company scraped from a public page.
  // ────────────────────────────────────────────────────────────────────────

  await t('inbox POST: requires title + company', async () => {
    const r1 = await post('/api/jobs/inbox', { company: 'Stripe' }, aliceToken);
    if (r1.status !== 400) throw new Error(`missing title should 400, got ${r1.status}`);
    const r2 = await post('/api/jobs/inbox', { title: 'Engineer' }, aliceToken);
    if (r2.status !== 400) throw new Error(`missing company should 400, got ${r2.status}`);
  });

  await t('inbox POST: persists entry + returns id', async () => {
    const r = await post('/api/jobs/inbox', {
      title: 'Senior Engineer',
      company: 'Stripe',
      url: 'https://example.com/job',
    }, aliceToken);
    if (r.status !== 200)     throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.id)           throw new Error('no id in response');
    if (!/^[a-f0-9]+$/.test(r.body.id)) throw new Error(`id not hex: ${r.body.id}`);
    if (!r.body.receivedAt)   throw new Error('no receivedAt in response');
  });

  await t('inbox GET: returns FIFO list with the entry we just posted', async () => {
    const r = await get('/api/jobs/inbox', aliceToken);
    if (r.status !== 200)          throw new Error(`status ${r.status}`);
    if (!Array.isArray(r.body.entries)) throw new Error('entries not array');
    const found = r.body.entries.find(e => e.company === 'Stripe' && e.title === 'Senior Engineer');
    if (!found)                    throw new Error('just-posted entry not in list');
    if (found.url !== 'https://example.com/job') throw new Error('url not persisted');
  });

  await t('inbox DELETE: returns deleted:true on first call, deleted:false on second (race-safe)', async () => {
    // Post a fresh entry so we control the id
    const post1 = await post('/api/jobs/inbox', {
      title: 'Race Test',
      company: 'Stripe',
    }, aliceToken);
    const id = post1.body.id;

    // First DELETE removes the file
    const del1 = await fetch(base + '/api/jobs/inbox/' + id, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + aliceToken },
    });
    const b1 = await del1.json();
    if (del1.status !== 200)  throw new Error(`first delete status ${del1.status}`);
    if (b1.deleted !== true)  throw new Error(`first delete should report deleted:true, got ${JSON.stringify(b1)}`);

    // Second DELETE (simulating a racing tab) must NOT error — returns deleted:false
    const del2 = await fetch(base + '/api/jobs/inbox/' + id, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + aliceToken },
    });
    const b2 = await del2.json();
    if (del2.status !== 200)   throw new Error(`second delete status ${del2.status}`);
    if (b2.deleted !== false)  throw new Error(`second delete should report deleted:false, got ${JSON.stringify(b2)}`);
  });

  await t('inbox DELETE: rejects invalid id (path-traversal guard)', async () => {
    const bad = await fetch(base + '/api/jobs/inbox/..%2F..%2Fusers.json', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + aliceToken },
    });
    if (bad.status !== 400) throw new Error(`bad id should 400, got ${bad.status}`);
  });

  await t('inbox POST: accepts valid reqId + reqIdLabel (v1.19.3)', async () => {
    const r = await post('/api/jobs/inbox', {
      title: 'Designer',
      company: 'Acme',
      url: 'https://acme.com/d',
      reqId: 'R-12345',
      reqIdLabel: 'Job Requisition ID',
    }, aliceToken);
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    // Verify the stored entry has reqId
    const list = await get('/api/jobs/inbox', aliceToken);
    const found = list.body.entries.find(e => e.id === r.body.id);
    if (!found)                         throw new Error('entry not in list');
    if (found.reqId !== 'R-12345')      throw new Error(`reqId not persisted: ${found.reqId}`);
    if (found.reqIdLabel !== 'Job Requisition ID') throw new Error('reqIdLabel not persisted');
  });

  await t('inbox POST: rejects URL-shaped reqId (silently drops, not 400)', async () => {
    // Policy: invalid reqId doesn't block the whole POST — we still want
    // the job added. Just drop the reqId silently.
    const r = await post('/api/jobs/inbox', {
      title: 'Analyst',
      company: 'Beta',
      reqId: 'https://attacker.example/evil',
    }, aliceToken);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const list = await get('/api/jobs/inbox', aliceToken);
    const found = list.body.entries.find(e => e.id === r.body.id);
    if (!found)                   throw new Error('entry missing');
    if (found.reqId)              throw new Error(`URL-shaped reqId should be dropped, got: ${found.reqId}`);
  });

  await t('inbox POST: rejects too-short and too-long reqId values', async () => {
    // Shape: /^[A-Za-z0-9][A-Za-z0-9._\-]{2,40}$/  (3–41 chars)
    for (const bad of ['ab', 'a'.repeat(50), 'has space', '']) {
      const r = await post('/api/jobs/inbox', {
        title: 'T', company: 'C', reqId: bad,
      }, aliceToken);
      if (r.status !== 200) throw new Error(`unexpected status ${r.status} for reqId="${bad}"`);
      const list = await get('/api/jobs/inbox', aliceToken);
      const found = list.body.entries.find(e => e.id === r.body.id);
      if (found && found.reqId) {
        throw new Error(`invalid reqId "${bad}" should have been dropped, but was persisted`);
      }
    }
  });

  await t('inbox auth: GET without token is 401', async () => {
    const r = await fetch(base + '/api/jobs/inbox');
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  });

  await t('inbox auth: one user cannot read another user\'s inbox', async () => {
    // Post as alice
    const posted = await post('/api/jobs/inbox', {
      title: 'Alice only', company: 'Secret',
    }, aliceToken);

    // Create a second user
    const charlieDataKey = await generateDataKey();
    const charliePwKey = await deriveKey('charlie-password', 'charlie');
    const charlieEncDK = await wrapKey(charlieDataKey, charliePwKey);
    const charlieCodes = generateRecoveryCodes(8);
    const charlieSlots = await buildRecoveryKeySlots(charlieCodes, charlieDataKey, 'charlie');
    const reg = await post('/api/register', {
      username: 'charlie',
      password: 'charlie-password',
      email: 'c@e.com',
      encryptedDataKey: charlieEncDK,
      recoveryKeySlots: charlieSlots,
    });
    const charlieToken = reg.body.token;

    // Charlie's inbox should NOT include alice's entry
    const charlieInbox = await get('/api/jobs/inbox', charlieToken);
    const leaked = charlieInbox.body.entries.find(e => e.id === posted.body.id);
    if (leaked) throw new Error('cross-tenant inbox leak — charlie sees alice\'s entries');

    // And charlie cannot DELETE alice's entry (404 since it's not in his dir)
    const evil = await fetch(base + '/api/jobs/inbox/' + posted.body.id, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + charlieToken },
    });
    // Should return 200 with deleted:false (file doesn't exist in charlie's dir)
    const evilBody = await evil.json();
    if (evil.status !== 200 || evilBody.deleted !== false) {
      throw new Error(`expected silent-miss from other user, got ${evil.status}: ${JSON.stringify(evilBody)}`);
    }

    // Alice's entry should still be in ALICE's inbox (charlie's DELETE didn't touch it)
    const aliceInbox = await get('/api/jobs/inbox', aliceToken);
    const stillThere = aliceInbox.body.entries.find(e => e.id === posted.body.id);
    if (!stillThere) throw new Error('alice\'s entry was deleted by charlie\'s call — path-traversal bug!');
  });

  // ────────────────────────────────────────────────────────────────────────
  _origLog.call(console, `\n${passed} passed, ${failed} failed`);

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log = _origLog;
  console.warn = _origWarn;
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  _origLog.call(console, 'Fatal:', e);
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
