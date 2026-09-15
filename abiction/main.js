const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, shell, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ffmpeg-static resuelve una ruta dentro de app.asar, pero los binarios no se
// pueden ejecutar directamente desde ahí. electron-builder lo desempaqueta a
// app.asar.unpacked (ver "asarUnpack" en package.json); acá corregimos la ruta.
const ffmpegPath = app.isPackaged
  ? require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')
  : require('ffmpeg-static');

// Helper nativo (Windows.Graphics.Capture) para capturar ventanas con
// contenido acelerado por GPU (la mayoría de las apps de videollamada),
// idéntico al usado en Lowey Screen Recorder.
const wgcCapturePath = app.isPackaged
  ? path.join(__dirname, 'native', 'wgc-capture.exe').replace('app.asar', 'app.asar.unpacked')
  : path.join(__dirname, 'native', 'wgc-capture.exe');

// Helper nativo NUEVO (Process Loopback Capture) para agarrar el audio de
// SOLO la ventana que se está grabando, en vez del audio de todo el sistema.
// ⚠️ Este helper (código fuente en native-audio-src/) nunca se compiló ni se
// probó en Windows real. Si el .exe no existe todavía (no lo compilaste) o
// falla al arrancar, la app cae sola al audio de todo el sistema (loopback
// clásico) en vez de romper la grabación.
const wgcAudioCapturePath = app.isPackaged
  ? path.join(__dirname, 'native', 'wgc-audio-capture.exe').replace('app.asar', 'app.asar.unpacked')
  : path.join(__dirname, 'native', 'wgc-audio-capture.exe');

// Esta app no tiene configuración: siempre graba a 1080p/60fps, siempre con
// mic, siempre con el audio de la ventana grabada, y siempre a las mismas
// dos carpetas fijas (la temporal es la MISMA que usa Lowey Screen
// Recorder). Se crean solas si no existen.
const OUTPUT_DIR = 'D:\\Grabaciones videollamada';
const TEMP_DIR = 'D:/temp';

function getTempDir() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  return TEMP_DIR;
}

// ffmpeg escribe una línea de progreso por stderr todo el tiempo que dura
// la captura EN VIVO (que puede ser horas). Guardar ese buffer entero sin
// límite es una fuga de memoria lenta pero real para grabaciones largas —
// alcanza con quedarse con la cola (para detectar "no space left on device").
const STDERR_TAIL_LIMIT = 8000;
function appendBounded(buffer, chunk) {
  const combined = buffer + chunk;
  return combined.length > STDERR_TAIL_LIMIT ? combined.slice(-STDERR_TAIL_LIMIT) : combined;
}

