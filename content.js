'use strict';

/**
 * content.js - 零堆积高能效采集端
 * 
 * 物理职责：
 * 1. 通过 Shadow DOM 穿透检索真实的 <video> 元素
 * 2. 建立跨进程长连接 Port 管道 (stream_pipeline)
 * 3. 拦截 MediaRecorder 分片，执行“即时推送、即时销毁”，网页本地内存始终为 0MB
 * 4. 正常退出时发送握手完结消息，规避小窗产生崩溃恢复警告 [纠正 1]
 */

const REC = {
  mediaRecorder  : null,
  captureStream  : null,   
  audioStream    : null,   
  mixedStream    : null,   
  audioCtx       : null,
  port           : null,     // 物理高带宽传输管道
  totalBytes     : 0,
  seconds        : 0,
  isPaused       : false,
  isRecording    : false,
  config         : null,
  targetVideo    : null,   
  timerInterval  : null,
  monInterval    : null,
  prevBytes      : 0,
  prevTime       : 0,
  currentBitrate : '0kbps',
  mimeType       : 'video/webm',
};

const CS = {
  hoverVideo  : null,
  hoverBar    : null,
  hoverRAF    : null,
  leaveTimer  : null,
  floatBar    : null,
  floatTimer  : null,
  floatSec    : 0,
  floatPaused : false,
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

function init() {
  initVideoDetection();
}

function findVideosDeep(root) {
  root = root || document;
  const videos = [];

  function traverse(node) {
    if (!node) return;
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.tagName === 'VIDEO') videos.push(node);
    const ch = node.children;
    if (ch) {
      for (let i = 0; i < ch.length; i++) traverse(ch[i]);
    }
    if (node.shadowRoot) traverse(node.shadowRoot);
  }

  traverse(root);
  return videos;
}

function isLiveVideo(video) {
  if (!video) return false;
  const rect = video.getBoundingClientRect();
  if (rect.width < 320 || rect.height < 180) return false;
  if (!video.src && !video.srcObject && !video.currentSrc) return false;
  if (isFinite(video.duration) && video.duration > 0 && video.duration < 10) return false;
  return true;
}

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

function throttledBindAllVideos() {
  if (CS.bindTimeout) return;
  CS.bindTimeout = setTimeout(() => {
    CS.bindTimeout = null;
    findVideosDeep().forEach(bindVideo);
  }, 800);
}

function initVideoDetection() {
  findVideosDeep().forEach(bindVideo);
  document.addEventListener('mouseover', onGlobalMouseover, { passive: true });

  const observer = new MutationObserver((mutations) => {
    let hasVideo = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'VIDEO' || (node.querySelector && node.querySelector('video'))) {
          hasVideo = true; break;
        }
      }
      if (hasVideo) break;
    }
    if (hasVideo) throttledBindAllVideos();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
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
  const container = target.closest?.('[class*="player"],[class*="video"],[class*="Player"],[class*="Video"],figure,main');
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

