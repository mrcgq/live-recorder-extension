'use strict';

// ============================================================
// Content Script
// 注入到所有页面，负责：
// 1. 悬浮录制控制条
// 2. 区域选择框
// ============================================================

let floatBar   = null;
let floatTimer = null;
let floatSec   = 0;
let floatPause = false;

let regionActive = false;

// ============================================================
// 消息监听（来自 popup / background）
// ============================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'showFloat':
      showFloat(msg.position || 'bottom-right');
      break;
    case 'removeFloat':
      removeFloat();
      break;
    case 'updateFloat':
      updateFloat(msg.paused, msg.time);
      break;
    case 'enableRegionSelect':
      startRegion();
      break;
    case 'disableRegionSelect':
      stopRegion();
      break;
  }
  sendResponse({ ok: true });
  return true;
});

// ============================================================
// 悬浮控制条
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

  floatBar = document.createElement('div');
  Object.assign(floatBar.style, {
    cssText: `
      position:fixed;
      ${posMap[position] || posMap['bottom-right']}
      z-index:2147483647;
      background:rgba(13,13,13,0.93);
      border:1.5px solid #e53935;
      border-radius:10px;
      padding:8px 14px;
      display:flex;
      align-items:center;
      gap:10px;
      font-family:'Microsoft YaHei',Arial,sans-serif;
      font-size:13px;
      color:#fff;
      box-shadow:0 4px 24px rgba(229,57,53,0.45);
      user-select:none;
      min-width:210px;
      backdrop-filter:blur(10px);
      cursor:move;
    `
  });

  // 内联 style 方式更可靠
  floatBar.style.cssText = `
    position:fixed;
    ${posMap[position] || posMap['bottom-right']}
    z-index:2147483647;
    background:rgba(13,13,13,0.93);
    border:1.5px solid #e53935;
    border-radius:10px;
    padding:8px 14px;
    display:flex;
    align-items:center;
    gap:10px;
    font-family:'Microsoft YaHei',Arial,sans-serif;
    font-size:13px;
    color:#fff;
    box-shadow:0 4px 24px rgba(229,57,53,0.45);
    user-select:none;
    min-width:210px;
    backdrop-filter:blur(10px);
    cursor:move;
  `;

  floatBar.innerHTML = `
    <style>
      @keyframes _rfblink {0%,100%{opacity:1}50%{opacity:.15}}
    </style>
    <span style="
      width:10px;height:10px;border-radius:50%;
      background:#e53935;flex-shrink:0;
      animation:_rfblink 1s infinite;display:inline-block;
    "></span>
    <span id="_rf_time" style="
      font-family:'Courier New',monospace;
      font-size:14px;font-weight:bold;
      color:#ff6666;letter-spacing:1px;flex:1;
    ">00:00:00</span>
    <button id="_rf_pause" style="
      background:rgba(255,152,0,.15);border:1px solid #ff9800;
      color:#ff9800;padding:4px 10px;border-radius:5px;
      cursor:pointer;font-size:11px;font-family:inherit;
    ">⏸ 暂停</button>
    <button id="_rf_stop" style="
      background:rgba(229,57,53,.15);border:1px solid #e53935;
      color:#e53935;padding:4px 10px;border-radius:5px;
      cursor:pointer;font-size:11px;font-family:inherit;
    ">⏹ 停止</button>
    <button id="_rf_close" style="
      background:transparent;border:none;
      color:#666;cursor:pointer;font-size:18px;
      line-height:1;padding:0 2px;
    ">×</button>
  `;

  document.documentElement.appendChild(floatBar);

  // ✅ 修复：通过 background 转发给 popup
  document.getElementById('_rf_pause').onclick = () => {
    floatPause = !floatPause;
    document.getElementById('_rf_pause').textContent =
      floatPause ? '▶ 继续' : '⏸ 暂停';
    // 发给 background，background 转发给 popup
    chrome.runtime.sendMessage({ action: 'floatPause' });
  };

  document.getElementById('_rf_stop').onclick = () => {
    chrome.runtime.sendMessage({ action: 'floatStop' });
  };

  document.getElementById('_rf_close').onclick = () => {
    removeFloat();
  };

  makeDraggable(floatBar);

  // 启动计时
  floatSec   = 0;
  floatPause = false;
  startFloatTimer();
}

