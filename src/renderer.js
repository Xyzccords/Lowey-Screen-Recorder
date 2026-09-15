const sourcesGrid = document.getElementById('sourcesGrid');
const refreshSourcesBtn = document.getElementById('refreshSources');
const captureModeSelect = document.getElementById('captureModeSelect');
const captureModeInfoBtn = document.getElementById('captureModeInfoBtn');
const captureModeInfo = document.getElementById('captureModeInfo');
const recordBtn = document.getElementById('recordBtn');
const recDot = document.getElementById('recDot');
const recTimer = document.getElementById('recTimer');
const encodeProgressWrap = document.getElementById('encodeProgressWrap');
const encodeProgress = document.getElementById('encodeProgress');
const encodeProgressLabel = document.getElementById('encodeProgressLabel');
const resultBox = document.getElementById('resultBox');

const pendingList = document.getElementById('pendingList');
const refreshPendingBtn = document.getElementById('refreshPending');
const compressSelectedBtn = document.getElementById('compressSelectedBtn');

const outputDirHint = document.getElementById('outputDirHint');
const tempDirHint = document.getElementById('tempDirHint');

window.addEventListener('error', (event) => {
  console.error('Error en la interfaz:', event.error || event.message);
  alert(`Ocurrió un error: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Promesa rechazada sin manejar:', event.reason);
  alert(`Ocurrió un error: ${event.reason && event.reason.message ? event.reason.message : event.reason}`);
});

// Esta app no tiene opciones de resolución/fps/audio: siempre graba a 720p,
// 30fps, sin micrófono ni audio del sistema, a las carpetas fijas que
// devuelve main.js.
const FPS = 30;
const RESOLUTION_ID = '720p';

let selectedSourceId = null;
let selectedSourceName = null;
let selectedSourceIsScreen = false;
let selectedSourceBounds = null; // {x, y, width, height} del monitor real (solo para fuentes de pantalla)
let outputDir = null;
let isRecording = false;
let isStarting = false; // evita iniciar dos capturas si F9 se aprieta dos veces muy rápido
let videoCaptureId = null; // id de la captura de video por ffmpeg
let videoPath = null;
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
    new Notification("Abi's Quick Recorder", {
      body: `Grabación lista: ${outputPath.split(/[\\/]/).pop()} (${formatBytes(finalSizeBytes)})`,
      silent: true
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
      selectedSourceId = source.id;
      selectedSourceName = source.name;
      selectedSourceIsScreen = source.isScreen;
      selectedSourceBounds = source.bounds || null;
      document.querySelectorAll('.source-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
    });

    sourcesGrid.appendChild(card);
  });
}

async function loadFixedDirs() {
  outputDir = await window.lowey.getDefaultOutputDir();
  outputDirHint.textContent = outputDir;
  tempDirHint.textContent = await window.lowey.getTempDir();
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
    outputDir,
    baseName,
    qualityId: 'hevcAudioIntacto',
    durationSeconds
  });

  pendingDurationMap.delete(item.id);
  return result;
}

compressSelectedBtn.addEventListener('click', async () => {
  const checkedItems = Array.from(pendingList.querySelectorAll('.pending-checkbox:checked')).map((cb) => {
    const row = cb.closest('.pending-item');
    return { id: row.dataset.id, videoPath: row.dataset.videoPath };
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
      new Notification("Abi's Quick Recorder", {
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

async function startRecording() {
  if (!selectedSourceId) {
    alert('Elegí una pantalla o aplicación para grabar.');
    return;
  }

  isStarting = true;

  resultBox.classList.add('hidden');
  encodeProgressWrap.classList.add('hidden');

  const id = `rec-${Date.now()}`;

  let videoCapture;
  try {
    videoCapture = await window.lowey.startVideoCapture({
      id,
      fps: FPS,
      mode: captureModeSelect.value,
      source: { id: selectedSourceId, name: selectedSourceName, isScreen: selectedSourceIsScreen, bounds: selectedSourceBounds }
    });
  } catch (err) {
    alert(`No se pudo iniciar la captura de video: ${err.message}`);
    isStarting = false;
    return;
  }
  videoCaptureId = videoCapture.id;
  videoPath = videoCapture.videoPath;

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

  await window.lowey.stopVideoCapture(videoCaptureId);

  // Grabar no espera nunca a que se optimice: la captura queda en
  // "Grabaciones sin optimizar" y el botón se libera al toque.
  pendingDurationMap.set(videoCaptureId, (Date.now() - recordStart) / 1000);
  recordBtn.disabled = false;
  recordBtn.textContent = '● Iniciar grabación';
  recordBtn.classList.remove('recording');
  recTimer.textContent = '00:00:00';
  await loadPendingRecordings();
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

window.lowey.onVideoCaptureError(({ message }) => {
  alert(`La grabación se interrumpió: ${message}`);
  if (isRecording) stopRecording();
});

async function loadShortcutHint() {
  const shortcut = await window.lowey.getRecordShortcut();
  const shortcutHint = document.getElementById('shortcutHint');
  shortcutHint.textContent = `Atajo para iniciar/detener sin abrir la ventana: "${shortcut}"`;
}

loadSources();
loadFixedDirs();
loadShortcutHint();
loadPendingRecordings();
