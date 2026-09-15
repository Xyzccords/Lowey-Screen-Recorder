const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('abiction', {
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
  onWriteError: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('write-error', listener);
    return () => ipcRenderer.removeListener('write-error', listener);
  },

  startVideoCapture: (payload) => ipcRenderer.invoke('start-video-capture', payload),
  stopVideoCapture: (id) => ipcRenderer.invoke('stop-video-capture', id),

  startWindowAudioCapture: (payload) => ipcRenderer.invoke('start-window-audio-capture', payload),
  stopWindowAudioCapture: (id) => ipcRenderer.invoke('stop-window-audio-capture', id),

  startWriteStream: (payload) => ipcRenderer.invoke('start-write-stream', payload),
  writeChunk: (id, arrayBuffer) => ipcRenderer.send('write-chunk', id, arrayBuffer),
  endWriteStream: (id) => ipcRenderer.invoke('end-write-stream', id),

  finishRecording: (payload) => ipcRenderer.invoke('finish-recording', payload),
  listPendingRecordings: () => ipcRenderer.invoke('list-pending-recordings'),
  discardPendingRecording: (id) => ipcRenderer.invoke('discard-pending-recording', id),
  onEncodeProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('encode-progress', listener);
    return () => ipcRenderer.removeListener('encode-progress', listener);
  },

  chooseVideoToUpload: () => ipcRenderer.invoke('choose-video-to-upload'),
  compressUploadedVideo: (payload) => ipcRenderer.invoke('compress-uploaded-video', payload),

  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),

  notifyRecordingStarted: (startedAt) => ipcRenderer.send('recording-started', startedAt),
  notifyRecordingStopped: () => ipcRenderer.send('recording-stopped'),
  onFloatingStart: (callback) => {
    const listener = (event, startedAt) => callback(startedAt);
    ipcRenderer.on('floating-start', listener);
    return () => ipcRenderer.removeListener('floating-start', listener);
  }
});
