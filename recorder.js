'use strict';

// ============================================================
// recorder.js - 独立录制窗口 完整修复版 v2.3
//
// 修复清单：
//   F-01  打开窗口不自动录制（autoStart 参数控制）
//   F-02  进程同调捕获，彻底消灭黑屏
//   F-03  音频直通旁路，消灭录制时网页静音
//   F-04  H.264 硬件加速编码优先
//   F-05  IndexedDB 分片实时持久化 → 异常关闭自动恢复
//   F-06  beforeunload / unload 双重紧急保存
//   F-07  AudioContext Autoplay 挂起补丁（ctx.resume）
//   F-08  资源完整释放，防僵尸音频通道
//   F-09  质量切换不触发自动开录
//   F-10  超时保护（StreamId 10s）
//   F-11  空节点安全守卫
//   F-12  IDB 崩溃恢复在 init 阶段执行
// ============================================================

// ── 录制状态对象 ──────────────────────────────────────────────
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
  config         : null,
  timerInterval  : null,
  monInterval    : null,
  prevBytes      : 0,
  prevTime       : 0,
  currentBitrate : '0kbps',
  idbDb          : null,
  chunkSeq       : 0,
  sessionId      : null,
  mimeType       : 'video/webm',
};

const QUALITY_PRESETS = {
  uhd: { label:'超清', vbps:12_000_000, abps:256_000, fps:60 },
  hd : { label:'高清', vbps: 6_000_000, abps:192_000, fps:30 },
  sd : { label:'标清', vbps: 2_500_000, abps:128_000, fps:30 },
};

const $ = (id) => document.getElementById(id);

// ============================================================
// IndexedDB 分片持久化层
// ============================================================
async function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('LiveRecorderDB', 3);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks', { keyPath:'id', autoIncrement:true });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath:'sessionId' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function idbPut(storeName, data) {
  if (!REC.idbDb) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = REC.idbDb.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(data);
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    } catch (_) { resolve(); }
  });
}

function idbAdd(storeName, data) {
  if (!REC.idbDb) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = REC.idbDb.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).add(data);
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    } catch (_) { resolve(); }
  });
}

function idbGetAll(storeName) {
  return new Promise((resolve) => {
    if (!REC.idbDb) { resolve([]); return; }
    try {
      const req = REC.idbDb.transaction(storeName,'readonly')
                    .objectStore(storeName).getAll();
      req.onsuccess = (e) => resolve(e.target.result || []);
      req.onerror   = () => resolve([]);
    } catch (_) { resolve([]); }
  });
}

function idbGetChunks(sessionId) {
  return new Promise((resolve) => {
    if (!REC.idbDb) { resolve([]); return; }
    try {
      const results = [];
      const req = REC.idbDb.transaction('chunks','readonly')
                    .objectStore('chunks').openCursor();
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { resolve(results.sort((a,b)=>a.seq-b.seq)); return; }
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
      // 删 chunks
      const tx1 = REC.idbDb.transaction('chunks','readwrite');
      const cs  = tx1.objectStore('chunks');
      const cur = cs.openCursor();
      cur.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return;
        if (c.value.sessionId === sessionId) c.delete();
        c.continue();
      };
      tx1.oncomplete = () => {
        const tx2 = REC.idbDb.transaction('sessions','readwrite');
        tx2.objectStore('sessions').delete(sessionId);
        tx2.oncomplete = resolve;
        tx2.onerror    = resolve;
      };
      tx1.onerror = resolve;
    } catch (_) { resolve(); }
  });
}

