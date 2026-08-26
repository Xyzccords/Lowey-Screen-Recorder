const sourcesGrid = document.getElementById('sourcesGrid');
const refreshSourcesBtn = document.getElementById('refreshSources');
const qualitySelect = document.getElementById('qualitySelect');
const qualityHint = document.getElementById('qualityHint');
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

const QUALITY_HINTS = {
  maxima: 'H.265, CRF 18. Prácticamente sin pérdida visible. Archivos más grandes que "alta" pero muy por debajo de una grabación a bitrate fijo.',
  alta: 'H.265, CRF 22. Muy buena calidad para tutoriales y gameplay, tamaño reducido. Recomendado.',
  equilibrada: 'H.264, CRF 23. Máxima compatibilidad (WhatsApp, redes, edición), buen balance calidad/peso.',
  ligera: 'H.264, CRF 28. Prioriza el tamaño de archivo sobre el detalle fino.'
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
      selectedSourceId = source.id;
      document.querySelectorAll('.source-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
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
  qualitySelect.value = 'alta';
  updateQualityHint();
}

function updateQualityHint() {
  qualityHint.textContent = QUALITY_HINTS[qualitySelect.value] || '';
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
}

async function buildCaptureStream(sourceId, fps, wantMic, wantSystemAudio) {
  const videoConstraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        minFrameRate: fps,
        maxFrameRate: fps
      }
    }
  };

  let desktopAudioStream = null;
  if (wantSystemAudio) {
    try {
      desktopAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        },
        video: false
      });
    } catch (err) {
      desktopAudioStream = null;
    }
  }

  const videoStream = await navigator.mediaDevices.getUserMedia(videoConstraints);
  activeStreams.push(videoStream);
  if (desktopAudioStream) activeStreams.push(desktopAudioStream);

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
  videoStream.getVideoTracks().forEach((track) => combined.addTrack(track));

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

  // Bitrate alto en la etapa de captura: prioriza que no se pierda calidad
  // ni se salteen cuadros en tiempo real. El peso final bajo se logra después,
  // en la recompresión por CRF con ffmpeg.
  const videoBitsPerSecond = fps >= 60 ? 60_000_000 : 40_000_000;

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
      ${savedPercent > 0 ? `<div class="saving">Ahorro por recompresión: ${savedPercent}%</div>` : ''}
      <div style="margin-top:8px;"><button id="openFolderBtn" class="ghost-btn">Abrir carpeta</button></div>
    `;

    document.getElementById('openFolderBtn').addEventListener('click', () => {
      window.lowey.showInFolder(result.outputPath);
    });
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

recordBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  } else {
    startRecording();
  }
});

refreshSourcesBtn.addEventListener('click', loadSources);
qualitySelect.addEventListener('change', updateQualityHint);

chooseFolderBtn.addEventListener('click', async () => {
  const dir = await window.lowey.chooseSaveFolder();
  if (dir) {
    outputDir = dir;
    outputDirInput.value = dir;
  }
});

loadSources();
loadQualityPresets();
loadDefaultOutputDir();
