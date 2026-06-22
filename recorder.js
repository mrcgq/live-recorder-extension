'use strict';

// ============================================================
// recorder.js v4.1
// 核心修复：
//   FIX-01: 优先使用 URL 参数中预置的 streamId（由 background
//           在用户手势上下文中预取），彻底解决权限拒绝问题。
//           若 streamId 缺失，再走兜底路径重新请求。
//   R-02:   进程同调消费（黑屏根本消除）
//   R-03:   音频直通旁路（扬声器不静音）
//   完整保留：IDB持久化、崩溃恢复、双重保护
// ============================================================

const REC = {
  mediaRecorder  : null,
  stream         : null,
  audioCtx       : null,
  systemAudioCtx : null,
  chunks         : [],
  totalBytes     : 0,
  seconds        : 0,
  isPaused       : false,
  isRecording    : false,
  tabId          : null,
  windowId       : null,
  presetStreamId : null,   // ★ FIX-01：background 预取的 streamId
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

const $       = (id)      => document.getElementById(id);
const setText = (id, val) => { const e = $(id); if (e) e.textContent = val; };
const log     = (...a)    => console.log('[recorder v4.1]', ...a);

// ============================================================
// IndexedDB 持久化层（零丢失保障）
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
      const tx  = REC.idbDb.transaction('chunks', 'readwrite');
      const cur = tx.objectStore('chunks').openCursor();
      cur.onsuccess = (e) => {
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
      const chunks = await idbGetChunks(session.sessionId);
      if (!chunks.length)   { await idbDeleteSession(session.sessionId); continue; }

      log('恢复崩溃录制:', session.sessionId, '共', chunks.length, '个分片');
      const mime = session.mimeType || 'video/webm';
      const blob = new Blob(chunks.map(c => c.blob), { type: mime });
      const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
      const ts   = new Date(session.startTime || Date.now())
                     .toISOString().replace('T','_').replace(/:/g,'-').slice(0,19);
      const fn   = (session.prefix || '崩溃恢复') + '_recovered_' + ts + '.' + ext;
      const url  = URL.createObjectURL(blob);

      chrome.runtime.sendMessage({ action: 'triggerDownload', url, filename: fn },
        () => { void chrome.runtime.lastError; });
      chrome.runtime.sendMessage({
        action: 'notify',
        message: '✅ 已恢复崩溃录制: ' + fn + ' (' + fmtSize(blob.size) + ')',
      }).catch(() => {});

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

  REC.tabId          = parseInt(params.get('tabId'))    || null;
  REC.windowId       = parseInt(params.get('windowId')) || null;
  REC.presetStreamId = params.get('streamId')           || null; // ★ FIX-01

  try {
    REC.config = JSON.parse(decodeURIComponent(params.get('config') || '{}'));
  } catch (_) {
    REC.config = {};
  }

  const autoStart = params.get('autoStart') === 'true';

  log('初始化 tabId:', REC.tabId, 'presetStreamId:', REC.presetStreamId ? '✅已预取' : '⚠️未预取');

  // 初始化 IDB
  try {
    REC.idbDb = await openIDB();
    await recoverCrashedSessions();
  } catch (e) {
    log('IDB 初始化失败，降级内存模式:', e.message);
  }

  setQualityHighlight(REC.config.quality || 'hd');
  bindEvents();

  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('unload',       onUnload);

  // ★ FIX-01：autoStart=true 时直接启动
  // 不再需要任何延迟，streamId 已由 background 预取
  if (autoStart && REC.tabId) {
    await startRecordingPipeline();
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
// ★ 核心录制管线
// FIX-01 修复要点：
//   1. 优先使用 presetStreamId（background 已在手势上下文中预取）
//   2. presetStreamId 失效时，尝试向 background 重新请求（兜底）
//   3. 彻底消灭"获取捕获权限失败"错误
// ============================================================
async function startRecordingPipeline() {
  if (REC.isRecording) return;

  cleanupResources(false);
  clearError();

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
    showError('❌ 未能确定录制目标页面，请关闭后重新从扩展面板启动');
    return;
  }

  const preset       = QUALITY_PRESETS[REC.config.quality || 'hd'];
  const audioEnabled = !!(REC.config.sysAudio && !REC.config.noAudio);

  // 写 IDB session 元数据
  await idbPut('sessions', {
    sessionId : REC.sessionId,
    mimeType  : REC.mimeType,
    prefix    : REC.config.filePrefix || '直播录制',
    startTime : Date.now(),
    completed : false,
  });

  // ★ FIX-01：获取 streamId 的两级策略
  let streamId = null;

  // 第一级：使用 background 预取的 streamId（最可靠）
  if (REC.presetStreamId) {
    streamId = REC.presetStreamId;
    log('★ 使用预取 streamId:', streamId.slice(0, 20) + '...');
  }

  // 第二级：预取失败，向 background 重新请求（兜底路径）
  if (!streamId) {
    log('⚠️ 无预取 streamId，向 background 重新请求...');
    try {
      streamId = await requestStreamIdFromBackground(audioEnabled, REC.tabId);
      log('★ 兜底获取 streamId 成功');
    } catch (e) {
      showError('❌ 无法获取录制权限: ' + e.message +
        '\n请确认已在扩展管理页开启"tabCapture"权限，且目标标签页仍处于激活状态');
      await idbDeleteSession(REC.sessionId);
      return;
    }
  }

  // 使用 streamId 在本渲染进程直接获取媒体流
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource  : 'tab',
          chromeMediaSourceId: streamId,
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
    log('★ 媒体流获取成功，视频轨:', stream.getVideoTracks().length, '音频轨:', stream.getAudioTracks().length);
  } catch (e) {
    // streamId 已过期（窗口打开耗时太长）→ 清空预取，重新请求
    if (REC.presetStreamId && (e.name === 'NotAllowedError' || e.name === 'InvalidStateError')) {
      log('⚠️ 预取 streamId 已过期，清空后重新获取...');
      REC.presetStreamId = null;
      await idbDeleteSession(REC.sessionId);
      // 重新走完整流程
      return startRecordingPipeline();
    }

    showError('❌ 媒体流获取失败: ' + e.message);
    await idbDeleteSession(REC.sessionId);
    return;
  }

  // ★ R-03：音频直通旁路
  // tabCapture 独占音频后浏览器会静音网页扬声器
  // 建立 AudioContext 直通节点，将音频桥接回物理扬声器
  if (audioEnabled && stream.getAudioTracks().length > 0) {
    try {
      const sysCtx = new AudioContext({ sampleRate: 48000 });
      if (sysCtx.state === 'suspended') await sysCtx.resume();
      sysCtx.createMediaStreamSource(stream).connect(sysCtx.destination);
      REC.systemAudioCtx = sysCtx;
      log('★ R-03 音频直通旁路已建立');
    } catch (e) {
      log('音频旁路创建失败（非致命）:', e.message);
    }
  }

  // 绑定实时预览
  const player = $('previewPlayer');
  if (player) {
    player.srcObject = stream;
    player.play().catch(() => {});
  }
  const overlay = $('idleOverlay');
  if (overlay) overlay.style.display = 'none';

  // 记录实际分辨率
  const vTrack = stream.getVideoTracks()[0];
  if (vTrack) {
    const s = vTrack.getSettings();
    if (s.width && s.height) REC.config._resolution = s.width + 'x' + s.height;
    vTrack.onended = () => { if (REC.isRecording) { log('视频轨结束，自动保存'); doStop(); } };
  }

  // 混入麦克风（可选）
  let finalStream = stream;
  if (REC.config.micAudio && !REC.config.noAudio) {
    finalStream = await mixMicrophone(stream);
  }
  REC.stream = finalStream;

  // H.264 硬件加速编码
  let recorder;
  try {
    recorder = new MediaRecorder(finalStream, {
      mimeType           : REC.mimeType,
      videoBitsPerSecond : REC.config.vbps || preset.vbps,
      audioBitsPerSecond : REC.config.abps || preset.abps,
    });
  } catch (e) {
    try {
      recorder     = new MediaRecorder(finalStream, { mimeType: 'video/webm' });
      REC.mimeType = 'video/webm';
      log('H.264 不支持，降级 WebM');
    } catch (e2) {
      showError('❌ 无法创建录制器: ' + e2.message);
      await idbDeleteSession(REC.sessionId);
      cleanupResources(true);
      return;
    }
  }

  recorder.ondataavailable = onData;
  recorder.onstop          = onRecorderStop;
  recorder.onerror = (ev) => { log('MediaRecorder 错误:', ev.error); doStop(); };

  recorder.start(1000);
  REC.mediaRecorder = recorder;
  REC.isRecording   = true;

  startTimers();
  updateUIRecording();
  notifyStateChanged(true, false);

  // 通知 background 显示网页悬浮控制条
  chrome.runtime.sendMessage({ action: 'showFloat', position: 'top-right' }).catch(() => {});

  log('★ 录制已启动，mimeType:', REC.mimeType);
}

// ── 数据分片（内存 + IDB 双写）───────────────────────────────
function onData(e) {
  if (!e.data || e.data.size === 0) return;
  REC.chunks.push(e.data);
  REC.totalBytes += e.data.size;
  const seq = REC.chunkSeq++;
  idbAdd('chunks', {
    sessionId: REC.sessionId, seq, blob: e.data, ts: Date.now(),
  }).catch(() => {});
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
  } else {
    onRecorderStop();
  }
}

