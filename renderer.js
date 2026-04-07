const playerA = document.getElementById('playerA');
const playerB = document.getElementById('playerB');
const imagePlayer = document.getElementById('imagePlayer');
const capturePlayer = document.getElementById('capturePlayer');
const debugInfo = document.getElementById('debug-info');

let activePlayer = playerA;
let hiddenPlayer = playerB;
let currentVideoIndex = 0;
let captureStream = null;
let captureActive = false;
let imageTimer = null;  // timer handle when showing a static image
let currentCrop = null; // video wall crop region { x, y, w, h } normalised 0.0–1.0

// Default duration for images when no duration is specified (ms)
const IMAGE_DEFAULT_DURATION_MS = 10000;

// --- Template iframe player ---
const templatePlayer = document.getElementById('templatePlayer');
let templateTimer = null;

function isTemplatePath(p) { return typeof p === 'string' && p.startsWith('template::'); }

function showTemplate(url) {
    playerA.pause(); playerB.pause();
    playerA.style.display = 'none'; playerB.style.display = 'none';
    if (cropCanvas) cropCanvas.style.display = 'none';
    stopCropVideoLoop();
    imagePlayer.style.display = 'none';
    templatePlayer.src = url;
    templatePlayer.style.display = 'block';
}

function hideTemplate() {
    if (templateTimer) { clearTimeout(templateTimer); templateTimer = null; }
    templatePlayer.style.display = 'none';
    templatePlayer.src = '';
    playerA.style.display = '';
    playerB.style.display = '';
}

// --- Playback status broadcaster (feeds WebSocket via IPC) ---
let _statusInterval = null;
let _currentFilename = '';
let _contentStartTime = 0;

function startStatusBroadcast(filename, duration) {
    _currentFilename = filename;
    _contentStartTime = Date.now();
    if (_statusInterval) clearInterval(_statusInterval);
    _statusInterval = setInterval(() => {
        if (!window.playerAPI || !window.playerAPI.sendPlaybackStatus) return;
        const elapsed = (Date.now() - _contentStartTime) / 1000;
        // For video get actual currentTime; fallback to elapsed for images/templates
        let position = elapsed;
        let videoDuration = duration || 0;
        try {
            if (!activePlayer.paused && activePlayer.readyState >= 2) {
                position = activePlayer.currentTime;
                if (activePlayer.duration && !isNaN(activePlayer.duration)) {
                    videoDuration = activePlayer.duration;
                }
            }
        } catch (e) {}
        window.playerAPI.sendPlaybackStatus({
            type: 'playback',
            filename: _currentFilename,
            position: Math.round(position * 10) / 10,
            duration: Math.round(videoDuration * 10) / 10,
            playlist_index: currentVideoIndex,
            playlist_length: playlist.length,
            timestamp: Date.now(),
        });
    }, 500);
}

// --- Video wall crop canvas ---
const cropCanvas = document.getElementById('cropCanvas');
const cropCtx = cropCanvas ? cropCanvas.getContext('2d') : null;
let cropVideoRAF = null; // requestAnimationFrame handle for video crop loop

function isImagePath(path) {
    return /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(path);
}

