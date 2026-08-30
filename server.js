/**
 * 服务入口：HTTP 服务器 + 静态文件 + CORS + 可选 API Token。
 * - 端口：环境变量 PORT（默认 9989），监听 0.0.0.0
 * - API Token：环境变量 BM_TOKEN（或 data/config.json 的 token）。
 *   配置后，跨源请求（浏览器插件等）必须携带
 *   Authorization: Bearer <token> 或 X-API-Token: <token>；
 *   本站网页（同源）与无 Origin 的请求（curl 等）不受影响。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, normalize } from 'node:path';
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

/** 跨源请求才校验 Token：同源网页、无 Origin 的 curl 不受影响 */
function needsToken(req) {
  if (!API_TOKEN) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const o = new URL(origin);
    return o.hostname !== req.headers.host?.split(':')[0];
  } catch {
    return true;
  }
}

/* ---------- 静态文件 ---------- */

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const filePath = resolve(PUBLIC_DIR, '.' + normalize('/' + rel));
  if (!filePath.startsWith(resolve(PUBLIC_DIR))) {
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
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(readFileSync(filePath));
  } catch {
    res.writeHead(500).end('Internal Error');
  }
}

/* ---------- HTTP 入口 ---------- */

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

  if (url.pathname.startsWith('/api/')) {
    if (needsToken(req) && !tokenMatches(req)) {
      res.writeHead(401, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '未授权：请在请求头携带 API Token' }));
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
});

initDb();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`书签工具已启动: http://0.0.0.0:${PORT}`);
  console.log(`数据文件: ${DB_PATH}`);
  if (API_TOKEN) console.log('API Token: 已启用（跨源请求需携带）');
  else console.log('API Token: 未启用（如需供浏览器插件跨源写入，建议设置 BM_TOKEN）');
});

/* 优雅退出 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在关闭…`);
    try {
      getDb().close();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
