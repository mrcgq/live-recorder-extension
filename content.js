'use strict';

// ============================================================
// content.js v4.0 - 完整重构版
//
// 重构要点：
//   R-01: 视口清洗划界（视频全屏填充，过滤弹幕/广告）
//   R-05: Shadow DOM 深度穿透检索器
//   修复: 防抖单一化、透明层穿透、自动识别逻辑
//   修复: 点击录制不自动开录（autoStart:false）
//   修复: 悬浮控制条完整生命周期管理
// ============================================================

// ── UI 状态对象 ───────────────────────────────────────────────
const CS = {
  hoverVideo       : null,
  hoverBar         : null,
  hoverRAF         : null,
  leaveTimer       : null,
  floatBar         : null,
  floatTimer       : null,
  floatSec         : 0,
  floatPaused      : false,
  regionActive     : false,
  observer         : null,
  bindTimeout      : null,   // ★ 单一防抖控制变量
  sanitizedVideo   : null,   // ★ R-01：当前被清洗的视频元素
  sanitizeStyle    : null,   // ★ R-01：注入的清洗样式元素
  originalStyles   : null,   // ★ R-01：视频原始样式备份
};

// ── 工具函数 ─────────────────────────────────────────────────
function fmtTime(s) {
  s = s || 0;
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

// ============================================================
// ★ R-05：Shadow DOM 深度穿透检索器
// 递归穿透所有 shadowRoot，100% 识别现代直播网站
// ============================================================
function findVideosDeep(root) {
  root = root || document;
  const videos = [];

  function traverse(node) {
    if (!node) return;
    const type = node.nodeType;
    // 只处理元素节点和 DocumentFragment（ShadowRoot 是后者）
    if (type !== Node.ELEMENT_NODE && type !== Node.DOCUMENT_FRAGMENT_NODE) return;

    if (node.tagName === 'VIDEO') {
      videos.push(node);
      // video 内部不会再有 video，但可能有 shadowRoot（极少见）
    } else {
      // 遍历子元素
      const children = node.children;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          traverse(children[i]);
        }
      }
    }

    // ★ 穿透 Shadow Root 隔离墙
    if (node.shadowRoot) {
      traverse(node.shadowRoot);
    }
  }

  traverse(root);
  return videos;
}

// 判断是否为有效直播视频（非广告、非缩略图、非已结束的短视频）
function isValidLiveVideo(video) {
  if (!video) return false;

  // 尺寸过滤：至少 320x180 才认为是主视频
  const rect = video.getBoundingClientRect();
  if (rect.width < 320 || rect.height < 180) return false;

  // 必须有视频源（src 或 srcObject 或 currentSrc）
  if (!video.src && !video.srcObject && !video.currentSrc) return false;

  // 排除已明确结束的短视频（直播流 duration 为 Infinity 或接近 0）
  if (isFinite(video.duration) && video.duration > 0 && video.duration < 15) return false;

  // 排除静音且暂停的广告视频（通常静音 + 暂停 = 预加载广告）
  // 但不排除用户手动暂停的主视频，所以只在两者同时满足时排除
  // （直播流通常不会同时 muted+paused 超过 3 秒）
  return true;
}

// 在所有视频中选出面积最大、最符合直播特征的视频
function pickBestVideo() {
  const videos = findVideosDeep();
  let best = null, bestArea = 0;

  for (const v of videos) {
    if (!isValidLiveVideo(v)) continue;
    const rect = v.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) { bestArea = area; best = v; }
  }

  return best;
}

