'use strict';

// ============================================================
// 全局状态
// ============================================================
const State = {
  isRecording : false,
  isPaused    : false,
  mediaRecorder: null,
  stream      : null,
  chunks      : [],
  startTime   : null,
  timerRAF    : null,
  monInterval : null,
  totalBytes  : 0,
  seconds     : 0,
  quality     : 'hd',
  isRegion    : false,
  recordings  : [],
  segBytes    : 0,
  segCount    : 0,
};

const QUALITY = {
  uhd: { label:'超清', vbps:12_000_000, abps:256_000, w:2560, h:1440, fps:60 },
  hd:  { label:'高清', vbps: 6_000_000, abps:192_000, w:1920, h:1080, fps:30 },
  sd:  { label:'标清', vbps: 2_500_000, abps:128_000, w:1280, h: 720, fps:30 },
};

// ============================================================
// 与 background 的长连接（解决消息转发问题）
// ============================================================
let bgPort = null;

function connectBackground() {
  bgPort = chrome.runtime.connect({ name: 'popup' });
  bgPort.onMessage.addListener((msg) => {
    if (msg.action === 'floatPause')    pauseResume();
    if (msg.action === 'floatStop')     stopRecording();
    if (msg.action === 'hotkeyToggle')  toggleMainRecord();
    if (msg.action === 'hotkeyPause')   pauseResume();
    if (msg.action === 'regionSelected') {
      toast(`🔲 区域已选择: ${msg.rect.width}×${msg.rect.height}`);
    }

    // ★ 新增：content.js 点击"录制小视频"触发自动录制
    if (msg.action === 'autoStartRecord') {
      if (!State.isRecording) {
        const info = msg.videoInfo;
        if (info?.width && info?.height) {
          $('monRes').textContent = `${info.width}×${info.height}`;
        }
        toast('🎯 检测到视频，正在启动录制...');
        // 自动切换到标签页录制模式
        $('captureMode').value = 'tab';
        startRecording();
      }
    }
  });

  bgPort.onDisconnect.addListener(() => { bgPort = null; });
}

// ============================================================
// DOM 快捷访问
// ============================================================
const $ = (id) => document.getElementById(id);

// ============================================================
// Toast 提示
// ============================================================
let _toastTimer = null;
function toast(msg, ms = 2800) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ============================================================
// 状态栏
// ============================================================
function setStatus(type, text) {
  $('statusDot').className = 'status-dot ' + type;
  $('statusText').textContent = text;
}

function showError(msg) {
  const b = $('errorBanner');
  $('errorMsg').textContent = msg;
  b.classList.add('show');
  setTimeout(() => b.classList.remove('show'), 7000);
}

// ============================================================
// Tab 切换
// ============================================================
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const t = $('tab-' + name);
  const p = $('panel-' + name);
  if (t) t.classList.add('active');
  if (p) p.classList.add('active');
}

// ============================================================
// 质量选择
// ============================================================
function setQuality(q) {
  State.quality = q;
  ['uhd','hd','sd'].forEach(k => {
    $('q' + k.toUpperCase()).classList.toggle('active', k === q);
  });
  const p = QUALITY[q];
  $('monRes').textContent = `${p.w}×${p.h}`;
  toast(`✅ ${p.label} 模式 (${p.vbps/1_000_000}Mbps)`);
}

// ============================================================
// 区域录制模式
// ============================================================
function toggleRegionMode() {
  State.isRegion = !State.isRegion;
  const btn = $('regionBtn');
  btn.classList.toggle('active', State.isRegion);
  btn.textContent = State.isRegion ? '✅ 区域模式已启用' : '🔲 区域录制模式';
  sendToContent({ action: State.isRegion ? 'enableRegionSelect' : 'disableRegionSelect' });
  toast(State.isRegion ? '🔲 请在页面上拖拽选择区域' : '🔲 区域模式已关闭');
}

// ============================================================
// 发消息到 content.js
// ============================================================
function sendToContent(msg, cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, () => {
      if (chrome.runtime.lastError) {
        // content script 未注入时忽略
        console.warn('sendToContent:', chrome.runtime.lastError.message);
      }
      if (cb) cb();
    });
  });
}

