'use strict';

// ============================================================
// Content Script - 完整版
// 功能：
//   1. 自动检测网页 <video> 元素，悬停显示录制工具栏
//   2. 悬浮录制控制条（可拖拽）
//   3. 区域选择框
//   4. MutationObserver 监听动态加载的视频（直播网站必须）
// ============================================================

// ============================================================
// 全局状态
// ============================================================
const CS = {
  // 悬停工具栏
  hoverVideo  : null,   // 当前悬停的 video 元素
  hoverBar    : null,   // 工具栏 DOM
  hoverRAF    : null,   // requestAnimationFrame id（位置跟随）
  leaveTimer  : null,   // 鼠标离开延迟计时器

  // 悬浮控制条
  floatBar    : null,
  floatTimer  : null,
  floatSec    : 0,
  floatPaused : false,

  // 区域选择
  regionActive: false,

  // MutationObserver
  observer    : null,
};

// ============================================================
// 工具函数
// ============================================================
function fmtTime(s) {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor(s % 3600 / 60)).padStart(2, '0');
  const sc = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sc}`;
}

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
// ★ 核心：自动视频检测系统
// ============================================================

/**
 * 初始化视频检测
 * 使用 mouseenter/mouseleave 代替 mouseover（性能更好）
 * 使用 MutationObserver 监听动态加载的视频
 */
function initVideoDetection() {

  // 1. 对已存在的视频绑定事件
  bindAllVideos();

  // 2. MutationObserver：监听 DOM 变化，捕获动态加载的 video
  //    （斗鱼、虎牙、B站、抖音等直播网站都是动态渲染的）
  CS.observer = new MutationObserver((mutations) => {
    let needRebind = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        // 新增节点本身是 video，或包含 video
        if (node.tagName === 'VIDEO' || node.querySelector?.('video')) {
          needRebind = true;
          break;
        }
      }
      if (needRebind) break;
    }
    if (needRebind) {
      // 延迟一帧，等待 DOM 稳定
      requestAnimationFrame(bindAllVideos);
    }
  });

  CS.observer.observe(document.documentElement, {
    childList: true,
    subtree  : true,
  });
}

/**
 * 绑定页面上所有 video 元素的悬停事件
 */
function bindAllVideos() {
  const videos = document.querySelectorAll('video');
  videos.forEach(bindVideo);
}

/**
 * 给单个 video 元素绑定事件
 */
function bindVideo(video) {
  // 避免重复绑定
  if (video.__recBound) return;
  video.__recBound = true;

  video.addEventListener('mouseenter', () => onVideoEnter(video));
  video.addEventListener('mouseleave', () => onVideoLeave(video));
}

/**
 * 鼠标进入 video 区域
 */
function onVideoEnter(video) {
  // 取消离开计时器
  clearTimeout(CS.leaveTimer);

  // 视频太小则忽略（避免广告等小视频误触发）
  const rect = video.getBoundingClientRect();
  if (rect.width < 200 || rect.height < 120) return;

  // 已经是同一个视频，不重建
  if (CS.hoverVideo === video && CS.hoverBar) return;

  CS.hoverVideo = video;
  createHoverBar(video);
}

/**
 * 鼠标离开 video 区域
 */
function onVideoLeave(video) {
  // 延迟 400ms 再销毁（给用户时间移到工具栏上）
  CS.leaveTimer = setTimeout(() => {
    // 检查鼠标是否在工具栏上
    if (CS.hoverBar?.matches(':hover')) return;
    destroyHoverBar();
  }, 400);
}

// ============================================================
// ★ 悬停工具栏（360风格）
// ============================================================

/**
 * 创建视频悬停工具栏
 * 使用 fixed 定位（不是 absolute），避免受页面滚动影响
 */
function createHoverBar(video) {
  destroyHoverBar();

  const bar = document.createElement('div');
  bar.id = '__rec_hover_bar__';

  // ✅ 关键：使用 fixed 定位！
  bar.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    background: rgba(10, 20, 40, 0.88);
    border: 1px solid rgba(76, 175, 80, 0.8);
    border-radius: 6px;
    padding: 0;
    display: flex;
    align-items: stretch;
    font-family: 'Microsoft YaHei', Arial, sans-serif;
    font-size: 12px;
    color: #fff;
    box-shadow: 0 3px 12px rgba(0,0,0,0.5);
    user-select: none;
    pointer-events: auto;
    overflow: hidden;
    backdrop-filter: blur(6px);
    transition: opacity 0.2s;
    opacity: 0;
  `;

  bar.innerHTML = `
    <style>
      #__rec_hover_bar__ button {
        background: transparent;
        border: none;
        color: #fff;
        padding: 7px 11px;
        cursor: pointer;
        font-size: 11px;
        font-family: 'Microsoft YaHei', Arial, sans-serif;
        display: flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
        transition: background 0.15s;
        border-right: 1px solid rgba(255,255,255,0.1);
      }
      #__rec_hover_bar__ button:last-child {
        border-right: none;
      }
      #__rec_hover_bar__ button:hover {
        background: rgba(76,175,80,0.3);
      }
      #__rec_hover_bar__ .rec-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #f44336;
        display: inline-block;
        animation: _hdot 1.2s infinite;
        flex-shrink: 0;
      }
      @keyframes _hdot {
        0%,100%{opacity:1} 50%{opacity:0.3}
      }
    </style>

    <button id="__rec_btn_record__">
      <span class="rec-dot"></span>
      录制小视频
    </button>

    <button id="__rec_btn_snapshot__">
      📷 截图
    </button>

    <button id="__rec_btn_pip__">
      🪟 画中画
    </button>

    <button id="__rec_btn_close__" style="padding:7px 8px; color:#888;">
      ✕
    </button>
  `;

  // 鼠标移入工具栏：取消离开计时器
  bar.addEventListener('mouseenter', () => clearTimeout(CS.leaveTimer));
  bar.addEventListener('mouseleave', () => {
    CS.leaveTimer = setTimeout(destroyHoverBar, 300);
  });

  // ★ 录制按钮
  bar.querySelector('#__rec_btn_record__').onclick = (e) => {
    e.stopPropagation();
    onClickRecord(video);
  };

  // ★ 截图按钮
  bar.querySelector('#__rec_btn_snapshot__').onclick = (e) => {
    e.stopPropagation();
    captureSnapshot(video);
  };

  // ★ 画中画按钮
  bar.querySelector('#__rec_btn_pip__').onclick = (e) => {
    e.stopPropagation();
    togglePiP(video);
  };

  // 关闭按钮
  bar.querySelector('#__rec_btn_close__').onclick = (e) => {
    e.stopPropagation();
    destroyHoverBar();
  };

  document.documentElement.appendChild(bar);
  CS.hoverBar = bar;

  // 初次定位
  positionHoverBar(video);

  // 淡入
  requestAnimationFrame(() => {
    if (CS.hoverBar) CS.hoverBar.style.opacity = '1';
  });

  // ✅ 使用 RAF 持续跟随（处理视频位置变化/页面滚动）
  function trackPosition() {
    if (!CS.hoverBar || !CS.hoverVideo) return;
    positionHoverBar(CS.hoverVideo);
    CS.hoverRAF = requestAnimationFrame(trackPosition);
  }
  CS.hoverRAF = requestAnimationFrame(trackPosition);
}

