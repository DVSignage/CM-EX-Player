const express = require('express');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const WebSocket = require('ws');

// Shared broadcast function — filled in once the server starts
let _broadcast = () => {};

function setupApi(getMainWindow, CACHE_DIR, getNdiSources, startNdiSend, stopNdiSend, getNdiSender) {
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
            res.json({ devices });
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
        const { deviceId, width, height } = req.body || {};
        if (!deviceId) {
            return res.status(400).json({ error: 'deviceId is required' });
        }
        const captureConfig = {
            deviceId,
            width: width || 1920,
            height: height || 1080
        };
        mainWindow.webContents.send('start-capture', captureConfig);
        res.json({ status: 'success', message: 'Capture started', config: captureConfig });
    });

    apiApp.post('/api/capture/stop', (req, res) => {
        const mainWindow = getMainWindow();
        if (!mainWindow) {
            return res.status(503).json({ error: 'Player window not available' });
        }
        mainWindow.webContents.send('stop-capture');
        res.json({ status: 'success', message: 'Capture stopped, resuming playlist' });
    });

    // --- NDI Source Discovery ---
    apiApp.get('/api/ndi/sources', async (req, res) => {
        try {
            const sources = getNdiSources ? await getNdiSources() : [];
            res.json({ sources });
        } catch (err) {
            res.json({ sources: [], error: err.message });
        }
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
            preview_supported: true,
            ndi_supported: typeof getNdiSources === 'function',
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

    // --- NDI Send (Capture → NDI broadcast) ---

    apiApp.post('/api/ndi/send/start', (req, res) => {
        const sourceName = req.body.sourceName || 'Player-Capture';
        if (typeof startNdiSend === 'function') {
            startNdiSend(sourceName);
            res.json({ status: 'success', sourceName });
        } else {
            res.status(501).json({ error: 'NDI send not available' });
        }
    });

    apiApp.post('/api/ndi/send/stop', (_req, res) => {
        if (typeof stopNdiSend === 'function') {
            stopNdiSend();
            res.json({ status: 'success', message: 'NDI broadcast stopped' });
        } else {
            res.status(501).json({ error: 'NDI send not available' });
        }
    });

    apiApp.get('/api/ndi/send/status', (_req, res) => {
        const sender = typeof getNdiSender === 'function' ? getNdiSender() : null;
        res.json({
            active: !!(sender && sender.active),
            sourceName: sender ? sender.sourceName : null,
        });
    });

    const API_PORT = 8081;
    const server = apiApp.listen(API_PORT, () => console.log(`Local API listening on port ${API_PORT}`));

    // --- WebSocket server for playback status (same port as HTTP) ---
    const wss = new WebSocket.Server({ server });

    wss.on('connection', (ws) => {
        console.log('[WS] Client connected');
        ws.on('close', () => console.log('[WS] Client disconnected'));
        ws.on('error', (err) => console.warn('[WS] Error:', err.message));
    });

    _broadcast = (data) => {
        const msg = JSON.stringify(data);
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(msg);
            }
        });
    };

    console.log(`[WS] WebSocket server ready on ws://localhost:${API_PORT}`);
}

// Attach broadcastStatus AFTER the function declaration so it isn't overwritten
setupApi.broadcastStatus = (data) => _broadcast(data);

module.exports = setupApi;
