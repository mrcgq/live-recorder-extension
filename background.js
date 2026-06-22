'use strict';

// ============================================================
// Background Service Worker - 完整修复版 v2.3
// 修复：autoStart 参数透传、activeTabId 时序锚定、
//       窗口异常关闭触发紧急保存、下载 Blob 生命周期闭环
// ============================================================

let recordingState = {
  isRecording      : false,
  isPaused         : false,
  quality          : 'hd',
  seconds          : 0,
  sizeString       : '0B',
  bitrate          : '0kbps',
  resolution       : '-',
  timeString       : '00:00:00',
  activeTabId      : null,
  recorderWindowId : null,
};

let popupPort = null;

// ── Popup 长连接 ──────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPort = port;
  port.postMessage({ action: 'stateSync', state: recordingState });
  port.onDisconnect.addListener(() => { popupPort = null; });
  port.onMessage.addListener(handlePopupCommand);
});

// ── 录制窗口管理 ──────────────────────────────────────────────
async function ensureRecorderWindow(config, tabId, autoStart) {
  if (recordingState.recorderWindowId) {
    try {
      await chrome.windows.update(recordingState.recorderWindowId, { focused: true });
      return;
    } catch (_) {
      recordingState.recorderWindowId = null;
    }
  }

  const queryParams = new URLSearchParams({
    tabId    : tabId || '',
    config   : JSON.stringify(config || {}),
    autoStart: autoStart ? 'true' : 'false',
  });

  const win = await chrome.windows.create({
    url    : 'recorder.html?' + queryParams.toString(),
    type   : 'popup',
    width  : 850,
    height : 600,
    focused: true,
  });

  recordingState.recorderWindowId = win.id;
}

// 监听录制窗口被意外关闭
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== recordingState.recorderWindowId) return;
  recordingState.recorderWindowId = null;

  if (recordingState.isRecording) {
    recordingState.isRecording = false;
    recordingState.isPaused    = false;
    broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
    if (popupPort) popupPort.postMessage({ action: 'stateSync', state: recordingState });
  }
});

// ── Popup 指令 ────────────────────────────────────────────────
async function handlePopupCommand(msg) {
  if (!['startRecording','stopRecording','pauseRecording','resumeRecording'].includes(msg.action)) return;

  if (msg.action === 'startRecording') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || !tabs[0]) return;
      const tabId = tabs[0].id;
      recordingState.activeTabId = tabId;
      // Popup 打开 → autoStart=false，用户手动点击录制按钮
      await ensureRecorderWindow(msg.config || {}, tabId, false);
    });
  } else {
    chrome.runtime.sendMessage({ ...msg, _target: 'recorder' }).catch(() => {});
  }
}

// ── 文件名消毒 ────────────────────────────────────────────────
function sanitizeFilename(raw) {
  if (!raw || typeof raw !== 'string') return 'recording.webm';
  return raw
    .replace(/[/\\]/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^[.\s]+/, '')
    .slice(0, 200) || 'recording.webm';
}

// ── 消息路由 ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  // 1. 获取 Tab Stream ID
  if (req.action === 'getTabStreamId') {
    const tabId = parseInt(req.tabId);
    if (!tabId) { sendResponse({ error: 'invalid_tab_id' }); return; }
    recordingState.activeTabId = tabId; // ★ 精确锚定

    if (!chrome.tabCapture) { sendResponse({ error: 'tabCapture_unavailable' }); return; }
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ streamId });
        }
      });
    } catch (e) { sendResponse({ error: e.message }); }
    return true;
  }

  // 2. 实时指标
  if (req.action === 'metricsUpdate') {
    Object.assign(recordingState, {
      isRecording: req.isRecording,
      isPaused   : req.isPaused,
      timeString : req.timeString,
      sizeString : req.sizeString,
      bitrate    : req.bitrate,
      resolution : req.resolution,
    });
    if (popupPort) {
      popupPort.postMessage({
        action: 'metricsUpdate',
        isRecording: req.isRecording, isPaused: req.isPaused,
        timeString: req.timeString,   sizeString: req.sizeString,
        bitrate: req.bitrate,         resolution: req.resolution,
        fps: req.fps,                 cpu: req.cpu,
      });
    }
    broadcastToTab(recordingState.activeTabId, {
      action: 'updateFloat', paused: req.isPaused, time: req.timeString,
    });
    sendResponse({ ok: true });
    return;
  }

  // 3. 状态变更
  if (req.action === 'recordingStateChanged') {
    Object.assign(recordingState, req.state);
    if (popupPort) popupPort.postMessage({ action: 'stateSync', state: recordingState });
    if (!req.state.isRecording) {
      broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
    }
    sendResponse({ ok: true });
    return;
  }

  // 4. 安全下载（唯一入口）
  if (req.action === 'triggerDownload') {
    const safeName = sanitizeFilename(req.filename);
    chrome.downloads.download({
      url: req.url, filename: safeName,
      conflictAction: 'uniquify', saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        chrome.runtime.sendMessage({ _target: 'recorder', action: 'releaseBlobUrl', url: req.url }).catch(() => {});
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ downloadId });

      function onChanged(delta) {
        if (delta.id !== downloadId) return;
        const state = delta.state && delta.state.current;
        if (state === 'complete' || state === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChanged);
          chrome.runtime.sendMessage({ _target: 'recorder', action: 'releaseBlobUrl', url: req.url }).catch(() => {});
        }
      }
      chrome.downloads.onChanged.addListener(onChanged);
    });
    return true;
  }

  // 5. content 触发录制
  if (req.action === 'startRecordFromContent') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ error: 'cannot_determine_tabId' }); return; }
    recordingState.activeTabId = tabId;

    const config    = req.config || {};
    const autoStart = config.autoStart === true;

    ensureRecorderWindow(config, tabId, autoStart).then(() => sendResponse({ ok: true }));
    return true;
  }

  // 6. 显示悬浮窗
  if (req.action === 'showFloat') {
    const pos = req.position || 'top-right';
    if (recordingState.activeTabId) {
      broadcastToTab(recordingState.activeTabId, { action: 'showFloat', position: pos });
    } else {
      broadcastToActiveTab({ action: 'showFloat', position: pos });
    }
    sendResponse({ ok: true });
    return;
  }

  // 7. 通知
  if (req.action === 'notify') {
    if (chrome.notifications) {
      chrome.notifications.create('rec_' + Date.now(), {
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: '🎬 直播内录器', message: req.message || '',
      });
    }
    sendResponse({ ok: true });
    return;
  }

  // 8. 悬浮窗控制
  if (req.action === 'floatPause' || req.action === 'floatStop') {
    chrome.runtime.sendMessage({
      _target: 'recorder',
      action : req.action === 'floatStop' ? 'stopRecording' : 'pauseRecording',
    }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false });
});

function broadcastToTab(tabId, msg) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, msg, () => { void chrome.runtime.lastError; });
}

function broadcastToActiveTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, () => { void chrome.runtime.lastError; });
  });
}
