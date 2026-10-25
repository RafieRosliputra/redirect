import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function request({ port, method = 'GET', path: requestPath = '/', host = '127.0.0.1', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: { Host: host, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await request({ port, path: '/healthz' });
      if (response.status === 200) return;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become ready');
}

test('HTTP app serves admin, creates links and redirects public hosts', async (t) => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'redirect-server-'));
  let logs = '';
  const child = spawn(process.execPath, ['app/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BASE_DOMAIN: 'johorstudio.com',
      ADMIN_HOST: '127.0.0.1',
      AUTH_MODE: 'dev',
      DB_PATH: path.join(dir, 'test.db'),
      TIMEZONE: 'Asia/Kuala_Lumpur',
      SEED_DEMO: 'true',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    rmSync(dir, { recursive: true, force: true });
  });

  await waitForServer(port);

  const admin = await request({ port, path: '/' });
  assert.equal(admin.status, 200);
  assert.match(admin.body, /Pautan pendek/);
  assert.match(admin.headers['content-security-policy'], /default-src 'self'/);

  const apiMe = await request({ port, path: '/api/me' });
  assert.equal(apiMe.status, 200);
  assert.equal(JSON.parse(apiMe.body).email, 'rafierosliputra@gmail.com');

  const created = await request({
    port,
    method: 'POST',
    path: '/api/links',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'promo', title: 'Promo', targetUrl: 'johorstudio.com/raya.html' }),
  });
  assert.equal(created.status, 201, created.body);
  const link = JSON.parse(created.body).link;
  assert.equal(link.shortUrl, 'https://promo.johorstudio.com');

  const redirect = await request({ port, path: '/', host: 'promo.johorstudio.com' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, 'https://johorstudio.com/raya.html');

  const unknown = await request({ port, path: '/', host: 'tiada.johorstudio.com' });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body, /belum wujud/);

  const pause = await request({
    port,
    method: 'PATCH',
    path: `/api/links/${link.id}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: false }),
  });
  assert.equal(pause.status, 200, pause.body);
  assert.equal(JSON.parse(pause.body).link.active, false);

  const paused = await request({ port, path: '/', host: 'promo.johorstudio.com' });
  assert.equal(paused.status, 404);

  const duplicate = await request({
    port,
    method: 'POST',
    path: '/api/links',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'telegram', targetUrl: 'https://example.com' }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(JSON.parse(duplicate.body).error.code, 'SLUG_TAKEN');

  assert.match(logs, /listening/);
});
