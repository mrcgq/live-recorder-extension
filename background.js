'use strict';

// ============================================================
// Background Service Worker - 消息路由中枢
// 修复：
//   1. startRecordFromContent 传递精确 tabId（消除时序竞争）
//   2. 完善所有消息路由
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
};

let popupPort = null;

// ============================================================
// 长连接：popup 连接时同步最新状态
// ============================================================
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;

  popupPort = port;
  // popup 重新打开时立即同步录制状态
  port.postMessage({ action: 'stateSync', state: recordingState });

  port.onDisconnect.addListener(() => {
    popupPort = null;
  });

  port.onMessage.addListener((msg) => {
    handlePopupCommand(msg);
  });
});

// ============================================================
// Offscreen Document 生命周期管理
// ============================================================
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url         : 'offscreen.html',
    reasons     : ['USER_MEDIA'],
    justification: 'Live stream tab capture and media encoding pipeline',
  });
}

async function closeOffscreenIfIdle() {
  if (recordingState.isRecording) return;
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existing.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {
    console.warn('[bg] closeOffscreen error:', e.message);
  }
}

// ============================================================
// 处理来自 popup 的指令（通过长连接 port）
// ============================================================
async function handlePopupCommand(msg) {
  const controlActions = [
    'startRecording',
    'stopRecording',
    'pauseRecording',
    'resumeRecording',
  ];

  if (!controlActions.includes(msg.action)) return;

  try {
    await ensureOffscreen();
    // 通过短消息转发至 offscreen
    chrome.runtime.sendMessage(
      { ...msg, _target: 'offscreen' },
      () => void chrome.runtime.lastError
    );
  } catch (e) {
    console.error('[bg] handlePopupCommand error:', e.message);
  }
}

// ============================================================
// 文件名安全消毒（阻断路径穿透攻击）
// ============================================================
function sanitizeFilename(raw) {
  if (!raw || typeof raw !== 'string') return 'recording.webm';

  return (
    raw
      .replace(/[/\\]/g, '_')           // 斜杠转下划线
      .replace(/\.\.+/g, '.')           // 消除双点路径穿透
      .replace(/[\x00-\x1f\x7f]/g, '')  // 移除控制字符
      .replace(/^[.\s]+/, '')           // 移除开头的点和空白
      .slice(0, 200)                    // 限制最大长度
    || 'recording.webm'
  );
}

