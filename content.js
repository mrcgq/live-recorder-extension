'use strict';

// ============================================================
// content.js v4.0 - 纯 UI 层（数据面已完全迁出）
//
// 职责（仅限于此，不做任何录制）：
//   1. Shadow DOM 穿透，识别直播视频，显示悬浮录制栏
//   2. 视口清洗划界（applyViewportSanitize）
//      将目标视频强制铺满全屏，过滤弹幕/广告
//      tabCapture 捕获的 Tab 画面因此只含纯净视频
//   3. 网页悬浮录制控制条（showFloat / updateFloat）
//   4. 转发用户操作指令给 background/recorder
//
// 不在此处做的事（已迁回 recorder.js）：
//   ✗ MediaRecorder
//   ✗ captureStream()
//   ✗ getUserMedia()
//   ✗ AudioContext 录制
// ============================================================

// ── 状态 ─────────────────────────────────────────────────────
const CS = {
  hoverVideo     : null,
  hoverBar       : null,
  hoverRAF       : null,
  leaveTimer     : null,
  floatBar       : null,
  floatTimer     : null,
  floatSec       : 0,
  floatPaused    : false,
  regionActive   : false,
  observer       : null,
  bindTimeout    : null,
  sanitizedVideo : null,   // 当前被清洗的视频元素
  sanitizeStyle  : null,   // 注入的清洗样式
  origStyle      : null,   // 视频原始 style 备份
};

function fmtTime(s) {
  s = s || 0;
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

// ============================================================
// ★ 视口清洗划界（R-01）
// 将目标视频强制 fixed 满屏，遮挡弹幕/广告/聊天框
// tabCapture 捕获整个 Tab，但因为视口只剩视频，录制内容纯净
// ============================================================
function applyViewportSanitize() {
  // 自动选取页面中最大的有效视频
  const video = pickBestVideo();
  if (!video) {
    console.warn('[content] 视口清洗：未找到有效视频');
    return;
  }

  // 避免重复应用
  if (CS.sanitizedVideo === video) return;

  // 备份原始 style
  CS.origStyle      = video.getAttribute('style') || '';
  CS.sanitizedVideo = video;

  // 注入清洗样式
  if (!CS.sanitizeStyle) {
    CS.sanitizeStyle    = document.createElement('style');
    CS.sanitizeStyle.id = '__rec_sanitize__';
  }

  const cls = '__rec_sanitized_el__';
  video.classList.add(cls);

  CS.sanitizeStyle.textContent = `
    /* ★ R-01 视口清洗：视频全屏铺满，遮挡所有网页杂质 */
    .${cls} {
      position   : fixed !important;
      top        : 0 !important;
      left       : 0 !important;
      width      : 100vw !important;
      height     : 100vh !important;
      max-width  : none !important;
      max-height : none !important;
      z-index    : 2147483640 !important;
      background : #000 !important;
      object-fit : contain !important;
      transform  : none !important;
      margin     : 0 !important;
      padding    : 0 !important;
      border     : none !important;
      border-radius : 0 !important;
      box-shadow : none !important;
      opacity    : 1 !important;
      visibility : visible !important;
    }
    /* 页面背景变黑，防止页面内容透出 */
    body { background : #000 !important; overflow : hidden !important; }
  `;

  (document.head || document.documentElement).appendChild(CS.sanitizeStyle);
  console.log('[content] ★ R-01 视口清洗已应用');
}

// 录制结束后还原网页布局
function removeViewportSanitize() {
  if (CS.sanitizedVideo) {
    CS.sanitizedVideo.classList.remove('__rec_sanitized_el__');
    if (CS.origStyle) {
      CS.sanitizedVideo.setAttribute('style', CS.origStyle);
    } else {
      CS.sanitizedVideo.removeAttribute('style');
    }
    CS.sanitizedVideo = null;
    CS.origStyle      = null;
  }
  if (CS.sanitizeStyle) {
    CS.sanitizeStyle.remove();
    CS.sanitizeStyle = null;
  }
  console.log('[content] ★ R-01 视口清洗已移除，页面已还原');
}

// ============================================================
// ★ Shadow DOM 深度穿透检索（R-05）
// ============================================================
function findVideosDeep(root) {
  root = root || document;
  const videos = [];

  function traverse(node) {
    if (!node) return;
    const t = node.nodeType;
    if (t !== Node.ELEMENT_NODE && t !== Node.DOCUMENT_FRAGMENT_NODE) return;

    if (node.tagName === 'VIDEO') {
      videos.push(node);
    } else {
      const ch = node.children;
      if (ch) for (let i = 0; i < ch.length; i++) traverse(ch[i]);
    }

    // ★ 穿透 Shadow Root
    if (node.shadowRoot) traverse(node.shadowRoot);
  }

  traverse(root);
  return videos;
}

// 判断是否为有效直播视频
function isValidVideo(video) {
  if (!video) return false;
  const rect = video.getBoundingClientRect();
  if (rect.width < 320 || rect.height < 180) return false;
  if (!video.src && !video.srcObject && !video.currentSrc) return false;
  // 排除已知时长很短的广告视频
  if (isFinite(video.duration) && video.duration > 0 && video.duration < 15) return false;
  return true;
}

// 选出面积最大的有效视频
function pickBestVideo() {
  let best = null, bestArea = 0;
  for (const v of findVideosDeep()) {
    if (!isValidVideo(v)) continue;
    const r    = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) { bestArea = area; best = v; }
  }
  return best;
}

