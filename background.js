'use strict';

// ============================================================
// Background Service Worker v4.1
// 核心修复：
//   FIX-01: startRecordFromContent 时立即在 background 调用
//           getMediaStreamId（保留用户手势上下文），
//           将 streamId 随参数传入 recorder 窗口，
//           彻底消灭"获取捕获权限失败"错误。
//   R-03:   主窗口生命周期联动（录制时最小化，结束后还原）
//   R-02:   recorder 窗口进程同调消费 streamId
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
  activeWindowId   : null,
  recorderWindowId : null,
};

let popupPort = null;

// ── Popup 长连接 ──────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPort = port;
    port.postMessage({ action: 'stateSync', state: recordingState });
    port.onDisconnect.addListener(() => { popupPort = null; });
    port.onMessage.addListener(handlePopupCommand);
  }
});

// ── 录制小窗管理 ─────────────────────────────────────────────
async function ensureRecorderWindow(params) {
  // 复用已存在窗口
  if (recordingState.recorderWindowId) {
    try {
      await chrome.windows.update(recordingState.recorderWindowId, { focused: true });
      return;
    } catch (_) {
      recordingState.recorderWindowId = null;
    }
  }

  const queryString = new URLSearchParams(params).toString();

  const win = await chrome.windows.create({
    url    : 'recorder.html?' + queryString,
    type   : 'popup',
    width  : 900,
    height : 620,
    focused: true,
  });

  recordingState.recorderWindowId = win.id;
}

// ★ R-03：最小化宿主窗口
async function minimizeHostWindow(windowId) {
  if (!windowId) return;
  try {
    await chrome.windows.update(windowId, { state: 'minimized' });
  } catch (e) {
    console.warn('[bg] 最小化失败:', e.message);
  }
}

// ★ R-03：还原宿主窗口
async function restoreHostWindow(windowId) {
  if (!windowId) return;
  try {
    await chrome.windows.update(windowId, { state: 'normal', focused: true });
  } catch (e) {
    console.warn('[bg] 还原窗口失败:', e.message);
  }
}

// 监听录制小窗被意外关闭
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== recordingState.recorderWindowId) return;
  recordingState.recorderWindowId = null;

  if (recordingState.isRecording) {
    recordingState.isRecording = false;
    recordingState.isPaused    = false;
    broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
    broadcastToTab(recordingState.activeTabId, { action: 'removeViewportSanitize' });
    restoreHostWindow(recordingState.activeWindowId);
    recordingState.activeWindowId = null;
    if (popupPort) popupPort.postMessage({ action: 'stateSync', state: recordingState });
  }
});

// ── Popup 指令 ────────────────────────────────────────────────
async function handlePopupCommand(msg) {
  const allowed = ['startRecording','stopRecording','pauseRecording','resumeRecording'];
  if (!allowed.includes(msg.action)) return;

  if (msg.action === 'startRecording') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || !tabs[0]) return;
      const tab      = tabs[0];
      const tabId    = tab.id;
      const windowId = tab.windowId;

      recordingState.activeTabId    = tabId;
      recordingState.activeWindowId = windowId;

      // ★ FIX-01：Popup 触发时，立即在 background 获取 streamId
      // background 是扩展页面，有权调用 tabCapture
      let streamId = null;
      if (chrome.tabCapture) {
        try {
          streamId = await getStreamIdForTab(tabId);
        } catch (e) {
          console.warn('[bg] popup 获取 streamId 失败，将由 recorder 重试:', e.message);
        }
      }

      await minimizeHostWindow(windowId);

      await ensureRecorderWindow({
        tabId    : tabId,
        windowId : windowId,
        streamId : streamId || '',           // ★ 直接传入 streamId
        config   : JSON.stringify(msg.config || {}),
        autoStart: 'true',
      });
    });
  } else {
    chrome.runtime.sendMessage({ ...msg, _target: 'recorder' }).catch(() => {});
  }
}

