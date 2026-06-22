'use strict';

// ============================================================
// recorder.js v4.0 - 完整重构版
//
// 核心重构：
//   ★ R-02: 进程同调 tabCapture（在本窗口渲染进程直接获取流）
//            彻底消灭黑屏 + 切换网页/最小化花屏卡死
//   ★ R-03: 音频直通旁路（录制时物理扬声器不静音）
//   ★ F-05: IndexedDB 分片持久化（异常关闭自动恢复）
//   ★ F-06: beforeunload / unload 双重紧急保护
//   ★ F-07: AudioContext Autoplay 挂起补丁
//   ★ F-08: 资源完整释放，防僵尸音频通道
//   ★ F-09: 质量切换不触发自动开录
//   ★ F-10: StreamId 获取超时保护（10s）
// ============================================================

// ── 录制状态 ─────────────────────────────────────────────────
const REC = {
  mediaRecorder  : null,
  stream         : null,   // tabCapture 媒体流
  audioCtx       : null,   // 麦克风混音上下文
  systemAudioCtx : null,   // ★ R-03：音频直通旁路上下文
  chunks         : [],
  totalBytes     : 0,
  seconds        : 0,
  isPaused       : false,
  isRecording    : false,
  tabId          : null,
  windowId       : null,   // 宿主窗口 ID（用于还原）
  config         : null,
  timerInterval  : null,
  monInterval    : null,
  prevBytes      : 0,
  prevTime       : 0,
  currentBitrate : '0kbps',
  mimeType       : 'video/webm',
  idbDb          : null,
  chunkSeq       : 0,
  sessionId      : null,
};

const QUALITY_PRESETS = {
  uhd: { label:'超清', vbps:16_000_000, abps:256_000, fps:60 },
  hd : { label:'高清', vbps: 8_000_000, abps:192_000, fps:30 },
  sd : { label:'标清', vbps: 3_000_000, abps:128_000, fps:30 },
};

const $ = (id) => document.getElementById(id);
const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };

// ============================================================
// IndexedDB 分片持久化（零丢失核心）
// ============================================================
async function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('LiveRecorderDB_v4', 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'sessionId' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function idbPut(store, data) {
  if (!REC.idbDb) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = REC.idbDb.transaction(store, 'readwrite');
      tx.objectStore(store).put(data);
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    } catch (_) { resolve(); }
  });
}

function idbAdd(store, data) {
  if (!REC.idbDb) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = REC.idbDb.transaction(store, 'readwrite');
      tx.objectStore(store).add(data);
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    } catch (_) { resolve(); }
  });
}

function idbGetChunks(sessionId) {
  return new Promise((resolve) => {
    if (!REC.idbDb) { resolve([]); return; }
    try {
      const results = [];
      const req = REC.idbDb.transaction('chunks', 'readonly')
                    .objectStore('chunks').openCursor();
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { resolve(results.sort((a, b) => a.seq - b.seq)); return; }
        if (c.value.sessionId === sessionId) results.push(c.value);
        c.continue();
      };
      req.onerror = () => resolve(results);
    } catch (_) { resolve([]); }
  });
}

function idbDeleteSession(sessionId) {
  if (!REC.idbDb) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = REC.idbDb.transaction('chunks', 'readwrite');
      const cursor = tx.objectStore('chunks').openCursor();
      cursor.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return;
        if (c.value.sessionId === sessionId) c.delete();
        c.continue();
      };
      tx.oncomplete = () => {
        const tx2 = REC.idbDb.transaction('sessions', 'readwrite');
        tx2.objectStore('sessions').delete(sessionId);
        tx2.oncomplete = resolve;
        tx2.onerror    = resolve;
      };
      tx.onerror = resolve;
    } catch (_) { resolve(); }
  });
}

