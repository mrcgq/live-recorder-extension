'use strict';

// ============================================================
// Content Script - 最终优化版
// 修复：
//   1. 合并 bindDebounce / bindTimeout 为唯一节流变量（Law-01）
//   2. 移除未使用的 throttledBindAllVideos 外部定义
//   3. 悬浮条暂停/继续逻辑修正
// ============================================================

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
  bindTimeout : null,   // ★ 唯一节流计时器（合并后）
};

// ============================================================
// 工具函数
// ============================================================
function fmtTime(s) {
  s = s || 0;
  return [
    Math.floor(s / 3600),
    Math.floor((s % 3600) / 60),
    s % 60,
  ].map((n) => String(n).padStart(2, '0')).join(':');
}

// ============================================================
// 消息监听
// ============================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'showFloat':
      showFloat(msg.position || 'top-right');
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
    default:
      break;
  }
  sendResponse({ ok: true });
  return true;
});

// ============================================================
// 视频自动检测（★ 唯一防抖入口，消除冗余）
// ============================================================
function throttledBindAllVideos() {
  // ★ 利用 CS.bindTimeout 唯一控制，1000ms 内只执行一次（Law-01/46）
  if (CS.bindTimeout) return;
  CS.bindTimeout = setTimeout(() => {
    bindAllVideos();
    CS.bindTimeout = null;
  }, 1000);
}

function initVideoDetection() {
  bindAllVideos();

  CS.observer = new MutationObserver((mutations) => {
    let hasVideoNode = false;

    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (
          node.tagName === 'VIDEO' ||
          (node.querySelector && node.querySelector('video'))
        ) {
          hasVideoNode = true;
          break;
        }
      }
      if (hasVideoNode) break;
    }

    // ★ 只在真正检测到 video 节点时才触发节流绑定
    if (hasVideoNode) {
      throttledBindAllVideos();
    }
  });

  CS.observer.observe(document.documentElement, {
    childList: true,
    subtree  : true,
  });
}

function bindAllVideos() {
  document.querySelectorAll('video').forEach(bindVideo);
}

function bindVideo(video) {
  if (video.__recBound) return;
  video.__recBound = true;

  video.addEventListener('mouseenter', () => onVideoEnter(video));
  video.addEventListener('mouseleave', () => onVideoLeave());
}

function onVideoEnter(video) {
  clearTimeout(CS.leaveTimer);

  const rect = video.getBoundingClientRect();
  // 过滤过小的视频（广告、头像等）
  if (rect.width < 200 || rect.height < 120) return;
  if (CS.hoverVideo === video && CS.hoverBar) return;

  CS.hoverVideo = video;
  createHoverBar(video);
}

function onVideoLeave() {
  CS.leaveTimer = setTimeout(() => {
    // 如果鼠标已移入工具栏，取消销毁
    if (CS.hoverBar && CS.hoverBar.matches(':hover')) return;
    destroyHoverBar();
  }, 400);
}

