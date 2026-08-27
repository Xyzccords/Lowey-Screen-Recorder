const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, shell } = require('electron');
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

// Presets de recompresión: usan CRF (calidad constante) en vez de bitrate fijo,
// que es lo que permite lograr "misma calidad, menos peso" frente a grabadores
// que graban directo a un bitrate alto durante toda la sesión.
const QUALITY_PRESETS = {
  maxima: { codec: 'libx265', crf: 18, preset: 'medium', tag: 'hvc1', label: 'Máxima calidad (H.265 CRF 18)' },
  alta: { codec: 'libx265', crf: 22, preset: 'medium', tag: 'hvc1', label: 'Alta calidad (H.265 CRF 22)' },
  equilibrada: { codec: 'libx264', crf: 23, preset: 'medium', label: 'Equilibrada (H.264 CRF 23)' },
  ligera: { codec: 'libx264', crf: 28, preset: 'faster', label: 'Ligera (H.264 CRF 28)' }
};

let mainWindow;
const writeStreams = new Map();

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
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(createWindow);

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

ipcMain.handle('start-write-stream', async () => {
  const id = `rec-${Date.now()}`;
  const tempPath = path.join(os.tmpdir(), `${id}.webm`);
  const stream = fs.createWriteStream(tempPath);
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

ipcMain.handle('finish-recording', async (event, { tempPath, outputDir, baseName, qualityId, keepAudio }) => {
  const preset = QUALITY_PRESETS[qualityId] || QUALITY_PRESETS.alta;
  fs.mkdirSync(outputDir, { recursive: true });

  const ext = preset.codec === 'libx265' ? 'mp4' : 'mp4';
  const outputPath = path.join(outputDir, `${baseName}.${ext}`);

  const args = ['-y', '-i', tempPath];
  args.push('-c:v', preset.codec, '-crf', String(preset.crf), '-preset', preset.preset, '-pix_fmt', 'yuv420p');
  if (preset.tag) args.push('-tag:v', preset.tag);

  if (keepAudio) {
    args.push('-c:a', 'aac', '-b:a', '160k');
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', outputPath);

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

      const tempSize = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0;
      const finalSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

      fs.unlink(tempPath, () => {});

      resolve({
        outputPath,
        tempSizeBytes: tempSize,
        finalSizeBytes: finalSize
      });
    });
  });
});

ipcMain.handle('show-in-folder', (event, filePath) => {
  shell.showItemInFolder(filePath);
});
