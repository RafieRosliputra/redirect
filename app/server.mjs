import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AccessVerifier } from './auth.mjs';
import { AppError } from './errors.mjs';
import { Store } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : String(value);
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const baseDomain = env('BASE_DOMAIN', 'johorstudio.com').toLowerCase().replace(/^\.+|\.+$/g, '');
const adminHosts = list(env('ADMIN_HOST', `re.${baseDomain}`));
const port = Number(env('PORT', '8080'));
const host = env('HOST', '0.0.0.0');
const config = {
  baseDomain,
  adminHosts,
  adminOrigin: env('PUBLIC_ADMIN_ORIGIN', `https://${adminHosts[0] || `re.${baseDomain}`}`).replace(/\/+$/, ''),
  authMode: env('AUTH_MODE', 'access').toLowerCase(),
  timeZone: env('TIMEZONE', 'Asia/Kuala_Lumpur'),
  dbPath: env('DB_PATH', '/data/redirect.db'),
  version: env('APP_VERSION', '1.0.0'),
  reserved: list(
    env(
      'RESERVED_SLUGS',
      [
        'www',
        're',
        'shop',
        'mail',
        'tele',
        'ana',
        'nextcloud',
        'photos',
        'files',
        'cloud',
        'apps',
        'api',
        'admin',
        'order',
        'umami',
        'calendar',
        'ftp',
        'smtp',
      ].join(','),
    ),
  ),
};

const access = new AccessVerifier({
  mode: config.authMode,
  teamDomain: env('CF_ACCESS_TEAM_DOMAIN'),
  audience: env('CF_ACCESS_AUD'),
  allowedEmails: env('ALLOWED_EMAILS', 'rafierosliputra@gmail.com'),
  devEmail: env('DEV_AUTH_EMAIL', 'rafierosliputra@gmail.com'),
});

const store = new Store(config.dbPath, {
  baseDomain: config.baseDomain,
  timeZone: config.timeZone,
  reserved: config.reserved,
  seed: env('SEED_DEMO', 'true') !== 'false',
});

const assetFiles = {
  '/assets/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/assets/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/assets/archivo-var.woff2': { file: 'assets/archivo-var.woff2', type: 'font/woff2' },
  '/assets/logo-dark.png': { file: 'assets/logo-dark.png', type: 'image/png' },
  '/assets/favicon.png': { file: 'assets/favicon.png', type: 'image/png' },
};

const assets = new Map(
  Object.entries(assetFiles).map(([route, meta]) => [
    route,
    { ...meta, body: readFileSync(path.join(publicDir, meta.file)) },
  ]),
);

const indexHtml = readFileSync(path.join(publicDir, 'index.html'));
const notFoundHtml = readFileSync(path.join(publicDir, 'not-found.html'));
const errorTemplate = readFileSync(path.join(publicDir, 'error.html'), 'utf8');

