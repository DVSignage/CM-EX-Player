const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const os = require('os');

// Local Express API port — must match api.js
const LOCAL_API_PORT = 8081;

// Get this machine's LAN IP for heartbeat registration.
// Prefers the interface on the same subnet as the CMS server, then falls
// back through real LAN ranges — avoids grabbing Hyper-V / WSL2 adapters.
function getLocalIp() {
    const ifaces = os.networkInterfaces();
    const allIps = [];

    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                allIps.push(iface.address);
            }
        }
    }

    if (allIps.length === 0) return '127.0.0.1';
    if (allIps.length === 1) return allIps[0];

    // 1. Best pick: same /24 subnet as the CMS server
    if (config.cms_url) {
        try {
            const raw = config.cms_url.includes('://') ? config.cms_url : `http://${config.cms_url}`;
            const cmsHost = new URL(raw).hostname;
            const cmsSubnet = cmsHost.split('.').slice(0, 3).join('.');
            const match = allIps.find(ip => ip.startsWith(cmsSubnet + '.'));
            if (match) return match;
        } catch (e) { /* ignore bad URL */ }
    }

    // 2. Prefer real private LAN ranges over virtual adapter ranges
    const prefer = allIps.find(ip => ip.startsWith('192.168.')) ||
                   allIps.find(ip => ip.startsWith('10.'))       ||
                   allIps.find(ip => /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
    return prefer || allIps[0];
}

// NDI support (requires NDI Runtime Tools installed on Windows)
let grandiose = null;
try {
  grandiose = require('grandiose');
  console.log('[NDI] grandiose loaded successfully');
} catch (e) {
  console.warn('[NDI] grandiose not available — NDI features disabled:', e.message);
}

let mainWindow;

// NDI state
const ndiReceivers = {};   // sourceName → { receiver, active, audioEnabled, loopRunning }
let ndiSender = null;      // { sender, active, sourceName } — for broadcasting capture as NDI

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
    player_id: null
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

// Log local IP at startup so it's visible in console
const LOCAL_IP = getLocalIp();
console.log(`[NETWORK] Local IP: ${LOCAL_IP}  API Port: ${LOCAL_API_PORT}`);
console.log(`[NDI] Player local API will be reachable at http://${LOCAL_IP}:${LOCAL_API_PORT}/api/ndi/sources`);

// --- NDI Functions ---

async function startNdiSource(sourceName, audioEnabled = true) {
  if (!grandiose) {
    console.warn('[NDI] Cannot start — grandiose not loaded');
    if (mainWindow) mainWindow.webContents.send('ndi-no-signal', { sourceName });
    return;
  }

  console.log(`[NDI] ▶ startNdiSource called for: "${sourceName}"`);

  // Stop existing receiver for this source if any
  await stopNdiSource(sourceName);

  try {
    console.log(`[NDI] Scanning for source (3s)...`);
    const sources = await grandiose.find({ showLocalSources: true, wait: 3000 });
    console.log(`[NDI] Scan result: ${sources.length} source(s) found:`, sources.map(s => s.name));

    const source = sources.find(s => s.name === sourceName);

    if (!source) {
      console.warn(`[NDI] ✗ Source not found in scan — requested: "${sourceName}"`);
      console.warn(`[NDI]   Available: ${sources.map(s => `"${s.name}"`).join(', ') || 'none'}`);
      if (mainWindow) mainWindow.webContents.send('ndi-no-signal', { sourceName });
      return;
    }

    console.log(`[NDI] ✓ Source matched — creating receiver...`);
    const receiver = await grandiose.receive({
      source,
      colorFormat: grandiose.COLOR_FORMAT_BGRX_BGRA,
      bandwidth: grandiose.RECV_BANDWIDTH_HIGHEST,
      allowVideoFields: false,
    });

    ndiReceivers[sourceName] = { receiver, active: true, audioEnabled, loopRunning: true };
    console.log(`[NDI] ✓ Receiver created — starting frame loop for: "${sourceName}"`);

    // Start frame loop
    ndiVideoLoop(sourceName);

  } catch (err) {
    console.error(`[NDI] ✗ Error starting source "${sourceName}":`, err.message);
    if (mainWindow) mainWindow.webContents.send('ndi-no-signal', { sourceName });
  }
}

async function stopNdiSource(sourceName) {
  const entry = ndiReceivers[sourceName];
  if (!entry) return;
  entry.active = false;
  entry.loopRunning = false;
  try {
    if (entry.receiver && typeof entry.receiver.destroy === 'function') {
      entry.receiver.destroy();
    }
  } catch (e) { /* ignore */ }
  delete ndiReceivers[sourceName];
  console.log(`[NDI] Stopped: ${sourceName}`);
  if (mainWindow) mainWindow.webContents.send('stop-ndi', { sourceName });
}

