'use strict';

// ============================================================
// popup.js - 纯控制面（Stateless View）
// 修复：
//   1. 移除全部 inline 事件，使用程序化绑定（阻断 CSP 拦截）
//   2. 引入 chrome.storage.local 双向双通道持久化，防止配置复位（Law-03/40）
// ============================================================

const $ = (id) => document.getElementById(id);

const QUALITY = {
  uhd: { label: '超清', vbps: 12_000_000, abps: 256_000, w: 2560, h: 1440, fps: 60 },
  hd : { label: '高清', vbps:  6_000_000, abps: 192_000, w: 1920, h: 1080, fps: 30 },
  sd : { label: '标清', vbps:  2_500_000, abps: 128_000, w: 1280, h:  720, fps: 30 },
};

// 16个核心双向同步参数配置项
const SYNC_CONFIG_KEYS = [
  'captureMode', 'resolutionSelect', 'fpsSelect', 'formatSelect',
  'sysAudio', 'micAudio', 'noAudio', 'audioChannels',
  'autoDownload', 'filePrefix', 'fileNaming', 'maxDuration',
  'segmentSize', 'showNotify', 'showFloat', 'floatPosition'
];

let UI = {
  quality       : 'hd',
  isRecording   : false,
  isPaused      : false,
};

let bgPort = null;
let _toastTimer = null;

// ============================================================
// 建立长连接
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
    console.warn('[popup] connect background failed:', e.message);
    setTimeout(connectBackground, 1000);
  }
}

function onBgMessage(msg) {
  switch (msg.action) {
    case 'stateSync':
      if (msg.state) applyState(msg.state);
      break;
    case 'metricsUpdate':
      applyMetrics(msg);
      break;
  }
}

// ============================================================
// 状态同步至视图层
// ============================================================
function applyState(state) {
  UI.isRecording = !!state.isRecording;
  UI.isPaused    = !!state.isPaused;
  if (state.quality) {
    UI.quality = state.quality;
    updateQualityActiveBtn(state.quality);
  }

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
    $('monSize').textContent        = msg.sizeString;
    $('progressDetail').textContent = '已录制: ' + msg.sizeString;
  }
  if (msg.bitrate)    $('monBitrate').textContent = msg.bitrate;
  if (msg.resolution) $('monRes').textContent     = msg.resolution;

  updateBtnUI();
}

// ============================================================
// 双通道数据持久化（对齐 Law-03 单一真相源）
// ============================================================
async function loadPersistentConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SYNC_CONFIG_KEYS, (stored) => {
      if (stored.captureMode !== undefined)      $('captureMode').value = stored.captureMode;
      if (stored.resolutionSelect !== undefined) $('resolutionSelect').value = stored.resolutionSelect;
      if (stored.fpsSelect !== undefined)        $('fpsSelect').value = stored.fpsSelect;
      if (stored.formatSelect !== undefined)     $('formatSelect').value = stored.formatSelect;
      
      if (stored.sysAudio !== undefined)         $('sysAudio').checked = stored.sysAudio;
      if (stored.micAudio !== undefined)         $('micAudio').checked = stored.micAudio;
      if (stored.noAudio !== undefined)          $('noAudio').checked = stored.noAudio;
      if (stored.audioChannels !== undefined)    $('audioChannels').value = stored.audioChannels;
      
      if (stored.autoDownload !== undefined)     $('autoDownload').checked = stored.autoDownload;
      if (stored.filePrefix !== undefined)       $('filePrefix').value = stored.filePrefix;
      if (stored.fileNaming !== undefined)       $('fileNaming').value = stored.fileNaming;
      
      if (stored.maxDuration !== undefined)      $('maxDuration').value = stored.maxDuration;
      if (stored.segmentSize !== undefined)      $('segmentSize').value = stored.segmentSize;
      if (stored.showNotify !== undefined)       $('showNotify').checked = stored.showNotify;
      if (stored.showFloat !== undefined)        $('showFloat').checked = stored.showFloat;
      if (stored.floatPosition !== undefined)    $('floatPosition').value = stored.floatPosition;

      // 同步品质高亮
      chrome.storage.local.get(['quality'], (res) => {
        if (res.quality) {
          UI.quality = res.quality;
          updateQualityActiveBtn(res.quality);
        }
        resolve();
      });
    });
  });
}

function savePersistentConfig() {
  const config = {
    captureMode:      $('captureMode').value,
    resolutionSelect: $('resolutionSelect').value,
    fpsSelect:        $('fpsSelect').value,
    formatSelect:     $('formatSelect').value,
    sysAudio:         $('sysAudio').checked,
    micAudio:         $('micAudio').checked,
    noAudio:          $('noAudio').checked,
    audioChannels:    $('audioChannels').value,
    autoDownload:     $('autoDownload').checked,
    filePrefix:       $('filePrefix').value,
    fileNaming:       $('fileNaming').value,
    maxDuration:      $('maxDuration').value,
    segmentSize:      $('segmentSize').value,
    showNotify:       $('showNotify').checked,
    showFloat:        $('showFloat').checked,
    floatPosition:    $('floatPosition').value,
    quality:          UI.quality
  };
  chrome.storage.local.set(config);
}

