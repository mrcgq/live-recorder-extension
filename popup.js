'use strict';

// ============================================================
// popup.js - 纯控制面（Stateless View）
// popup 关闭/重开不影响录制，数据全在 offscreen
// ============================================================

const $ = (id) => document.getElementById(id);

const QUALITY = {
  uhd: { label: '超清', vbps: 12_000_000, abps: 256_000, w: 2560, h: 1440, fps: 60 },
  hd : { label: '高清', vbps:  6_000_000, abps: 192_000, w: 1920, h: 1080, fps: 30 },
  sd : { label: '标清', vbps:  2_500_000, abps: 128_000, w: 1280, h:  720, fps: 30 },
};

// popup 本地 UI 状态（不含录制数据）
const UI = {
  quality       : 'hd',
  isRecording   : false,
  isPaused      : false,
};

let bgPort = null;
let _toastTimer = null;

// ============================================================
// background 长连接
// ============================================================
function connectBackground() {
  try {
    bgPort = chrome.runtime.connect({ name: 'popup' });

    bgPort.onMessage.addListener(onBgMessage);

    bgPort.onDisconnect.addListener(() => {
      bgPort = null;
      setTimeout(connectBackground, 800);
    });
  } catch (e) {
    console.warn('[popup] connect failed:', e.message);
    setTimeout(connectBackground, 1000);
  }
}

function onBgMessage(msg) {
  switch (msg.action) {

    // 重新打开 popup 时同步最新状态
    case 'stateSync':
      if (msg.state) applyState(msg.state);
      break;

    // 实时指标更新
    case 'metricsUpdate':
      applyMetrics(msg);
      break;

    default:
      break;
  }
}

// ============================================================
// 状态同步到 UI
// ============================================================
function applyState(state) {
  UI.isRecording = !!state.isRecording;
  UI.isPaused    = !!state.isPaused;
  if (state.quality) UI.quality = state.quality;

  updateBtnUI();
  setStatus(
    UI.isRecording ? (UI.isPaused ? 'paused' : 'recording') : 'ready',
    UI.isRecording ? (UI.isPaused ? '⏸ 已暂停' : '🔴 录制中') : '就绪'
  );

  if (state.resolution && state.resolution !== '-') {
    $('monRes').textContent = state.resolution;
  }
  if (state.timeString) {
    const el = $('mainTimer');
    el.textContent = state.timeString;
    el.className   = UI.isRecording ? 'record-time-display' : 'record-time-display idle';
  }
  if (state.sizeString) {
    $('monSize').textContent = state.sizeString;
  }

  // 录制中显示进度条
  const rp = $('recProgress');
  if (rp) rp.classList.toggle('show', UI.isRecording);
}

function applyMetrics(msg) {
  UI.isRecording = !!msg.isRecording;
  UI.isPaused    = !!msg.isPaused;

  if (msg.timeString) {
    const el = $('mainTimer');
    el.textContent = msg.timeString;
    el.className   = 'record-time-display';
  }
  if (msg.sizeString) {
    $('monSize').textContent         = msg.sizeString;
    $('progressDetail').textContent  = '已录制: ' + msg.sizeString;
  }
  if (msg.bitrate)    $('monBitrate').textContent = msg.bitrate;
  if (msg.resolution) $('monRes').textContent     = msg.resolution;

  updateBtnUI();
}

// ============================================================
// 向 background 发指令（background 路由至 offscreen）
// ============================================================
function sendCmd(action, extra) {
  const msg = Object.assign({ action }, extra || {});

  // 优先走长连接 port（有 popup 打开时）
  if (bgPort) {
    bgPort.postMessage(msg);
  } else {
    // 降级：短消息
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  }
}

