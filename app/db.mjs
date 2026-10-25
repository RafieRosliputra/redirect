import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.mjs';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS links (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT NOT NULL COLLATE NOCASE UNIQUE,
    target_url      TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    created_by      TEXT NOT NULL DEFAULT '',
    clicks          INTEGER NOT NULL DEFAULT 0,
    last_clicked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS clicks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id    INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    clicked_at TEXT NOT NULL,
    referrer   TEXT NOT NULL DEFAULT '',
    country    TEXT NOT NULL DEFAULT '',
    host       TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS clicks_link_id_idx ON clicks(link_id);
  CREATE INDEX IF NOT EXISTS clicks_clicked_at_idx ON clicks(clicked_at);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_LINKS = 1000;
const CLICK_RETENTION_DAYS = 90;

export function normalizeSlug(raw, { baseDomain, reserved = [] } = {}) {
  let value = String(raw ?? '').trim().toLowerCase();
  if (!value) {
    throw new AppError('SLUG_REQUIRED', 'Masukkan nama subdomain.', 400, 'slug');
  }

  // Accept a pasted URL or full hostname, then keep only the first label.
  value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (baseDomain) {
    const suffix = `.${baseDomain.toLowerCase()}`;
    if (value === baseDomain.toLowerCase()) {
      throw new AppError('SLUG_REQUIRED', 'Apex domain tidak boleh digunakan sebagai pautan pendek.', 400, 'slug');
    }
    if (value.endsWith(suffix)) value = value.slice(0, -suffix.length);
  }

  if (value.includes('.') || value.startsWith('www.') || value.startsWith('re.')) {
    throw new AppError('SLUG_INVALID', 'Guna satu label sahaja, contoh: telegram.', 400, 'slug');
  }
  if (!SLUG_RE.test(value)) {
    throw new AppError(
      'SLUG_INVALID',
      'Subdomain mesti 1–63 aksara: huruf kecil, nombor atau sengkang, tanpa sengkang di hujung.',
      400,
      'slug',
    );
  }
  if (reserved.map((item) => String(item).toLowerCase()).includes(value)) {
    throw new AppError('SLUG_RESERVED', `Subdomain “${value}” telah digunakan oleh servis lain.`, 409, 'slug');
  }
  return value;
}

export function normalizeTarget(raw, { slug, baseDomain } = {}) {
  let value = String(raw ?? '').trim();
  if (!value) {
    throw new AppError('TARGET_REQUIRED', 'Masukkan URL destinasi.', 400, 'targetUrl');
  }
  if (/\s/.test(value)) {
    throw new AppError('TARGET_INVALID', 'URL destinasi tidak boleh mengandungi ruang.', 400, 'targetUrl');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('TARGET_INVALID', 'URL destinasi tidak sah. Contoh: https://t.me/johrostudio', 400, 'targetUrl');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('TARGET_INVALID', 'Hanya pautan http:// atau https:// dibenarkan.', 400, 'targetUrl');
  }
  if (url.username || url.password) {
    throw new AppError('TARGET_INVALID', 'URL yang mengandungi username atau password tidak dibenarkan.', 400, 'targetUrl');
  }
  if (url.href.length > 2048) {
    throw new AppError('TARGET_INVALID', 'URL destinasi terlalu panjang (maksimum 2,048 aksara).', 400, 'targetUrl');
  }
  if (slug && baseDomain && url.hostname.toLowerCase() === `${slug}.${baseDomain.toLowerCase()}`) {
    throw new AppError('TARGET_LOOP', 'URL destinasi sama dengan pautan pendek ini dan akan menyebabkan gelung.', 400, 'targetUrl');
  }
  return url.href;
}

function cleanTitle(raw) {
  const value = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (value.length > 120) {
    throw new AppError('TITLE_TOO_LONG', 'Nama pautan maksimum 120 aksara.', 400, 'title');
  }
  return value;
}

function serializeLink(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    slug: row.slug,
    targetUrl: row.target_url,
    title: row.title,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    clicks: Number(row.clicks),
    lastClickedAt: row.last_clicked_at,
  };
}

function dateKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function weekdayLabel(date, timeZone) {
  return new Intl.DateTimeFormat('ms-MY', { timeZone, weekday: 'short' }).format(date);
}

