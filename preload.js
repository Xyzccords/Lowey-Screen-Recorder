const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lowey', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getRecordShortcut: () => ipcRenderer.invoke('get-record-shortcut'),
  onToggleRecordingShortcut: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('toggle-recording-shortcut', listener);
    return () => ipcRenderer.removeListener('toggle-recording-shortcut', listener);
  },
  getDefaultOutputDir: () => ipcRenderer.invoke('get-default-output-dir'),
  getTempDir: () => ipcRenderer.invoke('get-temp-dir'),
  onVideoCaptureError: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('video-capture-error', listener);
    return () => ipcRenderer.removeListener('video-capture-error', listener);
  },

  startVideoCapture: (payload) => ipcRenderer.invoke('start-video-capture', payload),
  stopVideoCapture: (id) => ipcRenderer.invoke('stop-video-capture', id),

  finishRecording: (payload) => ipcRenderer.invoke('finish-recording', payload),
  listPendingRecordings: () => ipcRenderer.invoke('list-pending-recordings'),
  discardPendingRecording: (id) => ipcRenderer.invoke('discard-pending-recording', id),
  onEncodeProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('encode-progress', listener);
    return () => ipcRenderer.removeListener('encode-progress', listener);
  },

  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),

  notifyRecordingStarted: (startedAt) => ipcRenderer.send('recording-started', startedAt),
  notifyRecordingStopped: () => ipcRenderer.send('recording-stopped'),
  onFloatingStart: (callback) => {
    const listener = (event, startedAt) => callback(startedAt);
    ipcRenderer.on('floating-start', listener);
    return () => ipcRenderer.removeListener('floating-start', listener);
  }
});