function removeFloat() {
  floatBar?.remove();
  floatBar = null;
  stopFloatTimer();
}

function updateFloat(paused, timeStr) {
  floatPause = paused;
  const te = document.getElementById('_rf_time');
  const pe = document.getElementById('_rf_pause');
  if (te && timeStr) te.textContent = timeStr;
  if (pe) pe.textContent = paused ? '▶ 继续' : '⏸ 暂停';
}

function startFloatTimer() {
  stopFloatTimer();
  floatTimer = setInterval(() => {
    if (floatPause) return;
    floatSec++;
    const el = document.getElementById('_rf_time');
    if (!el) { stopFloatTimer(); return; }
    const h = String(Math.floor(floatSec/3600)).padStart(2,'0');
    const m = String(Math.floor(floatSec%3600/60)).padStart(2,'0');
    const s = String(floatSec%60).padStart(2,'0');
    el.textContent = `${h}:${m}:${s}`;
  }, 1000);
}

function stopFloatTimer() {
  clearInterval(floatTimer);
  floatTimer = null;
}

// ============================================================
// 拖拽
// ============================================================
function makeDraggable(el) {
  let drag = false, sx, sy, ox, oy;

  el.addEventListener('mousedown', (e) => {
    if (['BUTTON'].includes(e.target.tagName)) return;
    drag = true;
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect();
    ox = r.left;    oy = r.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    el.style.left      = ox + e.clientX - sx + 'px';
    el.style.top       = oy + e.clientY - sy + 'px';
    el.style.right     = 'auto';
    el.style.bottom    = 'auto';
    el.style.transform = 'none';
  });

  document.addEventListener('mouseup', () => { drag = false; });
}

// ============================================================
// 区域选择
// ============================================================
function startRegion() {
  if (regionActive) return;
  regionActive = true;

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:2147483646;
    background:rgba(0,0,0,0.35);cursor:crosshair;
  `;

  const tip = document.createElement('div');
  tip.style.cssText = `
    position:fixed;top:50%;left:50%;
    transform:translate(-50%,-50%);
    background:rgba(229,57,53,0.92);color:#fff;
    padding:12px 28px;border-radius:8px;
    font-size:15px;font-family:Arial;
    pointer-events:none;user-select:none;
  `;
  tip.textContent = '🔲 拖拽鼠标选择录制区域  |  Esc 取消';
  overlay.appendChild(tip);
  document.documentElement.appendChild(overlay);

  let sx, sy, box = null;

  const onDown = (e) => {
    tip.style.display = 'none';
    sx = e.clientX; sy = e.clientY;
    box = document.createElement('div');
    box.style.cssText = `
      position:fixed;border:2px solid #e53935;
      background:rgba(229,57,53,.1);pointer-events:none;
      z-index:2147483647;
    `;
    document.documentElement.appendChild(box);
  };

  const onMove = (e) => {
    if (!box) return;
    const x = Math.min(e.clientX, sx), y = Math.min(e.clientY, sy);
    const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
    box.style.cssText += `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
  };

  const onUp = (e) => {
    const rect = {
      x: Math.min(e.clientX, sx),
      y: Math.min(e.clientY, sy),
      width : Math.abs(e.clientX - sx),
      height: Math.abs(e.clientY - sy),
    };
    box?.remove(); box = null;
    cleanup();
    if (rect.width > 10 && rect.height > 10) {
      chrome.runtime.sendMessage({ action: 'regionSelected', rect });
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { box?.remove(); cleanup(); }
  };

  function cleanup() {
    regionActive = false;
    overlay.remove();
    overlay.removeEventListener('mousedown', onDown);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('keydown', onKey);
  }

  overlay.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('keydown', onKey);
}

function stopRegion() {
  regionActive = false;
}
