/* =========================================================
 * 共享 API 客户端：popup / options / background 通用
 * 读取 chrome.storage.sync 中的服务配置，封装对 bookmark-nas
 * REST API 的调用（自动带 Token、统一错误处理）。
 * ========================================================= */

/** 读取扩展配置（默认值兜底） */
async function getConfig() {
  return chrome.storage.sync.get({
    baseUrl: '',
    token: '',
  });
}

/** 规范化服务地址：去掉结尾斜杠，补全协议 */
function normalizeBaseUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

/**
 * 调用 bookmark-nas API。
 * @param {string} path 以 / 开头的 API 路径，如 /api/bookmarks
 * @param {object} [options] fetch 选项（method/body 等）
 * @returns {Promise<any>} 解析后的 JSON
 * @throws {Error} 未配置/网络错误/HTTP 错误，message 适合直接展示
 */
async function apiFetch(path, options = {}) {
  const cfg = await getConfig();
  const base = normalizeBaseUrl(cfg.baseUrl);
  if (!base) throw new Error('请先在扩展设置中配置书签服务地址');

  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cfg.token) headers['X-API-Token'] = cfg.token;

  let res;
  try {
    res = await fetch(base + path, { ...options, headers });
  } catch {
    throw new Error('无法连接书签服务，请检查地址与网络');
  }

  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }

  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

/** 获取当前活动标签页（popup 中调用） */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** 保存书签；成功返回新书签对象 */
async function createBookmark(payload) {
  const data = await apiFetch('/api/bookmarks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data.bookmark;
}

/** 记录一次访问（打开书签时调用，失败不阻塞） */
async function trackVisit(id) {
  try {
    await apiFetch(`/api/bookmarks/${id}/visit`, { method: 'POST' });
  } catch { /* 统计失败可忽略 */ }
}