// Un solo preset de recompresión: una pasada, calidad constante. El tag
// hvc1 es lo que hace que Windows Explorer / reproductores tipo Cyberlink
// PowerDVD puedan generar la miniatura y reproducir el HEVC sin marcarlo
// como códec desconocido.
const QUALITY_PRESETS = {
  hevcAudioIntacto: {
    cpu: { codec: 'libx265', crf: 22, preset: 'medium' },
    gpu: { codec: 'hevc_nvenc', preset: 'p7', multipass: 'fullres', cq: 24 },
    tag: 'hvc1',
    label: 'Alta calidad HEVC'
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
// GPU realmente funciona en esta máquina.
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

// Resolución/fps fijos: 1080p, 60fps.
const OUTPUT_HEIGHT = 1080;
const FPS = 60;

let mainWindow;
let floatingWindow;
const videoCaptures = new Map(); // id -> proceso ffmpeg de captura de video en vivo
const audioCaptures = new Map(); // id -> proceso(s) de captura de audio de la ventana

function buildScreenCaptureInputArgs(fps, source) {
  const framerate = String(fps);
  if (process.platform === 'win32') {
    if (source.isScreen) {
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
    return ['-f', 'avfoundation', '-framerate', framerate, '-i', '1:none'];
  }
  return ['-f', 'x11grab', '-framerate', framerate, '-i', process.env.DISPLAY || ':0.0'];
}

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

// A 1080p/60fps hace falta más bitrate en vivo que en Lowey (720p/30) para
// que la captura intermedia no se note pixelada.
async function resolveLiveCaptureSettings(mode) {
  const wantsGpu = mode === 'liviano';
  const useGpu = wantsGpu && (await detectHardwareEncoder('h264_nvenc'));
  const videoBitsPerSecond = 14_000_000;
  return { useGpu, videoBitsPerSecond };
}

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

function extractHwnd(sourceId) {
  const hwndMatch = /^window:(\d+):/.exec(sourceId || '');
  return hwndMatch ? hwndMatch[1] : null;
}

ipcMain.handle('start-video-capture', async (event, { id, mode, source }) => {
  const videoPath = path.join(getTempDir(), `${id}-video.mp4`);
  const { useGpu, videoBitsPerSecond } = await resolveLiveCaptureSettings(mode);

  let proc;
  let helperProc = null;
  let stderrBuffer = '';

  if (process.platform === 'win32' && !source.isScreen) {
    const windowIdentifier = extractHwnd(source.id) || source.name;
    const wgc = await tryStartWindowCaptureViaWgc(FPS, windowIdentifier, videoBitsPerSecond, videoPath, useGpu);
    if (wgc.ok) {
      proc = wgc.ffmpegProc;
      helperProc = wgc.helperProc;
      proc.stderr.on('data', (data) => { stderrBuffer = appendBounded(stderrBuffer, data.toString()); });
    }
  }

  if (!proc) {
    const inputArgs = buildScreenCaptureInputArgs(FPS, source);
    const args = [...inputArgs, ...buildLiveEncoderArgs(FPS, videoBitsPerSecond, useGpu), '-y', videoPath];
    proc = spawn(ffmpegPath, args);
    proc.stderr.on('data', (data) => { stderrBuffer = appendBounded(stderrBuffer, data.toString()); });
  }

  proc.on('error', (err) => {
    console.error('Error al iniciar la captura de video:', err);
  });

  const entry = { proc, helperProc, videoPath, getStderr: () => stderrBuffer, exited: false, stopRequested: false };
  videoCaptures.set(id, entry);

  proc.once('exit', (code, signal) => {
    entry.exited = true;
    entry.exitCode = code;
    entry.exitSignal = signal;

    if (!entry.stopRequested && mainWindow && !mainWindow.isDestroyed()) {
      const message = /no space left on device/i.test(stderrBuffer)
        ? `Se quedó sin espacio en disco en ${TEMP_DIR}.`
        : 'La grabación en vivo se detuvo inesperadamente. Es posible que se haya perdido parte de la captura.';
      mainWindow.webContents.send('video-capture-error', { id, message });
    }
  });

  return { id, videoPath };
});

function stopChildProcess(entry) {
  return new Promise((resolve) => {
    if (!entry) {
      resolve();
      return;
    }
    entry.stopRequested = true;
    if (entry.exited) {
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
      resolve();
    });
    if (helperProc) {
      try {
        helperProc.stdin.write('q\n');
      } catch (err) {
        helperProc.kill();
      }
    } else {
      try {
        proc.stdin.write('q');
      } catch (err) {
        proc.kill();
      }
    }
  });
}

ipcMain.handle('stop-video-capture', async (event, id) => {
  const entry = videoCaptures.get(id);
  await stopChildProcess(entry);
  videoCaptures.delete(id);
});

// Captura de audio SOLO de la ventana grabada, vía el helper nuevo de
// Process Loopback. Si la fuente es una pantalla completa (no hay una sola
// ventana/proceso al que limitarse) o el helper no existe/falla, se
// resuelve con ok:false para que el renderer caiga a audio de todo el
// sistema (loopback clásico del navegador) en vez de grabar sin audio.
function tryStartWindowAudioViaWgc(hwnd, audioPath) {
  return new Promise((resolve) => {
    let helperProc;
    try {
      helperProc = spawn(wgcAudioCapturePath, [hwnd]);
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

      const match = stderrBuffer.match(/FORMAT (\d+) (\d+)/);
      if (match) {
        settled = true;
        clearTimeout(timeout);
        const sampleRate = match[1];
        const channels = match[2];

        const ffmpegProc = spawn(ffmpegPath, [
          '-f', 'f32le', '-ar', sampleRate, '-ac', channels,
          '-i', 'pipe:0',
          '-c:a', 'aac', '-b:a', '192k',
          '-y', audioPath
        ]);
        helperProc.stdout.pipe(ffmpegProc.stdin);
        resolve({ ok: true, ffmpegProc, helperProc });
      }
    });
  });
}

ipcMain.handle('start-window-audio-capture', async (event, { id, source }) => {
  if (process.platform !== 'win32' || source.isScreen) {
    return { ok: false };
  }
  const hwnd = extractHwnd(source.id);
  if (!hwnd) return { ok: false };

  const audioPath = path.join(getTempDir(), `${id}-winaudio.m4a`);
  const result = await tryStartWindowAudioViaWgc(hwnd, audioPath);
  if (!result.ok) return { ok: false };

  const entry = { proc: result.ffmpegProc, helperProc: result.helperProc, exited: false, stopRequested: false };
  result.ffmpegProc.once('exit', () => { entry.exited = true; });
  audioCaptures.set(id, entry);
  return { ok: true, audioPath };
});

ipcMain.handle('stop-window-audio-capture', async (event, id) => {
  const entry = audioCaptures.get(id);
  await stopChildProcess(entry);
  audioCaptures.delete(id);
});

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
      backgroundThrottling: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

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
  floatingWindow.setContentProtection(true);
  floatingWindow.setIgnoreMouseEvents(true);
  floatingWindow.loadFile(path.join(__dirname, 'src', 'floating.html'));
}