const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function applyHeaders(res, headers = {}) {
  for (const [key, value] of Object.entries(COMMON_HEADERS)) res.setHeader(key, value);
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  if (res.req?.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
}

function send(res, status, body, headers = {}) {
  applyHeaders(res, headers);
  res.statusCode = status;
  if (Buffer.isBuffer(body)) {
    res.end(body);
  } else {
    res.end(String(body));
  }
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  send(res, status, body, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function sendHtml(res, status, body, headers = {}) {
  send(res, status, body, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function renderErrorPage({ code, title, message, actionUrl = 'https://johorstudio.com', actionLabel = 'Kembali ke johorstudio.com' }) {
  return errorTemplate
    .replaceAll('{{CODE}}', escapeHtml(code))
    .replaceAll('{{TITLE}}', escapeHtml(title))
    .replaceAll('{{MESSAGE}}', escapeHtml(message))
    .replaceAll('{{ACTION_URL}}', escapeHtml(actionUrl))
    .replaceAll('{{ACTION_LABEL}}', escapeHtml(actionLabel));
}

function sendErrorPage(res, status, options) {
  sendHtml(res, status, renderErrorPage(options));
}

function sendApiError(res, error) {
  const status = error instanceof AppError ? error.status : 500;
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  const message =
    error instanceof AppError ? error.message : 'Ralat dalaman. Sila cuba sebentar lagi.';
  sendJson(res, status, { error: { code, message, field: error instanceof AppError ? error.field : null } });
}

function getHostname(req) {
  const raw = String(req.headers.host || '').trim();
  if (!raw || raw.length > 255) return '';
  try {
    const url = new URL(`http://${raw}`);
    if (!url.hostname || url.username || url.password) return '';
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function getPathname(req) {
  try {
    return new URL(req.url || '/', 'http://app.local').pathname;
  } catch {
    return '/';
  }
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Gunakan Content-Type: application/json.', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new AppError('BODY_TOO_LARGE', 'Permintaan terlalu besar.', 413);
    chunks.push(chunk);
  }
  if (size === 0) throw new AppError('BODY_REQUIRED', 'Permintaan kosong.', 400);
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new AppError('INVALID_JSON', 'JSON tidak sah.', 400);
  }
}

function checkOrigin(req) {
  if (config.authMode !== 'access') return;
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return;
  if (origin.replace(/\/+$/, '') !== config.adminOrigin) {
    throw new AppError('INVALID_ORIGIN', 'Permintaan dari asal yang tidak dibenarkan.', 403);
  }
}

function publicLink(link) {
  return {
    ...link,
    shortUrl: `https://${link.slug}.${config.baseDomain}`,
    displayTitle: link.title || link.slug,
  };
}

function formatLink(link) {
  return link ? publicLink(link) : null;
}

async function handleApi(req, res, pathname, viewer) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
    throw new AppError('METHOD_NOT_ALLOWED', 'Kaedah tidak dibenarkan.', 405);
  }
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') checkOrigin(req);

  if (pathname === '/api/me' && (method === 'GET' || method === 'HEAD')) {
    return sendJson(res, 200, {
      email: viewer.email,
      mode: viewer.mode,
      logoutUrl: viewer.logoutUrl,
      baseDomain: config.baseDomain,
      adminHost: config.adminHosts[0],
      version: config.version,
      accessProtected: viewer.mode === 'access',
    });
  }

  if (pathname === '/api/links' && (method === 'GET' || method === 'HEAD')) {
    const url = new URL(req.url || '/', 'http://app.local');
    const links = store.listLinks({
      query: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || 'all',
    });
    return sendJson(res, 200, {
      links: links.map(formatLink),
      overview: store.getOverview(),
      baseDomain: config.baseDomain,
    });
  }

  if (pathname === '/api/links' && method === 'POST') {
    const body = await readJson(req);
    const link = store.createLink({
      slug: body.slug,
      targetUrl: body.targetUrl,
      title: body.title,
      actor: viewer.email,
    });
    return sendJson(res, 201, { link: formatLink(link) });
  }

  const match = pathname.match(/^\/api\/links\/(\d+)$/);
  if (match && method === 'PATCH') {
    const body = await readJson(req);
    const existing = store.getLinkById(Number(match[1]));
    if (!existing) throw new AppError('NOT_FOUND', 'Pautan tidak dijumpai.', 404);
    const link = store.updateLink(Number(match[1]), {
      slug: body.slug ?? existing.slug,
      targetUrl: body.targetUrl ?? existing.targetUrl,
      title: body.title ?? existing.title,
      active: typeof body.active === 'boolean' ? body.active : existing.active,
    });
    return sendJson(res, 200, { link: formatLink(link) });
  }

  if (match && method === 'DELETE') {
    store.deleteLink(Number(match[1]));
    return sendJson(res, 200, { ok: true });
  }

  throw new AppError('NOT_FOUND', 'Endpoint tidak dijumpai.', 404);
}

async function serveAdmin(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
      // Authentication happens before routing, so API calls are rejected earlier.
    }
    throw new AppError('METHOD_NOT_ALLOWED', 'Kaedah tidak dibenarkan.', 405);
  }

  if (pathname === '/api/me' || pathname.startsWith('/api/')) {
    throw new AppError('NOT_FOUND', 'Endpoint tidak dijumpai.', 404);
  }

  if (pathname === '/' || pathname === '/index.html') {
    return send(res, 200, indexHtml, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': indexHtml.length,
      'Cache-Control': 'no-store',
    });
  }

  throw new AppError('NOT_FOUND', 'Halaman tidak dijumpai.', 404);
}