export class Store {
  constructor(dbPath, options = {}) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.baseDomain = String(options.baseDomain || 'johorstudio.com').toLowerCase();
    this.timeZone = options.timeZone || 'Asia/Kuala_Lumpur';
    this.reserved = Array.isArray(options.reserved) ? options.reserved : [];
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // Best effort; the data directory is still protected by the bind mount.
    }
    this.cleanupClicks();
    if (options.seed !== false) this.seed();
  }

  seed() {
    const alreadySeeded = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('seeded');
    if (alreadySeeded) return;
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM links').get().n;
    if (Number(count) === 0) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO links (slug, target_url, title, active, created_at, updated_at, created_by)
           VALUES (?, ?, ?, 1, ?, ?, ?)`,
        )
        .run('telegram', 'https://t.me/johrostudio', 'Telegram JohorStudio', now, now, 'setup');
    }
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('seeded', new Date().toISOString());
  }

  listLinks({ query = '', status = 'all' } = {}) {
    const where = [];
    const params = [];
    const q = String(query || '').trim();
    if (q) {
      where.push('(slug LIKE ? OR title LIKE ? OR target_url LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (status === 'active') where.push('active = 1');
    if (status === 'paused') where.push('active = 0');
    const sql = `SELECT * FROM links ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY active DESC, created_at DESC, id DESC`;
    return this.db.prepare(sql).all(...params).map(serializeLink);
  }

  getLinkById(id) {
    return serializeLink(this.db.prepare('SELECT * FROM links WHERE id = ?').get(Number(id)));
  }

  getPublicLink(slug) {
    return serializeLink(
      this.db.prepare('SELECT * FROM links WHERE slug = ? COLLATE NOCASE AND active = 1').get(String(slug)),
    );
  }

  createLink({ slug, targetUrl, title = '', actor = '' }) {
    const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM links').get().n);
    if (count >= MAX_LINKS) {
      throw new AppError('LIMIT_REACHED', `Had ${MAX_LINKS} pautan telah dicapai.`, 409);
    }
    const cleanSlug = normalizeSlug(slug, { baseDomain: this.baseDomain, reserved: this.reserved });
    const cleanTarget = normalizeTarget(targetUrl, { slug: cleanSlug, baseDomain: this.baseDomain });
    const cleanName = cleanTitle(title);
    const now = new Date().toISOString();
    try {
      const result = this.db
        .prepare(
          `INSERT INTO links (slug, target_url, title, active, created_at, updated_at, created_by)
           VALUES (?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(cleanSlug, cleanTarget, cleanName, now, now, String(actor || ''));
      return this.getLinkById(Number(result.lastInsertRowid));
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE constraint failed')) {
        throw new AppError('SLUG_TAKEN', `Subdomain “${cleanSlug}” sudah wujud.`, 409, 'slug');
      }
      throw error;
    }
  }

  updateLink(id, { slug, targetUrl, title = '', active = true }) {
    const existing = this.getLinkById(id);
    if (!existing) throw new AppError('NOT_FOUND', 'Pautan tidak dijumpai.', 404);
    const cleanSlug = normalizeSlug(slug, { baseDomain: this.baseDomain, reserved: this.reserved });
    const cleanTarget = normalizeTarget(targetUrl, { slug: cleanSlug, baseDomain: this.baseDomain });
    const cleanName = cleanTitle(title);
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `UPDATE links
              SET slug = ?, target_url = ?, title = ?, active = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(cleanSlug, cleanTarget, cleanName, active ? 1 : 0, now, Number(id));
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE constraint failed')) {
        throw new AppError('SLUG_TAKEN', `Subdomain “${cleanSlug}” sudah wujud.`, 409, 'slug');
      }
      throw error;
    }
    return this.getLinkById(id);
  }

  deleteLink(id) {
    const result = this.db.prepare('DELETE FROM links WHERE id = ?').run(Number(id));
    if (Number(result.changes) === 0) throw new AppError('NOT_FOUND', 'Pautan tidak dijumpai.', 404);
    return true;
  }

  recordClick(id, { referrer = '', country = '', host = '' } = {}) {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare('UPDATE links SET clicks = clicks + 1, last_clicked_at = ? WHERE id = ? AND active = 1')
        .run(now, Number(id));
      if (Number(result.changes) === 0) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db
        .prepare('INSERT INTO clicks (link_id, clicked_at, referrer, country, host) VALUES (?, ?, ?, ?, ?)')
        .run(Number(id), now, String(referrer).slice(0, 500), String(country).toUpperCase().slice(0, 8), String(host).slice(0, 255));
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors.
      }
      throw error;
    }
  }

  getOverview() {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS links,
                COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active,
                COALESCE(SUM(clicks), 0) AS clicks
           FROM links`,
      )
      .get();

    const now = new Date();
    const sinceIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentClicks = this.db
      .prepare('SELECT clicked_at FROM clicks WHERE clicked_at >= ? ORDER BY clicked_at DESC')
      .all(sinceIso);

    const buckets = [];
    const bucketByKey = new Map();
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
      const key = dateKey(date, this.timeZone);
      const bucket = { date: key, label: weekdayLabel(date, this.timeZone), count: 0 };
      buckets.push(bucket);
      bucketByKey.set(key, bucket);
    }
    for (const click of recentClicks) {
      const key = dateKey(new Date(click.clicked_at), this.timeZone);
      const bucket = bucketByKey.get(key);
      if (bucket) bucket.count += 1;
    }

    const clicks7d = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    const recentRows = this.db
      .prepare(
        `SELECT c.clicked_at, c.country, c.referrer, l.slug, l.target_url, l.title
           FROM clicks c JOIN links l ON l.id = c.link_id
          ORDER BY c.id DESC LIMIT 8`,
      )
      .all();

    return {
      totals: {
        links: Number(totals.links),
        active: Number(totals.active),
        clicks: Number(totals.clicks),
        clicks7d,
      },
      daily: buckets,
      recent: recentRows.map((row) => {
        let referrerHost = '';
        try {
          referrerHost = row.referrer ? new URL(row.referrer).hostname : '';
        } catch {
          referrerHost = '';
        }
        return {
          clickedAt: row.clicked_at,
          country: row.country,
          referrerHost,
          slug: row.slug,
          targetUrl: row.target_url,
          title: row.title,
        };
      }),
    };
  }

  cleanupClicks() {
    const cutoff = new Date(Date.now() - CLICK_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM clicks WHERE clicked_at < ?').run(cutoff);
  }

  close() {
    this.db.close();
  }
}
