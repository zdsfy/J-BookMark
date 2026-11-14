/**
 * REST API 层：书签/分类 CRUD、全文与标签搜索、访问统计、健康检查。
 * 所有端点返回 JSON，错误统一为 { error: string }。
 * 此 API 同时服务于网页前端与后续的浏览器插件。
 */
import { getDb } from './db.js';
import { runHealthCheck, getHealthJob } from './health.js';
import { getFavicon, invalidateFavicon } from './favicon.js';

/* ---------- 工具函数 ---------- */

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** 请求体超限标记：readBody 已写好 413 响应，调用方直接 return */
const TOO_LARGE = Symbol('too_large');

/** 读取请求体（限制 1MB）；超限返回 TOO_LARGE（已回 413），非法 JSON 返回 null */
function readBody(req, res) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > 1024 * 1024) {
        aborted = true;
        try {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '请求体过大（上限 1MB）' }));
        } catch {}
        req.destroy();
        resolve(TOO_LARGE);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => {
      if (!aborted) resolve(null);
    });
  });
}

/** LIKE 通配符转义，防止 % 和 _ 干扰搜索 */
function escapeLike(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** 标签规范化：按逗号/空格切分、去重、去空 */
function normalizeTags(tags) {
  if (tags == null) return null;
  const seen = new Set();
  const out = [];
  for (const raw of String(tags).split(/[,，\s]+/)) {
    const t = raw.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.join(',');
}

function parseId(match, idx = 1) {
  return Number(match[idx]);
}

function validUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

const SORTS = {
  clicks: 'b.click_count DESC, b.last_visited_at DESC',
  recent: 'b.last_visited_at DESC, b.id DESC',
  created: 'b.id DESC',
  alpha: 'b.title COLLATE NOCASE ASC',
};

/* ---------- 分类 ---------- */

function listCategories(_req, res) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.id, c.name, c.sort_order,
           COUNT(b.id) AS bookmark_count,
           SUM(CASE WHEN b.health_status = 'dead' THEN 1 ELSE 0 END) AS dead_count
    FROM categories c
    LEFT JOIN bookmarks b ON b.category_id = c.id
    GROUP BY c.id
    ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC
  `).all();
  sendJson(res, 200, { categories: rows });
}

async function createCategory(req, res) {
  const body = await readBody(req, res);
  if (body === TOO_LARGE) return;
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return sendError(res, 400, '分类名称不能为空');
  }
  if (body.sort_order != null && !Number.isInteger(body.sort_order)) {
    return sendError(res, 400, 'sort_order 必须是整数');
  }
  const name = body.name.trim();
  const db = getDb();
  try {
    const info = db.prepare(
      'INSERT INTO categories (name, sort_order) VALUES (?, ?)'
    ).run(name, body.sort_order ?? 0);
    sendJson(res, 201, { id: Number(info.lastInsertRowid), name });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return sendError(res, 409, `分类「${name}」已存在`);
    }
    throw e;
  }
}

async function updateCategory(req, res, match) {
  const id = parseId(match);
  const body = await readBody(req, res);
  if (body === TOO_LARGE) return;
  if (!body) return sendError(res, 400, '请求体无效');
  const db = getDb();
  const cur = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!cur) return sendError(res, 404, '分类不存在');

  const name = body.name != null ? String(body.name).trim() : cur.name;
  if (!name) return sendError(res, 400, '分类名称不能为空');
  if (body.sort_order != null && !Number.isInteger(body.sort_order)) {
    return sendError(res, 400, 'sort_order 必须是整数');
  }
  const sortOrder = body.sort_order != null ? body.sort_order : cur.sort_order;
  try {
    db.prepare('UPDATE categories SET name = ?, sort_order = ? WHERE id = ?').run(name, sortOrder, id);
    sendJson(res, 200, { id, name, sort_order: sortOrder });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return sendError(res, 409, `分类「${name}」已存在`);
    }
    throw e;
  }
}

function deleteCategory(_req, res, match) {
  const id = parseId(match);
  const db = getDb();
  const info = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  if (!info.changes) return sendError(res, 404, '分类不存在');
  sendJson(res, 200, { deleted: true });
}

/* ---------- 书签 ---------- */

function buildBookmarkSelect() {
  return `
    SELECT b.id, b.category_id, b.title, b.url, b.notes, b.tags, b.favicon,
           b.click_count, b.last_visited_at, b.health_status, b.health_code,
           b.last_checked_at, b.created_at, b.updated_at,
           c.name AS category_name
    FROM bookmarks b
    LEFT JOIN categories c ON c.id = b.category_id
  `;
}

function listBookmarks(req, res, _match, url) {
  const db = getDb();
  const params = url.searchParams;
  const categoryId = params.get('category_id');
  const health = params.get('health');
  const q = params.get('q');
  const tag = params.get('tag');
  const sort = SORTS[params.get('sort')] || SORTS.clicks;

  const where = [];
  const args = [];
  if (categoryId) {
    if (categoryId === 'none') {
      where.push('b.category_id IS NULL');
    } else if (/^\d+$/.test(categoryId)) {
      where.push('b.category_id = ?');
      args.push(Number(categoryId));
    }
  }
  if (health && ['unknown', 'ok', 'dead', 'error'].includes(health)) {
    where.push('b.health_status = ?');
    args.push(health);
  }
  if (q && q.trim()) {
    const like = `%${escapeLike(q.trim())}%`;
    where.push(`(b.title LIKE ? ESCAPE '\\' OR b.url LIKE ? ESCAPE '\\'
                 OR b.notes LIKE ? ESCAPE '\\' OR b.tags LIKE ? ESCAPE '\\')`);
    args.push(like, like, like, like);
  }
  if (tag) {
    where.push("(',' || b.tags || ',') LIKE ? ESCAPE '\\'");
    args.push(`%,${escapeLike(tag)},%`);
  }

  const sql = `${buildBookmarkSelect()}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${sort}`;
  const rows = db.prepare(sql).all(...args);
  sendJson(res, 200, { bookmarks: rows, total: rows.length });
}

async function createBookmark(req, res) {
  const body = await readBody(req, res);
  if (body === TOO_LARGE) return;
  if (!body) return sendError(res, 400, '请求体无效');
  const title = body.title != null ? String(body.title).trim() : '';
  const url = body.url != null ? String(body.url).trim() : '';
  if (!title || !url) return sendError(res, 400, '标题和网址不能为空');
  if (!validUrl(url)) return sendError(res, 400, '网址必须以 http:// 或 https:// 开头');

  const db = getDb();
  if (body.category_id != null) {
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(Number(body.category_id));
    if (!cat) return sendError(res, 400, '分类不存在');
  }
  const tags = normalizeTags(body.tags) ?? '';
  const info = db.prepare(`
    INSERT INTO bookmarks (category_id, title, url, notes, tags, favicon)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    body.category_id != null ? Number(body.category_id) : null,
    title,
    url,
    body.notes != null ? String(body.notes).trim() : '',
    tags,
    body.favicon != null ? String(body.favicon).trim() : ''
  );
  const newId = Number(info.lastInsertRowid);
  const row = db.prepare(`${buildBookmarkSelect()} WHERE b.id = ?`).get(newId);
  // 添加完成后自动在后台检查链接有效性（不阻塞响应；track=false 不占用批量检查进度）
  runHealthCheck([{ id: newId, url }], { track: false })
    .catch((e) => console.error(`[api] 书签 #${newId} 自动健康检查失败:`, e));
  sendJson(res, 201, { bookmark: row });
}

