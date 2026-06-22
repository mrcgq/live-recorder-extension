'use strict';

// ============================================================
// Background Service Worker v4.1 - 窗口抽取与标签隔离版
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
  originalWindowId : null,   // 记录录制前标签页所属的原始窗口 ID
  originalIndex    : null,   // 记录录制前标签页在原窗口中的索引
  tempWindowId     : null,   // 临时创建的独立最小化窗口 ID
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
// 独立提取与复位逻辑
// ============================================================

// 辅助 Promise 封装
function getTabAsync(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(tab);
    });
  });
}

function queryTabsAsync(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) resolve([]);
      else resolve(tabs);
    });
  });
}

function createTabAsync(createProperties) {
  return new Promise((resolve) => {
    chrome.tabs.create(createProperties, (tab) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(tab);
    });
  });
}

function createMinWindowAsync(tabId) {
  return new Promise((resolve) => {
    chrome.windows.create({
      tabId: tabId,
      state: 'minimized',
      focused: false
    }, (win) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(win);
    });
  });
}

// 提取当前目标标签页并将其移入一个独立的最小化窗口中（实现网页端在眼前“消失”）
async function isolateTabToMinimizedWindow(tabId) {
  const tab = await getTabAsync(tabId);
  if (!tab) throw new Error('无法读取目标标签页');

  const originalWindowId = tab.windowId;
  const originalIndex = tab.index;

  const tabsInWin = await queryTabsAsync({ windowId: originalWindowId });
  if (tabsInWin.length === 1) {
    // 如果原窗口中只有这一个标签页，为了避免移动它导致原窗口关闭，
    // 我们先在原窗口新建一个空白标签页供用户继续使用
    await createTabAsync({ windowId: originalWindowId, active: true });
  }

  // 创建一个包含目标标签页的新独立窗口，并初始化为最小化状态
  const newWin = await createMinWindowAsync(tabId);
  if (!newWin) throw new Error('无法创建最小化的隔离窗口');

  console.log('[bg] ★ 目标标签页已隔离到独立最小化窗口 tempWindowId:', newWin.id);

  recordingState.originalWindowId = originalWindowId;
  recordingState.originalIndex = originalIndex;
  recordingState.tempWindowId = newWin.id;
}

// 录制结束后无损还原标签页
async function restoreHostWindow() {
  const { activeTabId, originalWindowId, originalIndex, tempWindowId } = recordingState;
  
  if (!activeTabId || !originalWindowId) return;

  console.log('[bg] ★ 正在将目标标签页复原到原始窗口...');
  
  try {
    const origWinExists = await new Promise((resolve) => {
      chrome.windows.get(originalWindowId, () => {
        resolve(!chrome.runtime.lastError);
      });
    });

    if (origWinExists) {
      // 挪回原窗口的原位置
      await new Promise((resolve) => {
        chrome.tabs.move(activeTabId, { windowId: originalWindowId, index: originalIndex }, () => {
          resolve();
        });
      });
      // 重新激活并聚焦
      chrome.tabs.update(activeTabId, { active: true });
      chrome.windows.update(originalWindowId, { focused: true });
      console.log('[bg] ★ 标签页已成功复原并聚焦');
    } else {
      // 原窗口已被关闭，降级处理：直接将临时的最小化窗口恢复显示
      if (tempWindowId) {
        chrome.windows.update(tempWindowId, { state: 'normal', focused: true }, () => {
          void chrome.runtime.lastError;
        });
        console.log('[bg] ★ 原始窗口已不存在，已将隔离窗口还原显示');
      }
    }
  } catch (e) {
    console.error('[bg] 复原标签页失败:', e.message);
  }

  recordingState.originalWindowId = null;
  recordingState.originalIndex = null;
  recordingState.tempWindowId = null;
}

// 打开/复用录制控制小窗
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

// 监听录制小窗被用户直接关闭
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== recordingState.recorderWindowId) return;
  recordingState.recorderWindowId = null;

  if (recordingState.isRecording) {
    recordingState.isRecording = false;
    recordingState.isPaused    = false;

    // 清理网页 UI 状态
    broadcastToTab(recordingState.activeTabId, { action: 'removeViewportSanitize' });
    broadcastToActiveTab({ action: 'removeFloat' });

    // 还原宿主窗口与标签页
    restoreHostWindow();

    if (popupPort) {
      popupPort.postMessage({ action: 'stateSync', state: recordingState });
    }
  }
});

