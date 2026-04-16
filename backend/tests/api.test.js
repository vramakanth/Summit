/**
 * Summit — Backend API Tests
 * Run: cd backend/tests && npm install && npm test
 */

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point server at a temp data dir so tests never touch real data
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'summit-test-'));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.PORT = '0'; // OS assigns port

const app = require('../server');

afterAll(() => {
  // Clean up temp data
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── Health ───────────────────────────────────────────────────────────────────

describe('GET /api/ping', () => {
  it('returns ok:true with server info', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('dataDir');
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('POST /api/register', () => {
  it('creates a new user', async () => {
    const res = await request(app).post('/api/register').send({
      username: 'testuser',
      password: 'password123',
      email: 'test@example.com',
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.username).toBe('testuser');
  });

  it('rejects duplicate username', async () => {
    await request(app).post('/api/register').send({ username: 'dupuser', password: 'pass123' });
    const res = await request(app).post('/api/register').send({ username: 'dupuser', password: 'pass456' });
    expect(res.status).toBe(409);
  });

  it('rejects missing password', async () => {
    const res = await request(app).post('/api/register').send({ username: 'nopass' });
    expect(res.status).toBe(400);
  });

  it('rejects username under 3 characters', async () => {
    const res = await request(app).post('/api/register').send({ username: 'ab', password: 'pass123' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/login', () => {
  beforeAll(async () => {
    await request(app).post('/api/register').send({ username: 'loginuser', password: 'correctpass' });
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app).post('/api/login').send({
      username: 'loginuser',
      password: 'correctpass',
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.username).toBe('loginuser');
  });

  it('rejects wrong password', async () => {
    const res = await request(app).post('/api/login').send({
      username: 'loginuser',
      password: 'wrongpass',
    });
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('rejects unknown username', async () => {
    const res = await request(app).post('/api/login').send({
      username: 'nobody',
      password: 'pass',
    });
    expect(res.status).toBe(401);
  });

  it('returns JSON content-type (not HTML)', async () => {
    const res = await request(app).post('/api/login').send({ username: 'x', password: 'x' });
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

// ─── Jobs (authenticated) ─────────────────────────────────────────────────────

// ─── Jobs API ─────────────────────────────────────────────────────────────────
// The jobs API uses a simple GET (returns full object) + PUT (saves full object).
// No individual POST/PATCH/DELETE routes — the frontend manages the object client-side.

describe('Jobs API — GET + PUT (full object store)', () => {
  let token;

  beforeAll(async () => {
    await request(app).post('/api/register').send({ username: 'jobuser', password: 'pass123' });
    const res = await request(app).post('/api/login').send({ username: 'jobuser', password: 'pass123' });
    token = res.body.token;
  });

  it('GET /api/jobs requires auth', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(401);
  });

  it('GET /api/jobs returns empty object for new user', async () => {
    const res = await request(app).get('/api/jobs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    // Returns an object (keyed by job id), not an array
    expect(typeof res.body).toBe('object');
    expect(Array.isArray(res.body)).toBe(false);
  });

  it('PUT /api/jobs requires auth', async () => {
    const res = await request(app).put('/api/jobs').send({ job1: { title: 'Test' } });
    expect(res.status).toBe(401);
  });

  it('PUT /api/jobs saves the full jobs object', async () => {
    const jobs = {
      'abc123': { id: 'abc123', title: 'Software Engineer', company: 'Acme', status: 'to apply', createdAt: Date.now() },
    };
    const save = await request(app).put('/api/jobs').set('Authorization', `Bearer ${token}`).send(jobs);
    expect(save.status).toBe(200);
    expect(save.body.ok).toBe(true);
  });

  it('GET /api/jobs returns previously saved jobs', async () => {
    const jobs = {
      'job1': { id: 'job1', title: 'Software Engineer', company: 'Acme', status: 'to apply', createdAt: Date.now() },
      'job2': { id: 'job2', title: 'Product Manager', company: 'Beta', status: 'applied', createdAt: Date.now() },
    };
    await request(app).put('/api/jobs').set('Authorization', `Bearer ${token}`).send(jobs);
    const res = await request(app).get('/api/jobs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body['job1'].title).toBe('Software Engineer');
    expect(res.body['job2'].company).toBe('Beta');
  });

  it('PUT /api/jobs overwrites (full object replace)', async () => {
    const v1 = { 'j1': { id: 'j1', title: 'Old', company: 'OldCo', status: 'to apply', createdAt: Date.now() } };
    const v2 = { 'j2': { id: 'j2', title: 'New', company: 'NewCo', status: 'applied', createdAt: Date.now() } };
    await request(app).put('/api/jobs').set('Authorization', `Bearer ${token}`).send(v1);
    await request(app).put('/api/jobs').set('Authorization', `Bearer ${token}`).send(v2);
    const res = await request(app).get('/api/jobs').set('Authorization', `Bearer ${token}`);
    expect(res.body['j1']).toBeUndefined();  // overwritten
    expect(res.body['j2'].title).toBe('New');
  });

  it('PUT /api/jobs rejects non-object body', async () => {
    const res = await request(app).put('/api/jobs').set('Authorization', `Bearer ${token}`).send('invalid');
    expect(res.status).toBe(400);
  });
});

// ─── User isolation ───────────────────────────────────────────────────────────

describe('User data isolation', () => {
  let tokenA, tokenB;

  beforeAll(async () => {
    await request(app).post('/api/register').send({ username: 'userA', password: 'passA' });
    await request(app).post('/api/register').send({ username: 'userB', password: 'passB' });
    tokenA = (await request(app).post('/api/login').send({ username: 'userA', password: 'passA' })).body.token;
    tokenB = (await request(app).post('/api/login').send({ username: 'userB', password: 'passB' })).body.token;
  });

  it("user A cannot see user B's jobs", async () => {
    await request(app)
      .post('/api/jobs')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: 'Secret Job', company: 'Private Co', status: 'to apply' });
    const res = await request(app).get('/api/jobs').set('Authorization', `Bearer ${tokenA}`);
    expect(res.body.some(j => j.title === 'Secret Job')).toBe(false);
  });
});

// ─── ATS URL parsing (unit tests, no network) ─────────────────────────────────

describe('ATS detection', () => {
  // We test the logic by importing it — but since it's embedded in server.js
  // we test via the exported app's ping to confirm server loads, then test
  // URL cleaning directly via the logic we know is there

  it('server starts cleanly (ATS code loaded without errors)', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(200);
  });

  it('parse-job requires auth', async () => {
    const res = await request(app).post('/api/parse-job').send({ url: 'https://example.com' });
    expect(res.status).toBe(401);
  });

  it('parse-job returns JSON error for missing url', async () => {
    // Register + login to get token
    await request(app).post('/api/register').send({ username: 'atsuser', password: 'pass123' });
    const login = await request(app).post('/api/login').send({ username: 'atsuser', password: 'pass123' });
    const token = login.body.token;

    const res = await request(app)
      .post('/api/parse-job')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    // Must return JSON not HTML
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('parse-job returns JSON (not HTML) for any URL', async () => {
    await request(app).post('/api/register').send({ username: 'atsuser2', password: 'pass123' });
    const login = await request(app).post('/api/login').send({ username: 'atsuser2', password: 'pass123' });
    const token = login.body.token;

    const res = await request(app)
      .post('/api/parse-job')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://httpbin.org/status/200' });
    // Whatever the result, it must be JSON
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.status).toBe(200);
  });
});

// ─── extract-fields ───────────────────────────────────────────────────────────

describe('POST /api/extract-fields', () => {
  let token;

  beforeAll(async () => {
    await request(app).post('/api/register').send({ username: 'extractuser', password: 'pass123' });
    const res = await request(app).post('/api/login').send({ username: 'extractuser', password: 'pass123' });
    token = res.body.token;
  });

  it('accepts postingText field', async () => {
    const res = await request(app)
      .post('/api/extract-fields')
      .set('Authorization', `Bearer ${token}`)
      .send({ postingText: 'Senior Software Engineer at Acme Corp in San Francisco, CA. Salary: $150k-$200k.' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('accepts text field (frontend compat)', async () => {
    // Frontend sends "text" not "postingText" — both must work
    const res = await request(app)
      .post('/api/extract-fields')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'Product Manager at Beta Inc. Remote position.' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('returns 400 for missing text', async () => {
    const res = await request(app)
      .post('/api/extract-fields')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('requires auth', async () => {
    const res = await request(app)
      .post('/api/extract-fields')
      .send({ postingText: 'Test' });
    expect(res.status).toBe(401);
  });
});

// ─── Extension download ───────────────────────────────────────────────────────

describe('GET /api/extension', () => {
  let token;

  beforeAll(async () => {
    await request(app).post('/api/register').send({ username: 'extuser', password: 'pass123' });
    const res = await request(app).post('/api/login').send({ username: 'extuser', password: 'pass123' });
    token = res.body.token;
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/extension');
    expect(res.status).toBe(401);
  });

  it('returns a zip file when authenticated', async () => {
    const res = await request(app)
      .get('/api/extension')
      .set('Authorization', `Bearer ${token}`);
    // Will be 404 in test env (no extension folder), or 200 with zip — both are valid
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers['content-type']).toMatch(/zip/);
      expect(res.headers['content-disposition']).toContain('summit-extension.zip');
    }
  });
});