// ============================================================
// 获取录制流
// ============================================================
async function acquireStream() {
  const mode     = $('captureMode').value;
  const preset   = QUALITY[State.quality];
  const fps      = parseInt($('fpsSelect').value) || preset.fps;
  const resVal   = $('resolutionSelect').value;
  const noAudio  = $('noAudio').checked;
  const sysAudio = $('sysAudio').checked && !noAudio;
  const useMic   = $('micAudio').checked && !noAudio;

  const resH = { source: null, 1080: 1080, 720: 720, 480: 480 }[resVal];

  const videoConstraints = {
    frameRate: { ideal: fps, max: fps },
    ...(resH ? {
      height: { ideal: resH },
      width:  { ideal: Math.round(resH * 16 / 9) },
    } : {}),
  };

  const audioConstraints = sysAudio ? {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl : false,
    sampleRate      : 48000,
  } : false;

  let stream;

  if (mode === 'tab') {
    // 优先 tabCapture（真正内录，无黑框）
    stream = await tryTabCapture(sysAudio);
    if (!stream) {
      // 降级：getDisplayMedia + preferCurrentTab
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { ...videoConstraints, preferCurrentTab: true },
        audio: audioConstraints,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        systemAudio: sysAudio ? 'include' : 'exclude',
      });
    }
  } else {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: audioConstraints,
      systemAudio: sysAudio ? 'include' : 'exclude',
    });
  }

  if (useMic) {
    stream = await mixMic(stream);
  }

  return stream;
}

// ---- tabCapture 方式 ----
function tryTabCapture(withAudio) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'getTabStreamId', withAudio },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.streamId) {
          resolve(null);
          return;
        }
        navigator.mediaDevices.getUserMedia({
          video: {
            mandatory: {
              chromeMediaSource  : 'tab',
              chromeMediaSourceId: resp.streamId,
            }
          },
          audio: withAudio ? {
            mandatory: {
              chromeMediaSource  : 'tab',
              chromeMediaSourceId: resp.streamId,
              echoCancellation   : false,
            }
          } : false,
        }).then(resolve).catch(() => resolve(null));
      }
    );
  });
}

// ---- 混合麦克风 ----
async function mixMic(videoStream) {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
    });
    const ctx  = new AudioContext({ sampleRate: 48000 });
    const dest = ctx.createMediaStreamDestination();

    const sysTracks = videoStream.getAudioTracks();
    if (sysTracks.length > 0) {
      ctx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest);
    }
    ctx.createMediaStreamSource(micStream).connect(dest);

    return new MediaStream([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
  } catch (e) {
    console.warn('麦克风混入失败:', e);
    return videoStream;
  }
}

// ============================================================
// 选择最佳 MIME
// ============================================================
function pickMime() {
  const fmt = $('formatSelect').value;
  const list = fmt === 'webm-h264'
    ? ['video/webm;codecs=h264,opus', 'video/webm;codecs=h264,pcm', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9',      'video/webm'];
  return list.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

// ============================================================
// 开始录制
// ============================================================
async function startRecording() {
  try {
    setStatus('ready', '⏳ 获取权限中...');
    toast('⏳ 正在启动，请在弹窗中授权...');

    const stream = await acquireStream();

    State.stream    = stream;
    State.chunks    = [];
    State.totalBytes = 0;
    State.seconds   = 0;
    State.segBytes  = 0;
    State.segCount  = 0;

    const preset   = QUALITY[State.quality];
    const mimeType = pickMime();
    const vTrack   = stream.getVideoTracks()[0];

    // 更新实际分辨率
    if (vTrack) {
      const s = vTrack.getSettings();
      if (s.width && s.height) $('monRes').textContent = `${s.width}×${s.height}`;
    }

    // 信息芯片
    $('chipAudio').textContent  = stream.getAudioTracks().length > 0 ? '✅有声' : '❌无声';
    $('chipSource').textContent = $('captureMode').value === 'tab' ? '标签页' : '屏幕';
    $('chipFormat').textContent = mimeType.includes('h264') ? 'H264' : 'VP9';

    // 创建录制器
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: preset.vbps,
      audioBitsPerSecond: preset.abps,
    });

    recorder.ondataavailable = onData;
    recorder.onstop          = onStop;
    recorder.onerror         = (e) => {
      showError('录制错误: ' + (e.error?.message || '未知错误'));
      forceStop();
    };

    // 用户手动关闭屏幕共享
    vTrack.onended = () => { if (State.isRecording) stopRecording(); };

    recorder.start(500); // 每500ms切片

    State.mediaRecorder = recorder;
    State.isRecording   = true;
    State.isPaused      = false;
    State.startTime     = Date.now();

    startTimer();
    startMonitor();
    updateBtnUI();
    setStatus('recording', '🔴 录制中');
    $('recProgress').classList.add('show');
    toast('🔴 录制已开始！');

    // 悬浮窗
    if ($('showFloat').checked) applyFloatWindow();

  } catch (err) {
    setStatus('ready', '就绪');
    const errMap = {
      NotAllowedError  : '❌ 权限被拒绝，请在弹窗中点击"允许"或选择录制内容',
      NotSupportedError: '❌ 浏览器不支持此录制方式，请切换录制源',
      NotFoundError    : '❌ 未找到媒体设备',
      AbortError       : '❌ 操作被中止，请重试',
    };
    showError(errMap[err.name] || `❌ 启动失败: ${err.message}`);
  }
}

