const playerA = document.getElementById('playerA');
const playerB = document.getElementById('playerB');
const imagePlayer = document.getElementById('imagePlayer');
const capturePlayer = document.getElementById('capturePlayer');
const liveCanvas = document.getElementById('liveCanvas');
const liveCtx = liveCanvas ? liveCanvas.getContext('2d') : null;
const debugInfo = document.getElementById('debug-info');

let activePlayer = playerA;
let hiddenPlayer = playerB;
let currentVideoIndex = 0;
let captureStream = null;
let captureActive = false;
let imageTimer = null;
let currentCrop = null; // video wall crop region { x, y, w, h } normalised 0.0–1.0

// --- Native live input (DeckLink / NDI) state ---
let liveActive = false;
let liveInfo = null;         // { kind, available, label, error }
let framePort = null;        // MessagePort delivering raw frames from main
let latestFrame = null;      // most recent { format, width, height, rowBytes, buffer }
let liveRAF = null;          // requestAnimationFrame handle for the draw loop
let liveRgba = null;         // reused Uint8ClampedArray for RGBA output
let liveImageData = null;    // reused ImageData bound to liveRgba

const IMAGE_DEFAULT_DURATION_MS = 10000;

// --- Video wall crop canvas ---
const cropCanvas = document.getElementById('cropCanvas');
const cropCtx = cropCanvas ? cropCanvas.getContext('2d') : null;
let cropVideoRAF = null; // requestAnimationFrame handle for video crop loop

function applyVolumeToPlayers(volume, muted) {
    const level = volume / 100;
    playerA.volume = level;
    playerB.volume = level;
    playerA.muted = muted;
    playerB.muted = muted;
}

function isImagePath(path) {
    return /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(path);
}

function showImage(path) {
    playerA.pause(); playerB.pause();
    playerA.style.display = 'none'; playerB.style.display = 'none';
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
    playerA.style.display = ''; playerB.style.display = '';
}

// Empty playlist. Player will wait for CMS push.
const playlist = [];

function updateDebug(msg) {
    const videoName = playlist[currentVideoIndex] ? playlist[currentVideoIndex].split('/').pop() : 'None';
    debugInfo.innerText = `Status: ${msg}\nPlaying Index: ${currentVideoIndex}\nVideo: ${videoName}`;
}

function initializePlayer() {
    if (playlist.length === 0) return;

    if (isImagePath(playlist[0])) {
        hideImage();
        showImage(playlist[0]);
        updateDebug('Showing image...');
        imageTimer = setTimeout(() => handleVideoEnd(), IMAGE_DEFAULT_DURATION_MS);
    } else {
        hideImage();
        activePlayer.src = playlist[0];
        activePlayer.play().catch(e => console.error(e));
        if (currentCrop) startCropVideoLoop(activePlayer);
        updateDebug('Playing...');
        const nextPath = playlist.length > 1 ? playlist[1] : playlist[0];
        if (!isImagePath(nextPath)) {
            hiddenPlayer.src = nextPath;
            hiddenPlayer.load();
        }
    }
}

