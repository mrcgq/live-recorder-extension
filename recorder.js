'use strict';

// ============================================================
// recorder.js v3.0 - 纯控制面板
//
// 核心变更：
//   录制数据面完全移至 content.js（video.captureStream）
//   本文件只负责：
//   1. 显示实时录制状态和指标
//   2. 发送控制指令给 content.js
//   3. 质量预设切换
// ============================================================

const QUALITY_PRESETS = {
  uhd: { label:'超清 4K',  vbps:16_000_000, abps:256_000, fps:60, res:'3840×2160' },
  hd : { label:'高清 1080P', vbps:8_000_000,  abps:192_000, fps:30, res:'1920×1080' },
  sd : { label:'标清 720P',  vbps:3_000_000,  abps:128_000, fps:30, res:'1280×720'  },
};

let currentQuality = 'hd';
let isRecording    = false;
let isPaused       = false;
let activeTabId    = null;

const $ = (id) => document.getElementById(id);

// ============================================================
// 初始化
// ============================================================
function init() {
  // 解析 URL 参数
  const params = new URLSearchParams(window.location.search);
  activeTabId  = parseInt(params.get('tabId')) || null;

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
  // 质量按钮
  $('qUHD').addEventListener('click', () => setQuality('uhd'));
  $('qHD').addEventListener('click',  () => setQuality('hd'));
  $('qSD').addEventListener('click',  () => setQuality('sd'));

  // 主录制按钮（停止用）
  $('bigRecBtn').addEventListener('click', () => {
    if (isRecording) sendToContent('stopRecording');
  });

  // 暂停/停止
  $('btnPause').addEventListener('click', () => {
    if (!isRecording) return;
    if (isPaused) sendToContent('resumeRecording');
    else          sendToContent('pauseRecording');
  });

  $('btnStop').addEventListener('click', () => {
    if (isRecording) sendToContent('stopRecording');
  });
}

// ============================================================
// 向 content 脚本发送控制指令
// ============================================================
function sendToContent(action, extra) {
  if (!activeTabId) {
    showError('❌ 未连接到目标页面，请重新打开');
    return;
  }
  chrome.tabs.sendMessage(
    activeTabId,
    Object.assign({ action }, extra || {}),
    (resp) => { void chrome.runtime.lastError; }
  );
}

// ============================================================
// 接收来自 background 的状态同步
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg._target === 'recorder') {
    // 来自 popup 的指令，转发给 content
    switch (msg.action) {
      case 'stopRecording':
        sendToContent('stopRecording');
        break;
      case 'pauseRecording':
        sendToContent('pauseRecording');
        break;
      case 'resumeRecording':
        sendToContent('resumeRecording');
        break;
    }
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
    applyMetrics(msg);
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false });
});

// 长连接同步
const bgPort = chrome.runtime.connect({ name: 'recorder_panel' });
bgPort.onMessage.addListener((msg) => {
  if (msg.action === 'stateSync') applyState(msg.state);
  if (msg.action === 'metricsUpdate') applyMetrics(msg);
});

function applyState(state) {
  if (!state) return;
  isRecording = !!state.isRecording;
  isPaused    = !!state.isPaused;

  updateUI();

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
    txt.textContent  = '🔴 正在录制直播视频...';
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

// ── 质量管理 ─────────────────────────────────────────────────
function setQuality(q) {
  if (!QUALITY_PRESETS[q]) return;
  currentQuality = q;
  setQualityHighlight(q);
  updateFormat();

  if (isRecording) {
    // 通知 content 更新质量（下次分片时生效）
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

// ── 工具 ─────────────────────────────────────────────────────
function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function showError(msg) {
  const el = $('errorBar');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

// 启动
init();