// ============================================================
// 消息监听
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {

    // ★ R-01：background 通知执行视口清洗
    case 'applyViewportSanitize':
      applyViewportSanitize();
      sendResponse({ ok: true });
      break;

    // ★ R-01：录制结束，还原页面
    case 'removeViewportSanitize':
      removeViewportSanitize();
      sendResponse({ ok: true });
      break;

    case 'showFloat':
      showFloat(msg.position || 'top-right');
      sendResponse({ ok: true });
      break;

    case 'removeFloat':
      removeFloat();
      sendResponse({ ok: true });
      break;

    case 'updateFloat':
      updateFloat(msg.paused, msg.time);
      sendResponse({ ok: true });
      break;

    case 'enableRegionSelect':
      startRegion();
      sendResponse({ ok: true });
      break;

    case 'disableRegionSelect':
      stopRegion();
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false });
  }
  return true;
});

// ============================================================
// 视频检测 + 悬浮录制栏
// ============================================================

// 单一防抖绑定
function throttledBindAll() {
  if (CS.bindTimeout) return;
  CS.bindTimeout = setTimeout(() => {
    CS.bindTimeout = null;
    findVideosDeep().forEach(bindVideo);
  }, 800);
}

function initVideoDetection() {
  findVideosDeep().forEach(bindVideo);

  // 全局 mouseover：穿透透明遮罩层
  document.addEventListener('mouseover', onGlobalMouseover, { passive: true });

  // DOM 变化监听
  CS.observer = new MutationObserver((mutations) => {
    let hasVideo = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'VIDEO' ||
            (node.querySelector && node.querySelector('video'))) {
          hasVideo = true; break;
        }
      }
      if (hasVideo) break;
    }
    if (hasVideo) throttledBindAll();
  });
  CS.observer.observe(document.documentElement, { childList: true, subtree: true });
}

function onGlobalMouseover(e) {
  const target = e.target;
  if (!target) return;

  const video = findVideoNear(target);
  if (video && isValidVideo(video)) {
    clearTimeout(CS.leaveTimer);
    if (CS.hoverVideo !== video) {
      CS.hoverVideo = video;
      createHoverBar(video);
    }
  } else {
    if (CS.hoverBar && !CS.hoverBar.contains(target)) {
      CS.leaveTimer = setTimeout(destroyHoverBar, 600);
    }
  }
}

