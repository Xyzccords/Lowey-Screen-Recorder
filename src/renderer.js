const sourcesGrid = document.getElementById('sourcesGrid');
const refreshSourcesBtn = document.getElementById('refreshSources');
const resolutionSelect = document.getElementById('resolutionSelect');
const captureModeSelect = document.getElementById('captureModeSelect');
const captureModeInfoBtn = document.getElementById('captureModeInfoBtn');
const captureModeInfo = document.getElementById('captureModeInfo');
const fpsSelect = document.getElementById('fpsSelect');
const micToggle = document.getElementById('micToggle');
const systemAudioToggle = document.getElementById('systemAudioToggle');
const outputDirInput = document.getElementById('outputDir');
const chooseFolderBtn = document.getElementById('chooseFolder');
const tempDirInput = document.getElementById('tempDir');
const chooseTempFolderBtn = document.getElementById('chooseTempFolder');
const recordBtn = document.getElementById('recordBtn');
const recDot = document.getElementById('recDot');
const recTimer = document.getElementById('recTimer');
const encodeProgressWrap = document.getElementById('encodeProgressWrap');
const encodeProgress = document.getElementById('encodeProgress');
const encodeProgressLabel = document.getElementById('encodeProgressLabel');
const resultBox = document.getElementById('resultBox');

const appTitle = document.getElementById('appTitle');
const modeButtons = document.querySelectorAll('.mode-btn');
const pendingSection = document.getElementById('pendingSection');
const pendingList = document.getElementById('pendingList');
const refreshPendingBtn = document.getElementById('refreshPending');
const compressSelectedBtn = document.getElementById('compressSelectedBtn');

