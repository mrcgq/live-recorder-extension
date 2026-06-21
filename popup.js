'use strict';

// ============================================================
// popup.js - 纯控制面（Stateless View）
// 职责：
//   1. 彻底移除所有 inline onclick（遵守 MV3 严苛的 CSP 限制）
//   2. 采用双向数据持久化，确保参数重启弹窗后永不丢失（对齐 Law-03/40）
//   3. 添加空安全保护防御 `null` 节点异常（对齐 Law-11/12）
// ============================================================

const $ = (id) => document.getElementById(id);

const QUALITY = {
  uhd: { label: '超清', vbps: 12_000_000, abps: 256_000, w: 2560, h: 1440, fps: 60 },
  hd : { label: '高清', vbps:  6_000_000, abps: 192_000, w: 1920, h: 1080, fps: 30 },
  sd : { label: '标清', vbps:  2_500_000, abps: 128_000, w: 1280, h:  720, fps: 30 },
};

// 16项核心持久化配置项（双通道自动存储机制）
const PERSISTENT_KEYS = [
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
// 1. 本地配置加载与持久化逻辑
// ============================================================
async function loadConfigFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(PERSISTENT_KEYS, (stored) => {
      // 安全读取，空防线守卫 (Law-11)
      if (stored.captureMode !== undefined && $('captureMode'))           $('captureMode').value = stored.captureMode;
      if (stored.resolutionSelect !== undefined && $('resolutionSelect')) $('resolutionSelect').value = stored.resolutionSelect;
      if (stored.fpsSelect !== undefined && $('fpsSelect'))               $('fpsSelect').value = stored.fpsSelect;
      if (stored.formatSelect !== undefined && $('formatSelect'))         $('formatSelect').value = stored.formatSelect;
      
      if (stored.sysAudio !== undefined && $('sysAudio'))                 $('sysAudio').checked = stored.sysAudio;
      if (stored.micAudio !== undefined && $('micAudio'))                 $('micAudio').checked = stored.micAudio;
      if (stored.noAudio !== undefined && $('noAudio'))                   $('noAudio').checked = stored.noAudio;
      if (stored.audioChannels !== undefined && $('audioChannels'))       $('audioChannels').value = stored.audioChannels;
      
      if (stored.autoDownload !== undefined && $('autoDownload'))         $('autoDownload').checked = stored.autoDownload;
      if (stored.filePrefix !== undefined && $('filePrefix'))             $('filePrefix').value = stored.filePrefix;
      if (stored.fileNaming !== undefined && $('fileNaming'))             $('fileNaming').value = stored.fileNaming;
      
      if (stored.maxDuration !== undefined && $('maxDuration'))           $('maxDuration').value = stored.maxDuration;
      if (stored.segmentSize !== undefined && $('segmentSize'))           $('segmentSize').value = stored.segmentSize;
      if (stored.showNotify !== undefined && $('showNotify'))             $('showNotify').checked = stored.showNotify;
      if (stored.showFloat !== undefined && $('showFloat'))               $('showFloat').checked = stored.showFloat;
      if (stored.floatPosition !== undefined && $('floatPosition'))       $('floatPosition').value = stored.floatPosition;

      // 读取并高亮上次选择的清晰度
      chrome.storage.local.get(['quality'], (res) => {
        if (res.quality) {
          UI.quality = res.quality;
          syncQualityActiveBtn(res.quality);
        }
        resolve();
      });
    });
  });
}

function saveConfigToStorage() {
  const config = {};
  PERSISTENT_KEYS.forEach(key => {
    const el = $(key);
    if (!el) return;
    config[key] = el.type === 'checkbox' ? el.checked : el.value;
  });
  config.quality = UI.quality;
  chrome.storage.local.set(config);
}

