const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow;

// --- CONFIGURATION ---
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const CACHE_DIR = path.join(app.getPath('userData'), 'cache');
const OFFLINE_PLAYLIST_PATH = path.join(app.getPath('userData'), 'offline_playlist.json');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

let config = {
    cms_url: '',
    player_id: null,
    volume: 100,
    muted: false
};

// Load config if exists
if (fs.existsSync(CONFIG_PATH)) {
    try {
        const fileContent = fs.readFileSync(CONFIG_PATH, 'utf8');
        config = { ...config, ...JSON.parse(fileContent) };
    } catch (e) {
        console.error("Failed to load config, using defaults", e);
    }
}

function saveConfig() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// --- CMS INTEGRATION LOGIC ---

let enrollmentPollingInterval = null;
let heartbeatInterval = null;

async function requestEnrollment() {
    try {
        console.log("Requesting enrollment code from CMS...");
        const response = await axios.post(`${config.cms_url}/api/v1/players/enroll/request`);
        const { code, expires_at } = response.data;

        console.log(`Enrollment code received: ${code}`);
        mainWindow.webContents.send('show-enrollment-code', code);

        // Start polling for status
        if (enrollmentPollingInterval) clearInterval(enrollmentPollingInterval);
        enrollmentPollingInterval = setInterval(() => checkEnrollmentStatus(code), 5000);

    } catch (error) {
        console.error("Enrollment request failed:", error.message);
        setTimeout(requestEnrollment, 10000); // Retry after 10 seconds
    }
}

async function checkEnrollmentStatus(code) {
    try {
        console.log(`Checking status for code: ${code}...`);
        const response = await axios.get(`${config.cms_url}/api/v1/players/enroll/${code}/status`);

        if (response.data.status === 'approved' && response.data.player_id) {
            console.log(`Player approved! ID: ${response.data.player_id}`);
            clearInterval(enrollmentPollingInterval);

            // Save setup
            config.player_id = response.data.player_id;
            saveConfig();

            mainWindow.webContents.send('hide-enrollment-code');
            startPlayerRoutines();
        } else if (response.data.status === 'expired' || response.data.status === 'rejected') {
             console.log("Enrollment expired or rejected. Requesting new code.");
             clearInterval(enrollmentPollingInterval);
             requestEnrollment();
        }
    } catch (error) {
        if (error.response && error.response.status === 404) {
            // Still waiting
        } else {
             console.error("Error checking enrollment status:", error.message);
        }
    }
}

function startPlayerRoutines() {
    console.log("Starting player routines...");

    // 1. Boot instantly from cached playlist — no waiting for network
    global.boot_cache_loaded = false;
    if (fs.existsSync(OFFLINE_PLAYLIST_PATH)) {
        console.log("[BOOT] Loading cached playlist for instant playback...");
        try {
            const offlineData = JSON.parse(fs.readFileSync(OFFLINE_PLAYLIST_PATH, 'utf8'));
            processAndDownloadPlaylist(offlineData);
            global.boot_cache_loaded = true;
        } catch (e) {
            console.error("[BOOT] Failed to load cached playlist:", e.message);
        }
    }

    // 2. Fetch latest from CMS in background — updates playlist if anything changed
    fetchPlaylist();

    // 3. Connect SSE for real-time CMS push commands
    startSseConnection();

    // 4. Start Heartbeat (every 500 milliseconds for fast push command detection)
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(sendHeartbeat, 500);
    sendHeartbeat(); // send initial heartbeat immediately
}

