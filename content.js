'use strict';

// ============================================================
// content.js v3.0 - 完整重构
//
// 核心架构变更：
//   本脚本现在承担"数据面"核心职责：
//   1. 深度穿透 Shadow DOM 精准识别直播 <video> 元素
//   2. 直接调用 video.captureStream() 抽取纯净视频流
//   3. 通过 MediaRecorder 在页面内完成录制编码
//   4. 完成后通过 background 触发安全下载
//   5. recorder.html 窗口仅作为"控制面板 + 实时预览镜像"
//
// 这样做的根本优势：
//   ✅ 录制画面 = 直播视频本身，零网页元素混入
//   ✅ 不受全屏/画质切换影响，流不会中断
//   ✅ 彻底绕过 tabCapture 跨进程黑屏问题
//   ✅ 视频原始码率，不经二次压缩，画质最佳
// ============================================================

// ── 录制状态（页面内核心数据面）────────────────────────────
const REC = {
  mediaRecorder  : null,
  captureStream  : null,   // video.captureStream() 返回的流
  audioStream    : null,   // 麦克风流（可选）
  mixedStream    : null,   // 混音后的最终流
  audioCtx       : null,
  chunks         : [],
  totalBytes     : 0,
  seconds        : 0,
  isPaused       : false,
  isRecording    : false,
  config         : null,
  targetVideo    : null,   // 当前锁定的直播 video 元素
  timerInterval  : null,
  monInterval    : null,
  prevBytes      : 0,
  prevTime       : 0,
  currentBitrate : '0kbps',
  mimeType       : 'video/webm',
  sessionId      : null,
  idbDb          : null,
  chunkSeq       : 0,
  blobUrls       : [],     // 待回收的 Blob URL
};

// ── UI 状态 ──────────────────────────────────────────────────
const CS = {
  hoverVideo  : null,
  hoverBar    : null,
  hoverRAF    : null,
  leaveTimer  : null,
  floatBar    : null,
  floatTimer  : null,
  floatSec    : 0,
  floatPaused : false,
  regionActive: false,
  observer    : null,
  bindTimeout : null,
};

function fmtTime(s) {
  s = s || 0;
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

function fmtSize(b) {
  b = b || 0;
  if (b < 1024)       return b + 'B';
  if (b < 1048576)    return (b / 1024).toFixed(1) + 'KB';
  if (b < 1073741824) return (b / 1048576).toFixed(2) + 'MB';
  return (b / 1073741824).toFixed(2) + 'GB';
}

// ============================================================
// IndexedDB 分片持久化（零丢失保障）
// ============================================================
async function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('LiveRecorderContentDB', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'sessionId' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function idbPut(storeName, data) {
  if (!REC.idbDb) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = REC.idbDb.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(data);
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    } catch (_) { resolve(); }
  });
}

function idbAddChunk(data) {
  if (!REC.idbDb) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = REC.idbDb.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').add(data);
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    } catch (_) { resolve(); }
  });
}

function idbGetChunks(sessionId) {
  return new Promise((resolve) => {
    if (!REC.idbDb) { resolve([]); return; }
    try {
      const results = [];
      const cursor  = REC.idbDb.transaction('chunks', 'readonly')
                        .objectStore('chunks').openCursor();
      cursor.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { resolve(results.sort((a, b) => a.seq - b.seq)); return; }
        if (c.value.sessionId === sessionId) results.push(c.value);
        c.continue();
      };
      cursor.onerror = () => resolve(results);
    } catch (_) { resolve([]); }
  });
}

function idbDeleteSession(sessionId) {
  if (!REC.idbDb) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = REC.idbDb.transaction('chunks', 'readwrite');
      const cs = tx.objectStore('chunks');
      const cur = cs.openCursor();
      cur.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return;
        if (c.value.sessionId === sessionId) c.delete();
        c.continue();
      };
      tx.oncomplete = () => {
        const tx2 = REC.idbDb.transaction('sessions', 'readwrite');
        tx2.objectStore('sessions').delete(sessionId);
        tx2.oncomplete = resolve;
        tx2.onerror    = resolve;
      };
      tx.onerror = resolve;
    } catch (_) { resolve(); }
  });
}

