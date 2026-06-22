'use strict';

/**
 * background.js - 跨进程双向管道调度器
 * 
 * 物理职责：
 * 1. 建立 content_stream ↔ recorder_pipeline 的无损桥接通道
 * 2. 调度启动缓冲池，防止小窗初始化期间丢帧
 * 3. 监控网页端生命周期，意外断开时通知小窗紧急自愈
 */

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
let activeContentPort = null;
let activeRecorderPort = null;
let startupBuffer = []; // 启动缓冲池

// 跨进程 Port 通道桥接器
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPort = port;
    port.postMessage({ action: 'stateSync', state: recordingState });
    port.onDisconnect.addListener(() => { popupPort = null; });
    port.onMessage.addListener(handlePopupCommand);
    return;
  }

  // 采集端连接入网
  if (port.name === 'content_stream') {
    activeContentPort = port;
    port.onMessage.addListener((msg) => {
      if (activeRecorderPort) {
        activeRecorderPort.postMessage(msg);
      } else {
        startupBuffer.push(msg); // 小窗尚未就绪，压入缓冲池防止丢帧
      }
    });
    port.onDisconnect.addListener(() => {
      activeContentPort = null;
      // 物理崩溃探针：长连接异常断开（如标签页 OOM），通知小窗紧急自愈
      if (activeRecorderPort) {
        activeRecorderPort.postMessage({ action: 'content_disconnected' });
      }
    });
    return;
  }

  // 接收端（控制小窗）连接入网
  if (port.name === 'recorder_pipeline') {
    activeRecorderPort = port;
    // 立即冲刷缓冲池中的历史数据
    if (startupBuffer.length > 0) {
      startupBuffer.forEach(msg => activeRecorderPort.postMessage(msg));
      startupBuffer = [];
    }
    port.onDisconnect.addListener(() => {
      activeRecorderPort = null;
    });
    return;
  }
});

function getStreamIdForTab(tabId) {
  return new Promise((resolve, reject) => {
    if (!chrome.tabCapture) {
      reject(new Error('tabCapture 不可用，请声明权限'));
      return;
    }
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
      } else if (!streamId) {
        reject(new Error('streamId 为空'));
      } else {
        resolve(streamId);
      }
    });
  });
}

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
    streamId : streamId || '', 
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

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== recordingState.recorderWindowId) return;
  recordingState.recorderWindowId = null;

  if (recordingState.isRecording) {
    recordingState.isRecording = false;
    recordingState.isPaused    = false;
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
    chrome.runtime.sendMessage({ ...msg, _target: 'recorder' }).catch(() => {});
    if (recordingState.activeTabId) {
      chrome.tabs.sendMessage(
        recordingState.activeTabId,
        { ...msg, _target: 'content_recorder' },
        () => { void chrome.runtime.lastError; }
      );
    }
  }
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

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
      popupPort.postMessage({ ...req, action: 'metricsUpdate' });
    }

    broadcastToTab(recordingState.activeTabId, {
      action: 'updateFloat',
      paused: req.isPaused,
      time  : req.timeString,
    });

    sendResponse({ ok: true });
    return;
  }

  if (req.action === 'recordingStateChanged') {
    Object.assign(recordingState, req.state);
    if (popupPort) popupPort.postMessage({ action: 'stateSync', state: recordingState });
    if (!req.state.isRecording) {
      broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
    }
    sendResponse({ ok: true });
    return;
  }

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
        console.error('[bg] 获取 streamId 失败，降级启动:', e.message);
        await ensureRecorderWindow(config, tabId, autoStart, '');
        sendResponse({ ok: true, warn: e.message });
      });
    return true;
  }

  if (req.action === 'fallbackToTabCapture') {
    chrome.runtime.sendMessage({
      _target: 'recorder',
      action : 'startTabCaptureRecording',
      config : req.config
    }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

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