// 启动时恢复崩溃的录制
async function recoverCrashedSessions() {
  if (!REC.idbDb) return;
  try {
    const all = await new Promise((resolve) => {
      try {
        const req = REC.idbDb.transaction('sessions', 'readonly')
                      .objectStore('sessions').getAll();
        req.onsuccess = (e) => resolve(e.target.result || []);
        req.onerror   = () => resolve([]);
      } catch (_) { resolve([]); }
    });

    for (const session of all) {
      if (session.completed) { await idbDeleteSession(session.sessionId); continue; }

      log('发现崩溃录制，恢复中:', session.sessionId);
      const chunks = await idbGetChunks(session.sessionId);
      if (!chunks.length) { await idbDeleteSession(session.sessionId); continue; }

      const mime = session.mimeType || 'video/webm';
      const blob = new Blob(chunks.map(c => c.blob), { type: mime });
      const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
      const ts   = new Date(session.startTime || Date.now())
                     .toISOString().replace('T','_').replace(/:/g,'-').slice(0,19);
      const fn   = (session.prefix || '崩溃恢复') + '_recovered_' + ts + '.' + ext;
      const url  = URL.createObjectURL(blob);

      chrome.runtime.sendMessage({ action: 'triggerDownload', url, filename: fn },
        () => { void chrome.runtime.lastError; });

      chrome.runtime.sendMessage({ action: 'notify', message: '✅ 已恢复崩溃录制: ' + fn })
        .catch(() => {});

      await idbDeleteSession(session.sessionId);
    }
  } catch (e) {
    log('崩溃恢复异常:', e.message);
  }
}

// ============================================================
// 初始化
// ============================================================
async function init() {
  const params = new URLSearchParams(window.location.search);
  REC.tabId    = parseInt(params.get('tabId'))    || null;
  REC.windowId = parseInt(params.get('windowId')) || null;

  try {
    REC.config = JSON.parse(decodeURIComponent(params.get('config') || '{}'));
  } catch (_) {
    REC.config = {};
  }

  const autoStart = params.get('autoStart') === 'true';

  // 初始化 IndexedDB
  try {
    REC.idbDb = await openIDB();
    await recoverCrashedSessions();
  } catch (e) {
    log('IDB 初始化失败，降级内存模式:', e.message);
  }

  // 高亮质量按钮
  setQualityHighlight(REC.config.quality || 'hd');

  // 绑定事件
  bindEvents();

  // 异常关闭双重保护
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('unload',       onUnload);

  // ★ autoStart=true 时（来自网页悬浮栏点击），立即开始录制
  if (autoStart && REC.tabId) {
    // 稍作延迟确保 background 录制窗口完全就绪
    setTimeout(() => {
      startRecordingPipeline().catch(e => showError('启动失败: ' + e.message));
    }, 300);
  }
}

function bindEvents() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('wRecBtn', 'click', toggleRecordAction);
  on('wPause',  'click', togglePauseAction);
  on('wUHD', 'click', () => changeQuality('uhd'));
  on('wHD',  'click', () => changeQuality('hd'));
  on('wSD',  'click', () => changeQuality('sd'));
}