function handleVideoEnd() {
    updateDebug('Switching...');

    if (playlist.length <= 1) {
        currentVideoIndex = 0;
        initializePlayer();
        return;
    }

    const nextVideoIndex = (currentVideoIndex + 1) % playlist.length;
    currentVideoIndex = nextVideoIndex;
    const nextPath = playlist[nextVideoIndex];

    if (isImagePath(nextPath)) {
        activePlayer.classList.remove('active');
        activePlayer.classList.add('hidden');
        hideImage();
        showImage(nextPath);
        updateDebug('Showing image...');
        imageTimer = setTimeout(() => handleVideoEnd(), IMAGE_DEFAULT_DURATION_MS);
        return;
    }

    hideImage();
    const preloadVideoIndex = (nextVideoIndex + 1) % playlist.length;

    activePlayer.classList.remove('active');
    activePlayer.classList.add('hidden');
    hiddenPlayer.classList.remove('hidden');
    hiddenPlayer.classList.add('active');
    hiddenPlayer.play().catch(e => console.error(e));

    const temp = activePlayer;
    activePlayer = hiddenPlayer;
    hiddenPlayer = temp;

    if (currentCrop) startCropVideoLoop(activePlayer);

    const preloadPath = playlist[preloadVideoIndex];
    if (!isImagePath(preloadPath)) {
        hiddenPlayer.src = preloadPath;
        hiddenPlayer.load();
    }

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
        // Mutual exclusion: a getUserMedia capture replaces any native live input.
        if (liveActive) stopLiveSource();
        if (window.playerAPI && window.playerAPI.requestStopLive) window.playerAPI.requestStopLive();

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

// --- Native Live Input (DeckLink / NDI) ---

function showLiveCanvas() {
    // Mirror the capture overlay: hide/pause the A/B players, show the canvas.
    playerA.style.display = 'none';
    playerA.pause();
    playerB.style.display = 'none';
    playerB.pause();
    if (liveCanvas) liveCanvas.style.display = 'block';
}

function hideLiveCanvas() {
    if (liveCanvas) liveCanvas.style.display = 'none';
    playerA.style.display = '';
    playerB.style.display = '';
    activePlayer.classList.remove('hidden');
    activePlayer.classList.add('active');
    if (playlist.length > 0) {
        activePlayer.play().catch(e => console.error(e));
    }
}

// Receive the frame-delivery MessagePort from main (once per renderer load).
function attachFramePort(port) {
    framePort = port;
    framePort.onmessage = (event) => { latestFrame = event.data; };
    if (framePort.start) framePort.start();
}

function ensureRgbaBuffers(width, height) {
    const needed = width * height * 4;
    if (!liveRgba || liveRgba.length !== needed) {
        liveRgba = new Uint8ClampedArray(needed);
        liveImageData = new ImageData(liveRgba, width, height);
    }
}

function clampByte(v) {
    return v < 0 ? 0 : (v > 255 ? 255 : v);
}

// BGRA/BGRX (NDI) → RGBA, honouring row stride.
function drawBGRA(frame) {
    const { width, height, buffer, rowBytes } = frame;
    const src = new Uint8Array(buffer);
    const stride = rowBytes || width * 4;
    ensureRgbaBuffers(width, height);
    const out = liveRgba;
    for (let y = 0; y < height; y++) {
        let s = y * stride;
        let d = y * width * 4;
        for (let x = 0; x < width; x++) {
            out[d] = src[s + 2];     // R
            out[d + 1] = src[s + 1]; // G
            out[d + 2] = src[s];     // B
            out[d + 3] = 255;        // A
            s += 4; d += 4;
        }
    }
}

// UYVY 4:2:2 (DeckLink 8-bit YUV) → RGBA (BT.601 limited range), honouring stride.
function drawUYVY(frame) {
    const { width, height, buffer, rowBytes } = frame;
    const src = new Uint8Array(buffer);
    const stride = rowBytes || width * 2;
    ensureRgbaBuffers(width, height);
    const out = liveRgba;
    for (let y = 0; y < height; y++) {
        let s = y * stride;
        let d = y * width * 4;
        for (let x = 0; x < width; x += 2) {
            const u = src[s] - 128;
            const y0 = src[s + 1] - 16;
            const v = src[s + 2] - 128;
            const y1 = src[s + 3] - 16;
            const uR = 409 * v + 128;
            const uG = -100 * u - 208 * v + 128;
            const uB = 516 * u + 128;
            let c = 298 * y0;
            out[d] = clampByte((c + uR) >> 8);
            out[d + 1] = clampByte((c + uG) >> 8);
            out[d + 2] = clampByte((c + uB) >> 8);
            out[d + 3] = 255;
            c = 298 * y1;
            out[d + 4] = clampByte((c + uR) >> 8);
            out[d + 5] = clampByte((c + uG) >> 8);
            out[d + 6] = clampByte((c + uB) >> 8);
            out[d + 7] = 255;
            s += 4; d += 8;
        }
    }
}

function drawLivePlaceholder() {
    if (!liveCtx || !liveCanvas) return;
    if (liveCanvas.width !== liveCanvas.clientWidth) liveCanvas.width = liveCanvas.clientWidth || 1280;
    if (liveCanvas.height !== liveCanvas.clientHeight) liveCanvas.height = liveCanvas.clientHeight || 720;
    const w = liveCanvas.width, h = liveCanvas.height;
    liveCtx.fillStyle = '#000';
    liveCtx.fillRect(0, 0, w, h);
    liveCtx.fillStyle = '#888';
    liveCtx.textAlign = 'center';
    liveCtx.font = `${Math.round(h / 24)}px sans-serif`;
    const kind = liveInfo && liveInfo.kind === 'ndi' ? 'NDI' : 'DeckLink';
    const label = (liveInfo && liveInfo.label) ? ` — ${liveInfo.label}` : '';
    let msg;
    if (liveInfo && liveInfo.available === false) {
        msg = liveInfo.error
            ? `${kind} error: ${liveInfo.error}`
            : `${kind} not available on this device`;
    } else {
        msg = `Waiting for ${kind} signal${label}…`;
    }
    liveCtx.fillText(msg, w / 2, h / 2);
}

function liveDrawLoop() {
    if (!liveActive) return;
    const frame = latestFrame;
    if (frame && liveCtx) {
        if (liveCanvas.width !== frame.width) liveCanvas.width = frame.width;
        if (liveCanvas.height !== frame.height) liveCanvas.height = frame.height;
        try {
            if (frame.format === 'UYVY') drawUYVY(frame);
            else drawBGRA(frame);
            liveCtx.putImageData(liveImageData, 0, 0);
        } catch (err) {
            console.error('[LIVE] draw failed:', err.message);
        }
        latestFrame = null; // draw-latest: drop stale frames
    } else if (!frame && (!liveInfo || liveInfo.available === false)) {
        drawLivePlaceholder();
    }
    liveRAF = requestAnimationFrame(liveDrawLoop);
}

function startLiveSource(info) {
    // Mutual exclusion: a native source replaces getUserMedia capture.
    if (captureActive) stopCapture();
    liveInfo = info || {};
    liveActive = true;
    latestFrame = null;
    showLiveCanvas();
    drawLivePlaceholder();
    updateDebug(`${(liveInfo.kind || 'live').toUpperCase()}${liveInfo.label ? ' — ' + liveInfo.label : ''}${liveInfo.available === false ? ' (unavailable)' : ''}`);
    if (liveRAF) cancelAnimationFrame(liveRAF);
    liveRAF = requestAnimationFrame(liveDrawLoop);
}

function stopLiveSource() {
    if (!liveActive) return;
    liveActive = false;
    liveInfo = null;
    latestFrame = null;
    if (liveRAF) { cancelAnimationFrame(liveRAF); liveRAF = null; }
    hideLiveCanvas();
    updateDebug('Live input stopped, resuming playlist');
}

// Stop every live overlay (getUserMedia capture + native) and ask main to tear
// down native producers. Used when a playlist takes over the screen.
function stopAllLiveInputs() {
    if (captureActive) stopCapture();
    if (liveActive) stopLiveSource();
    if (window.playerAPI && window.playerAPI.requestStopLive) window.playerAPI.requestStopLive();
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

    window.playerAPI.onUpdatePlaylist((newPlaylistPaths) => {
        console.log("Received new local playlist.");
        if (!newPlaylistPaths || newPlaylistPaths.length === 0) return;

        // If any live input is active, stop it first so the playlist takes over
        stopAllLiveInputs();

        // Stop image timer if showing a static image
        hideImage();

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

        currentVideoIndex = 0;
        initializePlayer();
    });

    window.playerAPI.onAppendPlaylist((newPlaylistPaths) => {
        console.log("Background downloads complete. Appending local playlist.");
        if (!newPlaylistPaths || newPlaylistPaths.length === 0) return;

        // Quietly replace the background playlist array
        // without interrupting the currently playing active video!
        playlist.length = 0;
        playlist.push(...newPlaylistPaths);

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

    // --- Native Live Input (DeckLink / NDI) Listeners ---
    window.playerAPI.onFramePort((port) => {
        attachFramePort(port);
    });

    window.playerAPI.onStartLive((info) => {
        startLiveSource(info);
    });

    window.playerAPI.onStopLive(() => {
        stopLiveSource();
    });

    // --- Volume control ---
    window.playerAPI.onSetVolume(({ volume, muted }) => {
        applyVolumeToPlayers(volume, muted);
        console.log(`[VOLUME] volume=${volume} muted=${muted}`);
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