window.addEventListener('error', (event) => {
  console.error('Error en la interfaz:', event.error || event.message);
  alert(`Ocurrió un error: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Promesa rechazada sin manejar:', event.reason);
  alert(`Ocurrió un error: ${event.reason && event.reason.message ? event.reason.message : event.reason}`);
});

const MODE_NAMES = {
  normal: 'Lowey Screen Recorder',
  quick: "Abi's Quick Recorder"
};

let currentMode = 'normal';

const RESOLUTION_LABELS = {
  original: 'Original (sin cambios)',
  '1080p': '1080p',
  '720p': '720p',
  '480p': '480p'
};

let selectedSourceId = null;
let selectedSourceName = null;
let selectedSourceIsScreen = false;
let outputDir = null;
let audioRecorder = null;
let isRecording = false;
let isStarting = false; // evita iniciar dos capturas si F9 se aprieta dos veces muy rápido
let activeStreams = [];
let audioContext = null;
let recordingId = null; // id del write-stream de audio (null si no hay audio)
let videoCaptureId = null; // id de la captura de video por ffmpeg
let videoPath = null;
let audioPath = null;
let timerInterval = null;
let recordStart = null;
const pendingDurationMap = new Map(); // id -> duración real grabada, en segundos

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
    // silent: true porque ya reproducimos nuestro propio sonido con
    // playChime(); si no, Windows suma su sonido de notificación por
    // encima del nuestro y se escuchan los dos superpuestos.
    new Notification(MODE_NAMES[currentMode], {
      body: `Grabación lista: ${outputPath.split(/[\\/]/).pop()} (${formatBytes(finalSizeBytes)})`,
      silent: true
    });
  } catch (err) {
    console.error('No se pudo mostrar la notificación:', err);
  }
}

function setMode(mode) {
  currentMode = mode;
  appTitle.textContent = MODE_NAMES[mode];
  document.title = MODE_NAMES[mode];
  modeButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  pendingSection.classList.toggle('hidden', mode !== 'quick');
}

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

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
      selectedSourceName = source.name;
      selectedSourceIsScreen = source.isScreen;
      document.querySelectorAll('.source-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
    });

    sourcesGrid.appendChild(card);
  });
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

async function loadTempDir() {
  tempDirInput.value = await window.lowey.getTempDir();
}

function formatDate(ms) {
  return new Date(ms).toLocaleString();
}

async function loadPendingRecordings() {
  const items = await window.lowey.listPendingRecordings();

  if (items.length === 0) {
    pendingList.innerHTML = '<p class="pending-empty">No hay grabaciones esperando a optimizarse.</p>';
    compressSelectedBtn.disabled = true;
    return;
  }

  pendingList.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'pending-item';
    row.dataset.id = item.id;
    row.dataset.videoPath = item.videoPath;
    row.dataset.audioPath = item.audioPath || '';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'pending-checkbox';
    checkbox.addEventListener('change', updateCompressButtonState);
    row.appendChild(checkbox);

    const info = document.createElement('div');
    info.className = 'pending-info';
    info.innerHTML = `
      <div class="pending-name">${formatDate(item.createdAt)}</div>
      <div class="pending-meta">${formatBytes(item.sizeBytes)} sin optimizar</div>
    `;
    row.appendChild(info);

    const discardBtn = document.createElement('button');
    discardBtn.className = 'ghost-btn';
    discardBtn.textContent = 'Descartar';
    discardBtn.addEventListener('click', async () => {
      if (!confirm('¿Borrar esta captura sin optimizar? No se puede deshacer.')) return;
      await window.lowey.discardPendingRecording(item.id);
      pendingDurationMap.delete(item.id);
      loadPendingRecordings();
    });
    row.appendChild(discardBtn);

    pendingList.appendChild(row);
  });

  updateCompressButtonState();
}

function updateCompressButtonState() {
  const anyChecked = !!pendingList.querySelector('.pending-checkbox:checked');
  compressSelectedBtn.disabled = !anyChecked;
}

async function compressOne(item) {
  const recordedAt = Number(item.id.replace('rec-', '')) || Date.now();
  const baseName = `Grabacion_${new Date(recordedAt).toISOString().replace(/[:.]/g, '-')}`;
  // Solo se conoce si esta pending quedó de esta misma sesión (se trackea en
  // vivo con Date.now()); si el programa se reinició y la captura ya estaba
  // en la carpeta temporal de antes, no hay forma de saber cuánto duró.
  const durationSeconds = pendingDurationMap.get(item.id);

  const result = await window.lowey.finishRecording({
    videoPath: item.videoPath,
    audioPath: item.audioPath || null,
    outputDir,
    baseName,
    qualityId: 'hevcAudioIntacto',
    resolutionId: resolutionSelect.value,
    keepAudio: Boolean(item.audioPath),
    durationSeconds
  });

  pendingDurationMap.delete(item.id);
  return result;
}

compressSelectedBtn.addEventListener('click', async () => {
  const checkedItems = Array.from(pendingList.querySelectorAll('.pending-checkbox:checked')).map((cb) => {
    const row = cb.closest('.pending-item');
    return { id: row.dataset.id, videoPath: row.dataset.videoPath, audioPath: row.dataset.audioPath || null };
  });
  if (checkedItems.length === 0) return;

  compressSelectedBtn.disabled = true;
  resultBox.classList.add('hidden');
  encodeProgressWrap.classList.remove('hidden');

  const unsubscribe = window.lowey.onEncodeProgress(({ progress }) => {
    encodeProgress.value = Math.round(progress * 100);
  });

  const results = [];
  const errors = [];

  for (let i = 0; i < checkedItems.length; i += 1) {
    encodeProgressLabel.textContent = `Optimizando ${i + 1} de ${checkedItems.length}…`;
    encodeProgress.value = 0;
    try {
      const result = await compressOne(checkedItems[i]);
      results.push(result);
    } catch (err) {
      errors.push(err.message);
    }
  }

  unsubscribe();
  encodeProgressWrap.classList.add('hidden');
  encodeProgressLabel.textContent = 'Optimizando video (compresión de alta calidad)…';

  resultBox.classList.remove('hidden');
  resultBox.innerHTML = results
    .map((result) => {
      const savedPercent = result.tempSizeBytes
        ? Math.round((1 - result.finalSizeBytes / result.tempSizeBytes) * 100)
        : 0;
      return `
        <div style="margin-bottom:10px;">
          <div>Archivo final: <strong>${result.outputPath}</strong></div>
          <div>Tamaño final: ${formatBytes(result.finalSizeBytes)}</div>
          ${result.encoderUsed ? `<div>Codificado con: ${result.encoderUsed}</div>` : ''}
          ${savedPercent > 0 ? `<div class="saving">Ahorro por recompresión: ${savedPercent}%</div>` : ''}
        </div>
      `;
    })
    .join('') + (errors.length ? `<div>Errores: ${errors.join(' · ')}</div>` : '');

  if (results.length > 0) {
    playChime();
    try {
      new Notification(MODE_NAMES[currentMode], {
        body: results.length === 1
          ? `Grabación lista: ${results[0].outputPath.split(/[\\/]/).pop()} (${formatBytes(results[0].finalSizeBytes)})`
          : `${results.length} grabaciones optimizadas.`,
        silent: true
      });
    } catch (err) {
      console.error('No se pudo mostrar la notificación:', err);
    }
  }

  await loadPendingRecordings();
});

refreshPendingBtn.addEventListener('click', loadPendingRecordings);

function stopAllStreams() {
  activeStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  activeStreams = [];
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}

// Esta app ya NO graba el video en vivo con MediaRecorder del navegador: eso
// se hace aparte, con ffmpeg (ver startVideoCapture), porque el bitrate que
// le pedís a MediaRecorder para captura de escritorio es solo una sugerencia
// que Chromium ignora feo con contenido de mucho movimiento (medido: 2.7x a
// 4.5x más pesado de lo pedido). Acá solo se arma el audio (opcional).
async function buildAudioStream(sourceId, wantMic, wantSystemAudio) {
  const videoConstraint = {
    mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId }
  };
  const desktopAudioConstraint = {
    mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId }
  };

  // Chromium exige pedir el audio de escritorio (loopback) en la MISMA llamada
  // a getUserMedia que un video (aunque no lo vayamos a usar): pedirlo solo
  // puede colgar o tirar abajo el proceso de renderizado en Windows.
  let desktopStream = null;
  if (wantSystemAudio) {
    try {
      desktopStream = await navigator.mediaDevices.getUserMedia({
        audio: desktopAudioConstraint,
        video: videoConstraint
      });
    } catch (err) {
      desktopStream = null;
    }
  }

  // El video de esta llamada no se usa para nada (el real lo captura ffmpeg
  // aparte): se corta enseguida para no gastar recursos de más.
  if (desktopStream) {
    desktopStream.getVideoTracks().forEach((track) => track.stop());
    activeStreams.push(desktopStream);
  }

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
  const audioSources = [desktopStream && desktopStream.getAudioTracks().length > 0 ? desktopStream : null, micStream].filter(Boolean);

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

function pickAudioMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || 'audio/webm';
}

async function startRecording() {
  if (!selectedSourceId) {
    alert('Elegí una pantalla o aplicación para grabar.');
    return;
  }

  isStarting = true;

  resultBox.classList.add('hidden');
  encodeProgressWrap.classList.add('hidden');

  const fps = Number(fpsSelect.value);
  const wantMic = micToggle.checked;
  const wantSystemAudio = systemAudioToggle.checked;
  const id = `rec-${Date.now()}`;

  // Bitrate de la captura EN VIVO. En "Modo Visual Novel" se prioriza calidad
  // asumiendo que el juego/app grabado no necesita muchos recursos. En
  // "Modo juego exigente" se baja bastante para no competirle CPU a un juego
  // pesado mientras se graba (la calidad del archivo final no se toca acá,
  // eso lo resuelve la recompresión posterior). A diferencia del navegador,
  // ffmpeg sí respeta este límite de verdad (-maxrate/-bufsize).
  const isLowImpact = captureModeSelect.value === 'liviano';
  const videoBitsPerSecond = isLowImpact
    ? (fps >= 60 ? 5_000_000 : 4_000_000)
    : (fps >= 60 ? 9_000_000 : 7_000_000);

  let videoCapture;
  try {
    videoCapture = await window.lowey.startVideoCapture({
      id,
      fps,
      videoBitsPerSecond,
      source: { name: selectedSourceName, isScreen: selectedSourceIsScreen }
    });
  } catch (err) {
    alert(`No se pudo iniciar la captura de video: ${err.message}`);
    isStarting = false;
    return;
  }
  videoCaptureId = videoCapture.id;
  videoPath = videoCapture.videoPath;

  let audioCaptured = { stream: new MediaStream(), hasAudio: false };
  try {
    audioCaptured = await buildAudioStream(selectedSourceId, wantMic, wantSystemAudio);
  } catch (err) {
    console.error('No se pudo capturar audio, se graba sin audio:', err);
  }

  recordingId = null;
  audioPath = null;
  audioRecorder = null;

  if (audioCaptured.hasAudio) {
    const { id: aId, tempPath: aPath } = await window.lowey.startWriteStream({ id });
    recordingId = aId;
    audioPath = aPath;

    audioRecorder = new MediaRecorder(audioCaptured.stream, {
      mimeType: pickAudioMimeType(),
      audioBitsPerSecond: 256_000
    });
    audioRecorder.ondataavailable = async (event) => {
      if (event.data && event.data.size > 0) {
        const buffer = await event.data.arrayBuffer();
        window.lowey.writeChunk(recordingId, buffer);
      }
    };
    // Trozos chicos y frecuentes en vez de uno grande por segundo.
    audioRecorder.start(250);
  }

  recordStart = Date.now();
  window.lowey.notifyRecordingStarted(recordStart);
  timerInterval = setInterval(() => {
    recTimer.textContent = formatTimer(Date.now() - recordStart);
  }, 500);

  recDot.classList.add('live');
  recordBtn.textContent = '■ Detener grabación';
  recordBtn.classList.add('recording');
  isRecording = true;
  isStarting = false;
}

async function stopRecording() {
  isRecording = false;
  clearInterval(timerInterval);
  recDot.classList.remove('live');
  window.lowey.notifyRecordingStopped();

  if (audioRecorder && audioRecorder.state === 'recording') {
    await new Promise((resolve) => {
      audioRecorder.onstop = resolve;
      audioRecorder.stop();
    });
  }
  stopAllStreams();
  if (recordingId) await window.lowey.endWriteStream(recordingId);
  await window.lowey.stopVideoCapture(videoCaptureId);

  await onRecordingStopped();
}

async function onRecordingStopped() {
  if (currentMode === 'quick') {
    // En este modo, grabar no espera nunca a que se optimice: la captura
    // queda en "Grabaciones sin optimizar" y el botón se libera al toque.
    pendingDurationMap.set(videoCaptureId, (Date.now() - recordStart) / 1000);
    recordBtn.disabled = false;
    recordBtn.textContent = '● Iniciar grabación';
    recordBtn.classList.remove('recording');
    recTimer.textContent = '00:00:00';
    await loadPendingRecordings();
    return;
  }

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
      videoPath,
      audioPath,
      outputDir,
      baseName,
      qualityId: 'hevcAudioIntacto',
      resolutionId: resolutionSelect.value,
      keepAudio: Boolean(audioPath),
      durationSeconds: (Date.now() - recordStart) / 1000
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
  if (isRecording) {
    stopRecording();
  } else if (!recordBtn.disabled && !isStarting) {
    startRecording();
  }
}

recordBtn.addEventListener('click', toggleRecording);
window.lowey.onToggleRecordingShortcut(toggleRecording);

refreshSourcesBtn.addEventListener('click', loadSources);

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

chooseTempFolderBtn.addEventListener('click', async () => {
  const dir = await window.lowey.chooseTempFolder();
  if (dir) tempDirInput.value = dir;
});

window.lowey.onWriteError(({ message }) => {
  alert(`No se pudo seguir grabando: ${message}`);
  if (isRecording) stopRecording();
});

async function loadShortcutHint() {
  const shortcut = await window.lowey.getRecordShortcut();
  const shortcutHint = document.getElementById('shortcutHint');
  shortcutHint.textContent = `Atajo para iniciar/detener sin abrir la ventana: "${shortcut}"`;
}

loadSources();
loadResolutionOptions();
loadDefaultOutputDir();
loadTempDir();
loadShortcutHint();
loadPendingRecordings();
