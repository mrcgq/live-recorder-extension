

'use strict';

// ============================================================
// popup.js v3.1 - 主动唤醒重构版
// ============================================================

const $ = (id) => document.getElementById(id);

const QUALITY = {
  uhd: { label:'超清', vbps:16_000_000, abps:256_000, fps:60 },
  hd : { label:'高清', vbps: 8_000_000, abps:192_000, fps:30 },
  sd : { label:'标清', vbps: 3_000_000, abps:128_000, fps:30 },
};

const PERSISTENT_KEYS = [
  'captureMode', 'resolutionSelect', 'fpsSelect', 'formatSelect',
  'sysAudio', 'micAudio', 'noAudio', 'audioChannels',
  'autoDownload', 'filePrefix', 'fileNaming', 'maxDuration',
  'segmentSize', 'showNotify', 'showFloat', 'floatPosition',
];

let UI = { quality: 'hd', isRecording: false, isPaused: false };
let bgPort     = null;
let _toastTimer = null;

async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([...PERSISTENT_KEYS, 'quality'], (stored) => {
      PERSISTENT_KEYS.forEach((key) => {
        const el = $(key);
        if (!el || stored[key] === undefined) return;
        if (el.type === 'checkbox') el.checked = stored[key];
        else el.value = stored[key];
      });
      if (stored.quality) {
        UI.quality = stored.quality;
        syncQualityBtn(stored.quality);
      }
      resolve();
    });
  });
}

function saveConfig() {
  const cfg = { quality: UI.quality };
  PERSISTENT_KEYS.forEach((key) => {
    const el = $(key);
    if (!el) return;
    cfg[key] = el.type === 'checkbox' ? el.checked : el.value;
  });
  chrome.storage.local.set(cfg);
}

function connectBg() {
  try {
    bgPort = chrome.runtime.connect({ name: 'popup' });
    bgPort.onMessage.addListener((msg) => {
      if (msg.action === 'stateSync')     applyState(msg.state);
      if (msg.action === 'metricsUpdate') applyMetrics(msg);
    });
    bgPort.onDisconnect.addListener(() => {
      bgPort = null;
      setTimeout(connectBg, 800);
    });
  } catch (e) {
    setTimeout(connectBg, 1000);
  }
}

function applyState(state) {
  if (!state) return;
  UI.isRecording = !!state.isRecording;
  UI.isPaused    = !!state.isPaused;
  if (state.quality) { UI.quality = state.quality; syncQualityBtn(state.quality); }
  updateBtnUI();
  setStatus(
    UI.isRecording ? (UI.isPaused ? 'paused' : 'recording') : 'ready',
    UI.isRecording ? (UI.isPaused ? '⏸ 已暂停' : '🔴 录制中') : '就绪'
  );
  if (state.timeString) {
    const el = $('mainTimer');
    if (el) { el.textContent = state.timeString; el.className = UI.isRecording ? 'record-time-display' : 'record-time-display idle'; }
  }
  if (state.sizeString) setText('monSize', state.sizeString);
  if (state.resolution && state.resolution !== '-') setText('monRes', state.resolution);
}

function applyMetrics(msg) {
  UI.isRecording = !!msg.isRecording;
  UI.isPaused    = !!msg.isPaused;
  if (msg.timeString) { const el = $('mainTimer'); if (el) el.textContent = msg.timeString; }
  if (msg.sizeString) { setText('monSize', msg.sizeString); setText('progressDetail', '已录制: ' + msg.sizeString); }
  if (msg.bitrate)    setText('monBitrate', msg.bitrate);
  if (msg.resolution) setText('monRes', msg.resolution);
  if (msg.fps)        setText('monFps', msg.fps);
  updateBtnUI();
}

function bindEvents() {
  $('tab-options').addEventListener('click',  () => switchTab('options'));
  $('tab-files').addEventListener('click',    () => switchTab('files'));
  $('tab-settings').addEventListener('click', () => switchTab('settings'));

  $('btnGoSettings').addEventListener('click', () => switchTab('settings'));
  $('btnGoFiles').addEventListener('click',    () => switchTab('files'));
  $('btnGoAbout').addEventListener('click',    showAbout);

  $('qUHD').addEventListener('click', () => setQuality('uhd'));
  $('qHD').addEventListener('click',  () => setQuality('hd'));
  $('qSD').addEventListener('click',  () => setQuality('sd'));

  $('mainRecBtn').addEventListener('click', toggleMainRecord);
  $('btnPause').addEventListener('click',   pauseResume);
  $('btnStop').addEventListener('click',    stopRecording);
  $('btnGoFiles').addEventListener('click', () => switchTab('files'));

  if ($('btnApplyFloat')) $('btnApplyFloat').addEventListener('click', applyFloat);
  $('btnClearAll').addEventListener('click',     () => toast('🗑️ 清空完成'));
  $('btnOpenDownloads').addEventListener('click', () => chrome.downloads.showDefaultFolder());

  $('regionBtn').addEventListener('click', toggleRegion);

  PERSISTENT_KEYS.forEach((key) => {
    const el = $(key);
    if (!el) return;
    el.addEventListener('change', () => {
      if (key === 'noAudio' && el.checked) {
        if ($('sysAudio')) { $('sysAudio').checked = false; }
        if ($('micAudio')) { $('micAudio').checked = false; }
      }
      if ((key === 'sysAudio' || key === 'micAudio') && el.checked) {
        if ($('noAudio')) { $('noAudio').checked = false; }
      }
      saveConfig();
    });
  });

  const fp = $('filePrefix');
  if (fp) fp.addEventListener('input', saveConfig);
}