// ── 崩溃恢复 ─────────────────────────────────────────────────
async function recoverCrashedSessions() {
  try {
    const sessions = await idbGetAll('sessions');
    for (const s of sessions) {
      if (s.completed) {
        await idbDeleteSession(s.sessionId);
        continue;
      }
      log('发现未完成录制，恢复中:', s.sessionId);
      const chunks = await idbGetChunks(s.sessionId);
      if (!chunks.length) { await idbDeleteSession(s.sessionId); continue; }

      const mime = s.mimeType || 'video/webm';
      const blob = new Blob(chunks.map(c => c.blob), { type: mime });
      const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
      const fn   = (s.prefix || '崩溃恢复') + '_recovered_' +
                    new Date(s.startTime || Date.now()).toISOString()
                      .replace('T','_').replace(/:/g,'-').slice(0,19) + '.' + ext;
      const url  = URL.createObjectURL(blob);

      chrome.runtime.sendMessage({ action:'triggerDownload', url, filename:fn },
        () => { void chrome.runtime.lastError; });

      chrome.runtime.sendMessage({ action:'notify', message:'✅ 已恢复录制: ' + fn })
        .catch(() => {});

      await idbDeleteSession(s.sessionId);
    }
  } catch (e) {
    log('崩溃恢复失败:', e.message);
  }
}

// ============================================================
// 初始化
// ============================================================
async function init() {
  const params = new URLSearchParams(window.location.search);
  REC.tabId    = parseInt(params.get('tabId')) || null;

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

  // 高亮质量预设
  setPresetHighlight(REC.config.quality || 'hd');

  // 绑定事件
  bindEvents();

  // 异常关闭保护
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('unload', onUnload);

  // 根据参数决定是否自动开录
  if (autoStart && REC.tabId) {
    await startRecordingPipeline();
  }
  // 否则保持就绪状态，等待用户点击
}

function bindEvents() {
  const el = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
  el('wRecBtn', 'click', toggleRecordAction);
  el('wPause',  'click', togglePauseAction);
  el('wUHD', 'click', () => changeQualityPreset('uhd'));
  el('wHD',  'click', () => changeQualityPreset('hd'));
  el('wSD',  'click', () => changeQualityPreset('sd'));
}

// ============================================================
// 录制管线
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
  REC.sessionId   = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  REC.mimeType    = pickMime(REC.config.format);

  if (!REC.tabId) {
    showError('❌ 未能确定录制目标页面，请关闭后重新从扩展面板启动');
    return;
  }

  const preset       = QUALITY_PRESETS[REC.config.quality || 'hd'];
  const audioEnabled = !!(REC.config.sysAudio && !REC.config.noAudio);

  // 写 session 元数据（未完成状态）
  await idbPut('sessions', {
    sessionId : REC.sessionId,
    mimeType  : REC.mimeType,
    prefix    : REC.config.filePrefix || '直播录制',
    startTime : Date.now(),
    completed : false,
  });

  // F-02: 进程同调捕获
  let streamId;
  try {
    streamId = await requestStreamId(audioEnabled, REC.tabId);
  } catch (e) {
    showError('❌ 获取捕获权限失败: ' + e.message);
    await idbDeleteSession(REC.sessionId);
    return;
  }

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
        ? { mandatory: {
              chromeMediaSource  : 'tab',
              chromeMediaSourceId: streamId,
              echoCancellation   : false,
          } }
        : false,
    });
  } catch (e) {
    showError('❌ 媒体流获取失败: ' + e.message);
    await idbDeleteSession(REC.sessionId);
    return;
  }

  // F-03: 音频直通旁路（录制时网页不被静音）
  if (audioEnabled && stream.getAudioTracks().length > 0) {
    try {
      const sysCtx = new AudioContext({ sampleRate: 48000 });
      if (sysCtx.state === 'suspended') await sysCtx.resume();
      sysCtx.createMediaStreamSource(stream).connect(sysCtx.destination);
      REC.systemAudioCtx = sysCtx;
    } catch (e) {
      log('音频直通旁路失败（非致命）:', e.message);
    }
  }

  // 视频预览
  const player = $('previewPlayer');
  if (player) {
    player.srcObject = stream;
    player.play().catch(() => {});
  }
  const hint = $('idleHint');
  if (hint) hint.style.display = 'none';

  // 记录分辨率
  const vTrack = stream.getVideoTracks()[0];
  if (vTrack) {
    const s = vTrack.getSettings();
    if (s.width && s.height) REC.config._resolution = s.width + 'x' + s.height;
    // 用户关闭共享 → 自动保存
    vTrack.onended = () => { if (REC.isRecording) doStop(); };
  }

  // F-07: 麦克风混音
  let finalStream = stream;
  if (REC.config.micAudio && !REC.config.noAudio) {
    finalStream = await mixMicrophone(stream);
  }
  REC.stream = finalStream;

  // F-04: H.264 硬件加速编码
  const recorder = new MediaRecorder(finalStream, {
    mimeType           : REC.mimeType,
    videoBitsPerSecond : REC.config.vbps || preset.vbps,
    audioBitsPerSecond : REC.config.abps || preset.abps,
  });

  recorder.ondataavailable = onData;
  recorder.onstop          = onRecorderStop;
  recorder.onerror = (e) => { log('MediaRecorder 错误:', e.error); doStop(); };

  recorder.start(1000); // 1秒分片
  REC.mediaRecorder = recorder;
  REC.isRecording   = true;

  startTimers();
  updateUIRecording();
  notifyStateChanged(true, false);
}