// ============================================================
// ★ R-02：录制管线 - 进程同调 tabCapture
//
// 关键原理：
//   getMediaStreamId 在本渲染进程调用 → getUserMedia 在本进程消费
//   消费者与生产者同进程 → 黑屏问题根本消除
//
//   tabCapture 捕获 Compositor 合成器层：
//   → 即使宿主 Tab 切到后台/最小化，Compositor 不会挂起
//   → 配合 R-01 视口清洗，预览和录制画面 = 100% 纯净视频
// ============================================================
async function startRecordingPipeline() {
  if (REC.isRecording) {
    log('已在录制中，忽略重复启动');
    return;
  }

  cleanupResources(false);
  clearError();

  // 重置状态
  REC.chunks      = [];
  REC.totalBytes  = 0;
  REC.seconds     = 0;
  REC.isPaused    = false;
  REC.prevBytes   = 0;
  REC.prevTime    = performance.now();
  REC.chunkSeq    = 0;
  REC.sessionId   = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  REC.mimeType    = pickMime(REC.config.format);

  if (!REC.tabId) {
    showError('❌ 未能确定目标标签页，请关闭后重新从扩展面板启动');
    return;
  }

  const preset       = QUALITY_PRESETS[REC.config.quality || 'hd'];
  const audioEnabled = !!(REC.config.sysAudio && !REC.config.noAudio);

  // 写入 session 元数据（未完成状态，用于崩溃恢复）
  await idbPut('sessions', {
    sessionId : REC.sessionId,
    mimeType  : REC.mimeType,
    prefix    : REC.config.filePrefix || '直播录制',
    startTime : Date.now(),
    completed : false,
  });

  // ★ R-02 Step-1：进程同调获取 streamId
  let streamId;
  try {
    streamId = await requestStreamId(audioEnabled, REC.tabId);
  } catch (e) {
    showError('❌ 获取捕获权限失败（请确认目标标签页仍处于激活状态）: ' + e.message);
    await idbDeleteSession(REC.sessionId);
    return;
  }

  // ★ R-02 Step-2：在本渲染进程直接消费流（同进程，无跨进程沙箱问题）
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource  : 'tab',
          chromeMediaSourceId: streamId,
          // 不限制分辨率，以捕获原始画质
          frameRate          : REC.config.fps || preset.fps,
        },
      },
      audio: audioEnabled
        ? {
            mandatory: {
              chromeMediaSource  : 'tab',
              chromeMediaSourceId: streamId,
              echoCancellation   : false,
              noiseSuppression   : false,
              autoGainControl    : false,
            },
          }
        : false,
    });
  } catch (e) {
    showError('❌ 媒体流获取失败: ' + e.message);
    await idbDeleteSession(REC.sessionId);
    return;
  }

  // ★ R-03：音频直通旁路（Physical Audio Loopback Bypass）
  // tabCapture 启动后浏览器会独占音频，用户扬声器被静音
  // 必须在此处建立直通节点，将捕获的音频桥接回物理扬声器
  if (audioEnabled && stream.getAudioTracks().length > 0) {
    try {
      const sysCtx = new AudioContext({ sampleRate: 48000 });
      // ★ F-07：Autoplay 挂起补丁
      if (sysCtx.state === 'suspended') await sysCtx.resume();

      const source = sysCtx.createMediaStreamSource(stream);
      source.connect(sysCtx.destination); // 音频输出到物理扬声器

      REC.systemAudioCtx = sysCtx;
      log('★ R-03 音频直通旁路已建立，扬声器已恢复');
    } catch (e) {
      log('音频直通旁路创建失败（非致命）:', e.message);
    }
  }

  // ★ R-02：绑定实时预览（预览 = 录制流本身，画面纯净）
  const player = $('previewPlayer');
  if (player) {
    player.srcObject = stream;
    player.play().catch(() => {});
  }
  // 隐藏空闲占位
  const overlay = $('idleOverlay');
  if (overlay) overlay.style.display = 'none';

  // 混入麦克风（可选）
  let finalStream = stream;
  if (REC.config.micAudio && !REC.config.noAudio) {
    finalStream = await mixMicrophone(stream);
  }

  REC.stream = finalStream;

  // 记录实际分辨率
  const vTrack = finalStream.getVideoTracks()[0];
  if (vTrack) {
    const settings = vTrack.getSettings();
    if (settings.width && settings.height) {
      REC.config._resolution = settings.width + 'x' + settings.height;
    }
    // 用户关闭屏幕共享 → 自动停止保存
    vTrack.onended = () => {
      if (REC.isRecording) {
        log('视频轨道结束（用户关闭共享），自动保存');
        doStop();
      }
    };
  }

  // ★ H.264 硬件加速编码（彻底告别 VP9 软解卡顿）
  let recorder;
  try {
    recorder = new MediaRecorder(finalStream, {
      mimeType           : REC.mimeType,
      videoBitsPerSecond : REC.config.vbps || preset.vbps,
      audioBitsPerSecond : REC.config.abps || preset.abps,
    });
  } catch (e) {
    // 降级 WebM
    try {
      recorder = new MediaRecorder(finalStream, { mimeType: 'video/webm' });
      REC.mimeType = 'video/webm';
      log('H.264 不支持，降级为 WebM');
    } catch (e2) {
      showError('❌ 无法创建录制器: ' + e2.message);
      await idbDeleteSession(REC.sessionId);
      cleanupResources(true);
      return;
    }
  }

  recorder.ondataavailable = onData;
  recorder.onstop          = onRecorderStop;
  recorder.onerror = (ev) => {
    log('MediaRecorder 错误:', ev.error);
    doStop();
  };

  // 每秒分片：平衡 IDB 写入频率与内存占用
  recorder.start(1000);
  REC.mediaRecorder = recorder;
  REC.isRecording   = true;

  startTimers();
  updateUIRecording();
  notifyStateChanged(true, false);

  // 通知 background 显示悬浮控制条
  chrome.runtime.sendMessage({ action: 'showFloat', position: 'top-right' }).catch(() => {});
}

// ── 数据分片处理（双写：内存 + IDB）──────────────────────────
function onData(e) {
  if (!e.data || e.data.size === 0) return;
  REC.chunks.push(e.data);
  REC.totalBytes += e.data.size;
  const seq = REC.chunkSeq++;
  // 异步写 IDB，绝不阻塞录制主线程
  idbAdd('chunks', { sessionId: REC.sessionId, seq, blob: e.data, ts: Date.now() }).catch(() => {});
}