function showImage(path) {
    // Stop video players
    playerA.pause();
    playerB.pause();
    playerA.style.display = 'none';
    playerB.style.display = 'none';
    stopCropVideoLoop();

    if (currentCrop && cropCanvas && cropCtx) {
        // Crop mode: draw only the crop region onto the canvas
        imagePlayer.style.display = 'none';
        const img = new Image();
        img.onload = () => {
            cropCanvas.width = window.innerWidth;
            cropCanvas.height = window.innerHeight;
            const sx = Math.round(currentCrop.x * img.naturalWidth);
            const sy = Math.round(currentCrop.y * img.naturalHeight);
            const sw = Math.round(currentCrop.w * img.naturalWidth);
            const sh = Math.round(currentCrop.h * img.naturalHeight);
            cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
            cropCtx.drawImage(img, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
            cropCanvas.style.display = 'block';
        };
        img.src = path;
    } else {
        // Normal mode: show image element directly
        if (cropCanvas) cropCanvas.style.display = 'none';
        imagePlayer.src = path;
        imagePlayer.style.display = 'block';
    }
}

function hideImage() {
    if (imageTimer) { clearTimeout(imageTimer); imageTimer = null; }
    imagePlayer.style.display = 'none';
    imagePlayer.src = '';
    if (cropCanvas) cropCanvas.style.display = 'none';
    stopCropVideoLoop();
    playerA.style.display = '';
    playerB.style.display = '';
}

// NDI state
const ndiCanvas = document.getElementById('ndiCanvas');
const ndiCtx = ndiCanvas ? ndiCanvas.getContext('2d') : null;
const noSignalOverlay = document.getElementById('noSignalOverlay');
const noSignalSource = document.getElementById('noSignalSource');
let ndiActive = false;
let ndiNoSignalTimer = null;
const NDI_NO_SIGNAL_DELAY_MS = 20000; // Hold last frame for 20s before showing "No Signal"

// Empty playlist. Player will wait for CMS push.
const playlist = [];
const durations = [];  // parallel array: durations[i] matches playlist[i]

function updateDebug(msg) {
    const videoName = playlist[currentVideoIndex] ? playlist[currentVideoIndex].split('/').pop() : 'None';
    debugInfo.innerText = `Status: ${msg}\nPlaying Index: ${currentVideoIndex}\nVideo: ${videoName}`;
}

function initializePlayer() {
    if (playlist.length === 0) return;

    const currentPath = playlist[0];
    const currentDur = durations[0] || 0;

    if (isTemplatePath(currentPath)) {
        hideImage(); hideTemplate();
        const url = currentPath.replace('template::', '');
        showTemplate(url);
        updateDebug('Template...');
        const dur = currentDur > 0 ? currentDur * 1000 : IMAGE_DEFAULT_DURATION_MS;
        templateTimer = setTimeout(() => handleVideoEnd(), dur);
        startStatusBroadcast(url.split('/').pop() || 'Template', currentDur || IMAGE_DEFAULT_DURATION_MS / 1000);
    } else if (isImagePath(currentPath)) {
        // Show image, advance after duration
        hideImage(); hideTemplate();
        showImage(currentPath);
        updateDebug('Showing image...');
        const dur = currentDur > 0 ? currentDur * 1000 : IMAGE_DEFAULT_DURATION_MS;
        imageTimer = setTimeout(() => handleVideoEnd(), dur);
        startStatusBroadcast(currentPath.split('/').pop() || 'Image', currentDur || IMAGE_DEFAULT_DURATION_MS / 1000);
    } else {
        // Video: hide image player, show video players
        hideImage(); hideTemplate();
        activePlayer.src = currentPath;
        activePlayer.play().catch(e => console.error(e));
        if (currentCrop) startCropVideoLoop(activePlayer);
        updateDebug('Playing...');
        startStatusBroadcast(currentPath.split('/').pop() || 'Video', currentDur);

        // Preload second item if it's a video
        const nextPath = playlist.length > 1 ? playlist[1] : playlist[0];
        if (!isImagePath(nextPath) && !isTemplatePath(nextPath)) {
            hiddenPlayer.src = nextPath;
            hiddenPlayer.load();
        }
    }
}

function handleVideoEnd() {
    updateDebug('Switching...');

    if (playlist.length <= 1) {
        // Single item — loop it
        currentVideoIndex = 0;
        if (isTemplatePath(playlist[0])) {
            // Template: don't reload the iframe, just reset the advance timer
            // to avoid a blank flash while the iframe tears down and reloads
            const dur = (durations[0] || 0) > 0 ? durations[0] * 1000 : IMAGE_DEFAULT_DURATION_MS;
            if (templateTimer) clearTimeout(templateTimer);
            templateTimer = setTimeout(() => handleVideoEnd(), dur);
        } else {
            initializePlayer();
        }
        return;
    }

    const nextVideoIndex = (currentVideoIndex + 1) % playlist.length;
    currentVideoIndex = nextVideoIndex;
    const nextPath = playlist[nextVideoIndex];
    const nextDur = durations[nextVideoIndex] || 0;

    if (isTemplatePath(nextPath)) {
        activePlayer.classList.remove('active');
        activePlayer.classList.add('hidden');
        hideImage(); hideTemplate();
        const url = nextPath.replace('template::', '');
        showTemplate(url);
        updateDebug('Template...');
        const dur = nextDur > 0 ? nextDur * 1000 : IMAGE_DEFAULT_DURATION_MS;
        templateTimer = setTimeout(() => handleVideoEnd(), dur);
        startStatusBroadcast(url.split('/').pop() || 'Template', nextDur || IMAGE_DEFAULT_DURATION_MS / 1000);
        return;
    }

    if (isImagePath(nextPath)) {
        // Next item is an image — hide video players, show image
        activePlayer.classList.remove('active');
        activePlayer.classList.add('hidden');
        hideImage(); hideTemplate();
        showImage(nextPath);
        updateDebug('Showing image...');
        const dur = nextDur > 0 ? nextDur * 1000 : IMAGE_DEFAULT_DURATION_MS;
        imageTimer = setTimeout(() => handleVideoEnd(), dur);
        startStatusBroadcast(nextPath.split('/').pop() || 'Image', nextDur || IMAGE_DEFAULT_DURATION_MS / 1000);
        return;
    }

    // Next item is a video
    hideImage(); hideTemplate();
    const preloadVideoIndex = (nextVideoIndex + 1) % playlist.length;

    // Swap active/hidden CSS classes
    activePlayer.classList.remove('active');
    activePlayer.classList.add('hidden');

    hiddenPlayer.classList.remove('hidden');
    hiddenPlayer.classList.add('active');

    hiddenPlayer.play().catch(e => console.error(e));

    const temp = activePlayer;
    activePlayer = hiddenPlayer;
    hiddenPlayer = temp;

    if (currentCrop) startCropVideoLoop(activePlayer);

    // Preload next item if it's a video
    const preloadPath = playlist[preloadVideoIndex];
    if (!isImagePath(preloadPath) && !isTemplatePath(preloadPath)) {
        hiddenPlayer.src = preloadPath;
        hiddenPlayer.load();
    }

    startStatusBroadcast(nextPath.split('/').pop() || 'Video', nextDur);
    updateDebug('Playing...');
}

// Listen to the end event on both players
playerA.addEventListener('ended', handleVideoEnd);
playerB.addEventListener('ended', handleVideoEnd);

function playPreviousVideo() {
    updateDebug('Switching to previous video...');
    if (playlist.length <= 1) {
        activePlayer.currentTime = 0;
        activePlayer.play().catch(e => console.error(e));
        return;
    }

    let prevVideoIndex = currentVideoIndex - 1;
    if (prevVideoIndex < 0) prevVideoIndex = playlist.length - 1;

    activePlayer.classList.remove('active');
    activePlayer.classList.add('hidden');

    hiddenPlayer.classList.remove('hidden');
    hiddenPlayer.classList.add('active');

    // Load instantly (cannot preload gracefully going backwards)
    hiddenPlayer.src = playlist[prevVideoIndex];
    hiddenPlayer.load();
    hiddenPlayer.play().catch(e => console.error(e));

    const temp = activePlayer;
    activePlayer = hiddenPlayer;
    hiddenPlayer = temp;

    currentVideoIndex = prevVideoIndex;
    updateDebug('Playing...');
}

// --- Capture Card Functions ---

function showCapturePlayer() {
    // Hide A/B players, show capture player
    playerA.style.display = 'none';
    playerA.pause();
    playerB.style.display = 'none';
    playerB.pause();
    capturePlayer.style.display = 'block';
}

function hideCapturePlayer() {
    capturePlayer.style.display = 'none';
    // Restore playlist players
    playerA.style.display = '';
    playerB.style.display = '';
    // Restore whichever was the active player
    activePlayer.classList.remove('hidden');
    activePlayer.classList.add('active');
    if (playlist.length > 0) {
        activePlayer.play().catch(e => console.error(e));
    }
}

async function startCapture(config) {
    console.log('[CAPTURE] Starting capture with config:', config);
    try {
        // Stop any existing capture first
        stopCapture();

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');

        let selectedDevice = videoDevices[0]; // default to first
        if (config.deviceId) {
            selectedDevice = videoDevices.find(d => d.deviceId === config.deviceId) || selectedDevice;
        } else if (config.deviceLabel) {
            selectedDevice = videoDevices.find(d => d.label.toLowerCase().includes(config.deviceLabel.toLowerCase())) || selectedDevice;
        }

        if (!selectedDevice) {
            console.error('[CAPTURE] No capture device found');
            updateDebug('Capture error: No capture device found');
            return;
        }

        const constraints = {
            video: {
                deviceId: { exact: selectedDevice.deviceId },
                width: { ideal: config.width || 1920 },
                height: { ideal: config.height || 1080 }
            },
            audio: false
        };

        captureStream = await navigator.mediaDevices.getUserMedia(constraints);
        capturePlayer.srcObject = captureStream;
        captureActive = true;
        showCapturePlayer();
        updateDebug('Capture card active: ' + selectedDevice.label);
        console.log('[CAPTURE] Capture started successfully on device:', selectedDevice.label);
    } catch (err) {
        console.error('[CAPTURE] Failed to start capture:', err.message);
        captureActive = false;
        updateDebug('Capture error: ' + err.message);
        // Show error to user
        const errorOverlay = document.getElementById('error-overlay');
        const errorText = document.getElementById('error-text');
        if (errorOverlay && errorText) {
            let errorMsg = 'Capture card error: ';
            if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                errorMsg += 'Device not found. Check the capture card is connected.';
            } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
                errorMsg += 'Device is busy or unavailable. It may be in use by another application.';
            } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                errorMsg += 'Permission denied. Camera/capture access was blocked.';
            } else {
                errorMsg += err.message;
            }
            errorText.innerText = errorMsg;
            errorOverlay.classList.add('show');
        }
    }
}