async function stopAllNdiSources() {
  for (const sourceName of Object.keys(ndiReceivers)) {
    await stopNdiSource(sourceName);
  }
}

const NDI_NO_SIGNAL_DELAY_MS = 20000; // Hold last frame 20s before showing no-signal

async function ndiVideoLoop(sourceName) {
  const entry = ndiReceivers[sourceName];
  if (!entry) return;

  let frameCount = 0;
  let lastFrameTime = Date.now();
  let noSignalShown = false;

  while (entry.loopRunning && entry.active) {
    try {
      const frame = await entry.receiver.video(1000); // 1s timeout per attempt
      if (!entry.loopRunning) break;
      if (frame && mainWindow && !mainWindow.isDestroyed()) {
        frameCount++;
        lastFrameTime = Date.now();

        // If no-signal was showing, clear it on first good frame back
        if (noSignalShown) {
          console.log(`[NDI] Signal restored for: "${sourceName}"`);
          noSignalShown = false;
        }

        if (frameCount === 1 || frameCount === 10) {
          console.log(`[NDI] ✓ Frame #${frameCount} received — ${frame.xres}x${frame.yres}  data: ${frame.data ? frame.data.length : 'null'} bytes`);
        }
        mainWindow.webContents.send('ndi-frame', {
          sourceName,
          data: frame.data,
          width: frame.xres,
          height: frame.yres,
        });
      }
    } catch (err) {
      if (!entry.loopRunning) break;
      // Frame timeout — only show no-signal after 20s of no frames
      const silentMs = Date.now() - lastFrameTime;
      if (!noSignalShown && silentMs >= NDI_NO_SIGNAL_DELAY_MS) {
        console.warn(`[NDI] No frames for ${Math.round(silentMs / 1000)}s on "${sourceName}" — showing no-signal`);
        noSignalShown = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ndi-no-signal', { sourceName });
        }
      }
      // Keep retrying silently
    }
  }
  console.log(`[NDI] Frame loop ended for: ${sourceName} (total frames: ${frameCount})`);
}

async function getNdiSources() {
  if (!grandiose) {
    console.warn('[NDI] getNdiSources called but grandiose is not loaded — NDI Runtime may not be installed');
    return [];
  }
  console.log('[NDI] Scanning for sources (3s)...');
  try {
    const sources = await grandiose.find({ showLocalSources: true, wait: 3000 });
    console.log(`[NDI] Scan complete — found ${sources.length} source(s):`, sources.map(s => s.name));
    return sources.map(s => ({ name: s.name, urlAddress: s.urlAddress }));
  } catch (e) {
    console.error('[NDI] Source scan error:', e.message);
    return [];
  }
}

// --- NDI SEND (Capture → NDI broadcast) ---

