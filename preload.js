const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('playerAPI', {
    onPromptCmsUrl: (callback) => ipcRenderer.on('prompt-cms-url', (_event, url) => callback(url)),
    submitCmsUrl: (url) => ipcRenderer.send('submit-cms-url', url),
    onControlCommand: (callback) => ipcRenderer.on('control-command', (_event, value) => callback(value)),
    onShowEnrollmentCode: (callback) => ipcRenderer.on('show-enrollment-code', (_event, code) => callback(code)),
    onHideEnrollmentCode: (callback) => ipcRenderer.on('hide-enrollment-code', () => callback()),
    onUpdatePlaylist: (callback) => ipcRenderer.on('update-playlist', (_event, paths) => callback(paths)),
    onAppendPlaylist: (callback) => ipcRenderer.on('append-playlist', (_event, paths) => callback(paths)),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_event, info) => callback(info)),
    onMemoryError: (callback) => ipcRenderer.on('memory-error', (_event, msg) => callback(msg)),
    // Capture card support
    getCaptureDevices: () => ipcRenderer.invoke('get-capture-devices'),
    onStartCapture: (callback) => ipcRenderer.on('start-capture', (_event, config) => callback(config)),
    onStopCapture: (callback) => ipcRenderer.on('stop-capture', () => callback()),
    // Native live inputs (DeckLink / NDI) — frames arrive over a MessagePort
    onStartLive: (callback) => ipcRenderer.on('start-live', (_event, info) => callback(info)),
    onStopLive: (callback) => ipcRenderer.on('stop-live', () => callback()),
    onFramePort: (callback) => ipcRenderer.on('frame-port', (event) => callback(event.ports[0])),
    requestStopLive: () => ipcRenderer.send('request-stop-live'),
    // Video wall crop support
    onSetCrop: (callback) => ipcRenderer.on('set-crop', (_event, crop) => callback(crop)),
    // Volume control
    onSetVolume: (callback) => ipcRenderer.on('set-volume', (_event, state) => callback(state))
});
