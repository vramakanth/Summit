# Applied — Job Application Tracker

A self-hosted job application tracker with user accounts, AI tailoring, file management, and timestamped notes.

## Project Structure

```
applied-tracker/
├── backend/
│   ├── server.js        # Express API server
│   ├── package.json
│   └── data/            # Created automatically on first run
│       ├── users.json   # Hashed user credentials
│       └── jobs/        # Per-user job data (one JSON file per user)
└── frontend/
    └── public/
        └── index.html   # Full single-file frontend app
```

## Quick Start (Local)

```bash
cd backend
npm install
node server.js
# Open http://localhost:3000
```

---

## Deployment Options

### Option A — Railway (recommended, free tier available)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set root directory to `backend/`
4. Add environment variable: `JWT_SECRET=your-long-random-secret-here`
5. Railway auto-detects Node.js and runs `npm start`

> **Note**: Railway's free tier has ephemeral storage. For persistent data, add a Railway Volume mounted at `/app/data`.

### Option B — Render (free tier, persistent disk)

1. Push repo to GitHub
2. New Web Service → connect repo
3. Root directory: `backend/`
4. Build command: `npm install`
5. Start command: `node server.js`
6. Add environment variable: `JWT_SECRET=your-long-random-secret-here`
7. Add a Disk: mount path `/app/data`, size 1GB

### Option C — VPS / DigitalOcean Droplet

```bash
# On your server:
git clone <your-repo>
cd applied-tracker/backend
npm install

# Install PM2 for process management
npm install -g pm2
JWT_SECRET=your-secret pm2 start server.js --name applied
pm2 save
pm2 startup

# Nginx reverse proxy (optional, for custom domain)
# Point your domain to the server and proxy :3000
```

### Option D — Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --production
COPY backend/ .
COPY frontend/ ../frontend/
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t applied-tracker .
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data -e JWT_SECRET=your-secret applied-tracker
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port to listen on |
| `JWT_SECRET` | `change-this-secret-in-production-please` | Secret for signing JWTs — **change this!** |

---

## Security Notes

- Passwords are hashed with bcrypt (12 rounds) — never stored in plain text
- JWTs expire after 30 days
- Each user's job data is stored in a separate file, isolated by user ID
- **Always set a strong `JWT_SECRET`** in production — generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```

---

## Customizing the Anthropic API Key

The AI tailoring feature calls the Anthropic API from the browser using the key embedded in the Claude.ai artifact environment. To use it in your own hosted version, you'll need to:

1. Get an API key from [console.anthropic.com](https://console.anthropic.com)
2. Move the API call to the backend (recommended for security):

```js
// In server.js, add a proxy route:
app.post('/api/tailor', authMiddleware, async (req, res) => {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(req.body)
  });
  // stream back to client...
});
```

3. In `index.html`, change the fetch URL from `https://api.anthropic.com/v1/messages` to `/api/tailor`
