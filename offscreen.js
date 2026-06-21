'use strict';

// ============================================================
// Offscreen Document - 数据面（长生命周期）
// 修复：
//   1. onRecorderStop 中 formatSize(totalBytes) →
//      fmtSize(REC.totalBytes)（变量名错误修复）
//   2. AudioContext Autoplay 挂起补丁（ctx.resume()）
//   3. requestStreamId 传递精确 tabId（消除时序竞争）
//   4. cleanupResources 切断 mediaRecorder 强引用
// ============================================================

const REC = {
  mediaRecorder : null,
  stream        : null,
  audioCtx      : null,
  chunks        : [],
  totalBytes    : 0,
  seconds       : 0,
  isPaused      : false,
  config        : null,
  timerInterval : null,
  monInterval   : null,
  prevBytes     : 0,
  prevTime      : 0,
  currentBitrate: '0kbps',
};

// ============================================================
// 消息监听
// ============================================================
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req._target !== 'offscreen') return;

  switch (req.action) {

    case 'startRecording':
      startPipeline(req.config)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.error('[offscreen] startRecording error:', e);
          notifyStateChanged(false, false);
          sendResponse({ error: e.message });
        });
      return true; // 异步

    case 'pauseRecording':
      doPause();
      sendResponse({ ok: true });
      break;

    case 'resumeRecording':
      doResume();
      sendResponse({ ok: true });
      break;

    case 'stopRecording':
      doStop();
      sendResponse({ ok: true });
      break;

    case 'releaseBlobUrl':
      // 下载完成 → 安全回收 Blob URL（Law-39）
      if (req.url) {
        URL.revokeObjectURL(req.url);
        console.log('[offscreen] Blob URL released:', req.url);
      }
      // 清空 chunks，释放内存
      REC.chunks = [];
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false, msg: 'unknown_action' });
  }
});

// ============================================================
// 录制管线启动
// ============================================================
async function startPipeline(config) {
  if (REC.mediaRecorder && REC.mediaRecorder.state !== 'inactive') {
    throw new Error('Recording pipeline already active');
  }

  // 重置所有状态
  REC.chunks        = [];
  REC.totalBytes    = 0;
  REC.seconds       = 0;
  REC.isPaused      = false;
  REC.prevBytes     = 0;
  REC.prevTime      = performance.now();
  REC.config        = config || {};
  REC.currentBitrate = '0kbps';

  // 1. 获取 Tab Capture 流
  //    ★ 修复：传入精确的 tabId，消除时序竞争（P2修复）
  const audioEnabled = !!(config.sysAudio && !config.noAudio);
  const streamId = await requestStreamId(audioEnabled, config.tabId);

  let stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource  : 'tab',
        chromeMediaSourceId: streamId,
        ...(config.fps ? { frameRate: config.fps } : {}),
      },
    },
    audio: audioEnabled
      ? {
          mandatory: {
            chromeMediaSource  : 'tab',
            chromeMediaSourceId: streamId,
            echoCancellation   : false,
          },
        }
      : false,
  });

  // 2. 混入麦克风
  if (config.micAudio && !config.noAudio) {
    stream = await mixMicrophone(stream);
  }

  REC.stream = stream;

  // 3. 监听用户关闭屏幕共享
  const vTrack = stream.getVideoTracks()[0];
  if (vTrack) {
    vTrack.onended = () => {
      if (REC.mediaRecorder && REC.mediaRecorder.state !== 'inactive') {
        doStop();
      }
    };

    // 记录实际分辨率
    const settings = vTrack.getSettings();
    if (settings.width && settings.height) {
      REC.config._resolution = settings.width + 'x' + settings.height;
    }
  }

  // 4. 选择最佳 MIME Type
  const mimeType = pickMime(config.format);

  // 5. 创建 MediaRecorder
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: config.vbps || 6_000_000,
    audioBitsPerSecond: config.abps || 192_000,
  });

  recorder.ondataavailable = onData;
  recorder.onstop          = onRecorderStop;
  recorder.onerror         = (e) => {
    console.error('[offscreen] MediaRecorder error:', e.error);
    notifyStateChanged(false, false);
    cleanupResources();
  };

  // 每 500ms 收集一次切片
  recorder.start(500);
  REC.mediaRecorder = recorder;

  startTimers();
  notifyStateChanged(true, false);
}

