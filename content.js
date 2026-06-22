'use strict';

// ============================================================
// content.js - 完整修复版 v2.3
// C-01: 影子 DOM 深度穿透
// C-02: 透明控制层穿透
// C-03: 防抖冗余清理（单一 bindTimeout）
// C-04: 悬浮栏事件完整绑定
// C-05: 点击录制不自动开录（autoStart:false）
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
  return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60]
    .map(n => String(n).padStart(2,'0')).join(':');
}

// ── 消息监听 ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'showFloat':         showFloat(msg.position || 'top-right'); break;
    case 'removeFloat':       removeFloat();                          break;
    case 'updateFloat':       updateFloat(msg.paused, msg.time);      break;
    case 'enableRegionSelect':  startRegion();                        break;
    case 'disableRegionSelect': stopRegion();                         break;
  }
  sendResponse({ ok: true });
  return true;
});

// ── C-01: 影子 DOM 深度穿透 ──────────────────────────────────
function findVideosDeep(root) {
  root = root || document;
  const videos = [];
  function traverse(node) {
    if (!node) return;
    const type = node.nodeType;
    if (type !== Node.ELEMENT_NODE && type !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.tagName === 'VIDEO') videos.push(node);
    const children = node.children;
    if (children) for (let i = 0; i < children.length; i++) traverse(children[i]);
    if (node.shadowRoot) traverse(node.shadowRoot);
  }
  traverse(root);
  return videos;
}

// ── C-03: 唯一防抖 ───────────────────────────────────────────
function throttledBindAllVideos() {
  if (CS.bindTimeout) return;
  CS.bindTimeout = setTimeout(() => {
    CS.bindTimeout = null;
    findVideosDeep().forEach(bindVideo);
  }, 1000);
}

// ── 初始化 ───────────────────────────────────────────────────
function initVideoDetection() {
  findVideosDeep().forEach(bindVideo);

  // C-02: 全局 mouseover 穿透透明层
  document.addEventListener('mouseover', onGlobalMouseover, { passive: true });

  CS.observer = new MutationObserver((mutations) => {
    let hasVideo = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'VIDEO' || (node.querySelector && node.querySelector('video'))) {
          hasVideo = true; break;
        }
      }
      if (hasVideo) break;
    }
    if (hasVideo) throttledBindAllVideos();
  });
  CS.observer.observe(document.documentElement, { childList:true, subtree:true });
}

function onGlobalMouseover(e) {
  const target = e.target;
  if (!target) return;
  const video = findVideoNear(target);
  if (video) {
    clearTimeout(CS.leaveTimer);
    const rect = video.getBoundingClientRect();
    if (rect.width < 240 || rect.height < 130) return;
    if (CS.hoverVideo !== video) { CS.hoverVideo = video; createHoverBar(video); }
  } else {
    if (CS.hoverBar && !CS.hoverBar.contains(target)) {
      CS.leaveTimer = setTimeout(destroyHoverBar, 600);
    }
  }
}

function findVideoNear(target) {
  if (!target) return null;
  if (target.tagName === 'VIDEO') return target;
  if (target.shadowRoot) {
    const v = target.shadowRoot.querySelector('video');
    if (v) return v;
  }
  if (target.querySelector) {
    const v = target.querySelector('video');
    if (v) return v;
  }
  if (target.closest) {
    const container = target.closest(
      '[class*="player"],[class*="video"],[class*="Player"],[class*="Video"],figure,article'
    );
    if (container) {
      const v = container.querySelector('video');
      if (v) return v;
    }
  }
  if (target.parentElement) {
    const v = target.parentElement.querySelector('video');
    if (v) return v;
  }
  return null;
}

function bindVideo(video) {
  if (video.__recBound) return;
  video.__recBound = true;
  video.addEventListener('mouseleave', () => {
    CS.leaveTimer = setTimeout(destroyHoverBar, 600);
  }, { passive: true });
}