async function handleRequest(req, res) {
  const pathname = getPathname(req);
  const host = getHostname(req);

  if (!host) {
    return sendErrorPage(res, 400, {
      code: '400',
      title: 'Permintaan tidak sah',
      message: 'Host header tidak sah.',
    });
  }

  if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
    return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  const asset = assets.get(pathname);
  if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
    return send(res, 200, asset.body, {
      'Content-Type': asset.type,
      'Content-Length': asset.body.length,
      'Cache-Control': 'public, max-age=86400',
    });
  }

  const isAdminHost = config.adminHosts.includes(host);
  if (isAdminHost) {
    let viewer;
    try {
      viewer = await access.getViewer(req);
    } catch (error) {
      if (pathname.startsWith('/api/')) return sendApiError(res, error);
      const status = error instanceof AppError ? error.status : 500;
      const message =
        error instanceof AppError
          ? error.message
          : 'Pengesahan Cloudflare Access gagal. Sila muat semula halaman.';
      return sendErrorPage(res, status, {
        code: String(status),
        title: status === 503 ? 'Admin belum siap' : 'Akses diperlukan',
        message,
        actionUrl: access.logoutUrl || 'https://johorstudio.com',
        actionLabel: access.logoutUrl ? 'Log keluar' : 'Kembali ke johorstudio.com',
      });
    }

    if (pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, res, pathname, viewer);
      } catch (error) {
        if (!(error instanceof AppError) || error.status >= 500) console.error(error);
        return sendApiError(res, error);
      }
    }

    try {
      return await serveAdmin(req, res, pathname);
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) console.error(error);
      return sendErrorPage(res, error.status || 500, {
        code: String(error.status || 500),
        title: 'Halaman tidak dijumpai',
        message: error instanceof AppError ? error.message : 'Ralat dalaman.',
      });
    }
  }

  const suffix = `.${config.baseDomain}`;
  if (!host.endsWith(suffix)) {
    return sendHtml(res, 404, notFoundHtml);
  }

  const slug = host.slice(0, -suffix.length);
  if (!slug || slug.includes('.')) {
    return sendHtml(res, 404, notFoundHtml);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendErrorPage(res, 405, {
      code: '405',
      title: 'Kaedah tidak dibenarkan',
      message: 'Pautan pendek hanya boleh dibuka melalui GET.',
    });
  }

  const link = store.getPublicLink(slug);
  if (!link) return sendHtml(res, 404, notFoundHtml);

  if (req.method === 'GET') {
    try {
      store.recordClick(link.id, {
        referrer: req.headers.referer || '',
        country: req.headers['cf-ipcountry'] || '',
        host,
      });
    } catch (error) {
      console.error('Gagal merekod klik:', error);
    }
  }

  res.writeHead(302, {
    ...COMMON_HEADERS,
    Location: link.targetUrl,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  res.end();
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const pathname = getPathname(req);
  handleRequest(req, res)
    .catch((error) => {
      console.error(error);
      if (!res.headersSent) {
        if (pathname.startsWith('/api/')) sendApiError(res, error);
        else {
          sendErrorPage(res, 500, {
            code: '500',
            title: 'Ralat dalaman',
            message: 'Sesuatu tidak kena. Sila cuba lagi.',
          });
        }
      } else {
        res.end();
      }
    })
    .finally(() => {
      console.log(`${req.method} ${getHostname(req)}${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.listen(port, host, () => {
  console.log(`JohorStudio Redirect listening on http://${host}:${port}`);
  console.log(
    `Domain: *.${config.baseDomain} | Admin: ${config.adminHosts.join(', ')} | Auth: ${config.authMode} | DB: ${config.dbPath}`,
  );
  if (!access.isConfigured()) {
    console.warn('AMARAN: Cloudflare Access belum lengkap dikonfigurasikan. Admin akan pulangkan 503.');
  }
  if (config.authMode === 'dev') {
    console.warn('AMARAN: AUTH_MODE=dev aktif. Jangan gunakan mod ini untuk production.');
  }
});

const cleanupTimer = setInterval(() => {
  try {
    store.cleanupClicks();
  } catch (error) {
    console.error('Pembersihan klik gagal:', error);
  }
}, 24 * 60 * 60 * 1000);
cleanupTimer.unref();

function shutdown(signal) {
  console.log(`${signal} diterima, menutup server...`);
  server.close(() => {
    try {
      store.close();
    } catch {
      // Ignore close errors.
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