// 多策略寻找附近视频（穿透透明遮罩）
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
    const c = target.closest([
      '[class*="player"]','[class*="Player"]',
      '[class*="video"]', '[class*="Video"]',
      '[id*="player"]',  '[id*="Player"]',
      'figure','main',
    ].join(','));
    if (c) {
      const v = (c.shadowRoot && c.shadowRoot.querySelector('video')) || c.querySelector('video');
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

// ── 悬浮录制栏样式注入 ───────────────────────────────────────
function injectHoverStyle() {
  if (document.getElementById('__rec_hover_style__')) return;
  const s = document.createElement('style');
  s.id    = '__rec_hover_style__';
  s.textContent = `
    #__rec_hover_bar__ {
      position:fixed; z-index:2147483647;
      background:linear-gradient(135deg,#1a1a2e,#16213e);
      border:1px solid rgba(229,57,53,.6);
      border-top:3px solid #e53935;
      border-radius:0 0 10px 10px; height:44px;
      display:flex; align-items:center;
      box-shadow:0 6px 24px rgba(229,57,53,.3),0 2px 8px rgba(0,0,0,.5);
      font-family:'Microsoft YaHei','PingFang SC',Arial,sans-serif;
      font-size:12px; color:#fff; overflow:hidden;
      user-select:none; opacity:0;
      transition:opacity .18s ease;
      pointer-events:auto; min-width:280px;
    }
    #__rec_hover_bar__.show { opacity:1; }
    #__rec_hover_bar__ .hb-logo {
      background:#e53935; width:42px; height:100%;
      display:flex; align-items:center; justify-content:center;
      flex-shrink:0; font-size:20px;
    }
    #__rec_hover_bar__ .hb-brand {
      padding:0 10px 0 12px; font-size:12px;
      font-weight:bold; color:#ff8a80; white-space:nowrap;
      flex-shrink:0; height:100%;
      display:flex; align-items:center;
      border-right:1px solid rgba(255,255,255,.1);
    }
    #__rec_hover_bar__ button {
      background:transparent; border:none;
      color:rgba(255,255,255,.85); height:100%;
      padding:0 15px; cursor:pointer; font-size:12px;
      font-family:inherit; display:flex; align-items:center;
      gap:5px; white-space:nowrap;
      transition:background .15s,color .15s;
      border-left:1px solid rgba(255,255,255,.08);
    }
    #__rec_hover_bar__ button:hover {
      background:rgba(229,57,53,.25); color:#ff6b6b;
    }
    #__rec_hover_bar__ .hb-rec {
      color:#ff5252!important; font-weight:bold;
      background:rgba(229,57,53,.12)!important;
    }
    #__rec_hover_bar__ .hb-rec:hover {
      background:rgba(229,57,53,.3)!important;
    }
    #__rec_hover_bar__ .hb-close {
      color:rgba(255,255,255,.3)!important;
      padding:0 12px!important; font-size:16px!important;
    }
  `;
  (document.head || document.documentElement).appendChild(s);
}

function createHoverBar(video) {
  destroyHoverBar();
  injectHoverStyle();

  const bar = document.createElement('div');
  bar.id = '__rec_hover_bar__';
  bar.innerHTML = `
    <div class="hb-logo">🎬</div>
    <div class="hb-brand">直播内录器</div>
    <button class="hb-rec" id="__hb_rec__">⏺ 开始录制</button>
    <button id="__hb_pip__">📺 小窗播放</button>
    <button class="hb-close" id="__hb_close__">✕</button>
  `;

  bar.addEventListener('mouseenter', () => clearTimeout(CS.leaveTimer));
  bar.addEventListener('mouseleave', () => {
    CS.leaveTimer = setTimeout(destroyHoverBar, 400);
  });

  bar.querySelector('#__hb_rec__').addEventListener('click', (e) => {
    e.stopPropagation();
    onClickRecord(video);
  });
  bar.querySelector('#__hb_pip__').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePiP(video);
  });
  bar.querySelector('#__hb_close__').addEventListener('click', (e) => {
    e.stopPropagation();
    destroyHoverBar();
  });

  document.documentElement.appendChild(bar);
  CS.hoverBar = bar;
  positionHoverBar(video);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (CS.hoverBar) CS.hoverBar.classList.add('show');
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
  const barW = CS.hoverBar.offsetWidth || 280;
  let left   = rect.left + rect.width / 2 - barW / 2;
  left       = Math.max(4, Math.min(left, window.innerWidth - barW - 4));
  CS.hoverBar.style.left = left + 'px';
  CS.hoverBar.style.top  = Math.max(0, rect.top) + 'px';
}

function destroyHoverBar() {
  clearTimeout(CS.leaveTimer);
  if (CS.hoverRAF) { cancelAnimationFrame(CS.hoverRAF); CS.hoverRAF = null; }
  if (CS.hoverBar) {
    CS.hoverBar.classList.remove('show');
    setTimeout(() => { if (CS.hoverBar) { CS.hoverBar.remove(); CS.hoverBar = null; } }, 200);
  }
  CS.hoverVideo = null;
}