// ── 悬浮录制栏 ───────────────────────────────────────────────
function createHoverBar(video) {
  destroyHoverBar();

  if (!document.getElementById('__rec_style__')) {
    const style = document.createElement('style');
    style.id = '__rec_style__';
    style.textContent = `
      #__rec_hover_bar__ {
        position:fixed; z-index:2147483647;
        background:#fff; border:1px solid #dcdcdc;
        border-top:3px solid #10b981;
        border-radius:0 0 6px 6px; height:38px;
        display:flex; align-items:center;
        box-shadow:0 4px 12px rgba(0,0,0,.15);
        font-family:'Microsoft YaHei',Arial,sans-serif;
        font-size:12px; color:#333; overflow:hidden;
        user-select:none; opacity:0;
        transition:opacity .15s ease-in-out;
      }
      #__rec_hover_bar__ .logo { background:#10b981; width:34px; height:100%;
        display:flex; align-items:center; justify-content:center; flex-shrink:0; }
      #__rec_hover_bar__ .logo span {
        width:20px; height:20px; background:#fff; border-radius:50%;
        color:#10b981; font-weight:bold; font-size:13px;
        display:flex; align-items:center; justify-content:center; }
      #__rec_hover_bar__ button {
        background:transparent; border:none; border-right:1px solid #f0f0f0;
        color:#444; height:100%; padding:0 14px; cursor:pointer;
        font-size:12px; font-family:inherit;
        display:flex; align-items:center; gap:5px;
        white-space:nowrap; transition:background .15s; }
      #__rec_hover_bar__ button:hover { background:#f4f4f5; color:#10b981; }
      #__rec_hover_bar__ button:last-child { border-right:none; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  const bar = document.createElement('div');
  bar.id = '__rec_hover_bar__';
  bar.innerHTML = `
    <div class="logo"><span>e</span></div>
    <button id="__rb_rec__">🎥 录制</button>
    <button id="__rb_pip__">📺 小窗口</button>
    <button id="__rb_close__" style="color:#aaa;">✕</button>
  `;

  bar.addEventListener('mouseenter', () => clearTimeout(CS.leaveTimer));
  bar.addEventListener('mouseleave', () => { CS.leaveTimer = setTimeout(destroyHoverBar, 400); });

  bar.querySelector('#__rb_rec__').addEventListener('click', (e) => {
    e.stopPropagation(); onClickRecord();
  });
  bar.querySelector('#__rb_pip__').addEventListener('click', (e) => {
    e.stopPropagation(); togglePiP(video);
  });
  bar.querySelector('#__rb_close__').addEventListener('click', (e) => {
    e.stopPropagation(); destroyHoverBar();
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
  const barW = CS.hoverBar.offsetWidth || 220;
  let left   = rect.left + rect.width / 2 - barW / 2;
  left       = Math.max(rect.left, Math.min(left, window.innerWidth - barW - 4));
  CS.hoverBar.style.top  = Math.max(0, rect.top) + 'px';
  CS.hoverBar.style.left = left + 'px';
}

function destroyHoverBar() {
  clearTimeout(CS.leaveTimer);
  if (CS.hoverRAF) { cancelAnimationFrame(CS.hoverRAF); CS.hoverRAF = null; }
  if (CS.hoverBar) { CS.hoverBar.remove(); CS.hoverBar = null; }
  CS.hoverVideo = null;
}

// C-05: 不自动开录
function onClickRecord() {
  destroyHoverBar();
  showInPageToast('🎬 正在打开录制窗口，请点击红色按钮开始录制...');
  chrome.runtime.sendMessage({
    action: 'startRecordFromContent',
    config: {
      sysAudio  : true, micAudio: false, noAudio: false,
      format    : 'mp4', vbps: 6000000, abps: 192000,
      fps       : 30, filePrefix: '直播录制', quality: 'hd',
      autoStart : false,  // ★ 打开窗口，不自动开录
    },
  }, () => { void chrome.runtime.lastError; });
}

async function togglePiP(video) {
  try {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      showInPageToast('🪟 已退出小窗口');
    } else {
      await video.requestPictureInPicture();
      showInPageToast('🪟 小窗口已开启');
    }
  } catch (e) {
    showInPageToast('❌ 小窗口不可用: ' + e.message);
  }
}

function showInPageToast(msg, ms) {
  ms = ms || 2500;
  let el = document.getElementById('__rec_page_toast__');
  if (!el) {
    el = document.createElement('div');
    el.id = '__rec_page_toast__';
    el.style.cssText = [
      'position:fixed','bottom:80px','left:50%',
      'transform:translateX(-50%)',
      'background:rgba(16,16,16,.94)',
      'border:1px solid #555','color:#fff',
      'padding:10px 22px','border-radius:8px',
      'font-size:13px',
      'font-family:Microsoft YaHei,Arial,sans-serif',
      'z-index:2147483647','pointer-events:none',
      'white-space:nowrap',
      'box-shadow:0 4px 18px rgba(0,0,0,.45)',
      'transition:opacity .3s','opacity:0',
    ].join(';');
    document.documentElement.appendChild(el);
  }
  el.textContent   = msg;
  el.style.opacity = '1';
  clearTimeout(el.__t);
  el.__t = setTimeout(() => { el.style.opacity = '0'; }, ms);
}

// ── 网页悬浮录制控制条 ────────────────────────────────────────
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
    'position:fixed', posMap[position] || posMap['top-right'],
    'z-index:2147483647',
    'background:rgba(13,13,13,.94)',
    'border:1.5px solid #e53935','border-radius:10px',
    'padding:8px 14px','display:flex','align-items:center','gap:10px',
    'font-family:Microsoft YaHei,Arial,sans-serif',
    'font-size:13px','color:#fff',
    'box-shadow:0 4px 24px rgba(229,57,53,.4)',
    'user-select:none','min-width:220px',
    'backdrop-filter:blur(10px)','cursor:move',
  ].join(';');

  bar.innerHTML = `
    <style>@keyframes _rfb{0%,100%{opacity:1}50%{opacity:.15}}</style>
    <span style="width:10px;height:10px;border-radius:50%;background:#e53935;
      flex-shrink:0;display:inline-block;animation:_rfb 1s infinite;"></span>
    <span id="_rf_time" style="font-family:'Courier New',monospace;
      font-size:14px;font-weight:bold;color:#ff6666;letter-spacing:1px;flex:1;">00:00:00</span>
    <button id="_rf_pause" style="background:rgba(255,152,0,.15);border:1px solid #ff9800;
      color:#ff9800;padding:4px 10px;border-radius:5px;cursor:pointer;
      font-size:11px;font-family:inherit;">⏸ 暂停</button>
    <button id="_rf_stop" style="background:rgba(229,57,53,.15);border:1px solid #e53935;
      color:#e53935;padding:4px 10px;border-radius:5px;cursor:pointer;
      font-size:11px;font-family:inherit;">⏹ 停止</button>
    <button id="_rf_close" style="background:transparent;border:none;
      color:#555;cursor:pointer;font-size:18px;line-height:1;padding:0 2px;">×</button>
  `;

  document.documentElement.appendChild(bar);
  CS.floatBar    = bar;
  CS.floatSec    = 0;
  CS.floatPaused = false;

  bar.querySelector('#_rf_pause').addEventListener('click', () => {
    CS.floatPaused = !CS.floatPaused;
    bar.querySelector('#_rf_pause').textContent = CS.floatPaused ? '▶ 继续' : '⏸ 暂停';
    chrome.runtime.sendMessage(
      { action: CS.floatPaused ? 'pauseRecording' : 'resumeRecording', _target:'recorder' },
      () => { void chrome.runtime.lastError; }
    );
  });

  bar.querySelector('#_rf_stop').addEventListener('click', () => {
    chrome.runtime.sendMessage(
      { action:'stopRecording', _target:'recorder' },
      () => { void chrome.runtime.lastError; }
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
    drag = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    el.style.left = ox + e.clientX - sx + 'px';
    el.style.top  = oy + e.clientY - sy + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none';
  });
  document.addEventListener('mouseup', () => { drag = false; });
}

// ── 区域选择 ─────────────────────────────────────────────────
function startRegion() {
  if (CS.regionActive) return;
  CS.regionActive = true;
  const overlay = document.createElement('div');
  overlay.style.cssText = ['position:fixed','inset:0','z-index:2147483646','background:rgba(0,0,0,.32)','cursor:crosshair'].join(';');
  const tip = document.createElement('div');
  tip.style.cssText = ['position:fixed','top:50%','left:50%','transform:translate(-50%,-50%)','background:rgba(229,57,53,.93)','color:#fff','padding:12px 28px','border-radius:8px','font-size:15px','font-family:Microsoft YaHei,Arial','pointer-events:none','user-select:none','white-space:nowrap'].join(';');
  tip.textContent = '🔲 拖拽选择录制区域 | Esc 取消';
  overlay.appendChild(tip);
  document.documentElement.appendChild(overlay);
  let startX, startY, selBox = null;
  const onDown = (e) => {
    tip.style.display = 'none'; startX = e.clientX; startY = e.clientY;
    selBox = document.createElement('div');
    selBox.style.cssText = ['position:fixed','border:2px solid #e53935','background:rgba(229,57,53,.08)','pointer-events:none','z-index:2147483647'].join(';');
    document.documentElement.appendChild(selBox);
  };
  const onMove = (e) => {
    if (!selBox) return;
    selBox.style.left   = Math.min(e.clientX,startX) + 'px';
    selBox.style.top    = Math.min(e.clientY,startY) + 'px';
    selBox.style.width  = Math.abs(e.clientX-startX) + 'px';
    selBox.style.height = Math.abs(e.clientY-startY) + 'px';
  };
  const onUp = (e) => {
    const w = Math.abs(e.clientX-startX), h = Math.abs(e.clientY-startY);
    if (selBox) { selBox.remove(); selBox = null; }
    cleanup();
    if (w > 10 && h > 10) showInPageToast('🔲 已选区域: ' + w + '×' + h);
  };
  const onKey = (e) => { if (e.key !== 'Escape') return; if (selBox) { selBox.remove(); selBox = null; } cleanup(); };
  function cleanup() {
    CS.regionActive = false; overlay.remove();
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

function stopRegion() { CS.regionActive = false; }

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVideoDetection);
} else {
  initVideoDetection();
}