// ============================================================
// 录制控制
// ============================================================
function toggleMainRecord() {
  if (UI.isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startRecording() {
  const config = buildConfig();
  sendCmd('startRecording', { config });

  // 乐观更新 UI（等 background 回传真实状态）
  UI.isRecording = true;
  UI.isPaused    = false;
  updateBtnUI();
  setStatus('recording', '⏳ 启动中...');
  toast('⏳ 正在启动录制，请在弹窗中授权...');

  // 显示悬浮窗
  if ($('showFloat') && $('showFloat').checked) {
    applyFloatWindow();
  }
}

function stopRecording() {
  sendCmd('stopRecording');
  UI.isRecording = false;
  UI.isPaused    = false;
  updateBtnUI();
  setStatus('ready', '✅ 正在保存...');
  toast('⏹ 正在停止并保存...');

  const rp = $('recProgress');
  if (rp) rp.classList.remove('show');

  const el = $('mainTimer');
  if (el) el.className = 'record-time-display idle';
}

function pauseResume() {
  if (!UI.isRecording) return;

  if (UI.isPaused) {
    sendCmd('resumeRecording');
    UI.isPaused = false;
    $('btnPause').textContent = '⏸ 暂停';
    setStatus('recording', '🔴 录制中');
    toast('▶️ 继续录制');
  } else {
    sendCmd('pauseRecording');
    UI.isPaused = true;
    $('btnPause').textContent = '▶️ 继续';
    setStatus('paused', '⏸ 已暂停');
    toast('⏸ 录制已暂停');
  }

  updateBtnUI();
}

// ============================================================
// 构建录制配置
// ============================================================
function buildConfig() {
  const preset  = QUALITY[UI.quality];
  const noAudio = $('noAudio')  && $('noAudio').checked;

  return {
    sysAudio  : !noAudio && $('sysAudio') && $('sysAudio').checked,
    micAudio  : !noAudio && $('micAudio') && $('micAudio').checked,
    noAudio,
    format    : $('formatSelect') ? $('formatSelect').value : 'webm',
    vbps      : preset.vbps,
    abps      : preset.abps,
    fps       : $('fpsSelect') ? parseInt($('fpsSelect').value) || preset.fps : preset.fps,
    quality   : UI.quality,
    filePrefix: $('filePrefix') && $('filePrefix').value.trim()
                  ? $('filePrefix').value.trim()
                  : '直播录制',
  };
}

// ============================================================
// 质量选择
// ============================================================
function setQuality(q) {
  UI.quality = q;
  ['uhd', 'hd', 'sd'].forEach((k) => {
    const btn = $('q' + k.toUpperCase());
    if (btn) btn.classList.toggle('active', k === q);
  });
  const p = QUALITY[q];
  if ($('monRes')) $('monRes').textContent = p.w + '×' + p.h;
  toast('✅ ' + p.label + ' (' + p.vbps / 1_000_000 + 'Mbps)');
}

// ============================================================
// 区域录制
// ============================================================
function toggleRegionMode() {
  const btn = $('regionBtn');
  const active = btn.classList.toggle('active');
  btn.textContent = active ? '✅ 区域模式已启用' : '🔲 区域录制模式';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.tabs.sendMessage(
      tabs[0].id,
      { action: active ? 'enableRegionSelect' : 'disableRegionSelect' },
      () => void chrome.runtime.lastError
    );
  });

  toast(active ? '🔲 请在页面上拖拽选择区域' : '🔲 区域模式已关闭');
}

// ============================================================
// 悬浮窗
// ============================================================
function applyFloatWindow() {
  const pos = $('floatPosition') ? $('floatPosition').value : 'top-right';
  chrome.runtime.sendMessage({ action: 'showFloat', position: pos }, () => {
    void chrome.runtime.lastError;
  });
  toast('🪟 悬浮控制条已显示');
}

// ============================================================
// UI 辅助
// ============================================================
function updateBtnUI() {
  const btn = $('mainRecBtn');
  if (!btn) return;

  if (UI.isRecording && !UI.isPaused) {
    btn.className = 'record-big-btn recording';
  } else if (UI.isPaused) {
    btn.className = 'record-big-btn paused';
  } else {
    btn.className = 'record-big-btn';
  }

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
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  const t = $('tab-' + name);
  const p = $('panel-' + name);
  if (t) t.classList.add('active');
  if (p) p.classList.add('active');
}

function openDownloadFolder() {
  chrome.downloads.showDefaultFolder();
}

function showAbout() {
  toast('直播内录器 v2.1 Pro | Offscreen闭环 | 关闭弹窗不中断录制');
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  connectBackground();
  setQuality('hd');
  setStatus('ready', '就绪');

  // 音频互斥
  const noAudio  = $('noAudio');
  const sysAudio = $('sysAudio');
  const micAudio = $('micAudio');

  if (noAudio) {
    noAudio.addEventListener('change', function () {
      if (this.checked) {
        if (sysAudio) sysAudio.checked = false;
        if (micAudio) micAudio.checked = false;
      }
    });
  }
  if (sysAudio) {
    sysAudio.addEventListener('change', function () {
      if (this.checked && noAudio) noAudio.checked = false;
    });
  }
  if (micAudio) {
    micAudio.addEventListener('change', function () {
      if (this.checked && noAudio) noAudio.checked = false;
    });
  }
});