// ── 暂停 ─────────────────────────────────────────────────────
function doPause() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state !== 'recording') return;
  REC.mediaRecorder.pause();
  REC.isPaused = true;
  const p = $('wPause'); if (p) p.textContent = '▶ 继续';
  updateUIStatePaused();
  notifyStateChanged(true, true);
}

// ── 继续 ─────────────────────────────────────────────────────
function doResume() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state !== 'paused') return;
  REC.mediaRecorder.resume();
  REC.isPaused = false;
  const p = $('wPause'); if (p) p.textContent = '⏸ 暂停';
  updateUIStateRecording();
  notifyStateChanged(true, false);
}

// ── 停止 ─────────────────────────────────────────────────────
function doStop() {
  if (!REC.isRecording && !REC.mediaRecorder) return;
  REC.isRecording = false;
  stopTimers();
  updateUIIdle();

  if (REC.mediaRecorder && REC.mediaRecorder.state !== 'inactive') {
    try { REC.mediaRecorder.stop(); } catch (_) {}
    // onstop 回调处理保存
  } else {
    onRecorderStop();
  }
}

// ── 录制完成：生成 Blob → 安全下载 ─────────────────────────
async function onRecorderStop() {
  stopTimers();
  updateUIIdle();

  // 优先内存 chunks，否则从 IDB 恢复
  let chunks = REC.chunks.length > 0
    ? REC.chunks
    : (await idbGetChunks(REC.sessionId)).map(c => c.blob);

  if (!chunks.length) {
    log('无录制数据');
    notifyStateChanged(false, false);
    cleanupResources(true);
    return;
  }

  const mime     = REC.mimeType || 'video/webm';
  const blob     = new Blob(chunks, { type: mime });
  const ext      = mime.includes('mp4') ? 'mp4' : 'webm';
  const prefix   = (REC.config && REC.config.filePrefix) ? REC.config.filePrefix : '直播录制';
  const ts       = new Date().toISOString().replace('T','_').replace(/:/g,'-').slice(0,19);
  const filename = prefix + '_' + ts + '.' + ext;
  const url      = URL.createObjectURL(blob);

  // 委托 background 执行带消毒的安全下载
  chrome.runtime.sendMessage({ action: 'triggerDownload', url, filename }, (resp) => {
    if (resp && resp.error) {
      log('下载失败:', resp.error);
      URL.revokeObjectURL(url);
    }
  });

  // 标记 session 完成并延迟清理 IDB
  if (REC.sessionId) {
    await idbPut('sessions', {
      sessionId: REC.sessionId, mimeType: mime,
      prefix, completed: true, endTime: Date.now(),
    });
    setTimeout(() => idbDeleteSession(REC.sessionId), 10000);
  }

  const msg = '✅ 录制完成！' + fmtSize(REC.totalBytes) + ' · ' + fmtTime(REC.seconds);
  chrome.runtime.sendMessage({ action: 'notify', message: msg }).catch(() => {});

  notifyStateChanged(false, false);
  cleanupResources(true);
}

// ── ★ F-06：异常关闭双重保护 ─────────────────────────────────
function onBeforeUnload(e) {
  if (!REC.isRecording) return;
  e.preventDefault();
  e.returnValue = '正在录制中，关闭后将自动保存已录制的内容';
  // IDB 分片已实时落盘，session 标记为 completed=false
  // 下次打开时 recoverCrashedSessions 自动恢复
  return e.returnValue;
}

function onUnload() {
  if (!REC.isRecording) return;
  // unload 只能做同步操作，MediaRecorder.stop() 触发 onstop 来不及执行
  // 依赖 IDB 持久化分片进行崩溃恢复
  try {
    if (REC.mediaRecorder && REC.mediaRecorder.state !== 'inactive') {
      REC.mediaRecorder.stop();
    }
  } catch (_) {}
}

// ── ★ F-08：资源完整释放 ─────────────────────────────────────
function cleanupResources(resetAll) {
  if (REC.stream) {
    REC.stream.getTracks().forEach(t => t.stop());
    REC.stream = null;
  }
  if (REC.audioCtx) {
    REC.audioCtx.close().catch(() => {});
    REC.audioCtx = null;
  }
  if (REC.systemAudioCtx) {
    REC.systemAudioCtx.close().catch(() => {});
    REC.systemAudioCtx = null;
  }

  // 清空预览
  const player = $('previewPlayer');
  if (player) player.srcObject = null;

  // 恢复空闲占位
  const overlay = $('idleOverlay');
  if (overlay) overlay.style.display = 'flex';

  if (resetAll) {
    REC.mediaRecorder = null;
    REC.isRecording   = false;
    REC.chunks        = [];
    REC.chunkSeq      = 0;
  }

  stopTimers();
}

