import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { AppError } from './errors.mjs';

const CLOCK_SKEW_SECONDS = 30;
const JWKS_TTL_MS = 10 * 60 * 1000;

function normalizeTeamDomain(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function parseAllowedEmails(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function getCookie(req, name) {
  const cookie = String(req.headers.cookie || '');
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return '';
}

function getToken(req) {
  const header = req.headers['cf-access-jwt-assertion'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return getCookie(req, 'CF_Authorization');
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function isAudienceMatch(audience, expected) {
  if (Array.isArray(audience)) return audience.map(String).includes(expected);
  return String(audience) === expected;
}

export class AccessVerifier {
  constructor({ mode = 'access', teamDomain = '', audience = '', allowedEmails = '', devEmail = 'dev@localhost' } = {}) {
    this.mode = mode;
    this.teamDomain = normalizeTeamDomain(teamDomain);
    this.audience = String(audience || '').trim();
    this.allowedEmails = parseAllowedEmails(allowedEmails);
    this.devEmail = devEmail;
    this.jwksCache = null;
    this.jwksFetchedAt = 0;
    this.jwksPromise = null;

    if (this.mode !== 'dev' && this.mode !== 'access') {
      throw new Error(`AUTH_MODE tidak sah: ${this.mode}`);
    }
  }

  isConfigured() {
    return this.mode === 'dev' || Boolean(this.teamDomain && this.audience && this.allowedEmails.size);
  }

  get logoutUrl() {
    if (!this.teamDomain) return '';
    return `${this.teamDomain}/cdn-cgi/access/logout`;
  }

  async getViewer(req) {
    if (this.mode === 'dev') {
      return { email: this.devEmail, mode: 'dev', logoutUrl: '' };
    }
    if (!this.isConfigured()) {
      throw new AppError(
        'ACCESS_NOT_CONFIGURED',
        'Cloudflare Access belum dikonfigurasikan untuk aplikasi ini.',
        503,
      );
    }

    const token = getToken(req);
    if (!token) {
      throw new AppError('ACCESS_REQUIRED', 'Sila log masuk melalui Cloudflare Access.', 403);
    }

    const payload = await this.verify(token);
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email || !this.allowedEmails.has(email)) {
      throw new AppError('ACCESS_DENIED', 'Emel ini tidak dibenarkan mengakses halaman admin.', 403);
    }
    return { email, mode: 'access', logoutUrl: this.logoutUrl };
  }

  async verify(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new AppError('ACCESS_INVALID', 'Token akses tidak sah.', 403);

    let header;
    let payload;
    try {
      header = decodeSegment(parts[0]);
      payload = decodeSegment(parts[1]);
    } catch {
      throw new AppError('ACCESS_INVALID', 'Token akses tidak sah.', 403);
    }

    if (header.alg !== 'RS256' || !header.kid) {
      throw new AppError('ACCESS_INVALID', 'Token akses tidak sah.', 403);
    }
    if (payload.iss !== this.teamDomain || !isAudienceMatch(payload.aud, this.audience)) {
      throw new AppError('ACCESS_INVALID', 'Token akses tidak sah.', 403);
    }

    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp < now - CLOCK_SKEW_SECONDS) {
      throw new AppError('ACCESS_EXPIRED', 'Sesi Cloudflare Access telah tamat. Sila muat semula.', 403);
    }
    if (payload.nbf && payload.nbf > now + CLOCK_SKEW_SECONDS) {
      throw new AppError('ACCESS_INVALID', 'Token akses tidak sah.', 403);
    }
    if (payload.iat && payload.iat > now + CLOCK_SKEW_SECONDS) {
      throw new AppError('ACCESS_INVALID', 'Token akses tidak sah.', 403);
    }

    const keys = await this.getKeys(false);
    let jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
      const refreshed = await this.getKeys(true);
      jwk = refreshed.find((key) => key.kid === header.kid);
    }
    if (!jwk) throw new AppError('ACCESS_INVALID', 'Kunci tandatangan Access tidak dijumpai.', 403);

    let publicKey;
    try {
      publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    } catch {
      throw new AppError('ACCESS_INVALID', 'Kunci tandatangan Access tidak sah.', 403);
    }

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    if (!verifySignature('RSA-SHA256', signed, publicKey, signature)) {
      throw new AppError('ACCESS_INVALID', 'Tandatangan token akses tidak sah.', 403);
    }

    return payload;
  }

  async getKeys(force) {
    const fresh = Date.now() - this.jwksFetchedAt < JWKS_TTL_MS;
    if (!force && this.jwksCache && fresh) return this.jwksCache;
    if (this.jwksPromise) return this.jwksPromise;

    this.jwksPromise = (async () => {
      let response;
      try {
        response = await fetch(`${this.teamDomain}/cdn-cgi/access/certs`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(6000),
        });
      } catch {
        throw new AppError('ACCESS_JWKS_FAILED', 'Tidak dapat menghubungi Cloudflare Access.', 503);
      }
      if (!response.ok) {
        throw new AppError('ACCESS_JWKS_FAILED', 'Kunci Cloudflare Access tidak dapat dimuatkan.', 503);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new AppError('ACCESS_JWKS_FAILED', 'Respons Cloudflare Access tidak sah.', 503);
      }
      if (!Array.isArray(body.keys)) {
        throw new AppError('ACCESS_JWKS_FAILED', 'Kunci Cloudflare Access tidak sah.', 503);
      }
      this.jwksCache = body.keys.filter((key) => key && key.kty === 'RSA' && key.kid);
      this.jwksFetchedAt = Date.now();
      return this.jwksCache;
    })();

    try {
      return await this.jwksPromise;
    } finally {
      this.jwksPromise = null;
    }
  }
}

export { parseAllowedEmails };
