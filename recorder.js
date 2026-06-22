'use strict';

/**
 * recorder.js - OPFS 极速自愈录制引擎
 * 
 * 物理职责：
 * 1. 作为独立进程，接收 content.js 跨进程推送来的原始分片数据
 * 2. 物理加固：绑定控制面板 btnActiveStart 按钮，主动向原网页投递直录嗅探指令，规避鼠标悬浮局限 [纠正 3]
 * 3. 崩溃自愈保护：意外断网或页面进程死亡时，即刻关闭流强制落盘挽回
 */

const QUALITY_PRESETS = {
  uhd: { label:'超清 4K',  vbps:16_000_000, abps:256_000, fps:60, res:'3840×2160' },
  hd : { label:'高清 1080P', vbps:8_000_000,  abps:192_000, fps:30, res:'1920×1080' },
  sd : { label:'标清 720P',  vbps:3_000_000,  abps:128_000, fps:30, res:'1280×720'  },
};

let currentQuality   = 'hd';
let isRecording      = false;
let isPaused         = false;
let activeTabId      = null;
let presetStreamId   = null;

let keepAliveStream  = null;
let audioContext     = null;

// OPFS 引擎状态机
let fileHandle       = null;
let writableStream   = null;
let opfsInitialized  = false;
let currentTotalBytes = 0;
let currentConfig    = {};
let isNormalStop     = false; 

// Fallback 模式状态
let fallbackRecorder = null;
let fallbackSeconds  = 0;
let fallbackTimer    = null;

const $ = (id) => document.getElementById(id);

function init() {
  const params   = new URLSearchParams(window.location.search);
  activeTabId    = parseInt(params.get('tabId')) || null;
  presetStreamId = params.get('streamId') || null;

  try {
    currentConfig = JSON.parse(decodeURIComponent(params.get('config') || '{}'));
    if (currentConfig.quality && QUALITY_PRESETS[currentConfig.quality]) {
      currentQuality = currentConfig.quality;
    }
  } catch (_) {}

  setQualityHighlight(currentQuality);
  updateFormat();
  bindEvents();

  // 跨进程长连接管道接收端初始化
  const pipelinePort = chrome.runtime.connect({ name: 'recorder_pipeline' });
  pipelinePort.onMessage.addListener(async (msg) => {
    if (msg.action === 'chunk') {
      await writeToOPFS(msg.blob);
      currentTotalBytes += msg.blob.size;
    } else if (msg.action === 'complete') {
      isNormalStop = true;
      await finalizeOPFSRecording(currentConfig);
    } else if (msg.action === 'content_disconnected') {
      if (!isNormalStop) {
        await handleContentCrash();
      }
      isNormalStop = false; 
    }
  });
}

async function initOPFS() {
  try {
    const root = await navigator.storage.getDirectory();
    fileHandle = await root.getFileHandle('live_recording_cache.tmp', { create: true });
    writableStream = await fileHandle.createWritable({ keepExistingData: false });
    opfsInitialized = true;
    console.log('[OPFS] 高性能沙箱文件流初始化成功。');
  } catch (e) {
    showError('❌ OPFS 存储系统加载失败: ' + e.message);
  }
}

async function writeToOPFS(blob) {
  if (!opfsInitialized) {
    await initOPFS();
  }
  if (writableStream) {
    try {
      await writableStream.write(blob);
    } catch (e) {
      console.error('[OPFS] 块写入失败:', e);
    }
  }
}

async function finalizeOPFSRecording(config) {
  if (!writableStream) return;
  try {
    await writableStream.close(); 
    writableStream = null;
    opfsInitialized = false;

    const file = await fileHandle.getFile();
    if (file.size === 0) {
      console.warn('[OPFS] 检测到空视频流');
      return;
    }

    const mime = file.type || 'video/webm';
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const prefix = (config && config.filePrefix) ? config.filePrefix : '直播录制';
    const ts = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
    const filename = prefix + '_' + ts + '.' + ext;
    
    const url = URL.createObjectURL(file);

    chrome.runtime.sendMessage({
      action: 'triggerDownload',
      url: url,
      filename: filename
    }, (resp) => {
      if (resp && resp.error) {
        console.error('[OPFS] 下载唤醒失败:', resp.error);
        URL.revokeObjectURL(url);
      }
    });

    chrome.runtime.sendMessage({
      action: 'notify',
      message: '✅ 录制成功落盘！体积: ' + fmtSize(file.size)
    });
  } catch (e) {
    console.error('[OPFS] 最终落盘合并失败:', e);
  }
}