// ============================================================
// 数据收集
// ============================================================
function onData(e) {
  if (!e.data || e.data.size === 0) return;
  REC.chunks.push(e.data);
  REC.totalBytes += e.data.size;
}

// ============================================================
// 暂停
// ============================================================
function doPause() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state !== 'recording') return;
  REC.mediaRecorder.pause();
  REC.isPaused = true;
  notifyStateChanged(true, true);
}

// ============================================================
// 继续
// ============================================================
function doResume() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state !== 'paused') return;
  REC.mediaRecorder.resume();
  REC.isPaused = false;
  notifyStateChanged(true, false);
}

// ============================================================
// 停止
// ============================================================
function doStop() {
  if (!REC.mediaRecorder || REC.mediaRecorder.state === 'inactive') return;
  // stop() 会触发 onstop 回调
  REC.mediaRecorder.stop();
  cleanupResources();
}

// ============================================================
// 录制完成 → 生成 Blob → 触发安全下载
// ============================================================
function onRecorderStop() {
  stopTimers();

  if (!REC.chunks.length) {
    console.warn('[offscreen] No data recorded');
    notifyStateChanged(false, false);
    return;
  }

  // ★ 修复：使用 REC.mediaRecorder.mimeType 而非可能已被清空的引用
  const mime = (REC.mediaRecorder && REC.mediaRecorder.mimeType)
    ? REC.mediaRecorder.mimeType
    : 'video/webm';

  const blob     = new Blob(REC.chunks, { type: mime });
  const ext      = mime.includes('mp4') ? 'mp4' : 'webm';
  const prefix   = (REC.config && REC.config.filePrefix) ? REC.config.filePrefix : '直播录制';
  const ts       = new Date().toISOString()
    .replace('T', '_').replace(/:/g, '-').slice(0, 19);
  const filename = prefix + '_' + ts + '.' + ext;

  // 创建 Blob URL（生命周期由 background 在下载完成后回收）
  const blobUrl = URL.createObjectURL(blob);

  // ★ 修复：使用 REC.totalBytes（不是未定义的 totalBytes）
  const finalSize = REC.totalBytes;

  // 通知 background 执行安全下载
  chrome.runtime.sendMessage(
    { action: 'triggerDownload', url: blobUrl, filename },
    (resp) => {
      if (resp && resp.error) {
        console.error('[offscreen] triggerDownload failed:', resp.error);
        // 下载失败立即回收
        URL.revokeObjectURL(blobUrl);
        REC.chunks = [];
      }
    }
  );

  // 发送完成通知
  chrome.runtime.sendMessage({
    action : 'notify',
    // ★ 修复：使用局部变量 finalSize
    message: '录制完成！' + fmtSize(finalSize) + ' · ' + fmtTime(REC.seconds),
  });

  notifyStateChanged(false, false);
}

// ============================================================
// 资源完整释放（Law-32/39）
// ============================================================
function cleanupResources() {
  // 停止所有媒体轨道
  if (REC.stream) {
    REC.stream.getTracks().forEach((t) => t.stop());
    REC.stream = null;
  }

  // ★ 关闭 AudioContext，根除僵尸音频句柄（Law-32）
  if (REC.audioCtx) {
    REC.audioCtx.close().catch((e) => {
      console.warn('[offscreen] AudioContext.close() error:', e);
    });
    REC.audioCtx = null;
  }

  // ★ 切断 MediaRecorder 强引用，允许 GC 回收（Law-41）
  REC.mediaRecorder = null;

  stopTimers();
}

// ============================================================
// 混入麦克风
// ★ 修复：Autoplay Policy 补丁，主动 resume() 挂起的 AudioContext
// ============================================================
async function mixMicrophone(videoStream) {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate      : 48000,
      },
    });

    const ctx  = new AudioContext({ sampleRate: 48000 });

    // ★ 修复：Offscreen Document 无用户手势，AudioContext 默认 suspended
    //         必须主动调用 resume() 才能激活（Law-52）
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    // 再次确认状态（某些浏览器版本 resume 后可能仍处于异常状态）
    if (ctx.state !== 'running') {
      console.warn('[offscreen] AudioContext state after resume:', ctx.state);
    }

    const dest = ctx.createMediaStreamDestination();

    // 混入系统音轨
    const sysTracks = videoStream.getAudioTracks();
    if (sysTracks.length > 0) {
      ctx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest);
    }

    // 混入麦克风轨
    ctx.createMediaStreamSource(micStream).connect(dest);

    // ★ 托管至 REC，确保 cleanupResources 时能正确关闭（Law-32）
    REC.audioCtx = ctx;

    return new MediaStream([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
  } catch (e) {
    console.warn('[offscreen] mixMicrophone failed:', e.message);
    return videoStream; // 降级：不混麦克风，继续录制
  }
}