async function sendHeartbeat() {
    try {
        let captureDevices = [];
        try {
            const devices = await mainWindow.webContents.executeJavaScript(`
              navigator.mediaDevices.enumerateDevices()
                .then(devices => devices.filter(d => d.kind === 'videoinput').map(d => ({label: d.label, deviceId: d.deviceId})))
            `);
            captureDevices = devices || [];
        } catch(e) { captureDevices = []; }

        const response = await axios.post(`${config.cms_url}/api/v1/players/${config.player_id}/heartbeat`, {
             status: 'online',
             timestamp: new Date().toISOString(),
             capture_devices: captureDevices
        });

        if (response.data && response.data.command && response.data.command !== 'none') {
            const cmd = response.data.command;
            console.log(`[HEARTBEAT COMMAND DETECTED] Command: ${cmd}`);

            if (cmd === 'load_playlist') {
                // Use playlist_hash if available, fall back to playlist_id for dedup
                const incomingHash = response.data.playlist_hash || response.data.playlist_id;
                if (incomingHash && incomingHash === global.last_playlist_hash) {
                    console.log("Playlist unchanged (hash match). Skipping redundant fetch.");
                } else {
                    global.last_playlist_hash = incomingHash || null;
                    global.last_content_id = null;
                    fetchPlaylist();
                }
            } else if (cmd === 'load_content' && response.data.content_id) {
                if (response.data.content_id === global.last_content_id) {
                    // Same content already loaded — skip
                } else {
                    global.last_content_id = response.data.content_id;
                    global.last_playlist_hash = null;
                    console.log(`Loading direct content: ${response.data.content_id}`);
                    loadSingleContent(response.data.content_id);
                }
            } else if (cmd === 'load_wall_content' && response.data.wall_content_id) {
                const wallKey = `${response.data.wall_content_id}_${JSON.stringify(response.data.wall_crop)}`;
                if (wallKey === global.last_wall_key) {
                    // Same wall content + crop already loaded — skip
                } else {
                    global.last_wall_key = wallKey;
                    global.last_content_id = null;
                    global.last_playlist_hash = null;
                    const crop = response.data.wall_crop;
                    if (crop && mainWindow) {
                        // Normalise crop to 0.0–1.0 range
                        const normCrop = {
                            x: crop.x / crop.canvas_w,
                            y: crop.y / crop.canvas_h,
                            w: crop.w / crop.canvas_w,
                            h: crop.h / crop.canvas_h,
                        };
                        console.log(`[WALL] Setting crop: x=${normCrop.x.toFixed(3)} y=${normCrop.y.toFixed(3)} w=${normCrop.w.toFixed(3)} h=${normCrop.h.toFixed(3)}`);
                        mainWindow.webContents.send('set-crop', normCrop);
                    }
                    console.log(`[WALL] Loading wall content: ${response.data.wall_content_id}`);
                    loadSingleContent(response.data.wall_content_id);
                }
            } else if (cmd === 'show_capture') {
                if (mainWindow) mainWindow.webContents.send('start-capture', { deviceLabel: response.data.capture_device_label });
            } else if (cmd === 'hide_capture') {
                if (mainWindow) mainWindow.webContents.send('stop-capture');
            } else if (['play', 'pause', 'next', 'previous', 'restart'].includes(cmd)) {
                if (mainWindow) mainWindow.webContents.send('control-command', cmd);
            } else if (cmd === 'refresh') {
                handleRefreshCommand();
            } else if (cmd === 'restart_service') {
                handleRestartCommand();
            } else if (cmd === 'set_volume') {
                const volume = typeof response.data.volume === 'number' ? Math.max(0, Math.min(100, response.data.volume)) : config.volume;
                const muted = typeof response.data.muted === 'boolean' ? response.data.muted : config.muted;
                applyVolume(volume, muted);
            }
        }

        // Video wall crop data — forwarded to renderer independently of commands
        if (response.data && response.data.crop) {
            if (JSON.stringify(response.data.crop) !== JSON.stringify(global.current_crop)) {
                global.current_crop = response.data.crop;
                if (mainWindow) mainWindow.webContents.send('set-crop', response.data.crop);
            }
        } else if (global.current_crop) {
            global.current_crop = null;
            if (mainWindow) mainWindow.webContents.send('set-crop', null);
        }
    } catch (error) {
        console.error("Heartbeat failed:", error.message);
        if (error.response && error.response.status === 404) {
            console.log("[CMS DELETION DETECTED] This player was removed from the portal.");
            config.player_id = null;
            if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);

            if (heartbeatInterval) clearInterval(heartbeatInterval);

            if (mainWindow) {
                 mainWindow.webContents.send('update-playlist', []);
                 mainWindow.webContents.send('prompt-cms-url', config.cms_url);
            }
        }
    }
}