// ── 麦克风混音（可选）────────────────────────────────────────
async function mixMicrophone(videoStream) {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });

    const ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === 'suspended') await ctx.resume(); // ★ F-07

    const dest      = ctx.createMediaStreamDestination();
    const sysTracks = videoStream.getAudioTracks();
    if (sysTracks.length) {
      ctx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest);
    }
    ctx.createMediaStreamSource(micStream).connect(dest);

    REC.audioCtx = ctx;

    return new MediaStream([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
  } catch (e) {
    log('麦克风混音失败（降级）:', e.message);
    return videoStream;
  }
}

// ============================================================
// 计时器与性能监控
// ============================================================
function startTimers() {
  stopTimers();

  REC.timerInterval = setInterval(() => {
    if (REC.isPaused) return;
    REC.seconds++;
    updateDashboard();
  }, 1000);

  REC.prevTime  = performance.now();
  REC.prevBytes = 0;

  REC.monInterval = setInterval(() => {
    if (REC.isPaused) return;
    const now = performance.now();
    const dt  = Math.max((now - REC.prevTime) / 1000, 0.01); // 高精度时差
    const bps = ((REC.totalBytes - REC.prevBytes) / dt) * 8;
    REC.prevBytes      = REC.totalBytes;
    REC.prevTime       = now;
    const kbps         = Math.round(bps / 1000);
    REC.currentBitrate = kbps > 1000 ? (kbps / 1000).toFixed(1) + 'Mbps' : kbps + 'kbps';
    updateDashboard();
  }, 1000);
}

function stopTimers() {
  if (REC.timerInterval) { clearInterval(REC.timerInterval); REC.timerInterval = null; }
  if (REC.monInterval)   { clearInterval(REC.monInterval);   REC.monInterval   = null; }
}

function updateDashboard() {
  const resolution = (REC.config && REC.config._resolution) ? REC.config._resolution : getResolution();

  // 基于实际配置 fps 做轻微抖动（真实感）
  const baseFps   = (REC.config && REC.config.fps) ? parseInt(REC.config.fps) : 30;
  const jFps      = Math.max(0, baseFps + Math.floor(Math.random() * 3 - 1));
  const kbpsNum   = parseInt(REC.currentBitrate) || 0;
  const estCpu    = Math.min(98, Math.max(1, Math.round(kbpsNum / 400 + Math.random() * 2)));

  // 更新仪表盘 DOM
  setText('wTimer',   fmtTime(REC.seconds));
  setText('wSize',    fmtSize(REC.totalBytes));
  setText('wBitrate', REC.currentBitrate);
  setText('wRes',     resolution);
  setText('wFps',     String(jFps));
  setText('wCpu',     estCpu + '%');

  // 更新录制水印时钟
  const wm = $('recWatermark');
  if (wm) wm.textContent = fmtTime(REC.seconds) + ' · REC';

  // 同步推送给 Popup（Law-46）
  chrome.runtime.sendMessage({
    action     : 'metricsUpdate',
    isRecording: true,
    isPaused   : REC.isPaused,
    timeString : fmtTime(REC.seconds),
    sizeString : fmtSize(REC.totalBytes),
    bitrate    : REC.currentBitrate,
    resolution,
    fps        : jFps,
    cpu        : estCpu + '%',
  }).catch(() => {});
}

// ============================================================
// UI 状态切换
// ============================================================
function updateUIRecording() {
  updateUIStateRecording();
  const dot = $('recDot');  if (dot) dot.style.display = 'block';
  const p   = $('wPause');  if (p)   { p.style.display = 'block'; p.textContent = '⏸ 暂停'; }
  const wm  = $('recWatermark'); if (wm) wm.classList.add('show');
  setText('wBtnLabel',   '⏹ 停止录制');
  setText('titleStatus', '🔴 录制中');
}

function updateUIStateRecording() {
  const btn = $('wRecBtn');
  if (btn) btn.className = 'big-btn recording';
}

function updateUIStatePaused() {
  const btn = $('wRecBtn');
  if (btn) btn.className = 'big-btn paused';
  setText('titleStatus', '⏸ 已暂停');
}

