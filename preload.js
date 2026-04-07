const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('playerAPI', {
    onPromptCmsUrl: (callback) => ipcRenderer.on('prompt-cms-url', (_event, url) => callback(url)),
    submitCmsUrl: (url) => ipcRenderer.send('submit-cms-url', url),
    onControlCommand: (callback) => ipcRenderer.on('control-command', (_event, value) => callback(value)),
    onShowEnrollmentCode: (callback) => ipcRenderer.on('show-enrollment-code', (_event, code) => callback(code)),
    onHideEnrollmentCode: (callback) => ipcRenderer.on('hide-enrollment-code', () => callback()),
    onUpdatePlaylist: (callback) => ipcRenderer.on('update-playlist', (_event, paths, durations) => callback(paths, durations)),
    onAppendPlaylist: (callback) => ipcRenderer.on('append-playlist', (_event, paths, durations) => callback(paths, durations)),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_event, info) => callback(info)),
    onMemoryError: (callback) => ipcRenderer.on('memory-error', (_event, msg) => callback(msg)),
    // Capture card support
    getCaptureDevices: () => ipcRenderer.invoke('get-capture-devices'),
    onStartCapture: (callback) => ipcRenderer.on('start-capture', (_event, config) => callback(config)),
    onStopCapture: (callback) => ipcRenderer.on('stop-capture', () => callback()),
    // NDI support
    onNdiFrame:    (callback) => ipcRenderer.on('ndi-frame',     (_event, frame) => callback(frame)),
    onNdiNoSignal: (callback) => ipcRenderer.on('ndi-no-signal', (_event, data)  => callback(data)),
    onStopNdi:     (callback) => ipcRenderer.on('stop-ndi',      (_event, data)  => callback(data)),
    // Video wall crop support
    onSetCrop: (callback) => ipcRenderer.on('set-crop', (_event, crop) => callback(crop)),
    // NDI send (capture → NDI broadcast)
    sendNdiFrame: (frameData) => ipcRenderer.send('ndi-send-frame', frameData),
    onNdiSendStarted: (callback) => ipcRenderer.on('ndi-send-started', (_event, data) => callback(data)),
    onNdiSendStopped: (callback) => ipcRenderer.on('ndi-send-stopped', () => callback()),
    // Playback status (for WebSocket broadcast to control systems)
    sendPlaybackStatus: (data) => ipcRenderer.send('playback-status', data),
});