function startNdiSend(sourceName) {
  if (!grandiose) {
    console.warn('[NDI SEND] Cannot start — grandiose not loaded');
    return;
  }
  stopNdiSend();  // Stop any existing sender
  try {
    const sender = grandiose.send({ name: sourceName, clockVideo: false, clockAudio: false });
    ndiSender = { sender, active: true, sourceName };
    console.log(`[NDI SEND] Broadcasting as: ${sourceName}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ndi-send-started', { sourceName });
    }
  } catch (e) {
    console.error('[NDI SEND] Failed to create sender:', e.message);
    ndiSender = null;
  }
}

function stopNdiSend() {
  if (!ndiSender) return;
  console.log(`[NDI SEND] Stopping broadcast: ${ndiSender.sourceName}`);
  ndiSender.active = false;
  try {
    // Release the sender — grandiose will clean up the native handle
    ndiSender.sender = null;
  } catch (e) {
    console.warn('[NDI SEND] Cleanup error:', e.message);
  }
  ndiSender = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ndi-send-stopped');
  }
}

// Receive frames from renderer for NDI broadcast
ipcMain.on('ndi-send-frame', (_event, { data, width, height }) => {
  if (!ndiSender || !ndiSender.active || !ndiSender.sender) return;
  try {
    ndiSender.sender.send({
      xres: width,
      yres: height,
      fourCC: grandiose.FOURCC_BGRA || 101,  // BGRA
      frameRateN: 30000,
      frameRateD: 1001,
      data: Buffer.from(data),
    });
  } catch (e) {
    // Suppress frequent frame errors — just log occasionally
    if (Math.random() < 0.01) console.warn('[NDI SEND] Frame error:', e.message);
  }
});

// --- EXPRESS SERVER FOR 3RD PARTY APIs ---
const apiModule = require('./api');
apiModule(() => mainWindow, CACHE_DIR, getNdiSources, startNdiSend, stopNdiSend, () => ndiSender);

// --- PLAYBACK STATUS BROADCAST (renderer → IPC → WebSocket) ---
ipcMain.on('playback-status', (_event, data) => {
    apiModule.broadcastStatus(data);
});

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

    // 3. Start Heartbeat (every 500 milliseconds for fast push command detection)
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
             capture_devices: captureDevices,
             local_ip: getLocalIp(),
             api_port: LOCAL_API_PORT,
             ndi_broadcast_active: !!(ndiSender && ndiSender.active),
             ndi_broadcast_name: ndiSender ? ndiSender.sourceName : null,
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
                    global.last_content_id = null; // switching away from direct content
                    // Clear wall crop — playlist assignment is not from a layout
                    global.last_wall_key = null;
                    global.current_crop = null;
                    if (mainWindow) mainWindow.webContents.send('set-crop', null);
                    fetchPlaylist();
                }
            } else if (cmd === 'load_content' && response.data.content_id) {
                if (response.data.content_id === global.last_content_id) {
                    // Same content already loaded — skip
                } else {
                    global.last_content_id = response.data.content_id;
                    global.last_playlist_hash = null;
                    // Clear wall crop — direct content is not from a layout
                    global.last_wall_key = null;
                    global.current_crop = null;
                    if (mainWindow) mainWindow.webContents.send('set-crop', null);
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
            } else if (cmd === 'show_ndi_wall') {
                // NDI stream wall — set crop first, then start NDI source
                const sourceName = response.data.source_name || response.data.ndi_source_name;
                const audioEnabled = response.data.audio_enabled !== undefined ? response.data.audio_enabled : true;
                const wallCrop = response.data.wall_crop;
                const wallKey = `ndi_${sourceName}_${JSON.stringify(wallCrop)}`;
                if (wallKey === global.last_wall_key) {
                    // Same NDI wall already active — skip
                } else {
                    global.last_wall_key = wallKey;
                    global.last_content_id = null;
                    global.last_playlist_hash = null;
                    if (wallCrop && mainWindow) {
                        const normCrop = {
                            x: wallCrop.x / wallCrop.canvas_w,
                            y: wallCrop.y / wallCrop.canvas_h,
                            w: wallCrop.w / wallCrop.canvas_w,
                            h: wallCrop.h / wallCrop.canvas_h,
                        };
                        console.log(`[NDI WALL] Setting crop: x=${normCrop.x.toFixed(3)} y=${normCrop.y.toFixed(3)} w=${normCrop.w.toFixed(3)} h=${normCrop.h.toFixed(3)}`);
                        mainWindow.webContents.send('set-crop', normCrop);
                    }
                    if (sourceName) {
                        console.log(`[NDI WALL] Starting NDI source: ${sourceName}`);
                        startNdiSource(sourceName, audioEnabled);
                    } else {
                        console.warn('[NDI WALL] show_ndi_wall but source_name is empty');
                    }
                }
            } else if (cmd === 'show_ndi') {
                const sourceName = response.data.source_name || response.data.ndi_source_name;
                const audioEnabled = response.data.audio_enabled !== undefined ? response.data.audio_enabled : true;
                console.log(`[NDI] show_ndi payload: source_name="${response.data.source_name}" resolved="${sourceName}"`);
                if (sourceName) {
                    startNdiSource(sourceName, audioEnabled);
                } else {
                    console.warn('[NDI] show_ndi received but source_name is empty — check DB ndi_source column');
                }
            } else if (cmd === 'hide_ndi') {
                const sourceName = response.data.source_name || response.data.ndi_source_name;
                if (sourceName) { stopNdiSource(sourceName); } else { stopAllNdiSources(); }
            } else if (['play', 'pause', 'next', 'previous', 'restart'].includes(cmd)) {
                if (mainWindow) mainWindow.webContents.send('control-command', cmd);
            }
        }

        // Video wall crop data — forwarded to renderer independently of commands
        // Skip when wall commands (load_wall_content / show_ndi_wall) handle crop themselves
        const cmd = response.data && response.data.command;
        if (cmd !== 'load_wall_content' && cmd !== 'show_ndi_wall') {
            if (response.data && response.data.crop) {
                if (JSON.stringify(response.data.crop) !== JSON.stringify(global.current_crop)) {
                    global.current_crop = response.data.crop;
                    if (mainWindow) mainWindow.webContents.send('set-crop', response.data.crop);
                }
            } else if (global.current_crop) {
                global.current_crop = null;
                if (mainWindow) mainWindow.webContents.send('set-crop', null);
            }
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
        global.last_wall_key = null;
        global.current_crop = null;
        if (mainWindow) mainWindow.webContents.send('set-crop', null);
        fetchPlaylist();
    } else if (cmd === 'load_content' && data.content_id) {
        global.last_content_id = data.content_id;
        global.last_playlist_hash = null;
        global.last_wall_key = null;
        global.current_crop = null;
        if (mainWindow) mainWindow.webContents.send('set-crop', null);
        console.log(`Loading direct content: ${data.content_id}`);
        loadSingleContent(data.content_id);
    } else if (cmd === 'show_capture') {
        if (mainWindow) mainWindow.webContents.send('start-capture', { deviceLabel: data.capture_device_label });
    } else if (cmd === 'hide_capture') {
        if (mainWindow) mainWindow.webContents.send('stop-capture');
    } else if (['play', 'pause', 'next', 'previous', 'restart'].includes(cmd)) {
        if (mainWindow) mainWindow.webContents.send('control-command', cmd);
    } else if (cmd === 'show_ndi') {
        const sourceName = data.source_name || data.ndi_source_name;
        const audioEnabled = data.audio_enabled !== undefined ? data.audio_enabled : true;
        if (sourceName) {
            startNdiSource(sourceName, audioEnabled);
        }
    } else if (cmd === 'hide_ndi') {
        const sourceName = data.source_name || data.ndi_source_name;
        if (sourceName) {
            stopNdiSource(sourceName);
        } else {
            stopAllNdiSources();
        }
    } else if (cmd === 'start_ndi_broadcast') {
        const sourceName = data.ndi_broadcast_name || `${config.player_id}-Capture`;
        startNdiSend(sourceName);
    } else if (cmd === 'stop_ndi_broadcast') {
        stopNdiSend();
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
        // Fetch metadata so we get the real filename, type, and extension
        const meta = await axios.get(`${config.cms_url}/api/v1/content/${contentId}`);
        const mockPlaylist = { items: [{ content_id: contentId, content: { filename: meta.data.filename, type: meta.data.type, url: meta.data.url } }] };
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
     const finalDurationsArray = [];
     const filesToProcess = [];

     for (const item of playlistData.items) {
         if (item.content_id) {
             const contentType = item.content?.type;

             // Template content: load render URL in iframe, no download needed
             if (contentType === 'template') {
                 // Always rewrite the host to config.cms_url so it's reachable from this machine,
                 // regardless of what host the server stored in the DB (may be localhost/Docker internal)
                 let renderUrl;
                 if (item.content?.url) {
                     try {
                         const storedUrl = new URL(item.content.url);
                         const cmsBase = config.cms_url.replace(/\/$/, '');
                         renderUrl = `${cmsBase}${storedUrl.pathname}`;
                     } catch (e) {
                         renderUrl = `${config.cms_url}/api/v1/content/${item.content_id}/stream`;
                     }
                 } else {
                     renderUrl = `${config.cms_url}/api/v1/content/${item.content_id}/stream`;
                 }
                 finalLocalPathsArray.push(`template::${renderUrl}`);
                 finalDurationsArray.push(item.duration || 10);
                 continue;
             }

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
             finalDurationsArray.push(item.duration || 0);  // 0 = auto

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
         // Aggressively clear old playlist so user immediately sees a change happened when downloading
         mainWindow.webContents.send('update-playlist', [], []);
     }

     // Background download missing files
     if (filesToProcess.length > 0) {
         const downloadFile = async (file, index) => {
             console.log(`[DOWNLOADING] ${file.filename} from ${file.remoteUrl}`);
             if (mainWindow) mainWindow.webContents.send('download-progress', { show: true, text: `Downloading ${index + 1} / ${filesToProcess.length}...`});

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
                     mainWindow.webContents.send('download-progress', { show: false });
                     mainWindow.webContents.send('update-playlist', [finalLocalPathsArray[0]], [finalDurationsArray[0]]);
                 }
                 initialPlaybackTriggered = true;
             }
         }

         if (mainWindow && !initialPlaybackTriggered) {
             // Fallback just in case
             mainWindow.webContents.send('download-progress', { show: false });
         }

         if (allSuccessful && mainWindow) {
             console.log("All downloads complete. Appending missing background layout seamlessly.");
             mainWindow.webContents.send('append-playlist', finalLocalPathsArray, finalDurationsArray);
         }
     } else {
         // All files are already cached, push instantly
         if (mainWindow) {
             mainWindow.webContents.send('download-progress', { show: false });
             mainWindow.webContents.send('update-playlist', finalLocalPathsArray, finalDurationsArray);
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
    });
}

app.whenReady().then(() => {
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
    stopAllNdiSources();
    stopNdiSend();
    if (process.platform !== 'darwin') app.quit();
});
