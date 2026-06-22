'use strict';

// ============================================================
// Background Service Worker v4.0 - 架构重构终极版
//
// 核心架构：
//   录制引擎 100% 在 recorder.js（独立小窗）内运行
//   content.js 只负责：UI悬浮栏 + 视口清洗 + 转发指令
//   background.js 负责：tabCapture streamId下发 + 窗口生命周期
//
// 关键时序（解决"网页不消失"问题）：
//   Step1: content.js 点击 → 通知 background
//   Step2: background 立即获取 streamId（tabCapture 权限在此）
//   Step3: background 立即最小化宿主窗口
//   Step4: background 打开 recorder 窗口，携带 streamId
//   Step5: recorder.js 在自己进程内用 streamId 消费流
//   Step6: tabCapture 保活机制确保最小化的网页持续渲染
//   → 网页消失 + 画面不卡 + 小窗实时预览，完美闭环
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
  activeWindowId   : null,   // 宿主窗口ID，用于最小化/还原
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

// ============================================================
// 窗口生命周期管理
// ============================================================

// 打开/复用录制小窗
async function ensureRecorderWindow(urlParams) {
  if (recordingState.recorderWindowId) {
    try {
      await chrome.windows.update(recordingState.recorderWindowId, { focused: true });
      return;
    } catch (_) {
      recordingState.recorderWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url    : 'recorder.html?' + new URLSearchParams(urlParams).toString(),
    type   : 'popup',
    width  : 900,
    height : 620,
    focused: true,
  });

  recordingState.recorderWindowId = win.id;
}

// ★ 立即最小化宿主窗口（非阻塞，不等待任何异步操作）
// 必须在获取 streamId 之前调用，原因：
//   tabCapture 的 getMediaStreamId 获取 streamId 后，
//   streamId 有短暂有效期（约数秒），此时窗口应已最小化
//   后台 tabCapture 保活机制会保证最小化的页面持续渲染
function minimizeHostWindowNow(windowId) {
  if (!windowId) return;
  chrome.windows.update(windowId, { state: 'minimized' }, () => {
    void chrome.runtime.lastError;
    console.log('[bg] ★ 宿主窗口已最小化 windowId:', windowId);
  });
}

// 录制结束后还原宿主窗口
function restoreHostWindow(windowId) {
  if (!windowId) return;
  chrome.windows.update(windowId, { state: 'normal', focused: true }, () => {
    void chrome.runtime.lastError;
    console.log('[bg] ★ 宿主窗口已还原 windowId:', windowId);
  });
}

// 监听录制小窗被用户直接关闭
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== recordingState.recorderWindowId) return;
  recordingState.recorderWindowId = null;

  if (recordingState.isRecording) {
    recordingState.isRecording = false;
    recordingState.isPaused    = false;

    // 通知 content 清理 UI
    broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
    broadcastToTab(recordingState.activeTabId, { action: 'removeViewportSanitize' });

    // 还原宿主窗口
    restoreHostWindow(recordingState.activeWindowId);
    recordingState.activeWindowId = null;

    if (popupPort) {
      popupPort.postMessage({ action: 'stateSync', state: recordingState });
    }
  }
});

// ============================================================
// tabCapture StreamId 获取（background 是扩展页面，有完整权限）
// ============================================================
function getStreamIdForTab(tabId) {
  return new Promise((resolve, reject) => {
    if (!chrome.tabCapture) {
      reject(new Error('tabCapture 不可用，请确认 manifest.json 已声明 "tabCapture" 权限'));
      return;
    }
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!streamId) {
        reject(new Error('streamId 为空'));
      } else {
        resolve(streamId);
      }
    });
  });
}

// ============================================================
// Popup 指令处理
// ============================================================
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

      // Step1: 立即最小化宿主窗口
      minimizeHostWindowNow(windowId);

      // Step2: 获取 streamId
      let streamId = '';
      try {
        streamId = await getStreamIdForTab(tabId);
        console.log('[bg] Popup 路径 streamId 获取成功');
      } catch (e) {
        console.warn('[bg] Popup 路径 streamId 获取失败:', e.message);
      }

      // Step3: 视口清洗（通知 content 将视频全屏铺满，过滤弹幕/广告）
      broadcastToTab(tabId, {
        action: 'applyViewportSanitize',
      });

      // Step4: 打开录制小窗（携带 streamId，autoStart=true）
      await ensureRecorderWindow({
        tabId    : tabId,
        windowId : windowId,
        streamId : streamId,
        config   : JSON.stringify(msg.config || {}),
        autoStart: 'true',
      });
    });

  } else {
    // 转发停止/暂停/继续给 recorder 窗口
    chrome.runtime.sendMessage({ ...msg, _target: 'recorder' }).catch(() => {});
  }
}