/**
 * 计算并更新工具栏位置（fixed 定位，相对视口）
 */
function positionHoverBar(video) {
  if (!CS.hoverBar) return;
  const rect = video.getBoundingClientRect();
  const barW = CS.hoverBar.offsetWidth || 280;
  const barH = CS.hoverBar.offsetHeight || 34;

  // 默认：视频右上角，向内偏移8px
  let top  = rect.top + 8;
  let left = rect.right - barW - 8;

  // 防止超出视口
  if (left < rect.left) left = rect.left + 8;
  if (top < 4) top = 4;
  if (top + barH > window.innerHeight) top = rect.bottom - barH - 8;

  CS.hoverBar.style.top  = top  + 'px';
  CS.hoverBar.style.left = left + 'px';
}

/**
 * 销毁工具栏
 */
function destroyHoverBar() {
  clearTimeout(CS.leaveTimer);
  if (CS.hoverRAF) {
    cancelAnimationFrame(CS.hoverRAF);
    CS.hoverRAF = null;
  }
  CS.hoverBar?.remove();
  CS.hoverBar  = null;
  CS.hoverVideo = null;
}

// ============================================================
// ★ 录制按钮点击处理
// ============================================================
function onClickRecord(video) {
  destroyHoverBar();

  // 1. 显示悬浮控制条
  showFloat('top-right');

  // 2. 通知 background → popup 开始录制
  //    background 会通过 port 转发给 popup
  chrome.runtime.sendMessage({
    action: 'startRecordFromContent',
    videoInfo: {
      src   : video.currentSrc || video.src || '',
      width : video.videoWidth,
      height: video.videoHeight,
      time  : video.currentTime,
    }
  });

  // 3. 同时弹出 popup 提示用户确认
  //    （Chrome 不允许 content 直接控制 popup，但可以发消息）
  chrome.runtime.sendMessage({ action: 'openPopup' });
}