function toggleMainRecord() {
  if (UI.isRecording) stopRecording(); else startRecording();
}

// 物理加固：一键主动唤醒录制。点击 Popup 主按钮时，首先尝试在原直播网页中自动检索 <video> 并强行开启直录，拒绝无谓等待 [纠正 3]
function startRecording() {
  const config = buildConfig();

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    const tabId = tabs[0].id;

    // 先行握手，对直播网页进行主动嗅探抓取
    chrome.tabs.sendMessage(tabId, { action: 'start_recording_now', config }, (response) => {
      const err = chrome.runtime.lastError;

      if (err || !response || !response.ok) {
        // 网页无播放器或未就绪：降级唤醒控制窗口（让用户选择 TabCapture）
        if (bgPort) {
          bgPort.postMessage({ action: 'startRecording', config });
        } else {
          chrome.runtime.sendMessage({ action: 'startRecording', config }, () => {
            void chrome.runtime.lastError;
          });
        }
        toast('🎬 已打开录制控制窗口');
      } else {
        toast('⏺ 极客引擎已成功强行开始直录！');
      }
    });
  });
}

function stopRecording() {
  if (bgPort) {
    bgPort.postMessage({ action: 'stopRecording' });
  } else {
    chrome.runtime.sendMessage({ action: 'stopRecording' }, () => { void chrome.runtime.lastError; });
  }
  UI.isRecording = false; UI.isPaused = false;
  updateBtnUI();
  setStatus('ready', '✅ 正在保存...');
  toast('⏹ 正在停止录制并保存...');
}

function pauseResume() {
  if (!UI.isRecording) return;
  if (UI.isPaused) {
    if (bgPort) bgPort.postMessage({ action: 'resumeRecording' });
    else chrome.runtime.sendMessage({ action: 'resumeRecording' }, () => { void chrome.runtime.lastError; });
    UI.isPaused = false;
    setText('btnPause', '⏸ 暂停');
    setStatus('recording', '🔴 录制中');
    toast('▶️ 继续录制');
  } else {
    if (bgPort) bgPort.postMessage({ action: 'pauseRecording' });
    else chrome.runtime.sendMessage({ action: 'pauseRecording' }, () => { void chrome.runtime.lastError; });
    UI.isPaused = true;
    setText('btnPause', '▶️ 继续');
    setStatus('paused', '⏸ 已暂停');
    toast('⏸ 录制已暂停');
  }
  updateBtnUI();
}

function buildConfig() {
  const q = QUALITY[UI.quality] || QUALITY['hd'];
  return {
    sysAudio  : $('sysAudio') ? $('sysAudio').checked : true,
    micAudio  : $('micAudio') ? $('micAudio').checked : false,
    noAudio   : $('noAudio')  ? $('noAudio').checked  : false,
    format    : $('formatSelect') ? $('formatSelect').value : 'mp4',
    vbps      : q.vbps,
    abps      : q.abps,
    fps       : parseInt(($('fpsSelect') ? $('fpsSelect').value : '30')) || q.fps,
    filePrefix: ($('filePrefix') ? $('filePrefix').value.trim() : '') || '直播录制',
    quality   : UI.quality,
    maxDuration: parseInt(($('maxDuration') ? $('maxDuration').value : '0')) || 0,
    showNotify: $('showNotify') ? $('showNotify').checked : true,
  };
}

function setQuality(q) {
  UI.quality = q;
  syncQualityBtn(q);
  saveConfig();
  toast('✅ 已切换到 ' + QUALITY[q].label + ' 模式');
}

function syncQualityBtn(q) {
  ['uhd','hd','sd'].forEach((k) => {
    const el = $('q' + k.toUpperCase());
    if (el) el.classList.toggle('active', k === q);
  });
}

function updateBtnUI() {
  const btn = $('mainRecBtn');
  if (!btn) return;
  btn.className = UI.isRecording
    ? (UI.isPaused ? 'record-big-btn paused' : 'record-big-btn recording')
    : 'record-big-btn';
  const pb = $('btnPause');
  const sb = $('btnStop');
  if (pb) pb.disabled = !UI.isRecording;
  if (sb) sb.disabled = !UI.isRecording;
}

function setStatus(type, text) {
  const dot = $('statusDot');
  const txt = $('statusText');
  if (dot) dot.className = 'status-dot ' + type;
  if (txt) txt.textContent = text;
}

function toggleRegion() {
  const btn = $('regionBtn');
  if (!btn) return;
  const active = btn.classList.toggle('active');
  btn.textContent = active ? '✅ 区域模式启用中' : '🔲 区域录制模式';
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.tabs.sendMessage(
      tabs[0].id,
      { action: active ? 'enableRegionSelect' : 'disableRegionSelect' },
      () => { void chrome.runtime.lastError; }
    );
  });
  toast(active ? '🔲 请在页面拖拽选择区域' : '🔲 区域模式已关闭');
}

function applyFloat() {
  const pos = $('floatPosition') ? $('floatPosition').value : 'top-right';
  chrome.runtime.sendMessage({ action: 'showFloat', position: pos }, () => {
    void chrome.runtime.lastError;
  });
  toast('🪟 悬浮控制条已显示');
}

function showAbout() {
  toast('直播内录器 Pro v3.0 · video.captureStream 精准捕获 · 零元素混入');
}

function toast(msg, ms) {
  ms = ms || 2800;
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const t = $('tab-' + name);
  const p = $('panel-' + name);
  if (t) t.classList.add('active');
  if (p) p.classList.add('active');
}

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await loadConfig();
  connectBg();
});