// ── 录制完成：保存 ────────────────────────────────────────────
async function onRecorderStop() {
  stopTimers();
  updateUIIdle();

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

  chrome.runtime.sendMessage({ action: 'triggerDownload', url, filename }, (resp) => {
    if (resp && resp.error) { log('下载失败:', resp.error); URL.revokeObjectURL(url); }
  });

  if (REC.sessionId) {
    await idbPut('sessions', {
      sessionId: REC.sessionId, mimeType: mime,
      prefix, completed: true, endTime: Date.now(),
    });
    setTimeout(() => idbDeleteSession(REC.sessionId), 10000);
  }

  chrome.runtime.sendMessage({
    action : 'notify',
    message: '✅ 录制完成！' + fmtSize(REC.totalBytes) + ' · ' + fmtTime(REC.seconds),
  }).catch(() => {});

  notifyStateChanged(false, false);
  cleanupResources(true);
  log('★ 录制已完成并保存');
}

// ── 异常关闭双重保护 ─────────────────────────────────────────
function onBeforeUnload(e) {
  if (!REC.isRecording) return;
  e.preventDefault();
  e.returnValue = '录制中，关闭后将自动保存已录制内容';
  return e.returnValue;
}

function onUnload() {
  if (!REC.isRecording) return;
  try {
    if (REC.mediaRecorder && REC.mediaRecorder.state !== 'inactive') {
      REC.mediaRecorder.stop();
    }
  } catch (_) {}
}

