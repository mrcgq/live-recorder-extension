'use strict';

// ============================================================
// recorder.js v3.1 - 保活及控制中心
//
// 核心变更：
//   1. 接收 `background.js` 传入的 `streamId` 并通过 getUserMedia 
//      对目标标签页进行后台保活抓取，促使 Chromium 在切标签页/最小化时 
//      强制渲染视频播放器，100% 根治后台花屏、画面冻结等问题！
//   2. 完美内置音频直通环路：修复了 tabCapture 导致原网页静音的副作用。
//   3. 双引擎容灾：当 content.js 录制报错时，本窗口自动接管录制，
//      无缝以 tabCapture 画面为备用引擎完成安全内录与下载。
// ============================================================

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

// 备用录制相关
let fallbackRecorder = null;
let fallbackChunks   = [];
let fallbackSeconds  = 0;
let fallbackTimer    = null;

const $ = (id) => document.getElementById(id);

// ============================================================
// 初始化
// ============================================================
function init() {
  const params   = new URLSearchParams(window.location.search);
  activeTabId    = parseInt(params.get('tabId')) || null;
  presetStreamId = params.get('streamId') || null;

  try {
    const config = JSON.parse(decodeURIComponent(params.get('config') || '{}'));
    if (config.quality && QUALITY_PRESETS[config.quality]) {
      currentQuality = config.quality;
    }
  } catch (_) {}

  setQualityHighlight(currentQuality);
  updateFormat();
  bindEvents();
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
// ★ tabCapture 独占静默保活 (Bypass Rendering Throttling)
// ============================================================
async function activateKeepAlive(streamId) {
  if (keepAliveStream) return;
  console.log('[recorder] 启动静默保活，streamId:', streamId);
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

    // 音频旁路直通：解决 tabCapture 静音网页播放器的缺陷，在控制面板还原扬声器输出
    if (stream.getAudioTracks().length > 0) {
      try {
        const sysCtx = new AudioContext({ sampleRate: 48000 });
        if (sysCtx.state === 'suspended') await sysCtx.resume();
        const source = sysCtx.createMediaStreamSource(stream);
        source.connect(sysCtx.destination);
        audioContext = sysCtx;
      } catch (ae) {
        console.warn('[recorder] 音频直通失败:', ae.message);
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

    console.log('[recorder] ★ 静默保活已激活，后台渲染被锁定，永不花屏断影！');
  } catch (e) {
    console.warn('[recorder] 静默保活激活失败:', e.message);
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
  console.log('[recorder] ★ 保活流已关闭。');
}

// ============================================================
// ★ 容灾降级机制：备用 tabCapture 录制管线
// ============================================================
function startFallbackRecording(config) {
  if (!keepAliveStream) {
    showError('❌ 备用内录引擎启动失败：独占保活流未准备就绪');
    return;
  }

  fallbackChunks = [];
  fallbackSeconds = 0;

  try {
    const mime = pickMime(config.format);
    fallbackRecorder = new MediaRecorder(keepAliveStream, {
      mimeType: mime,
      videoBitsPerSecond: config.vbps || 8_000_000,
      audioBitsPerSecond: config.abps || 192_000,
    });

    fallbackRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        fallbackChunks.push(e.data);
      }
    };

    fallbackRecorder.onstop = () => {
      saveFallbackVideo(config);
    };

    fallbackRecorder.start(1000);
    isRecording = true;
    isPaused    = false;
    updateUI();

    startFallbackTimer();
    console.log('[recorder] ★ 备用 tabCapture 内录引擎已运行');
  } catch (e) {
    showError('❌ 备用引擎启动失败: ' + e.message);
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

function saveFallbackVideo(config) {
  if (!fallbackChunks.length) return;
  const mime = (fallbackRecorder && fallbackRecorder.mimeType) || 'video/webm';
  const blob = new Blob(fallbackChunks, { type: mime });
  const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
  const prefix = (config.filePrefix || '直播录制') + '_备用';
  const ts   = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
  const filename = prefix + '_' + ts + '.' + ext;
  const url  = URL.createObjectURL(blob);

  chrome.runtime.sendMessage({ action: 'triggerDownload', url, filename }, (resp) => {
    if (resp && resp.error) console.error('备用下载失败:', resp.error);
  });

  chrome.runtime.sendMessage({
    action: 'notify',
    message: '✅ 录制完成（备用引擎）！' + fmtSize(blob.size)
  });

  fallbackChunks = [];
  fallbackRecorder = null;
  releaseKeepAlive();
}

function startFallbackTimer() {
  stopFallbackTimer();
  fallbackTimer = setInterval(() => {
    if (isPaused) return;
    fallbackSeconds++;
    const totalBytes = fallbackChunks.reduce((acc, c) => acc + c.size, 0);

    applyMetrics({
      isRecording: true,
      isPaused: isPaused,
      timeString: fmtTime(fallbackSeconds),
      sizeString: fmtSize(totalBytes),
      bitrate: '8Mbps',
      resolution: QUALITY_PRESETS[currentQuality].res,
      fps: 30
    });
  }, 1000);
}

function stopFallbackTimer() {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}

// ============================================================
// 消息交互
// ============================================================
function sendToContent(action, extra) {
  if (!activeTabId) {
    showError('❌ 未连接到目标页面，请重新打开');
    return;
  }
  chrome.tabs.sendMessage(
    activeTabId,
    Object.assign({ action }, extra || {}),
    () => { void chrome.runtime.lastError; }
  );
}

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
    }
    sendResponse({ ok: true });
    return;
  }

  // 接收来自 background 的 CORS 备用触发
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

// 长连接同步
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

  // 录制开启 → 启动独占保活 (Bypass Throttling)
  if (isRecording && !wasRecording && !keepAliveStream && presetStreamId) {
    activateKeepAlive(presetStreamId);
  }

  // 录制结束 → 解锁释放保活流
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
  if (msg.sizeString) setText('mSize', msg.sizeString);
  if (msg.bitrate)    setText('mBitrate', msg.bitrate);
  if (msg.resolution) setText('mRes', msg.resolution);
  if (msg.fps)        setText('mFps', String(msg.fps));
  if (msg.sizeString) setText('footerInfo', '已录制 ' + msg.sizeString);
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

// ── 质量与格式管理 ───────────────────────────────────────────
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
