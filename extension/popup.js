/* =========================================================
 * popup 逻辑：保存当前页 + 搜索/直达最近书签
 * ========================================================= */

const $ = (s) => document.querySelector(s);
const state = { cats: [], tab: null };

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
function setMsg(text, ok) {
  const m = $('#msg');
  m.textContent = text || '';
  m.className = text ? (ok ? 'msg ok' : 'msg err') : 'msg';
}

/* ---------- 初始化 ---------- */

async function init() {
  // 设置按钮
  $('#btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  try {
    state.tab = await getActiveTab();
    if (state.tab?.url) {
      // 仅对 http(s) 页面允许保存
      if (/^https?:/i.test(state.tab.url)) {
        $('#cur-page').innerHTML = '将保存：<b>' + esc(state.tab.title || '') + '</b><br>' + esc(state.tab.url);
        $('#save-title').value = state.tab.title || hostOf(state.tab.url);
      } else {
        $('#cur-page').textContent = '当前页面不是网页（chrome:// 等），无法保存';
        $('#btn-save').disabled = true;
      }
    }
  } catch {
    $('#cur-page').textContent = '无法读取当前标签页';
  }

  // 加载分类
  try {
    const data = await apiFetch('/api/categories');
    state.cats = data.categories || [];
    $('#save-cat').innerHTML = '<option value="">未分类</option>' + state.cats
      .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
      + '<option value="__new__">➕ 新建分类…</option>';
  } catch (e) {
    setMsg(e.message, false);
  }

  // 加载最近书签
  await search('');

  // 事件
  $('#btn-save').addEventListener('click', saveCurrent);
  $('#search').addEventListener('input', debounce(() => search($('#search').value.trim()), 250));
  $('#list').addEventListener('click', onItemClick);
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------- 保存当前页 ---------- */

async function saveCurrent() {
  const title = $('#save-title').value.trim();
  const catVal = $('#save-cat').value;
  const tags = $('#save-tags').value.trim();
  if (!title || !state.tab?.url) { setMsg('标题或网址为空', false); return; }

  let category_id = catVal && catVal !== '__new__' ? Number(catVal) : null;

  // 新建分类
  if (catVal === '__new__') {
    const name = prompt('请输入新分类名称：');
    if (!name || !name.trim()) { setMsg('未输入分类名称', false); return; }
    try {
      const c = await apiFetch('/api/categories', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      category_id = c.id;
      state.cats.push(c);
    } catch (e) { setMsg(e.message, false); return; }
  }

  $('#btn-save').disabled = true;
  try {
    const bm = await createBookmark({ title, url: state.tab.url, category_id, tags });
    setMsg('✓ 已保存（#' + bm.id + '）', true);
    $('#save-tags').value = '';
    // 重新加载最近书签
    await search('');
  } catch (e) {
    setMsg(e.message, false);
  } finally {
    $('#btn-save').disabled = false;
  }
}

/* ---------- 搜索 / 列表 ---------- */

async function search(q) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('sort', 'recent');
  try {
    const data = await apiFetch('/api/bookmarks?' + params.toString());
    renderList(data.bookmarks || []);
    $('#count').textContent = data.total || 0;
  } catch (e) {
    $('#list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderList(bms) {
  const list = $('#list');
  if (!bms.length) {
    list.innerHTML = '<div class="empty">没有书签。保存当前网页试试！</div>';
    return;
  }
  list.innerHTML = bms.map((b) => `
    <div class="item" data-id="${b.id}" data-url="${esc(b.url)}">
      <span class="fav"><img src=""></span>
      <span class="meta">
        <span class="t">${esc(b.title)}</span>
        <span class="h">${esc(hostOf(b.url))}${b.category_name ? ' · ' + esc(b.category_name) : ''}</span>
      </span>
      <span class="go">↗</span>
    </div>`).join('');
  // 图标异步加载（失败保留首字母占位）
  bms.forEach((b, i) => {
    const el = list.children[i];
    if (!el) return;
    const letter = (b.title || '?').charAt(0).toUpperCase();
    el.querySelector('.fav').innerHTML = `<span>${esc(letter)}</span>`;
    const img = document.createElement('img');
    img.src = `${normalizeBaseUrl(state.baseUrl)}/api/bookmarks/${b.id}/favicon`;
    img.onerror = () => img.remove();
    el.querySelector('.fav').appendChild(img);
  });
}

function onItemClick(e) {
  const item = e.target.closest('.item');
  if (!item) return;
  const id = Number(item.dataset.id);
  const url = item.dataset.url;
  // 记录访问（异步，不阻塞打开）
  trackVisit(id);
  chrome.tabs.create({ url });
}

/* ---------- 启动 ---------- */
(async () => {
  // popup 里也要 baseUrl 用于拼 favicon
  try {
    const cfg = await getConfig();
    state.baseUrl = normalizeBaseUrl(cfg.baseUrl);
  } catch { state.baseUrl = ''; }
  await init();
})()