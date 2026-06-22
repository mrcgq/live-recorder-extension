'use strict';

// ============================================================
// Background Service Worker v3.1
// 核心变更：
//   1. 结合 video.captureStream() 纯视频流内录设计。
//   2. 引入 tabCapture 保活机制 (Wake-lock)：在后台激活一个静默的 
//      tabCapture 流，强制 Chrome 的合成器与渲染器在后台以 full-frame 运行，
//      彻底攻克切换标签页/最小化时 video.captureStream() 产生的“花屏/冻结”缺陷！
//   3. 添加双引擎容灾机制：当 video.captureStream() 因 CORS 报错受限时，
//      自动无缝降级采用 tabCapture 底层流完成高质量捕获。
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

// ── 获取 tabCapture 独占 streamId ─────────────────────────────
function getStreamIdForTab(tabId) {
  return new Promise((resolve, reject) => {
    if (!chrome.tabCapture) {
      reject(new Error('tabCapture 不可用，请确认已声明权限'));
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

// ── 录制小窗管理 ─────────────────────────────────────────────
async function ensureRecorderWindow(config, tabId, autoStart, streamId) {
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
    streamId : streamId || '', // 注入保活与备用捕获使用的 streamId
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

      let streamId = '';
      try {
        streamId = await getStreamIdForTab(tabId);
      } catch (e) {
        console.warn('[bg] 获取 streamId 失败:', e.message);
      }

      await ensureRecorderWindow(msg.config || {}, tabId, false, streamId);
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
          // 同时通知 content 脚本释放
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

    const config = req.config || {};
    const autoStart = config.autoStart === true;

    getStreamIdForTab(tabId)
      .then(async (streamId) => {
        await ensureRecorderWindow(config, tabId, autoStart, streamId);
        sendResponse({ ok: true });
      })
      .catch(async (e) => {
        console.error('[bg] 获取 streamId 失败，尝试降级启动:', e.message);
        await ensureRecorderWindow(config, tabId, autoStart, '');
        sendResponse({ ok: true, warn: e.message });
      });
    return true;
  }

  // 5. 容灾降级：CORS 触发时，content 通知 recorder 页面启动 tabCapture 录制
  if (req.action === 'fallbackToTabCapture') {
    chrome.runtime.sendMessage({
      _target: 'recorder',
      action : 'startTabCaptureRecording',
      config : req.config
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
