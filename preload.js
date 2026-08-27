const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lowey', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getQualityPresets: () => ipcRenderer.invoke('get-quality-presets'),
  getRecordShortcut: () => ipcRenderer.invoke('get-record-shortcut'),
  onToggleRecordingShortcut: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('toggle-recording-shortcut', listener);
    return () => ipcRenderer.removeListener('toggle-recording-shortcut', listener);
  },
  chooseSaveFolder: () => ipcRenderer.invoke('choose-save-folder'),
  getDefaultOutputDir: () => ipcRenderer.invoke('get-default-output-dir'),

  startWriteStream: () => ipcRenderer.invoke('start-write-stream'),
  writeChunk: (id, arrayBuffer) => ipcRenderer.send('write-chunk', id, arrayBuffer),
  endWriteStream: (id) => ipcRenderer.invoke('end-write-stream', id),

  finishRecording: (payload) => ipcRenderer.invoke('finish-recording', payload),
  onEncodeProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('encode-progress', listener);
    return () => ipcRenderer.removeListener('encode-progress', listener);
  },

  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath)
});
