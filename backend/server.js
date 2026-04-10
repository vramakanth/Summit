const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production-please';
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// --- Helpers ---
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function loadUserJobs(userId) {
  const file = path.join(JOBS_DIR, `${userId}.json`);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveUserJobs(userId, jobs) {
  const file = path.join(JOBS_DIR, `${userId}.json`);
  fs.writeFileSync(file, JSON.stringify(jobs, null, 2));
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Auth Routes ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = loadUsers();
  const key = username.toLowerCase().trim();
  if (users[key]) return res.status(409).json({ error: 'Username already taken' });

  const hashed = await bcrypt.hash(password, 12);
  const userId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  users[key] = { id: userId, username: username.trim(), password: hashed, createdAt: Date.now() };
  saveUsers(users);

  const token = jwt.sign({ id: userId, username: username.trim() }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: username.trim() });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = loadUsers();
  const key = username.toLowerCase().trim();
  const user = users[key];
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

// --- Jobs Routes ---
app.get('/api/jobs', authMiddleware, (req, res) => {
  res.json(loadUserJobs(req.user.id));
});

app.put('/api/jobs', authMiddleware, (req, res) => {
  const jobs = req.body;
  if (typeof jobs !== 'object') return res.status(400).json({ error: 'Invalid data' });
  saveUserJobs(req.user.id, jobs);
  res.json({ ok: true });
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Applied Tracker running on http://localhost:${PORT}`);
});