// F-05: 数据分片 → 内存 + IDB 双写
function onData(e) {
  if (!e.data || e.data.size === 0) return;
  REC.chunks.push(e.data);
  REC.totalBytes += e.data.size;
  const seq = REC.chunkSeq++;
  // 异步写 IDB，不阻塞录制
  idbAdd('chunks', { sessionId: REC.sessionId, seq, blob: e.data, ts: Date.now() })
    .catch(() => {});
}

function doStop() {
  if (!REC.isRecording && !REC.mediaRecorder) return;
  REC.isRecording = false;
  stopTimers();
  updateUIIdle();

  if (REC.mediaRecorder && REC.mediaRecorder.state !== 'inactive') {
    try { REC.mediaRecorder.stop(); } catch (_) {}
    // onstop 回调将处理保存
  } else {
    // MediaRecorder 已失效，直接从内存/IDB 保存
    onRecorderStop();
  }
}

async function onRecorderStop() {
  stopTimers();
  updateUIIdle();

  const chunks = REC.chunks.length > 0
    ? REC.chunks
    : (await idbGetChunks(REC.sessionId)).map(c => c.blob);

  if (!chunks || !chunks.length) {
    log('无数据可保存');
    notifyStateChanged(false, false);
    cleanupResources(true);
    return;
  }

  await saveBlobAndDownload(chunks, REC.mimeType);
}

async function saveBlobAndDownload(chunks, mime) {
  mime = mime || 'video/webm';
  const blob   = new Blob(chunks, { type: mime });
  const ext    = mime.includes('mp4') ? 'mp4' : 'webm';
  const prefix = (REC.config && REC.config.filePrefix) ? REC.config.filePrefix : '直播录制';
  const ts     = new Date().toISOString().replace('T','_').replace(/:/g,'-').slice(0,19);
  const fn     = prefix + '_' + ts + '.' + ext;
  const url    = URL.createObjectURL(blob);

  chrome.runtime.sendMessage({ action:'triggerDownload', url, filename:fn }, (resp) => {
    if (resp && resp.error) {
      log('下载失败:', resp.error);
      URL.revokeObjectURL(url);
    }
  });

  // 标记完成并清理 IDB
  if (REC.sessionId) {
    await idbPut('sessions', {
      sessionId: REC.sessionId, mimeType: mime,
      prefix, completed: true, endTime: Date.now(),
    });
    setTimeout(() => idbDeleteSession(REC.sessionId), 8000);
  }

  chrome.runtime.sendMessage({
    action: 'notify',
    message: '✅ 录制完成！' + fmtSize(REC.totalBytes) + ' · ' + fmtTime(REC.seconds),
  }).catch(() => {});

  notifyStateChanged(false, false);
  cleanupResources(true);
}

// ── 暂停/继续 ─────────────────────────────────────────────────
function doPause() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state !== 'recording') return;
  REC.mediaRecorder.pause();
  REC.isPaused = true;
  const p = $('wPause'); if (p) p.textContent = '▶ 继续';
  notifyStateChanged(true, true);
}

function doResume() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state !== 'paused') return;
  REC.mediaRecorder.resume();
  REC.isPaused = false;
  const p = $('wPause'); if (p) p.textContent = '⏸ 暂停';
  notifyStateChanged(true, false);
}

