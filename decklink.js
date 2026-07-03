// decklink.js — Blackmagic DeckLink capture via the `macadam` native addon.
//
// Chromium's getUserMedia stack cannot reliably drive DeckLink/WDM devices, so
// professional capture (e.g. the DeckLink Quad HDMI Recorder, whose 4 HDMI
// inputs enumerate as 4 separate devices) goes through the DeckLink SDK here in
// the main process. Frames are emitted to a caller-supplied `onFrame` callback
// and forwarded to the renderer over a MessagePort (see main.js).
//
// macadam does NOT auto-detect the incoming signal format, so capture must be
// started with the correct display mode. When no mode is specified we probe a
// prioritized list of common HDMI formats until one delivers a frame, and cache
// the winner per device for instant restarts.
//
// The addon and the Blackmagic Desktop Video runtime may be absent on a given
// machine. In that case this module degrades to an unavailable no-op so the
// rest of the player is completely unaffected.

const path = require('path');
const fs = require('fs');

let macadam = null;
let available = false;

// Prepend the bundled Desktop Video runtime folder to PATH before requiring the
// addon, so its dependent DLLs resolve in a packaged build (resourcesPath) as
// well as in development (__dirname).
function prepRuntimePath() {
    const candidates = [];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'decklink'));
    candidates.push(path.join(__dirname, 'runtime', 'decklink'));
    for (const dir of candidates) {
        try {
            if (fs.existsSync(dir)) {
                process.env.PATH = dir + path.delimiter + process.env.PATH;
                return;
            }
        } catch (_) { /* ignore */ }
    }
}

try {
    prepRuntimePath();
    macadam = require('macadam');
    available = true;
    console.log('[DECKLINK] macadam loaded — DeckLink capture available');
} catch (err) {
    console.warn('[DECKLINK] macadam unavailable — DeckLink capture disabled:', err.message);
}

let activeCapture = null;
let capturing = false;

// Last display mode that produced frames, per deviceIndex — probed first on restart.
const lastWorkingMode = new Map();

// Probe order for unknown HDMI signals: most common consumer/pro formats first.
// Names map to macadam bmd constants; missing constants are skipped.
const PROBE_MODE_NAMES = [
    'bmdModeHD1080p6000', 'bmdModeHD1080p5994', 'bmdModeHD1080p50',
    'bmdModeHD1080p30', 'bmdModeHD1080p2997', 'bmdModeHD1080p25', 'bmdModeHD1080p24', 'bmdModeHD1080p2398',
    'bmdMode4K2160p30', 'bmdMode4K2160p2997', 'bmdMode4K2160p25', 'bmdMode4K2160p5994', 'bmdMode4K2160p50',
    'bmdModeHD720p60', 'bmdModeHD720p5994', 'bmdModeHD720p50',
    'bmdModeHD1080i6000', 'bmdModeHD1080i5994', 'bmdModeHD1080i50',
];

const FIRST_FRAME_TIMEOUT_MS = 2000;

function isAvailable() {
    return available;
}

// Enumerate connected DeckLink devices. Each HDMI input on a Quad HDMI Recorder
// appears as its own device, so the array index is the `deviceIndex` used to
// start capture. Includes the device's supported input display modes so the
// CMS/API can offer an explicit format instead of relying on auto-probe.
function listSources() {
    if (!available) return [];
    try {
        const infos = macadam.getDeviceInfo() || [];
        return infos.map((info, index) => ({
            kind: 'decklink',
            deviceIndex: index,
            label: info.modelName || info.displayName || `DeckLink ${index}`,
            displayName: info.displayName || info.modelName || `DeckLink ${index}`,
            inputDisplayModes: (info.inputDisplayModes || info.displayModes || []).map(m => ({
                name: m.name,
                width: m.width,
                height: m.height,
                frameRate: m.frameRate,
            })),
        }));
    } catch (err) {
        console.error('[DECKLINK] listSources failed:', err.message);
        return [];
    }
}

