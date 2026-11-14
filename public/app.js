/* =========================================================
 * 我的书签 - 前端逻辑（原生 JS，无构建步骤）
 * 数据全部通过 REST API 获取；API 同时服务于后续浏览器插件。
 * ========================================================= */

/* ---------- 工具函数 ---------- */

const $ = (sel) => document.querySelector(sel);

/** HTML 转义，防止用户内容注入 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** 请求 API，非 2xx 抛出错误 */
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
  return data;
}

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- 全局状态 ---------- */

const state = {
  cats: [],                 // 分类列表
  bms: [],                  // 当前书签列表
  total: 0,                 // 书签总数（来自 /api/stats，用于「未分类」计数）
  filter: {
    categoryId: null,       // null=全部, 'none'=未分类, 数字=分类 id
    health: null,           // null|'ok'|'dead'|'error'|'unknown'
    q: '',
    tag: null,
  },
  sort: 'clicks',
  editingId: null,          // 编辑中的书签 id
  confirmCb: null,          // 确认弹窗回调
};

/* ---------- 主题 ---------- */

function initTheme() {
  const saved = localStorage.getItem('bm-theme');
  const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('bm-theme', next);
}

/* ---------- 弹窗通用 ---------- */

function openModal(modal) {
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const first = modal.querySelector('input, select, textarea, button');
  if (first) setTimeout(() => first.focus(), 30);
}