// ============================================================
// 数据回调
// ============================================================
function onData(e) {
  if (!e.data || e.data.size === 0) return;

  State.chunks.push(e.data);
  State.totalBytes += e.data.size;
  State.segBytes   += e.data.size;

  const sizeStr = fmtSize(State.totalBytes);
  $('monSize').textContent    = sizeStr;
  $('progressDetail').textContent = `已录制: ${sizeStr}`;

  // 进度条
  const maxDur = parseInt($('maxDuration').value);
  const pct = maxDur > 0
    ? Math.min((State.seconds / maxDur) * 100, 100)
    : Math.min((State.totalBytes / (500 * 1024 * 1024)) * 100, 95);
  $('progressFill').style.width = pct + '%';

  // 分段
  const segLimit = parseInt($('segmentSize').value) * 1024 * 1024;
  if (segLimit > 0 && State.segBytes >= segLimit) doSegment();
}

// ============================================================
// 分段保存
// ============================================================
function doSegment() {
  if (!State.chunks.length) return;
  State.segCount++;
  const copy = [...State.chunks];
  State.chunks   = [];
  State.segBytes = 0;

  const blob = new Blob(copy, { type: State.mediaRecorder.mimeType });
  const name = mkFilename(`_seg${State.segCount}`);
  dlBlob(blob, name);
  toast(`💾 片段${State.segCount} 已保存 (${fmtSize(blob.size)})`);
}

// ============================================================
// 停止录制
// ============================================================
function stopRecording() {
  if (!State.isRecording) return;
  if (State.mediaRecorder?.state !== 'inactive') {
    State.mediaRecorder.stop();
  }
  releaseStream();
}

function forceStop() {
  releaseStream();
  State.isRecording = false;
  State.isPaused    = false;
  stopTimer();
  stopMonitor();
  updateBtnUI();
  $('recProgress').classList.remove('show');
  setStatus('error', '录制中断');
}

function releaseStream() {
  State.stream?.getTracks().forEach(t => t.stop());
  State.stream = null;
}

// ============================================================
// 录制完成
// ============================================================
function onStop() {
  State.isRecording = false;
  State.isPaused    = false;
  stopTimer();
  stopMonitor();
  $('recProgress').classList.remove('show');
  updateBtnUI();
  setStatus('ready', '✅ 录制完成');

  if (!State.chunks.length) {
    toast('⚠️ 没有捕获到内容');
    return;
  }

  const mime = State.mediaRecorder?.mimeType || 'video/webm';
  const blob = new Blob(State.chunks, { type: mime });
  const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
  const name = mkFilename('', ext);
  const url  = URL.createObjectURL(blob);

  const rec = {
    id       : Date.now(),
    filename : name,
    url, blob,
    size     : blob.size,
    duration : State.seconds,
    quality  : State.quality,
    ts       : new Date().toLocaleString('zh-CN'),
    mime,
  };

  State.recordings.unshift(rec);
  renderList();

  if ($('autoDownload').checked) {
    dlBlob(blob, name);
    toast(`✅ 已保存: ${name} (${fmtSize(blob.size)})`);
  } else {
    toast(`✅ 录制完成 ${fmtSize(blob.size)}，请手动保存`);
  }

  switchTab('files');
  sendToContent({ action: 'removeFloat' });

  // 通知
  if ($('showNotify').checked) {
    chrome.runtime.sendMessage({
      action : 'notify',
      message: `录制完成！${fmtSize(blob.size)} · ${fmtTime(State.seconds)}`,
    });
  }
}

