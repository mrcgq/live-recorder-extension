'use strict';

// ============================================================
// Background Service Worker
// ============================================================

let popupPort = null;

// ---- 长连接（popup 主动连接）----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPort = port;
  port.onDisconnect.addListener(() => { popupPort = null; });
  port.onMessage.addListener((msg) => {
    console.log('[bg] from popup:', msg.action);
  });
});

// ---- 短消息 ----
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  // 获取 Tab Stream ID（内录核心）
  if (req.action === 'getTabStreamId') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.length) { sendResponse({ error: 'no_tab' }); return; }
      try {
        chrome.tabCapture.getMediaStreamId(
          { targetTabId: tabs[0].id },
          (streamId) => {
            if (chrome.runtime.lastError) {
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
    return true;
  }

  // 文件下载
  if (req.action === 'download') {
    chrome.downloads.download({
      url           : req.url,
      filename      : req.filename || 'recording.webm',
      saveAs        : req.saveAs  || false,
      conflictAction: 'uniquify',
    }, (id) => sendResponse({ downloadId: id }));
    return true;
  }

  // 系统通知
  if (req.action === 'notify') {
    chrome.notifications.create({
      type    : 'basic',
      iconUrl : 'icons/icon128.png',
      title   : '🎬 直播内录器',
      message : req.message || '',
    });
    sendResponse({ ok: true });
    return;
  }

  // ★ content.js 点击"录制小视频"按钮 → 转发给 popup 自动开始录制
  if (req.action === 'startRecordFromContent') {
    if (popupPort) {
      popupPort.postMessage({
        action   : 'autoStartRecord',
        videoInfo: req.videoInfo,
      });
    }
    sendResponse({ ok: true });
    return;
  }

  // ★ 打开 popup（Chrome 支持 action.openPopup）
  if (req.action === 'openPopup') {
    // Chrome 127+ 支持
    if (chrome.action?.openPopup) {
      chrome.action.openPopup().catch(() => {});
    }
    sendResponse({ ok: true });
    return;
  }

  // content → popup 的消息转发
  const forwardList = [
    'floatPause', 'floatStop',
    'regionSelected',
    'hotkeyToggle', 'hotkeyPause',
  ];
  if (forwardList.includes(req.action)) {
    if (popupPort) popupPort.postMessage(req);
    sendResponse({ ok: true });
    return;
  }
});

// ---- 快捷键 ----
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'start-stop-recording') {
    popupPort?.postMessage({ action: 'hotkeyToggle' });
  }
  if (cmd === 'pause-recording') {
    popupPort?.postMessage({ action: 'hotkeyPause' });
  }
});
