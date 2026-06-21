'use strict';

// ============================================================
// Background Service Worker
// 职责：
// 1. 提供 tabCapture streamId
// 2. 转发 content.js → popup.js 的消息
// 3. 处理快捷键
// 4. 处理下载
// ============================================================

// 保存 popup 的连接端口
let popupPort = null;

// ---- 长连接（popup 主动连接）----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPort = port;
    port.onDisconnect.addListener(() => {
      popupPort = null;
    });
    port.onMessage.addListener((msg) => {
      // popup → background 的消息处理
      handlePopupMessage(msg, port);
    });
  }
});

// ---- 短消息处理 ----
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // 1. 获取 Tab Stream ID（核心内录功能）
  if (request.action === 'getTabStreamId') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        sendResponse({ error: 'no_active_tab' });
        return;
      }
      const tabId = tabs[0].id;
      try {
        chrome.tabCapture.getMediaStreamId(
          { targetTabId: tabId },
          (streamId) => {
            if (chrome.runtime.lastError) {
              console.warn('[background] tabCapture error:',
                chrome.runtime.lastError.message);
              sendResponse({ error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ streamId });
            }
          }
        );
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true; // 保持异步
  }

  // 2. 触发文件下载
  if (request.action === 'download') {
    chrome.downloads.download({
      url: request.url,
      filename: request.filename || 'recording.webm',
      saveAs: request.saveAs || false,
      conflictAction: 'uniquify',
    }, (downloadId) => {
      sendResponse({ downloadId });
    });
    return true;
  }

  // 3. 显示系统通知
  if (request.action === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '🎬 直播内录器',
      message: request.message || '通知',
    });
    sendResponse({ ok: true });
    return;
  }

  // 4. content.js 转发给 popup 的消息
  // （悬浮窗按钮点击 → 通知 popup 执行操作）
  if (request.action === 'floatPause' ||
      request.action === 'floatStop'  ||
      request.action === 'regionSelected' ||
      request.action === 'hotkeyToggle' ||
      request.action === 'hotkeyPause') {

    // 通过 port 转发给 popup
    if (popupPort) {
      popupPort.postMessage(request);
    }
    sendResponse({ ok: true });
    return;
  }

});

// ---- 快捷键处理 ----
chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;

    if (command === 'start-stop-recording') {
      // 转发给 popup
      if (popupPort) {
        popupPort.postMessage({ action: 'hotkeyToggle' });
      }
    }

    if (command === 'pause-recording') {
      if (popupPort) {
        popupPort.postMessage({ action: 'hotkeyPause' });
      }
    }
  });
});

function handlePopupMessage(msg, port) {
  // 未来扩展：popup → background 的指令
  console.log('[background] from popup:', msg);
}
