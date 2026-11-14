/**
 * 站点图标（favicon）提取器：按需抓取书签站点图标并缓存到 data/favicons/。
 *
 * 策略（按顺序尝试）：
 *   1. <书签协议>://<host>/favicon.ico
 *   2. 抓首页 HTML，解析 <link rel="icon|shortcut icon|apple-touch-icon"> 的 href
 *
 * 安全与健壮性：
 *   - SSRF 防护：最终 URL 为内网/保留地址（复用 health.isPrivateTarget）则跳过；
 *   - 尺寸/类型校验：图标上限 1.5MB，首页上限 512KB，仅接受 image/* 或 .ico 后缀；
 *   - 并发去重：同一书签同时请求只抓一次；
 *   - 失败负缓存（内存 6 小时 TTL），避免反复对死站发起请求。
 */
import { getDb } from './db.js';
import { isPrivateTarget } from './health.js';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FAVICON_DIR = join(__dirname, '..', 'data', 'favicons');

const TIMEOUT_MS = 6000;
const MAX_ICON_BYTES = 1.5 * 1024 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const UA = 'bookmark-nas/0.1';
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000; // 失败负缓存 6 小时

const MIME_BY_EXT = {
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

/** content-type → 扩展名；不认识的图片类型按 url 后缀兜底，否则 null */
function extFromContentType(type, url) {
  const t = (type || '').toLowerCase().split(';')[0].trim();
  if (/^image\/x-icon$/.test(t) || /^image\/vnd\.microsoft\.icon$/.test(t)) return 'ico';
  if (t === 'image/png') return 'png';
  if (t === 'image/jpeg') return 'jpg';
  if (t === 'image/svg+xml') return 'svg';
  if (t === 'image/webp') return 'webp';
  if (t === 'image/avif') return 'avif';
  if (t === 'image/gif') return 'gif';
  if (t.startsWith('image/')) {
    const fromUrl = (url.match(/\.([a-z0-9]+)(?:[?#]|$)/i) || [])[1];
    if (fromUrl && (fromUrl === 'png' || fromUrl === 'jpg' || fromUrl === 'jpeg' ||
        fromUrl === 'svg' || fromUrl === 'webp' || fromUrl === 'ico' || fromUrl === 'gif')) {
      return fromUrl === 'jpeg' ? 'jpg' : fromUrl;
    }
  }
  return null;
}

/** 并发去重：id → 进行中的 Promise */
const inflight = new Map();
/** 失败负缓存：id → 失败时间戳 */
const failedAt = new Map();

/* ---------- 内部工具 ---------- */

function findCached(id) {
  try {
    if (!existsSync(FAVICON_DIR)) return null;
    const files = readdirSync(FAVICON_DIR).filter((f) => f.startsWith(`${id}.`));
    if (!files.length) return null;
    const f = files[0];
    const ext = f.split('.').pop();
    if (!(ext in MIME_BY_EXT)) return null;
    const buf = readFileSync(join(FAVICON_DIR, f));
    if (!buf.length) return null;
    return { buf, type: MIME_BY_EXT[ext] };
  } catch {
    return null;
  }
}

function cleanupOld(id, keepExt = null) {
  try {
    if (!existsSync(FAVICON_DIR)) return;
    for (const f of readdirSync(FAVICON_DIR)) {
      if (f.startsWith(`${id}.`) && f.endsWith(`.${keepExt}`) === false) {
        const ext = f.split('.').pop();
        if (keepExt == null || ext !== keepExt) {
          try { unlinkSync(join(FAVICON_DIR, f)); } catch {}
        }
      }
    }
  } catch {}
}

/** 删除某书签的所有缓存图标（编辑 URL、删除书签时调用） */
export function invalidateFavicon(id) {
  cleanupOld(id);
  failedAt.delete(id);
}

/* ---------- 抓取 ---------- */

async function fetchBytes(url, maxBytes, accept) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': UA, Accept: accept || '*/*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const finalUrl = res.url || url;
  // SSRF：跟随重定向后的最终地址如果是内网，拒绝
  if (isPrivateTarget(finalUrl)) throw new Error('目标为内网地址，已跳过');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > maxBytes) throw new Error(`响应体超限(${buf.length}B)`);
  return { buf, type: res.headers.get('content-type') || '', finalUrl };
}

async function fetchSiteIcon(url) {
  const u = new URL(url);
  const origin = u.origin;

  // 1) 标准路径 /favicon.ico
  try {
    const { buf, type, finalUrl } = await fetchBytes(`${origin}/favicon.ico`, MAX_ICON_BYTES);
    const ext = extFromContentType(type, finalUrl) || 'ico';
    return { buf, ext };
  } catch {}

  // 2) 首页 HTML 里的 <link rel="icon">（含 apple-touch-icon、shortcut icon）
  try {
    const { buf: html } = await fetchBytes(`${origin}/`, MAX_PAGE_BYTES, 'text/html');
    const text = html.toString('utf8');
    const m = text.match(/<link\b[^>]*>/gi);
    const candidates = [];
    for (const tag of m || []) {
      const rel = tag.match(/\brel=["']([^"']*)["']/i);
      const href = tag.match(/\bhref=["']([^"']*)["']/i);
      if (!rel || !href) continue;
      if (!/icon/i.test(rel[1])) continue;
      candidates.push(href[1]);
    }
    // apple-touch-icon 优先（通常分辨率更高），其次第一个 icon
    const pick = candidates.find((h) => /apple-touch-icon/i.test(h)) || candidates[0];
    if (!pick) throw new Error('未找到 icon link');
    if (/^data:/i.test(pick)) throw new Error('data: 图标不支持');
    const abs = new URL(pick, `${origin}/`).href;
    const { buf, type, finalUrl } = await fetchBytes(abs, MAX_ICON_BYTES);
    const ext = extFromContentType(type, finalUrl);
    if (!ext) throw new Error('非法图片类型');
    return { buf, ext };
  } catch {
    throw new Error('未提取到站点图标');
  }
}

/* ---------- 对外接口 ---------- */

/**
 * 获取书签图标；返回 { status: 200, buf, type } 或 { status: 404, error }。
 * 优先磁盘缓存 → 内存负缓存 → 并发去重抓取。
 */
export async function getFavicon(id) {
  // 1) 磁盘缓存
  const cached = findCached(id);
  if (cached) return { status: 200, ...cached };

  // 2) 失败负缓存
  const failTime = failedAt.get(id);
  if (failTime && Date.now() - failTime < NEGATIVE_TTL_MS) {
    return { status: 404, error: '图标不可用（缓存）' };
  }

  // 3) 并发去重
  if (inflight.has(id)) return inflight.get(id);

  const task = (async () => {
    const db = getDb();
    const row = db.prepare('SELECT url FROM bookmarks WHERE id = ?').get(id);
    if (!row) return { status: 404, error: '书签不存在' };
    if (!row.url || isPrivateTarget(row.url)) {
      return { status: 404, error: '内网/保留地址不提取图标' };
    }
    try {
      const { buf, ext } = await fetchSiteIcon(row.url);
      mkdirSync(FAVICON_DIR, { recursive: true });
      cleanupOld(id, ext); // 清理同 id 的旧扩展名文件
      writeFileSync(join(FAVICON_DIR, `${id}.${ext}`), buf);
      failedAt.delete(id);
      return { status: 200, buf, type: MIME_BY_EXT[ext] || 'image/x-icon' };
    } catch (e) {
      failedAt.set(id, Date.now());
      return { status: 404, error: e.message };
    }
  })();

  inflight.set(id, task);
  try {
    return await task;
  } finally {
    inflight.delete(id);
  }
}