function closeModal(modal) {
  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

function closeTopModal() {
  for (const m of document.querySelectorAll('.modal:not(.hidden)')) closeModal(m);
}

/* ---------- 渲染：分类侧栏 ---------- */

const HEALTH_CHIPS = [
  ['', '全部'],
  ['ok', '正常'],
  ['dead', '失效'],
  ['error', '异常'],
  ['unknown', '未检测'],
];

const HEALTH_LABEL = { ok: '正常', dead: '失效', error: '异常', unknown: '未检测' };

function renderSidebar() {
  const list = $('#cat-list');
  const f = state.filter;

  const totalCount = state.cats.reduce((s, c) => s + c.bookmark_count, 0);
  const items = [
    { key: 'all', id: null, name: '全部', count: totalCount, icon: 'all' },
    { key: 'none', id: 'none', name: '未分类', count: Math.max(0, state.total - totalCount), icon: 'inbox' },
    ...state.cats.map((c) => ({ key: 'cat' + c.id, id: c.id, name: c.name, count: c.bookmark_count, icon: 'folder' })),
  ];

  list.innerHTML = items.map((it) => {
    const active = f.categoryId === it.id;
    const icon = it.icon === 'all'
      ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>'
      : it.icon === 'inbox'
        ? '<svg viewBox="0 0 24 24"><path d="M4 4h16l-1.5 16h-13z"/><path d="M2.5 9h19"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M4 4h7l2 2h7v14H4z"/></svg>';
    const actions = it.key.startsWith('cat')
      ? `<span class="cat-actions">
          <button class="cat-rename" data-id="${it.id}" aria-label="重命名分类「${escapeHtml(it.name)}」" title="重命名"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
          <button class="cat-del" data-id="${it.id}" aria-label="删除分类「${escapeHtml(it.name)}」" title="删除"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
        </span>`
      : '';
    return `<div class="cat-item ${active ? 'active' : ''}" role="button" tabindex="0" data-cat="${it.id ?? ''}" data-key="${it.key}" aria-label="筛选分类：${escapeHtml(it.name)}">
      ${icon}<span class="cat-name">${escapeHtml(it.name)}</span>
      <span class="cat-count">${it.count}</span>${actions}
    </div>`;
  }).join('');
}

/* ---------- 渲染：工具栏（结果数 + 健康筛选 chips） ---------- */

function renderToolbar() {
  $('#result-count').textContent = state.bms.length
    ? `共 ${state.bms.length} 条书签`
    : '没有书签';
  const chips = $('#health-chips');
  chips.innerHTML = HEALTH_CHIPS.map(([val, label]) =>
    `<button class="chip ${state.filter.health === val ? 'active' : ''}" data-health="${val}">${label}</button>`
  ).join('');
  $('#tag-filter').classList.toggle('hidden', !state.filter.tag);
  if (state.filter.tag) $('#tag-filter-name').textContent = state.filter.tag;
}

/* ---------- 渲染：书签卡片网格 ---------- */

function faviconHtml(bm) {
  const letter = (bm.title || '?').trim().charAt(0).toUpperCase();
  const host = hostOf(bm.url);
  return `<span class="card-favicon" aria-hidden="true">${escapeHtml(letter)}
    <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64" alt=""
         loading="lazy" onerror="this.remove()">
  </span>`;
}

function healthBadgeHtml(bm) {
  const icon = bm.health_status === 'ok'
    ? '<svg viewBox="0 0 24 24"><path d="m4.5 12.5 5 5 10-11"/></svg>'
    : bm.health_status === 'dead'
      ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>'
      : bm.health_status === 'error'
        ? '<svg viewBox="0 0 24 24"><path d="M12 3 2.5 20h19z"/><path d="M12 10v4M12 17.2v.1"/></svg>'
        : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16v.1"/></svg>';
  const label = HEALTH_LABEL[bm.health_status] || '未检测';
  return `<span class="health-badge ${bm.health_status}" title="状态码：${bm.health_code ?? '—'}">${icon}${label}</span>`;
}

function cardHtml(bm) {
  const host = hostOf(bm.url);
  const tags = bm.tags
    ? bm.tags.split(',').map((t) => `<button class="tag-chip" data-tag="${escapeHtml(t)}" aria-label="按标签「${escapeHtml(t)}」筛选">#${escapeHtml(t)}</button>`).join('')
    : '';
  const notes = bm.notes ? `<div class="card-notes">${escapeHtml(bm.notes)}</div>` : '';
  return `
  <article class="card" data-id="${bm.id}">
    <div class="card-actions">
      <button class="act-edit" data-id="${bm.id}" aria-label="编辑书签「${escapeHtml(bm.title)}」" title="编辑">
        <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
      <button class="act-del danger" data-id="${bm.id}" aria-label="删除书签「${escapeHtml(bm.title)}」" title="删除">
        <svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
      </button>
    </div>
    <a class="card-main" href="${escapeHtml(bm.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(bm.title)}">
      ${faviconHtml(bm)}
      <div class="card-body">
        <div class="card-title">${escapeHtml(bm.title)}</div>
        <div class="card-host">${escapeHtml(host)}</div>
        ${notes}
      </div>
    </a>
    ${tags ? `<div class="card-tags">${tags}</div>` : ''}
    <div class="card-footer">
      ${healthBadgeHtml(bm)}
      <span class="card-clicks" title="访问次数">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/></svg>
        ${bm.click_count}
      </span>
    </div>
  </article>`;
}

function renderGrid() {
  const grid = $('#grid');
  const empty = $('#empty');
  if (!state.bms.length) {
    grid.innerHTML = '';
    const isFiltering = !!(state.filter.q || state.filter.tag || state.filter.health || state.filter.categoryId !== null);
    empty.innerHTML = isFiltering
      ? `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><div>没有匹配的书签，换个关键词试试</div>`
      : `<svg viewBox="0 0 24 24"><path d="M6 2h12a1 1 0 0 1 1 1v19l-7-4.5L5 22V3a1 1 0 0 1 1-1z"/></svg><div>还没有书签，点击右上角「添加书签」开始收藏</div>`;
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = state.bms.map(cardHtml).join('');
}

/* ---------- 数据加载 ---------- */

async function loadCategories() {
  try {
    const data = await api('/categories');
    state.cats = data.categories;
    renderSidebar();
  } catch (e) {
    toast('分类加载失败：' + e.message, 'error');
  }
}

async function loadBookmarks() {
  const p = new URLSearchParams();
  const f = state.filter;
  if (f.categoryId !== null) p.set('category_id', f.categoryId);
  if (f.health) p.set('health', f.health);
  if (f.q) p.set('q', f.q);
  if (f.tag) p.set('tag', f.tag);
  p.set('sort', state.sort);
  try {
    const data = await api('/bookmarks?' + p.toString());
    state.bms = data.bookmarks;
    renderGrid();
    renderToolbar();
  } catch (e) {
    toast('书签加载失败：' + e.message, 'error');
  }
}

async function loadAll() {
  await Promise.all([loadCategories(), loadBookmarks()]);
  try {
    const s = await api('/stats');
    state.total = s.total;
    renderSidebar();
  } catch { /* 统计失败不影响主界面 */ }
}

/* ---------- 书签编辑弹窗 ---------- */

function openBookmarkModal(bm) {
  state.editingId = bm ? bm.id : null;
  $('#modal-title').textContent = bm ? '编辑书签' : '添加书签';
  $('#f-title').value = bm ? bm.title : '';
  $('#f-url').value = bm ? bm.url : '';
  $('#f-tags').value = bm ? bm.tags : '';
  $('#f-notes').value = bm ? bm.notes : '';
  $('#f-url-error').classList.add('hidden');
  const cur = bm ? bm.category_id : (typeof state.filter.categoryId === 'number' ? state.filter.categoryId : '');
  $('#f-category').innerHTML = '<option value="">未分类</option>' + state.cats
    .map((c) => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
    .join('');
  openModal($('#bookmark-modal'));
  setTimeout(() => $('#f-title').focus(), 50);
}

async function saveBookmark(e) {
  e.preventDefault();
  const title = $('#f-title').value.trim();
  const url = $('#f-url').value.trim();
  const categoryId = $('#f-category').value ? Number($('#f-category').value) : null;
  const tags = $('#f-tags').value.trim();
  const notes = $('#f-notes').value.trim();
  if (!title) { $('#f-title').focus(); return; }
  if (!/^https?:\/\//i.test(url)) {
    const err = $('#f-url-error');
    err.textContent = '请输入以 http:// 或 https:// 开头的网址';
    err.classList.remove('hidden');
    $('#f-url').focus();
    return;
  }
  const payload = { title, url, category_id: categoryId, tags, notes };
  try {
    if (state.editingId) {
      await api(`/bookmarks/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('书签已更新');
      closeModal($('#bookmark-modal'));
      await loadAll();
      checkNewBookmark(state.editingId); // 编辑保存后自动重新检查链接
    } else {
      const created = await api('/bookmarks', { method: 'POST', body: JSON.stringify(payload) });
      toast('书签已添加');
      closeModal($('#bookmark-modal'));
      await loadAll();
      checkNewBookmark(created.bookmark.id); // 添加完成后自动检查链接
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** 新书签添加后，轮询其健康检查结果并刷新徽章（最多约 20 秒） */
function checkNewBookmark(id) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) card.classList.add('checking');
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    try {
      const { bookmark } = await api(`/bookmarks/${id}`);
      if (bookmark.health_status !== 'unknown' || tries >= 10) {
        clearInterval(timer);
        await loadAll(); // 重新渲染后徽章显示最新状态
        if (bookmark.health_status === 'dead' || bookmark.health_status === 'error') {
          toast(bookmark.health_status === 'dead'
            ? '链接检查：无法访问该网址'
            : `链接检查：返回异常（HTTP ${bookmark.health_code ?? '?'}）`);
        }
      }
    } catch {
      clearInterval(timer); // 书签可能已被删除
    }
  }, 2000);
}

/* ---------- 确认弹窗 ---------- */

function askConfirm(text, cb) {
  $('#confirm-text').textContent = text;
  state.confirmCb = cb;
  openModal($('#confirm-modal'));
}

/* ---------- 分类操作 ---------- */

async function submitNewCategory() {
  const input = $('#cat-input');
  const name = input.value.trim();
  if (!name) return;
  try {
    await api('/categories', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    $('#cat-input-wrap').classList.add('hidden');
    toast(`分类「${name}」已创建`);
    await loadAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function startRename(btn) {
  const item = btn.closest('.cat-item');
  const nameSpan = item.querySelector('.cat-name');
  const oldName = nameSpan.textContent;
  const input = document.createElement('input');
  input.value = oldName;
  input.maxLength = 30;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (!val || val === oldName) { loadCategories(); return; }
    try {
      await api(`/categories/${item.dataset.cat}`, { method: 'PUT', body: JSON.stringify({ name: val }) });
      toast('分类已重命名');
    } catch (err) {
      toast(err.message, 'error');
    }
    loadCategories();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') { done = true; loadCategories(); }
  });
  input.addEventListener('blur', commit);
}

function requestDeleteCategory(btn) {
  const item = btn.closest('.cat-item');
  const name = item.querySelector('.cat-name').textContent;
  askConfirm(`删除分类「${name}」？该分类下的书签将变为「未分类」。`, async () => {
    try {
      await api(`/categories/${item.dataset.cat}`, { method: 'DELETE' });
      toast('分类已删除');
      await loadAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function requestDeleteBookmark(id) {
  const bm = state.bms.find((b) => b.id === id);
  askConfirm(`删除书签「${bm ? bm.title : ''}」？此操作不可恢复。`, async () => {
    try {
      await api(`/bookmarks/${id}`, { method: 'DELETE' });
      toast('书签已删除');
      await loadAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ---------- 访问统计 ---------- */

function trackVisit(id) {
  api(`/bookmarks/${id}/visit`, { method: 'POST' })
    .then((r) => {
      const clicks = document.querySelector(`.card[data-id="${id}"] .card-clicks`);
      if (clicks) clicks.lastChild.textContent = ' ' + r.click_count;
    })
    .catch(() => { /* 统计失败不影响打开网页 */ });
}

/* ---------- 统计弹窗 ---------- */

function lastNDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push({ label: `${m}-${day}`, day: `${d.getFullYear()}-${m}-${day}`, n: 0 });
  }
  return out;
}

async function openStats() {
  openModal($('#stats-modal'));
  const body = $('#stats-body');
  body.innerHTML = '<div class="empty" style="padding:30px 0">加载中…</div>';
  try {
    const s = await api('/stats');
    const dist = { ok: 0, dead: 0, error: 0, unknown: 0 };
    for (const d of s.healthDist) dist[d.health_status] = d.n;
    const maxH = Math.max(1, ...Object.values(dist));
    const days = lastNDays(7);
    const counts = new Map(s.last7Days.map((d) => [d.day, d.n]));
    for (const d of days) d.n = counts.get(d.day) || 0;
    const maxD = Math.max(1, ...days.map((d) => d.n));
    const healthNames = [['ok', '正常'], ['dead', '失效'], ['error', '异常'], ['unknown', '未检测']];
    body.innerHTML = `
      <div class="stat-cards">
        <div class="stat-card"><div class="num">${s.total}</div><div class="label">书签总数</div></div>
        <div class="stat-card"><div class="num">${s.categoryCount}</div><div class="label">分类数</div></div>
        <div class="stat-card"><div class="num">${s.todayVisits}</div><div class="label">今日访问</div></div>
        <div class="stat-card"><div class="num">${s.totalClicks}</div><div class="label">累计点击数</div></div>
      </div>
      <div class="stats-section"><h3>链接健康状态</h3>
        ${healthNames.map(([k, label]) => `
          <div class="health-row"><span class="h-name">${label}</span>
            <span class="h-bar ${k}"><i style="width:${Math.round((dist[k] / maxH) * 100)}%"></i></span>
            <span class="h-num">${dist[k]}</span></div>`).join('')}
      </div>
      <div class="stats-section"><h3>最近 7 天访问</h3>
        <div class="days-chart">${days.map((d) => `
          <div class="days-col" title="${d.day}：${d.n} 次">
            <div class="d-bar" style="height:${Math.max(d.n ? 8 : 2, Math.round((d.n / maxD) * 100))}%"></div>
            <div class="d-label">${d.label}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="stats-section"><h3>最常访问 Top 5</h3>
        <ol class="top-list">
          ${s.topBookmarks.length ? s.topBookmarks.map((b, i) => `
            <li><span class="rank">${i + 1}</span>
              <span class="t-title"><a href="${escapeHtml(b.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</a></span>
              <span class="t-clicks">${b.click_count} 次</span></li>`).join('')
          : '<li style="color:var(--ink-3)">暂无访问记录</li>'}
        </ol>
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="empty">统计加载失败：${escapeHtml(e.message)}</div>`;
  }
}

/* ---------- 健康检查（批量 + 轮询进度） ---------- */

let checkTimer = null;

function pollHealthCheck() {
  if (checkTimer) return;
  checkTimer = setInterval(async () => {
    try {
      const { job } = await api('/check-all/status');
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      $('#check-bar-fill').style.width = pct + '%';
      const summary = job.ok + job.dead + job.error;
      if (job.running) {
        $('#check-bar-text').textContent = `正在检查 ${job.done}/${job.total}…`;
      } else if (summary) {
        clearInterval(checkTimer);
        checkTimer = null;
        $('#check-bar-text').textContent = `检查完成：${job.ok} 正常 / ${job.dead} 失效 / ${job.error} 异常`;
        toast(`检查完成：${job.ok} 正常 / ${job.dead} 失效 / ${job.error} 异常`);
        setTimeout(() => $('#check-progress').classList.add('hidden'), 2500);
        loadAll();
      } else {
        clearInterval(checkTimer);
        checkTimer = null;
        $('#check-progress').classList.add('hidden');
      }
    } catch { /* 轮询失败，下轮重试 */ }
  }, 1500);
}

async function startHealthCheck() {
  try {
    const data = await api('/check-all', { method: 'POST' });
    if (!data.started) { toast('没有书签需要检查'); return; }
    $('#check-progress').classList.remove('hidden');
    $('#check-bar-fill').style.width = '0%';
    $('#check-bar-text').textContent = '正在检查…';
    pollHealthCheck();
  } catch (e) {
    if (/已在运行/.test(e.message)) {
      $('#check-progress').classList.remove('hidden');
      pollHealthCheck();
    } else {
      toast(e.message, 'error');
    }
  }
}

/* ---------- 事件绑定 ---------- */

function wireEvents() {
  // 搜索（防抖 250ms）
  $('#search').addEventListener('input', debounce((e) => {
    state.filter.q = e.target.value.trim();
    loadBookmarks();
    renderToolbar();
  }, 250));

  // 排序
  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    loadBookmarks();
  });

  // 健康状态筛选 chips
  $('#health-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter.health = chip.dataset.health || null;
    renderToolbar();
    loadBookmarks();
  });

  // 清除标签筛选
  $('#tag-filter-clear').addEventListener('click', () => {
    state.filter.tag = null;
    renderToolbar();
    loadBookmarks();
  });

  // 分类侧栏（外层是 div[role=button]，避免 button 嵌套导致的解析逃逸）
  function selectCategory(item) {
    let val = item.dataset.cat;
    if (val === '') val = null;
    else if (val !== 'none') val = Number(val);
    state.filter.categoryId = val;
    renderSidebar();
    loadBookmarks();
  }

  $('#cat-list').addEventListener('click', (e) => {
    const rename = e.target.closest('.cat-rename');
    if (rename) { e.stopPropagation(); startRename(rename); return; }
    const del = e.target.closest('.cat-del');
    if (del) { e.stopPropagation(); requestDeleteCategory(del); return; }
    const item = e.target.closest('.cat-item');
    if (!item) return;
    selectCategory(item);
  });

  // 键盘支持：Enter / Space 选择分类
  $('#cat-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.cat-item');
    if (!item) return;
    e.preventDefault();
    selectCategory(item);
  });

  // 新建分类
  $('#btn-add-cat').addEventListener('click', () => {
    const wrap = $('#cat-input-wrap');
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) $('#cat-input').focus();
  });
  $('#cat-input-ok').addEventListener('click', submitNewCategory);
  $('#cat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNewCategory();
  });

  // 书签卡片（事件委托）
  $('#grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    if (e.target.closest('.act-edit')) { openBookmarkModal(state.bms.find((b) => b.id === id)); return; }
    if (e.target.closest('.act-del')) { requestDeleteBookmark(id); return; }
    const tag = e.target.closest('.tag-chip');
    if (tag) {
      state.filter.tag = tag.dataset.tag;
      renderToolbar();
      loadBookmarks();
      return;
    }
    if (e.target.closest('a.card-main')) trackVisit(id);
  });

  // 书签弹窗
  $('#btn-add').addEventListener('click', () => openBookmarkModal(null));
  $('#bookmark-form').addEventListener('submit', saveBookmark);
  $('#bookmark-modal .modal-close').addEventListener('click', () => closeModal($('#bookmark-modal')));
  $('#bookmark-modal .modal-cancel').addEventListener('click', () => closeModal($('#bookmark-modal')));
  $('#bookmark-modal').addEventListener('click', (e) => {
    if (e.target === $('#bookmark-modal')) closeModal($('#bookmark-modal'));
  });
  $('#f-url').addEventListener('input', () => $('#f-url-error').classList.add('hidden'));

  // 确认弹窗
  $('#confirm-modal .modal-cancel').addEventListener('click', () => closeModal($('#confirm-modal')));
  $('#confirm-ok').addEventListener('click', () => {
    const cb = state.confirmCb;
    state.confirmCb = null;
    closeModal($('#confirm-modal'));
    if (cb) cb();
  });
  $('#confirm-modal').addEventListener('click', (e) => {
    if (e.target === $('#confirm-modal')) closeModal($('#confirm-modal'));
  });

  // 统计弹窗
  $('#btn-stats').addEventListener('click', openStats);
  $('#stats-modal .modal-close').addEventListener('click', () => closeModal($('#stats-modal')));
  $('#stats-modal').addEventListener('click', (e) => {
    if (e.target === $('#stats-modal')) closeModal($('#stats-modal'));
  });

  // 健康检查
  $('#btn-check').addEventListener('click', startHealthCheck);

  // 主题切换
  $('#btn-theme').addEventListener('click', toggleTheme);

  // 键盘：Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#cat-input-wrap').classList.contains('hidden')) {
      $('#cat-input-wrap').classList.add('hidden');
      $('#cat-input').value = '';
    } else {
      closeTopModal();
    }
  });
}

/* ---------- 启动 ---------- */

function init() {
  initTheme();
  wireEvents();
  loadAll();
}

init();
