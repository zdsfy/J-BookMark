/* =========================================================
 * Service Worker（MV3）：右键菜单保存 + 消息处理
 * ========================================================= */
importScripts('common.js');

// 初始化右键菜单
chrome.runtime.onInstalled.addListener(() => {
  createMenus();
});

chrome.runtime.onStartup.addListener(() => {
  createMenus();
});

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'bm-save-page',
      title: '保存此页面到书签',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'bm-save-link',
      title: '保存链接到书签',
      contexts: ['link'],
    });
  });
}

async function saveUrl(title, url) {
  const data = await apiFetch('/api/bookmarks', {
    method: 'POST',
    body: JSON.stringify({ title, url }),
  });
  return data.bookmark;
}

// 右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'bm-save-page') {
      await saveUrl(tab?.title || info.pageUrl, info.pageUrl);
    } else if (info.menuItemId === 'bm-save-link') {
      await saveUrl(info.linkText || info.linkUrl, info.linkUrl);
    }
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '书签已保存',
      message: '已保存到 bookmark-nas',
    });
  } catch (e) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '保存失败',
      message: e.message || '未知错误',
    });
  }
});

// popup/options 通过 runtime message 调用（打开书签时记录访问等）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'trackVisit') {
    trackVisit(msg.id).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true; // 异步响应
  }
  return false;
});