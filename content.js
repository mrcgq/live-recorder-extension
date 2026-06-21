'use strict';

// ============================================================
// Content Script - 360 风格网页内录悬浮栏
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
  bindTimeout : null,
};

function fmtTime(s) {
  s = s || 0;
  return [
    Math.floor(s / 3600),
    Math.floor((s % 3600) / 60),
    s % 60,
  ].map((n) => String(n).padStart(2, '0')).join(':');
}

// 接收来自 background 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
  }
  sendResponse({ ok: true });
  return true;
});

// 节流，避免 live chat 持续引起主线程卡顿 (Law-46)
function throttledBindAllVideos() {
  if (CS.bindTimeout) return;
  CS.bindTimeout = setTimeout(() => {
    bindAllVideos();
    CS.bindTimeout = null;
  }, 1000);
}

// 全局流式指针嗅探：穿透透明控制图层，100% 唤醒
function initVideoDetection() {
  bindAllVideos();

  // 1. 全局 mouseover 嗅探（Bypass 控制遮罩层）
  document.addEventListener('mouseover', (e) => {
    let target = e.target;
    if (!target) return;

    let video = null;
    if (target.tagName === 'VIDEO') {
      video = target;
    } else {
      // 穿透遮罩层：向上或向内检索视频
      video = target.querySelector('video') || 
              (target.parentElement && target.parentElement.querySelector('video')) ||
              (target.closest && target.closest('.player, .video-container, [class*="player"]') && target.closest('.player, .video-container, [class*="player"]').querySelector('video'));
    }

    if (video) {
      clearTimeout(CS.leaveTimer);
      const rect = video.getBoundingClientRect();
      if (rect.width < 240 || rect.height < 130) return;

      if (CS.hoverVideo !== video) {
        CS.hoverVideo = video;
        createHoverBar(video);
      }
    } else {
      if (CS.hoverBar && !CS.hoverBar.contains(target)) {
        CS.leaveTimer = setTimeout(destroyHoverBar, 600);
      }
    }
  });

  // 2. DOM 观察器
  CS.observer = new MutationObserver((mutations) => {
    let hasVideoNode = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'VIDEO' || (node.querySelector && node.querySelector('video'))) {
          hasVideoNode = true;
          break;
        }
      }
      if (hasVideoNode) break;
    }
    if (hasVideoNode) {
      throttledBindAllVideos();
    }
  });

  CS.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function bindAllVideos() {
  document.querySelectorAll('video').forEach(bindVideo);
}

function bindVideo(video) {
  if (video.__recBound) return;
  video.__recBound = true;

  video.addEventListener('mouseleave', () => {
    CS.leaveTimer = setTimeout(destroyHoverBar, 600);
  });
}