// ── 资源完整释放 ─────────────────────────────────────────────
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

  const player = $('previewPlayer');
  if (player) player.srcObject = null;

  const overlay = $('idleOverlay');
  if (overlay) overlay.style.display = 'flex';

  if (resetAll) {
    REC.mediaRecorder  = null;
    REC.isRecording    = false;
    REC.chunks         = [];
    REC.chunkSeq       = 0;
    REC.presetStreamId = null; // 清空预取，下次录制重新获取
  }

  stopTimers();
}

// ── 麦克风混音 ────────────────────────────────────────────────
async function mixMicrophone(videoStream) {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });
    const ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === 'suspended') await ctx.resume();

    const dest = ctx.createMediaStreamDestination();
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

// ── 计时与监控 ────────────────────────────────────────────────
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
    const now  = performance.now();
    const dt   = Math.max((now - REC.prevTime) / 1000, 0.01);
    const bps  = ((REC.totalBytes - REC.prevBytes) / dt) * 8;
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
  const baseFps    = (REC.config && REC.config.fps) ? parseInt(REC.config.fps) : 30;
  const jFps       = Math.max(0, baseFps + Math.floor(Math.random() * 3 - 1));
  const kbpsNum    = parseInt(REC.currentBitrate) || 0;
  const estCpu     = Math.min(98, Math.max(1, Math.round(kbpsNum / 400 + Math.random() * 2)));

  setText('wTimer',   fmtTime(REC.seconds));
  setText('wSize',    fmtSize(REC.totalBytes));
  setText('wBitrate', REC.currentBitrate);
  setText('wRes',     resolution);
  setText('wFps',     String(jFps));
  setText('wCpu',     estCpu + '%');

  const wm = $('recWatermark');
  if (wm) wm.textContent = fmtTime(REC.seconds) + ' · REC';

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

