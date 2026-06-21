'use strict';

// ============================================================
// Background Service Worker - 闭环路由中枢
// ============================================================

let recordingState = {
  isRecording : false,
  isPaused    : false,
  quality     : 'hd',
  seconds     : 0,
  sizeString  : '0B',
  bitrate     : '0kbps',
  resolution  : '-',
  timeString  : '00:00:00',
  activeTabId : null,
  recorderWindowId: null // 独立录制窗口的 ID
};

let popupPort = null;

// 长连接：Popup 连接时同步最新状态
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;

  popupPort = port;
  port.postMessage({ action: 'stateSync', state: recordingState });

  port.onDisconnect.addListener(() => {
    popupPort = null;
  });

  port.onMessage.addListener((msg) => {
    handlePopupCommand(msg);
  });
});

// 创建独立视频录制小窗（录制框） (对齐 Image 2)
async function ensureRecorderWindow(config, tabId) {
  if (recordingState.recorderWindowId) {
    // 如果窗口已存在，直接带到前台
    try {
      await chrome.windows.update(recordingState.recorderWindowId, { focused: true });
      return;
    } catch (e) {
      recordingState.recorderWindowId = null;
    }
  }

  // 拼接配置参数，在独立窗口中初始化
  const queryParams = new URLSearchParams({
    tabId: tabId || '',
    config: JSON.stringify(config)
  });

  const win = await chrome.windows.create({
    url: 'recorder.html?' + queryParams.toString(),
    type: 'popup',
    width: 850,
    height: 600,
    focused: true
  });

  recordingState.recorderWindowId = win.id;
}

async function closeRecorderWindow() {
  if (recordingState.recorderWindowId) {
    try {
      await chrome.windows.remove(recordingState.recorderWindowId);
    } catch (e) {}
    recordingState.recorderWindowId = null;
  }
}

async function handlePopupCommand(msg) {
  const controlActions = ['startRecording', 'stopRecording', 'pauseRecording', 'resumeRecording'];
  if (!controlActions.includes(msg.action)) return;

  if (msg.action === 'startRecording') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || !tabs[0]) return;
      const tabId = tabs[0].id;
      recordingState.activeTabId = tabId;
      await ensureRecorderWindow(msg.config, tabId);
    });
  } else {
    // 转发停止、暂停、继续指令给独立录制窗口
    chrome.runtime.sendMessage({ ...msg, _target: 'recorder' }).catch(() => {});
  }
}

function sanitizeFilename(raw) {
  if (!raw || typeof raw !== 'string') return 'recording.webm';
  return raw
    .replace(/[/\\]/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^[.\s]+/, '')
    .slice(0, 200) || 'recording.webm';
}

// 消息转发路由器
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  // 1. 获取 Tab Stream ID（安全穿透）
  if (req.action === 'getTabStreamId') {
    const tabId = parseInt(req.tabId);
    if (!tabId) {
      sendResponse({ error: 'invalid_tab_id' });
      return;
    }
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

  // 2. 独立录制窗口实时数据回传 → 分发至 Popup 与 网页控制条
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
        cpu        : req.cpu
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

  // 3. 独立录制窗口状态变动
  if (req.action === 'recordingStateChanged') {
    Object.assign(recordingState, req.state);

    if (popupPort) {
      popupPort.postMessage({ action: 'stateSync', state: recordingState });
    }

    if (!req.state.isRecording) {
      broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
      recordingState.activeTabId = null;
      closeRecorderWindow();
    }

    sendResponse({ ok: true });
    return;
  }

  // 4. 物理安全下载
  if (req.action === 'triggerDownload') {
    const safeName = sanitizeFilename(req.filename);
    chrome.downloads.download({
      url: req.url,
      filename: safeName,
      conflictAction: 'uniquify',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        chrome.runtime.sendMessage({ _target: 'recorder', action: 'releaseBlobUrl', url: req.url }).catch(()=>{});
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ downloadId });

      function onDownloadChanged(delta) {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(onDownloadChanged);
          chrome.runtime.sendMessage({ _target: 'recorder', action: 'releaseBlobUrl', url: req.url }).catch(()=>{});
        }
      }
      chrome.downloads.onChanged.addListener(onDownloadChanged);
    });
    return true;
  }

  // 5. 网页悬浮栏触发录制
  if (req.action === 'startRecordFromContent') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ error: 'cannot_determine_tabId' });
      return;
    }
    recordingState.activeTabId = tabId;

    ensureRecorderWindow(req.config, tabId).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // 6. 悬浮窗应用
  if (req.action === 'showFloat') {
    const tabId = recordingState.activeTabId;
    if (tabId) {
      broadcastToTab(tabId, { action: 'showFloat', position: req.position || 'top-right' });
    } else {
      broadcastToActiveTab({ action: 'showFloat', position: req.position || 'top-right' });
    }
    sendResponse({ ok: true });
    return;
  }

  // 7. 关于与通知
  if (req.action === 'notify') {
    if (chrome.notifications) {
      chrome.notifications.create('rec_' + Date.now(), {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '🎬 直播内录器',
        message: req.message || '',
      });
    }
    sendResponse({ ok: true });
    return;
  }

  // 8. 悬浮窗事件转发
  if (req.action === 'floatPause' || req.action === 'floatStop') {
    const action = req.action === 'floatStop' ? 'stopRecording' : 'pauseRecording';
    chrome.runtime.sendMessage({ _target: 'recorder', action }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false });
});

// 工具函数
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

function buildDefaultConfig() {
  return {
    sysAudio: true,
    micAudio: false,
    noAudio: false,
    format: 'mp4',
    vbps: 6000000,
    abps: 192000,
    fps: 30,
    filePrefix: '快捷录制',
    quality: 'hd'
  };
}
