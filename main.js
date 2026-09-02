const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, shell, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// ffmpeg-static resuelve una ruta dentro de app.asar, pero los binarios no se
// pueden ejecutar directamente desde ahí. electron-builder lo desempaqueta a
// app.asar.unpacked (ver "asarUnpack" en package.json); acá corregimos la ruta.
const ffmpegPath = app.isPackaged
  ? require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')
  : require('ffmpeg-static');

// Helper nativo (Windows.Graphics.Capture) para capturar ventanas con
// contenido acelerado por GPU (la mayoría de los juegos), algo que gdigrab
// en modo ventana no puede ver (captura BitBlt clásica de GDI). Mismo truco
// de ruta que ffmpeg-static para cuando está empaquetado dentro de asar.
const wgcCapturePath = app.isPackaged
  ? path.join(__dirname, 'native', 'wgc-capture.exe').replace('app.asar', 'app.asar.unpacked')
  : path.join(__dirname, 'native', 'wgc-capture.exe');

// Preferencias simples persistidas en disco (por ahora solo la carpeta
// temporal). os.tmpdir() en Windows siempre cae en el disco del sistema, que
// puede no tener espacio libre para capturas largas.
let settings = {};

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
  } catch (err) {
    settings = {};
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings));
  } catch (err) {
    console.error('No se pudieron guardar las preferencias:', err);
  }
}

function getTempDir() {
  return settings.tempDir && fs.existsSync(settings.tempDir) ? settings.tempDir : os.tmpdir();
}

// ffmpeg escribe una línea de progreso por stderr todo el tiempo que dura
// la captura EN VIVO (que puede ser horas). Guardar ese buffer entero sin
// límite (como se hacía antes) es una fuga de memoria lenta pero real para
// grabaciones largas — lo único que se necesita de él es revisar el final
// en busca de "no space left on device", así que alcanza con quedarse con
// la cola.
const STDERR_TAIL_LIMIT = 8000;
function appendBounded(buffer, chunk) {
  const combined = buffer + chunk;
  return combined.length > STDERR_TAIL_LIMIT ? combined.slice(-STDERR_TAIL_LIMIT) : combined;
}

// Un solo preset de recompresión: una pasada, calidad constante, audio
// copiado tal cual (sin recodificar). Los valores de "gpu" se eligieron
// midiendo en una GTX 1650 real: con estos parámetros el resultado terminó
// siendo más rápido Y más liviano que la CPU en la muestra de prueba
// (valores más simples como "-preset p5 -cq 22" dan archivos ~2x más pesados).
const QUALITY_PRESETS = {
  hevcAudioIntacto: {
    cpu: { codec: 'libx265', crf: 22, preset: 'medium' },
    gpu: { codec: 'hevc_nvenc', preset: 'p7', multipass: 'fullres', cq: 28 },
    tag: 'hvc1',
    copyAudio: true,
    label: 'Alta calidad HEVC (audio intacto)'
  }
};

function buildEncoderArgs(preset, useGpu) {
  if (useGpu) {
    const g = preset.gpu;
    return ['-c:v', g.codec, '-preset', g.preset, '-multipass', g.multipass, '-cq', String(g.cq), '-tag:v', preset.tag];
  }
  const c = preset.cpu;
  return ['-c:v', c.codec, '-crf', String(c.crf), '-preset', c.preset, '-tag:v', preset.tag];
}

// Prueba una sola vez por codec (y cachea el resultado) si ese encoder de
// GPU realmente funciona en esta máquina, en vez de asumir que hay una
// NVIDIA compatible. Si falla (no hay GPU, drivers viejos, etc.) el resto
// de la app sigue usando CPU como hacía antes. Parametrizado por codec
// porque la recompresión final usa hevc_nvenc (prioriza tamaño) y la
// captura en vivo usa h264_nvenc (prioriza velocidad/bajo uso de CPU) —
// no hay garantía de que uno funcione si el otro lo hace, aunque en la
// práctica casi siempre sea así (mismo motor NVENC).
const hwEncoderPromises = new Map();
function detectHardwareEncoder(codec = 'hevc_nvenc') {
  if (!hwEncoderPromises.has(codec)) {
    hwEncoderPromises.set(codec, new Promise((resolve) => {
      const proc = spawn(ffmpegPath, [
        '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=0.1',
        '-c:v', codec, '-f', 'null', '-'
      ]);
      let spawnFailed = false;
      proc.on('error', () => { spawnFailed = true; });
      proc.on('close', (code) => resolve(!spawnFailed && code === 0));
    }));
  }
  return hwEncoderPromises.get(codec);
}