// ★ FIX-01 核心：在 background 进程同步获取 streamId
// background 是扩展自有页面，拥有完整的 tabCapture 权限
function getStreamIdForTab(tabId) {
  return new Promise((resolve, reject) => {
    if (!chrome.tabCapture) {
      reject(new Error('tabCapture API 不可用'));
      return;
    }
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!streamId) {
          reject(new Error('返回的 streamId 为空'));
        } else {
          resolve(streamId);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

// 文件名安全消毒
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

  // 1. ★ FIX-01：recorder 窗口请求 streamId（兜底路径）
  //    当 background 预取失败时，recorder 可再次请求
  if (req.action === 'getTabStreamId') {
    const tabId = parseInt(req.tabId);
    if (!tabId) { sendResponse({ error: 'invalid_tab_id' }); return; }

    recordingState.activeTabId = tabId;

    if (!chrome.tabCapture) {
      sendResponse({ error: 'tabCapture_unavailable' });
      return;
    }

    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ streamId });
        }
      });
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return true;
  }

  // 2. 实时指标回传
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

  // 3. 录制状态变更
  if (req.action === 'recordingStateChanged') {
    const wasRecording = recordingState.isRecording;
    Object.assign(recordingState, req.state);

    if (popupPort) {
      popupPort.postMessage({ action: 'stateSync', state: recordingState });
    }

    if (!req.state.isRecording) {
      broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
      // ★ R-01：录制结束，通知 content 移除视口清洗
      broadcastToTab(recordingState.activeTabId, { action: 'removeViewportSanitize' });
      // ★ R-03：还原宿主窗口
      if (wasRecording && recordingState.activeWindowId) {
        restoreHostWindow(recordingState.activeWindowId);
        recordingState.activeWindowId = null;
      }
    }

    sendResponse({ ok: true });
    return;
  }

  // 4. 安全下载（唯一入口）
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

      function onChanged(delta) {
        if (delta.id !== downloadId) return;
        const st = delta.state && delta.state.current;
        if (st === 'complete' || st === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChanged);
          chrome.runtime.sendMessage(
            { _target: 'recorder', action: 'releaseBlobUrl', url: req.url }
          ).catch(() => {});
        }
      }
      chrome.downloads.onChanged.addListener(onChanged);
    });
    return true;
  }

  // 5. ★ FIX-01 核心路径：content 触发录制
  //    在 background 立即获取 streamId（此时仍在用户手势上下文），
  //    再将 streamId 传入 recorder 窗口
  if (req.action === 'startRecordFromContent') {
    const tab      = sender.tab;
    const tabId    = tab && tab.id;
    const windowId = tab && tab.windowId;

    if (!tabId) { sendResponse({ error: 'no_tab_id' }); return; }

    recordingState.activeTabId    = tabId;
    recordingState.activeWindowId = windowId;

    const config = req.config || {};

    // ★ 关键：立即在 background 获取 streamId
    //   此时距离用户点击事件最近，手势上下文仍有效
    getStreamIdForTab(tabId)
      .then(async (streamId) => {
        // 获取成功 → 最小化宿主窗口 → 打开 recorder（携带 streamId）
        await minimizeHostWindow(windowId);

        await ensureRecorderWindow({
          tabId    : tabId,
          windowId : windowId,
          streamId : streamId,            // ★ 直接携带有效的 streamId
          config   : JSON.stringify(config),
          autoStart: 'true',
        });

        sendResponse({ ok: true });
      })
      .catch(async (e) => {
        console.error('[bg] 获取 streamId 失败:', e.message);

        // 降级：不传 streamId，让 recorder 窗口自行重试
        await minimizeHostWindow(windowId);
        await ensureRecorderWindow({
          tabId    : tabId,
          windowId : windowId,
          streamId : '',
          config   : JSON.stringify(config),
          autoStart: 'true',
        });

        sendResponse({ ok: true, warn: e.message });
      });

    return true; // 异步
  }

  // 6. 显示悬浮控制条
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
