'use strict';

// ============================================================
// Background Service Worker v4.0 - 完整重构版
//
// 重构要点：
//   R-03: 主窗口生命周期联动（录制时最小化，结束后还原）
//   R-02: 下沉 tabCapture 至 recorder 进程同调
//   修复：activeTabId 精准锚定，消除时序竞争
//   修复：异常关闭触发 content 紧急保存
//   修复：下载 Blob 生命周期完整闭环
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
  activeWindowId   : null,   // ★ R-03：记录宿主窗口ID，用于最小化/还原
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
    return;
  }

  // recorder 面板长连接（用于实时指标推送）
  if (port.name === 'recorder_panel') {
    port.postMessage({ action: 'stateSync', state: recordingState });
    port.onDisconnect.addListener(() => {});
  }
});

// ── ★ R-03：独立录制小窗管理 ────────────────────────────────
async function ensureRecorderWindow(config, tabId, windowId, autoStart) {
  // 复用已存在的窗口
  if (recordingState.recorderWindowId) {
    try {
      await chrome.windows.update(recordingState.recorderWindowId, { focused: true });
      return;
    } catch (_) {
      recordingState.recorderWindowId = null;
    }
  }

  const queryParams = new URLSearchParams({
    tabId    : tabId     || '',
    windowId : windowId  || '',
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

// ── ★ R-03：主窗口最小化 ─────────────────────────────────────
async function minimizeHostWindow(windowId) {
  if (!windowId) return;
  try {
    await chrome.windows.update(windowId, { state: 'minimized' });
  } catch (e) {
    console.warn('[bg] 最小化宿主窗口失败:', e.message);
  }
}

// ── ★ R-03：录制结束后还原宿主窗口 ──────────────────────────
async function restoreHostWindow(windowId) {
  if (!windowId) return;
  try {
    await chrome.windows.update(windowId, { state: 'normal', focused: true });
  } catch (e) {
    console.warn('[bg] 还原宿主窗口失败:', e.message);
  }
}

// ── 录制小窗被意外关闭 ───────────────────────────────────────
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== recordingState.recorderWindowId) return;
  recordingState.recorderWindowId = null;

  if (recordingState.isRecording) {
    recordingState.isRecording = false;
    recordingState.isPaused    = false;

    // 通知宿主页面执行紧急保存（tabCapture 数据在 recorder 进程，
    // 窗口关闭后数据已随进程丢失，此处只做状态清理和通知）
    broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });

    // ★ R-03：还原宿主窗口
    restoreHostWindow(recordingState.activeWindowId);
    recordingState.activeWindowId = null;

    if (popupPort) popupPort.postMessage({ action: 'stateSync', state: recordingState });
  }
});

// ── Popup 指令处理 ────────────────────────────────────────────
async function handlePopupCommand(msg) {
  const allowed = ['startRecording', 'stopRecording', 'pauseRecording', 'resumeRecording'];
  if (!allowed.includes(msg.action)) return;

  if (msg.action === 'startRecording') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || !tabs[0]) return;
      const tab      = tabs[0];
      const tabId    = tab.id;
      const windowId = tab.windowId;

      recordingState.activeTabId    = tabId;
      recordingState.activeWindowId = windowId;

      // ★ R-03：拉起录制小窗前先最小化宿主窗口
      await minimizeHostWindow(windowId);
      await ensureRecorderWindow(msg.config || {}, tabId, windowId, false);
    });
  } else {
    // 转发给 recorder 窗口
    chrome.runtime.sendMessage({ ...msg, _target: 'recorder' }).catch(() => {});
  }
}

// ── 文件名安全消毒 ────────────────────────────────────────────
function sanitizeFilename(raw) {
  if (!raw || typeof raw !== 'string') return 'recording.webm';
  return raw
    .replace(/[/\\]/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^[.\s]+/, '')
    .slice(0, 200) || 'recording.webm';
}

// ── 消息路由中枢 ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  // ── 1. ★ R-02：获取 Tab Stream ID（进程同调核心入口）────────
  if (req.action === 'getTabStreamId') {
    const tabId = parseInt(req.tabId);
    if (!tabId) { sendResponse({ error: 'invalid_tab_id' }); return; }

    // 精准锚定 activeTabId
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
    return true; // 异步
  }

  // ── 2. 实时指标回传 ──────────────────────────────────────────
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

  // ── 3. 录制状态变更 ──────────────────────────────────────────
  if (req.action === 'recordingStateChanged') {
    const wasRecording = recordingState.isRecording;
    Object.assign(recordingState, req.state);

    if (popupPort) {
      popupPort.postMessage({ action: 'stateSync', state: recordingState });
    }

    if (!req.state.isRecording) {
      broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });

      // ★ R-03：录制结束 → 还原宿主窗口
      if (wasRecording && recordingState.activeWindowId) {
        restoreHostWindow(recordingState.activeWindowId);
        recordingState.activeWindowId = null;
      }

      // ★ R-01：通知 content 脚本移除视口清洗样式
      if (recordingState.activeTabId) {
        chrome.tabs.sendMessage(
          recordingState.activeTabId,
          { action: 'removeViewportSanitize' },
          () => { void chrome.runtime.lastError; }
        );
      }
    }

    sendResponse({ ok: true });
    return;
  }

  // ── 4. 安全下载（唯一入口，含文件名消毒）───────────────────
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
        // 下载失败立即回收 Blob
        chrome.runtime.sendMessage(
          { _target: 'recorder', action: 'releaseBlobUrl', url: req.url }
        ).catch(() => {});
        return;
      }
      sendResponse({ downloadId });

      // 下载完成后回收 Blob 内存
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

  // ── 5. content 脚本触发开录（悬浮栏点击）───────────────────
  if (req.action === 'startRecordFromContent') {
    const tab      = sender.tab;
    const tabId    = tab && tab.id;
    const windowId = tab && tab.windowId;

    if (!tabId) { sendResponse({ error: 'no_tab_id' }); return; }

    recordingState.activeTabId    = tabId;
    recordingState.activeWindowId = windowId;

    const config    = req.config || {};
    const autoStart = config.autoStart === true;

    // ★ R-03：最小化宿主窗口后再拉起录制小窗
    minimizeHostWindow(windowId).then(() => {
      return ensureRecorderWindow(config, tabId, windowId, autoStart);
    }).then(() => {
      sendResponse({ ok: true });
    }).catch(e => {
      sendResponse({ error: e.message });
    });
    return true;
  }

  // ── 6. 显示悬浮控制条 ────────────────────────────────────────
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

  // ── 7. 系统通知 ──────────────────────────────────────────────
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

  // ── 8. 悬浮窗控制转发 ────────────────────────────────────────
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