// Salidas de resolución disponibles para achicar el peso final independiente
// de la calidad elegida. "-2" en el filtro scale mantiene la relación de
// aspecto y garantiza un ancho par (lo exigen los encoders).
const RESOLUTION_HEIGHTS = {
  original: null,
  '1080p': 1080,
  '720p': 720,
  '480p': 480
};

let mainWindow;
let floatingWindow;
const writeStreams = new Map();
const videoCaptures = new Map(); // id -> proceso ffmpeg de captura de video en vivo

// El video EN VIVO se captura con la herramienta de captura de pantalla nativa
// de cada sistema operativo (no con MediaRecorder del navegador): medimos que
// el "videoBitsPerSecond" del navegador para captura de escritorio es solo una
// sugerencia que Chromium se salta feo con contenido de mucho movimiento (se
// midió 2.7x-4.5x por encima de lo pedido en una prueba real). ffmpeg, en
// cambio, sí respeta un límite de bitrate real (-maxrate/-bufsize).
function buildScreenCaptureInputArgs(fps, source) {
  const framerate = String(fps);
  if (process.platform === 'win32') {
    if (source.isScreen) {
      // Sin "bounds" (no se pudo matchear el display), se mantiene el
      // comportamiento viejo: todo el escritorio virtual. Con "bounds" se
      // recorta la captura al monitor real que se seleccionó.
      if (source.bounds) {
        const { x, y, width, height } = source.bounds;
        return [
          '-f', 'gdigrab',
          '-framerate', framerate,
          '-offset_x', String(x),
          '-offset_y', String(y),
          '-video_size', `${width}x${height}`,
          '-i', 'desktop'
        ];
      }
      return ['-f', 'gdigrab', '-framerate', framerate, '-i', 'desktop'];
    }
    return ['-f', 'gdigrab', '-framerate', framerate, '-i', `title=${source.name}`];
  }
  if (process.platform === 'darwin') {
    // No hay forma confiable de detectar automáticamente el índice de pantalla
    // en avfoundation; se asume la pantalla principal como mejor esfuerzo.
    return ['-f', 'avfoundation', '-framerate', framerate, '-i', '1:none'];
  }
  // Linux (X11)
  return ['-f', 'x11grab', '-framerate', framerate, '-i', process.env.DISPLAY || ':0.0'];
}

// "Calidad máxima" codifica en vivo por CPU (libx264 ultrafast) como
// siempre — anda bien cuando no hay nada más peleando por CPU. "Bajo
// impacto (GPU)" usa el encoder de video de la GPU (h264_nvenc, no
// hevc_nvenc: acá importa velocidad y bajo uso de CPU, no tamaño — eso lo
// resuelve la recompresión final) para sacarle ese trabajo a la CPU casi
// por completo, que es lo que realmente hace falta cuando hay un juego
// pesado corriendo al mismo tiempo (bajar el bitrate solo, sin cambiar de
// encoder, no bajaba una carga de CPU real — medido con Genshin real).
function buildLiveEncoderArgs(fps, videoBitsPerSecond, useGpu) {
  const bps = String(Math.round(videoBitsPerSecond));
  const bufsize = String(Math.round(videoBitsPerSecond * 2));
  if (useGpu) {
    return [
      '-c:v', 'h264_nvenc',
      '-preset', 'p1',
      '-tune', 'll',
      '-rc', 'cbr',
      '-b:v', bps,
      '-maxrate', bps,
      '-bufsize', bufsize,
      '-pix_fmt', 'yuv420p',
      '-g', String(fps * 2)
    ];
  }
  return [
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-b:v', bps,
    '-maxrate', bps,
    '-bufsize', bufsize,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2)
  ];
}

