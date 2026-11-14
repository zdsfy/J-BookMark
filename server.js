/**
 * 服务入口：HTTP 服务器 + 静态文件 + 跨源访问控制 + 可选 API Token。
 * - 端口：环境变量 PORT（默认 9989），监听 0.0.0.0
 * - API Token：环境变量 BM_TOKEN（或 data/config.json 的 token）。设置后，
 *   任何「非同源、非白名单」的跨源请求都必须携带
 *   Authorization: Bearer <token> 或 X-API-Token: <token>，否则返回 401。
 * - 跨源白名单：环境变量 BM_CORS_ORIGINS（逗号分隔的完整 Origin），
 *   供浏览器插件等可信来源配置；白名单请求无需 Token。
 * - 同源网页（本站前端）与无 Origin 的请求（curl、内网脚本）不受影响。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, normalize, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { initDb, getDb, DB_PATH, DATA_DIR } from './src/db.js';
import { handleApi } from './src/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 9989;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/* ---------- API Token 配置 ---------- */

function loadToken() {
  if (process.env.BM_TOKEN) return process.env.BM_TOKEN;
  const cfgPath = join(DATA_DIR, 'config.json');
  try {
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (typeof cfg.token === 'string' && cfg.token) return cfg.token;
    }
  } catch (e) {
    console.error('[server] 读取 data/config.json 失败:', e.message);
  }
  return null;
}

const API_TOKEN = loadToken();

function tokenMatches(req) {
  const header = req.headers.authorization || req.headers['x-api-token'] || '';
  return header.replace(/^Bearer\s+/i, '').trim() === API_TOKEN;
}

/* ---------- 跨源访问控制 ----------
 * 规则（按优先级）：
 *   1. 无 Origin（curl、内网脚本）→ 放行；
 *   2. Origin 与请求 Host 完全一致（协议 + host:port 同源）→ 放行；\
 *      注意：只比 hostname 会导致同 IP 不同端口被误判为同源，这里改为完整比较；
 *   3. Origin 在 BM_CORS_ORIGINS 白名单 → 放行；
 *   4. 其余跨源请求 → 必须携带合法 Token，否则拒绝。
 */

const CORS_ORIGINS = (process.env.BM_CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function parseOrigin(req) {
  const h = req.headers.origin;
  if (!h) return null;
  try {
    return new URL(h);
  } catch {
    return null;
  }
}

function isSameOrigin(o, req) {
  if (!o) return false;
  const host = req.headers.host || '';
  return o.host === host && (o.protocol === 'http:' || o.protocol === 'https:');
}

function isCallerAllowed(req) {
  const o = parseOrigin(req);
  if (!o) return true; // 无 Origin 的客户端（curl 等）
  if (isSameOrigin(o, req)) return true; // 本站网页
  if (CORS_ORIGINS.includes(req.headers.origin)) return true; // 显式白名单
  return API_TOKEN ? tokenMatches(req) : false; // 其它跨源：必须带合法 Token
}

function allowOriginHeader(req) {
  return req.headers.origin || '*';
}

/* ---------- 静态文件 ---------- */

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  const filePath = resolve(PUBLIC_DIR, '.' + normalize('/' + rel));
  // 用 relative 判断，避免「public2/」这类同前缀兄弟目录被误放行
  const relToPublic = relative(PUBLIC_DIR, filePath);
  if (relToPublic.startsWith('..') || isAbsolute(relToPublic)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const body = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'Content-Length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(500).end('Internal Error');
  }
}

/* ---------- HTTP 入口 ---------- */

const server = createServer((req, res) => {
  try {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost'); // 固定 base，不吃 Host 头
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    const allowed = isCallerAllowed(req);

    // CORS 预检
    if (req.method === 'OPTIONS') {
      if (!allowed) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': allowOriginHeader(req),
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOriginHeader(req),
      'Vary': 'Origin',
    };

    if (url.pathname.startsWith('/api/')) {
      if (!allowed) {
        res.writeHead(401, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: '未授权：来源不被允许（可通过 BM_CORS_ORIGINS 配置或携带 API Token）',
        }));
        return;
      }
      // 委托给 API 层（其内部写响应头时带上 CORS）
      const origWriteHead = res.writeHead.bind(res);
      res.writeHead = (status, headers) => {
        const merged = { ...corsHeaders, ...headers };
        return origWriteHead(status, merged);
      };
      handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url.pathname);
  } catch (e) {
    // 兜底：任何未预期的异常都不能让进程崩溃
    console.error('[server] 请求处理异常:', e);
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal Error');
    } catch {}
  }
});

initDb();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`书签工具已启动: http://0.0.0.0:${PORT}`);
  console.log(`数据文件: ${DB_PATH}`);
  if (API_TOKEN) console.log('API Token: 已启用（跨源请求需携带）');
  else console.log('API Token: 未启用（跨源白名单之外来源将被拒绝）');
  if (CORS_ORIGINS.length) console.log(`跨源白名单: ${CORS_ORIGINS.join(', ')}`);
});

/* ---------- 优雅退出与崩溃兜底 ---------- */

function shutdown(reason, exitCode = 0) {
  console.error(`[server] 关闭中…原因: ${reason}`);
  try {
    getDb().close();
  } catch {}
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 2000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}

process.on('uncaughtException', (e) => {
  console.error('[server] uncaughtException:', e);
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (r) => {
  console.error('[server] unhandledRejection:',
    r instanceof Error ? r.stack || r.message : JSON.stringify(r));
});