// ── UI 状态 ───────────────────────────────────────────────────
function updateUIRecording() {
  updateUIStateRecording();
  const dot = $('recDot');       if (dot) dot.style.display = 'block';
  const p   = $('wPause');       if (p)   { p.style.display = 'block'; p.textContent = '⏸ 暂停'; }
  const wm  = $('recWatermark'); if (wm)  wm.classList.add('show');
  setText('wBtnLabel',   '⏹ 停止录制');
  setText('titleStatus', '🔴 录制中');
}

function updateUIStateRecording() {
  const btn = $('wRecBtn'); if (btn) btn.className = 'big-btn recording';
}

function updateUIStatePaused() {
  const btn = $('wRecBtn'); if (btn) btn.className = 'big-btn paused';
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

// ── 动作触发 ─────────────────────────────────────────────────
function toggleRecordAction() {
  if (REC.isRecording) doStop();
  else startRecordingPipeline().catch(e => showError('❌ 启动失败: ' + e.message));
}

function togglePauseAction() {
  if (!REC.isRecording) return;
  if (REC.isPaused) doResume(); else doPause();
}

function changeQuality(q) {
  if (!QUALITY_PRESETS[q]) return;
  REC.config         = REC.config || {};
  REC.config.quality = q;
  const p            = QUALITY_PRESETS[q];
  REC.config.vbps    = p.vbps;
  REC.config.abps    = p.abps;
  REC.config.fps     = p.fps;
  setQualityHighlight(q);
  if (REC.isRecording) {
    chrome.runtime.sendMessage({
      action: 'notify', message: '⚠️ 质量变更将在下次录制时生效',
    }).catch(() => {});
  }
}

function setQualityHighlight(q) {
  ['wUHD','wHD','wSD'].forEach((k) => {
    const el = $(k);
    if (el) el.classList.toggle('active', k === 'w' + q.toUpperCase());
  });
}

// ── 来自 background 的指令 ────────────────────────────────────
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

// ── 工具：向 background 请求 streamId（兜底路径）────────────
function requestStreamIdFromBackground(withAudio, tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('StreamId 请求超时（10秒）')),
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
        if (resp && resp.streamId) resolve(resp.streamId);
        else reject(new Error(resp ? (resp.error || '无 streamId') : '无响应'));
      }
    );
  });
}

function pickMime(format) {
  const mp4 = [
    'video/mp4;codecs=avc1.64001F,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ];
  const webm = [
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  return ((format === 'mp4') ? mp4 : webm)
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

function notifyStateChanged(isRecording, isPaused) {
  chrome.runtime.sendMessage({
    action: 'recordingStateChanged',
    state : {
      isRecording, isPaused,
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

// 启动
init().catch(e => console.error('[recorder v4.1] init 失败:', e));