// Bitrate + si usar GPU para la captura en vivo, según el modo elegido en
// la UI. Con GPU no hace falta sacrificar bitrate para "aliviar" — el
// ahorro real viene de sacarle el encode a la CPU, no de pedir menos
// calidad. Si se pidió "GPU" pero no hay una compatible, cae al mismo
// camino y bitrate de "CPU" tal cual — no hay motivo para además
// penalizarlo con menos calidad solo porque el usuario había elegido la
// otra opción (antes pasaba esto: elegir "GPU" sin tener una terminaba
// peor que haber elegido "CPU" directamente).
async function resolveLiveCaptureSettings(mode, fps) {
  const wantsGpu = mode === 'liviano';
  const useGpu = wantsGpu && (await detectHardwareEncoder('h264_nvenc'));
  const videoBitsPerSecond = useGpu
    ? (fps >= 60 ? 8_000_000 : 6_000_000)
    : (fps >= 60 ? 9_000_000 : 7_000_000);
  return { useGpu, videoBitsPerSecond };
}

// Intenta capturar una ventana puntual vía Windows.Graphics.Capture (ve
// contenido de GPU, a diferencia de "gdigrab -i title=..."). El helper
// nativo imprime "SIZE ancho alto" por stderr apenas resuelve la ventana, o
// "NOTFOUND" si no la encuentra. Si no contesta nada útil en poco tiempo (no
// existe el helper, la ventana no se puede capturar así, etc.) se resuelve
// con ok:false para que el llamador caiga al método viejo.
function tryStartWindowCaptureViaWgc(fps, windowIdentifier, videoBitsPerSecond, videoPath, useGpu) {
  return new Promise((resolve) => {
    let helperProc;
    try {
      helperProc = spawn(wgcCapturePath, [windowIdentifier, String(fps)]);
    } catch (err) {
      resolve({ ok: false });
      return;
    }

    let settled = false;
    let stderrBuffer = '';
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      helperProc.kill();
      resolve({ ok: false });
    }, 4000);

    helperProc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false });
    });

    helperProc.stderr.on('data', (data) => {
      stderrBuffer = appendBounded(stderrBuffer, data.toString());
      if (settled) return;

      if (/NOTFOUND/.test(stderrBuffer)) {
        settled = true;
        clearTimeout(timeout);
        resolve({ ok: false });
        return;
      }

      const match = stderrBuffer.match(/SIZE (\d+) (\d+)/);
      if (match) {
        settled = true;
        clearTimeout(timeout);
        const width = Number(match[1]);
        const height = Number(match[2]);

        const ffmpegProc = spawn(ffmpegPath, [
          '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-framerate', String(fps),
          '-i', 'pipe:0',
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          ...buildLiveEncoderArgs(fps, videoBitsPerSecond, useGpu),
          '-y', videoPath
        ]);
        helperProc.stdout.pipe(ffmpegProc.stdin);
        resolve({ ok: true, ffmpegProc, helperProc, getStderr: () => stderrBuffer });
      }
    });
  });
}

