const sourcesGrid = document.getElementById('sourcesGrid');
const refreshSourcesBtn = document.getElementById('refreshSources');
const captureModeSelect = document.getElementById('captureModeSelect');
const captureModeInfoBtn = document.getElementById('captureModeInfoBtn');
const captureModeInfo = document.getElementById('captureModeInfo');
const recordBtn = document.getElementById('recordBtn');
const pauseBtn = document.getElementById('pauseBtn');
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

const uploadVideoBtn = document.getElementById('uploadVideoBtn');
const uploadResultBox = document.getElementById('uploadResultBox');

window.addEventListener('error', (event) => {
  console.error('Error en la interfaz:', event.error || event.message);
  alert(`Ocurrió un error: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Promesa rechazada sin manejar:', event.reason);
  alert(`Ocurrió un error: ${event.reason && event.reason.message ? event.reason.message : event.reason}`);
});

let selectedSourceId = null;
let selectedSourceName = null;
let selectedSourceIsScreen = false;
let selectedSourceBounds = null;
let outputDir = null;
let isRecording = false;
let isPaused = false;
let isStarting = false;
let videoCaptureId = null;
let videoPath = null;
let winAudioPath = null; // audio nativo de la ventana (si el helper funcionó)
let windowAudioActive = false; // si hay que pausar/reanudar también el audio nativo de ventana
let micRecorder = null; // MediaRecorder del navegador: mic solo, o mic+sistema mezclados
let micRecordingId = null;
let micPath = null;
let activeStreams = [];
let audioContext = null;
let timerInterval = null;
let recordStart = null;
let pauseStartedAt = null;
let accumulatedPauseMs = 0; // tiempo total pausado, para descontarlo del timer y de la duración real
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

// Beep corto y distinto de playChime(), pensado para diagnóstico: solo
// suena cuando se dispara un ATAJO de teclado (no al clickear un botón).
// Si la próxima vez un atajo "no hace nada" pero este beep sí se escucha,
// el problema está en la lógica de la app; si el beep nunca suena, la
// tecla no le está llegando a la app (otro programa se la está comiendo
// antes de que la vea Electron).
function playShortcutBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    osc.type = 'square';
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
    setTimeout(() => ctx.close(), 300);
  } catch (err) {
    console.error('No se pudo reproducir el beep de atajo:', err);
  }
}

function notify(body) {
  try {
    new Notification('Abiction!', { body, silent: true });
  } catch (err) {
    console.error('No se pudo mostrar la notificación:', err);
  }
}

async function loadSources() {
  sourcesGrid.innerHTML = '<p class="hint">Cargando…</p>';
  const sources = await window.abiction.getSources();
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
  outputDir = await window.abiction.getDefaultOutputDir();
  outputDirHint.textContent = outputDir;
  tempDirHint.textContent = await window.abiction.getTempDir();
}

function formatDate(ms) {
  return new Date(ms).toLocaleString();
}

async function loadPendingRecordings() {
  const items = await window.abiction.listPendingRecordings();

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
    row.dataset.micPath = item.micPath || '';
    row.dataset.winAudioPath = item.winAudioPath || '';

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
      await window.abiction.discardPendingRecording(item.id);
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
  const durationSeconds = pendingDurationMap.get(item.id);

  const result = await window.abiction.finishRecording({
    videoPath: item.videoPath,
    micPath: item.micPath || null,
    winAudioPath: item.winAudioPath || null,
    outputDir,
    baseName,
    durationSeconds
  });

  pendingDurationMap.delete(item.id);
  return result;
}

compressSelectedBtn.addEventListener('click', async () => {
  const checkedItems = Array.from(pendingList.querySelectorAll('.pending-checkbox:checked')).map((cb) => {
    const row = cb.closest('.pending-item');
    return {
      id: row.dataset.id,
      videoPath: row.dataset.videoPath,
      micPath: row.dataset.micPath || null,
      winAudioPath: row.dataset.winAudioPath || null
    };
  });
  if (checkedItems.length === 0) return;

  compressSelectedBtn.disabled = true;
  resultBox.classList.add('hidden');
  encodeProgressWrap.classList.remove('hidden');

  const unsubscribe = window.abiction.onEncodeProgress(({ progress }) => {
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
    notify(
      results.length === 1
        ? `Grabación lista: ${results[0].outputPath.split(/[\\/]/).pop()} (${formatBytes(results[0].finalSizeBytes)})`
        : `${results.length} grabaciones optimizadas.`
    );
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

// Mic siempre. Audio de sistema (loopback clásico) SOLO como respaldo,
// cuando el helper nativo de audio por ventana no está disponible o falló
// — si el helper funcionó, alcanza con el mic solo acá (el audio de la
// ventana ya lo captura ese proceso aparte).
async function buildBrowserAudioStream(sourceId, includeSystemAudio) {
  let desktopStream = null;
  if (includeSystemAudio) {
    const videoConstraint = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } };
    const desktopAudioConstraint = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } };
    try {
      desktopStream = await navigator.mediaDevices.getUserMedia({ audio: desktopAudioConstraint, video: videoConstraint });
    } catch (err) {
      desktopStream = null;
    }
    if (desktopStream) {
      // El video de esta llamada no se usa (el real lo captura ffmpeg
      // aparte): se corta enseguida para no gastar recursos de más.
      desktopStream.getVideoTracks().forEach((track) => track.stop());
      activeStreams.push(desktopStream);
    }
  }

  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    activeStreams.push(micStream);
  } catch (err) {
    micStream = null;
  }

  const combined = new MediaStream();
  const sources = [desktopStream && desktopStream.getAudioTracks().length > 0 ? desktopStream : null, micStream].filter(Boolean);

  if (sources.length === 1) {
    sources[0].getAudioTracks().forEach((track) => combined.addTrack(track));
  } else if (sources.length > 1) {
    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    sources.forEach((stream) => {
      audioContext.createMediaStreamSource(stream).connect(destination);
    });
    destination.stream.getAudioTracks().forEach((track) => combined.addTrack(track));
  }

  return { stream: combined, hasAudio: sources.length > 0 };
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

  const id = `rec-${Date.now()}`;
  const sourcePayload = { id: selectedSourceId, name: selectedSourceName, isScreen: selectedSourceIsScreen, bounds: selectedSourceBounds };

  let videoCapture;
  try {
    videoCapture = await window.abiction.startVideoCapture({ id, mode: captureModeSelect.value, source: sourcePayload });
  } catch (err) {
    alert(`No se pudo iniciar la captura de video: ${err.message}`);
    isStarting = false;
    return;
  }
  videoCaptureId = id;
  videoPath = videoCapture.videoPath;

  // Intenta agarrar el audio de SOLO esta ventana con el helper nativo. Si
  // no se puede (pantalla completa, helper no compilado, o falla), cae a
  // audio de todo el sistema mezclado con el mic en el navegador.
  winAudioPath = null;
  let windowAudioOk = false;
  try {
    const waResult = await window.abiction.startWindowAudioCapture({ id, source: sourcePayload });
    windowAudioOk = Boolean(waResult && waResult.ok);
    if (windowAudioOk) winAudioPath = waResult.audioPath;
  } catch (err) {
    windowAudioOk = false;
  }
  windowAudioActive = windowAudioOk;

  let audioCaptured = { stream: new MediaStream(), hasAudio: false };
  try {
    audioCaptured = await buildBrowserAudioStream(selectedSourceId, !windowAudioOk);
  } catch (err) {
    console.error('No se pudo capturar audio del navegador:', err);
  }

  micRecordingId = null;
  micPath = null;
  micRecorder = null;

  if (audioCaptured.hasAudio) {
    const { id: aId, tempPath } = await window.abiction.startWriteStream({ id, suffix: 'mic' });
    micRecordingId = aId;
    micPath = tempPath;

    micRecorder = new MediaRecorder(audioCaptured.stream, {
      mimeType: pickAudioMimeType(),
      audioBitsPerSecond: 256_000
    });
    micRecorder.ondataavailable = async (event) => {
      if (event.data && event.data.size > 0) {
        const buffer = await event.data.arrayBuffer();
        window.abiction.writeChunk(micRecordingId, buffer);
      }
    };
    micRecorder.start(250);
  }

  recordStart = Date.now();
  accumulatedPauseMs = 0;
  isPaused = false;
  window.abiction.notifyRecordingStarted(recordStart);
  timerInterval = setInterval(() => {
    recTimer.textContent = formatTimer(Date.now() - recordStart - accumulatedPauseMs);
  }, 500);

  recDot.classList.add('live');
  recordBtn.textContent = '■ Detener grabación';
  recordBtn.classList.add('recording');
  pauseBtn.classList.remove('hidden');
  pauseBtn.textContent = '⏸ Pausar';
  isRecording = true;
  isStarting = false;
}

async function stopRecording() {
  isRecording = false;
  isPaused = false;
  clearInterval(timerInterval);
  recDot.classList.remove('live');
  pauseBtn.classList.add('hidden');
  window.abiction.notifyRecordingStopped();

  if (micRecorder && micRecorder.state !== 'inactive') {
    await new Promise((resolve) => {
      micRecorder.onstop = resolve;
      micRecorder.stop();
    });
  }
  stopAllStreams();
  if (micRecordingId) await window.abiction.endWriteStream(micRecordingId);

  await window.abiction.stopVideoCapture(videoCaptureId);
  if (winAudioPath) await window.abiction.stopWindowAudioCapture(videoCaptureId);

  // La duración real descuenta el tiempo que estuvo pausada (el video y el
  // audio finales tampoco incluyen esos tramos, se cortan de los archivos).
  pendingDurationMap.set(videoCaptureId, (Date.now() - recordStart - accumulatedPauseMs) / 1000);
  recordBtn.disabled = false;
  recordBtn.textContent = '● Iniciar grabación';
  recordBtn.classList.remove('recording');
  recTimer.textContent = '00:00:00';
  await loadPendingRecordings();
}

async function togglePause() {
  if (!isRecording) return;

  if (!isPaused) {
    isPaused = true;
    pauseStartedAt = Date.now();
    clearInterval(timerInterval);
    recDot.classList.remove('live');
    pauseBtn.textContent = '▶ Reanudar';
    window.abiction.notifyRecordingPaused();

    await window.abiction.pauseVideoCapture(videoCaptureId);
    if (windowAudioActive) await window.abiction.pauseWindowAudioCapture(videoCaptureId);
    if (micRecorder && micRecorder.state === 'recording') micRecorder.pause();
  } else {
    accumulatedPauseMs += Date.now() - pauseStartedAt;
    isPaused = false;
    recDot.classList.add('live');
    pauseBtn.textContent = '⏸ Pausar';
    timerInterval = setInterval(() => {
      recTimer.textContent = formatTimer(Date.now() - recordStart - accumulatedPauseMs);
    }, 500);
    // El "startedAt" que recibe el indicador flotante es virtual: se corre
    // hacia adelante lo mismo que se pausó, para que su timer (que solo
    // sabe hacer Date.now() - startedAt) siga mostrando el tiempo real de
    // grabación sin tener que enterarse de que hubo una pausa.
    window.abiction.notifyRecordingResumed(recordStart + accumulatedPauseMs);

    await window.abiction.resumeVideoCapture(videoCaptureId);
    if (windowAudioActive) await window.abiction.resumeWindowAudioCapture(videoCaptureId);
    if (micRecorder && micRecorder.state === 'paused') micRecorder.resume();
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
pauseBtn.addEventListener('click', togglePause);
window.abiction.onToggleRecordingShortcut(() => {
  playShortcutBeep();
  toggleRecording();
});
window.abiction.onTogglePauseShortcut(() => {
  playShortcutBeep();
  togglePause();
});

refreshSourcesBtn.addEventListener('click', loadSources);

captureModeInfoBtn.addEventListener('click', () => {
  captureModeInfo.classList.toggle('hidden');
});

window.abiction.onVideoCaptureError(({ message }) => {
  alert(`La grabación se interrumpió: ${message}`);
  if (isRecording) stopRecording();
});

window.abiction.onWriteError(({ message }) => {
  alert(`No se pudo seguir grabando audio: ${message}`);
});

uploadVideoBtn.addEventListener('click', async () => {
  const inputPath = await window.abiction.chooseVideoToUpload();
  if (!inputPath) return;

  uploadVideoBtn.disabled = true;
  uploadResultBox.classList.add('hidden');
  encodeProgressWrap.classList.remove('hidden');
  encodeProgressLabel.textContent = 'Optimizando video subido…';
  encodeProgress.value = 0;

  const unsubscribe = window.abiction.onEncodeProgress(({ progress }) => {
    encodeProgress.value = Math.round(progress * 100);
  });

  try {
    const result = await window.abiction.compressUploadedVideo({ inputPath, outputDir });
    const savedPercent = result.tempSizeBytes
      ? Math.round((1 - result.finalSizeBytes / result.tempSizeBytes) * 100)
      : 0;
    uploadResultBox.classList.remove('hidden');
    uploadResultBox.innerHTML = `
      <div>Archivo final: <strong>${result.outputPath}</strong></div>
      <div>Tamaño final: ${formatBytes(result.finalSizeBytes)}</div>
      <div>Codificado con: ${result.encoderUsed}</div>
      ${savedPercent > 0 ? `<div class="saving">Ahorro por recompresión: ${savedPercent}%</div>` : ''}
      <div style="margin-top:8px;"><button id="openUploadFolderBtn" class="ghost-btn">Abrir carpeta</button></div>
    `;
    document.getElementById('openUploadFolderBtn').addEventListener('click', () => {
      window.abiction.showInFolder(result.outputPath);
    });
    playChime();
    notify(`Video optimizado: ${result.outputPath.split(/[\\/]/).pop()}`);
  } catch (err) {
    uploadResultBox.classList.remove('hidden');
    uploadResultBox.textContent = `Error al optimizar el video: ${err.message}`;
  } finally {
    unsubscribe();
    encodeProgressWrap.classList.add('hidden');
    encodeProgressLabel.textContent = 'Optimizando video (compresión de alta calidad)…';
    uploadVideoBtn.disabled = false;
  }
});

async function loadShortcutHint() {
  const recordShortcut = await window.abiction.getRecordShortcut();
  const pauseShortcut = await window.abiction.getPauseShortcut();
  const shortcutHint = document.getElementById('shortcutHint');
  shortcutHint.textContent =
    `Atajos sin abrir la ventana — grabar/detener: "${recordShortcut}" · pausar/reanudar: "${pauseShortcut}"`;
}

loadSources();
loadFixedDirs();
loadShortcutHint();
loadPendingRecordings();