function handleCMSCommand(data) {
    if (!data || !data.command || data.command === 'none') return;

    const cmd = data.command;
    console.log(`[CMS PUSH DETECTED] Command: ${cmd}`);

    if (cmd === 'load_playlist') {
        fetchPlaylist();
    } else if (cmd === 'load_content' && data.content_id) {
        global.last_content_id = data.content_id;
        global.last_playlist_hash = null;
        console.log(`Loading direct content: ${data.content_id}`);
        loadSingleContent(data.content_id);
    } else if (cmd === 'show_capture') {
        if (mainWindow) mainWindow.webContents.send('start-capture', { deviceLabel: data.capture_device_label });
    } else if (cmd === 'hide_capture') {
        if (mainWindow) mainWindow.webContents.send('stop-capture');
    } else if (['play', 'pause', 'next', 'previous', 'restart'].includes(cmd)) {
        if (mainWindow) mainWindow.webContents.send('control-command', cmd);
    } else if (cmd === 'set_volume') {
        const volume = typeof data.volume === 'number' ? Math.max(0, Math.min(100, data.volume)) : config.volume;
        const muted = typeof data.muted === 'boolean' ? data.muted : config.muted;
        applyVolume(volume, muted);
    } else if (cmd === 'delete_player') {
        console.log("[CMS DELETION DETECTED] This player was removed from the portal.");
        config.player_id = null;
        if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);

        if (mainWindow) {
             mainWindow.webContents.send('update-playlist', []);
             mainWindow.webContents.send('prompt-cms-url', config.cms_url);
        }
    }
}

function applyVolume(volume, muted) {
    config.volume = volume;
    config.muted = muted;
    saveConfig();
    if (mainWindow) mainWindow.webContents.send('set-volume', { volume, muted });
    console.log(`[VOLUME] volume=${volume} muted=${muted}`);
}

let sseConnection = null;

function startSseConnection() {
    if (!config.cms_url || !config.player_id) return;
    if (sseConnection) { sseConnection.close(); sseConnection = null; }

    const { EventSource } = require('eventsource');
    const url = `${config.cms_url}/api/v1/players/${config.player_id}/events`;
    console.log(`[SSE] Connecting to ${url}`);

    sseConnection = new EventSource(url);
    sseConnection.onmessage = (event) => {
        try { handleCMSCommand(JSON.parse(event.data)); }
        catch (e) { console.error('[SSE] Parse error:', e.message); }
    };
    sseConnection.onerror = () => console.warn('[SSE] Connection lost, retrying...');
}

let refreshInProgress = false;

function handleRefreshCommand() {
    if (refreshInProgress || !mainWindow) return;
    refreshInProgress = true;
    console.log('[CMD] Refresh: reloading renderer...');

    mainWindow.webContents.reload();

    mainWindow.webContents.once('did-finish-load', async () => {
        refreshInProgress = false;
        try {
            await axios.post(`${config.cms_url}/api/v1/players/${config.player_id}/ack`, {
                success: true,
                message: 'Refresh completed'
            });
            console.log('[CMD] Refresh ACK sent.');
        } catch (e) {
            console.error('[CMD] Refresh ACK failed:', e.message);
        }
    });
}

function handleRestartCommand() {
    console.log('[CMD] Restart: relaunching app...');
    app.relaunch();
    app.exit(0);
}

async function fetchPlaylist() {
    try {
        console.log("Fetching assigned playlist...");
        const response = await axios.get(`${config.cms_url}/api/v1/players/${config.player_id}/assigned-playlist`);
        const playlistData = response.data;

        // NOTE: do NOT set last_playlist_hash here — the heartbeat handler sets it
        // before calling fetchPlaylist() using the server's canonical hash value.
        // Setting it here with a different format string would break the dedup loop.

        console.log("Playlist retrieved, starting download process...");
        await processAndDownloadPlaylist(playlistData);

    } catch (error) {
        console.error("Failed to fetch playlist via network:", error.message);

        // Offline Fallback Mechanism — only if nothing is already playing from cache
        if (!global.boot_cache_loaded && fs.existsSync(OFFLINE_PLAYLIST_PATH)) {
            console.log("[OFFLINE MODE] Network unreachable. Utilizing last known saved playlist.");
            try {
                const offlineData = JSON.parse(fs.readFileSync(OFFLINE_PLAYLIST_PATH, 'utf8'));
                await processAndDownloadPlaylist(offlineData);
            } catch (e) {
                console.error("Failed to parse offline playlist file.", e.message);
            }
        }
    }
}