// Resolve a user/CMS-supplied display mode to a macadam bmd constant.
// Accepts a raw number, a constant name ('bmdModeHD1080p6000'), or a short
// name ('1080p60', '2160p25', '1080i50', '720p5994'...).
function resolveDisplayMode(value) {
    if (!available || value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') return value;
    const str = String(value).trim();
    if (typeof macadam[str] === 'number') return macadam[str];
    // Short form: 1080p60 -> bmdModeHD1080p6000 (also try direct suffix match)
    const m = str.match(/^(\d{3,4})(p|i)(\d{2,4})$/i);
    if (m) {
        const lines = m[1];
        const scan = m[2].toLowerCase();
        let rate = m[3];
        // 60 -> 6000, 59.94 shorthand 5994 stays as-is
        if (rate.length === 2) rate = rate + '00';
        const prefix = lines === '2160' ? 'bmdMode4K' : (lines === '720' || lines === '1080') ? 'bmdModeHD' : 'bmdMode';
        const candidates = [
            `${prefix}${lines}${scan}${rate}`,
            `${prefix}${lines}${scan}${m[3]}`, // e.g. p50 has no trailing zeros
        ];
        for (const c of candidates) {
            if (typeof macadam[c] === 'number') return macadam[c];
        }
    }
    console.warn(`[DECKLINK] Unknown display mode "${str}" — falling back to auto-probe`);
    return null;
}

function modeName(mode) {
    if (!available) return String(mode);
    for (const key of Object.keys(macadam)) {
        if (key.startsWith('bmdMode') && macadam[key] === mode) return key;
    }
    return String(mode);
}

// Build the ordered list of display modes to try for a device.
function buildProbeList(deviceIndex, requestedMode) {
    const modes = [];
    const push = (m) => { if (typeof m === 'number' && !modes.includes(m)) modes.push(m); };
    push(requestedMode);
    push(lastWorkingMode.get(deviceIndex));
    for (const name of PROBE_MODE_NAMES) push(macadam[name]);
    return modes;
}

// Wait for the first frame from a capture, or time out.
function firstFrameOrTimeout(capture, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; resolve(null); }
        }, timeoutMs);
        capture.frame().then((frame) => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(frame); }
        }).catch(() => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
        });
    });
}

// Start capturing from a device. `onFrame` receives
// { format, width, height, rowBytes, data } where data is a Node Buffer of raw
// pixels. bmdFormat8BitYUV delivers UYVY 4:2:2.
//
// If config.displayMode is not given (or doesn't match the signal), a probe
// list of common HDMI formats is tried until one yields a frame within
// FIRST_FRAME_TIMEOUT_MS. Throws if no format produces frames (no signal or
// unsupported format) so the caller can surface the error on the overlay.
async function start(config, onFrame) {
    if (!available) throw new Error('DeckLink not available');
    await stop();

    const deviceIndex = Number.isInteger(config && config.deviceIndex) ? config.deviceIndex : 0;
    const pixelFormat = (config && config.pixelFormat) || macadam.bmdFormat8BitYUV;
    const requestedMode = resolveDisplayMode(config && config.displayMode);
    const probeList = buildProbeList(deviceIndex, requestedMode);

    let capture = null;
    let firstFrame = null;
    let usedMode = null;

    for (const mode of probeList) {
        try {
            capture = await macadam.capture({ deviceIndex, displayMode: mode, pixelFormat });
        } catch (err) {
            // Device busy / mode unsupported — try the next one.
            capture = null;
            continue;
        }
        const frame = await firstFrameOrTimeout(capture, FIRST_FRAME_TIMEOUT_MS);
        if (frame && frame.video && frame.video.data) {
            firstFrame = frame;
            usedMode = mode;
            console.log(`[DECKLINK] Device ${deviceIndex} locked on ${modeName(mode)}`);
            break;
        }
        try { await capture.stop(); } catch (_) { /* ignore */ }
        capture = null;
    }

    if (!capture) {
        lastWorkingMode.delete(deviceIndex);
        throw new Error(`No signal detected on DeckLink input ${deviceIndex} (tried ${probeList.length} formats)`);
    }

    lastWorkingMode.set(deviceIndex, usedMode);
    activeCapture = capture;
    capturing = true;

    const emit = (frame) => {
        if (frame && frame.video && frame.video.data) {
            try {
                onFrame({
                    format: 'UYVY',
                    width: frame.video.width,
                    height: frame.video.height,
                    rowBytes: frame.video.rowBytes,
                    data: frame.video.data,
                });
            } catch (err) {
                console.error('[DECKLINK] onFrame handler failed:', err.message);
            }
        }
    };

    emit(firstFrame);

    // Pull frames in the background; hand each to onFrame. On error (e.g. signal
    // loss or format change) we stop the loop rather than hang.
    (async () => {
        while (capturing && activeCapture) {
            let frame;
            try {
                frame = await activeCapture.frame();
            } catch (err) {
                if (capturing) console.error('[DECKLINK] frame error:', err.message);
                break;
            }
            if (!capturing) break;
            emit(frame);
        }
        capturing = false;
    })();

    return { deviceIndex, displayMode: usedMode, displayModeName: modeName(usedMode), pixelFormat };
}

async function stop() {
    capturing = false;
    if (activeCapture) {
        try { await activeCapture.stop(); } catch (_) { /* ignore */ }
        activeCapture = null;
    }
}

module.exports = { isAvailable, listSources, start, stop };