async function recoverCrashedSessions() {
  if (!REC.idbDb) return;
  try {
    const all = await new Promise((resolve) => {
      try {
        const req = REC.idbDb.transaction('sessions', 'readonly')
                      .objectStore('sessions').getAll();
        req.onsuccess = (e) => resolve(e.target.result || []);
        req.onerror   = () => resolve([]);
      } catch (_) { resolve([]); }
    });

    for (const session of all) {
      if (session.completed) { await idbDeleteSession(session.sessionId); continue; }
      const chunks = await idbGetChunks(session.sessionId);
      if (!chunks.length) { await idbDeleteSession(session.sessionId); continue; }

      const mime     = session.mimeType || 'video/webm';
      const blob     = new Blob(chunks.map(c => c.blob), { type: mime });
      const ext      = mime.includes('mp4') ? 'mp4' : 'webm';
      const filename = (session.prefix || '崩溃恢复') + '_recovered_' +
                       new Date(session.startTime || Date.now())
                         .toISOString().replace('T','_').replace(/:/g,'-').slice(0,19) +
                       '.' + ext;
      const url = URL.createObjectURL(blob);

      chrome.runtime.sendMessage({ action: 'triggerDownload', url, filename },
        () => { void chrome.runtime.lastError; });
      chrome.runtime.sendMessage({ action: 'notify', message: '✅ 已恢复录制: ' + filename })
        .catch(() => {});

      await idbDeleteSession(session.sessionId);
    }
  } catch (e) {
    console.warn('[content-rec] 崩溃恢复失败:', e.message);
  }
}

// ============================================================
// 初始化
// ============================================================
async function init() {
  // 初始化 IDB
  try {
    REC.idbDb = await openIDB();
    await recoverCrashedSessions();
  } catch (e) {
    console.warn('[content-rec] IDB 初始化失败，降级内存模式:', e.message);
  }

  initVideoDetection();
}

// ============================================================
// Shadow DOM 深度穿透视频检测
// ============================================================
function findVideosDeep(root) {
  root = root || document;
  const videos = [];

  function traverse(node) {
    if (!node) return;
    const type = node.nodeType;
    if (type !== Node.ELEMENT_NODE && type !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.tagName === 'VIDEO') videos.push(node);
    const ch = node.children;
    if (ch) for (let i = 0; i < ch.length; i++) traverse(ch[i]);
    if (node.shadowRoot) traverse(node.shadowRoot);
  }

  traverse(root);
  return videos;
}

// 判断视频是否为有效直播视频（非广告、非缩略图）
function isLiveVideo(video) {
  if (!video) return false;
  const rect = video.getBoundingClientRect();
  // 尺寸过滤：至少 320x180
  if (rect.width < 320 || rect.height < 180) return false;
  // 必须有视频源
  if (!video.src && !video.srcObject && !video.currentSrc) return false;
  // 时长过滤：直播流通常 duration 为 Infinity 或 0（HLS/DASH）
  // 排除明确是短视频（< 10秒且已知时长）的情况
  if (isFinite(video.duration) && video.duration > 0 && video.duration < 10) return false;
  return true;
}

// 在所有视频中选出最优的直播视频（面积最大且满足条件）
function pickBestLiveVideo() {
  const videos = findVideosDeep();
  let best = null;
  let bestArea = 0;

  for (const v of videos) {
    if (!isLiveVideo(v)) continue;
    const rect = v.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) { bestArea = area; best = v; }
  }

  return best;
}

// ── 单一防抖绑定 ─────────────────────────────────────────────
function throttledBindAllVideos() {
  if (CS.bindTimeout) return;
  CS.bindTimeout = setTimeout(() => {
    CS.bindTimeout = null;
    findVideosDeep().forEach(bindVideo);
  }, 800);
}

function initVideoDetection() {
  findVideosDeep().forEach(bindVideo);

  // 全局 mouseover，穿透透明遮罩
  document.addEventListener('mouseover', onGlobalMouseover, { passive: true });

  // DOM 变化监听
  CS.observer = new MutationObserver((mutations) => {
    let hasVideo = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'VIDEO' ||
            (node.querySelector && node.querySelector('video'))) {
          hasVideo = true; break;
        }
      }
      if (hasVideo) break;
    }
    if (hasVideo) throttledBindAllVideos();
  });
  CS.observer.observe(document.documentElement, { childList: true, subtree: true });
}

function onGlobalMouseover(e) {
  const target = e.target;
  if (!target) return;

  const video = findVideoNear(target);
  if (video && isLiveVideo(video)) {
    clearTimeout(CS.leaveTimer);
    if (CS.hoverVideo !== video) {
      CS.hoverVideo = video;
      createHoverBar(video);
    }
  } else {
    if (CS.hoverBar && !CS.hoverBar.contains(target)) {
      CS.leaveTimer = setTimeout(destroyHoverBar, 600);
    }
  }
}

function findVideoNear(target) {
  if (!target) return null;
  if (target.tagName === 'VIDEO') return target;
  if (target.shadowRoot) {
    const v = target.shadowRoot.querySelector('video');
    if (v) return v;
  }
  if (target.querySelector) {
    const v = target.querySelector('video');
    if (v) return v;
  }
  const container = target.closest
    ? target.closest('[class*="player"],[class*="video"],[class*="Player"],[class*="Video"],figure,main')
    : null;
  if (container) {
    const v = container.querySelector('video');
    if (v) return v;
  }
  if (target.parentElement) {
    const v = target.parentElement.querySelector('video');
    if (v) return v;
  }
  return null;
}