function stopCapture() {
    if (captureStream) {
        captureStream.getTracks().forEach(track => track.stop());
        captureStream = null;
    }
    capturePlayer.srcObject = null;
    if (captureActive) {
        captureActive = false;
        hideCapturePlayer();
        updateDebug('Capture stopped, resuming playlist');
        console.log('[CAPTURE] Capture stopped');
    }
}

// --- NDI Send (Capture → NDI broadcast) ---
let ndiSendActive = false;
let ndiSendRAF = null;
const ndiSendCanvas = document.createElement('canvas');
const ndiSendCtx = ndiSendCanvas.getContext('2d');
const NDI_SEND_FPS = 30;
let ndiSendLastFrameTime = 0;

function ndiSendFrameLoop(timestamp) {
    if (!ndiSendActive || !captureActive || !capturePlayer.srcObject) {
        ndiSendRAF = null;
        return;
    }
    const elapsed = timestamp - ndiSendLastFrameTime;
    if (elapsed >= 1000 / NDI_SEND_FPS) {
        ndiSendLastFrameTime = timestamp;
        const vw = capturePlayer.videoWidth;
        const vh = capturePlayer.videoHeight;
        if (vw > 0 && vh > 0) {
            if (ndiSendCanvas.width !== vw || ndiSendCanvas.height !== vh) {
                ndiSendCanvas.width = vw;
                ndiSendCanvas.height = vh;
            }
            ndiSendCtx.drawImage(capturePlayer, 0, 0, vw, vh);
            const imageData = ndiSendCtx.getImageData(0, 0, vw, vh);
            const rgba = imageData.data;
            // RGBA → BGRA swap
            for (let i = 0; i < rgba.length; i += 4) {
                const r = rgba[i];
                rgba[i] = rgba[i + 2];     // B
                rgba[i + 2] = r;           // R
            }
            if (window.playerAPI && window.playerAPI.sendNdiFrame) {
                window.playerAPI.sendNdiFrame({
                    data: rgba.buffer,
                    width: vw,
                    height: vh,
                });
            }
        }
    }
    ndiSendRAF = requestAnimationFrame(ndiSendFrameLoop);
}

