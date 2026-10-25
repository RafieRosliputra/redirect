import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AccessVerifier } from '../auth.mjs';

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeToken({ privateKey, teamDomain, audience, email, expiresIn = 300 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-key', typ: 'JWT' };
  const payload = {
    iss: teamDomain,
    aud: audience,
    email,
    sub: 'user-1',
    iat: now,
    exp: now + expiresIn,
  };
  const signed = `${encode(header)}.${encode(payload)}`;
  const signature = sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url');
  return `${signed}.${signature}`;
}

async function setup() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const server = http.createServer((req, res) => {
    if (req.url === '/cdn-cgi/access/certs') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const teamDomain = `http://127.0.0.1:${server.address().port}`;
  return { server, privateKey, teamDomain };
}

test('AccessVerifier validates a signed JWT and enforces the email allowlist', async (t) => {
  const { server, privateKey, teamDomain } = await setup();
  t.after(() => server.close());
  const verifier = new AccessVerifier({
    mode: 'access',
    teamDomain,
    audience: 'aud-123',
    allowedEmails: 'rafierosliputra@gmail.com',
  });
  const token = makeToken({
    privateKey,
    teamDomain,
    audience: 'aud-123',
    email: 'rafierosliputra@gmail.com',
  });
  const viewer = await verifier.getViewer({ headers: { 'cf-access-jwt-assertion': token } });
  assert.equal(viewer.email, 'rafierosliputra@gmail.com');
  assert.equal(viewer.logoutUrl, `${teamDomain}/cdn-cgi/access/logout`);

  const wrongEmail = makeToken({
    privateKey,
    teamDomain,
    audience: 'aud-123',
    email: 'someone@example.com',
  });
  await assert.rejects(
    () => verifier.getViewer({ headers: { 'cf-access-jwt-assertion': wrongEmail } }),
    /tidak dibenarkan/,
  );

  const wrongAudience = makeToken({
    privateKey,
    teamDomain,
    audience: 'other-aud',
    email: 'rafierosliputra@gmail.com',
  });
  await assert.rejects(
    () => verifier.getViewer({ headers: { 'cf-access-jwt-assertion': wrongAudience } }),
    /tidak sah/,
  );

  const expired = makeToken({
    privateKey,
    teamDomain,
    audience: 'aud-123',
    email: 'rafierosliputra@gmail.com',
    expiresIn: -120,
  });
  await assert.rejects(
    () => verifier.getViewer({ headers: { 'cf-access-jwt-assertion': expired } }),
    /tamat/,
  );

  const tampered = `${token.slice(0, -4)}abcd`;
  await assert.rejects(
    () => verifier.getViewer({ headers: { 'cf-access-jwt-assertion': tampered } }),
    /tidak sah/,
  );

  await assert.rejects(() => verifier.getViewer({ headers: {} }), /log masuk/);
});

test('AccessVerifier fails closed when the configuration is incomplete', async () => {
  const verifier = new AccessVerifier({ mode: 'access', teamDomain: '', audience: '', allowedEmails: '' });
  await assert.rejects(
    () => verifier.getViewer({ headers: { 'cf-access-jwt-assertion': 'a.b.c' } }),
    /belum dikonfigurasikan/,
  );
});