async function handleContentCrash() {
  console.warn('[OPFS] 警告：检测到网页长连接断开（网页可能崩溃）。执行紧急自愈保存...');
  if (writableStream) {
    await finalizeOPFSRecording(currentConfig);
    showError('⚠️ 直播播放页面已断开，已为您自动挽救并合并之前录制的全部视频！');
  }
  isRecording = false;
  updateUI();
}

async function clearOPFSTempFile() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('live_recording_cache.tmp');
    console.log('[OPFS] 临时落盘物理缓存已安全擦除，空间释放。');
  } catch (e) {
    console.warn('[OPFS] 缓存擦除失败:', e.message);
  }
}

function bindEvents() {
  $('qUHD').addEventListener('click', () => setQuality('uhd'));
  $('qHD').addEventListener('click',  () => setQuality('hd'));
  $('qSD').addEventListener('click',  () => setQuality('sd'));

  // 物理加固：绑定小窗控制台的主动直录强力唤醒按纽 [纠正 3]
  const activeStartBtn = $('btnActiveStart');
  if (activeStartBtn) {
    activeStartBtn.addEventListener('click', () => {
      if (!activeTabId) {
        showError('❌ 无法定位到直播源标签页');
        return;
      }
      
      const config = buildConfigForQuality(currentQuality);
      
      // 主动向原直播网页发出“一键强制直录”信号，击穿悬浮遮罩盲区
      chrome.tabs.sendMessage(activeTabId, { action: 'start_recording_now', config: config }, (response) => {
        const err = chrome.runtime.lastError;
        if (err || !response || !response.ok) {
          showError('⚠️ 原网页上未检索到正在播放的视频，无缝切换为 tabCapture 备用全页面录制...');
          
          // 若网页中没有找到播放器，100% 顺势自愈降级为直接捕获标签页录制
          chrome.runtime.sendMessage({
            action: 'startTabCaptureRecording',
            config: config
          });
        }
      });
    });
  }

  $('bigRecBtn').addEventListener('click', () => {
    if (fallbackRecorder) {
      stopFallbackRecording();
    } else if (isRecording) {
      sendToContent('stopRecording');
    }
  });

  $('btnPause').addEventListener('click', () => {
    if (!isRecording) return;
    if (isPaused) {
      if (fallbackRecorder) {
        fallbackRecorder.resume();
        isPaused = false;
        updateUI();
      } else {
        sendToContent('resumeRecording');
      }
    } else {
      if (fallbackRecorder) {
        fallbackRecorder.pause();
        isPaused = true;
        updateUI();
      } else {
        sendToContent('pauseRecording');
      }
    }
  });

  $('btnStop').addEventListener('click', () => {
    if (fallbackRecorder) {
      stopFallbackRecording();
    } else if (isRecording) {
      sendToContent('stopRecording');
    }
  });
}

