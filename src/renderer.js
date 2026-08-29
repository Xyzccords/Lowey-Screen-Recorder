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
let outputDir = null;
let mediaRecorder = null;
let isStarting = false; // evita iniciar dos capturas si F9 se aprieta dos veces muy rápido
let activeStreams = [];
let audioContext = null;
let recordingId = null;
let tempPath = null;
let timerInterval = null;
let recordStart = null;
const pendingAudioMap = new Map(); // tempPath -> tenía audio al grabarse
const pendingDurationMap = new Map(); // tempPath -> duración real grabada, en segundos

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
    row.dataset.tempPath = item.tempPath;

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
      await window.lowey.discardPendingRecording(item.tempPath);
      pendingAudioMap.delete(item.tempPath);
      pendingDurationMap.delete(item.tempPath);
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

function extractRecordedAt(tempPathValue) {
  const match = tempPathValue.match(/rec-(\d+)\.webm$/);
  return match ? Number(match[1]) : Date.now();
}

async function compressOne(itemTempPath) {
  const baseName = `Grabacion_${new Date(extractRecordedAt(itemTempPath)).toISOString().replace(/[:.]/g, '-')}`;
  const keepAudio = pendingAudioMap.has(itemTempPath) ? pendingAudioMap.get(itemTempPath) : true;
  // Solo se conoce si esta pending quedó de esta misma sesión (se trackea en
  // vivo con Date.now()); si el programa se reinició y la captura ya estaba
  // en la carpeta temporal de antes, no hay forma de saber cuánto duró.
  const durationSeconds = pendingDurationMap.get(itemTempPath);

  const result = await window.lowey.finishRecording({
    tempPath: itemTempPath,
    outputDir,
    baseName,
    qualityId: 'hevcAudioIntacto',
    resolutionId: resolutionSelect.value,
    keepAudio,
    durationSeconds
  });

  pendingAudioMap.delete(itemTempPath);
  pendingDurationMap.delete(itemTempPath);
  return result;
}

compressSelectedBtn.addEventListener('click', async () => {
  const checkedRows = Array.from(pendingList.querySelectorAll('.pending-checkbox:checked')).map(
    (cb) => cb.closest('.pending-item').dataset.tempPath
  );
  if (checkedRows.length === 0) return;

  compressSelectedBtn.disabled = true;
  resultBox.classList.add('hidden');
  encodeProgressWrap.classList.remove('hidden');

  const unsubscribe = window.lowey.onEncodeProgress(({ progress }) => {
    encodeProgress.value = Math.round(progress * 100);
  });

  const results = [];
  const errors = [];

  for (let i = 0; i < checkedRows.length; i += 1) {
    encodeProgressLabel.textContent = `Optimizando ${i + 1} de ${checkedRows.length}…`;
    encodeProgress.value = 0;
    try {
      const result = await compressOne(checkedRows[i]);
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

  isStarting = true;

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
    isStarting = false;
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
    ? (fps >= 60 ? 5_000_000 : 4_000_000)
    : (fps >= 60 ? 9_000_000 : 7_000_000);

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

  // Trozos chicos y frecuentes en vez de uno grande por segundo: repartir el
  // trabajo de volcar cada trozo a disco evita baches periódicos notorios.
  mediaRecorder.start(250);
  recordStart = Date.now();
  window.lowey.notifyRecordingStarted(recordStart);
  timerInterval = setInterval(() => {
    recTimer.textContent = formatTimer(Date.now() - recordStart);
  }, 500);

  recDot.classList.add('live');
  recordBtn.textContent = '■ Detener grabación';
  recordBtn.classList.add('recording');
  isStarting = false;
}

async function onRecordingStopped() {
  clearInterval(timerInterval);
  recDot.classList.remove('live');
  window.lowey.notifyRecordingStopped();
  stopAllStreams();
  await window.lowey.endWriteStream(recordingId);

  if (currentMode === 'quick') {
    // En este modo, grabar no espera nunca a que se optimice: la captura
    // queda en "Grabaciones sin optimizar" y el botón se libera al toque.
    pendingAudioMap.set(tempPath, window.__loweyHasAudio);
    pendingDurationMap.set(tempPath, (Date.now() - recordStart) / 1000);
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
      tempPath,
      outputDir,
      baseName,
      qualityId: 'hevcAudioIntacto',
      resolutionId: resolutionSelect.value,
      keepAudio: window.__loweyHasAudio,
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
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
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
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
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