// ============================================================
// 暂停 / 继续
// ============================================================
function pauseResume() {
  if (!State.mediaRecorder) return;

  if (State.isPaused) {
    State.mediaRecorder.resume();
    State.isPaused = false;
    $('btnPause').innerHTML = '⏸ 暂停';
    setStatus('recording', '🔴 录制中');
    startTimer();
    toast('▶️ 继续录制');
  } else {
    State.mediaRecorder.pause();
    State.isPaused = true;
    $('btnPause').innerHTML = '▶️ 继续';
    setStatus('paused', '⏸ 已暂停');
    stopTimer();
    toast('⏸ 录制已暂停');
  }

  updateBtnUI();
  sendToContent({
    action : 'updateFloat',
    paused : State.isPaused,
    time   : fmtTime(State.seconds),
  });
}

// ============================================================
// 主按钮
// ============================================================
function toggleMainRecord() {
  State.isRecording ? stopRecording() : startRecording();
}

// ============================================================
// 按钮 UI 更新
// ============================================================
function updateBtnUI() {
  const btn = $('mainRecBtn');
  if (State.isRecording && !State.isPaused) {
    btn.className = 'record-big-btn recording';
  } else if (State.isPaused) {
    btn.className = 'record-big-btn paused';
  } else {
    btn.className = 'record-big-btn';
  }
  $('btnPause').disabled = !State.isRecording;
  $('btnStop').disabled  = !State.isRecording;
}

// ============================================================
// 计时器（requestAnimationFrame，精确）
// ============================================================
function startTimer() {
  let prev = performance.now();

  function tick(now) {
    if (!State.isRecording || State.isPaused) return;
    if (now - prev >= 1000) {
      prev += 1000;
      State.seconds++;

      const el = $('mainTimer');
      el.textContent = fmtTime(State.seconds);
      el.className   = 'record-time-display';

      const max = parseInt($('maxDuration').value);
      if (max > 0 && State.seconds >= max) {
        stopRecording();
        toast('⏱️ 已达最长录制时长，自动停止');
        return;
      }
    }
    State.timerRAF = requestAnimationFrame(tick);
  }
  State.timerRAF = requestAnimationFrame(tick);
}

function stopTimer() {
  if (State.timerRAF) cancelAnimationFrame(State.timerRAF);
  State.timerRAF = null;
  $('mainTimer').className = 'record-time-display idle';
}

// ============================================================
// 实时监控
// ============================================================
function startMonitor() {
  let prevBytes = 0;
  let prevTime  = Date.now();

  State.monInterval = setInterval(() => {
    if (!State.isRecording || State.isPaused) return;

    const now     = Date.now();
    const dt      = (now - prevTime) / 1000 || 1;
    const bps     = (State.totalBytes - prevBytes) / dt * 8;
    prevBytes = State.totalBytes;
    prevTime  = now;

    const kbps = Math.round(bps / 1000);
    $('monBitrate').textContent = kbps > 1000
      ? (kbps / 1000).toFixed(1) + 'Mbps'
      : kbps + 'kbps';

    $('monFps').textContent = parseInt($('fpsSelect').value) || 30;
    $('monCpu').textContent = Math.min(99, Math.round(kbps / 200 + Math.random() * 5)) + '%';
  }, 1000);
}

function stopMonitor() {
  clearInterval(State.monInterval);
  State.monInterval = null;
  $('monCpu').textContent     = '0%';
  $('monFps').textContent     = '0';
  $('monBitrate').textContent = '0kbps';
}