// ============================================================
// ★ 截图功能
// ============================================================
function captureSnapshot(video) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth  || video.clientWidth;
    canvas.height = video.videoHeight || video.clientHeight;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (!blob) {
        showInPageToast('❌ 截图失败（跨域视频限制）');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href     = url;
      a.download = `截图_${ts}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      showInPageToast('📷 截图已保存！');
    }, 'image/png');

  } catch (e) {
    showInPageToast('❌ 截图失败: ' + e.message);
  }
}

// ============================================================
// ★ 画中画功能
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
function showInPageToast(msg, ms = 2500) {
  let el = document.getElementById('__rec_page_toast__');
  if (!el) {
    el = document.createElement('div');
    el.id = '__rec_page_toast__';
    el.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(20,20,20,0.92);
      border: 1px solid #444;
      color: #fff;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 13px;
      font-family: 'Microsoft YaHei', Arial, sans-serif;
      z-index: 2147483647;
      pointer-events: none;
      white-space: nowrap;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      transition: opacity 0.3s;
    `;
    document.documentElement.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el.__timer);
  el.__timer = setTimeout(() => { el.style.opacity = '0'; }, ms);
}

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

  const bar = document.createElement('div');
  bar.id = '__live_rec_float__';
  bar.style.cssText = `
    position: fixed;
    ${posMap[position] || posMap['top-right']}
    z-index: 2147483647;
    background: rgba(13,13,13,0.93);
    border: 1.5px solid #e53935;
    border-radius: 10px;
    padding: 8px 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'Microsoft YaHei', Arial, sans-serif;
    font-size: 13px;
    color: #fff;
    box-shadow: 0 4px 24px rgba(229,57,53,0.4);
    user-select: none;
    min-width: 220px;
    backdrop-filter: blur(10px);
    cursor: move;
  `;

  bar.innerHTML = `
    <style>
      @keyframes _rfb { 0%,100%{opacity:1} 50%{opacity:.15} }
    </style>
    <span style="
      width:10px;height:10px;border-radius:50%;
      background:#e53935;flex-shrink:0;
      animation:_rfb 1s infinite;display:inline-block;
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

  document.documentElement.appendChild(bar);
  CS.floatBar    = bar;
  CS.floatSec    = 0;
  CS.floatPaused = false;

  document.getElementById('_rf_pause').onclick = () => {
    CS.floatPaused = !CS.floatPaused;
    document.getElementById('_rf_pause').textContent =
      CS.floatPaused ? '▶ 继续' : '⏸ 暂停';
    chrome.runtime.sendMessage({ action: 'floatPause' });
  };

  document.getElementById('_rf_stop').onclick = () => {
    chrome.runtime.sendMessage({ action: 'floatStop' });
    removeFloat();
  };

  document.getElementById('_rf_close').onclick = removeFloat;

  makeDraggable(bar);
  startFloatTimer();
}

function removeFloat() {
  CS.floatBar?.remove();
  CS.floatBar = null;
  stopFloatTimer();
}

function updateFloat(paused, timeStr) {
  CS.floatPaused = paused;
  const te = document.getElementById('_rf_time');
  const pe = document.getElementById('_rf_pause');
  if (te && timeStr) te.textContent = timeStr;
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
  }, 1000);
}

function stopFloatTimer() {
  clearInterval(CS.floatTimer);
  CS.floatTimer = null;
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
  if (CS.regionActive) return;
  CS.regionActive = true;

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
    font-size:15px;font-family:'Microsoft YaHei',Arial;
    pointer-events:none;user-select:none;
  `;
  tip.textContent = '🔲 拖拽鼠标选择录制区域 | Esc 取消';
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
    const x = Math.min(e.clientX, sx);
    const y = Math.min(e.clientY, sy);
    const w = Math.abs(e.clientX - sx);
    const h = Math.abs(e.clientY - sy);
    box.style.left   = x + 'px';
    box.style.top    = y + 'px';
    box.style.width  = w + 'px';
    box.style.height = h + 'px';
  };

  const onUp = (e) => {
    const rect = {
      x     : Math.min(e.clientX, sx),
      y     : Math.min(e.clientY, sy),
      width : Math.abs(e.clientX - sx),
      height: Math.abs(e.clientY - sy),
    };
    box?.remove(); box = null;
    cleanup();
    if (rect.width > 10 && rect.height > 10) {
      chrome.runtime.sendMessage({ action: 'regionSelected', rect });
      showInPageToast(`🔲 区域已选: ${rect.width}×${rect.height}`);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { box?.remove(); cleanup(); }
  };

  function cleanup() {
    CS.regionActive = false;
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
  CS.regionActive = false;
}

// ============================================================
// 启动
// ============================================================
// 等 DOM 就绪后再初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVideoDetection);
} else {
  initVideoDetection();
}