ipcMain.handle('start-video-capture', async (event, { id, fps, mode, source }) => {
  const videoPath = path.join(getTempDir(), `${id}-video.mp4`);
  const { useGpu, videoBitsPerSecond } = await resolveLiveCaptureSettings(mode, fps);

  let proc;
  let helperProc = null;
  let stderrBuffer = '';

  // Solo tiene sentido probar WGC para ventanas puntuales en Windows (para
  // pantallas completas, gdigrab con offset/video_size ya anda bien y es
  // más simple).
  if (process.platform === 'win32' && !source.isScreen) {
    // El id de una fuente de ventana en Electron/Windows viene como
    // "window:<hwnd>:0" — ese número es el handle real de la ventana.
    // Usarlo directo es exacto (a diferencia de buscar por el texto del
    // título, que puede fallar o agarrar la ventana equivocada si hay dos
    // con nombres parecidos). Si por algún motivo no matchea ese formato,
    // se cae al nombre como venía haciendo antes.
    const hwndMatch = /^window:(\d+):/.exec(source.id || '');
    const windowIdentifier = hwndMatch ? hwndMatch[1] : source.name;
    const wgc = await tryStartWindowCaptureViaWgc(fps, windowIdentifier, videoBitsPerSecond, videoPath, useGpu);
    if (wgc.ok) {
      proc = wgc.ffmpegProc;
      helperProc = wgc.helperProc;
      proc.stderr.on('data', (data) => { stderrBuffer = appendBounded(stderrBuffer, data.toString()); });
    }
  }

  if (!proc) {
    const inputArgs = buildScreenCaptureInputArgs(fps, source);
    const args = [...inputArgs, ...buildLiveEncoderArgs(fps, videoBitsPerSecond, useGpu), '-y', videoPath];
    proc = spawn(ffmpegPath, args);
    proc.stderr.on('data', (data) => { stderrBuffer = appendBounded(stderrBuffer, data.toString()); });
  }

  proc.on('error', (err) => {
    console.error('Error al iniciar la captura de video:', err);
  });

  const entry = { proc, helperProc, videoPath, getStderr: () => stderrBuffer, exited: false, stopRequested: false };
  videoCaptures.set(id, entry);

  // El evento 'close' de un child process se dispara UNA sola vez, en el
  // momento real en que el proceso termina. Si ffmpeg muere solo (crash,
  // disco lleno, se cerró la ventana capturada) ANTES de que el usuario
  // pida detener, ese evento ya ocurrió: escucharlo recién en
  // "stop-video-capture" nunca se dispara y la promesa de detener se queda
  // colgada para siempre. Por eso se trackea acá, apenas se lanza el
  // proceso, si ya terminó y por qué.
  proc.once('exit', (code, signal) => {
    entry.exited = true;
    entry.exitCode = code;
    entry.exitSignal = signal;

    if (!entry.stopRequested && mainWindow && !mainWindow.isDestroyed()) {
      const message = /no space left on device/i.test(stderrBuffer)
        ? 'Se quedó sin espacio en disco donde se guarda la grabación. Elegí otra carpeta temporal con más espacio en Opciones.'
        : 'La grabación en vivo se detuvo inesperadamente. Es posible que se haya perdido parte de la captura.';
      mainWindow.webContents.send('video-capture-error', { id, message });
    }
  });

  return { id, videoPath };
});

ipcMain.handle('stop-video-capture', (event, id) => {
  return new Promise((resolve) => {
    const entry = videoCaptures.get(id);
    if (!entry) {
      resolve();
      return;
    }
    entry.stopRequested = true;

    // Si el proceso ya había terminado antes de este pedido (ver el
    // listener 'exit' de arriba), no hay ningún 'close' pendiente por
    // esperar: resolver directo evita quedarse colgado para siempre.
    if (entry.exited) {
      videoCaptures.delete(id);
      resolve();
      return;
    }

    const { proc, helperProc } = entry;
    const forceKillTimer = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
      if (helperProc && !helperProc.killed) helperProc.kill('SIGKILL');
    }, 5000);
    proc.once('close', () => {
      clearTimeout(forceKillTimer);
      if (helperProc && !helperProc.killed) helperProc.kill();
      videoCaptures.delete(id);
      resolve();
    });

    if (helperProc) {
      // Con captura por WGC, el stdin de ffmpeg está ocupado por la tubería
      // desde el helper (helperProc.stdout.pipe(proc.stdin)): hay que
      // avisarle al HELPER que pare, no escribirle directo a ffmpeg. Al
      // cerrarse el stdout del helper, la tubería cierra el stdin de ffmpeg
      // solo y este termina de codificar y sale, disparando el 'close' de
      // arriba igual que en el camino viejo.
      try {
        helperProc.stdin.write('q\n');
      } catch (err) {
        helperProc.kill();
      }
    } else {
      // "q" por stdin le pide a ffmpeg que cierre el archivo prolijamente
      // (con duración válida en el header), en vez de matarlo de un tirón.
      try {
        proc.stdin.write('q');
      } catch (err) {
        proc.kill();
      }
    }
  });
});

