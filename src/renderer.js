const sourcesGrid = document.getElementById('sourcesGrid');
const refreshSourcesBtn = document.getElementById('refreshSources');
const qualitySelect = document.getElementById('qualitySelect');
const qualityHint = document.getElementById('qualityHint');
const resolutionSelect = document.getElementById('resolutionSelect');
const captureModeSelect = document.getElementById('captureModeSelect');
const captureModeInfoBtn = document.getElementById('captureModeInfoBtn');
const captureModeInfo = document.getElementById('captureModeInfo');
const fpsSelect = document.getElementById('fpsSelect');
const micToggle = document.getElementById('micToggle');
const systemAudioToggle = document.getElementById('systemAudioToggle');
const outputDirInput = document.getElementById('outputDir');
const chooseFolderBtn = document.getElementById('chooseFolder');
const recordBtn = document.getElementById('recordBtn');
const recDot = document.getElementById('recDot');
const recTimer = document.getElementById('recTimer');
const encodeProgressWrap = document.getElementById('encodeProgressWrap');
const encodeProgress = document.getElementById('encodeProgress');
const resultBox = document.getElementById('resultBox');

const regionToggle = document.getElementById('regionToggle');
const chooseRegionBtn = document.getElementById('chooseRegionBtn');
const regionHint = document.getElementById('regionHint');
const regionModal = document.getElementById('regionModal');
const regionPreviewWrap = document.getElementById('regionPreviewWrap');
const regionPreviewImg = document.getElementById('regionPreviewImg');
const regionSelectionBox = document.getElementById('regionSelectionBox');
const regionCancelBtn = document.getElementById('regionCancelBtn');
const regionConfirmBtn = document.getElementById('regionConfirmBtn');

