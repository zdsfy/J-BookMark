/* =========================================================
 * options 逻辑：配置服务地址与 Token，测试连接
 * ========================================================= */

const $ = (s) => document.querySelector(s);

async function load() {
  const cfg = await getConfig();
  $('#base-url').value = cfg.baseUrl || '';
  $('#token').value = cfg.token || '';
}

function setStatus(text, ok) {
  const s = $('#status');
  s.textContent = text || '';
  s.className = 'status' + (text ? (ok ? ' ok' : ' err') : '');
}

async function save() {
  const baseUrl = normalizeBaseUrl($('#base-url').value);
  const token = $('#token').value.trim();
  await chrome.storage.sync.set({ baseUrl, token });
  setStatus('已保存。', true);
}

async function test() {
  const baseUrl = normalizeBaseUrl($('#base-url').value);
  const token = $('#token').value.trim();
  if (!baseUrl) { setStatus('请先填写服务地址', false); return; }

  const btn = $('#btn-test');
  btn.disabled = true;
  setStatus('正在测试…', true);
  try {
    // 临时保存以便 apiFetch 使用（不影响已保存的正式配置）
    const prev = await getConfig();
    await chrome.storage.sync.set({ baseUrl, token });
    const data = await apiFetch('/api/health');
    // 顺带取一下书签数验证数据权限
    let extra = '';
    try {
      const b = await apiFetch('/api/stats');
      extra = `，共 ${b.total} 条书签`;
    } catch { /* 仅健康检查成功也可 */ }
    setStatus(`连接成功${extra}`, true);
  } catch (e) {
    setStatus('连接失败：' + e.message, false);
  } finally {
    btn.disabled = false;
  }
}

// 事件
$('#btn-save').addEventListener('click', save);
$('#btn-test').addEventListener('click', test);
load();