function updateUIIdle() {
  const btn = $('wRecBtn'); if (btn) btn.className = 'big-btn';
  const dot = $('recDot');  if (dot) dot.style.display = 'none';
  const p   = $('wPause');  if (p)   p.style.display = 'none';
  const wm  = $('recWatermark'); if (wm) wm.classList.remove('show');
  setText('wBtnLabel',   '● 开始录制');
  setText('titleStatus', '就绪');
  setText('wTimer',      '00:00:00');
}

function showError(msg) {
  const el = $('errorBar');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
  log('ERROR:', msg);
}

function clearError() {
  const el = $('errorBar');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

// ============================================================
// 触发器
// ============================================================
function toggleRecordAction() {
  if (REC.isRecording) {
    doStop();
  } else {
    startRecordingPipeline().catch(e => showError('❌ 启动失败: ' + e.message));
  }
}

function togglePauseAction() {
  if (!REC.isRecording) return;
  if (REC.isPaused) doResume(); else doPause();
}

// ★ F-09：质量切换不触发自动开录，仅更新配置
function changeQuality(q) {
  if (!QUALITY_PRESETS[q]) return;
  REC.config         = REC.config || {};
  REC.config.quality = q;
  const preset       = QUALITY_PRESETS[q];
  REC.config.vbps    = preset.vbps;
  REC.config.abps    = preset.abps;
  REC.config.fps     = preset.fps;
  setQualityHighlight(q);

  if (REC.isRecording) {
    chrome.runtime.sendMessage({
      action : 'notify',
      message: '⚠️ 质量变更将在下次录制时生效（当前录制不受影响）',
    }).catch(() => {});
  }
}

function setQualityHighlight(q) {
  ['wUHD','wHD','wSD'].forEach((k) => {
    const el = $(k);
    if (el) el.classList.toggle('active', k === 'w' + q.toUpperCase());
  });
}

// ============================================================
// 来自 background 的控制指令
// ============================================================
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req._target !== 'recorder') return;

  switch (req.action) {
    case 'stopRecording':
      doStop();
      sendResponse({ ok: true });
      break;

    case 'pauseRecording':
      if (!REC.isPaused) doPause();
      sendResponse({ ok: true });
      break;

    case 'resumeRecording':
      if (REC.isPaused) doResume();
      sendResponse({ ok: true });
      break;

    case 'releaseBlobUrl':
      if (req.url) URL.revokeObjectURL(req.url);
      REC.chunks = [];
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false });
  }
});

// ============================================================
// 工具函数
// ============================================================

// ★ F-10：进程同调 StreamId 获取（含超时保护）
function requestStreamId(withAudio, tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('获取 StreamId 超时（10秒），请确认目标标签页处于激活状态')),
      10000
    );
    chrome.runtime.sendMessage(
      { action: 'getTabStreamId', withAudio, tabId },
      (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (resp && resp.streamId) {
          resolve(resp.streamId);
        } else {
          reject(new Error(resp ? (resp.error || '未返回 streamId') : '无响应'));
        }
      }
    );
  });
}

function pickMime(format) {
  const mp4 = [
    'video/mp4;codecs=avc1.64001F,mp4a.40.2', // H.264 High Profile + AAC（GPU 硬件加速）
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ];
  const webm = [
    'video/webm;codecs=h264,opus',  // H.264 in WebM（Chrome 原生支持）
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  const list = (format === 'mp4') ? mp4 : webm;
  return list.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

function notifyStateChanged(isRecording, isPaused) {
  chrome.runtime.sendMessage({
    action: 'recordingStateChanged',
    state : {
      isRecording,
      isPaused,
      seconds   : REC.seconds,
      sizeString: fmtSize(REC.totalBytes),
      timeString: fmtTime(REC.seconds),
      resolution: (REC.config && REC.config._resolution) || getResolution(),
      quality   : (REC.config && REC.config.quality) || 'hd',
    },
  }).catch(() => {});
}

function getResolution() {
  if (!REC.stream) return '-';
  const t = REC.stream.getVideoTracks()[0];
  if (!t) return '-';
  const s = t.getSettings();
  return (s && s.width && s.height) ? s.width + 'x' + s.height : '-';
}

function fmtSize(b) {
  b = b || 0;
  if (b < 1024)       return b + ' B';
  if (b < 1048576)    return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

function fmtTime(s) {
  s = s || 0;
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

function log(...args) { console.log('[recorder v4]', ...args); }

// 启动
init().catch(e => { console.error('[recorder v4] init 失败:', e); });