app.whenReady().then(() => {
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
    dialog.showErrorBox(
      'Abiction!',
      `No se pudo activar ningún atajo de teclado global (${RECORD_SHORTCUT_CANDIDATES.join(', ')}). ` +
        'Vas a tener que usar el botón de la ventana para iniciar y detener la grabación.'
    );
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  [...videoCaptures.values(), ...audioCaptures.values()].forEach(({ proc, helperProc }) => {
    try { proc.kill(); } catch (err) { /* ya terminado */ }
    if (helperProc) {
      try { helperProc.kill(); } catch (err) { /* ya terminado */ }
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
  dialog.showErrorBox('Abiction!', `La ventana se cerró inesperadamente (motivo: ${details.reason}).`);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception en el proceso principal:', err);
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showErrorBox('Abiction!', `Error inesperado: ${err.message}`);
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

ipcMain.handle('get-default-output-dir', () => OUTPUT_DIR);
ipcMain.handle('get-temp-dir', () => getTempDir());

// --- Audio del renderer (mic solo, o mic+sistema mezclados en el navegador
// cuando el helper nativo de audio por ventana no está disponible) ---
const writeStreams = new Map();

ipcMain.handle('start-write-stream', async (event, { id, suffix }) => {
  const tempPath = path.join(getTempDir(), `${id}-${suffix}.webm`);
  const stream = fs.createWriteStream(tempPath);
  stream.on('error', (err) => {
    writeStreams.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('write-error', {
        id,
        message: err.code === 'ENOSPC' ? `Se quedó sin espacio en disco en ${TEMP_DIR}.` : err.message
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

// Cada grabación pendiente puede ser hasta 3 archivos con el mismo id:
// "<id>-video.mp4" (siempre), "<id>-mic.webm" (mic, siempre que se haya
// podido capturar) y "<id>-winaudio.m4a" (solo si el helper nativo de
// audio por ventana funcionó).
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
      const micPath = path.join(dir, `${id}-mic.webm`);
      const winAudioPath = path.join(dir, `${id}-winaudio.m4a`);
      const hasMic = fs.existsSync(micPath);
      const hasWinAudio = fs.existsSync(winAudioPath);
      const videoStat = fs.statSync(videoPath);
      const size = videoStat.size
        + (hasMic ? fs.statSync(micPath).size : 0)
        + (hasWinAudio ? fs.statSync(winAudioPath).size : 0);
      return {
        id,
        videoPath,
        micPath: hasMic ? micPath : null,
        winAudioPath: hasWinAudio ? winAudioPath : null,
        sizeBytes: size,
        createdAt: videoStat.mtimeMs
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
});

ipcMain.handle('discard-pending-recording', (event, id) => {
  if (!PENDING_ID_RE.test(id)) throw new Error('Id inválido.');
  const dir = getTempDir();
  fs.unlink(path.join(dir, `${id}-video.mp4`), () => {});
  fs.unlink(path.join(dir, `${id}-mic.webm`), () => {});
  fs.unlink(path.join(dir, `${id}-winaudio.m4a`), () => {});
});

function parseDurationSeconds(text) {
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function runFfmpeg(args, knownDurationSeconds) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    let totalDuration = knownDurationSeconds > 0 ? knownDurationSeconds : null;
    let headerBuffer = '';
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

// videoPath: siempre. micPath: audio del mic solo, O mic+sistema ya
// mezclados en el navegador (según pudo o no usarse el helper nativo).
// winAudioPath: audio nativo de la ventana, solo si ese helper funcionó —
// cuando está presente, se mezcla con micPath vía amix (los dos suenan a la
// vez, no uno encima cortando al otro).
async function encodeFinal({ videoPath, micPath, winAudioPath, outputPath, scaleHeight, durationSeconds }) {
  const preset = QUALITY_PRESETS.hevcAudioIntacto;
  const hasMic = Boolean(micPath && fs.existsSync(micPath));
  const hasWinAudio = Boolean(winAudioPath && fs.existsSync(winAudioPath));

  const inputArgs = ['-i', videoPath];
  if (hasMic) inputArgs.push('-i', micPath);
  if (hasWinAudio) inputArgs.push('-i', winAudioPath);

  let mapArgs;
  let filterArgs = [];
  let audioEncodeArgs;
  if (hasMic && hasWinAudio) {
    filterArgs = ['-filter_complex', '[1:a][2:a]amix=inputs=2:duration=longest:normalize=0[aout]'];
    mapArgs = ['-map', '0:v', '-map', '[aout]'];
    audioEncodeArgs = ['-c:a', 'aac', '-b:a', '192k'];
  } else if (hasMic || hasWinAudio) {
    mapArgs = ['-map', '0:v', '-map', '1:a'];
    audioEncodeArgs = ['-c:a', 'aac', '-b:a', '192k'];
  } else {
    mapArgs = [];
    audioEncodeArgs = ['-an'];
  }

  const scaleArgs = scaleHeight ? ['-vf', `scale=-2:${scaleHeight}`] : [];
  const trailingArgs = ['-pix_fmt', 'yuv420p', ...audioEncodeArgs, '-movflags', '+faststart', outputPath];

  const hasGpu = await detectHardwareEncoder('hevc_nvenc');
  let encoderUsed = hasGpu ? 'GPU (NVENC)' : 'CPU';

  try {
    const encoderArgs = buildEncoderArgs(preset, hasGpu);
    await runFfmpeg(
      ['-y', ...inputArgs, ...filterArgs, ...mapArgs, ...scaleArgs, ...encoderArgs, ...trailingArgs],
      durationSeconds
    );
  } catch (err) {
    if (!hasGpu) throw err;
    console.error('Falló la compresión por GPU, reintentando por CPU:', err);
    encoderUsed = 'CPU';
    const cpuArgs = buildEncoderArgs(preset, false);
    await runFfmpeg(
      ['-y', ...inputArgs, ...filterArgs, ...mapArgs, ...scaleArgs, ...cpuArgs, ...trailingArgs],
      durationSeconds
    );
  }

  return encoderUsed;
}

ipcMain.handle('finish-recording', async (event, { videoPath, micPath, winAudioPath, outputDir, baseName, durationSeconds }) => {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${baseName}.mp4`);

  const encoderUsed = await encodeFinal({
    videoPath, micPath, winAudioPath, outputPath,
    scaleHeight: OUTPUT_HEIGHT,
    durationSeconds
  });

  const videoSize = fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0;
  const micSize = micPath && fs.existsSync(micPath) ? fs.statSync(micPath).size : 0;
  const winAudioSize = winAudioPath && fs.existsSync(winAudioPath) ? fs.statSync(winAudioPath).size : 0;
  const finalSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

  fs.unlink(videoPath, () => {});
  if (micPath) fs.unlink(micPath, () => {});
  if (winAudioPath) fs.unlink(winAudioPath, () => {});

  return {
    outputPath,
    tempSizeBytes: videoSize + micSize + winAudioSize,
    finalSizeBytes: finalSize,
    encoderUsed
  };
});

// "Subir video": comprime un archivo YA EXISTENTE (grabado o no por esta
// app) con el mismo pipeline de calidad constante, SIN forzar su
// resolución — el pedido fue optimizar el peso, no cambiar el tamaño de un
// video que puede venir de otro lado (por ejemplo, la grabación nativa de
// Zoom/Teams).
ipcMain.handle('choose-video-to-upload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('compress-uploaded-video', async (event, { inputPath, outputDir }) => {
  fs.mkdirSync(outputDir, { recursive: true });
  const base = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(outputDir, `${base}_optimizado.mp4`);

  // El archivo subido ya trae su propio audio (a diferencia de una
  // grabación de esta app, donde el audio viene de archivos separados) —
  // alcanza con un -i simple, sin -map/-filter_complex, y sin escalar (se
  // respeta la resolución original del video subido).
  const preset = QUALITY_PRESETS.hevcAudioIntacto;
  const trailingArgs = ['-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath];
  const hasGpu = await detectHardwareEncoder('hevc_nvenc');
  let encoderUsed = hasGpu ? 'GPU (NVENC)' : 'CPU';

  try {
    const encoderArgs = buildEncoderArgs(preset, hasGpu);
    await runFfmpeg(['-y', '-i', inputPath, ...encoderArgs, ...trailingArgs]);
  } catch (err) {
    if (!hasGpu) throw err;
    console.error('Falló la compresión por GPU, reintentando por CPU:', err);
    encoderUsed = 'CPU';
    const cpuArgs = buildEncoderArgs(preset, false);
    await runFfmpeg(['-y', '-i', inputPath, ...cpuArgs, ...trailingArgs]);
  }

  const originalSize = fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0;
  const finalSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

  return {
    outputPath,
    tempSizeBytes: originalSize,
    finalSizeBytes: finalSize,
    encoderUsed
  };
});

ipcMain.handle('show-in-folder', (event, filePath) => {
  shell.showItemInFolder(filePath);
});
