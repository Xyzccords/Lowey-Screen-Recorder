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

// Presets de recompresión: usan CRF (calidad constante) en vez de bitrate fijo,
// que es lo que permite lograr "misma calidad, menos peso" frente a grabadores
// que graban directo a un bitrate alto durante toda la sesión.
const QUALITY_PRESETS = {
  rapidaGpu: { gpu: true, label: 'Rápida (GPU)' },
  equilibrada: { codec: 'libx264', crf: 23, preset: 'medium', label: 'Equilibrada (H.264 CRF 23)' },
  ligera: { codec: 'libx264', crf: 28, preset: 'faster', label: 'Ligera (H.264 CRF 28)' },
  // Una sola pasada, CRF fijo, audio copiado tal cual (sin recodificar).
  hevcAudioIntacto: { codec: 'libx265', crf: 22, preset: 'medium', tag: 'hvc1', copyAudio: true, label: 'Alta calidad HEVC (audio intacto)' }
};

// Salidas de resolución disponibles para achicar el peso final independiente
// de la calidad elegida. "-2" en el filtro scale mantiene la relación de
// aspecto y garantiza un ancho par (lo exigen los encoders).
const RESOLUTION_HEIGHTS = {
  original: null,
  '1080p': 1080,
  '720p': 720,
  '480p': 480
};

// Se prueban en este orden porque no sabemos de antemano qué GPU tiene el
// usuario; cada intento falla casi al instante si esa marca no está presente,
// así que probarlas todas es barato. HEVC va primero porque pesa bastante
// menos que H.264 en las GPU que lo soportan bien (NVIDIA Turing/GTX 16xx en
// adelante); si falla, se prueba H.264 por GPU y por último se cae a CPU.
const GPU_ENCODERS = [
  { name: 'NVIDIA (NVENC HEVC)', args: ['-c:v', 'hevc_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '25', '-b:v', '0', '-tag:v', 'hvc1'] },
  { name: 'NVIDIA (NVENC H.264)', args: ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '25', '-b:v', '0'] },
  { name: 'Intel (Quick Sync)', args: ['-c:v', 'h264_qsv', '-global_quality', '25'] },
  { name: 'AMD (AMF)', args: ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '25', '-qp_p', '25'] }
];

let mainWindow;
let floatingWindow;
const writeStreams = new Map();

// Atajo global para iniciar/detener la grabación sin tener que hacer foco
// en la ventana (útil porque abrir la app taparía lo que se está grabando).
const RECORD_SHORTCUT = 'F9';

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
  floatingWindow.loadFile(path.join(__dirname, 'src', 'floating.html'));
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();

  const registered = globalShortcut.register(RECORD_SHORTCUT, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-recording-shortcut');
    }
  });
  if (!registered) {
    console.error(`No se pudo registrar el atajo ${RECORD_SHORTCUT} (puede estar en uso por otro programa).`);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
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

  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
    appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    isScreen: s.id.startsWith('screen:')
  }));
});

ipcMain.handle('get-record-shortcut', () => RECORD_SHORTCUT);

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

ipcMain.handle('get-source-preview', async (event, sourceId) => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 1600, height: 900 }
  });
  const source = sources.find((s) => s.id === sourceId);
  if (!source || source.thumbnail.isEmpty()) return null;
  return source.thumbnail.toDataURL();
});

ipcMain.handle('get-quality-presets', () => {
  return Object.entries(QUALITY_PRESETS).map(([id, p]) => ({ id, label: p.label }));
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

ipcMain.handle('start-write-stream', async () => {
  const id = `rec-${Date.now()}`;
  const tempPath = path.join(getTempDir(), `${id}.webm`);
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

const PENDING_FILENAME_RE = /^rec-\d+\.webm$/;

ipcMain.handle('list-pending-recordings', () => {
  const dir = getTempDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return [];
  }

  return files
    .filter((name) => PENDING_FILENAME_RE.test(name))
    .map((name) => {
      const tempPath = path.join(dir, name);
      const stat = fs.statSync(tempPath);
      return { tempPath, sizeBytes: stat.size, createdAt: stat.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
});

ipcMain.handle('discard-pending-recording', (event, tempPath) => {
  const dir = getTempDir();
  const name = path.basename(tempPath);
  if (path.join(dir, name) !== tempPath || !PENDING_FILENAME_RE.test(name)) {
    throw new Error('Ruta inválida.');
  }
  fs.unlink(tempPath, () => {});
});

function parseDurationSeconds(text) {
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function parseTimeSeconds(text) {
  const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    let totalDuration = null;
    let stderrBuffer = '';

    ff.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuffer += text;

      if (totalDuration === null) {
        const d = parseDurationSeconds(stderrBuffer);
        if (d) totalDuration = d;
      }

      const t = parseTimeSeconds(text);
      if (t !== null && totalDuration) {
        const progress = Math.min(1, t / totalDuration);
        mainWindow.webContents.send('encode-progress', { progress });
      }
    });

    ff.on('error', reject);

    ff.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg terminó con código ${code}:\n${stderrBuffer.slice(-2000)}`));
        return;
      }
      resolve();
    });
  });
}

ipcMain.handle('finish-recording', async (event, { tempPath, outputDir, baseName, qualityId, keepAudio, resolutionId }) => {
  const preset = QUALITY_PRESETS[qualityId] || QUALITY_PRESETS.equilibrada;
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${baseName}.mp4`);

  const targetHeight = RESOLUTION_HEIGHTS[resolutionId] || null;
  const scaleArgs = targetHeight ? ['-vf', `scale=-2:${targetHeight}`] : [];

  const audioArgs = keepAudio
    ? (preset.copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'])
    : ['-an'];
  const trailingArgs = ['-pix_fmt', 'yuv420p', ...audioArgs, '-movflags', '+faststart', outputPath];

  const encode = (encoderArgs) => runFfmpeg(['-y', '-i', tempPath, ...scaleArgs, ...encoderArgs, ...trailingArgs]);

  let encoderUsed;
  if (preset.gpu) {
    let succeeded = false;
    for (const encoder of GPU_ENCODERS) {
      try {
        await encode(encoder.args);
        encoderUsed = encoder.name;
        succeeded = true;
        break;
      } catch (err) {
        // Esta GPU/encoder no está disponible en esta máquina: probar la siguiente.
      }
    }
    if (!succeeded) {
      const cpuFallback = QUALITY_PRESETS.equilibrada;
      await encode(['-c:v', cpuFallback.codec, '-crf', String(cpuFallback.crf), '-preset', cpuFallback.preset]);
      encoderUsed = 'CPU (ninguna GPU compatible encontrada)';
    }
  } else {
    const encoderArgs = ['-c:v', preset.codec, '-crf', String(preset.crf), '-preset', preset.preset];
    if (preset.tag) encoderArgs.push('-tag:v', preset.tag);
    await encode(encoderArgs);
    encoderUsed = 'CPU';
  }

  const tempSize = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0;
  const finalSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

  fs.unlink(tempPath, () => {});

  return {
    outputPath,
    tempSizeBytes: tempSize,
    finalSizeBytes: finalSize,
    encoderUsed
  };
});

ipcMain.handle('show-in-folder', (event, filePath) => {
  shell.showItemInFolder(filePath);
});