// ── 点击录制：通知 background 执行完整录制启动流程 ────────────
function onClickRecord(video) {
  // 选最优视频（若传入的无效则重新选）
  const target = (video && isValidVideo(video)) ? video : pickBestVideo();
  if (!target) {
    showToast('❌ 未找到有效的直播视频，请确认视频正在播放');
    return;
  }

  destroyHoverBar();
  showToast('🎬 正在启动录制，网页即将最小化...');

  // 通知 background：
  //   background 会立即最小化宿主窗口 + 获取 streamId + 打开 recorder
  //   recorder 在自己进程内消费 streamId，画面不卡
  chrome.runtime.sendMessage({
    action: 'startRecordFromContent',
    config: {
      sysAudio  : true,
      micAudio  : false,
      noAudio   : false,
      format    : 'mp4',
      vbps      : 8000000,
      abps      : 192000,
      fps       : 30,
      filePrefix: '直播录制',
      quality   : 'hd',
    },
  }, (resp) => {
    void chrome.runtime.lastError;
    if (resp && resp.error) {
      showToast('❌ 启动失败: ' + resp.error);
    }
  });
}

// 画中画
async function togglePiP(video) {
  try {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      showToast('🪟 已退出小窗口播放');
    } else {
      await video.requestPictureInPicture();
      showToast('🪟 小窗口播放已开启');
    }
  } catch (e) {
    showToast('❌ 小窗口不可用: ' + e.message);
  }
}

// ============================================================
// 网页悬浮录制控制条
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
    'background:rgba(8,8,8,.97)',
    'border:2px solid #e53935',
    'border-radius:12px',
    'padding:8px 14px',
    'display:flex', 'align-items:center', 'gap:10px',
    'font-family:Microsoft YaHei,PingFang SC,Arial,sans-serif',
    'font-size:13px', 'color:#fff',
    'box-shadow:0 4px 32px rgba(229,57,53,.55)',
    'user-select:none', 'min-width:240px',
    'backdrop-filter:blur(16px)',
    'cursor:move',
  ].join(';');

  bar.innerHTML = `
    <style>@keyframes _rfb{0%,100%{opacity:1}50%{opacity:.1}}</style>
    <span style="width:11px;height:11px;border-radius:50%;background:#e53935;
      flex-shrink:0;display:inline-block;animation:_rfb 1s infinite;
      box-shadow:0 0 8px rgba(229,57,53,.8);"></span>
    <span id="_rf_time" style="font-family:'Courier New',monospace;
      font-size:15px;font-weight:bold;color:#ff5252;letter-spacing:2px;
      flex:1;min-width:80px;">00:00:00</span>
    <button id="_rf_pause" style="background:rgba(255,152,0,.15);
      border:1px solid rgba(255,152,0,.6);color:#ff9800;
      padding:5px 12px;border-radius:6px;cursor:pointer;
      font-size:11px;font-family:inherit;transition:all .2s;">⏸ 暂停</button>
    <button id="_rf_stop" style="background:rgba(229,57,53,.15);
      border:1px solid rgba(229,57,53,.6);color:#e53935;
      padding:5px 12px;border-radius:6px;cursor:pointer;
      font-size:11px;font-family:inherit;transition:all .2s;">⏹ 停止</button>
    <button id="_rf_close" style="background:transparent;border:none;
      color:rgba(255,255,255,.3);cursor:pointer;
      font-size:20px;line-height:1;padding:0 2px;">×</button>
  `;

  document.documentElement.appendChild(bar);
  CS.floatBar    = bar;
  CS.floatSec    = 0;
  CS.floatPaused = false;

  bar.querySelector('#_rf_pause').addEventListener('click', () => {
    CS.floatPaused = !CS.floatPaused;
    bar.querySelector('#_rf_pause').textContent = CS.floatPaused ? '▶ 继续' : '⏸ 暂停';
    chrome.runtime.sendMessage(
      { _target: 'recorder', action: CS.floatPaused ? 'pauseRecording' : 'resumeRecording' },
      () => { void chrome.runtime.lastError; }
    );
  });

  bar.querySelector('#_rf_stop').addEventListener('click', () => {
    chrome.runtime.sendMessage(
      { _target: 'recorder', action: 'stopRecording' },
      () => { void chrome.runtime.lastError; }
    );
    removeFloat();
  });

  bar.querySelector('#_rf_close').addEventListener('click', () => {
    removeFloat();
    showToast('⚠️ 控制条已隐藏，录制仍在后台继续');
  });

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