if (window.playerAPI) {
    window.playerAPI.onNdiSendStarted(({ sourceName }) => {
        console.log('[NDI SEND] Started broadcasting as:', sourceName);
        ndiSendActive = true;
        if (!ndiSendRAF) ndiSendRAF = requestAnimationFrame(ndiSendFrameLoop);
    });
    window.playerAPI.onNdiSendStopped(() => {
        console.log('[NDI SEND] Stopped broadcasting');
        ndiSendActive = false;
        if (ndiSendRAF) { cancelAnimationFrame(ndiSendRAF); ndiSendRAF = null; }
    });
}

// --- NDI Canvas Functions ---

function showNdiCanvas() {
  ndiCanvas.style.display = 'block';
  noSignalOverlay.style.display = 'none';
  // Hide playlist players
  playerA.style.display = 'none'; playerA.pause();
  playerB.style.display = 'none'; playerB.pause();
  capturePlayer.style.display = 'none';
  ndiActive = true;
  if (_statusInterval) { clearInterval(_statusInterval); _statusInterval = null; }
  updateDebug('NDI Live');
}

function hideNdiCanvas() {
  ndiCanvas.style.display = 'none';
  noSignalOverlay.style.display = 'none';
  ndiActive = false;
  if (ndiNoSignalTimer) { clearTimeout(ndiNoSignalTimer); ndiNoSignalTimer = null; }
  // Restore playlist players
  playerA.style.display = '';
  playerB.style.display = '';
  activePlayer.classList.remove('hidden');
  activePlayer.classList.add('active');
  if (playlist.length > 0) {
    activePlayer.play().catch(e => console.error(e));
  }
  updateDebug('NDI stopped — resuming playlist');
}