// ============================================================
// tabCapture 独占保活 (静默拉流，锁死后台帧率)
// ============================================================
async function activateKeepAlive(streamId) {
  if (keepAliveStream) return;
  console.log('[recorder] 激活物理保活流, streamId:', streamId);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource  : 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      audio: {
        mandatory: {
          chromeMediaSource  : 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    keepAliveStream = stream;

    if (stream.getAudioTracks().length > 0) {
      try {
        const sysCtx = new AudioContext({ sampleRate: 48000 });
        if (sysCtx.state === 'suspended') await sysCtx.resume();
        const source = sysCtx.createMediaStreamSource(stream);
        source.connect(sysCtx.destination);
        audioContext = sysCtx;
      } catch (ae) {
        console.warn('[recorder] 绕过扬声器失败:', ae.message);
      }
    }

    const player = $('previewPlayer');
    const container = $('previewContainer');
    if (player) {
      player.srcObject = stream;
      player.play().then(() => {
        if (container) container.style.display = 'block';
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[recorder] 物理保活流建立失败:', e.message);
  }
}

function releaseKeepAlive() {
  if (keepAliveStream) {
    keepAliveStream.getTracks().forEach(track => track.stop());
    keepAliveStream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  const player = $('previewPlayer');
  const container = $('previewContainer');
  if (player) player.srcObject = null;
  if (container) container.style.display = 'none';
}

// ============================================================
// 备用 tabCapture 录制管线 (CORS Fallback)
// ============================================================
async function startFallbackRecording(config) {
  if (!keepAliveStream) {
    showError('❌ 备用录制器启动失败：保活流就绪异常');
    return;
  }

  currentTotalBytes = 0;
  fallbackSeconds = 0;

  try {
    const mime = pickMime(config.format);
    fallbackRecorder = new MediaRecorder(keepAliveStream, {
      mimeType: mime,
      videoBitsPerSecond: config.vbps || 8_000_000,
      audioBitsPerSecond: config.abps || 192_000,
    });

    fallbackRecorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        await writeToOPFS(e.data); // 直接追加写入沙箱文件
        currentTotalBytes += e.data.size;
      }
    };

    fallbackRecorder.onstop = async () => {
      await finalizeOPFSRecording(config);
    };

    fallbackRecorder.start(1000);
    isRecording = true;
    isPaused    = false;
    updateUI();

    startFallbackTimer();
    console.log('[recorder] 备用 OPFS-TabCapture 录制引擎开始运行。');
  } catch (e) {
    showError('❌ 备用引擎故障: ' + e.message);
  }
}

function stopFallbackRecording() {
  if (fallbackRecorder && fallbackRecorder.state !== 'inactive') {
    fallbackRecorder.stop();
  }
  stopFallbackTimer();
  isRecording = false;
  updateUI();
}

function startFallbackTimer() {
  stopFallbackTimer();
  fallbackTimer = setInterval(() => {
    if (isPaused) return;
    fallbackSeconds++;

    applyMetrics({
      isRecording: true,
      isPaused: isPaused,
      timeString: fmtTime(fallbackSeconds),
      sizeString: fmtSize(currentTotalBytes),
      bitrate: '8Mbps',
      resolution: QUALITY_PRESETS[currentQuality].res,
      fps: 30
    });
  }, 1000);
}

function stopFallbackTimer() {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}

function sendToContent(action, extra) {
  if (!activeTabId) {
    showError('❌ 未定位到目标页面，请重新开启');
    return;
  }
  chrome.tabs.sendMessage(
    activeTabId,
    Object.assign({ action }, extra || {}),
    () => { void chrome.runtime.lastError; }
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg._target === 'recorder') {
    switch (msg.action) {
      case 'stopRecording':
        if (fallbackRecorder) stopFallbackRecording();
        else                  sendToContent('stopRecording');
        break;
      case 'pauseRecording':
        if (fallbackRecorder) { fallbackRecorder.pause(); isPaused = true; updateUI(); }
        else                  sendToContent('pauseRecording');
        break;
      case 'resumeRecording':
        if (fallbackRecorder) { fallbackRecorder.resume(); isPaused = false; updateUI(); }
        else                  sendToContent('resumeRecording');
        break;
      case 'releaseBlobUrl':
        if (msg.url) {
          URL.revokeObjectURL(msg.url);
        }
        clearOPFSTempFile(); 
        break;
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'startTabCaptureRecording') {
    startFallbackRecording(msg.config || {});
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'stateSync' || msg.action === 'recordingStateChanged') {
    const state = msg.state || msg;
    applyState(state);
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'metricsUpdate') {
    if (!fallbackRecorder) {
      applyMetrics(msg);
    }
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false });
});

const bgPort = chrome.runtime.connect({ name: 'recorder_panel' });
bgPort.onMessage.addListener((msg) => {
  if (msg.action === 'stateSync') {
    applyState(msg.state);
  }
  if (msg.action === 'metricsUpdate' && !fallbackRecorder) {
    applyMetrics(msg);
  }
});

function applyState(state) {
  if (!state) return;
  const wasRecording = isRecording;
  isRecording = !!state.isRecording;
  isPaused    = !!state.isPaused;

  updateUI();

  if (isRecording && !wasRecording && !keepAliveStream && presetStreamId) {
    activateKeepAlive(presetStreamId);
  }

  if (!isRecording && wasRecording) {
    releaseKeepAlive();
  }

  if (state.resolution && state.resolution !== '-') {
    setText('mRes', state.resolution);
  }
  if (state.timeString) {
    setText('timerDisplay', state.timeString);
  }
  if (state.sizeString) {
    setText('mSize', state.sizeString);
  }
}

function applyMetrics(msg) {
  isRecording = !!msg.isRecording;
  isPaused    = !!msg.isPaused;
  updateUI();

  if (msg.timeString) setText('timerDisplay', msg.timeString);
  
  const sizeToDisplay = currentTotalBytes > 0 ? currentTotalBytes : (parseInt(msg.sizeString) || 0);
  setText('mSize', fmtSize(sizeToDisplay));
  
  if (msg.bitrate)    setText('mBitrate', msg.bitrate);
  if (msg.resolution) setText('mRes', msg.resolution);
  if (msg.fps)        setText('mFps', String(msg.fps));
  setText('footerInfo', '已录制 ' + fmtSize(sizeToDisplay));
}

function updateUI() {
  const dot     = $('statusDot');
  const txt     = $('statusText');
  const timer   = $('timerDisplay');
  const recDot  = $('recDot');
  const hint    = $('hintBox');
  const ctrls   = $('recControls');
  const bigBtn  = $('bigRecBtn');
  const bigLbl  = $('bigRecLabel');
  const pBtn    = $('btnPause');

  if (isRecording && !isPaused) {
    dot.className    = 'status-indicator recording';
    txt.textContent  = fallbackRecorder ? '🔴 正在以备用引擎捕获直播(勿切屏)...' : '🔴 正在以极客引擎直录纯净视频...';
    timer.className  = 'timer-display recording';
    recDot.style.display = 'block';
    hint.style.display   = 'none';
    ctrls.style.display  = 'flex';
    bigBtn.className = 'big-rec-btn recording';
    bigLbl.textContent = '点击停止';
    if (pBtn) { pBtn.disabled = false; pBtn.textContent = '⏸ 暂停'; }
  } else if (isPaused) {
    dot.className    = 'status-indicator paused';
    txt.textContent  = '⏸ 录制已暂停';
    timer.className  = 'timer-display paused';
    recDot.style.display = 'block';
    hint.style.display   = 'none';
    ctrls.style.display  = 'flex';
    bigBtn.className = 'big-rec-btn paused';
    bigLbl.textContent = '已暂停';
    if (pBtn) { pBtn.disabled = false; pBtn.textContent = '▶ 继续'; }
  } else {
    dot.className    = 'status-indicator ready';
    txt.textContent  = '就绪 — 请在网页直播视频上点击「⏺ 开始录制」';
    timer.className  = 'timer-display';
    setText('timerDisplay', '00:00:00');
    recDot.style.display = 'none';
    hint.style.display   = 'block';
    ctrls.style.display  = 'none';
    setText('footerInfo', '等待录制...');
    if (pBtn) { pBtn.disabled = true; pBtn.textContent = '⏸ 暂停'; }
  }
}

function setQuality(q) {
  if (!QUALITY_PRESETS[q]) return;
  currentQuality = q;
  setQualityHighlight(q);
  updateFormat();

  if (isRecording && !fallbackRecorder) {
    sendToContent('updateConfig', { config: buildConfigForQuality(q) });
  }
}

function setQualityHighlight(q) {
  ['qUHD', 'qHD', 'qSD'].forEach((k) => {
    const el = $(k);
    if (el) el.classList.toggle('active', k === 'q' + q.toUpperCase());
  });
}

function buildConfigForQuality(q) {
  const p = QUALITY_PRESETS[q];
  return {
    quality  : q,
    vbps     : p.vbps,
    abps     : p.abps,
    fps      : p.fps,
    sysAudio : true,
    micAudio : false,
    noAudio  : false,
    format   : 'mp4',
    filePrefix: '直播录制',
  };
}

function updateFormat() {
  const mime = [
    'video/mp4;codecs=avc1.64001F,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ].find(m => MediaRecorder.isTypeSupported(m));

  setText('mFormat', mime ? 'MP4 H.264' : 'WebM');
  setText('mRes', QUALITY_PRESETS[currentQuality].res);
}

function pickMime(format) {
  const mp4Candidates = [
    'video/mp4;codecs=avc1.64001F,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ];
  const webmCandidates = [
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  const list = format === 'mp4' ? mp4Candidates : webmCandidates;
  return list.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

function fmtSize(b) {
  b = b || 0;
  if (b < 1024)       return b + 'B';
  if (b < 1048576)    return (b / 1024).toFixed(1) + 'KB';
  if (b < 1073741824) return (b / 1048576).toFixed(2) + 'MB';
  return (b / 1073741824).toFixed(2) + 'GB';
}

function fmtTime(s) {
  s = s || 0;
  return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60]
    .map(n => String(n).padStart(2,'0')).join(':');
}

function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function showError(msg) {
  const el = $('errorBar');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

init();