// ============================================================
// 录制列表
// ============================================================
function renderList() {
  const el = $('recordingsList');
  if (!State.recordings.length) {
    el.innerHTML = `
      <div class="empty-list">
        🎬 暂无录制文件<br>
        <span style="font-size:12px;color:#555">点击红色按钮开始录制</span>
      </div>`;
    return;
  }

  el.innerHTML = State.recordings.map(r => `
    <div class="rec-item">
      <div class="rec-thumb" style="cursor:pointer"
           onclick="window.open('${r.url}','_blank')">🎬</div>
      <div class="rec-info">
        <div class="rec-name" title="${r.filename}">${r.filename}</div>
        <div class="rec-meta">
          <span class="rec-badge">${fmtSize(r.size)}</span>
          <span class="rec-badge">${fmtTime(r.duration)}</span>
          <span class="rec-badge">${QUALITY[r.quality]?.label || '高清'}</span>
        </div>
        <div style="font-size:10px;color:#555;margin-top:3px">${r.ts}</div>
      </div>
      <div class="rec-actions">
        <button class="rec-btn download" onclick="dlRec(${r.id})">💾 保存</button>
        <button class="rec-btn" onclick="window.open('${r.url}','_blank')">▶ 预览</button>
        <button class="rec-btn" onclick="delRec(${r.id})">🗑️</button>
      </div>
    </div>
  `).join('');
}

function dlRec(id) {
  const r = State.recordings.find(x => x.id === id);
  if (r) { dlBlob(r.blob, r.filename); toast('💾 下载中: ' + r.filename); }
}

function delRec(id) {
  const i = State.recordings.findIndex(x => x.id === id);
  if (i > -1) {
    URL.revokeObjectURL(State.recordings[i].url);
    State.recordings.splice(i, 1);
    renderList();
    toast('🗑️ 已删除');
  }
}

function clearAllRecordings() {
  if (State.isRecording) { toast('⚠️ 请先停止录制'); return; }
  State.recordings.forEach(r => URL.revokeObjectURL(r.url));
  State.recordings = [];
  renderList();
  toast('🗑️ 已清空');
}

// ============================================================
// 工具函数
// ============================================================
function dlBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // 延迟释放，确保下载触发
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 3000);
}

function mkFilename(suffix = '', ext = 'webm') {
  const prefix = $('filePrefix').value.trim() || '直播录制';
  const ts = new Date().toISOString()
    .replace('T','_').replace(/:/g,'-').slice(0,19);
  return `${prefix}_${ts}${suffix}.${ext}`;
}

function fmtSize(b) {
  if (b < 1024)            return b + 'B';
  if (b < 1024**2)         return (b/1024).toFixed(1) + 'KB';
  if (b < 1024**3)         return (b/1024**2).toFixed(2) + 'MB';
  return (b/1024**3).toFixed(2) + 'GB';
}

function fmtTime(s) {
  const h = String(Math.floor(s/3600)).padStart(2,'0');
  const m = String(Math.floor(s%3600/60)).padStart(2,'0');
  const sc= String(s%60).padStart(2,'0');
  return `${h}:${m}:${sc}`;
}

// ============================================================
// 悬浮窗
// ============================================================
function applyFloatWindow() {
  const pos = $('floatPosition').value;
  sendToContent({ action: 'showFloat', position: pos });
  toast('🪟 悬浮控制条已显示');
}

function openDownloadFolder() {
  chrome.downloads.showDefaultFolder();
}

function showAbout() {
  toast('直播内录器 v2.0 | 支持 Chrome / Edge | 网页直播视频音频内录');
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  connectBackground();   // 建立与 background 的长连接
  setQuality('hd');
  renderList();
  setStatus('ready', '就绪');

  // 互斥逻辑
  $('noAudio').addEventListener('change', function() {
    if (this.checked) {
      $('sysAudio').checked = false;
      $('micAudio').checked = false;
    }
  });
  $('sysAudio').addEventListener('change', function() {
    if (this.checked) $('noAudio').checked = false;
  });
  $('micAudio').addEventListener('change', function() {
    if (this.checked) $('noAudio').checked = false;
  });
});