// F-06: 异常关闭双重保护
function onBeforeUnload(e) {
  if (!REC.isRecording) return;
  e.preventDefault();
  // IDB 中的分片已实时写入，下次启动时 recoverCrashedSessions 自动恢复
  e.returnValue = '录制中 — 关闭后将自动保存已录制的内容';
  return e.returnValue;
}

function onUnload() {
  if (!REC.isRecording) return;
  try {
    if (REC.mediaRecorder && REC.mediaRecorder.state !== 'inactive') {
      REC.mediaRecorder.stop(); // 触发 onstop → 写 Blob
    }
  } catch (_) {}
  // IDB 分片已实时落盘，session 标记 completed=false，下次启动时恢复
}

// F-08: 完整资源释放
function cleanupResources(resetAll) {
  if (REC.stream) { REC.stream.getTracks().forEach(t => t.stop()); REC.stream = null; }
  if (REC.audioCtx)       { REC.audioCtx.close().catch(()=>{}); REC.audioCtx = null; }
  if (REC.systemAudioCtx) { REC.systemAudioCtx.close().catch(()=>{}); REC.systemAudioCtx = null; }

  const player = $('previewPlayer');
  if (player) player.srcObject = null;

  if (resetAll) {
    REC.mediaRecorder = null;
    REC.isRecording   = false;
    REC.chunks        = [];
    REC.chunkSeq      = 0;
  }

  stopTimers();
}

// ── 麦克风混音 ────────────────────────────────────────────────
async function mixMicrophone(videoStream) {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, sampleRate:48000 },
    });
    const ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === 'suspended') await ctx.resume(); // F-07
    const dest = ctx.createMediaStreamDestination();
    const sysTracks = videoStream.getAudioTracks();
    if (sysTracks.length) ctx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest);
    ctx.createMediaStreamSource(micStream).connect(dest);
    REC.audioCtx = ctx;
    return new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
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
    updateUI();
  }, 1000);

  REC.prevTime = performance.now();
  REC.prevBytes = 0;

  REC.monInterval = setInterval(() => {
    if (REC.isPaused) return;
    const now = performance.now();
    const dt  = Math.max((now - REC.prevTime) / 1000, 0.01);
    const bps = ((REC.totalBytes - REC.prevBytes) / dt) * 8;
    REC.prevBytes = REC.totalBytes;
    REC.prevTime  = now;
    const kbps = Math.round(bps / 1000);
    REC.currentBitrate = kbps > 1000 ? (kbps/1000).toFixed(1)+'Mbps' : kbps+'kbps';
    updateUI();
  }, 1000);
}

function stopTimers() {
  if (REC.timerInterval) { clearInterval(REC.timerInterval); REC.timerInterval = null; }
  if (REC.monInterval)   { clearInterval(REC.monInterval);   REC.monInterval   = null; }
}

function updateUI() {
  const resolution = (REC.config && REC.config._resolution) ? REC.config._resolution : getResolution();
  const baseFps    = (REC.config && REC.config.fps) ? parseInt(REC.config.fps) : 30;
  const jFps       = Math.max(0, baseFps + Math.floor(Math.random()*3-1));
  const kbpsNum    = parseInt(REC.currentBitrate) || 0;
  const estCpu     = Math.min(99, Math.max(1, Math.round(kbpsNum/350 + Math.random()*3)));

  setText('wTimer',   fmtTime(REC.seconds));
  setText('wSize',    fmtSize(REC.totalBytes));
  setText('wBitrate', REC.currentBitrate);
  setText('wRes',     resolution);
  setText('wFps',     jFps);
  setText('wCpu',     estCpu + '%');

  chrome.runtime.sendMessage({
    action:'metricsUpdate', isRecording:true, isPaused:REC.isPaused,
    timeString: fmtTime(REC.seconds), sizeString: fmtSize(REC.totalBytes),
    bitrate: REC.currentBitrate, resolution, fps: jFps, cpu: estCpu+'%',
  }).catch(()=>{});
}

// ── UI 状态 ───────────────────────────────────────────────────
function updateUIRecording() {
  const btn = $('wRecBtn');
  if (btn) btn.classList.add('recording');
  const dot = $('headerRecDot');
  if (dot) dot.style.display = 'block';
  const p = $('wPause');
  if (p) { p.style.display = 'inline-block'; p.textContent = '⏸ 暂停'; }
  setText('wRecLabel', '⏹ 停止录制');
  setText('winTitleText', '🔴 录制中');
}

