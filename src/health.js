/**
 * 链接健康检查器：对书签 URL 做 HEAD/GET 探测（8 秒超时，4 并发），
 * 结果写入 bookmarks 表并维护内存中的任务进度，供 /api/check-all/status 轮询。
 * 策略：HEAD 优先；服务器不支持 HEAD（405/501）或网络异常时回退 GET。
 * 状态分类：ok(2xx 及 401/403 需登录但可达) / error(其余 4xx-5xx) / dead(网络错误或超时)。
 */
import { getDb } from './db.js';

const CONCURRENCY = 4;
const TIMEOUT_MS = 8000;
const UA = 'bookmark-nas/0.1';

const job = {
  running: false,
  total: 0,
  done: 0,
  ok: 0,
  dead: 0,
  error: 0,
  unknown: 0,
  startedAt: null,
  finishedAt: null,
};

export function getHealthJob() {
  return job;
}

/**
 * 判断目标是否为内网/保留地址。是则跳过探测（避免 SSRF：恶意书签
 * 让 NAS 去扫内网端口，再通过 health_code 回显结果）。
 * 只做 IP 字面量与 localhost 判断；域名解析到内网的情况不在本层处理。
 */
export function isPrivateTarget(u) {
  try {
    const hostname = new URL(u).hostname;
    if (!hostname) return true;
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '0.0.0.0') {
      return true;
    }
    // IPv6 字面量一律视为内网/保留网段，跳过探测
    if (hostname.startsWith('[') || hostname.includes(':')) return true;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false; // 域名，允许探测
    const [a, b] = hostname.split('.').map(Number);
    if (a === 10) return true;            // 10.0.0.0/8
    if (a === 127) return true;           // 127.0.0.0/8 loopback
    if (a === 0) return true;             // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a >= 224) return true;            // 组播/保留
    return false;
  } catch {
    return false;
  }
}

async function probe(url) {
  const attempt = async (method) => {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA, Accept: '*/*' },
    });
    return { code: res.status, dead: false };
  };

  try {
    const head = await attempt('HEAD');
    // 部分服务器不支持 HEAD（405/501），改用 GET 探测（如 Python BaseHTTP 服务）
    if (head.code === 405 || head.code === 501) {
      try {
        return await attempt('GET');
      } catch {
        return head; // GET 也失败则保留 HEAD 的结果
      }
    }
    return head;
  } catch {
    // HEAD 网络异常/超时 → 回退 GET 再试一次
    try {
      return await attempt('GET');
    } catch {
      return { code: 0, dead: true };
    }
  }
}

/**
 * 批量检测。rows: [{ id, url }]，逐个更新数据库。
 * track=false 时不更新任务进度对象（供「添加书签后自动检查」使用，
 * 避免与用户手动触发的批量检查进度相互干扰）。
 * 返回 [{ id, url, health_status, health_code }]
 */
export async function runHealthCheck(rows, { track = true } = {}) {
  if (track) {
    job.running = true;
    job.total = rows.length;
    job.done = 0;
    job.ok = 0;
    job.dead = 0;
    job.error = 0;
    job.unknown = 0;
    job.startedAt = new Date().toISOString();
    job.finishedAt = null;
  }

  const db = getDb();
  const update = db.prepare(`
    UPDATE bookmarks
    SET health_status = ?, health_code = ?,
        last_checked_at = datetime('now', 'localtime')
    WHERE id = ?
  `);

  const results = [];
  let index = 0;

  const worker = async () => {
    while (index < rows.length) {
      const row = rows[index++];
      // SSRF 防护：内网/保留地址直接标记 unknown，不做探测
      if (isPrivateTarget(row.url)) {
        update.run('unknown', null, row.id);
        if (track) {
          job.done++;
          job.unknown++;
        }
        results.push({ id: row.id, url: row.url, health_status: 'unknown', health_code: null });
        continue;
      }
      const p = await probe(row.url);
      // 2xx 以及 401/403（服务可达、仅需登录）视为正常；其余 4xx/5xx 为异常
      const reachable = (p.code >= 200 && p.code < 300) || p.code === 401 || p.code === 403;
      const status = reachable ? 'ok' : p.dead ? 'dead' : 'error';
      update.run(status, p.code || null, row.id);
      if (track) {
        job.done++;
        job[status]++;
      }
      results.push({ id: row.id, url: row.url, health_status: status, health_code: p.code || null });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  if (track) {
    job.running = false;
    job.finishedAt = new Date().toISOString();
  }
  return results;
}