// ============================================================
// 文件名安全消毒
// ============================================================
function sanitizeFilename(raw) {
  if (!raw || typeof raw !== 'string') return 'recording.webm';
  return raw
    .replace(/[/\\]/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^[.\s]+/, '')
    .slice(0, 200) || 'recording.webm';
}

// ============================================================
// 消息路由
// ============================================================
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  // ── 1. recorder.js 请求 streamId（兜底路径）─────────────────
  if (req.action === 'getTabStreamId') {
    const tabId = parseInt(req.tabId);
    if (!tabId) { sendResponse({ error: 'invalid_tab_id' }); return; }

    recordingState.activeTabId = tabId;

    getStreamIdForTab(tabId)
      .then(streamId => sendResponse({ streamId }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // ── 2. 实时指标回传（recorder → background → popup）─────────
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

    // 同步更新网页悬浮控制条
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
      // 录制结束：清理网页 UI
      broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
      broadcastToTab(recordingState.activeTabId, { action: 'removeViewportSanitize' });

      // 还原宿主窗口
      if (wasRecording && recordingState.activeWindowId) {
        restoreHostWindow(recordingState.activeWindowId);
        recordingState.activeWindowId = null;
      }
    }

    sendResponse({ ok: true });
    return;
  }

  // ── 4. 安全下载（唯一下载入口）──────────────────────────────
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
          chrome.runtime.sendMessage(
            { _target: 'recorder', action: 'releaseBlobUrl', url: req.url }
          ).catch(() => {});
        }
      }
      chrome.downloads.onChanged.addListener(onChanged);
    });
    return true;
  }

  // ── 5. content.js 触发录制（网页悬浮栏点击）─────────────────
  //
  // ★ 正确时序：
  //   a. 立即最小化宿主窗口（不等待任何异步）
  //   b. 获取 streamId（background 有权限，无需用户手势）
  //   c. 通知 content 执行视口清洗
  //   d. 打开 recorder 窗口（携带 streamId）
  //   e. recorder 在自己进程内消费 streamId → 不黑屏、不卡死
  //
  if (req.action === 'startRecordFromContent') {
    const tab      = sender.tab;
    const tabId    = tab && tab.id;
    const windowId = tab && tab.windowId;

    if (!tabId) { sendResponse({ error: 'no_tab_id' }); return; }

    recordingState.activeTabId    = tabId;
    recordingState.activeWindowId = windowId;

    const config = req.config || {};

    // ★ a. 立即最小化（第一时间，不等待任何异步操作）
    minimizeHostWindowNow(windowId);

    // ★ b. 获取 streamId（与最小化并行，background 有完整权限）
    getStreamIdForTab(tabId)
      .then(async (streamId) => {
        console.log('[bg] content 路径 streamId 获取成功');

        // ★ c. 通知 content 执行视口清洗（将视频铺满全屏，过滤杂质）
        broadcastToTab(tabId, { action: 'applyViewportSanitize' });

        // ★ d. 打开录制小窗
        await ensureRecorderWindow({
          tabId    : tabId,
          windowId : windowId,
          streamId : streamId,
          config   : JSON.stringify(config),
          autoStart: 'true',
        });

        sendResponse({ ok: true });
      })
      .catch(async (e) => {
        console.error('[bg] content 路径 streamId 失败:', e.message);

        // 降级：不带 streamId，让 recorder 自行重试
        broadcastToTab(tabId, { action: 'applyViewportSanitize' });

        await ensureRecorderWindow({
          tabId    : tabId,
          windowId : windowId,
          streamId : '',
          config   : JSON.stringify(config),
          autoStart: 'true',
        });

        sendResponse({ ok: true, warn: e.message });
      });

    return true;
  }

  // ── 6. 显示网页悬浮控制条 ────────────────────────────────────
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

  // ── 8. 悬浮窗控制按钮转发 ────────────────────────────────────
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