// ============================================================
// 创建 360 风格高保真网页悬浮录制栏 (对齐 Image 1)
// ============================================================
function createHoverBar(video) {
  destroyHoverBar();

  if (!document.getElementById('__rec_style__')) {
    const style = document.createElement('style');
    style.id = '__rec_style__';
    style.textContent = `
      #__rec_hover_bar__ {
        position: fixed;
        z-index: 2147483647;
        background: #ffffff;
        border: 1px solid #dcdcdc;
        border-top: 3px solid #10b981; /* 360 绿色顶线 */
        border-radius: 0 0 6px 6px;
        height: 38px;
        display: flex;
        align-items: center;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        font-family: 'Microsoft YaHei', Arial, sans-serif;
        font-size: 12px;
        color: #333333;
        overflow: hidden;
        user-select: none;
        opacity: 0;
        transition: opacity 0.15s ease-in-out;
      }
      #__rec_hover_bar__ .logo-section {
        background: #10b981;
        width: 34px;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      #__rec_hover_bar__ .logo-circle {
        width: 20px;
        height: 20px;
        background: #ffffff;
        border-radius: 50%;
        color: #10b981;
        font-weight: bold;
        font-size: 13px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #__rec_hover_bar__ button {
        background: transparent;
        border: none;
        border-right: 1px solid #f0f0f0;
        color: #444444;
        height: 100%;
        padding: 0 14px;
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
        transition: background 0.15s;
      }
      #__rec_hover_bar__ button:hover {
        background: #f4f4f5;
        color: #10b981;
      }
      #__rec_hover_bar__ button:last-child {
        border-right: none;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  const bar = document.createElement('div');
  bar.id = '__rec_hover_bar__';
  bar.innerHTML = `
    <div class="logo-section">
      <div class="logo-circle">e</div>
    </div>
    <button id="__rb_rec__">🎥 录制小视频</button>
    <button id="__rb_clip__">✂️ 剪视频</button>
    <button id="__rb_pip__">📺 小窗口</button>
    <button id="__rb_settings__">⚙️ 设置</button>
    <button id="__rb_close__" style="color: #999;">✕ 关闭</button>
  `;

  bar.addEventListener('mouseenter', () => clearTimeout(CS.leaveTimer));
  bar.addEventListener('mouseleave', () => {
    CS.leaveTimer = setTimeout(destroyHoverBar, 400);
  });

  // 事件程序化注入
  bar.querySelector('#__rb_rec__').addEventListener('click', (e) => {
    e.stopPropagation();
    onClickRecord();
  });

  bar.querySelector('#__rb_clip__').addEventListener('click', (e) => {
    e.stopPropagation();
    showInPageToast('✂️ 录制结束后，可在扩展面板【高级设置】进行视频裁剪');
  });

  bar.querySelector('#__rb_pip__').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePiP(video);
  });

  bar.querySelector('#__rb_settings__').addEventListener('click', (e) => {
    e.stopPropagation();
    showInPageToast('⚙️ 请点击右上角浏览器工具栏图标打开扩展设置');
  });

  bar.querySelector('#__rb_close__').addEventListener('click', (e) => {
    e.stopPropagation();
    destroyHoverBar();
  });

  document.documentElement.appendChild(bar);
  CS.hoverBar = bar;

  positionHoverBar(video);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (CS.hoverBar) CS.hoverBar.style.opacity = '1';
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
  const barW = CS.hoverBar.offsetWidth  || 360;

  let top  = rect.top + window.scrollY;
  let left = rect.left + window.scrollX + (rect.width / 2) - (barW / 2);

  // 保证不超出视频左右边界
  if (left < rect.left + window.scrollX) left = rect.left + window.scrollX;

  CS.hoverBar.style.top  = top  + 'px';
  CS.hoverBar.style.left = left + 'px';
}

function destroyHoverBar() {
  clearTimeout(CS.leaveTimer);
  if (CS.hoverRAF) { cancelAnimationFrame(CS.hoverRAF); CS.hoverRAF = null; }
  if (CS.hoverBar) { CS.hoverBar.remove(); CS.hoverBar = null; }
  CS.hoverVideo = null;
}

function onClickRecord() {
  destroyHoverBar();
  showFloat('top-right');
  showInPageToast('🔴 正在启动录制，请在弹出的录制小窗口中进行控制...');

  chrome.runtime.sendMessage({
    action: 'startRecordFromContent',
    config: {
      sysAudio: true,
      micAudio: false,
      noAudio: false,
      format: 'mp4',
      vbps: 6000000,
      abps: 192000,
      fps: 30,
      filePrefix: '快照录制'
    }
  });
}

// 物理级“小窗口”画中画接口 (一键Detached)
async function togglePiP(video) {
  try {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      showInPageToast('🪟 已退出小窗口播放');
    } else {
      await video.requestPictureInPicture();
      showInPageToast('🪟 小窗口播放已开启');
    }
  } catch (e) {
    showInPageToast('❌ 小窗口不可用: 视频未加载或受跨域保护');
  }
}

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
      'border:1px solid #555', 'color:#fff',
      'padding:10px 22px', 'border-radius:8px',
      'font-size:13px;',
      'font-family:Microsoft YaHei,Arial,sans-serif',
      'z-index:2147483647', 'pointer-events:none',
      'white-space:nowrap',
      'box-shadow:0 4px 18px rgba(0,0,0,0.45)',
      'transition:opacity 0.3s', 'opacity:0',
    ].join(';');
    document.documentElement.appendChild(el);
  }
  el.textContent   = msg;
  el.style.opacity = '1';
  clearTimeout(el.__t);
  el.__t = setTimeout(() => { el.style.opacity = '0'; }, ms);
}

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
    'display:flex', 'align-items:center', 'gap:10px',
    'font-family:Microsoft YaHei,Arial,sans-serif',
    'font-size:13px', 'color:#fff',
    'box-shadow:0 4px 24px rgba(229,57,53,0.4)',
    'user-select:none', 'min-width:220px',
    'backdrop-filter:blur(10px)', 'cursor:move',
  ].join(';');

  bar.innerHTML = `
    <style>@keyframes _rfb{0%,100%{opacity:1}50%{opacity:.15}}</style>
    <span style="width:10px;height:10px;border-radius:50%;background:#e53935;
      flex-shrink:0;display:inline-block;animation:_rfb 1s infinite;"></span>
    <span id="_rf_time" style="font-family:'Courier New',monospace;
      font-size:14px;font-weight:bold;color:#ff6666;letter-spacing:1px;flex:1;">
      00:00:00
    </span>
    <button id="_rf_pause" style="background:rgba(255,152,0,.15);border:1px solid #ff9800;
      color:#ff9800;padding:4px 10px;border-radius:5px;cursor:pointer;
      font-size:11px;font-family:inherit;">⏸ 暂停</button>
    <button id="_rf_stop" style="background:rgba(229,57,53,.15);border:1px solid #e53935;
      color:#e53935;padding:4px 10px;border-radius:5px;cursor:pointer;
      font-size:11px;font-family:inherit;">⏹ 停止</button>
    <button id="_rf_close" style="background:transparent;border:none;
      color:#666;cursor:pointer;font-size:18px;line-height:1;padding:0 2px;">×</button>
  `;

  document.documentElement.appendChild(bar);
  CS.floatBar    = bar;
  CS.floatSec    = 0;
  CS.floatPaused = false;

  bar.querySelector('#_rf_pause').addEventListener('click', () => {
    CS.floatPaused = !CS.floatPaused;
    bar.querySelector('#_rf_pause').textContent =
      CS.floatPaused ? '▶ 继续' : '⏸ 暂停';

    const action = CS.floatPaused ? 'pauseRecording' : 'resumeRecording';
    chrome.runtime.sendMessage(
      { action, _target: 'recorder' },
      () => void chrome.runtime.lastError
    );
  });

  bar.querySelector('#_rf_stop').addEventListener('click', () => {
    chrome.runtime.sendMessage(
      { action: 'stopRecording', _target: 'recorder' },
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVideoDetection);
} else {
  initVideoDetection();
}