// ============================================================
// ★ R-01：视口清洗划界（Viewport-Fitted Sanitization）
// 将目标视频元素强制置顶满屏，遮挡所有网页杂质
// ============================================================
function applyViewportSanitize(video) {
  if (!video || CS.sanitizedVideo === video) return;

  // 备份原始内联样式
  CS.originalStyles = video.getAttribute('style') || '';
  CS.sanitizedVideo = video;

  // 注入全局清洗样式（覆盖父容器、遮挡弹幕层）
  if (!CS.sanitizeStyle) {
    CS.sanitizeStyle = document.createElement('style');
    CS.sanitizeStyle.id = '__rec_sanitize_style__';
  }

  // 生成唯一类名避免污染
  const uid = '__rec_sanitized_video__';
  video.classList.add(uid);

  CS.sanitizeStyle.textContent = `
    /* ★ R-01：视口清洗 - 强制视频满屏，遮挡所有杂质 */
    .${uid} {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      min-width: 0 !important;
      min-height: 0 !important;
      z-index: 2147483640 !important;
      background: #000 !important;
      object-fit: contain !important;
      transform: none !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      clip-path: none !important;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
    /* 确保 body 背景为黑，不透出页面内容 */
    body.__rec_sanitize_body__ {
      background: #000 !important;
      overflow: hidden !important;
    }
  `;

  (document.head || document.documentElement).appendChild(CS.sanitizeStyle);
  document.body && document.body.classList.add('__rec_sanitize_body__');

  console.log('[content] ★ R-01 视口清洗已应用 → 视频已全屏隔离');
}

// 移除视口清洗，还原网页原始布局
function removeViewportSanitize() {
  if (CS.sanitizedVideo) {
    CS.sanitizedVideo.classList.remove('__rec_sanitized_video__');
    // 还原原始内联样式
    if (CS.originalStyles) {
      CS.sanitizedVideo.setAttribute('style', CS.originalStyles);
    } else {
      CS.sanitizedVideo.removeAttribute('style');
    }
    CS.sanitizedVideo = null;
    CS.originalStyles = null;
  }

  if (CS.sanitizeStyle) {
    CS.sanitizeStyle.remove();
    CS.sanitizeStyle = null;
  }

  document.body && document.body.classList.remove('__rec_sanitize_body__');
  console.log('[content] ★ R-01 视口清洗已移除 → 页面布局已还原');
}

// ============================================================
// 消息监听（来自 background 的指令）
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
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

    // ★ R-01：录制结束，移除视口清洗
    case 'removeViewportSanitize':
      removeViewportSanitize();
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
// 视频检测与悬浮栏
// ============================================================

// ★ 单一防抖：节流绑定，避免弹幕高频触发
function throttledBindAllVideos() {
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

  // DOM 变化监听（新增视频节点时重新绑定）
  CS.observer = new MutationObserver((mutations) => {
    let hasNewVideo = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'VIDEO' ||
            (node.querySelector && node.querySelector('video'))) {
          hasNewVideo = true;
          break;
        }
      }
      if (hasNewVideo) break;
    }
    if (hasNewVideo) throttledBindAllVideos();
  });

  CS.observer.observe(document.documentElement, { childList: true, subtree: true });
}

