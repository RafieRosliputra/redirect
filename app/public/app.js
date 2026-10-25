(() => {
  'use strict';

  const state = {
    me: null,
    links: [],
    overview: null,
    query: '',
    status: 'all',
    requestId: 0,
    editing: null,
    deleteArmed: false,
    deleteTimer: null,
    toastTimer: null,
  };

  const numberFormat = new Intl.NumberFormat('ms-MY');
  const elements = {
    accountEmail: document.querySelector('#account-email'),
    logoutLink: document.querySelector('#logout-link'),
    statActive: document.querySelector('#stat-active'),
    statLinksNote: document.querySelector('#stat-links-note'),
    statClicks7d: document.querySelector('#stat-clicks7d'),
    statClicks: document.querySelector('#stat-clicks'),
    visibleCount: document.querySelector('#visible-count'),
    searchInput: document.querySelector('#search-input'),
    filters: Array.from(document.querySelectorAll('.filter')),
    linksList: document.querySelector('#links-list'),
    emptyState: document.querySelector('#empty-state'),
    emptyTitle: document.querySelector('#empty-title'),
    emptyCopy: document.querySelector('#empty-copy'),
    emptyReset: document.querySelector('#empty-reset'),
    linkTemplate: document.querySelector('#link-template'),
    createForm: document.querySelector('#create-form'),
    createTitle: document.querySelector('#create-title-input'),
    createSlug: document.querySelector('#create-slug'),
    createTarget: document.querySelector('#create-target'),
    createSubmit: document.querySelector('#create-submit'),
    createError: document.querySelector('#create-error'),
    previewShort: document.querySelector('#preview-short'),
    previewTarget: document.querySelector('#preview-target'),
    routeClicks: document.querySelector('#route-clicks'),
    routeURL: document.querySelector('.route-url'),
    routeDestination: document.querySelector('.route-destination'),
    chart: document.querySelector('#chart'),
    chartTotal: document.querySelector('#chart-total'),
    recentList: document.querySelector('#recent-list'),
    editDialog: document.querySelector('#edit-dialog'),
    editForm: document.querySelector('#edit-form'),
    editId: document.querySelector('#edit-id'),
    editTitle: document.querySelector('#edit-title-input'),
    editSlug: document.querySelector('#edit-slug'),
    editTarget: document.querySelector('#edit-target'),
    editActive: document.querySelector('#edit-active'),
    editSubmit: document.querySelector('#edit-submit'),
    editError: document.querySelector('#edit-error'),
    editDelete: document.querySelector('#edit-delete'),
    editClose: document.querySelector('#edit-close'),
    editCancel: document.querySelector('#edit-cancel'),
    toast: document.querySelector('#toast'),
    toastMessage: document.querySelector('#toast-message'),
  };

  function formatNumber(value) {
    return numberFormat.format(Number(value) || 0);
  }

  function pluralKlik(value) {
    return `${formatNumber(value)} klik`;
  }

  function timeAgo(iso) {
    if (!iso) return 'Belum diklik';
    const timestamp = new Date(iso).getTime();
    if (!Number.isFinite(timestamp)) return 'Belum diklik';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 45) return 'Baru sahaja';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min lalu`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} jam lalu`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} hari lalu`;
    return new Intl.DateTimeFormat('ms-MY', {
      day: 'numeric',
      month: 'short',
      year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    }).format(new Date(iso));
  }

  function setBaseDomain(baseDomain) {
    const domain = String(baseDomain || 'johorstudio.com');
    document.querySelectorAll('[data-base-domain]').forEach((node) => {
      node.textContent = `.${domain}`;
    });
    document.querySelectorAll('.link-domain').forEach((node) => {
      node.textContent = `.${domain}`;
    });
    if (elements.routeURL) elements.routeURL.textContent = `telegram.${domain}`;
    document.querySelectorAll('.hero-domain').forEach((node) => {
      node.textContent = `re.${domain}`;
    });
    updatePreview();
  }

  function updatePreview() {
    const slug = elements.createSlug.value.trim().toLowerCase().replace(/\s+/g, '-') || 'pautan';
    const target = elements.createTarget.value.trim();
    elements.previewShort.textContent = `${slug}.johorstudio.com`;
    elements.previewTarget.textContent = target || 'Destinasi anda akan muncul di sini';
  }

  function showToast(message, kind = 'success') {
    clearTimeout(state.toastTimer);
    elements.toast.classList.toggle('is-error', kind === 'error');
    elements.toastMessage.textContent = message;
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, kind === 'error' ? 5000 : 3200);
  }

  function setFormError(node, message, focus) {
    if (!message) {
      node.textContent = '';
      node.hidden = true;
      return;
    }
    node.textContent = message;
    node.hidden = false;
    if (focus) focus.focus();
  }

  async function api(url, options = {}) {
    const request = { ...options, headers: { ...(options.headers || {}) } };
    if (request.body && typeof request.body !== 'string') {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(request.body);
    }
    const response = await fetch(url, { credentials: 'same-origin', ...request });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || 'Ralat rangkaian. Sila cuba lagi.');
      error.code = data?.error?.code || 'HTTP_ERROR';
      error.field = data?.error?.field || null;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function handleApiError(error) {
    if (error && ['ACCESS_EXPIRED', 'ACCESS_REQUIRED', 'ACCESS_INVALID'].includes(error.code)) {
      showToast('Sesi Access tamat. Memuatkan semula…', 'error');
      window.setTimeout(() => window.location.reload(), 1200);
      return;
    }
    showToast(error?.message || 'Ralat rangkaian. Sila cuba lagi.', 'error');
  }

  function renderSkeleton() {
    elements.linksList.innerHTML = '';
    for (let index = 0; index < 3; index += 1) {
      const skeleton = document.createElement('div');
      skeleton.className = 'link-skeleton';
      skeleton.setAttribute('aria-hidden', 'true');
      elements.linksList.append(skeleton);
    }
  }

  function renderEmptyState() {
    const hasFilter = Boolean(state.query) || state.status !== 'all';
    elements.emptyState.hidden = false;
    elements.emptyReset.hidden = !hasFilter;
    if (hasFilter) {
      elements.emptyTitle.textContent = 'Tiada pautan sepadan';
      elements.emptyCopy.textContent = 'Cuba carian lain atau tukar tapisan.';
    } else {
      elements.emptyTitle.textContent = 'Belum ada pautan';
      elements.emptyCopy.textContent = 'Cipta pautan pertama anda di sebelah kanan.';
    }
  }

  function buildMeta(card, link, domain) {
    const name = card.querySelector('.link-name');
    const separators = card.querySelectorAll('.meta-sep');
    const clicks = card.querySelector('.link-clicks');
    const last = card.querySelector('.link-last');
    name.textContent = link.title || 'Tanpa nama';
    if (!link.title) {
      name.hidden = true;
      separators[0].hidden = true;
    }
    clicks.textContent = pluralKlik(link.clicks);
    last.textContent = link.lastClickedAt ? `Terakhir: ${timeAgo(link.lastClickedAt)}` : 'Belum diklik';
    if (!link.clicks) last.classList.add('is-muted');
    card.querySelector('.link-target').textContent = `→ ${link.targetUrl}`;
    card.querySelector('.link-target').title = link.targetUrl;
    card.querySelector('.link-slug').textContent = link.slug;
    card.querySelector('.link-domain').textContent = `.${domain}`;
  }

  function renderLinks() {
    const fragment = document.createDocumentFragment();
    const domain = state.me?.baseDomain || 'johorstudio.com';
    elements.linksList.innerHTML = '';
    elements.linksList.setAttribute('aria-busy', 'false');
    elements.linksList.classList.remove('is-loading');
    elements.visibleCount.textContent = `${state.links.length} pautan`;

    if (!state.links.length) {
      renderEmptyState();
      return;
    }

    elements.emptyState.hidden = true;
    for (const link of state.links) {
      const card = elements.linkTemplate.content.firstElementChild.cloneNode(true);
      card.dataset.id = String(link.id);
      card.classList.toggle('is-paused', !link.active);
      const shortLink = card.querySelector('.link-short');
      shortLink.href = link.shortUrl;
      shortLink.setAttribute('aria-label', `Buka ${link.shortUrl} dalam tab baharu`);
      const badge = card.querySelector('.status-badge');
      badge.textContent = link.active ? 'Aktif' : 'Dijeda';
      badge.classList.toggle('is-paused', !link.active);
      buildMeta(card, link, domain);
      card.querySelector('[data-action="copy"]').setAttribute('aria-label', `Salin ${link.shortUrl}`);
      card.querySelector('[data-action="edit"]').setAttribute('aria-label', `Edit ${link.slug}.${domain}`);
      fragment.append(card);
    }
    elements.linksList.append(fragment);
  }

  function renderOverview(overview) {
    const totals = overview?.totals || { links: 0, active: 0, clicks: 0, clicks7d: 0 };
    elements.statActive.textContent = `${formatNumber(totals.active)} / ${formatNumber(totals.links)}`;
    elements.statLinksNote.textContent = `Daripada ${formatNumber(totals.links)} pautan`;
    elements.statClicks7d.textContent = formatNumber(totals.clicks7d);
    elements.statClicks.textContent = formatNumber(totals.clicks);
    elements.chartTotal.innerHTML = `${formatNumber(totals.clicks7d)} <span>klik</span>`;

    const daily = Array.isArray(overview?.daily) ? overview.daily : [];
    const max = Math.max(1, ...daily.map((day) => Number(day.count) || 0));
    elements.chart.innerHTML = '';
    for (const day of daily) {
      const count = Number(day.count) || 0;
      const level = count === 0 ? 0 : Math.max(1, Math.round((count / max) * 10));
      const col = document.createElement('div');
      col.className = 'chart-col';
      const value = document.createElement('span');
      value.className = 'chart-value';
      if (count === 0) value.classList.add('is-zero');
      value.textContent = formatNumber(count);
      const track = document.createElement('div');
      track.className = 'chart-track';
      const bar = document.createElement('span');
      bar.className = 'chart-bar';
      bar.dataset.level = String(level);
      bar.title = `${day.label}: ${pluralKlik(count)}`;
      const label = document.createElement('span');
      label.className = 'chart-day';
      label.textContent = day.label;
      track.append(bar);
      col.append(value, track, label);
      elements.chart.append(col);
    }
    const chartLabel = daily.map((day) => `${day.label} ${day.count}`).join(', ');
    elements.chart.setAttribute('aria-label', `Klik tujuh hari terakhir: ${chartLabel}`);

    const telegram = state.links.find((link) => link.slug === 'telegram');
    if (telegram) {
      elements.routeClicks.textContent = pluralKlik(telegram.clicks);
      elements.routeDestination.textContent = telegram.targetUrl.replace(/^https?:\/\//, '');
    } else {
      elements.routeClicks.textContent = 'Contoh pautan';
    }

    renderRecent(overview?.recent || []);
  }

  function renderRecent(recent) {
    elements.recentList.innerHTML = '';
    if (!recent.length) {
      const empty = document.createElement('li');
      empty.className = 'recent-empty';
      empty.textContent = 'Belum ada klik direkodkan. Kongsi pautan pertama anda.';
      elements.recentList.append(empty);
      return;
    }
    for (const item of recent) {
      const li = document.createElement('li');
      li.className = 'recent-item';
      const main = document.createElement('div');
      main.className = 'recent-main';
      const slug = document.createElement('span');
      slug.className = 'recent-slug';
      slug.textContent = `${item.slug}.${state.me?.baseDomain || 'johorstudio.com'}`;
      const target = document.createElement('span');
      target.className = 'recent-target';
      try {
        target.textContent = new URL(item.targetUrl).hostname;
      } catch {
        target.textContent = item.targetUrl;
      }
      main.append(slug, target);
      const side = document.createElement('div');
      side.className = 'recent-side';
      const time = document.createElement('span');
      time.className = 'recent-time';
      time.textContent = timeAgo(item.clickedAt);
      time.title = new Intl.DateTimeFormat('ms-MY', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(item.clickedAt));
      const country = document.createElement('span');
      country.className = 'recent-country';
      country.textContent = item.country ? `· ${item.country}` : '';
      if (!item.country) country.hidden = true;
      side.append(time, country);
      li.append(main, side);
      elements.recentList.append(li);
    }
  }

  async function loadLinks({ initial = false } = {}) {
    const requestId = ++state.requestId;
    if (initial) {
      renderSkeleton();
      elements.linksList.setAttribute('aria-busy', 'true');
    } else {
      elements.linksList.classList.add('is-loading');
      elements.linksList.setAttribute('aria-busy', 'true');
    }
    try {
      const params = new URLSearchParams();
      if (state.query) params.set('q', state.query);
      if (state.status !== 'all') params.set('status', state.status);
      const query = params.toString() ? `?${params.toString()}` : '';
      const data = await api(`/api/links${query}`);
      if (requestId !== state.requestId) return;
      state.links = data.links || [];
      state.overview = data.overview || null;
      if (data.baseDomain) {
        state.me = { ...(state.me || {}), baseDomain: data.baseDomain };
        setBaseDomain(data.baseDomain);
      }
      renderLinks();
      renderOverview(state.overview);
    } catch (error) {
      if (requestId !== state.requestId) return;
      elements.linksList.innerHTML = '';
      elements.linksList.setAttribute('aria-busy', 'false');
      elements.emptyState.hidden = false;
      elements.emptyTitle.textContent = 'Pautan tidak dapat dimuatkan';
      elements.emptyCopy.textContent = error.message;
      elements.emptyReset.hidden = true;
      handleApiError(error);
    }
  }

  async function loadMe() {
    const me = await api('/api/me');
    state.me = me;
    elements.accountEmail.textContent = me.email;
    elements.accountEmail.title = me.email;
    if (me.logoutUrl) {
      elements.logoutLink.href = me.logoutUrl;
      elements.logoutLink.hidden = false;
    } else {
      elements.logoutLink.hidden = true;
    }
    if (me.mode === 'dev') {
      const access = document.querySelector('.access-state');
      if (access) {
        access.lastChild.textContent = ' Dev';
        access.title = 'Mod pembangunan — bukan Cloudflare Access';
      }
    }
    setBaseDomain(me.baseDomain);
    return me;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    if (!ok) throw new Error('Salin tidak disokong oleh pelayar ini.');
  }

  function resetDeleteButton() {
    state.deleteArmed = false;
    clearTimeout(state.deleteTimer);
    elements.editDelete.classList.remove('is-confirming');
    elements.editDelete.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg> Padam';
  }

  function openEdit(link) {
    state.editing = link;
    resetDeleteButton();
    setFormError(elements.editError, '');
    elements.editId.value = String(link.id);
    elements.editTitle.value = link.title || '';
    elements.editSlug.value = link.slug;
    elements.editTarget.value = link.targetUrl;
    elements.editActive.checked = Boolean(link.active);
    elements.editDialog.showModal();
    window.setTimeout(() => elements.editSlug.focus(), 20);
  }

  function closeEdit() {
    if (elements.editDialog.open) elements.editDialog.close();
    state.editing = null;
    resetDeleteButton();
  }

  function onCreateInput() {
    updatePreview();
    setFormError(elements.createError, '');
  }

  function onCreateSlugInput() {
    const cursor = elements.createSlug.selectionStart;
    const lower = elements.createSlug.value.toLowerCase().replace(/\s+/g, '-');
    if (lower !== elements.createSlug.value) {
      elements.createSlug.value = lower;
      try {
        elements.createSlug.setSelectionRange(cursor, cursor);
      } catch {
        // Ignore selection errors on input types that do not support it.
      }
    }
    onCreateInput();
  }

  async function submitCreate(event) {
    event.preventDefault();
    setFormError(elements.createError, '');
    const slug = elements.createSlug.value.trim();
    const targetUrl = elements.createTarget.value.trim();
    const title = elements.createTitle.value.trim();
    if (!slug) {
      setFormError(elements.createError, 'Masukkan nama subdomain.', elements.createSlug);
      return;
    }
    if (!targetUrl) {
      setFormError(elements.createError, 'Masukkan URL destinasi.', elements.createTarget);
      return;
    }

    elements.createSubmit.disabled = true;
    elements.createSubmit.querySelector('span').textContent = 'Mencipta…';
    try {
      const data = await api('/api/links', { method: 'POST', body: { slug, targetUrl, title } });
      elements.createForm.reset();
      updatePreview();
      showToast(`Pautan ${data.link.slug}.${state.me?.baseDomain || 'johorstudio.com'} dicipta.`);
      elements.createSlug.focus();
      await loadLinks();
    } catch (error) {
      setFormError(elements.createError, error.message, null);
      if (error.field === 'slug') elements.createSlug.focus();
      if (error.field === 'targetUrl') elements.createTarget.focus();
      if (String(error.code || '').startsWith('ACCESS_')) handleApiError(error);
    } finally {
      elements.createSubmit.disabled = false;
      elements.createSubmit.querySelector('span').textContent = 'Cipta pautan';
    }
  }

  async function submitEdit(event) {
    event.preventDefault();
    if (!state.editing) return;
    setFormError(elements.editError, '');
    const slug = elements.editSlug.value.trim();
    const targetUrl = elements.editTarget.value.trim();
    const title = elements.editTitle.value.trim();
    if (!slug || !targetUrl) {
      setFormError(elements.editError, 'Subdomain dan destinasi wajib diisi.', !slug ? elements.editSlug : elements.editTarget);
      return;
    }
    elements.editSubmit.disabled = true;
    elements.editSubmit.textContent = 'Menyimpan…';
    try {
      const data = await api(`/api/links/${state.editing.id}`, {
        method: 'PATCH',
        body: { slug, targetUrl, title, active: elements.editActive.checked },
      });
      closeEdit();
      showToast(`Perubahan pada ${data.link.slug} disimpan.`);
      await loadLinks();
    } catch (error) {
      setFormError(elements.editError, error.message, null);
      if (String(error.code || '').startsWith('ACCESS_')) handleApiError(error);
    } finally {
      elements.editSubmit.disabled = false;
      elements.editSubmit.textContent = 'Simpan perubahan';
    }
  }

  async function deleteEditing() {
    if (!state.editing) return;
    if (!state.deleteArmed) {
      state.deleteArmed = true;
      elements.editDelete.classList.add('is-confirming');
      elements.editDelete.textContent = 'Sahkan padam?';
      state.deleteTimer = window.setTimeout(resetDeleteButton, 5000);
      return;
    }
    const link = state.editing;
    elements.editDelete.disabled = true;
    elements.editDelete.textContent = 'Memadam…';
    try {
      await api(`/api/links/${link.id}`, { method: 'DELETE' });
      closeEdit();
      showToast(`Pautan ${link.slug} telah dipadam.`);
      await loadLinks();
    } catch (error) {
      setFormError(elements.editError, error.message);
      resetDeleteButton();
    } finally {
      elements.editDelete.disabled = false;
    }
  }

  function setStatus(status) {
    state.status = status;
    for (const button of elements.filters) {
      const active = button.dataset.status === status;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    loadLinks();
  }

  let searchTimer;
  elements.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = elements.searchInput.value.trim();
      loadLinks();
    }, 260);
  });

  for (const button of elements.filters) {
    button.addEventListener('click', () => setStatus(button.dataset.status));
  }

  elements.emptyReset.addEventListener('click', () => {
    state.query = '';
    state.status = 'all';
    elements.searchInput.value = '';
    for (const button of elements.filters) {
      const active = button.dataset.status === 'all';
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    loadLinks();
  });

  elements.linksList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const card = button.closest('.link-card');
    const link = state.links.find((item) => String(item.id) === card?.dataset.id);
    if (!link) return;
    if (button.dataset.action === 'copy') {
      try {
        await copyText(link.shortUrl);
        showToast(`${link.shortUrl} disalin.`);
        const oldLabel = button.getAttribute('aria-label');
        button.classList.add('is-copied');
        button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg><span class="btn-tip">Disalin</span>';
        window.setTimeout(() => {
          button.classList.remove('is-copied');
          button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg><span class="btn-tip">Salin</span>';
          if (oldLabel) button.setAttribute('aria-label', oldLabel);
        }, 1400);
      } catch (error) {
        showToast(error.message, 'error');
      }
    }
    if (button.dataset.action === 'edit') openEdit(link);
  });

  elements.createSlug.addEventListener('input', onCreateSlugInput);
  elements.createTarget.addEventListener('input', onCreateInput);
  elements.createTitle.addEventListener('input', onCreateInput);
  elements.createForm.addEventListener('submit', submitCreate);
  elements.editForm.addEventListener('submit', submitEdit);

  elements.editClose.addEventListener('click', closeEdit);
  elements.editCancel.addEventListener('click', closeEdit);
  elements.editDelete.addEventListener('click', deleteEditing);
  elements.editDialog.addEventListener('click', (event) => {
    if (event.target === elements.editDialog) closeEdit();
  });
  elements.editDialog.addEventListener('close', () => {
    state.editing = null;
    resetDeleteButton();
    setFormError(elements.editError, '');
  });

  async function init() {
    updatePreview();
    try {
      await loadMe();
    } catch (error) {
      handleApiError(error);
      return;
    }
    await loadLinks({ initial: true });
  }

  init();
})();
