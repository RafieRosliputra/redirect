import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, normalizeSlug, normalizeTarget } from '../db.mjs';

function makeStore(seed = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'redirect-db-'));
  const store = new Store(path.join(dir, 'test.db'), {
    baseDomain: 'johorstudio.com',
    reserved: ['www', 're', 'shop'],
    seed,
  });
  return {
    store,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('normalizeSlug accepts names, pasted hosts and URLs', () => {
  const options = { baseDomain: 'johorstudio.com', reserved: ['www', 're'] };
  assert.equal(normalizeSlug('Telegram', options), 'telegram');
  assert.equal(normalizeSlug(' https://promo.johorstudio.com/raya ', options), 'promo');
  assert.equal(normalizeSlug('promo.johorstudio.com', options), 'promo');
  assert.throws(() => normalizeSlug('www', options), /servis lain/);
  assert.throws(() => normalizeSlug('two.parts', options), /satu label/);
  assert.throws(() => normalizeSlug('bad_slug', options), /huruf kecil/);
  assert.throws(() => normalizeSlug('-bad', options), /huruf kecil/);
  assert.throws(() => normalizeSlug('', options), /Masukkan/);
});

test('normalizeTarget normalises URLs and blocks unsafe targets', () => {
  assert.equal(normalizeTarget('t.me/johrostudio'), 'https://t.me/johrostudio');
  assert.equal(
    normalizeTarget('https://johorstudio.com/raya.html?a=1', { slug: 'raya', baseDomain: 'johorstudio.com' }),
    'https://johorstudio.com/raya.html?a=1',
  );
  assert.throws(() => normalizeTarget('javascript:alert(1)'), /tidak sah/);
  assert.throws(() => normalizeTarget('ftp://example.com/file'), /http/);
  assert.throws(() => normalizeTarget('https://user:pass@example.com/'), /username/);
  assert.throws(
    () => normalizeTarget('https://raya.johorstudio.com/', { slug: 'raya', baseDomain: 'johorstudio.com' }),
    /gelung/,
  );
  assert.throws(() => normalizeTarget(''), /Masukkan/);
});

test('store seeds telegram exactly once', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'redirect-seed-'));
  const dbPath = path.join(dir, 'test.db');
  const store = new Store(dbPath, { baseDomain: 'johorstudio.com', seed: true });
  assert.equal(store.listLinks().length, 1);
  assert.equal(store.listLinks()[0].slug, 'telegram');
  store.deleteLink(store.listLinks()[0].id);
  store.close();

  const reopened = new Store(dbPath, { baseDomain: 'johorstudio.com', seed: true });
  assert.equal(reopened.listLinks().length, 0);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test('CRUD, pause and click analytics work', () => {
  const { store, cleanup } = makeStore();
  try {
    const link = store.createLink({
      slug: 'Promo',
      title: '  Promo   Raya ',
      targetUrl: 'johorstudio.com/raya.html',
      actor: 'rafierosliputra@gmail.com',
    });
    assert.equal(link.slug, 'promo');
    assert.equal(link.title, 'Promo Raya');
    assert.equal(link.targetUrl, 'https://johorstudio.com/raya.html');
    assert.equal(link.active, true);
    assert.equal(link.clicks, 0);

    assert.throws(() => store.createLink({ slug: 'promo', targetUrl: 'https://example.com' }), /sudah wujud/);
    assert.throws(() => store.createLink({ slug: 're', targetUrl: 'https://example.com' }), /servis lain/);

    assert.equal(store.getPublicLink('PROMO').id, link.id);
    assert.equal(store.recordClick(link.id, { country: 'my', host: 'promo.johorstudio.com' }), true);
    const clicked = store.getLinkById(link.id);
    assert.equal(clicked.clicks, 1);
    assert.ok(clicked.lastClickedAt);

    const overview = store.getOverview();
    assert.equal(overview.totals.links, 1);
    assert.equal(overview.totals.active, 1);
    assert.equal(overview.totals.clicks, 1);
    assert.equal(overview.totals.clicks7d, 1);
    assert.equal(overview.daily.length, 7);
    assert.equal(overview.daily.at(-1).count, 1);
    assert.equal(overview.recent.length, 1);
    assert.equal(overview.recent[0].slug, 'promo');
    assert.equal(overview.recent[0].country, 'MY');

    const paused = store.updateLink(link.id, {
      slug: 'promo',
      targetUrl: 'https://johorstudio.com/raya.html',
      title: 'Promo Raya',
      active: false,
    });
    assert.equal(paused.active, false);
    assert.equal(store.getPublicLink('promo'), null);

    store.deleteLink(link.id);
    assert.equal(store.getLinkById(link.id), null);
  } finally {
    cleanup();
  }
});

test('only one of the malformed slugs is rejected and title is capped', () => {
  const { store, cleanup } = makeStore();
  try {
    assert.throws(
      () => store.createLink({ slug: 'valid-slug', title: 'x'.repeat(121), targetUrl: 'https://example.com' }),
      /120 aksara/,
    );
  } finally {
    cleanup();
  }
});