window.addEventListener('error', (event) => {
  console.error('Error en la interfaz:', event.error || event.message);
  alert(`Ocurrió un error: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Promesa rechazada sin manejar:', event.reason);
  alert(`Ocurrió un error: ${event.reason && event.reason.message ? event.reason.message : event.reason}`);
});

const QUALITY_HINTS = {
  rapidaGpu: 'Usa la placa de video (NVIDIA/Intel/AMD) para codificar en segundos en vez de minutos. Prueba HEVC y H.264 por GPU antes de caer a CPU automáticamente si no hay ninguna compatible.',
  equilibrada: 'H.264, CRF 23. Máxima compatibilidad (WhatsApp, redes, edición), buen balance calidad/peso.',
  ligera: 'H.264, CRF 28. Prioriza el tamaño de archivo sobre el detalle fino.'
};

const RESOLUTION_LABELS = {
  original: 'Original (sin cambios)',
  '1080p': '1080p',
  '720p': '720p',
  '480p': '480p'
};

let selectedSourceId = null;
let outputDir = null;
let mediaRecorder = null;
let activeStreams = [];
let audioContext = null;
let recordingId = null;
let tempPath = null;
let timerInterval = null;
let recordStart = null;
let regionRect = null; // { x, y, w, h } como fracciones (0-1) del video capturado
let regionCleanup = null;

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function formatTimer(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function playChime() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    [660, 990].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.3);
    });
    setTimeout(() => ctx.close(), 800);
  } catch (err) {
    console.error('No se pudo reproducir el sonido de aviso:', err);
  }
}

function notifyRecordingReady(outputPath, finalSizeBytes) {
  try {
    new Notification('Lowey Screen Recorder', {
      body: `Grabación lista: ${outputPath.split(/[\\/]/).pop()} (${formatBytes(finalSizeBytes)})`
    });
  } catch (err) {
    console.error('No se pudo mostrar la notificación:', err);
  }
}

async function loadSources() {
  sourcesGrid.innerHTML = '<p class="hint">Cargando…</p>';
  const sources = await window.lowey.getSources();
  sourcesGrid.innerHTML = '';

  sources.forEach((source) => {
    const card = document.createElement('div');
    card.className = 'source-card';
    card.dataset.id = source.id;
    if (source.id === selectedSourceId) card.classList.add('selected');

    const img = document.createElement('img');
    img.src = source.thumbnail || '';
    card.appendChild(img);

    const name = document.createElement('div');
    name.className = 'source-name';
    name.textContent = source.isScreen ? `🖥️ ${source.name}` : `🪟 ${source.name}`;
    card.appendChild(name);

    card.addEventListener('click', () => {
      if (selectedSourceId !== source.id) {
        regionRect = null;
        regionHint.textContent = '';
      }
      selectedSourceId = source.id;
      document.querySelectorAll('.source-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      chooseRegionBtn.disabled = !regionToggle.checked;
    });

    sourcesGrid.appendChild(card);
  });
}

async function loadQualityPresets() {
  const presets = await window.lowey.getQualityPresets();
  qualitySelect.innerHTML = '';
  presets.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    qualitySelect.appendChild(option);
  });
  qualitySelect.value = 'rapidaGpu';
  updateQualityHint();
}

function updateQualityHint() {
  qualityHint.textContent = QUALITY_HINTS[qualitySelect.value] || '';
}

async function loadResolutionOptions() {
  const options = await window.lowey.getResolutionOptions();
  resolutionSelect.innerHTML = '';
  options.forEach((id) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = RESOLUTION_LABELS[id] || id;
    resolutionSelect.appendChild(option);
  });
  resolutionSelect.value = 'original';
}

async function loadDefaultOutputDir() {
  outputDir = await window.lowey.getDefaultOutputDir();
  outputDirInput.value = outputDir;
}

function stopAllStreams() {
  activeStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  activeStreams = [];
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (regionCleanup) {
    regionCleanup();
    regionCleanup = null;
  }
}

// Recorta el video capturado a la región elegida dibujando cuadro a cuadro en
// un canvas oculto. Se usa setInterval (no requestAnimationFrame) para que
// siga grabando aunque la ventana no tenga foco ni esté visible.
function applyRegionCrop(videoTrack, fps, rect) {
  const settings = videoTrack.getSettings();
  const nativeW = settings.width || 1920;
  const nativeH = settings.height || 1080;

  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const sx = Math.round(rect.x * nativeW);
  const sy = Math.round(rect.y * nativeH);
  const sw = even(rect.w * nativeW);
  const sh = even(rect.h * nativeH);

  const video = document.createElement('video');
  video.muted = true;
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.srcObject = new MediaStream([videoTrack]);
  document.body.appendChild(video);
  video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');

  const intervalId = setInterval(() => {
    if (video.readyState >= 2) {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    }
  }, 1000 / fps);

  const canvasStream = canvas.captureStream(fps);

  regionCleanup = () => {
    clearInterval(intervalId);
    video.pause();
    video.srcObject = null;
    video.remove();
  };

  return canvasStream.getVideoTracks()[0];
}

async function buildCaptureStream(sourceId, fps, wantMic, wantSystemAudio) {
  const videoConstraint = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      minFrameRate: fps,
      maxFrameRate: fps
    }
  };

  const desktopAudioConstraint = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId
    }
  };

  // Chromium exige pedir el audio de escritorio (loopback) en la MISMA llamada
  // a getUserMedia que el video: pedirlo por separado (solo audio) puede colgar
  // o tirar abajo el proceso de renderizado en algunos sistemas Windows.
  let desktopStream;
  try {
    desktopStream = await navigator.mediaDevices.getUserMedia({
      audio: wantSystemAudio ? desktopAudioConstraint : false,
      video: videoConstraint
    });
  } catch (err) {
    if (!wantSystemAudio) throw err;
    // Reintentar sin audio del sistema por si el origen elegido no lo soporta.
    desktopStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraint
    });
  }

  const videoStream = desktopStream;
  const desktopAudioStream = desktopStream.getAudioTracks().length > 0 ? desktopStream : null;
  activeStreams.push(videoStream);

  let micStream = null;
  if (wantMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      activeStreams.push(micStream);
    } catch (err) {
      micStream = null;
    }
  }

  const combined = new MediaStream();
  if (regionRect) {
    combined.addTrack(applyRegionCrop(videoStream.getVideoTracks()[0], fps, regionRect));
  } else {
    videoStream.getVideoTracks().forEach((track) => combined.addTrack(track));
  }

  const audioSources = [desktopAudioStream, micStream].filter(Boolean);
  if (audioSources.length === 1) {
    audioSources[0].getAudioTracks().forEach((track) => combined.addTrack(track));
  } else if (audioSources.length > 1) {
    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    audioSources.forEach((stream) => {
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(destination);
    });
    destination.stream.getAudioTracks().forEach((track) => combined.addTrack(track));
  }

  return { stream: combined, hasAudio: audioSources.length > 0 };
}

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || 'video/webm';
}

async function startRecording() {
  if (!selectedSourceId) {
    alert('Elegí una pantalla o aplicación para grabar.');
    return;
  }

  resultBox.classList.add('hidden');
  encodeProgressWrap.classList.add('hidden');

  const fps = Number(fpsSelect.value);
  const wantMic = micToggle.checked;
  const wantSystemAudio = systemAudioToggle.checked;

  let captured;
  try {
    captured = await buildCaptureStream(selectedSourceId, fps, wantMic, wantSystemAudio);
  } catch (err) {
    alert(`No se pudo iniciar la captura: ${err.message}`);
    return;
  }

  const { id, tempPath: tPath } = await window.lowey.startWriteStream();
  recordingId = id;
  tempPath = tPath;
  window.__loweyHasAudio = captured.hasAudio;

  // Bitrate de la captura EN VIVO. En "Modo Visual Novel" se prioriza calidad
  // asumiendo que el juego/app grabado no necesita muchos recursos. En
  // "Modo juego exigente" se baja bastante para no competirle CPU a un juego
  // pesado mientras se graba (la calidad del archivo final no se toca acá,
  // eso lo resuelve la recompresión posterior).
  const isLowImpact = captureModeSelect.value === 'liviano';
  const videoBitsPerSecond = isLowImpact
    ? (fps >= 60 ? 12_000_000 : 8_000_000)
    : (fps >= 60 ? 60_000_000 : 40_000_000);

  mediaRecorder = new MediaRecorder(captured.stream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond,
    audioBitsPerSecond: 256_000
  });

  mediaRecorder.ondataavailable = async (event) => {
    if (event.data && event.data.size > 0) {
      const buffer = await event.data.arrayBuffer();
      window.lowey.writeChunk(recordingId, buffer);
    }
  };

  mediaRecorder.onstop = onRecordingStopped;

  mediaRecorder.start(1000);
  recordStart = Date.now();
  window.lowey.notifyRecordingStarted(recordStart);
  timerInterval = setInterval(() => {
    recTimer.textContent = formatTimer(Date.now() - recordStart);
  }, 500);

  recDot.classList.add('live');
  recordBtn.textContent = '■ Detener grabación';
  recordBtn.classList.add('recording');
}

async function onRecordingStopped() {
  clearInterval(timerInterval);
  recDot.classList.remove('live');
  window.lowey.notifyRecordingStopped();
  stopAllStreams();
  await window.lowey.endWriteStream(recordingId);

  recordBtn.disabled = true;
  recordBtn.textContent = '● Iniciar grabación';
  recordBtn.classList.remove('recording');
  encodeProgressWrap.classList.remove('hidden');
  encodeProgress.value = 0;

  const unsubscribe = window.lowey.onEncodeProgress(({ progress }) => {
    encodeProgress.value = Math.round(progress * 100);
  });

  const baseName = `Grabacion_${new Date().toISOString().replace(/[:.]/g, '-')}`;

  try {
    const result = await window.lowey.finishRecording({
      tempPath,
      outputDir,
      baseName,
      qualityId: qualitySelect.value,
      resolutionId: resolutionSelect.value,
      keepAudio: window.__loweyHasAudio
    });

    const savedPercent = result.tempSizeBytes
      ? Math.round((1 - result.finalSizeBytes / result.tempSizeBytes) * 100)
      : 0;

    resultBox.classList.remove('hidden');
    resultBox.innerHTML = `
      <div>Archivo final: <strong>${result.outputPath}</strong></div>
      <div>Tamaño final: ${formatBytes(result.finalSizeBytes)}</div>
      <div>Captura intermedia: ${formatBytes(result.tempSizeBytes)}</div>
      ${result.encoderUsed ? `<div>Codificado con: ${result.encoderUsed}</div>` : ''}
      ${savedPercent > 0 ? `<div class="saving">Ahorro por recompresión: ${savedPercent}%</div>` : ''}
      <div style="margin-top:8px;"><button id="openFolderBtn" class="ghost-btn">Abrir carpeta</button></div>
    `;

    document.getElementById('openFolderBtn').addEventListener('click', () => {
      window.lowey.showInFolder(result.outputPath);
    });

    playChime();
    notifyRecordingReady(result.outputPath, result.finalSizeBytes);
  } catch (err) {
    resultBox.classList.remove('hidden');
    resultBox.textContent = `Error al optimizar el video: ${err.message}`;
  } finally {
    unsubscribe();
    encodeProgressWrap.classList.add('hidden');
    recordBtn.disabled = false;
    recTimer.textContent = '00:00:00';
  }
}

function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  } else if (!recordBtn.disabled) {
    startRecording();
  }
}

recordBtn.addEventListener('click', toggleRecording);
window.lowey.onToggleRecordingShortcut(toggleRecording);

refreshSourcesBtn.addEventListener('click', loadSources);
qualitySelect.addEventListener('change', updateQualityHint);

captureModeInfoBtn.addEventListener('click', () => {
  captureModeInfo.classList.toggle('hidden');
});

chooseFolderBtn.addEventListener('click', async () => {
  const dir = await window.lowey.chooseSaveFolder();
  if (dir) {
    outputDir = dir;
    outputDirInput.value = dir;
  }
});

async function loadShortcutHint() {
  const shortcut = await window.lowey.getRecordShortcut();
  const shortcutHint = document.getElementById('shortcutHint');
  shortcutHint.textContent = `Atajo para iniciar/detener sin abrir la ventana: "${shortcut}"`;
}

// --- Selección de región ---

regionToggle.addEventListener('change', () => {
  chooseRegionBtn.disabled = !regionToggle.checked || !selectedSourceId;
  if (!regionToggle.checked) {
    regionRect = null;
    regionHint.textContent = '';
  }
});

let dragState = null;

function resetSelectionBox() {
  regionSelectionBox.classList.add('hidden');
  regionSelectionBox.style.width = '0px';
  regionSelectionBox.style.height = '0px';
  regionConfirmBtn.disabled = true;
}

chooseRegionBtn.addEventListener('click', async () => {
  if (!selectedSourceId) return;
  const dataUrl = await window.lowey.getSourcePreview(selectedSourceId);
  if (!dataUrl) {
    alert('No se pudo generar la vista previa de esta fuente.');
    return;
  }
  regionPreviewImg.src = dataUrl;
  resetSelectionBox();
  regionModal.classList.remove('hidden');
});

regionPreviewWrap.addEventListener('mousedown', (event) => {
  const rect = regionPreviewImg.getBoundingClientRect();
  const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
  dragState = { startX: x, startY: y, imgRect: rect };
  regionSelectionBox.classList.remove('hidden');
  regionSelectionBox.style.left = `${x}px`;
  regionSelectionBox.style.top = `${y}px`;
  regionSelectionBox.style.width = '0px';
  regionSelectionBox.style.height = '0px';
});

window.addEventListener('mousemove', (event) => {
  if (!dragState) return;
  const { startX, startY, imgRect } = dragState;
  const x = Math.min(Math.max(event.clientX - imgRect.left, 0), imgRect.width);
  const y = Math.min(Math.max(event.clientY - imgRect.top, 0), imgRect.height);
  const left = Math.min(startX, x);
  const top = Math.min(startY, y);
  const width = Math.abs(x - startX);
  const height = Math.abs(y - startY);
  regionSelectionBox.style.left = `${left}px`;
  regionSelectionBox.style.top = `${top}px`;
  regionSelectionBox.style.width = `${width}px`;
  regionSelectionBox.style.height = `${height}px`;
});

window.addEventListener('mouseup', () => {
  if (!dragState) return;
  const width = parseFloat(regionSelectionBox.style.width);
  const height = parseFloat(regionSelectionBox.style.height);
  regionConfirmBtn.disabled = width < 10 || height < 10;
  dragState = null;
});

regionConfirmBtn.addEventListener('click', () => {
  const imgRect = regionPreviewImg.getBoundingClientRect();
  const left = parseFloat(regionSelectionBox.style.left);
  const top = parseFloat(regionSelectionBox.style.top);
  const width = parseFloat(regionSelectionBox.style.width);
  const height = parseFloat(regionSelectionBox.style.height);

  regionRect = {
    x: left / imgRect.width,
    y: top / imgRect.height,
    w: width / imgRect.width,
    h: height / imgRect.height
  };

  regionHint.textContent = `Región elegida: ${Math.round(regionRect.w * 100)}% x ${Math.round(regionRect.h * 100)}% de la pantalla ✓`;
  regionModal.classList.add('hidden');
});

regionCancelBtn.addEventListener('click', () => {
  regionModal.classList.add('hidden');
});

loadSources();
loadQualityPresets();
loadResolutionOptions();
loadDefaultOutputDir();
loadShortcutHint();