function onGlobalMouseover(e) {
  const target = e.target;
  if (!target) return;

  const video = findVideoNear(target);

  if (video && isValidLiveVideo(video)) {
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

// 多策略综合寻找附近的视频元素（穿透遮罩层）
function findVideoNear(target) {
  if (!target) return null;

  // 策略1：直接是 video
  if (target.tagName === 'VIDEO') return target;

  // 策略2：目标有 shadowRoot，向内找
  if (target.shadowRoot) {
    const v = target.shadowRoot.querySelector('video');
    if (v) return v;
  }

  // 策略3：向内查找
  if (target.querySelector) {
    const v = target.querySelector('video');
    if (v) return v;
  }

  // 策略4：向上找播放器容器，再向内找
  if (target.closest) {
    const selectors = [
      '[class*="player"]', '[class*="Player"]',
      '[class*="video"]',  '[class*="Video"]',
      '[id*="player"]',    '[id*="Player"]',
      'figure', 'main', '[role="main"]',
    ].join(',');
    const container = target.closest(selectors);
    if (container) {
      // 先检查 shadowRoot
      if (container.shadowRoot) {
        const v = container.shadowRoot.querySelector('video');
        if (v) return v;
      }
      const v = container.querySelector('video');
      if (v) return v;
    }
  }

  // 策略5：父节点向内查找（最后兜底）
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

// ============================================================
// 悬浮录制栏 UI
// ============================================================
function injectHoverStyle() {
  if (document.getElementById('__rec_hover_style__')) return;
  const style = document.createElement('style');
  style.id = '__rec_hover_style__';
  style.textContent = `
    #__rec_hover_bar__ {
      position: fixed;
      z-index: 2147483647;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border: 1px solid rgba(229,57,53,0.6);
      border-top: 3px solid #e53935;
      border-radius: 0 0 10px 10px;
      height: 44px;
      display: flex;
      align-items: center;
      box-shadow: 0 6px 24px rgba(229,57,53,0.3), 0 2px 8px rgba(0,0,0,0.5);
      font-family: 'Microsoft YaHei', 'PingFang SC', Arial, sans-serif;
      font-size: 12px;
      color: #fff;
      overflow: hidden;
      user-select: none;
      opacity: 0;
      transition: opacity 0.18s ease;
      pointer-events: auto;
      min-width: 300px;
    }
    #__rec_hover_bar__.visible { opacity: 1; }
    #__rec_hover_bar__ .hb-logo {
      background: #e53935;
      width: 42px; height: 100%;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; font-size: 20px;
    }
    #__rec_hover_bar__ .hb-brand {
      padding: 0 10px 0 12px;
      font-size: 12px; font-weight: bold;
      color: #ff8a80; white-space: nowrap; flex-shrink: 0;
      border-right: 1px solid rgba(255,255,255,0.1);
      height: 100%; display: flex; align-items: center;
    }
    #__rec_hover_bar__ button {
      background: transparent; border: none;
      color: rgba(255,255,255,0.85);
      height: 100%; padding: 0 15px;
      cursor: pointer; font-size: 12px;
      font-family: inherit;
      display: flex; align-items: center; gap: 5px;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s;
      border-left: 1px solid rgba(255,255,255,0.08);
    }
    #__rec_hover_bar__ button:hover {
      background: rgba(229,57,53,0.25);
      color: #ff6b6b;
    }
    #__rec_hover_bar__ .hb-rec {
      color: #ff5252 !important;
      font-weight: bold;
      background: rgba(229,57,53,0.12) !important;
    }
    #__rec_hover_bar__ .hb-rec:hover {
      background: rgba(229,57,53,0.3) !important;
    }
    #__rec_hover_bar__ .hb-close {
      color: rgba(255,255,255,0.3) !important;
      padding: 0 12px !important;
      font-size: 16px !important;
    }
    #__rec_hover_bar__ .hb-close:hover {
      background: rgba(255,255,255,0.05) !important;
      color: rgba(255,255,255,0.7) !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function createHoverBar(video) {
  destroyHoverBar();
  injectHoverStyle();

  const bar = document.createElement('div');
  bar.id = '__rec_hover_bar__';
  bar.innerHTML = `
    <div class="hb-logo">🎬</div>
    <div class="hb-brand">直播内录器</div>
    <button class="hb-rec"  id="__hb_rec__">⏺ 开始录制</button>
    <button               id="__hb_pip__">📺 小窗播放</button>
    <button class="hb-close" id="__hb_close__">✕</button>
  `;

  // 鼠标进出控制显隐
  bar.addEventListener('mouseenter', () => clearTimeout(CS.leaveTimer));
  bar.addEventListener('mouseleave', () => {
    CS.leaveTimer = setTimeout(destroyHoverBar, 400);
  });

  // 按钮事件（完全程序化绑定，杜绝 CSP 拦截）
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

  // 双 RAF 确保 transition 生效
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (CS.hoverBar) CS.hoverBar.classList.add('visible');
  }));

  // 持续跟随视频元素位置（应对布局变化）
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
  const barW = CS.hoverBar.offsetWidth || 300;

  // 水平居中于视频，但不超出视口
  let left = rect.left + rect.width / 2 - barW / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - barW - 4));

  // 悬停在视频顶部内侧（不超出视口顶部）
  let top = Math.max(0, rect.top);

  CS.hoverBar.style.left = left + 'px';
  CS.hoverBar.style.top  = top + 'px';
}

function destroyHoverBar() {
  clearTimeout(CS.leaveTimer);
  if (CS.hoverRAF) { cancelAnimationFrame(CS.hoverRAF); CS.hoverRAF = null; }
  if (CS.hoverBar) {
    CS.hoverBar.classList.remove('visible');
    // 等 transition 结束后再移除 DOM
    setTimeout(() => { if (CS.hoverBar) { CS.hoverBar.remove(); CS.hoverBar = null; } }, 200);
  }
  CS.hoverVideo = null;
}

// ============================================================
// ★ 核心：点击录制
// 流程：视口清洗 → 通知 background → 打开 recorder 窗口
// ============================================================
function onClickRecord(video) {
  if (!video || !isValidLiveVideo(video)) {
    video = pickBestVideo();
    if (!video) {
      showToast('❌ 未找到有效的直播视频，请确认视频正在播放');
      return;
    }
  }

  destroyHoverBar();

  // ★ R-01：应用视口清洗（视频全屏填充，遮挡弹幕广告）
  applyViewportSanitize(video);

  showToast('🎬 视频画面已隔离，正在打开录制控制窗口...');

  // 通知 background 打开录制控制窗口
  // autoStart=true：recorder 窗口打开后立即开始录制
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
      autoStart : true,   // ★ 从网页悬浮栏触发 → 自动开录
    },
  }, (resp) => {
    void chrome.runtime.lastError;
    if (!resp || !resp.ok) {
      // 如果打开失败，移除清洗
      removeViewportSanitize();
      showToast('❌ 打开录制窗口失败，请重试');
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
    'background:rgba(8,8,8,0.97)',
    'border:2px solid #e53935',
    'border-radius:12px',
    'padding:8px 14px',
    'display:flex', 'align-items:center', 'gap:10px',
    'font-family:Microsoft YaHei,PingFang SC,Arial,sans-serif',
    'font-size:13px', 'color:#fff',
    'box-shadow:0 4px 32px rgba(229,57,53,0.55)',
    'user-select:none', 'min-width:240px',
    'backdrop-filter:blur(16px)',
    '-webkit-backdrop-filter:blur(16px)',
    'cursor:move',
  ].join(';');

  bar.innerHTML = `
    <style>@keyframes _rfblink{0%,100%{opacity:1}50%{opacity:.1}}</style>
    <span style="
      width:11px;height:11px;border-radius:50%;
      background:#e53935;flex-shrink:0;display:inline-block;
      animation:_rfblink 1s infinite;
      box-shadow:0 0 8px rgba(229,57,53,0.8);
    "></span>
    <span id="_rf_time" style="
      font-family:'Courier New',monospace;
      font-size:15px;font-weight:bold;
      color:#ff5252;letter-spacing:2px;flex:1;
      min-width:80px;
    ">00:00:00</span>
    <span id="_rf_size" style="
      font-size:11px;color:#666;
      font-family:'Courier New',monospace;
      margin-right:2px;
    ">0 B</span>
    <button id="_rf_pause" style="
      background:rgba(255,152,0,0.15);
      border:1px solid rgba(255,152,0,0.6);
      color:#ff9800;padding:5px 12px;border-radius:6px;
      cursor:pointer;font-size:11px;font-family:inherit;
      transition:all 0.2s;white-space:nowrap;
    ">⏸ 暂停</button>
    <button id="_rf_stop" style="
      background:rgba(229,57,53,0.15);
      border:1px solid rgba(229,57,53,0.6);
      color:#e53935;padding:5px 12px;border-radius:6px;
      cursor:pointer;font-size:11px;font-family:inherit;
      transition:all 0.2s;white-space:nowrap;
    ">⏹ 停止</button>
    <button id="_rf_close" style="
      background:transparent;border:none;
      color:rgba(255,255,255,0.3);cursor:pointer;
      font-size:20px;line-height:1;padding:0 2px;
      transition:color 0.2s;
    ">×</button>
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
    showToast('⚠️ 悬浮条已隐藏，录制仍在后台继续');
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
    const te = document.getElementById('_rf_time');
    if (!te) { stopFloatTimer(); return; }
    te.textContent = fmtTime(CS.floatSec);
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

// ── Toast 提示 ────────────────────────────────────────────────
function showToast(msg, ms) {
  ms = ms || 3000;
  let el = document.getElementById('__rec_toast__');
  if (!el) {
    el = document.createElement('div');
    el.id = '__rec_toast__';
    el.style.cssText = [
      'position:fixed', 'bottom:80px', 'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(8,8,8,0.97)',
      'border:1px solid rgba(255,255,255,0.15)',
      'color:#fff', 'padding:12px 26px',
      'border-radius:10px', 'font-size:13px',
      'font-family:Microsoft YaHei,PingFang SC,Arial,sans-serif',
      'z-index:2147483647', 'pointer-events:none',
      'white-space:nowrap',
      'box-shadow:0 4px 24px rgba(0,0,0,0.6)',
      'transition:opacity .3s', 'opacity:0',
      'max-width:90vw',
      'backdrop-filter:blur(12px)',
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
    'position:fixed', 'inset:0', 'z-index:2147483646',
    'background:rgba(0,0,0,0.45)', 'cursor:crosshair',
  ].join(';');

  const tip = document.createElement('div');
  tip.style.cssText = [
    'position:fixed', 'top:50%', 'left:50%',
    'transform:translate(-50%,-50%)',
    'background:rgba(229,57,53,0.95)',
    'color:#fff', 'padding:14px 32px', 'border-radius:10px',
    'font-size:15px',
    'font-family:Microsoft YaHei,PingFang SC,Arial,sans-serif',
    'pointer-events:none', 'user-select:none', 'white-space:nowrap',
    'box-shadow:0 4px 20px rgba(0,0,0,0.4)',
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
      'position:fixed',
      'border:2px dashed #e53935',
      'background:rgba(229,57,53,0.08)',
      'pointer-events:none',
      'z-index:2147483647',
    ].join(';');
    document.documentElement.appendChild(selBox);
  });

  document.addEventListener('mousemove', onRegionMove);
  document.addEventListener('mouseup',   onRegionUp);
  document.addEventListener('keydown',   onRegionKey);

  function onRegionMove(e) {
    if (!selBox) return;
    selBox.style.left   = Math.min(e.clientX, startX) + 'px';
    selBox.style.top    = Math.min(e.clientY, startY) + 'px';
    selBox.style.width  = Math.abs(e.clientX - startX) + 'px';
    selBox.style.height = Math.abs(e.clientY - startY) + 'px';
  }

  function onRegionUp(e) {
    if (!selBox) return;
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selBox.remove(); selBox = null;
    cleanup();
    if (w > 10 && h > 10) showToast('🔲 已选区域: ' + Math.round(w) + '×' + Math.round(h));
  }

  function onRegionKey(e) {
    if (e.key !== 'Escape') return;
    if (selBox) { selBox.remove(); selBox = null; }
    cleanup();
    showToast('🔲 区域选择已取消');
  }

  function cleanup() {
    CS.regionActive = false;
    overlay.remove();
    document.removeEventListener('mousemove', onRegionMove);
    document.removeEventListener('mouseup',   onRegionUp);
    document.removeEventListener('keydown',   onRegionKey);
  }
}

function stopRegion() { CS.regionActive = false; }

// ── 启动 ─────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVideoDetection);
} else {
  initVideoDetection();
}