function injectStyle() {
  if (document.getElementById('__rec_style__')) return;
  const style = document.createElement('style');
  style.id = '__rec_style__';
  style.textContent = `
    #__rec_hover_bar__ {
      position: fixed; z-index: 2147483647;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border: 1px solid #e53935; border-top: 3px solid #e53935; border-radius: 0 0 8px 8px;
      height: 42px; display: flex; align-items: center;
      box-shadow: 0 4px 20px rgba(229,57,53,0.35);
      font-family: 'Microsoft YaHei', Arial, sans-serif; font-size: 12px; color: #fff;
      overflow: hidden; user-select: none; opacity: 0; transition: opacity 0.2s ease;
      pointer-events: auto; min-width: 280px;
    }
    #__rec_hover_bar__.show { opacity: 1; }
    #__rec_hover_bar__ .hb-logo { background: #e53935; width: 40px; height: 100%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 18px; }
    #__rec_hover_bar__ .hb-title { padding: 0 12px; font-size: 12px; color: #ff8a80; font-weight: bold; white-space: nowrap; flex-shrink: 0; }
    #__rec_hover_bar__ .hb-divider { width: 1px; height: 24px; background: #333; flex-shrink: 0; }
    #__rec_hover_bar__ button { background: transparent; border: none; color: #ddd; height: 100%; padding: 0 16px; cursor: pointer; font-size: 12px; font-family: inherit; display: flex; align-items: center; gap: 5px; white-space: nowrap; transition: all 0.15s; border-left: 1px solid #333; }
    #__rec_hover_bar__ button:first-of-type { border-left: none; }
    #__rec_hover_bar__ button:hover { background: rgba(229,57,53,0.2); color: #ff6b6b; }
    #__rec_hover_bar__ .hb-rec-btn { background: rgba(229,57,53,0.15) !important; color: #ff5252 !important; font-weight: bold; }
    #__rec_hover_bar__ .hb-close { color: #666 !important; padding: 0 12px !important; }
    #__rec_hover_bar__ .hb-close:hover { background: rgba(255,255,255,0.05) !important; color: #999 !important; }
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
    if (CS.hoverBar) CS.hoverBar.classList.add('show');
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

async function onClickRecord(video) {
  if (!video || !isLiveVideo(video)) {
    video = pickBestLiveVideo();
    if (!video) {
      showToast('❌ 未找到视频源');
      return;
    }
  }

  destroyHoverBar();
  REC.targetVideo = video;
  showToast('🎬 正在建立零堆积物理传输流...');

  const config = {
    sysAudio  : true,
    micAudio  : false,
    noAudio   : false,
    format    : 'mp4',
    vbps      : 8000000,
    abps      : 192000,
    fps       : 30,
    filePrefix: '直播录制',
    quality   : 'hd',
    autoStart : true
  };

  await startCapture(video, config);
}

async function startCapture(video, config) {
  if (REC.isRecording) {
    showToast('⚠️ 已在录制中');
    return;
  }

  cleanupRecording(false);

  REC.config     = config || {};
  REC.totalBytes = 0;
  REC.seconds    = 0;
  REC.isPaused   = false;
  REC.prevBytes  = 0;
  REC.prevTime   = performance.now();
  REC.mimeType   = pickMime(config.format);

  // 建立双向 IPC 传输通道
  REC.port = chrome.runtime.connect({ name: 'content_stream' });

  let videoStream;
  try {
    const fps = config.fps || 30;
    videoStream = video.captureStream(fps);
  } catch (e) {
    console.warn('[content-rec] 跨域保护限制直提，切换 tabCapture 备用管线:', e.message);
    showToast('⚠️ 视频受跨域保护，已启动备用合成器，请勿最小化网页...');

    chrome.runtime.sendMessage({
      action: 'fallbackToTabCapture',
      config: config
    }, () => { void chrome.runtime.lastError; });

    cleanupRecording(true);
    return;
  }

  const videoTracks = videoStream.getVideoTracks();
  if (!videoTracks.length) {
    showToast('❌ 视频轨道捕获失败');
    return;
  }

  videoTracks[0].onended = () => {
    if (REC.isRecording) {
      showToast('⚠️ 直播流已断开，正在保存...');
      doStop();
    }
  };

  let finalStream;
  if (config.noAudio) {
    finalStream = new MediaStream(videoTracks);
  } else if (config.micAudio) {
    finalStream = await mixMicrophoneWithStream(videoStream);
  } else {
    finalStream = videoStream;
  }

  REC.captureStream = videoStream;
  REC.mixedStream   = finalStream;

  const vSettings = videoTracks[0].getSettings();
  REC.config._resolution = (vSettings.width && vSettings.height) 
    ? vSettings.width + 'x' + vSettings.height 
    : video.videoWidth + 'x' + video.videoHeight;

  let recorder;
  try {
    recorder = new MediaRecorder(finalStream, {
      mimeType           : REC.mimeType,
      videoBitsPerSecond : config.vbps || 8_000_000,
      audioBitsPerSecond : config.abps || 192_000,
    });
  } catch (e) {
    try {
      recorder = new MediaRecorder(finalStream, {
        mimeType: 'video/webm',
        videoBitsPerSecond: config.vbps || 8_000_000,
      });
      REC.mimeType = 'video/webm';
    } catch (e2) {
      showToast('❌ 录制器实例化失败: ' + e2.message);
      cleanupRecording(true);
      return;
    }
  }

  recorder.ondataavailable = onData;
  recorder.onstop          = onRecorderStop;
  recorder.onerror = (ev) => {
    console.error('[content-rec] MediaRecorder 内部错误:', ev.error);
    doStop();
  };

  recorder.start(1000);
  REC.mediaRecorder = recorder;
  REC.isRecording   = true;

  chrome.runtime.sendMessage({
    action: 'startRecordFromContent',
    config: config
  }, () => { void chrome.runtime.lastError; });

  showFloat('top-right');
  startTimers();
  notifyStateChanged(true, false);
}

function onData(e) {
  if (!e.data || e.data.size === 0) return;
  REC.totalBytes += e.data.size;
  // 零内存残留：即时发送
  if (REC.port) {
    REC.port.postMessage({ action: 'chunk', blob: e.data });
  }
}

function doPause() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state !== 'recording') return;
  REC.mediaRecorder.pause();
  REC.isPaused = true;
  notifyStateChanged(true, true);
  updateFloatPauseBtn(true);
}

function doResume() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state !== 'paused') return;
  REC.mediaRecorder.resume();
  REC.isPaused = false;
  notifyStateChanged(true, false);
  updateFloatPauseBtn(false);
}

function doStop() {
  if (!REC.isRecording && !REC.mediaRecorder) return;
  REC.isRecording = false;
  stopTimers();

  if (REC.mediaRecorder && REC.mediaRecorder.state !== 'inactive') {
    try { REC.mediaRecorder.stop(); } catch (_) {}
  } else {
    onRecorderStop();
  }
  removeFloat();
}

function onRecorderStop() {
  stopTimers();
  removeFloat();
  showToast('✅ 录制结束，视频流已成功安全落盘...');
  notifyStateChanged(false, false);

  // [纠正 1] 主动给小窗递交“握手完结”命令，告知小窗这是用户的正常终止，而非网页崩溃
  if (REC.port) {
    try {
      REC.port.postMessage({ action: 'complete' });
    } catch (_) {}
  }

  cleanupRecording(true);
}

function cleanupRecording(resetAll) {
  stopTimers();

  if (REC.captureStream) {
    REC.captureStream = null;
  }

  if (REC.mixedStream) {
    if (REC.audioCtx) {
      REC.audioCtx.close().catch(() => {});
      REC.audioCtx = null;
    }
    REC.mixedStream = null;
  }

  if (resetAll) {
    REC.mediaRecorder = null;
    REC.isRecording   = false;
    REC.targetVideo   = null;
    if (REC.port) {
      try { REC.port.disconnect(); } catch (_) {}
      REC.port = null;
    }
  }
}

async function mixMicrophoneWithStream(videoStream) {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });

    const ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === 'suspended') await ctx.resume();

    const dest = ctx.createMediaStreamDestination();
    const videoTracks = videoStream.getVideoTracks();
    const audioTracks = videoStream.getAudioTracks();

    if (audioTracks.length) {
      ctx.createMediaStreamSource(new MediaStream(audioTracks)).connect(dest);
    }
    ctx.createMediaStreamSource(micStream).connect(dest);
    REC.audioCtx = ctx;

    return new MediaStream([...videoTracks, ...dest.stream.getAudioTracks()]);
  } catch (e) {
    console.warn('[content-rec] 混音失败:', e.message);
    return videoStream;
  }
}

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
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
      if (REC.isRecording) {
        doStop();
      }
      sendResponse({ ok: true });
      break;

    case 'releaseBlobUrl':
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false });
  }
  return true;
});

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

  bar.querySelector('#_rf_pause').addEventListener('click', () => {
    if (REC.isRecording) {
      if (REC.isPaused) doResume(); else doPause();
    }
  });

  bar.querySelector('#_rf_stop').addEventListener('click', () => {
    if (REC.isRecording) doStop();
    else removeFloat();
  });

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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init(); });
} else {
  init();
}


------------------------------------------------------------
FILE: recorder.js
------------------------------------------------------------
'use strict';

/**
 * recorder.js - OPFS 极速自愈录制引擎
 * 
 * 物理职责：
 * 1. 作为独立进程，接收 content.js 跨进程推送来的原始分片数据
 * 2. 引入 Origin Private File System (OPFS)，执行高性能、无阻碍的文件流直写
 * 3. 崩溃自愈保护：探测到网页连接意外断开（崩溃）时，自动触发文件封口及自适应下载
 * 4. 下载完成即时执行 OPFS 临时磁盘空间完全抹除，确保空间零占用
 */

const QUALITY_PRESETS = {
  uhd: { label:'超清 4K',  vbps:16_000_000, abps:256_000, fps:60, res:'3840×2160' },
  hd : { label:'高清 1080P', vbps:8_000_000,  abps:192_000, fps:30, res:'1920×1080' },
  sd : { label:'标清 720P',  vbps:3_000_000,  abps:128_000, fps:30, res:'1280×720'  },
};

let currentQuality   = 'hd';
let isRecording      = false;
let isPaused         = false;
let activeTabId      = null;
let presetStreamId   = null;

let keepAliveStream  = null;
let audioContext     = null;

// OPFS 引擎状态机
let fileHandle       = null;
let writableStream   = null;
let opfsInitialized  = false;
let currentTotalBytes = 0;
let currentConfig    = {};
let isNormalStop     = false; // [纠正 1] 区分正常停止与异常断连状态

// Fallback 模式状态
let fallbackRecorder = null;
let fallbackSeconds  = 0;
let fallbackTimer    = null;

const $ = (id) => document.getElementById(id);

function init() {
  const params   = new URLSearchParams(window.location.search);
  activeTabId    = parseInt(params.get('tabId')) || null;
  presetStreamId = params.get('streamId') || null;

  try {
    currentConfig = JSON.parse(decodeURIComponent(params.get('config') || '{}'));
    if (currentConfig.quality && QUALITY_PRESETS[currentConfig.quality]) {
      currentQuality = currentConfig.quality;
    }
  } catch (_) {}

  setQualityHighlight(currentQuality);
  updateFormat();
  bindEvents();

  // 跨进程长连接管道接收端初始化
  const pipelinePort = chrome.runtime.connect({ name: 'recorder_pipeline' });
  pipelinePort.onMessage.addListener(async (msg) => {
    if (msg.action === 'chunk') {
      await writeToOPFS(msg.blob);
      currentTotalBytes += msg.blob.size;
    } else if (msg.action === 'complete') {
      // 收到网页端的主动停止握手信号
      isNormalStop = true;
      await finalizeOPFSRecording(currentConfig);
    } else if (msg.action === 'content_disconnected') {
      // 只有在非正常握手、确实由网页崩溃断连引发时，才触发红色自愈保护栏 [纠正 1]
      if (!isNormalStop) {
        await handleContentCrash();
      }
      isNormalStop = false; // 复位防线
    }
  });
}

// ============================================================
// OPFS 高性能持久化存储核心 [Law-52]
// ============================================================
async function initOPFS() {
  try {
    const root = await navigator.storage.getDirectory();
    // 使用专属的私有缓存文件名，100% 避免普通网页脚本嗅探读取
    fileHandle = await root.getFileHandle('live_recording_cache.tmp', { create: true });
    writableStream = await fileHandle.createWritable({ keepExistingData: false });
    opfsInitialized = true;
    console.log('[OPFS] 高性能沙箱文件流初始化成功。');
  } catch (e) {
    showError('❌ OPFS 存储系统加载失败: ' + e.message);
  }
}

async function writeToOPFS(blob) {
  if (!opfsInitialized) {
    await initOPFS();
  }
  if (writableStream) {
    try {
      await writableStream.write(blob);
    } catch (e) {
      console.error('[OPFS] 块写入失败:', e);
    }
  }
}

// 物理合并落盘与安全恢复引擎
async function finalizeOPFSRecording(config) {
  if (!writableStream) return;
  try {
    await writableStream.close(); // 锁定并封口文件流
    writableStream = null;
    opfsInitialized = false;

    const file = await fileHandle.getFile();
    if (file.size === 0) {
      console.warn('[OPFS] 检测到空视频流');
      return;
    }

    const mime = file.type || 'video/webm';
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const prefix = (config && config.filePrefix) ? config.filePrefix : '直播录制';
    const ts = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
    const filename = prefix + '_' + ts + '.' + ext;
    
    // 生成临时安全链接
    const url = URL.createObjectURL(file);

    // [纠正 2] 必须向 background 投递 triggerDownload 事务
    // 直接在此处调用下载会导致后台 downloads.onChanged 无法监控到 downloadId
    // 进而使 Blob 内存泄露（ObjectURL 永不释放）且沙箱临时文件（OPFS）永远残留在磁盘中！
    chrome.runtime.sendMessage({
      action: 'triggerDownload',
      url: url,
      filename: filename
    }, (resp) => {
      if (resp && resp.error) {
        console.error('[OPFS] 下载唤醒失败:', resp.error);
        URL.revokeObjectURL(url);
      }
    });

    chrome.runtime.sendMessage({
      action: 'notify',
      message: '✅ 录制成功落盘！体积: ' + fmtSize(file.size)
    });
  } catch (e) {
    console.error('[OPFS] 最终落盘合并失败:', e);
  }
}

// 崩溃自愈保护：网页端突发死锁/强杀时紧急回收并合并已录制成果
async function handleContentCrash() {
  console.warn('[OPFS] 警告：检测到网页长连接断开（网页可能崩溃）。执行紧急自愈保存...');
  if (writableStream) {
    await finalizeOPFSRecording(currentConfig);
    showError('⚠️ 直播播放页面已断开，已为您自动挽救并合并之前录制的全部视频！');
  }
  isRecording = false;
  updateUI();
}

async function clearOPFSTempFile() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('live_recording_cache.tmp');
    console.log('[OPFS] 临时落盘物理缓存已安全擦除，空间释放。');
  } catch (e) {
    console.warn('[OPFS] 缓存擦除失败:', e.message);
  }
}

function bindEvents() {
  $('qUHD').addEventListener('click', () => setQuality('uhd'));
  $('qHD').addEventListener('click',  () => setQuality('hd'));
  $('qSD').addEventListener('click',  () => setQuality('sd'));

  $('bigRecBtn').addEventListener('click', () => {
    if (fallbackRecorder) {
      stopFallbackRecording();
    } else if (isRecording) {
      sendToContent('stopRecording');
    }
  });

  $('btnPause').addEventListener('click', () => {
    if (!isRecording) return;
    if (isPaused) {
      if (fallbackRecorder) {
        fallbackRecorder.resume();
        isPaused = false;
        updateUI();
      } else {
        sendToContent('resumeRecording');
      }
    } else {
      if (fallbackRecorder) {
        fallbackRecorder.pause();
        isPaused = true;
        updateUI();
      } else {
        sendToContent('pauseRecording');
      }
    }
  });

  $('btnStop').addEventListener('click', () => {
    if (fallbackRecorder) {
      stopFallbackRecording();
    } else if (isRecording) {
      sendToContent('stopRecording');
    }
  });
}

// ============================================================
// tabCapture 独占保活 (静默拉流，锁死后台帧率)
// ============================================================
async function activateKeepAlive(streamId) {
  if (keepAliveStream) return;
  console.log('[recorder] 激活物理保活流, streamId:', streamId);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource  : 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      audio: {
        mandatory: {
          chromeMediaSource  : 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    keepAliveStream = stream;

    if (stream.getAudioTracks().length > 0) {
      try {
        const sysCtx = new AudioContext({ sampleRate: 48000 });
        if (sysCtx.state === 'suspended') await sysCtx.resume();
        const source = sysCtx.createMediaStreamSource(stream);
        source.connect(sysCtx.destination);
        audioContext = sysCtx;
      } catch (ae) {
        console.warn('[recorder] 绕过扬声器失败:', ae.message);
      }
    }

    const player = $('previewPlayer');
    const container = $('previewContainer');
    if (player) {
      player.srcObject = stream;
      player.play().then(() => {
        if (container) container.style.display = 'block';
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[recorder] 物理保活流建立失败:', e.message);
  }
}

function releaseKeepAlive() {
  if (keepAliveStream) {
    keepAliveStream.getTracks().forEach(track => track.stop());
    keepAliveStream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  const player = $('previewPlayer');
  const container = $('previewContainer');
  if (player) player.srcObject = null;
  if (container) container.style.display = 'none';
}

// ============================================================
// 备用 tabCapture 录制管线 (CORS Fallback)
// ============================================================
async function startFallbackRecording(config) {
  if (!keepAliveStream) {
    showError('❌ 备用录制器启动失败：保活流就绪异常');
    return;
  }

  currentTotalBytes = 0;
  fallbackSeconds = 0;

  try {
    const mime = pickMime(config.format);
    fallbackRecorder = new MediaRecorder(keepAliveStream, {
      mimeType: mime,
      videoBitsPerSecond: config.vbps || 8_000_000,
      audioBitsPerSecond: config.abps || 192_000,
    });

    fallbackRecorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        await writeToOPFS(e.data); // 直接追加写入沙箱文件
        currentTotalBytes += e.data.size;
      }
    };

    fallbackRecorder.onstop = async () => {
      await finalizeOPFSRecording(config);
    };

    fallbackRecorder.start(1000);
    isRecording = true;
    isPaused    = false;
    updateUI();

    startFallbackTimer();
    console.log('[recorder] 备用 OPFS-TabCapture 录制引擎开始运行。');
  } catch (e) {
    showError('❌ 备用引擎故障: ' + e.message);
  }
}

function stopFallbackRecording() {
  if (fallbackRecorder && fallbackRecorder.state !== 'inactive') {
    fallbackRecorder.stop();
  }
  stopFallbackTimer();
  isRecording = false;
  updateUI();
}

function startFallbackTimer() {
  stopFallbackTimer();
  fallbackTimer = setInterval(() => {
    if (isPaused) return;
    fallbackSeconds++;

    applyMetrics({
      isRecording: true,
      isPaused: isPaused,
      timeString: fmtTime(fallbackSeconds),
      sizeString: fmtSize(currentTotalBytes),
      bitrate: '8Mbps',
      resolution: QUALITY_PRESETS[currentQuality].res,
      fps: 30
    });
  }, 1000);
}

function stopFallbackTimer() {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}

function sendToContent(action, extra) {
  if (!activeTabId) {
    showError('❌ 未定位到目标页面，请重新开启');
    return;
  }
  chrome.tabs.sendMessage(
    activeTabId,
    Object.assign({ action }, extra || {}),
    () => { void chrome.runtime.lastError; }
  );
}

// 统一事件分发器
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg._target === 'recorder') {
    switch (msg.action) {
      case 'stopRecording':
        if (fallbackRecorder) stopFallbackRecording();
        else                  sendToContent('stopRecording');
        break;
      case 'pauseRecording':
        if (fallbackRecorder) { fallbackRecorder.pause(); isPaused = true; updateUI(); }
        else                  sendToContent('pauseRecording');
        break;
      case 'resumeRecording':
        if (fallbackRecorder) { fallbackRecorder.resume(); isPaused = false; updateUI(); }
        else                  sendToContent('resumeRecording');
        break;
      case 'releaseBlobUrl':
        if (msg.url) {
          URL.revokeObjectURL(msg.url);
        }
        clearOPFSTempFile(); // 彻底销毁本地临时物理文件 [Law-39]
        break;
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'startTabCaptureRecording') {
    startFallbackRecording(msg.config || {});
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'stateSync' || msg.action === 'recordingStateChanged') {
    const state = msg.state || msg;
    applyState(state);
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'metricsUpdate') {
    if (!fallbackRecorder) {
      applyMetrics(msg);
    }
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false });
});

// 长连接事件同步
const bgPort = chrome.runtime.connect({ name: 'recorder_panel' });
bgPort.onMessage.addListener((msg) => {
  if (msg.action === 'stateSync') {
    applyState(msg.state);
  }
  if (msg.action === 'metricsUpdate' && !fallbackRecorder) {
    applyMetrics(msg);
  }
});

function applyState(state) {
  if (!state) return;
  const wasRecording = isRecording;
  isRecording = !!state.isRecording;
  isPaused    = !!state.isPaused;

  updateUI();

  if (isRecording && !wasRecording && !keepAliveStream && presetStreamId) {
    activateKeepAlive(presetStreamId);
  }

  if (!isRecording && wasRecording) {
    releaseKeepAlive();
  }

  if (state.resolution && state.resolution !== '-') {
    setText('mRes', state.resolution);
  }
  if (state.timeString) {
    setText('timerDisplay', state.timeString);
  }
  if (state.sizeString) {
    setText('mSize', state.sizeString);
  }
}

function applyMetrics(msg) {
  isRecording = !!msg.isRecording;
  isPaused    = !!msg.isPaused;
  updateUI();

  if (msg.timeString) setText('timerDisplay', msg.timeString);
  
  // 采用 OPFS 中写入的物理文件大小进行实时修正
  const sizeToDisplay = currentTotalBytes > 0 ? currentTotalBytes : (parseInt(msg.sizeString) || 0);
  setText('mSize', fmtSize(sizeToDisplay));
  
  if (msg.bitrate)    setText('mBitrate', msg.bitrate);
  if (msg.resolution) setText('mRes', msg.resolution);
  if (msg.fps)        setText('mFps', String(msg.fps));
  setText('footerInfo', '已录制 ' + fmtSize(sizeToDisplay));
}

function updateUI() {
  const dot     = $('statusDot');
  const txt     = $('statusText');
  const timer   = $('timerDisplay');
  const recDot  = $('recDot');
  const hint    = $('hintBox');
  const ctrls   = $('recControls');
  const bigBtn  = $('bigRecBtn');
  const bigLbl  = $('bigRecLabel');
  const pBtn    = $('btnPause');

  if (isRecording && !isPaused) {
    dot.className    = 'status-indicator recording';
    txt.textContent  = fallbackRecorder ? '🔴 正在以备用引擎捕获直播(勿切屏)...' : '🔴 正在以极客引擎直录纯净视频...';
    timer.className  = 'timer-display recording';
    recDot.style.display = 'block';
    hint.style.display   = 'none';
    ctrls.style.display  = 'flex';
    bigBtn.className = 'big-rec-btn recording';
    bigLbl.textContent = '点击停止';
    if (pBtn) { pBtn.disabled = false; pBtn.textContent = '⏸ 暂停'; }
  } else if (isPaused) {
    dot.className    = 'status-indicator paused';
    txt.textContent  = '⏸ 录制已暂停';
    timer.className  = 'timer-display paused';
    recDot.style.display = 'block';
    hint.style.display   = 'none';
    ctrls.style.display  = 'flex';
    bigBtn.className = 'big-rec-btn paused';
    bigLbl.textContent = '已暂停';
    if (pBtn) { pBtn.disabled = false; pBtn.textContent = '▶ 继续'; }
  } else {
    dot.className    = 'status-indicator ready';
    txt.textContent  = '就绪 — 请在网页直播视频上点击「⏺ 开始录制」';
    timer.className  = 'timer-display';
    setText('timerDisplay', '00:00:00');
    recDot.style.display = 'none';
    hint.style.display   = 'block';
    ctrls.style.display  = 'none';
    setText('footerInfo', '等待录制...');
    if (pBtn) { pBtn.disabled = true; pBtn.textContent = '⏸ 暂停'; }
  }
}

function setQuality(q) {
  if (!QUALITY_PRESETS[q]) return;
  currentQuality = q;
  setQualityHighlight(q);
  updateFormat();

  if (isRecording && !fallbackRecorder) {
    sendToContent('updateConfig', { config: buildConfigForQuality(q) });
  }
}

function setQualityHighlight(q) {
  ['qUHD', 'qHD', 'qSD'].forEach((k) => {
    const el = $(k);
    if (el) el.classList.toggle('active', k === 'q' + q.toUpperCase());
  });
}

function buildConfigForQuality(q) {
  const p = QUALITY_PRESETS[q];
  return {
    quality  : q,
    vbps     : p.vbps,
    abps     : p.abps,
    fps      : p.fps,
    sysAudio : true,
    micAudio : false,
    noAudio  : false,
    format   : 'mp4',
    filePrefix: '直播录制',
  };
}

function updateFormat() {
  const mime = [
    'video/mp4;codecs=avc1.64001F,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ].find(m => MediaRecorder.isTypeSupported(m));

  setText('mFormat', mime ? 'MP4 H.264' : 'WebM');
  setText('mRes', QUALITY_PRESETS[currentQuality].res);
}

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

function fmtSize(b) {
  b = b || 0;
  if (b < 1024)       return b + 'B';
  if (b < 1048576)    return (b / 1024).toFixed(1) + 'KB';
  if (b < 1073741824) return (b / 1048576).toFixed(2) + 'MB';
  return (b / 1073741824).toFixed(2) + 'GB';
}

function fmtTime(s) {
  s = s || 0;
  return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60]
    .map(n => String(n).padStart(2,'0')).join(':');
}

function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function showError(msg) {
  const el = $('errorBar');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

init();