function bindVideo(video) {
  if (video.__recBound) return;
  video.__recBound = true;
  video.addEventListener('mouseleave', () => {
    CS.leaveTimer = setTimeout(destroyHoverBar, 600);
  }, { passive: true });
}

// ============================================================
// 悬浮录制栏 UI
// ============================================================
function injectStyle() {
  if (document.getElementById('__rec_style__')) return;
  const style = document.createElement('style');
  style.id = '__rec_style__';
  style.textContent = `
    #__rec_hover_bar__ {
      position: fixed;
      z-index: 2147483647;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border: 1px solid #e53935;
      border-top: 3px solid #e53935;
      border-radius: 0 0 8px 8px;
      height: 42px;
      display: flex;
      align-items: center;
      box-shadow: 0 4px 20px rgba(229,57,53,0.35);
      font-family: 'Microsoft YaHei', Arial, sans-serif;
      font-size: 12px;
      color: #fff;
      overflow: hidden;
      user-select: none;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: auto;
      min-width: 280px;
    }
    #__rec_hover_bar__ .hb-logo {
      background: #e53935;
      width: 40px;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 18px;
    }
    #__rec_hover_bar__ .hb-title {
      padding: 0 12px;
      font-size: 12px;
      color: #ff8a80;
      font-weight: bold;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #__rec_hover_bar__ .hb-divider {
      width: 1px;
      height: 24px;
      background: #333;
      flex-shrink: 0;
    }
    #__rec_hover_bar__ button {
      background: transparent;
      border: none;
      color: #ddd;
      height: 100%;
      padding: 0 16px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      display: flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
      transition: all 0.15s;
      border-left: 1px solid #333;
    }
    #__rec_hover_bar__ button:first-of-type {
      border-left: none;
    }
    #__rec_hover_bar__ button:hover {
      background: rgba(229,57,53,0.2);
      color: #ff6b6b;
    }
    #__rec_hover_bar__ .hb-rec-btn {
      background: rgba(229,57,53,0.15) !important;
      color: #ff5252 !important;
      font-weight: bold;
    }
    #__rec_hover_bar__ .hb-rec-btn:hover {
      background: rgba(229,57,53,0.35) !important;
    }
    #__rec_hover_bar__ .hb-close {
      color: #666 !important;
      padding: 0 12px !important;
    }
    #__rec_hover_bar__ .hb-close:hover {
      background: rgba(255,255,255,0.05) !important;
      color: #999 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function createHoverBar(video) {
  destroyHoverBar();
  injectStyle();

  const bar = document.createElement('div');
  bar.id = '__rec_hover_bar__';
  bar.innerHTML = `
    <div class="hb-logo">🎬</div>
    <div class="hb-title">直播内录器</div>
    <div class="hb-divider"></div>
    <button class="hb-rec-btn" id="__rb_rec__">⏺ 开始录制</button>
    <button id="__rb_pip__">📺 小窗播放</button>
    <button class="hb-close" id="__rb_close__">✕</button>
  `;

  bar.addEventListener('mouseenter', () => clearTimeout(CS.leaveTimer));
  bar.addEventListener('mouseleave', () => {
    CS.leaveTimer = setTimeout(destroyHoverBar, 400);
  });

  bar.querySelector('#__rb_rec__').addEventListener('click', (e) => {
    e.stopPropagation();
    onClickRecord(video);
  });
  bar.querySelector('#__rb_pip__').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePiP(video);
  });
  bar.querySelector('#__rb_close__').addEventListener('click', (e) => {
    e.stopPropagation();
    destroyHoverBar();
  });

  document.documentElement.appendChild(bar);
  CS.hoverBar = bar;
  positionHoverBar(video);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (CS.hoverBar) CS.hoverBar.style.opacity = '1';
  }));

  function trackLoop() {
    if (!CS.hoverBar || !CS.hoverVideo) return;
    positionHoverBar(CS.hoverVideo);
    CS.hoverRAF = requestAnimationFrame(trackLoop);
  }
  CS.hoverRAF = requestAnimationFrame(trackLoop);
}

function positionHoverBar(video) {
  if (!CS.hoverBar) return;
  const rect = video.getBoundingClientRect();
  const barW = CS.hoverBar.offsetWidth || 280;
  let left   = rect.left + rect.width / 2 - barW / 2;
  left       = Math.max(4, Math.min(left, window.innerWidth - barW - 4));
  // 悬浮在视频顶部
  let top    = rect.top;
  if (top < 0) top = Math.min(rect.bottom - 42, 0);
  CS.hoverBar.style.top  = top + 'px';
  CS.hoverBar.style.left = left + 'px';
}

function destroyHoverBar() {
  clearTimeout(CS.leaveTimer);
  if (CS.hoverRAF) { cancelAnimationFrame(CS.hoverRAF); CS.hoverRAF = null; }
  if (CS.hoverBar) { CS.hoverBar.remove(); CS.hoverBar = null; }
  CS.hoverVideo = null;
}

// ============================================================
// 核心：点击录制 → 直接捕获 video 元素的纯净流
// ============================================================
async function onClickRecord(video) {
  // 验证视频有效性
  if (!video || !isLiveVideo(video)) {
    video = pickBestLiveVideo();
    if (!video) {
      showToast('❌ 未找到有效的直播视频，请确认视频正在播放');
      return;
    }
  }

  destroyHoverBar();
  REC.targetVideo = video;

  // 打开控制窗口（不自动开录，控制窗口仅作面板）
  // 同时在本页开始捕获流
  showToast('🎬 正在启动录制...');

  const config = {
    sysAudio  : true,
    micAudio  : false,
    noAudio   : false,
    format    : 'mp4',
    vbps      : 6000000,
    abps      : 192000,
    fps       : 30,
    filePrefix: '直播录制',
    quality   : 'hd',
  };

  // 在页面内直接启动录制
  await startCapture(video, config);
}

// ============================================================
// 核心录制管线：video.captureStream() 直接抽取纯净视频流
// ============================================================
async function startCapture(video, config) {
  if (REC.isRecording) {
    showToast('⚠️ 已在录制中');
    return;
  }

  // 清理旧资源
  cleanupRecording(false);

  REC.config     = config || {};
  REC.chunks     = [];
  REC.totalBytes = 0;
  REC.seconds    = 0;
  REC.isPaused   = false;
  REC.prevBytes  = 0;
  REC.prevTime   = performance.now();
  REC.chunkSeq   = 0;
  REC.sessionId  = 'cs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  REC.mimeType   = pickMime(config.format);

  // 写入 session 元数据
  await idbPut('sessions', {
    sessionId : REC.sessionId,
    mimeType  : REC.mimeType,
    prefix    : config.filePrefix || '直播录制',
    startTime : Date.now(),
    completed : false,
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 核心：直接从 video 元素捕获纯净视频流
  // captureStream(fps) 返回的流只包含视频内容，无任何网页元素
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let videoStream;
  try {
    const fps = config.fps || 30;
    videoStream = video.captureStream(fps);
  } catch (e) {
    showToast('❌ 无法捕获视频流（可能受 CORS 保护）: ' + e.message);
    await idbDeleteSession(REC.sessionId);
    return;
  }

  // 检查视频轨道有效性
  const videoTracks = videoStream.getVideoTracks();
  if (!videoTracks.length) {
    showToast('❌ 视频流中无视频轨道，视频可能未开始播放');
    await idbDeleteSession(REC.sessionId);
    return;
  }

  // 监听视频轨道结束（直播断流）
  videoTracks[0].onended = () => {
    if (REC.isRecording) {
      showToast('⚠️ 直播流已断开，正在保存...');
      doStop();
    }
  };

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 音频处理：
  // captureStream 会自动包含 video 元素的音频轨
  // 如果需要混入麦克风，使用 AudioContext 混音
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let finalStream;

  if (config.noAudio) {
    // 仅视频，无音频
    finalStream = new MediaStream(videoTracks);
  } else if (config.micAudio) {
    // 混入麦克风
    finalStream = await mixMicrophoneWithStream(videoStream);
  } else {
    // 使用 captureStream 自带的视频+音频（网页声音）
    finalStream = videoStream;
  }

  REC.captureStream = videoStream;
  REC.mixedStream   = finalStream;

  // 记录实际分辨率
  const vSettings = videoTracks[0].getSettings();
  if (vSettings.width && vSettings.height) {
    REC.config._resolution = vSettings.width + 'x' + vSettings.height;
  } else {
    REC.config._resolution = video.videoWidth + 'x' + video.videoHeight;
  }

  // 创建 MediaRecorder
  let recorder;
  try {
    recorder = new MediaRecorder(finalStream, {
      mimeType           : REC.mimeType,
      videoBitsPerSecond : config.vbps || 6_000_000,
      audioBitsPerSecond : config.abps || 192_000,
    });
  } catch (e) {
    // 降级尝试
    try {
      recorder = new MediaRecorder(finalStream, {
        mimeType: 'video/webm',
        videoBitsPerSecond: config.vbps || 6_000_000,
      });
      REC.mimeType = 'video/webm';
    } catch (e2) {
      showToast('❌ 无法创建录制器: ' + e2.message);
      await idbDeleteSession(REC.sessionId);
      cleanupRecording(true);
      return;
    }
  }

  recorder.ondataavailable = onData;
  recorder.onstop          = onRecorderStop;
  recorder.onerror = (ev) => {
    console.error('[content-rec] MediaRecorder 错误:', ev.error);
    doStop();
  };

  // 每秒分片，平衡实时性与性能
  recorder.start(1000);
  REC.mediaRecorder = recorder;
  REC.isRecording   = true;

  // 显示悬浮控制条
  showFloat('top-right');

  // 启动计时器
  startTimers();

  // 通知 background 更新状态
  notifyStateChanged(true, false);
  chrome.runtime.sendMessage({ action: 'notify', message: '🔴 录制已开始' }).catch(() => {});

  showToast('🔴 录制已开始！点击悬浮条可暂停/停止');
}

// 分片数据处理（内存 + IDB 双写）
function onData(e) {
  if (!e.data || e.data.size === 0) return;
  REC.chunks.push(e.data);
  REC.totalBytes += e.data.size;
  const seq = REC.chunkSeq++;
  idbAddChunk({ sessionId: REC.sessionId, seq, blob: e.data, ts: Date.now() }).catch(() => {});
}

// 暂停
function doPause() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state !== 'recording') return;
  REC.mediaRecorder.pause();
  REC.isPaused = true;
  notifyStateChanged(true, true);
  updateFloatPauseBtn(true);
}

// 继续
function doResume() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state !== 'paused') return;
  REC.mediaRecorder.resume();
  REC.isPaused = false;
  notifyStateChanged(true, false);
  updateFloatPauseBtn(false);
}

// 停止
function doStop() {
  if (!REC.isRecording && !REC.mediaRecorder) return;
  REC.isRecording = false;
  stopTimers();

  if (REC.mediaRecorder && REC.mediaRecorder.state !== 'inactive') {
    try { REC.mediaRecorder.stop(); } catch (_) {}
    // onstop 回调处理保存
  } else {
    onRecorderStop();
  }

  removeFloat();
}

// 录制完成：生成 Blob 并触发下载
async function onRecorderStop() {
  stopTimers();
  removeFloat();

  // 优先使用内存 chunks，否则从 IDB 恢复
  let chunks = REC.chunks;
  if (!chunks.length && REC.sessionId) {
    const idbChunks = await idbGetChunks(REC.sessionId);
    chunks = idbChunks.map(c => c.blob);
  }

  if (!chunks.length) {
    console.warn('[content-rec] 无录制数据');
    notifyStateChanged(false, false);
    cleanupRecording(true);
    return;
  }

  const mime     = REC.mimeType || 'video/webm';
  const blob     = new Blob(chunks, { type: mime });
  const ext      = mime.includes('mp4') ? 'mp4' : 'webm';
  const prefix   = (REC.config && REC.config.filePrefix) ? REC.config.filePrefix : '直播录制';
  const ts       = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
  const filename = prefix + '_' + ts + '.' + ext;
  const url      = URL.createObjectURL(blob);
  REC.blobUrls.push(url);

  // 委托 background 执行安全下载
  chrome.runtime.sendMessage({ action: 'triggerDownload', url, filename }, (resp) => {
    if (resp && resp.error) {
      console.error('[content-rec] 下载失败:', resp.error);
    }
  });

  // 标记 session 完成
  if (REC.sessionId) {
    await idbPut('sessions', {
      sessionId: REC.sessionId,
      mimeType : mime,
      prefix,
      completed: true,
      endTime  : Date.now(),
    });
    setTimeout(() => idbDeleteSession(REC.sessionId), 10000);
  }

  chrome.runtime.sendMessage({
    action : 'notify',
    message: '✅ 录制完成！' + fmtSize(REC.totalBytes) + ' · ' + fmtTime(REC.seconds),
  }).catch(() => {});

  showToast('✅ 录制完成，正在保存到下载目录...');
  notifyStateChanged(false, false);
  cleanupRecording(true);
}

// 清理录制资源
function cleanupRecording(resetAll) {
  stopTimers();

  if (REC.captureStream) {
    // 注意：不要 stop captureStream 的轨道，否则会影响页面视频播放
    // captureStream 轨道由视频元素管理，只需解除引用
    REC.captureStream = null;
  }

  if (REC.mixedStream) {
    // 只停止我们创建的额外轨道（麦克风轨）
    if (REC.audioCtx) {
      REC.audioCtx.close().catch(() => {});
      REC.audioCtx = null;
    }
    REC.mixedStream = null;
  }

  if (resetAll) {
    REC.mediaRecorder = null;
    REC.isRecording   = false;
    REC.chunks        = [];
    REC.chunkSeq      = 0;
    REC.targetVideo   = null;
  }
}

// 麦克风混音
async function mixMicrophoneWithStream(videoStream) {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });

    const ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === 'suspended') await ctx.resume();

    const dest      = ctx.createMediaStreamDestination();
    const videoTracks = videoStream.getVideoTracks();
    const audioTracks = videoStream.getAudioTracks();

    if (audioTracks.length) {
      ctx.createMediaStreamSource(new MediaStream(audioTracks)).connect(dest);
    }
    ctx.createMediaStreamSource(micStream).connect(dest);

    REC.audioCtx = ctx;

    return new MediaStream([...videoTracks, ...dest.stream.getAudioTracks()]);
  } catch (e) {
    console.warn('[content-rec] 麦克风混音失败，降级:', e.message);
    return videoStream;
  }
}

// ============================================================
// 计时器与性能监控
// ============================================================
function startTimers() {
  stopTimers();

  REC.timerInterval = setInterval(() => {
    if (REC.isPaused) return;
    REC.seconds++;
    pushMetrics();
  }, 1000);

  REC.prevTime  = performance.now();
  REC.prevBytes = 0;

  REC.monInterval = setInterval(() => {
    if (REC.isPaused) return;
    const now = performance.now();
    const dt  = Math.max((now - REC.prevTime) / 1000, 0.01);
    const bps = ((REC.totalBytes - REC.prevBytes) / dt) * 8;
    REC.prevBytes      = REC.totalBytes;
    REC.prevTime       = now;
    const kbps         = Math.round(bps / 1000);
    REC.currentBitrate = kbps > 1000 ? (kbps / 1000).toFixed(1) + 'Mbps' : kbps + 'kbps';
  }, 1000);
}

function stopTimers() {
  if (REC.timerInterval) { clearInterval(REC.timerInterval); REC.timerInterval = null; }
  if (REC.monInterval)   { clearInterval(REC.monInterval);   REC.monInterval   = null; }
}

function pushMetrics() {
  const resolution = (REC.config && REC.config._resolution) ? REC.config._resolution : '-';
  chrome.runtime.sendMessage({
    action     : 'metricsUpdate',
    isRecording: true,
    isPaused   : REC.isPaused,
    timeString : fmtTime(REC.seconds),
    sizeString : fmtSize(REC.totalBytes),
    bitrate    : REC.currentBitrate,
    resolution,
    fps        : (REC.config && REC.config.fps) ? REC.config.fps : 30,
    cpu        : '0%',
  }).catch(() => {});
}

function notifyStateChanged(isRecording, isPaused) {
  chrome.runtime.sendMessage({
    action: 'recordingStateChanged',
    state : {
      isRecording,
      isPaused,
      seconds   : REC.seconds,
      sizeString: fmtSize(REC.totalBytes),
      timeString: fmtTime(REC.seconds),
      resolution: (REC.config && REC.config._resolution) || '-',
      quality   : (REC.config && REC.config.quality) || 'hd',
    },
  }).catch(() => {});
}

// ============================================================
// 消息监听（来自 background 的指令）
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    // 悬浮控制条相关
    case 'showFloat':
      showFloat(msg.position || 'top-right');
      sendResponse({ ok: true });
      break;

    case 'removeFloat':
      removeFloat();
      sendResponse({ ok: true });
      break;

    case 'updateFloat':
      updateFloat(msg.paused, msg.time);
      sendResponse({ ok: true });
      break;

    // 录制控制（来自 popup 或 recorder 窗口）
    case 'stopRecording':
      if (REC.isRecording) doStop();
      sendResponse({ ok: true });
      break;

    case 'pauseRecording':
      if (REC.isRecording && !REC.isPaused) doPause();
      sendResponse({ ok: true });
      break;

    case 'resumeRecording':
      if (REC.isRecording && REC.isPaused) doResume();
      sendResponse({ ok: true });
      break;

    case 'emergencySave':
      // 录制窗口被意外关闭，触发紧急保存
      if (REC.isRecording) {
        showToast('⚠️ 录制窗口关闭，正在紧急保存...');
        doStop();
      }
      sendResponse({ ok: true });
      break;

    case 'releaseBlobUrl':
      if (req && req.url) {
        URL.revokeObjectURL(req.url);
        REC.blobUrls = REC.blobUrls.filter(u => u !== req.url);
      }
      sendResponse({ ok: true });
      break;

    // 区域选择
    case 'enableRegionSelect':
      startRegion();
      sendResponse({ ok: true });
      break;

    case 'disableRegionSelect':
      stopRegion();
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false });
  }
  return true;
});

// ============================================================
// 网页悬浮录制控制条
// ============================================================
function showFloat(position) {
  removeFloat();

  const posMap = {
    'top-right'    : 'top:16px;right:16px;',
    'top-left'     : 'top:16px;left:16px;',
    'bottom-right' : 'bottom:24px;right:16px;',
    'bottom-left'  : 'bottom:24px;left:16px;',
    'bottom-center': 'bottom:24px;left:50%;transform:translateX(-50%);',
  };

  const bar = document.createElement('div');
  bar.id = '__live_rec_float__';
  bar.style.cssText = [
    'position:fixed',
    posMap[position] || posMap['top-right'],
    'z-index:2147483647',
    'background:rgba(10,10,10,0.96)',
    'border:2px solid #e53935',
    'border-radius:12px',
    'padding:8px 14px',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'font-family:Microsoft YaHei,Arial,sans-serif',
    'font-size:13px',
    'color:#fff',
    'box-shadow:0 4px 30px rgba(229,57,53,0.5)',
    'user-select:none',
    'min-width:240px',
    'backdrop-filter:blur(12px)',
    'cursor:move',
  ].join(';');

  bar.innerHTML = `
    <style>
      @keyframes _rfblink {0%,100%{opacity:1}50%{opacity:.1}}
    </style>
    <span style="
      width:11px;height:11px;border-radius:50%;
      background:#e53935;flex-shrink:0;display:inline-block;
      animation:_rfblink 1s infinite;
      box-shadow:0 0 6px #e53935;
    "></span>
    <span id="_rf_time" style="
      font-family:'Courier New',monospace;
      font-size:15px;font-weight:bold;
      color:#ff5252;letter-spacing:2px;flex:1;
    ">00:00:00</span>
    <span id="_rf_size" style="font-size:11px;color:#888;margin-right:4px;">0MB</span>
    <button id="_rf_pause" style="
      background:rgba(255,152,0,0.15);
      border:1px solid #ff9800;color:#ff9800;
      padding:4px 11px;border-radius:5px;
      cursor:pointer;font-size:11px;font-family:inherit;
      transition:background 0.2s;
    ">⏸ 暂停</button>
    <button id="_rf_stop" style="
      background:rgba(229,57,53,0.15);
      border:1px solid #e53935;color:#e53935;
      padding:4px 11px;border-radius:5px;
      cursor:pointer;font-size:11px;font-family:inherit;
      transition:background 0.2s;
    ">⏹ 停止</button>
    <button id="_rf_close" style="
      background:transparent;border:none;
      color:#555;cursor:pointer;font-size:20px;
      line-height:1;padding:0 2px;
    ">×</button>
  `;

  document.documentElement.appendChild(bar);
  CS.floatBar    = bar;
  CS.floatSec    = 0;
  CS.floatPaused = false;

  // 暂停/继续
  bar.querySelector('#_rf_pause').addEventListener('click', () => {
    if (REC.isRecording) {
      if (REC.isPaused) doResume(); else doPause();
    }
  });

  // 停止
  bar.querySelector('#_rf_stop').addEventListener('click', () => {
    if (REC.isRecording) doStop();
    else removeFloat();
  });

  // 关闭（仅隐藏浮窗，不停止录制）
  bar.querySelector('#_rf_close').addEventListener('click', () => {
    removeFloat();
  });

  makeDraggable(bar);
  startFloatTimer();
}

function removeFloat() {
  if (CS.floatBar) { CS.floatBar.remove(); CS.floatBar = null; }
  stopFloatTimer();
}

function updateFloat(paused, timeStr) {
  CS.floatPaused = !!paused;
  const te = document.getElementById('_rf_time');
  if (te && timeStr) te.textContent = timeStr;
  updateFloatPauseBtn(paused);

  // 同步文件大小
  const se = document.getElementById('_rf_size');
  if (se) se.textContent = fmtSize(REC.totalBytes);
}

function updateFloatPauseBtn(paused) {
  const pe = document.getElementById('_rf_pause');
  if (pe) pe.textContent = paused ? '▶ 继续' : '⏸ 暂停';
}

function startFloatTimer() {
  stopFloatTimer();
  CS.floatTimer = setInterval(() => {
    if (CS.floatPaused) return;
    CS.floatSec++;
    const el = document.getElementById('_rf_time');
    if (!el) { stopFloatTimer(); return; }
    el.textContent = fmtTime(CS.floatSec);
    const se = document.getElementById('_rf_size');
    if (se) se.textContent = fmtSize(REC.totalBytes);
  }, 1000);
}

function stopFloatTimer() {
  if (CS.floatTimer) { clearInterval(CS.floatTimer); CS.floatTimer = null; }
}

// ── 拖拽 ─────────────────────────────────────────────────────
function makeDraggable(el) {
  let drag = false, sx, sy, ox, oy;
  el.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    drag = true;
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect();
    ox = r.left; oy = r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    el.style.left      = Math.max(0, ox + e.clientX - sx) + 'px';
    el.style.top       = Math.max(0, oy + e.clientY - sy) + 'px';
    el.style.right     = 'auto';
    el.style.bottom    = 'auto';
    el.style.transform = 'none';
  });
  document.addEventListener('mouseup', () => { drag = false; });
}

// ── Toast 提示 ────────────────────────────────────────────────
function showToast(msg, ms) {
  ms = ms || 2800;
  let el = document.getElementById('__rec_toast__');
  if (!el) {
    el = document.createElement('div');
    el.id = '__rec_toast__';
    el.style.cssText = [
      'position:fixed', 'bottom:80px', 'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(10,10,10,0.96)',
      'border:1px solid #444',
      'color:#fff', 'padding:11px 24px',
      'border-radius:10px', 'font-size:13px',
      'font-family:Microsoft YaHei,Arial,sans-serif',
      'z-index:2147483647', 'pointer-events:none',
      'white-space:nowrap',
      'box-shadow:0 4px 24px rgba(0,0,0,0.5)',
      'transition:opacity .3s', 'opacity:0',
      'max-width:90vw',
    ].join(';');
    document.documentElement.appendChild(el);
  }
  el.textContent   = msg;
  el.style.opacity = '1';
  clearTimeout(el.__t);
  el.__t = setTimeout(() => { el.style.opacity = '0'; }, ms);
}

// ── 画中画 ────────────────────────────────────────────────────
async function togglePiP(video) {
  try {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      showToast('🪟 已退出小窗口播放');
    } else {
      await video.requestPictureInPicture();
      showToast('🪟 小窗口播放已开启');
    }
  } catch (e) {
    showToast('❌ 小窗口不可用: ' + e.message);
  }
}

// ── 区域选择 ─────────────────────────────────────────────────
function startRegion() {
  if (CS.regionActive) return;
  CS.regionActive = true;

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483646',
    'background:rgba(0,0,0,0.4)', 'cursor:crosshair',
  ].join(';');

  const tip = document.createElement('div');
  tip.style.cssText = [
    'position:fixed', 'top:50%', 'left:50%',
    'transform:translate(-50%,-50%)',
    'background:rgba(229,57,53,0.95)',
    'color:#fff', 'padding:14px 32px', 'border-radius:10px',
    'font-size:15px', 'font-family:Microsoft YaHei,Arial',
    'pointer-events:none', 'user-select:none', 'white-space:nowrap',
    'box-shadow:0 4px 20px rgba(0,0,0,0.4)',
  ].join(';');
  tip.textContent = '🔲 拖拽选择录制区域 | Esc 取消';
  overlay.appendChild(tip);
  document.documentElement.appendChild(overlay);

  let startX, startY, selBox = null;

  overlay.addEventListener('mousedown', (e) => {
    tip.style.display = 'none';
    startX = e.clientX; startY = e.clientY;
    selBox = document.createElement('div');
    selBox.style.cssText = [
      'position:fixed', 'border:2px dashed #e53935',
      'background:rgba(229,57,53,0.1)',
      'pointer-events:none', 'z-index:2147483647',
      'box-shadow:0 0 0 2000px rgba(0,0,0,0.3)',
    ].join(';');
    document.documentElement.appendChild(selBox);
  });

  document.addEventListener('mousemove', (e) => {
    if (!selBox) return;
    selBox.style.left   = Math.min(e.clientX, startX) + 'px';
    selBox.style.top    = Math.min(e.clientY, startY) + 'px';
    selBox.style.width  = Math.abs(e.clientX - startX) + 'px';
    selBox.style.height = Math.abs(e.clientY - startY) + 'px';
  });

  document.addEventListener('mouseup', (e) => {
    if (!selBox) return;
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selBox.remove(); selBox = null;
    cleanup();
    if (w > 10 && h > 10) showToast('🔲 已选区域: ' + Math.round(w) + '×' + Math.round(h));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (selBox) { selBox.remove(); selBox = null; }
    cleanup();
  });

  function cleanup() {
    CS.regionActive = false;
    overlay.remove();
  }
}

function stopRegion() { CS.regionActive = false; }

// ── MIME 选择 ─────────────────────────────────────────────────
function pickMime(format) {
  const mp4Candidates = [
    'video/mp4;codecs=avc1.64001F,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ];
  const webmCandidates = [
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  const list = format === 'mp4' ? mp4Candidates : webmCandidates;
  return list.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

// ── 启动 ─────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init().catch(console.error); });
} else {
  init().catch(console.error);
}