// ============================================================
// 短消息处理
// ============================================================
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  // ----------------------------------------------------------
  // 1. 获取 Tab Stream ID
  //    ★ 修复：优先使用 req.tabId（由发起端精确传入）
  //           消除多窗口/快速切换时的时序竞争（P2修复）
  // ----------------------------------------------------------
  if (req.action === 'getTabStreamId') {
    const resolveTabId = (tabId) => {
      // ★ 终极物理对齐：确保通过非 content 路径启动时，也能正确锚定活跃标签 ID，同步悬浮条生命周期
      recordingState.activeTabId = tabId; 

      if (!chrome.tabCapture) {
        sendResponse({ error: 'tabCapture_unavailable' });
        return;
      }
      try {
        chrome.tabCapture.getMediaStreamId(
          { targetTabId: tabId },
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
    };

    // 如果发起端已传入精确的 tabId，直接使用
    if (req.tabId) {
      resolveTabId(req.tabId);
    } else {
      // 降级：查询当前活跃标签
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          sendResponse({ error: 'no_active_tab' });
          return;
        }
        resolveTabId(tabs[0].id);
      });
    }
    return true;
  }

  // ----------------------------------------------------------
  // 2. offscreen → 实时指标上报 → 分发给 popup + content
  // ----------------------------------------------------------
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
      });
    }

    // 同步悬浮控制条
    broadcastToTab(recordingState.activeTabId, {
      action: 'updateFloat',
      paused: req.isPaused,
      time  : req.timeString,
    });

    sendResponse({ ok: true });
    return;
  }

  // ----------------------------------------------------------
  // 3. offscreen → 录制状态变更 → 广播
  // ----------------------------------------------------------
  if (req.action === 'recordingStateChanged') {
    Object.assign(recordingState, req.state);

    if (popupPort) {
      popupPort.postMessage({ action: 'stateSync', state: recordingState });
    }

    if (!req.state.isRecording) {
      // 录制结束：移除悬浮条，关闭 offscreen
      broadcastToTab(recordingState.activeTabId, { action: 'removeFloat' });
      recordingState.activeTabId = null;
      closeOffscreenIfIdle();
    }

    sendResponse({ ok: true });
    return;
  }

  // ----------------------------------------------------------
  // 4. 安全文件下载（含路径消毒 + Blob URL 生命周期回收）
  // ----------------------------------------------------------
  if (req.action === 'triggerDownload') {
    const safeName = sanitizeFilename(req.filename);

    chrome.downloads.download(
      {
        url           : req.url,
        filename      : safeName,
        conflictAction: 'uniquify',
        saveAs        : false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[bg] download error:', chrome.runtime.lastError.message);
          // 下载失败立即回收，防止泄漏
          chrome.runtime.sendMessage({
            _target: 'offscreen',
            action : 'releaseBlobUrl',
            url    : req.url,
          }).catch(() => {});
          sendResponse({ error: chrome.runtime.lastError.message });
          return;
        }

        sendResponse({ downloadId });

        // 监听下载完成 → 通知 offscreen 回收 Blob URL（Law-39）
        function onDownloadChanged(delta) {
          if (delta.id !== downloadId) return;

          if (delta.state && delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onDownloadChanged);
            chrome.runtime.sendMessage({
              _target: 'offscreen',
              action : 'releaseBlobUrl',
              url    : req.url,
            }).catch(() => {});
          }

          if (delta.error && delta.error.current) {
            chrome.downloads.onChanged.removeListener(onDownloadChanged);
            console.error('[bg] download failed:', delta.error.current);
            // 下载出错也要回收
            chrome.runtime.sendMessage({
              _target: 'offscreen',
              action : 'releaseBlobUrl',
              url    : req.url,
            }).catch(() => {});
          }
        }

        chrome.downloads.onChanged.addListener(onDownloadChanged);
      }
    );
    return true;
  }

  // ----------------------------------------------------------
  // 5. content.js 侧边栏点击"录制小视频"
  //    ★ 修复：从 sender.tab.id 获取精确 tabId 并传入 offscreen
  //           彻底消除多窗口时序竞争（P2修复）
  // ----------------------------------------------------------
  if (req.action === 'startRecordFromContent') {
    // sender.tab 是发起消息的 content script 所在标签页
    const tabId = sender.tab && sender.tab.id;

    if (!tabId) {
      sendResponse({ error: 'cannot_determine_tabId' });
      return;
    }

    // 保存活跃标签页 ID（用于后续广播悬浮条消息）
    recordingState.activeTabId = tabId;

    ensureOffscreen()
      .then(() => {
        chrome.runtime.sendMessage({
          _target: 'offscreen',
          action : 'startRecording',
          config : { ...req.config, tabId }, // ★ 精确 tabId 注入配置
        }).catch(() => {});

        // 显示悬浮控制条
        broadcastToTab(tabId, {
          action  : 'showFloat',
          position: 'top-right',
        });

        if (popupPort) {
          popupPort.postMessage({ action: 'stateSync', state: recordingState });
        }
      })
      .catch((e) => {
        console.error('[bg] ensureOffscreen failed:', e.message);
      });

    sendResponse({ ok: true });
    return;
  }

  // ----------------------------------------------------------
  // 6. popup 手动触发显示悬浮控制条
  // ----------------------------------------------------------
  if (req.action === 'showFloat') {
    // 向当前活跃标签广播
    const tabId = recordingState.activeTabId;
    if (tabId) {
      broadcastToTab(tabId, {
        action  : 'showFloat',
        position: req.position || 'top-right',
      });
    } else {
      broadcastToActiveTab({ action: 'showFloat', position: req.position || 'top-right' });
    }
    sendResponse({ ok: true });
    return;
  }

  // ----------------------------------------------------------
  // 7. 系统通知
  // ----------------------------------------------------------
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

  // ----------------------------------------------------------
  // 8. content 悬浮条按钮 → 转发至 offscreen
  // ----------------------------------------------------------
  if (req.action === 'floatPause' || req.action === 'floatStop') {
    const action = req.action === 'floatStop' ? 'stopRecording' : 'pauseRecording';
    chrome.runtime.sendMessage(
      { _target: 'offscreen', action },
      () => void chrome.runtime.lastError
    );
    sendResponse({ ok: true });
    return;
  }

  // 兜底
  sendResponse({ ok: false, msg: 'unknown_action' });
});

// ============================================================
// 快捷键
// ============================================================
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start-stop-recording') {
    if (recordingState.isRecording) {
      chrome.runtime.sendMessage(
        { _target: 'offscreen', action: 'stopRecording' },
        () => void chrome.runtime.lastError
      );
    } else {
      try {
        await ensureOffscreen();
        // 快捷键启动时查询当前活跃标签
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (!tabs || !tabs[0]) return;
          const tabId = tabs[0].id;
          recordingState.activeTabId = tabId;

          chrome.runtime.sendMessage({
            _target: 'offscreen',
            action : 'startRecording',
            config : { ...buildDefaultConfig(), tabId },
          }).catch(() => {});
        });
      } catch (e) {
        console.error('[bg] hotkey start error:', e.message);
      }
    }
  }

  if (command === 'pause-recording') {
    const action = recordingState.isPaused ? 'resumeRecording' : 'pauseRecording';
    chrome.runtime.sendMessage(
      { _target: 'offscreen', action },
      () => void chrome.runtime.lastError
    );
  }
});

// ============================================================
// 工具函数
// ============================================================

/** 向指定 tabId 发消息 */
function broadcastToTab(tabId, msg) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, msg, () => {
    void chrome.runtime.lastError;
  });
}

/** 向当前活跃标签发消息（兜底）*/
function broadcastToActiveTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, () => {
      void chrome.runtime.lastError;
    });
  });
}

/** 默认录制配置（快捷键触发时使用）*/
function buildDefaultConfig() {
  return {
    sysAudio  : true,
    micAudio  : false,
    noAudio   : false,
    format    : 'webm',
    vbps      : 6_000_000,
    abps      : 192_000,
    fps       : 30,
    filePrefix: '直播录制',
    quality   : 'hd',
  };
}