// ── 拖拽 ─────────────────────────────────────────────────────
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
    el.style.left      = Math.max(0, ox + e.clientX - sx) + 'px';
    el.style.top       = Math.max(0, oy + e.clientY - sy) + 'px';
    el.style.right     = 'auto';
    el.style.bottom    = 'auto';
    el.style.transform = 'none';
  });
  document.addEventListener('mouseup', () => { drag = false; });
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, ms) {
  ms = ms || 3000;
  let el = document.getElementById('__rec_toast__');
  if (!el) {
    el = document.createElement('div');
    el.id = '__rec_toast__';
    el.style.cssText = [
      'position:fixed', 'bottom:80px', 'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(8,8,8,.97)',
      'border:1px solid rgba(255,255,255,.15)',
      'color:#fff', 'padding:12px 26px',
      'border-radius:10px', 'font-size:13px',
      'font-family:Microsoft YaHei,PingFang SC,Arial,sans-serif',
      'z-index:2147483647', 'pointer-events:none',
      'white-space:nowrap',
      'box-shadow:0 4px 24px rgba(0,0,0,.6)',
      'transition:opacity .3s', 'opacity:0',
    ].join(';');
    document.documentElement.appendChild(el);
  }
  el.textContent   = msg;
  el.style.opacity = '1';
  clearTimeout(el.__t);
  el.__t = setTimeout(() => { el.style.opacity = '0'; }, ms);
}

// ── 区域选择 ─────────────────────────────────────────────────
function startRegion() {
  if (CS.regionActive) return;
  CS.regionActive = true;

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed','inset:0','z-index:2147483646',
    'background:rgba(0,0,0,.45)','cursor:crosshair',
  ].join(';');

  const tip = document.createElement('div');
  tip.style.cssText = [
    'position:fixed','top:50%','left:50%',
    'transform:translate(-50%,-50%)',
    'background:rgba(229,57,53,.95)',
    'color:#fff','padding:14px 32px','border-radius:10px',
    'font-size:15px',
    'font-family:Microsoft YaHei,PingFang SC,Arial,sans-serif',
    'pointer-events:none','user-select:none','white-space:nowrap',
  ].join(';');
  tip.textContent = '🔲 拖拽选择录制区域 · Esc 取消';
  overlay.appendChild(tip);
  document.documentElement.appendChild(overlay);

  let startX, startY, selBox = null;

  overlay.addEventListener('mousedown', (e) => {
    tip.style.display = 'none';
    startX = e.clientX; startY = e.clientY;
    selBox = document.createElement('div');
    selBox.style.cssText = [
      'position:fixed','border:2px dashed #e53935',
      'background:rgba(229,57,53,.08)',
      'pointer-events:none','z-index:2147483647',
    ].join(';');
    document.documentElement.appendChild(selBox);
  });

  function onMove(e) {
    if (!selBox) return;
    selBox.style.left   = Math.min(e.clientX, startX) + 'px';
    selBox.style.top    = Math.min(e.clientY, startY) + 'px';
    selBox.style.width  = Math.abs(e.clientX - startX) + 'px';
    selBox.style.height = Math.abs(e.clientY - startY) + 'px';
  }

  function onUp(e) {
    if (!selBox) return;
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selBox.remove(); selBox = null;
    cleanup();
    if (w > 10 && h > 10) showToast('🔲 已选区域: ' + Math.round(w) + '×' + Math.round(h));
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (selBox) { selBox.remove(); selBox = null; }
    cleanup();
    showToast('区域选择已取消');
  }

  function cleanup() {
    CS.regionActive = false;
    overlay.remove();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    document.removeEventListener('keydown',   onKey);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
  document.addEventListener('keydown',   onKey);
}

function stopRegion() { CS.regionActive = false; }

// ── 启动 ─────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVideoDetection);
} else {
  initVideoDetection();
}