async function loadSingleContent(contentId) {
    try {
        const meta = await axios.get(`${config.cms_url}/api/v1/content/${contentId}`);
        const filename = meta.data.filename || `${contentId}`;
        const mockPlaylist = { items: [{ content_id: contentId, content: { filename } }] };
        processAndDownloadPlaylist(mockPlaylist);
    } catch (e) {
        console.warn(`[CONTENT] Metadata fetch failed for ${contentId}, using fallback:`, e.message);
        const mockPlaylist = { items: [{ content_id: contentId }] };
        processAndDownloadPlaylist(mockPlaylist);
    }
}

async function processAndDownloadPlaylist(playlistData) {
     if (!playlistData || !playlistData.items || playlistData.items.length === 0) {
         console.log("No items in playlist.");
         return;
     }

     // Save active playlist configuration locally for offline survival
     fs.writeFileSync(OFFLINE_PLAYLIST_PATH, JSON.stringify(playlistData), 'utf8');

     // Build the target structure first
     const finalLocalPathsArray = [];
     const filesToProcess = [];

     for (const item of playlistData.items) {
         if (item.content_id) {
             const remoteUrl = `${config.cms_url}/api/v1/content/${item.content_id}/stream`;

             // Extract original extension if available to fully support WebM and other formats
             let ext = '.mp4';
             if (item.content && item.content.filename) {
                 const match = item.content.filename.match(/\.[0-9a-z]+$/i);
                 if (match) ext = match[0];
             }
             const filename = item.content?.filename || `${item.content_id}${ext}`;
             const localFilePath = path.join(CACHE_DIR, filename);

             const formattedLocalPath = `file:///${localFilePath.replace(/\\/g, '/')}`;
             finalLocalPathsArray.push(formattedLocalPath);

             if (!fs.existsSync(localFilePath)) {
                 filesToProcess.push({ remoteUrl, localFilePath, filename });
             }
         }
     }

     if (filesToProcess.length > 0) {
         // Prevent new downloads if exceeding 50GB limit
         let cacheSize = 0;
         try {
             const files = fs.readdirSync(CACHE_DIR);
             for (const f of files) cacheSize += fs.statSync(path.join(CACHE_DIR, f)).size;
         } catch(e) {}

         if (cacheSize >= 50 * 1024 * 1024 * 1024) {
             console.log("Memory Full. Cache exceeds 50 GB limit. Ignoring new playlist downloads.");
             if (mainWindow) {
                 mainWindow.webContents.send('memory-error', 'Memory Full: Cannot download new content. Cache capacity (50 GB) reached.');
             }
             return;
         }
     }

     // Progressive Initial Playback Structure
     if (mainWindow && filesToProcess.length > 0) {
         global.last_sent_playlist_key = null; // playlist is changing, allow next cached send through
         mainWindow.webContents.send('update-playlist', []);
     }

     // Background download missing files
     if (filesToProcess.length > 0) {
         const downloadFile = async (file, index) => {
             console.log(`[DOWNLOADING] ${file.filename} from ${file.remoteUrl}`);

             try {
                 const response = await axios({ method: 'GET', url: file.remoteUrl, responseType: 'stream' });
                 await new Promise((resolve, reject) => {
                     const tmpFilePath = file.localFilePath + '.tmp';
                     const writer = fs.createWriteStream(tmpFilePath);
                     response.data.pipe(writer);
                     let error = null;
                     writer.on('error', err => { error = err; writer.close(); if (fs.existsSync(tmpFilePath)) fs.unlinkSync(tmpFilePath); reject(err); });
                     writer.on('close', () => { if (!error) { try { fs.renameSync(tmpFilePath, file.localFilePath); resolve(); } catch(e) { reject(e); } } });
                 });
                 console.log(`[SUCCESS] Downloaded ${file.filename}`);
                 return true;
             } catch (err) {
                 console.error(`[ERROR] Failed to download ${file.filename}:`, err.message);
                 return false;
             }
         };

         let allSuccessful = true;
         let initialPlaybackTriggered = false;

         for (let i = 0; i < filesToProcess.length; i++) {
             const success = await downloadFile(filesToProcess[i], i);
             if (!success) {
                 allSuccessful = false;
                 await new Promise(r => setTimeout(r, 2000));
             }

             // Jumpstart the player the microsecond the FIRST video block is ready locally
             // This makes it feel fully "instant" for small files
             if (!initialPlaybackTriggered && fs.existsSync(finalLocalPathsArray[0].replace('file:///', ''))) {
                 console.log("First essential video is cached! Starting initial playback instantly.");
                 if (mainWindow) {
                     // download-progress overlay removed
                     mainWindow.webContents.send('update-playlist', [finalLocalPathsArray[0]]);
                 }
                 initialPlaybackTriggered = true;
             }
         }

         if (mainWindow && !initialPlaybackTriggered) {
             // Fallback just in case
             // download-progress overlay removed
         }

         if (allSuccessful && mainWindow) {
             console.log("All downloads complete. Appending missing background layout seamlessly.");
             mainWindow.webContents.send('append-playlist', finalLocalPathsArray);
         }
     } else {
         // All files are already cached — skip if playlist is identical to what's already playing
         const playlistKey = finalLocalPathsArray.join('|');
         if (playlistKey === global.last_sent_playlist_key) {
             console.log("[PLAYLIST] Unchanged, skipping redundant update.");
             return;
         }
         global.last_sent_playlist_key = playlistKey;
         if (mainWindow) {
             mainWindow.webContents.send('update-playlist', finalLocalPathsArray);
         }
     }

     // Smart LRU Cache Garbage Collection: Keep current playlist + up to 30 other recent videos
     try {
         const currentAssignedFiles = playlistData.items
            .filter(item => item.content_id)
            .map(item => {
                let ext = '.mp4';
                if (item.content && item.content.filename) {
                    const match = item.content.filename.match(/\.[0-9a-z]+$/i);
                    if (match) ext = match[0];
                }
                return item.content?.filename || `${item.content_id}${ext}`;
            });

         const fileStats = [];
         const cachedFiles = fs.readdirSync(CACHE_DIR);
         for (const file of cachedFiles) {
             const isVideoFile = file.match(/\.(mp4|webm|mkv|avi|mov)$/i);
             if (isVideoFile) {
                 const filePath = path.join(CACHE_DIR, file);
                 const stats = fs.statSync(filePath);
                 fileStats.push({ name: file, path: filePath, mtime: stats.mtime.getTime() });
             }
         }

         // Sort by most recently modified first
         fileStats.sort((a, b) => b.mtime - a.mtime);

         let unassignedCount = 0;
         const MAX_UNASSIGNED_CACHE = 1000; // Raised from 30 to 1000 (virtually unlimited for normal operations) per harddrive instructions

         for (const fileInfo of fileStats) {
             if (!currentAssignedFiles.includes(fileInfo.name)) {
                 unassignedCount++;
                 if (unassignedCount > MAX_UNASSIGNED_CACHE) {
                     console.log(`[GARBAGE COLLECTION] Limiting Cache - Deleting old video: ${fileInfo.path}`);
                     try { fs.unlinkSync(fileInfo.path); } catch(e) { console.error(`EPERM/Delete Error for ${fileInfo.path}:`, e.message); }
                 }
             }
         }
     } catch (err) {
         console.error("[GARBAGE COLLECTION ERROR]", err.message);
     }
}