// Atajo global para iniciar/detener la grabación sin tener que hacer foco
// en la ventana (útil porque abrir la app taparía lo que se está grabando).
// F9 puede chocar con otros programas que ya lo usan (GeForce Experience,
// otros grabadores, etc.) — se prueban estos en orden y se usa el primero
// que se pueda registrar de verdad, en vez de asumir que F9 siempre queda
// activo.
const RECORD_SHORTCUT_CANDIDATES = ['F9', 'F10', 'F11', 'Alt+F9'];
let activeRecordShortcut = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Sin esto, Chromium le baja la prioridad a los timers de la ventana
      // cuando queda sin foco o minimizada (lo normal mientras se juega),
      // lo que puede meter tartamudeo en la grabación aunque el juego en sí
      // no se entere (lo dibuja la GPU aparte).
      backgroundThrottling: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // El indicador flotante se deja vivo y oculto entre grabaciones (para no
  // recrearlo cada vez), así que "ventana principal cerrada" NO implica
  // "cero ventanas abiertas" para Electron: si grabaste al menos una vez,
  // cerrar la ventana principal no disparaba 'window-all-closed' y la app
  // entera se quedaba corriendo en segundo plano, invisible, para siempre.
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.destroy();
      floatingWindow = null;
    }
  });
}

function createFloatingWindow() {
  const display = screen.getPrimaryDisplay();
  const width = 150;
  const height = 46;

  floatingWindow = new BrowserWindow({
    width,
    height,
    x: display.workArea.x + display.workArea.width - width - 16,
    y: display.workArea.y + 16,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  floatingWindow.setAlwaysOnTop(true, 'screen-saver');
  // Evita que el propio indicador aparezca en la grabación (Windows/macOS).
  floatingWindow.setContentProtection(true);
  // El pill no tiene ningún botón ni control, solo texto — no hay ninguna
  // razón para que le robe los clicks del mouse a lo que esté debajo (por
  // ejemplo, un botón del juego que quede tapado por el indicador).
  floatingWindow.setIgnoreMouseEvents(true);
  floatingWindow.loadFile(path.join(__dirname, 'src', 'floating.html'));
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();

  for (const candidate of RECORD_SHORTCUT_CANDIDATES) {
    const registered = globalShortcut.register(candidate, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('toggle-recording-shortcut');
      }
    });
    if (registered) {
      activeRecordShortcut = candidate;
      break;
    }
  }

  if (!activeRecordShortcut) {
    console.error(`No se pudo registrar ningún atajo (${RECORD_SHORTCUT_CANDIDATES.join(', ')}) — puede que otro programa ya los esté usando.`);
    dialog.showErrorBox(
      'Lowey Screen Recorder',
      `No se pudo activar ningún atajo de teclado global (${RECORD_SHORTCUT_CANDIDATES.join(', ')}). ` +
        'Puede que otro programa ya lo esté usando (por ejemplo GeForce Experience u otro grabador). ' +
        'Vas a tener que usar el botón de la ventana para iniciar y detener la grabación.'
    );
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  videoCaptures.forEach(({ proc, helperProc }) => {
    try {
      proc.kill();
    } catch (err) {
      // ya terminado
    }
    if (helperProc) {
      try {
        helperProc.kill();
      } catch (err) {
        // ya terminado
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('render-process-gone', (event, webContents, details) => {
  dialog.showErrorBox(
    'Lowey Screen Recorder',
    `La ventana se cerró inesperadamente (motivo: ${details.reason}). ` +
      'Si pasó justo al iniciar una grabación, probá desactivar "Grabar audio del sistema" y reintentar.'
  );
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception en el proceso principal:', err);
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showErrorBox('Lowey Screen Recorder', `Error inesperado: ${err.message}`);
  }
});

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });
  const displays = screen.getAllDisplays();

  return sources.map((s) => {
    const isScreen = s.id.startsWith('screen:');
    // Sin esto, "gdigrab -i desktop" siempre agarra el escritorio virtual
    // COMPLETO (todos los monitores concatenados), sin importar cuál
    // pantalla se eligió acá. Con los bounds reales del monitor se puede
    // recortar la captura a la pantalla que el usuario realmente clickeó
    // (ver buildScreenCaptureInputArgs). display_id coincide con el id de
    // screen.getAllDisplays() (confirmado a mano en Electron 31 + Win11);
    // si algún día no coincidiera, bounds queda null y se cae al
    // comportamiento anterior (todo el escritorio) en vez de romper nada.
    let bounds = null;
    if (isScreen) {
      const display = displays.find((d) => String(d.id) === s.display_id);
      if (display) bounds = display.bounds;
    }
    return {
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      isScreen,
      bounds
    };
  });
});

ipcMain.handle('get-record-shortcut', () => activeRecordShortcut || 'ninguno (no se pudo activar)');

ipcMain.handle('get-resolution-options', () => Object.keys(RESOLUTION_HEIGHTS));

ipcMain.on('recording-started', (event, startedAt) => {
  if (!floatingWindow || floatingWindow.isDestroyed()) createFloatingWindow();
  floatingWindow.webContents.once('did-finish-load', () => {
    floatingWindow.webContents.send('floating-start', startedAt);
  });
  if (!floatingWindow.webContents.isLoading()) {
    floatingWindow.webContents.send('floating-start', startedAt);
  }
  floatingWindow.showInactive();
});

ipcMain.on('recording-stopped', () => {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.hide();
  }
});