// ============================================================
// 计时器与性能监控（高精度时序，Law-46）
// ============================================================
function startTimers() {
  stopTimers();

  // 秒级计时器
  REC.timerInterval = setInterval(() => {
    if (REC.isPaused) return;
    REC.seconds++;
    pushMetrics();
  }, 1000);

  // 码率监控（使用 performance.now() 真实物理时差，消除 setInterval 漂移）
  REC.prevTime  = performance.now();
  REC.prevBytes = 0;

  REC.monInterval = setInterval(() => {
    if (REC.isPaused) return;

    const now = performance.now();
    // ★ 真实物理流逝时间，最小值 10ms 防除零（Law-46）
    const dt  = Math.max((now - REC.prevTime) / 1000, 0.01);
    const bps = ((REC.totalBytes - REC.prevBytes) / dt) * 8;

    REC.prevBytes = REC.totalBytes;
    REC.prevTime  = now;

    const kbps = Math.round(bps / 1000);
    REC.currentBitrate = kbps > 1000
      ? (kbps / 1000).toFixed(1) + 'Mbps'
      : kbps + 'kbps';
  }, 1000);
}

function stopTimers() {
  if (REC.timerInterval) { clearInterval(REC.timerInterval); REC.timerInterval = null; }
  if (REC.monInterval)   { clearInterval(REC.monInterval);   REC.monInterval   = null; }
}

// ============================================================
// 向 background 推送实时指标
// ============================================================
function pushMetrics() {
  const resolution = (REC.config && REC.config._resolution)
    ? REC.config._resolution
    : getResolution();

  chrome.runtime.sendMessage({
    action     : 'metricsUpdate',
    isRecording: true,
    isPaused   : REC.isPaused,
    timeString : fmtTime(REC.seconds),
    sizeString : fmtSize(REC.totalBytes),
    bitrate    : REC.currentBitrate,
    resolution,
  }).catch(() => {}); // background 可能短暂休眠，忽略
}

// ============================================================
// 向 background 通知录制状态变更
// ============================================================
function notifyStateChanged(isRecording, isPaused) {
  chrome.runtime.sendMessage({
    action: 'recordingStateChanged',
    state : {
      isRecording,
      isPaused,
      seconds   : REC.seconds,
      sizeString: fmtSize(REC.totalBytes),
      timeString: fmtTime(REC.seconds),
      resolution: (REC.config && REC.config._resolution)
        ? REC.config._resolution
        : getResolution(),
    },
  }).catch(() => {});
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 向 background 请求 Tab Stream ID
 * ★ 修复：传入精确 tabId，消除多窗口时序竞争（P2修复）
 */
function requestStreamId(withAudio, tabId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'getTabStreamId', withAudio, tabId },
      (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp || !resp.streamId) {
          reject(new Error(resp ? resp.error : 'No streamId returned'));
          return;
        }
        resolve(resp.streamId);
      }
    );
  });
}

function pickMime(format) {
  const candidates = (format === 'webm-h264')
    ? [
        'video/webm;codecs=h264,opus',
        'video/webm;codecs=h264,pcm',
        'video/webm;codecs=vp9,opus',
        'video/webm',
      ]
    : [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm',
      ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

function getResolution() {
  if (!REC.stream) return '-';
  const track    = REC.stream.getVideoTracks()[0];
  if (!track) return '-';
  const settings = track.getSettings();
  return (settings && settings.width && settings.height)
    ? settings.width + 'x' + settings.height
    : '-';
}

function fmtSize(b) {
  b = b || 0;
  if (b < 1024)              return b + 'B';
  if (b < 1024 * 1024)       return (b / 1024).toFixed(1) + 'KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + 'MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
}

function fmtTime(s) {
  s = s || 0;
  const h  = String(Math.floor(s / 3600)).padStart(2, '0');
  const m  = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sc = String(s % 60).padStart(2, '0');
  return h + ':' + m + ':' + sc;
}