function showNoSignal(sourceName) {
  playerA.style.display = 'none'; playerA.pause();
  playerB.style.display = 'none'; playerB.pause();
  capturePlayer.style.display = 'none';
  ndiCanvas.style.display = 'none';
  noSignalOverlay.style.display = 'flex';
  if (noSignalSource) noSignalSource.textContent = sourceName || '';
  updateDebug('NDI: No Signal — ' + (sourceName || ''));
}

// --- Video wall crop: video loop ---
function startCropVideoLoop(videoEl) {
    stopCropVideoLoop();
    if (!cropCanvas || !cropCtx || !currentCrop) return;
    cropCanvas.width = window.innerWidth;
    cropCanvas.height = window.innerHeight;
    cropCanvas.style.display = 'block';
    videoEl.style.display = 'none';

    function drawFrame() {
        if (!currentCrop || videoEl.paused || videoEl.ended) {
            cropCanvas.style.display = 'none';
            videoEl.style.display = '';
            return;
        }
        const sx = Math.round(currentCrop.x * videoEl.videoWidth);
        const sy = Math.round(currentCrop.y * videoEl.videoHeight);
        const sw = Math.round(currentCrop.w * videoEl.videoWidth);
        const sh = Math.round(currentCrop.h * videoEl.videoHeight);
        if (sw > 0 && sh > 0) {
            cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
            cropCtx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
        }
        cropVideoRAF = requestAnimationFrame(drawFrame);
    }
    cropVideoRAF = requestAnimationFrame(drawFrame);
}