// ============================================================
// 悬停工具栏
// ============================================================
function createHoverBar(video) {
  destroyHoverBar();

  // 样式仅注入一次
  if (!document.getElementById('__rec_style__')) {
    const style = document.createElement('style');
    style.id = '__rec_style__';
    style.textContent = `
      #__rec_hover_bar__ {
        position: fixed;
        z-index: 2147483647;
        background: rgba(8, 18, 36, 0.92);
        border: 1px solid rgba(76, 175, 80, 0.8);
        border-radius: 6px;
        display: flex;
        align-items: stretch;
        overflow: hidden;
        font-family: 'Microsoft YaHei', Arial, sans-serif;
        font-size: 12px;
        color: #fff;
        box-shadow: 0 3px 14px rgba(0,0,0,0.55);
        user-select: none;
        backdrop-filter: blur(6px);
        opacity: 0;
        transition: opacity 0.18s;
        pointer-events: auto;
      }
      #__rec_hover_bar__ button {
        background: transparent;
        border: none;
        border-right: 1px solid rgba(255,255,255,0.1);
        color: #fff;
        padding: 7px 12px;
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
        display: flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
        transition: background 0.15s;
      }
      #__rec_hover_bar__ button:last-child { border-right: none; }
      #__rec_hover_bar__ button:hover { background: rgba(76,175,80,0.28); }
      #__rec_hover_bar__ .rdot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #f44336; display: inline-block; flex-shrink: 0;
        animation: _rdot 1.2s infinite;
      }
      @keyframes _rdot { 0%,100%{opacity:1} 50%{opacity:0.25} }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  const bar = document.createElement('div');
  bar.id = '__rec_hover_bar__';
  bar.innerHTML = `
    <button id="__rb_rec__"><span class="rdot"></span>录制小视频</button>
    <button id="__rb_snap__">📷 截图</button>
    <button id="__rb_pip__">🪟 画中画</button>
    <button id="__rb_close__" style="color:#999;padding:7px 9px;">✕</button>
  `;

  bar.addEventListener('mouseenter', () => clearTimeout(CS.leaveTimer));
  bar.addEventListener('mouseleave', () => {
    CS.leaveTimer = setTimeout(destroyHoverBar, 300);
  });

  bar.querySelector('#__rb_rec__').addEventListener('click', (e) => {
    e.stopPropagation();
    onClickRecord(video);
  });
  bar.querySelector('#__rb_snap__').addEventListener('click', (e) => {
    e.stopPropagation();
    captureSnapshot(video);
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

  // 双 RAF 确保 CSS transition 触发
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (CS.hoverBar) CS.hoverBar.style.opacity = '1';
  }));

  // RAF 持续跟随视频位置
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
  const barW = CS.hoverBar.offsetWidth  || 295;
  const barH = CS.hoverBar.offsetHeight || 34;

  let top  = rect.top  + 10;
  let left = rect.right - barW - 10;

  if (left < rect.left + 4)                    left = rect.left + 4;
  if (top  < 4)                                top  = 4;
  if (top  + barH > window.innerHeight - 4)    top  = rect.bottom - barH - 10;

  CS.hoverBar.style.top  = top  + 'px';
  CS.hoverBar.style.left = left + 'px';
}

function destroyHoverBar() {
  clearTimeout(CS.leaveTimer);
  if (CS.hoverRAF) { cancelAnimationFrame(CS.hoverRAF); CS.hoverRAF = null; }
  if (CS.hoverBar) { CS.hoverBar.remove(); CS.hoverBar = null; }
  CS.hoverVideo = null;
}

// ============================================================
// 录制按钮点击
// ============================================================
function onClickRecord(video) {
  destroyHoverBar();
  showFloat('top-right');
  showInPageToast('🔴 正在启动录制，请在弹窗中授权...');

  // background 会从 sender.tab.id 获取精确 tabId
  chrome.runtime.sendMessage({
    action: 'startRecordFromContent',
    config: {
      sysAudio  : true,
      micAudio  : false,
      noAudio   : false,
      format    : 'webm',
      vbps      : 6_000_000,
      abps      : 192_000,
      fps       : 30,
      filePrefix: '直播录制',
      quality   : 'hd',
    },
  });
}

// ============================================================
// 截图
// ============================================================
function captureSnapshot(video) {
  try {
    const w = video.videoWidth  || video.clientWidth  || 1280;
    const h = video.videoHeight || video.clientHeight || 720;

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);

    canvas.toBlob((blob) => {
      if (!blob) { showInPageToast('❌ 截图失败（跨域限制）'); return; }
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href          = url;
      a.download      = '截图_' + ts + '.png';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 3000);
      showInPageToast('📷 截图已保存！');
    }, 'image/png');
  } catch (e) {
    showInPageToast('❌ 截图失败: ' + e.message);
  }
}

// ============================================================
// 画中画
// ============================================================
async function togglePiP(video) {
  try {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      showInPageToast('🪟 已退出画中画');
    } else {
      await video.requestPictureInPicture();
      showInPageToast('🪟 画中画已开启');
    }
  } catch (e) {
    showInPageToast('❌ 画中画不可用: ' + e.message);
  }
}

// ============================================================
// 页面内 Toast 提示
// ============================================================
function showInPageToast(msg, ms) {
  ms = ms || 2500;
  let el = document.getElementById('__rec_page_toast__');
  if (!el) {
    el = document.createElement('div');
    el.id = '__rec_page_toast__';
    el.style.cssText = [
      'position:fixed', 'bottom:80px', 'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(16,16,16,0.94)',
      'border:1px solid #555',
      'color:#fff',
      'padding:10px 22px',
      'border-radius:8px',
      'font-size:13px',
      'font-family:Microsoft YaHei,Arial,sans-serif',
      'z-index:2147483647',
      'pointer-events:none',
      'white-space:nowrap',
      'box-shadow:0 4px 18px rgba(0,0,0,0.45)',
      'transition:opacity 0.3s',
      'opacity:0',
    ].join(';');
    document.documentElement.appendChild(el);
  }
  el.textContent   = msg;
  el.style.opacity = '1';
  clearTimeout(el.__t);
  el.__t = setTimeout(() => { el.style.opacity = '0'; }, ms);
}

// ============================================================
// 悬浮录制控制条
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
    'background:rgba(13,13,13,0.94)',
    'border:1.5px solid #e53935',
    'border-radius:10px',
    'padding:8px 14px',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'font-family:Microsoft YaHei,Arial,sans-serif',
    'font-size:13px',
    'color:#fff',
    'box-shadow:0 4px 24px rgba(229,57,53,0.4)',
    'user-select:none',
    'min-width:220px',
    'backdrop-filter:blur(10px)',
    'cursor:move',
  ].join(';');

  bar.innerHTML = `
    <style>
      @keyframes _rfb { 0%,100%{opacity:1} 50%{opacity:.15} }
    </style>
    <span style="
      width:10px;height:10px;border-radius:50%;background:#e53935;
      flex-shrink:0;display:inline-block;animation:_rfb 1s infinite;
    "></span>
    <span id="_rf_time" style="
      font-family:'Courier New',monospace;font-size:14px;
      font-weight:bold;color:#ff6666;letter-spacing:1px;flex:1;
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
      background:transparent;border:none;color:#666;
      cursor:pointer;font-size:18px;line-height:1;padding:0 2px;
    ">×</button>
  `;

  document.documentElement.appendChild(bar);
  CS.floatBar    = bar;
  CS.floatSec    = 0;
  CS.floatPaused = false;

  // ★ 修复：暂停/继续逻辑正确区分两种状态
  bar.querySelector('#_rf_pause').addEventListener('click', () => {
    CS.floatPaused = !CS.floatPaused;
    bar.querySelector('#_rf_pause').textContent =
      CS.floatPaused ? '▶ 继续' : '⏸ 暂停';

    // 发送正确的动作（不是固定的 floatPause）
    const action = CS.floatPaused ? 'pauseRecording' : 'resumeRecording';
    chrome.runtime.sendMessage(
      { action, _target: 'offscreen' },
      () => void chrome.runtime.lastError
    );
  });

  bar.querySelector('#_rf_stop').addEventListener('click', () => {
    chrome.runtime.sendMessage(
      { action: 'stopRecording', _target: 'offscreen' },
      () => void chrome.runtime.lastError
    );
    removeFloat();
  });

  bar.querySelector('#_rf_close').addEventListener('click', removeFloat);

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
  const pe = document.getElementById('_rf_pause');
  if (te && timeStr) te.textContent = timeStr;
  if (pe) pe.textContent = CS.floatPaused ? '▶ 继续' : '⏸ 暂停';
}

function startFloatTimer() {
  stopFloatTimer();
  CS.floatTimer = setInterval(() => {
    if (CS.floatPaused) return;
    CS.floatSec++;
    const el = document.getElementById('_rf_time');
    if (!el) { stopFloatTimer(); return; }
    el.textContent = fmtTime(CS.floatSec);
  }, 1000);
}

function stopFloatTimer() {
  if (CS.floatTimer) { clearInterval(CS.floatTimer); CS.floatTimer = null; }
}

// ============================================================
// 拖拽
// ============================================================
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
  if (CS.regionActive) return;
  CS.regionActive = true;

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483646',
    'background:rgba(0,0,0,0.32)', 'cursor:crosshair',
  ].join(';');

  const tip = document.createElement('div');
  tip.style.cssText = [
    'position:fixed', 'top:50%', 'left:50%',
    'transform:translate(-50%,-50%)',
    'background:rgba(229,57,53,0.93)',
    'color:#fff', 'padding:12px 28px', 'border-radius:8px',
    'font-size:15px', 'font-family:Microsoft YaHei,Arial',
    'pointer-events:none', 'user-select:none', 'white-space:nowrap',
  ].join(';');
  tip.textContent = '🔲 拖拽选择录制区域 | Esc 取消';
  overlay.appendChild(tip);
  document.documentElement.appendChild(overlay);

  let startX, startY, selBox = null;

  const onDown = (e) => {
    tip.style.display = 'none';
    startX = e.clientX; startY = e.clientY;
    selBox = document.createElement('div');
    selBox.style.cssText = [
      'position:fixed',
      'border:2px solid #e53935',
      'background:rgba(229,57,53,0.08)',
      'pointer-events:none',
      'z-index:2147483647',
    ].join(';');
    document.documentElement.appendChild(selBox);
  };

  const onMove = (e) => {
    if (!selBox) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selBox.style.left   = x + 'px';
    selBox.style.top    = y + 'px';
    selBox.style.width  = w + 'px';
    selBox.style.height = h + 'px';
  };

  const onUp = (e) => {
    const rect = {
      x     : Math.min(e.clientX, startX),
      y     : Math.min(e.clientY, startY),
      width : Math.abs(e.clientX - startX),
      height: Math.abs(e.clientY - startY),
    };
    if (selBox) { selBox.remove(); selBox = null; }
    cleanup();
    if (rect.width > 10 && rect.height > 10) {
      showInPageToast('🔲 已选区域: ' + rect.width + '×' + rect.height);
    }
  };

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (selBox) { selBox.remove(); selBox = null; }
    cleanup();
  };

  function cleanup() {
    CS.regionActive = false;
    overlay.remove();
    overlay.removeEventListener('mousedown', onDown);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    document.removeEventListener('keydown',   onKey);
  }

  overlay.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
  document.addEventListener('keydown',   onKey);
}

function stopRegion() {
  CS.regionActive = false;
}

// ============================================================
// 启动
// ============================================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVideoDetection);
} else {
  initVideoDetection();
}