function getBookmark(_req, res, match) {
  const id = parseId(match);
  const db = getDb();
  const row = db.prepare(`${buildBookmarkSelect()} WHERE b.id = ?`).get(id);
  if (!row) return sendError(res, 404, '书签不存在');
  sendJson(res, 200, { bookmark: row });
}

/** 站点图标：优先本地缓存，未缓存则按需从站点抓取（结果缓存到 data/favicons/） */
async function getBookmarkFavicon(_req, res, match) {
  const id = parseId(match);
  const result = await getFavicon(id);
  if (result.status !== 200) {
    return sendError(res, 404, result.error || '图标不可用');
  }
  res.writeHead(200, {
    'Content-Type': result.type,
    'Cache-Control': 'private, max-age=86400',
    'Content-Length': result.buf.length,
  });
  res.end(result.buf);
}

async function updateBookmark(req, res, match) {
  const id = parseId(match);
  const body = await readBody(req, res);
  if (body === TOO_LARGE) return;
  if (!body) return sendError(res, 400, '请求体无效');
  const db = getDb();
  const cur = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  if (!cur) return sendError(res, 404, '书签不存在');

  const next = {
    category_id: body.category_id !== undefined ? body.category_id : cur.category_id,
    title: body.title !== undefined ? String(body.title).trim() : cur.title,
    url: body.url !== undefined ? String(body.url).trim() : cur.url,
    notes: body.notes !== undefined ? String(body.notes).trim() : cur.notes,
    tags: body.tags !== undefined ? (normalizeTags(body.tags) ?? '') : cur.tags,
    favicon: body.favicon !== undefined ? String(body.favicon).trim() : cur.favicon,
  };
  if (!next.title || !next.url) return sendError(res, 400, '标题和网址不能为空');
  if (!validUrl(next.url)) return sendError(res, 400, '网址必须以 http:// 或 https:// 开头');
  if (next.category_id != null) {
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(Number(next.category_id));
    if (!cat) return sendError(res, 400, '分类不存在');
  }
  // URL 变化时清理旧 favicon 缓存（新 URL 的图标按需重新提取）
  if (next.url !== cur.url) invalidateFavicon(id);

  db.prepare(`
    UPDATE bookmarks SET category_id = ?, title = ?, url = ?, notes = ?, tags = ?, favicon = ?,
           updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(
    next.category_id != null ? Number(next.category_id) : null,
    next.title, next.url, next.notes, next.tags, next.favicon, id
  );
  const row = db.prepare(`${buildBookmarkSelect()} WHERE b.id = ?`).get(id);
  // 编辑保存后自动在后台重新检查链接有效性（不阻塞响应）
  runHealthCheck([{ id, url: next.url }], { track: false })
    .catch((e) => console.error(`[api] 书签 #${id} 编辑后健康检查失败:`, e));
  sendJson(res, 200, { bookmark: row });
}

function deleteBookmark(_req, res, match) {
  const id = parseId(match);
  const db = getDb();
  const info = db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  if (!info.changes) return sendError(res, 404, '书签不存在');
  invalidateFavicon(id); // 清理缓存图标文件
  sendJson(res, 200, { deleted: true });
}

/** 访问统计：点击 +1 并记录访问时间（供前端与插件调用） */
function visitBookmark(_req, res, match) {
  const id = parseId(match);
  const db = getDb();
  const cur = db.prepare('SELECT id FROM bookmarks WHERE id = ?').get(id);
  if (!cur) return sendError(res, 404, '书签不存在');
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO visits (bookmark_id) VALUES (?)').run(id);
    db.prepare(`
      UPDATE bookmarks
      SET click_count = click_count + 1,
          last_visited_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const row = db.prepare('SELECT click_count, last_visited_at FROM bookmarks WHERE id = ?').get(id);
  sendJson(res, 200, row);
}

/* ---------- 健康检查 ---------- */

async function checkOne(_req, res, match) {
  const id = parseId(match);
  const db = getDb();
  const cur = db.prepare('SELECT id, url FROM bookmarks WHERE id = ?').get(id);
  if (!cur) return sendError(res, 404, '书签不存在');
  // track=false：单条检查不占用、不重置批量检查的进度
  const [result] = await runHealthCheck([cur], { track: false });
  sendJson(res, 200, { bookmark: result });
}

function checkAll(_req, res) {
  const db = getDb();
  const job = getHealthJob();
  if (job.running) return sendJson(res, 409, { error: '健康检查已在运行中', job });
  const rows = db.prepare('SELECT id, url FROM bookmarks').all();
  if (!rows.length) return sendJson(res, 200, { started: false, total: 0 });
  // 后台异步执行，不阻塞请求
  runHealthCheck(rows).catch((e) => console.error('[health] 批量检查失败:', e));
  sendJson(res, 202, { started: true, total: rows.length });
}

function checkAllStatus(_req, res) {
  sendJson(res, 200, { job: getHealthJob() });
}

/* ---------- 统计 ---------- */

function getStats(_req, res) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS n FROM bookmarks').get().n;
  const totalClicks = db.prepare('SELECT COALESCE(SUM(click_count), 0) AS n FROM bookmarks').get().n;
  const categoryCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  const todayVisits = db.prepare(
    "SELECT COUNT(*) AS n FROM visits WHERE date(visited_at) = date('now', 'localtime')"
  ).get().n;
  const healthDist = db.prepare(
    'SELECT health_status, COUNT(*) AS n FROM bookmarks GROUP BY health_status'
  ).all();
  const last7Days = db.prepare(`
    SELECT date(visited_at) AS day, COUNT(*) AS n
    FROM visits
    WHERE visited_at >= datetime('now', 'localtime', '-7 days')
    GROUP BY date(visited_at) ORDER BY day
  `).all();
  const topBookmarks = db.prepare(`
    SELECT id, title, url, click_count FROM bookmarks
    ORDER BY click_count DESC, last_visited_at DESC LIMIT 5
  `).all();
  sendJson(res, 200, {
    total, totalClicks, categoryCount, todayVisits, healthDist, last7Days, topBookmarks,
  });
}

function serviceHealth(_req, res) {
  try {
    getDb().prepare('SELECT 1').get();
    sendJson(res, 200, { ok: true, service: 'bookmark-nas', time: new Date().toISOString() });
  } catch {
    sendJson(res, 503, { ok: false, service: 'bookmark-nas' });
  }
}

/* ---------- 路由分发 ---------- */

const routes = [
  ['GET', /^\/api\/categories$/, listCategories],
  ['POST', /^\/api\/categories$/, createCategory],
  ['PUT', /^\/api\/categories\/(\d+)$/, updateCategory],
  ['DELETE', /^\/api\/categories\/(\d+)$/, deleteCategory],
  ['GET', /^\/api\/bookmarks$/, listBookmarks],
  ['POST', /^\/api\/bookmarks$/, createBookmark],
  ['GET', /^\/api\/bookmarks\/(\d+)$/, getBookmark],
  ['GET', /^\/api\/bookmarks\/(\d+)\/favicon$/, getBookmarkFavicon],
  ['PUT', /^\/api\/bookmarks\/(\d+)$/, updateBookmark],
  ['DELETE', /^\/api\/bookmarks\/(\d+)$/, deleteBookmark],
  ['POST', /^\/api\/bookmarks\/(\d+)\/visit$/, visitBookmark],
  ['POST', /^\/api\/bookmarks\/(\d+)\/check$/, checkOne],
  ['POST', /^\/api\/check-all$/, checkAll],
  ['GET', /^\/api\/check-all\/status$/, checkAllStatus],
  ['GET', /^\/api\/stats$/, getStats],
  ['GET', /^\/api\/health$/, serviceHealth],
];

/** 处理 /api/* 请求；未匹配返回 404 */
export async function handleApi(req, res, url) {
  for (const [method, pattern, handler] of routes) {
    if (method !== req.method) continue;
    const match = url.pathname.match(pattern);
    if (!match) continue;
    try {
      await handler(req, res, match, url);
    } catch (e) {
      console.error(`[api] ${req.method} ${url.pathname} 失败:`, e);
      if (!res.headersSent) sendError(res, 500, '服务器内部错误');
      else res.end();
    }
    return;
  }
  sendError(res, 404, '接口不存在');
}