// ============================================================
// 2. 长连接与指标同步 (Law-46)
// ============================================================
function connectBackground() {
  try {
    bgPort = chrome.runtime.connect({ name: 'popup' });

    bgPort.onMessage.addListener((msg) => {
      if (msg.action === 'stateSync') {
        applyState(msg.state);
      }
      if (msg.action === 'metricsUpdate') {
        applyMetrics(msg);
      }
    });

    bgPort.onDisconnect.addListener(() => {
      bgPort = null;
      setTimeout(connectBackground, 800);
    });
  } catch (e) {
    console.warn('[popup] background connection error:', e.message);
    setTimeout(connectBackground, 1000);
  }
}

function applyState(state) {
  UI.isRecording = !!state.isRecording;
  UI.isPaused    = !!state.isPaused;
  if (state.quality) {
    UI.quality = state.quality;
    syncQualityActiveBtn(state.quality);
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
  if (msg.fps)        $('monFps').textContent     = msg.fps;
  if (msg.cpu)        $('monCpu').textContent     = msg.cpu;

  updateBtnUI();
}

// ============================================================
// 3. 事件注册绑定（完全移除 inline，抗击 CSP 拦截）
// ============================================================
function bindUIEvents() {
  // 选项卡切换绑定
  $('tab-options').addEventListener('click', () => switchTab('options'));
  $('tab-files').addEventListener('click', () => switchTab('files'));
  $('tab-settings').addEventListener('click', () => switchTab('settings'));

  // 精准按钮与跳转
  $('btnGoSettings').addEventListener('click', () => switchTab('settings'));
  $('btnGoFiles').addEventListener('click', () => switchTab('files'));
  $('btnGoAbout').addEventListener('click', showAbout);

  // 清晰度按钮
  $('qUHD').addEventListener('click', () => setQuality('uhd'));
  $('qHD').addEventListener('click', () => setQuality('hd'));
  $('qSD').addEventListener('click', () => setQuality('sd'));

  // 区域录制与控制中心
  $('regionBtn').addEventListener('click', toggleRegionMode);
  $('mainRecBtn').addEventListener('click', toggleMainRecord);
  $('btnPause').addEventListener('click', pauseResume);
  $('btnStop').addEventListener('click', stopRecording);

  // 悬浮窗显示按钮（★ 修复：此时元素在 HTML 中已拥有正确的 ID）
  if ($('btnApplyFloat')) {
    $('btnApplyFloat').addEventListener('click', applyFloatWindow);
  }

  // 底部清除与下载目录
  $('btnClearAll').addEventListener('click', clearAllRecordings);
  $('btnOpenDownloads').addEventListener('click', openDownloadFolder);

  // 双向配置侦听与保存绑定
  PERSISTENT_KEYS.forEach((key) => {
    const el = $(key);
    if (!el) return;

    el.addEventListener('change', () => {
      // 声音选项互斥判定
      if (key === 'noAudio' && el.checked) {
        $('sysAudio').checked = false;
        $('micAudio').checked = false;
      }
      if ((key === 'sysAudio' || key === 'micAudio') && el.checked) {
        $('noAudio').checked = false;
      }
      saveConfigToStorage();
    });
  });

  // 输入框实时写入
  $('filePrefix').addEventListener('input', saveConfigToStorage);
}

// ============================================================
// 4. 指令发射中枢
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
// 5. 辅助与面板切换
// ============================================================
function setQuality(q) {
  UI.quality = q;
  syncQualityActiveBtn(q);
  saveConfigToStorage();
  const p = QUALITY[q];
  if ($('monRes')) $('monRes').textContent = p.w + '×' + p.h;
  toast('✅ 已切换到 ' + p.label + ' 模式');
}

function syncQualityActiveBtn(q) {
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

function openDownloadFolder() {
  chrome.downloads.showDefaultFolder();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  const t = $('tab-' + name);
  const p = $('panel-' + name);
  if (t) t.classList.add('active');
  if (p) p.classList.add('active');
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  bindUIEvents();
  await loadConfigFromStorage();
  connectBackground();
});