ipcMain.handle('choose-save-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-default-output-dir', () => {
  return path.join(app.getPath('videos'), 'Lowey Screen Recorder');
});

ipcMain.handle('get-temp-dir', () => getTempDir());

ipcMain.handle('choose-temp-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  settings.tempDir = result.filePaths[0];
  saveSettings();
  return settings.tempDir;
});

ipcMain.handle('start-write-stream', async (event, { id }) => {
  const tempPath = path.join(getTempDir(), `${id}-audio.webm`);
  const stream = fs.createWriteStream(tempPath);
  stream.on('error', (err) => {
    console.error('Error escribiendo el archivo temporal:', err);
    writeStreams.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('write-error', {
        id,
        message: err.code === 'ENOSPC'
          ? 'Se quedó sin espacio en disco donde se guarda el archivo temporal. Elegí otra carpeta temporal con más espacio en Opciones.'
          : err.message
      });
    }
  });
  writeStreams.set(id, stream);
  return { id, tempPath };
});

ipcMain.on('write-chunk', (event, id, chunk) => {
  const stream = writeStreams.get(id);
  if (stream) stream.write(Buffer.from(chunk));
});

ipcMain.handle('end-write-stream', async (event, id) => {
  const stream = writeStreams.get(id);
  if (!stream) return;
  await new Promise((resolve) => stream.end(resolve));
  writeStreams.delete(id);
});

// Cada grabación pendiente son dos archivos con el mismo id: "<id>-video.mp4"
// (siempre existe) y opcionalmente "<id>-audio.webm" (si se grabó audio).
const PENDING_ID_RE = /^rec-\d+$/;
const PENDING_VIDEO_RE = /^(rec-\d+)-video\.mp4$/;