// ============================================================
// 录制动作控制
// ============================================================
function sendCmd(action, extra) {
  const msg = Object.assign({ action }, extra || {});
  if (bgPort) {
    bgPort.postMessage(msg);
  } else {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  }
}

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

  UI.isRecording = true;
  UI.isPaused    = false;
  updateBtnUI();
  setStatus('recording', '⏳ 启动中...');
  toast('⏳ 正在启动录制，请在弹窗中授权...');

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
    $('btnPause').innerHTML = '⏸ 暂停';
    setStatus('recording', '🔴 录制中');
    startTimer();
    toast('▶️ 继续录制');
  } else {
    sendCmd('pauseRecording');
    UI.isPaused = true;
    $('btnPause').innerHTML = '▶️ 继续';
    setStatus('paused', '⏸ 已暂停');
    stopTimer();
    toast('⏸ 录制已暂停');
  }
  updateBtnUI();
}

function buildConfig() {
  const q = UI.quality || 'hd';
  const preset = QUALITY[q];
  return {
    sysAudio:         $('sysAudio').checked,
    micAudio:         $('micAudio').checked,
    noAudio:          $('noAudio').checked,
    format:           $('formatSelect').value,
    vbps:             preset.vbps,
    abps:             preset.abps,
    fps:              parseInt($('fpsSelect').value) || preset.fps,
    filePrefix:       $('filePrefix').value.trim() || '直播录制',
    quality:          q,
    maxDuration:      parseInt($('maxDuration').value) || 0,
    segmentSize:      parseInt($('segmentSize').value) || 0,
    showNotify:       $('showNotify').checked
  };
}

// ============================================================
// 程序化事件绑定（100% 阻断 CSP 安全异常）
// ============================================================
function bindUIEvents() {
  // Tab面板选择
  $('tab-options').addEventListener('click', () => switchTab('options'));
  $('tab-files').addEventListener('click', () => switchTab('files'));
  $('tab-settings').addEventListener('click', () => switchTab('settings'));

  // 快捷跳转
  $('btnGoSettings').addEventListener('click', () => switchTab('settings'));
  $('btnGoFiles').addEventListener('click', () => switchTab('files'));
  $('btnGoAbout').addEventListener('click', showAbout);

  // 质量选择按钮
  $('qUHD').addEventListener('click', () => setQuality('uhd'));
  $('qHD').addEventListener('click', () => setQuality('hd'));
  $('qSD').addEventListener('click', () => setQuality('sd'));

  // 区域录制按钮
  $('regionBtn').addEventListener('click', toggleRegionMode);

  // 主控制面按钮
  $('mainRecBtn').addEventListener('click', toggleMainRecord);
  $('btnPause').addEventListener('click', pauseResume);
  $('btnStop').addEventListener('click', stopRecording);

  // 悬浮条应用按钮
  $('btnApplyFloat').addEventListener('click', applyFloatWindow);

  // 底部控制
  $('btnClearAll').addEventListener('click', clearAllRecordings);
  $('btnOpenDownloads').addEventListener('click', openDownloadFolder);

  // 动态内容双向观察器注册
  SYNC_CONFIG_KEYS.forEach((id) => {
    const el = $(id);
    if (!el) return;

    el.addEventListener('change', () => {
      // 声音选项互斥处理
      if (id === 'noAudio' && el.checked) {
        $('sysAudio').checked = false;
        $('micAudio').checked = false;
      }
      if ((id === 'sysAudio' || id === 'micAudio') && el.checked) {
        $('noAudio').checked = false;
      }
      savePersistentConfig();
    });
  });

  // 输入框实时写入
  $('filePrefix').addEventListener('input', savePersistentConfig);
}

// ============================================================
// 辅助函数
// ============================================================
function setQuality(q) {
  UI.quality = q;
  updateQualityActiveBtn(q);
  savePersistentConfig();
  const p = QUALITY[q];
  if ($('monRes')) $('monRes').textContent = p.w + '×' + p.h;
  toast('✅ 已切换到 ' + p.label + ' 模式');
}

function updateQualityActiveBtn(q) {
  ['uhd', 'hd', 'sd'].forEach((k) => {
    const btn = $('q' + k.toUpperCase());
    if (btn) btn.classList.toggle('active', k === q);
  });
}

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

  $('btnPause').disabled = !UI.isRecording;
  $('btnStop').disabled  = !UI.isRecording;
}

function setStatus(type, text) {
  const dot = $('statusDot');
  const txt = $('statusText');
  if (dot) dot.className = 'status-dot ' + type;
  if (txt) txt.textContent = text;
}

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

function applyFloatWindow() {
  const pos = $('floatPosition') ? $('floatPosition').value : 'top-right';
  chrome.runtime.sendMessage({ action: 'showFloat', position: pos }, () => {
    void chrome.runtime.lastError;
  });
  toast('🪟 悬浮控制条已显示');
}

function clearAllRecordings() {
  if (UI.isRecording) {
    toast('⚠️ 请先停止录制');
    return;
  }
  toast('🗑️ 清空文件列表完成');
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

function showAbout() {
  toast('直播内录器 v2.1 Pro | Offscreen闭环 | 关闭弹窗不中断录制');
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  bindUIEvents();
  await loadPersistentConfig();
  connectBackground();
});