function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        fullscreen: true,
        alwaysOnTop: true,
        kiosk: true,
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'app.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadFile('index.html');

    mainWindow.webContents.on('did-finish-load', () => {
         // Boot sequence
         if (!config.player_id) {
             mainWindow.webContents.send('prompt-cms-url', config.cms_url);
         } else {
             mainWindow.webContents.send('hide-enrollment-code');
             startPlayerRoutines();
         }
         // Restore persisted volume on every page load (including after refresh command)
         mainWindow.webContents.send('set-volume', { volume: config.volume, muted: config.muted });
    });
}

app.whenReady().then(() => {
    require('./api')(() => mainWindow, CACHE_DIR);

    ipcMain.on('submit-cms-url', (event, url) => {
        config.cms_url = url;
        saveConfig();
        requestEnrollment();
    });

    // Capture card device enumeration — must run in renderer context
    ipcMain.handle('get-capture-devices', async () => {
        if (!mainWindow) return [];
        try {
            const result = await mainWindow.webContents.executeJavaScript(
                `navigator.mediaDevices.enumerateDevices().then(d => d.filter(x => x.kind === "videoinput").map(x => ({deviceId: x.deviceId, label: x.label})))`
            );
            return result;
        } catch (err) {
            console.error('Failed to enumerate capture devices:', err.message);
            return [];
        }
    });

    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
