# Summit — Job Application Tracker

![Tests](https://github.com/vramakanth/Job-Application-Tracker/actions/workflows/test.yml/badge.svg)

**Summit** is a self-hosted job application tracker with AI-powered company insights, resume tailoring, interview prep, and a Chrome extension for one-click job capture from any job board.

Live at **[jobsummit.app](https://jobsummit.app)**

---

## Features

- **Pipeline tracking** — Kanban-style status board from wishlist to offer
- **Company intelligence** — Glassdoor ratings, culture summary, news, role intel, workforce data
- **AI resume tailoring** — Tailor resume and cover letter to each job posting
- **Interview prep** — AI-generated role-specific questions, categorized and trackable
- **Compensation research** — Market salary benchmarks per role and location
- **Document library** — Store and version resumes and cover letters
- **Chrome extension** — One-click job capture from any job board
- **Watchlist** — Star jobs to track high-priority applications
- **Stale detection** — Auto-detects expired postings

---

## Project Structure

```
applied-tracker/
├── .github/
│   └── workflows/
│       └── test.yml          # GitHub Actions CI (runs on every push)
├── backend/
│   ├── server.js             # Express API — auth, jobs, AI endpoints
│   ├── ats-helpers.js        # URL cleaning, slug fallback
│   ├── package.json
│   ├── tests/
│   │   └── architecture.test.js   # 56 backend unit tests
│   └── data/                 # Auto-created on first run
│       ├── users.json        # Bcrypt-hashed credentials
│       └── jobs/             # Per-user job data (one JSON per user)
├── frontend/
│   ├── public/
│   │   └── index.html        # Full single-page app (~6,400 lines)
│   └── tests/
│       └── smoke.test.js     # 43 frontend regression tests
└── extension/
    ├── manifest.json         # Chrome extension manifest v3
    ├── content.js            # DOM extraction from job pages
    └── popup.js              # Extension popup
```

---

## Running Locally

```bash
cd backend
npm install
node server.js
# Open http://localhost:3000
```

---

## Deployment (Render)

Summit runs on [Render](https://render.com) with a persistent disk.

1. Push this repo to GitHub
2. New Web Service → connect repo
3. Root directory: `backend/`
4. Build command: `npm install`
5. Start command: `node server.js`
6. Add a Disk: mount path `/app/data`, size 1 GB
7. Set environment variables (see below)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | ✅ | Secret for signing JWTs — generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `GROQ_API_KEY` | ✅ | Primary AI provider — [console.groq.com](https://console.groq.com) (free tier available) |
| `OPENROUTER_API_KEY` | ✅ | Fallback AI provider — [openrouter.ai](https://openrouter.ai) |
| `GOOGLE_API_KEY` | ✅ | Second fallback — [aistudio.google.com](https://aistudio.google.com) |
| `PORT` | — | Defaults to `3000` |
| `DATA_DIR` | — | Defaults to `./data` |
| `ADMIN_SECRET` | — | Optional header secret for `/api/admin/*` routes |

**AI fallback chain:** Groq → OpenRouter → Google. If Groq is healthy, responses return in 2–5 seconds.

---

## Chrome Extension

Download from Settings → Browser Extensions inside the app, or load unpacked from the `extension/` folder in Chrome DevTools → Extensions → Load unpacked.

Visit any job posting (Indeed, LinkedIn, Greenhouse, ZipRecruiter, etc.) and click the Summit icon to auto-extract the job title, company, salary, location, and full posting text.

---

## Tests

Tests run automatically via GitHub Actions on every push to `main`.

**Run locally:**

```bash
# Backend (56 unit tests — URL parsing, AI routing, salary extraction)
node backend/tests/architecture.test.js

# Frontend (43 smoke tests — UI regression, watchlist, settings, tabs)
node frontend/tests/smoke.test.js
```

**View CI results:** Go to the [Actions tab](https://github.com/vramakanth/Job-Application-Tracker/actions) on GitHub.

---

## Security

- Passwords hashed with bcrypt (12 rounds)
- JWTs expire after 30 days
- Per-user data isolation — each user's jobs stored in a separate file
- Optional AES-256-GCM encryption for job data at rest

---

## Tech Stack

| Layer | Stack |
|-------|-------|
| Backend | Node.js, Express |
| Frontend | Vanilla JS, single HTML file |
| AI | Groq (llama-3.3-70b), OpenRouter, Google Gemini |
| Job parsing | Jina.ai reader → direct fetch → slug fallback |
| Auth | JWT + bcrypt |
| Hosting | Render (backend + disk), Namecheap DNS |
| CI | GitHub Actions |