ipcMain.handle('list-pending-recordings', () => {
  const dir = getTempDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return [];
  }

  return files
    .map((name) => ({ name, match: name.match(PENDING_VIDEO_RE) }))
    .filter(({ match }) => match)
    .map(({ name, match }) => {
      const id = match[1];
      const videoPath = path.join(dir, name);
      const audioPath = path.join(dir, `${id}-audio.webm`);
      const hasAudio = fs.existsSync(audioPath);
      const videoStat = fs.statSync(videoPath);
      const audioSize = hasAudio ? fs.statSync(audioPath).size : 0;
      return {
        id,
        videoPath,
        audioPath: hasAudio ? audioPath : null,
        sizeBytes: videoStat.size + audioSize,
        createdAt: videoStat.mtimeMs
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
});

ipcMain.handle('discard-pending-recording', (event, id) => {
  if (!PENDING_ID_RE.test(id)) {
    throw new Error('Id inválido.');
  }
  const dir = getTempDir();
  fs.unlink(path.join(dir, `${id}-video.mp4`), () => {});
  fs.unlink(path.join(dir, `${id}-audio.webm`), () => {});
});

function parseDurationSeconds(text) {
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// knownDurationSeconds: duración real ya conocida (trackeada en el renderer
// con Date.now() mientras se grababa). Los .webm que graba esta app quedan
// sin duración en el header (son streaming, sin Cues/Duration), así que
// ffmpeg reporta "Duration: N/A" y nunca podría calcular el progreso por sí
// solo: por eso se le pasa la duración real de afuera en vez de depender de
// que ffmpeg la lea del archivo.
function runFfmpeg(args, knownDurationSeconds) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    let totalDuration = knownDurationSeconds > 0 ? knownDurationSeconds : null;
    // "Duration:" solo aparece una vez, cerca del arranque — se junta en un
    // buffer aparte que se descarta apenas se encuentra (o si nunca aparece,
    // igual se acota) en vez de mezclarlo con el buffer de progreso, que sí
    // necesita crecer durante toda la compresión.
    let headerBuffer = '';
    // Para "time=" y para el mensaje de error final solo hace falta lo más
    // reciente — sin acotar esto, una recompresión de una grabación de
    // varias horas iba juntando el log de progreso entero en memoria para
    // nada (nunca se lee más que la última aparición).
    let tailBuffer = '';

    ff.stderr.on('data', (data) => {
      const text = data.toString();

      if (totalDuration === null) {
        headerBuffer += text;
        const d = parseDurationSeconds(headerBuffer);
        if (d) {
          totalDuration = d;
          headerBuffer = '';
        } else if (headerBuffer.length > 20000) {
          headerBuffer = headerBuffer.slice(-20000);
        }
      }
      tailBuffer = appendBounded(tailBuffer, text);

      // Se busca la ÚLTIMA aparición de "time=" en la cola acumulada (no
      // solo en este pedacito) para no perder actualizaciones si un
      // "time=..." queda partido justo entre dos chunks del stream.
      if (totalDuration) {
        const matches = [...tailBuffer.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
        if (matches.length > 0) {
          const [, h, m, s] = matches[matches.length - 1];
          const t = Number(h) * 3600 + Number(m) * 60 + Number(s);
          const progress = Math.min(1, t / totalDuration);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('encode-progress', { progress });
          }
        }
      }
    });

    ff.on('error', reject);

    ff.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg terminó con código ${code}:\n${tailBuffer.slice(-2000)}`));
        return;
      }
      resolve();
    });
  });
}

ipcMain.handle('finish-recording', async (event, { videoPath, audioPath, outputDir, baseName, qualityId, keepAudio, resolutionId, durationSeconds }) => {
  const preset = QUALITY_PRESETS[qualityId] || QUALITY_PRESETS.hevcAudioIntacto;
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${baseName}.mp4`);

  const targetHeight = RESOLUTION_HEIGHTS[resolutionId] || null;
  const scaleArgs = targetHeight ? ['-vf', `scale=-2:${targetHeight}`] : [];

  const hasAudio = Boolean(keepAudio && audioPath && fs.existsSync(audioPath));
  const inputArgs = hasAudio ? ['-i', videoPath, '-i', audioPath] : ['-i', videoPath];
  const mapArgs = hasAudio ? ['-map', '0:v', '-map', '1:a'] : [];
  const audioArgs = hasAudio
    ? (preset.copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'])
    : ['-an'];
  const trailingArgs = ['-pix_fmt', 'yuv420p', ...audioArgs, '-movflags', '+faststart', outputPath];

  const hasGpu = await detectHardwareEncoder('hevc_nvenc');
  let encoderUsed = hasGpu ? 'GPU (NVENC)' : 'CPU';

  try {
    const encoderArgs = buildEncoderArgs(preset, hasGpu);
    await runFfmpeg(
      ['-y', ...inputArgs, ...mapArgs, ...scaleArgs, ...encoderArgs, ...trailingArgs],
      durationSeconds
    );
  } catch (err) {
    // Si la GPU falla en el intento real (no solo en la prueba de arranque),
    // se reintenta una vez por CPU en vez de perder toda la grabación.
    if (!hasGpu) throw err;
    console.error('Falló la compresión por GPU, reintentando por CPU:', err);
    encoderUsed = 'CPU';
    const cpuArgs = buildEncoderArgs(preset, false);
    await runFfmpeg(
      ['-y', ...inputArgs, ...mapArgs, ...scaleArgs, ...cpuArgs, ...trailingArgs],
      durationSeconds
    );
  }

  const videoSize = fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0;
  const audioSize = hasAudio ? fs.statSync(audioPath).size : 0;
  const finalSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

  fs.unlink(videoPath, () => {});
  if (audioPath) fs.unlink(audioPath, () => {});

  return {
    outputPath,
    tempSizeBytes: videoSize + audioSize,
    finalSizeBytes: finalSize,
    encoderUsed
  };
});

ipcMain.handle('show-in-folder', (event, filePath) => {
  shell.showItemInFolder(filePath);
});
