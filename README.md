# Summit

![Tests](https://github.com/vramakanth/Summit/actions/workflows/test.yml/badge.svg)

**Your entire job search — applications, research, resumes, interviews — in one private workspace.**

Summit is a job-application planning and tracking web app with a companion Chrome/Safari extension. Its defining property is **zero-knowledge encryption**: your job data is encrypted in your browser with a key derived from your password, and the server only ever stores ciphertext. Nobody — including the operator — can read your workspace without your password.

Live at **[jobsummit.app](https://jobsummit.app)** · Current version **v1.20.11** · Extension **v2.6.2**

---

## What it does

- **Capture** any posting in one click with the browser extension, or paste a URL. The server extracts title, company, location, work type, salary, and requisition ID; you review and correct before saving.
- **Track** every application through a pipeline — to apply → applied → interview → offer — with a watchlist, bulk actions, and stale-posting detection.
- **Research** the company from inside the job: news, culture signals, ratings, and market salary benchmarks for the role and location.
- **Tailor** your resume and cover letter to the specific posting, from a versioned document library (PDF/DOCX upload supported).
- **Prepare** with AI-generated, role-specific interview questions you can categorise and track.
- **Own your data** — export the whole workspace as a ZIP and import it back; recovery codes let you unlock the account if you forget your password.

Installable as a PWA on mobile. Works on any job board; there is no site-specific parsing.

---

## How the privacy model works

```
 password ──PBKDF2 (100k)──▶ pwKey ──unwrap──▶ dataKey (AES-GCM-256, in memory only)
                                                    │
   jobs / notes / documents ◀── encrypt/decrypt ────┘
                                                    │
   server stores: {encryptedDataKey, ciphertext}    ▼   never: password, pwKey, dataKey, plaintext
```

- `dataKey` lives only in browser memory. A page reload keeps you signed in (the JWT persists) but shows an **unlock screen** to re-derive the key from your password — this is expected behaviour, not a bug.
- **Recovery codes** (eight, single-use) are generated at registration. Each one independently wraps `dataKey`. Lose the password *and* every code and the data is unrecoverable by design.
- The **browser extension** can't decrypt your workspace (it doesn't have the key). It posts captured jobs to a per-user server **inbox** in plaintext; the web app drains the inbox, dedupes, merges, and re-encrypts. Inbox entries are consumed atomically so multiple open tabs can't double-add.
- **Analytics** are first-party and cookie-free: public screens (landing, login, register) send a beacon with the screen name and referrer host. The server stores no IP, no user-agent, and a visitor hash that rotates daily and can't be reversed. Do-Not-Track and Global Privacy Control are honoured. Nothing inside the workspace is tracked.

---

## Architecture

| Layer | What | Notes |
|---|---|---|
| Frontend | Vanilla JS, one `index.html` (~10.4k lines), Dexie/IndexedDB | No framework, no build step |
| Backend | Node 18+ / Express, 64 REST endpoints (~2.8k lines) | File-backed per-user storage, no database |
| Rendering | Headless Chromium via `puppeteer-core` + `@sparticuz/chromium` | For JS-rendered postings on the paste-URL path |
| Extension | Chrome/Safari Manifest V3 | `content.js` is a pure *reader* — no extraction logic |
| AI | Groq → OpenRouter → Google Gemini fallback chain | Per-user daily token cap; model IDs env-overridable |
| Crypto | PBKDF2 (100k) → AES-GCM-256, WebCrypto | Passwords: bcrypt (12 rounds); JWTs expire in 30 days |
| Admin | `admin.html` — users, AI token usage, visitors + funnel | Gated by `ADMIN_USERNAME(S)` or `ADMIN_SECRET` |

**One extraction pipeline.** Whether a job arrives from the extension (which ships the rendered HTML, body text, JSON-LD, and meta tags — gzipped) or from a pasted URL (which the server fetches and renders itself), the same `extractJobFields()` runs: JSON-LD probe → salary regex → AI gap-fill. There's exactly one place to fix parsing bugs.

### Repository layout

```
Summit/
├── .github/workflows/test.yml     # CI — three test tiers on every push
├── backend/
│   ├── server.js                  # Express API: auth, jobs, inbox, extraction, AI, admin, analytics
│   ├── render.js                  # Long-lived headless Chromium for JS-rendered postings
│   ├── ats-helpers.js             # URL normalisation, entity decoding, ID-token trimming
│   ├── package.json
│   ├── tests/                     # architecture · behavior · e2e · crypto (zero-dep)
│   │                              # encryption (HTTP round-trips) · ats (jest)
│   └── data/                      # Created on first run — see DATA_DIR
│       ├── users.json             # bcrypt hashes, wrapped keys, recovery slots
│       ├── jobs/  docs/  notes/   # Per-user encrypted blobs
│       ├── settings/  inbox/      # Per-user settings; extension → webapp handoff queue
│       ├── usage/                 # AI token usage (NDJSON, monthly)
│       └── visits/                # Page-view log (NDJSON, monthly, no PII)
├── frontend/
│   ├── public/
│   │   ├── index.html             # The app + landing + auth screens
│   │   ├── admin.html             # Operator dashboard
│   │   ├── manifest.json  sw.js   # PWA manifest + service worker (static assets only)
│   │   └── reset-password.html    # Legacy email-reset landing (recovery codes replaced it)
│   └── tests/                     # smoke · filter · mobile · joblist (zero-dep)
└── extension/
    ├── manifest.json              # MV3
    ├── content.js                 # Reader: html + text + JSON-LD + meta → popup; webapp bridge
    ├── popup.js / popup.html      # Two-stage flow: extract → review/edit → save to inbox
    ├── background.js              # Service worker; session sync with the webapp
    └── tests/extension.test.js
```

---

## Running locally

```bash
cd backend
npm install
node server.js          # http://localhost:3000
```

No AI keys are required to boot — AI features degrade to "unavailable" rather than crashing. Chromium rendering needs the `@sparticuz/chromium` binary, which `npm install` fetches.

**Extension:** `chrome://extensions` → Developer mode → *Load unpacked* → select `extension/`. Note that Chrome does not inject content scripts into tabs that were already open when you load or reload the extension; Summit works around this by injecting on demand, so you shouldn't need to reload tabs.

---

## Deployment (Render)

1. New **Web Service** → connect the repo; root directory `backend/`
2. Build: `npm install` · Start: `node server.js`
3. Add a **Disk** (1 GB is plenty) mounted at `/app/data`, and set `DATA_DIR=/app/data`
4. Set the environment variables below
5. Deploy. The extension is served from `/api/extension` so users can download it from Settings.

Backend and frontend deploy together — the server serves `frontend/public` statically. Extension releases are separate: bump `extension/manifest.json`, and bump `MIN_EXTENSION_VERSION` in `index.html` so users on older builds see an update banner.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | Signs session tokens and salts the daily visitor hash. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `DATA_DIR` | on Render | Where user data lives. Default `./data`; set to the mounted disk in production |
| `GROQ_API_KEY` | for AI | Primary provider — [console.groq.com](https://console.groq.com) |
| `OPENROUTER_API_KEY` | for AI | First fallback — [openrouter.ai](https://openrouter.ai) |
| `GOOGLE_API_KEY` | for AI | Second fallback — [aistudio.google.com](https://aistudio.google.com) |
| `GROQ_MODEL` / `GROQ_FALLBACK_MODEL` | — | Default `openai/gpt-oss-120b` / `openai/gpt-oss-20b`. Override here when a provider deprecates a model — no redeploy needed |
| `OPENROUTER_MODEL` / `GOOGLE_MODEL` | — | Defaults `openrouter/free` / `gemini-2.5-flash` |
| `DAILY_TOKEN_CAP` | — | Per-user daily AI token budget. Default 100,000 |
| `ADMIN_USERNAME` or `ADMIN_USERNAMES` | for admin | Summit username(s) allowed into `admin.html` — comma-separated, case-insensitive; both names accepted and merged. Removing a name revokes access immediately |
| `ADMIN_SECRET` | — | Alternative `x-admin-secret` header for scripted access to `/api/admin/*` |
| `PORT` | — | Default `3000` |

---

## Tests

Three tiers, all run by CI on every push. The first two are **blocking**.

| Tier | Files | Tests | Deps |
|---|---|---|---|
| Backend zero-dep | `architecture` `behavior` `e2e` `crypto` | 420 | none |
| Frontend + extension zero-dep | `smoke` `filter` `mobile` `joblist` `extension` | 333 | none |
| Integration | `encryption` (boots the server, HTTP round-trips) · `ats` (jest) | 66 | `npm install` |

```bash
# Zero-dep tiers — plain node, ~3 seconds total
for f in backend/tests/{architecture,behavior,e2e,crypto}.test.js frontend/tests/*.test.js extension/tests/*.test.js; do node "$f"; done

# Integration tier
cd backend && npm install && node tests/encryption.test.js
cd backend/tests && npm install && npx jest
```

Most tests are **regression guards**: each fix ships with a test that fails if the bug is reintroduced. Many are structural — they read the source and assert invariants (every route that touches `users[]` calls `loadUsers()` first; the visit log can never gain an `ip` field; `popup.js`'s header version must match `manifest.json`; the extension's content script can't grow extraction logic). The suite is deliberately dependency-free so it can't rot when a test framework releases a breaking version.

---

## Security summary

- End-to-end encrypted workspace; server holds ciphertext and a password-wrapped key only
- Passwords hashed with bcrypt (12 rounds); JWTs expire after 30 days
- Recovery codes replace email reset (email reset is incompatible with zero-knowledge)
- Rate limiting on login, recovery, and the analytics beacon
- Admin routes require an admin-claim JWT re-validated against the env allow-list on every request, or the shared secret
- No third-party scripts, no cookies, no ad or analytics vendors

---

## Status

Summit is an independent product run by a California LLC. It is in private beta.