function stopCropVideoLoop() {
    if (cropVideoRAF) { cancelAnimationFrame(cropVideoRAF); cropVideoRAF = null; }
}

// Start playback
initializePlayer();

// --- API Command Listener ---
// This listens to commands sent from the Main Process (which received an HTTP hit from the 3rd party controller)
if (window.playerAPI) {
    window.playerAPI.onControlCommand((command) => {
        updateDebug(`Last API Command: ${command.toUpperCase()}`);
        console.log(`Received command: ${command}`);

        if (command === 'play') {
            activePlayer.play().catch(e => console.error(e));
        } else if (command === 'pause') {
            activePlayer.pause();
        } else if (command === 'restart') {
            activePlayer.currentTime = 0;
            activePlayer.play().catch(e => console.error(e));
        } else if (command === 'next') {
            handleVideoEnd();
        } else if (command === 'previous') {
            playPreviousVideo();
        }
    });

    // --- SETUP LISTENERS ---
    const setupOverlay = document.getElementById('setup-overlay');
    const cmsUrlInput = document.getElementById('cms-url-input');
    const connectBtn = document.getElementById('connect-btn');

    window.playerAPI.onPromptCmsUrl((defaultUrl) => {
        if (defaultUrl) cmsUrlInput.value = defaultUrl;
        setupOverlay.classList.add('show');
        updateDebug('WAITING FOR CMS URL');
    });

    connectBtn.addEventListener('click', () => {
        let urlStr = cmsUrlInput.value.trim();
        if (urlStr) {
            // Auto-format URL
            if (!/^https?:\/\//i.test(urlStr)) urlStr = 'http://' + urlStr;

            try {
                // Extract just the origin (e.g. http://ip:8080) to strip any /player UI paths
                const parsedUrl = new URL(urlStr);
                urlStr = parsedUrl.origin;
            } catch (e) {
                console.error("Invalid URL format:", e);
                urlStr = urlStr.replace(/\/+$/, '');
            }

            setupOverlay.classList.remove('show');
            window.playerAPI.submitCmsUrl(urlStr);
        }
    });

    // --- CMS REGISTRATION LISTENERS ---
    const registrationOverlay = document.getElementById('registration-overlay');
    const enrollmentCodeText = document.getElementById('enrollment-code');

    window.playerAPI.onShowEnrollmentCode((code) => {
        console.log("Showing enrollment code:", code);
        enrollmentCodeText.innerText = code;
        registrationOverlay.classList.add('show');
        updateDebug('WAITING FOR CMS REGISTRATION');
    });

    window.playerAPI.onHideEnrollmentCode(() => {
        console.log("Registration complete. Hiding overlays.");
        registrationOverlay.classList.remove('show');
        setupOverlay.classList.remove('show'); // Ensure setup page is also hidden
        updateDebug('Registration Approved. Waiting for playlist...');
    });

    window.playerAPI.onUpdatePlaylist((newPlaylistPaths, newDurations) => {
        console.log("Received new local playlist.");
        if (!newPlaylistPaths || newPlaylistPaths.length === 0) return;

        // If NDI is active, stop it so playlist takes over
        if (ndiActive) hideNdiCanvas();

        // If capture is active, stop it first so playlist takes over
        if (captureActive) stopCapture();

        // Stop image/template timers
        hideImage();
        hideTemplate();

        // Stop current video playback
        activePlayer.pause();
        hiddenPlayer.pause();

        // Clear sources to ensure no bleeding
        activePlayer.removeAttribute('src');
        hiddenPlayer.removeAttribute('src');
        activePlayer.load();
        hiddenPlayer.load();

        // Update our playlist array with the local file paths from main.js
        playlist.length = 0;
        playlist.push(...newPlaylistPaths);
        durations.length = 0;
        durations.push(...(newDurations || []));

        currentVideoIndex = 0;
        initializePlayer();
    });

    window.playerAPI.onAppendPlaylist((newPlaylistPaths, newDurations) => {
        console.log("Background downloads complete. Appending local playlist.");
        if (!newPlaylistPaths || newPlaylistPaths.length === 0) return;

        // Quietly replace the background playlist array
        // without interrupting the currently playing active video!
        playlist.length = 0;
        playlist.push(...newPlaylistPaths);
        durations.length = 0;
        durations.push(...(newDurations || []));

        // Ensure hidden player has the next video preloaded correctly
        if (playlist.length > 1) {
             let preloadVideoIndex = (currentVideoIndex + 1) % playlist.length;
             hiddenPlayer.src = playlist[preloadVideoIndex];
             hiddenPlayer.load();
        }
    });

    const downloadOverlay = document.getElementById('download-overlay');
    const downloadText = document.getElementById('download-text');

    window.playerAPI.onDownloadProgress((info) => {
        if (info.show) {
            downloadOverlay.classList.add('show');
            if (info.text) downloadText.innerText = info.text;
        } else {
            downloadOverlay.classList.remove('show');
        }
    });

    const errorOverlay = document.getElementById('error-overlay');
    const errorText = document.getElementById('error-text');
    const closeErrorBtn = document.getElementById('close-error-btn');

    closeErrorBtn.addEventListener('click', () => {
        errorOverlay.classList.remove('show');
    });

    window.playerAPI.onMemoryError((msg) => {
        errorText.innerText = msg;
        errorOverlay.classList.add('show');
    });

    // --- Capture Card Listeners ---
    window.playerAPI.onStartCapture((config) => {
        startCapture(config);
    });

    window.playerAPI.onStopCapture(() => {
        stopCapture();
    });

    // --- NDI Listeners ---
    // --- NDI Canvas Self-Test (press T to draw test pattern) ---
    document.addEventListener('keydown', (e) => {
        if (e.key === 't' || e.key === 'T') {
            console.log('[NDI TEST] Drawing canvas test pattern...');
            showNdiCanvas();
            const w = 1280, h = 720;
            ndiCanvas.width = w;
            ndiCanvas.height = h;
            // Draw colour bars
            const barW = Math.floor(w / 7);
            const colours = ['#fff','#ff0','#0ff','#0f0','#f0f','#f00','#00f'];
            colours.forEach((c, i) => {
                ndiCtx.fillStyle = c;
                ndiCtx.fillRect(i * barW, 0, barW, h);
            });
            ndiCtx.fillStyle = 'white';
            ndiCtx.font = '48px monospace';
            ndiCtx.fillText('NDI CANVAS OK — waiting for stream...', 60, h / 2);
            console.log('[NDI TEST] Test pattern drawn — if you see colour bars, canvas is working');
        }
    });

    // Offscreen canvas for NDI crop (created on demand)
    let ndiOffscreen = null;
    let ndiOffCtx = null;

    window.playerAPI.onNdiFrame(({ data, width, height, sourceName }) => {
        if (!ndiActive) {
            console.log(`[NDI RENDERER] First frame received — ${width}x${height}${currentCrop ? ' (cropped)' : ''} — showing canvas`);
            showNdiCanvas();
        }
        if (!ndiCtx) { console.error('[NDI RENDERER] ndiCtx is null!'); return; }

        // Frame arrived — cancel any pending no-signal timer
        if (ndiNoSignalTimer) {
            clearTimeout(ndiNoSignalTimer);
            ndiNoSignalTimer = null;
        }
        // Hide no-signal if it was showing
        if (noSignalOverlay.style.display !== 'none') {
            noSignalOverlay.style.display = 'none';
            ndiCanvas.style.display = 'block';
        }

        try {
            // BGRA → RGBA conversion
            const src = new Uint8ClampedArray(data instanceof ArrayBuffer ? data : data.buffer || data);
            const expectedLen = width * height * 4;
            if (src.length !== expectedLen) {
                console.error(`[NDI RENDERER] Buffer size mismatch — expected ${expectedLen}, got ${src.length}`);
                return;
            }

            if (currentCrop) {
                // --- Cropped NDI mode: draw full frame to offscreen, then crop to visible canvas ---
                if (!ndiOffscreen || ndiOffscreen.width !== width || ndiOffscreen.height !== height) {
                    ndiOffscreen = document.createElement('canvas');
                    ndiOffscreen.width = width;
                    ndiOffscreen.height = height;
                    ndiOffCtx = ndiOffscreen.getContext('2d');
                }
                const imageData = ndiOffCtx.createImageData(width, height);
                const dst = imageData.data;
                for (let i = 0; i < src.length; i += 4) {
                    dst[i]     = src[i + 2]; // R ← B
                    dst[i + 1] = src[i + 1]; // G
                    dst[i + 2] = src[i];     // B ← R
                    dst[i + 3] = 255;
                }
                ndiOffCtx.putImageData(imageData, 0, 0);

                // Crop region in source pixels
                const sx = Math.round(currentCrop.x * width);
                const sy = Math.round(currentCrop.y * height);
                const sw = Math.round(currentCrop.w * width);
                const sh = Math.round(currentCrop.h * height);

                // Size visible canvas to fill screen
                ndiCanvas.width = window.innerWidth;
                ndiCanvas.height = window.innerHeight;
                ndiCtx.drawImage(ndiOffscreen, sx, sy, sw, sh, 0, 0, ndiCanvas.width, ndiCanvas.height);
            } else {
                // --- Full-frame NDI mode (no crop) ---
                if (ndiCanvas.width !== width || ndiCanvas.height !== height) {
                    ndiCanvas.width = width;
                    ndiCanvas.height = height;
                }
                const imageData = ndiCtx.createImageData(width, height);
                const dst = imageData.data;
                for (let i = 0; i < src.length; i += 4) {
                    dst[i]     = src[i + 2]; // R ← B
                    dst[i + 1] = src[i + 1]; // G
                    dst[i + 2] = src[i];     // B ← R
                    dst[i + 3] = 255;
                }
                ndiCtx.putImageData(imageData, 0, 0);
            }
        } catch (e) {
            console.error('[NDI] Frame draw error:', e);
        }
    });

    window.playerAPI.onNdiNoSignal(({ sourceName }) => {
        // Debounce: hold last frame for 20 seconds before showing "No Signal"
        // Brief frame drops are normal with NDI — don't flash the overlay
        if (!ndiNoSignalTimer) {
            console.log(`[NDI] Signal drop detected — holding last frame for ${NDI_NO_SIGNAL_DELAY_MS / 1000}s before showing No Signal`);
            ndiNoSignalTimer = setTimeout(() => {
                ndiNoSignalTimer = null;
                showNoSignal(sourceName);
            }, NDI_NO_SIGNAL_DELAY_MS);
        }
    });

    window.playerAPI.onStopNdi(() => {
        hideNdiCanvas();
    });

    // --- Video wall crop listener ---
    window.playerAPI.onSetCrop((crop) => {
        currentCrop = crop;
        console.log('[CROP]', crop ? `Set: x=${crop.x} y=${crop.y} w=${crop.w} h=${crop.h}` : 'Cleared');
        if (!crop) {
            if (cropCanvas) cropCanvas.style.display = 'none';
            stopCropVideoLoop();
            // Restore normal display for current content
            if (imagePlayer.src && imagePlayer.src !== '') {
                imagePlayer.style.display = 'block';
            }
        } else {
            // If currently showing an image, re-render it cropped
            if (imagePlayer.src && imagePlayer.src !== '' && imagePlayer.style.display === 'block') {
                showImage(imagePlayer.src);
            }
            // If a video is currently playing, start crop loop
            if (!activePlayer.paused && activePlayer.videoWidth > 0) {
                startCropVideoLoop(activePlayer);
            }
        }
    });
}
