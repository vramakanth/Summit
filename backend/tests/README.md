# Summit — Test Suite

Tests are split into three tiers by dependency weight. The fastest tier runs without any npm install; the heaviest boots a real server against a tempdir to exercise end-to-end flows.

## Tiers

### Tier 1 — Zero-dep (`npm run test:node`)

Plain-node tests. No `npm install` required anywhere. Just works.

- `behavior.test.js` — 248 tests. Source-regex guards + behavioral dedupe helpers that eval webapp functions against fixtures.
- `architecture.test.js` — 72 tests. Module structure, export shape, file-size guards.
- `e2e.test.js` — 11 tests. Webcrypto primitives the browser uses, exercised end-to-end without a server.

### Tier 2 — Crypto primitives (`npm run test:crypto`)

- `crypto.test.js` — 9 tests. Zero-knowledge wrap/unwrap/recovery round-trips using Node's native webcrypto. No server, no deps.

### Tier 3 — Full integration (`npm run test:integration`)

Boots the real Express server on a random port against a tempdir. Covers the complete zero-knowledge lifecycle, inbox handoff, and ATS parsing.

**Requires:**
```bash
cd backend && npm install          # express, multer, bcryptjs, jsonwebtoken, etc.
cd tests && npm install            # jest, supertest
```

Then:
```bash
npm run test:integration
```

Included:
- `encryption.test.js` — 27 tests. Registration, login, jobs round-trip, change-password, recovery codes phase 1+2, `/api/forgot` / `/api/reset-password` / `/api/enable-encryption` all returning 410 Gone (v1.19 removals), inbox POST/GET/DELETE with race semantics, reqId validation, cross-tenant isolation.
- `ats.test.js` — ATS parsing unit tests (`cleanJobUrl`, `detectATS`, `slugFallback`, salary extraction paths).

## Running everything

```bash
npm test
```

Runs Tiers 1 + 2 + 3 in order. Tier 1 is ~seconds; Tier 3 is ~10s because it boots a real server and does bcrypt password hashing.

## CI recommendation

Run `test:node && test:crypto` on every push (no install needed, sub-5s feedback). Run `test:integration` on PRs + main-branch pushes where you're willing to do `npm install` anyway.

## Adding tests

- **Regression guard on source**: append to `behavior.test.js`, use `/regex/.test(feSrc)` or `serverSrc`. Cheap, catches "someone deleted this function".
- **Actual logic check**: append to `behavior.test.js` in the "BEHAVIORAL" section — use `_extractFn` + `_buildDedupeScope` to eval real functions against fixtures.
- **End-to-end flow**: append to `encryption.test.js`. Uses `post()`/`get()` helpers + the test's own webcrypto port. Auto-wires into the runner.