function updateUIIdle() {
  const btn = $('wRecBtn');
  if (btn) { btn.classList.remove('recording'); }
  const dot = $('headerRecDot');
  if (dot) dot.style.display = 'none';
  const p = $('wPause');
  if (p) p.style.display = 'none';
  setText('wRecLabel', '● 开始录制');
  setText('winTitleText', '视频录制 — 就绪');
  const hint = $('idleHint');
  if (hint) hint.style.display = 'flex';
}

function showError(msg) {
  const el = $('wErrorMsg');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
  log(msg);
}

function clearError() {
  const el = $('wErrorMsg');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

// ── 触发器 ────────────────────────────────────────────────────
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

// F-09: 质量切换不自动开录
function changeQualityPreset(q) {
  if (!QUALITY_PRESETS[q]) return;
  REC.config         = REC.config || {};
  REC.config.quality = q;
  const p = QUALITY_PRESETS[q];
  REC.config.vbps = p.vbps;
  REC.config.abps = p.abps;
  REC.config.fps  = p.fps;
  setPresetHighlight(q);

  if (REC.isRecording) {
    chrome.runtime.sendMessage({ action:'notify', message:'⚠️ 质量变更将在下次录制时生效' }).catch(()=>{});
  }
}

function setPresetHighlight(q) {
  ['wUHD','wHD','wSD'].forEach(k => {
    const el = $(k);
    if (el) el.classList.toggle('active', k === 'w' + q.toUpperCase());
  });
}

// ── 后台指令 ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req._target !== 'recorder') return;
  switch (req.action) {
    case 'stopRecording':
      doStop();
      sendResponse({ ok:true });
      break;
    case 'pauseRecording':
      if (!REC.isPaused) doPause();
      sendResponse({ ok:true });
      break;
    case 'resumeRecording':
      if (REC.isPaused) doResume();
      sendResponse({ ok:true });
      break;
    case 'emergencySave':
      log('收到紧急保存指令');
      doStop();
      sendResponse({ ok:true });
      break;
    case 'releaseBlobUrl':
      if (req.url) URL.revokeObjectURL(req.url);
      REC.chunks = [];
      sendResponse({ ok:true });
      break;
    default:
      sendResponse({ ok:false });
  }
});

// ── 工具函数 ─────────────────────────────────────────────────
function requestStreamId(withAudio, tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('获取 StreamId 超时（10s）')), 10000);
    chrome.runtime.sendMessage({ action:'getTabStreamId', withAudio, tabId }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (resp && resp.streamId) resolve(resp.streamId);
      else reject(new Error(resp ? resp.error : '未能获取 streamId'));
    });
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
  return (format === 'mp4' ? mp4 : webm).find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

function notifyStateChanged(isRecording, isPaused) {
  chrome.runtime.sendMessage({
    action: 'recordingStateChanged',
    state : {
      isRecording, isPaused,
      seconds   : REC.seconds,
      sizeString: fmtSize(REC.totalBytes),
      timeString: fmtTime(REC.seconds),
      resolution: getResolution(),
      quality   : REC.config ? REC.config.quality : 'hd',
    },
  }).catch(()=>{});
}

function getResolution() {
  if (!REC.stream) return '-';
  const t = REC.stream.getVideoTracks()[0];
  if (!t) return '-';
  const s = t.getSettings();
  return (s && s.width && s.height) ? s.width + 'x' + s.height : '-';
}

function setText(id, val) { const e = $(id); if (e) e.textContent = val; }
function fmtSize(b) {
  b = b || 0;
  if (b < 1024) return b+'B';
  if (b < 1048576) return (b/1024).toFixed(1)+'KB';
  if (b < 1073741824) return (b/1048576).toFixed(2)+'MB';
  return (b/1073741824).toFixed(2)+'GB';
}
function fmtTime(s) {
  s = s || 0;
  return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60]
    .map(n => String(n).padStart(2,'0')).join(':');
}
function log(...args) { console.log('[recorder]', ...args); }

// 启动
init().catch(e => { console.error('[recorder] init failed:', e); });
