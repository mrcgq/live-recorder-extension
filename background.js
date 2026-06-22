'use strict';

// ============================================================
// Background Service Worker v3.0
// 核心变更：不再使用 tabCapture，改为 content script 直接
// 通过 video.captureStream() 抽取纯净视频流，经 MessageChannel
// 桥接至 recorder 窗口。
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

// ── 录制小窗管理 ─────────────────────────────────────────────
async function ensureRecorderWindow(config, tabId, autoStart) {
  // 若已存在窗口则聚焦复用
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
    width  : 900,
    height : 620,
    focused: true,
  });

  recordingState.recorderWindowId = win.id;
}

// 监听录制窗口被意外关闭 → 通知 content 脚本停止并保存
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== recordingState.recorderWindowId) return;
  recordingState.recorderWindowId = null;

  if (recordingState.isRecording) {
    recordingState.isRecording = false;
    recordingState.isPaused    = false;
    // 通知 content 脚本执行紧急保存
    if (recordingState.activeTabId) {
      chrome.tabs.sendMessage(
        recordingState.activeTabId,
        { action: 'emergencySave' },
        () => { void chrome.runtime.lastError; }
      );
    }
    broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
    if (popupPort) popupPort.postMessage({ action: 'stateSync', state: recordingState });
  }
});

// ── Popup 指令处理 ────────────────────────────────────────────
async function handlePopupCommand(msg) {
  const allowed = ['startRecording','stopRecording','pauseRecording','resumeRecording'];
  if (!allowed.includes(msg.action)) return;

  if (msg.action === 'startRecording') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || !tabs[0]) return;
      const tabId = tabs[0].id;
      recordingState.activeTabId = tabId;
      await ensureRecorderWindow(msg.config || {}, tabId, false);
    });
  } else {
    // 转发给 recorder 窗口
    chrome.runtime.sendMessage({ ...msg, _target: 'recorder' }).catch(() => {});
    // 同时通知 content 脚本（兜底）
    if (recordingState.activeTabId) {
      chrome.tabs.sendMessage(
        recordingState.activeTabId,
        { ...msg, _target: 'content_recorder' },
        () => { void chrome.runtime.lastError; }
      );
    }
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

  // 1. 实时指标回传
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
        action     : 'metricsUpdate',
        isRecording: req.isRecording,
        isPaused   : req.isPaused,
        timeString : req.timeString,
        sizeString : req.sizeString,
        bitrate    : req.bitrate,
        resolution : req.resolution,
        fps        : req.fps,
        cpu        : req.cpu,
      });
    }

    broadcastToTab(recordingState.activeTabId, {
      action: 'updateFloat',
      paused: req.isPaused,
      time  : req.timeString,
    });

    sendResponse({ ok: true });
    return;
  }

  // 2. 录制状态变更
  if (req.action === 'recordingStateChanged') {
    Object.assign(recordingState, req.state);
    if (popupPort) popupPort.postMessage({ action: 'stateSync', state: recordingState });
    if (!req.state.isRecording) {
      broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
    }
    sendResponse({ ok: true });
    return;
  }

  // 3. 安全下载（唯一入口，含文件名消毒）
  if (req.action === 'triggerDownload') {
    const safeName = sanitizeFilename(req.filename);
    chrome.downloads.download({
      url           : req.url,
      filename      : safeName,
      conflictAction: 'uniquify',
      saveAs        : false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        URL.revokeObjectURL(req.url);
        return;
      }
      sendResponse({ downloadId });

      // 下载完成后回收 Blob 内存
      function onChanged(delta) {
        if (delta.id !== downloadId) return;
        const st = delta.state && delta.state.current;
        if (st === 'complete' || st === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChanged);
          // 通知数据持有方释放
          chrome.runtime.sendMessage(
            { _target: 'recorder', action: 'releaseBlobUrl', url: req.url }
          ).catch(() => {});
          // 同时通知 content 脚本释放（若由 content 持有）
          if (recordingState.activeTabId) {
            chrome.tabs.sendMessage(
              recordingState.activeTabId,
              { action: 'releaseBlobUrl', url: req.url },
              () => { void chrome.runtime.lastError; }
            );
          }
        }
      }
      chrome.downloads.onChanged.addListener(onChanged);
    });
    return true;
  }

  // 4. content 脚本触发开录（从悬浮栏点击）
  if (req.action === 'startRecordFromContent') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ error: 'no_tab_id' }); return; }
    recordingState.activeTabId = tabId;

    const config    = req.config || {};
    const autoStart = config.autoStart === true;

    ensureRecorderWindow(config, tabId, autoStart)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // 5. content 脚本上报：已获取到视频流，通知 recorder 窗口接收
  if (req.action === 'videoStreamReady') {
    // recorder 窗口通过 chrome.runtime.sendMessage 接收流信息
    chrome.runtime.sendMessage({
      _target   : 'recorder',
      action    : 'receiveStreamInfo',
      tabId     : sender.tab && sender.tab.id,
      streamInfo: req.streamInfo,
    }).catch(() => {});
    sendResponse({ ok: true });
    return;
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

  // 7. 系统通知
  if (req.action === 'notify') {
    if (chrome.notifications) {
      chrome.notifications.create('rec_' + Date.now(), {
        type    : 'basic',
        iconUrl : 'icons/icon128.png',
        title   : '🎬 直播内录器',
        message : req.message || '',
      });
    }
    sendResponse({ ok: true });
    return;
  }

  // 8. 悬浮窗控制转发
  if (req.action === 'floatPause' || req.action === 'floatStop') {
    const action = req.action === 'floatStop' ? 'stopRecording' : 'pauseRecording';
    chrome.runtime.sendMessage({ _target: 'recorder', action }).catch(() => {});
    if (recordingState.activeTabId) {
      chrome.tabs.sendMessage(
        recordingState.activeTabId,
        { action, _target: 'content_recorder' },
        () => { void chrome.runtime.lastError; }
      );
    }
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false });
});

// ── 工具函数 ─────────────────────────────────────────────────
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