// ============================================================
// tabCapture StreamId 获取
// ============================================================
function getStreamIdForTab(tabId) {
  return new Promise((resolve, reject) => {
    if (!chrome.tabCapture) {
      reject(new Error('tabCapture 不可用'));
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

      recordingState.activeTabId = tabId;

      try {
        // Step 1: 提取目标标签页放入独立最小化窗口 (网页端瞬间“消失”，但不中断后台渲染)
        await isolateTabToMinimizedWindow(tabId);

        // Step 2: 获取隔离后的 streamId
        const streamId = await getStreamIdForTab(tabId);

        // Step 3: 通知 content.js 执行深度 DOM 视频隔离
        broadcastToTab(tabId, { action: 'applyViewportSanitize' });

        // Step 4: 打开并聚焦录制控制小窗
        await ensureRecorderWindow({
          tabId    : tabId,
          streamId : streamId,
          config   : JSON.stringify(msg.config || {}),
          autoStart: 'true',
        });
      } catch (e) {
        console.error('[bg] Popup 启动录制失败:', e.message);
        await restoreHostWindow();
      }
    });

  } else {
    chrome.runtime.sendMessage({ ...msg, _target: 'recorder' }).catch(() => {});
  }
}

// ============================================================
// 文件名消毒
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

  // ── 1. recorder.js 请求 streamId ─────────────────────────────
  if (req.action === 'getTabStreamId') {
    const tabId = parseInt(req.tabId);
    if (!tabId) { sendResponse({ error: 'invalid_tab_id' }); return; }

    recordingState.activeTabId = tabId;

    getStreamIdForTab(tabId)
      .then(streamId => sendResponse({ streamId }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
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

    // 同步更新网页悬浮控制条 (广播给用户当前正在浏览的页面，而不是被录制的那页，防止控制条被录进视频)
    broadcastToActiveTab({
      action: 'updateFloat',
      paused: req.isPaused,
      time: req.timeString,
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
      broadcastToTab(recordingState.activeTabId, { action: 'removeViewportSanitize' });
      broadcastToActiveTab({ action: 'removeFloat' });

      // 还原宿主窗口与标签页
      if (wasRecording) {
        restoreHostWindow();
      }
    }

    sendResponse({ ok: true });
    return;
  }

  // ── 4. 安全下载 ──────────────────────────────────────────────
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

  // ── 5. content.js 网页悬浮栏触发录制 ─────────────────────────────
  if (req.action === 'startRecordFromContent') {
    const tab      = sender.tab;
    const tabId    = tab && tab.id;

    if (!tabId) { sendResponse({ error: 'no_tab_id' }); return; }

    recordingState.activeTabId = tabId;
    const config = req.config || {};

    (async () => {
      try {
        // Step 1: 提取标签页放入独立最小化窗口 (宿主窗口正常保留，网页端瞬间消失)
        await isolateTabToMinimizedWindow(tabId);

        // Step 2: 获取隔离后的 streamId
        const streamId = await getStreamIdForTab(tabId);
        console.log('[bg] content 路径 streamId 获取成功');

        // Step 3: 通知 content.js 执行深度 DOM 隔离清洗
        broadcastToTab(tabId, { action: 'applyViewportSanitize' });

        // Step 4: 打开并聚焦录制控制小窗
        await ensureRecorderWindow({
          tabId    : tabId,
          streamId : streamId,
          config   : JSON.stringify(config),
          autoStart: 'true',
        });

        sendResponse({ ok: true });
      } catch (e) {
        console.error('[bg] content 路径启动录制失败:', e.message);
        await restoreHostWindow();
        sendResponse({ error: e.message });
      }
    })();

    return true; // 保持通道异步
  }

  // ── 6. 显示网页悬浮控制条 ────────────────────────────────────
  if (req.action === 'showFloat') {
    const pos = req.position || 'top-right';
    // 控制条必须展示在当前活跃的浏览标签页，而决不能在被隔离录制的标签页展示，防止被录入视频中
    broadcastToActiveTab({ action: 'showFloat', position: pos });
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
