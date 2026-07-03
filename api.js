const express = require('express');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

module.exports = function setupApi(getMainWindow, CACHE_DIR, providers) {
    providers = providers || {};
    const ndi = providers.ndi || { isAvailable: () => false, listSources: () => [] };
    const decklink = providers.decklink || { isAvailable: () => false, listSources: () => [] };
    const apiApp = express();
    apiApp.use(cors());
    apiApp.use(express.json());

    // --- Preview streaming configuration ---
    const PREVIEW_FPS = 3;
    const PREVIEW_WIDTH = 640;
    const PREVIEW_HEIGHT = 360;
    const PREVIEW_QUALITY = 50;
    let activeStreamCount = 0;

    // --- Helper: capture a single preview frame ---
    async function capturePreviewFrame() {
        const mainWindow = getMainWindow();
        if (!mainWindow) return null;
        try {
            const nativeImage = await mainWindow.webContents.capturePage();
            const resized = nativeImage.resize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
            return resized.toJPEG(PREVIEW_QUALITY);
        } catch (err) {
            console.error('[PREVIEW] Frame capture error:', err.message);
            return null;
        }
    }

    // --- MJPEG Preview Endpoints ---

    apiApp.get('/api/preview/stream', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Connection': 'keep-alive'
        });

        activeStreamCount++;
        let closed = false;

        const intervalMs = Math.round(1000 / PREVIEW_FPS);
        const frameInterval = setInterval(async () => {
            if (closed) return;
            const jpegBuffer = await capturePreviewFrame();
            if (!jpegBuffer || closed) return;
            try {
                res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuffer.length}\r\n\r\n`);
                res.write(jpegBuffer);
                res.write('\r\n');
            } catch (err) {
                // Client disconnected
                cleanup();
            }
        }, intervalMs);

        function cleanup() {
            if (closed) return;
            closed = true;
            clearInterval(frameInterval);
            activeStreamCount--;
            try { res.end(); } catch (e) {}
        }

        req.on('close', cleanup);
        req.on('error', cleanup);
    });

    apiApp.get('/api/preview/snapshot', async (req, res) => {
        const jpegBuffer = await capturePreviewFrame();
        if (!jpegBuffer) {
            return res.status(503).json({ error: 'Unable to capture frame — window not available' });
        }
        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': jpegBuffer.length,
            'Cache-Control': 'no-cache'
        });
        res.end(jpegBuffer);
    });

    apiApp.get('/api/preview/config', (req, res) => {
        res.json({
            fps: PREVIEW_FPS,
            width: PREVIEW_WIDTH,
            height: PREVIEW_HEIGHT,
            quality: PREVIEW_QUALITY,
            active_streams: activeStreamCount
        });
    });

    // --- Capture Card Endpoints ---

    apiApp.get('/api/capture/devices', async (req, res) => {
        const mainWindow = getMainWindow();
        if (!mainWindow) {
            return res.status(503).json({ error: 'Player window not available' });
        }
        try {
            const devices = await mainWindow.webContents.executeJavaScript(
                `navigator.mediaDevices.enumerateDevices().then(d => d.filter(x => x.kind === "videoinput").map(x => ({deviceId: x.deviceId, label: x.label})))`
            );
            // DeckLink devices are not visible to getUserMedia — list them separately.
            res.json({ devices, decklink_devices: decklink.listSources() });
        } catch (err) {
            console.error('[CAPTURE] Device enumeration error:', err.message);
            res.status(500).json({ error: 'Failed to enumerate capture devices', details: err.message });
        }
    });

    apiApp.post('/api/capture/start', (req, res) => {
        const mainWindow = getMainWindow();
        if (!mainWindow) {
            return res.status(503).json({ error: 'Player window not available' });
        }
        const body = req.body || {};
        const kind = (body.kind || '').toLowerCase();
        const isDeckLink = kind === 'decklink' || Number.isInteger(body.deviceIndex);
        // DeckLink capture routes through the native SDK path in main.js.
        if (isDeckLink) {
            if (typeof providers.startDeckLink !== 'function') {
                return res.status(500).json({ error: 'DeckLink routing unavailable' });
            }
            const cfg = { deviceIndex: body.deviceIndex || 0, label: body.label, displayMode: body.displayMode };
            providers.startDeckLink(cfg);
            return res.json({ status: 'success', message: 'DeckLink capture started', config: cfg });
        }
        const { deviceId, width, height } = body;
        if (!deviceId) {
            return res.status(400).json({ error: 'deviceId is required' });
        }
        const captureConfig = {
            deviceId,
            width: width || 1920,
            height: height || 1080
        };
        if (typeof providers.stopLive === 'function') providers.stopLive();
        mainWindow.webContents.send('start-capture', captureConfig);
        res.json({ status: 'success', message: 'Capture started', config: captureConfig });
    });

    apiApp.post('/api/capture/stop', (req, res) => {
        const mainWindow = getMainWindow();
        if (!mainWindow) {
            return res.status(503).json({ error: 'Player window not available' });
        }
        if (typeof providers.stopLive === 'function') providers.stopLive();
        mainWindow.webContents.send('stop-capture');
        res.json({ status: 'success', message: 'Capture stopped, resuming playlist' });
    });

    // --- NDI Endpoints ---

    apiApp.get('/api/ndi/sources', (req, res) => {
        res.json({ available: ndi.isAvailable(), sources: ndi.listSources() });
    });

    apiApp.post('/api/ndi/start', (req, res) => {
        const mainWindow = getMainWindow();
        if (!mainWindow) {
            return res.status(503).json({ error: 'Player window not available' });
        }
        if (typeof providers.startNdi !== 'function') {
            return res.status(500).json({ error: 'NDI routing unavailable' });
        }
        const { sourceName, bandwidth } = req.body || {};
        if (!sourceName) {
            return res.status(400).json({ error: 'sourceName is required' });
        }
        providers.startNdi({ sourceName, bandwidth });
        res.json({ status: 'success', message: 'NDI receive started', config: { sourceName, bandwidth } });
    });

    apiApp.post('/api/ndi/stop', (req, res) => {
        const mainWindow = getMainWindow();
        if (!mainWindow) {
            return res.status(503).json({ error: 'Player window not available' });
        }
        if (typeof providers.stopLive === 'function') providers.stopLive();
        res.json({ status: 'success', message: 'NDI receive stopped, resuming playlist' });
    });

    // --- Existing Playback Control Endpoints ---

    apiApp.post('/api/play', (req, res) => {
        const mainWindow = getMainWindow();
        if (mainWindow) mainWindow.webContents.send('control-command', 'play');
        res.json({ status: 'success' });
    });

    apiApp.post('/api/pause', (req, res) => {
        const mainWindow = getMainWindow();
        if (mainWindow) mainWindow.webContents.send('control-command', 'pause');
        res.json({ status: 'success' });
    });

    apiApp.post('/api/restart', (req, res) => {
        const mainWindow = getMainWindow();
        if (mainWindow) mainWindow.webContents.send('control-command', 'restart');
        res.json({ status: 'success' });
    });

    apiApp.post('/api/sys-reboot', (req, res) => {
        console.log("Hardware reboot sequence initiated via API...");
        res.json({ status: 'rebooting' });

        exec('shutdown /r /t 0', (error) => {
            if (error) {
                console.error(`Reboot error: ${error.message}`);
            }
        });
    });

    apiApp.get('/api/device', (req, res) => {
        let mac = '', ip = '';
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    mac = iface.mac;
                    ip = iface.address;
                    break;
                }
            }
            if (ip) break;
        }

        let freeSpace = 0, totalSpace = 0;
        try {
            const stats = fs.statfsSync(CACHE_DIR);
            freeSpace = stats.bavail * stats.bsize;
            totalSpace = stats.blocks * stats.bsize;
        } catch (e) {
            console.error("Could not read disk space", e);
        }

        let cacheSize = 0;
        try {
            const files = fs.readdirSync(CACHE_DIR);
            for (const f of files) {
                const fstats = fs.statSync(path.join(CACHE_DIR, f));
                cacheSize += fstats.size;
            }
        } catch(e) {}

        res.json({
            mac_address: mac,
            ip_address: ip,
            platform: os.platform(),
            free_space_bytes: freeSpace,
            total_space_bytes: totalSpace,
            cache_size_bytes: cacheSize,
            memory_total_bytes: os.totalmem(),
            memory_free_bytes: os.freemem(),
            cache_limit_bytes: 50 * 1024 * 1024 * 1024,
            capture_supported: true,
            decklink_supported: decklink.isAvailable(),
            ndi_supported: ndi.isAvailable(),
            preview_supported: true,
            preview: {
                stream_url: `http://${ip}:${API_PORT}/api/preview/stream`,
                snapshot_url: `http://${ip}:${API_PORT}/api/preview/snapshot`,
                fps: PREVIEW_FPS,
                width: PREVIEW_WIDTH,
                height: PREVIEW_HEIGHT,
                quality: PREVIEW_QUALITY,
                active_streams: activeStreamCount
            }
        });
    });

    const API_PORT = 8081;
    const server = apiApp.listen(API_PORT, () => console.log(`Local API listening on port ${API_PORT}`));
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            const { dialog, app } = require('electron');
            dialog.showMessageBox({
                type: 'warning',
                title: 'Port Already In Use',
                message: `Local API (port ${API_PORT}) is unavailable.`,
                detail: 'Another instance of CMX Player may already be running. Third-party API control will not work, but the player will continue normally.',
                buttons: ['OK']
            });
        } else {
            console.error('API server error:', err);
        }
    });
};
