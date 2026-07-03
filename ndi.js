// ndi.js — NDI receive via the `grandiose` native addon.
//
// Discovers NDI sources on the network and receives video frames from a chosen
// source in the main process, emitting them to a caller-supplied `onFrame`
// callback (forwarded to the renderer over a MessagePort — see main.js).
//
// The addon and the NDI runtime DLL may be absent. In that case this module
// degrades to an unavailable no-op so the rest of the player is unaffected.

const path = require('path');
const fs = require('fs');

let grandiose = null;
let available = false;

function prepRuntimePath() {
    const candidates = [];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ndi'));
    candidates.push(path.join(__dirname, 'runtime', 'ndi'));
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
    grandiose = require('grandiose');
    available = true;
    console.log('[NDI] grandiose loaded — NDI receive available');
} catch (err) {
    console.warn('[NDI] grandiose unavailable — NDI receive disabled:', err.message);
}

let finder = null;
let discoveryTimer = null;
let cachedRaw = [];       // original grandiose source objects (for receive)
let cachedSources = [];   // mapped, safe-to-serialize summaries (for heartbeat/API)
let receiver = null;
let receiving = false;

function mapSource(s) {
    return { kind: 'ndi', name: s.name, urlAddress: s.urlAddress || null };
}

// Refresh the source cache. Supports both the finder-class API and the one-shot
// find() API across grandiose forks. Runs on an interval so the 500ms heartbeat
// never blocks on discovery.
async function refreshSources() {
    if (!available) return;
    try {
        if (typeof grandiose.GrandioseFinder === 'function') {
            if (!finder) finder = new grandiose.GrandioseFinder({ showLocalSources: true });
            const srcs = (finder.getCurrentSources && finder.getCurrentSources()) || [];
            cachedRaw = srcs;
            cachedSources = srcs.map(mapSource);
        } else if (typeof grandiose.find === 'function') {
            const srcs = await grandiose.find({ showLocalSources: true }, 2000);
            cachedRaw = srcs || [];
            cachedSources = cachedRaw.map(mapSource);
        }
    } catch (err) {
        // Keep the previous cache on transient discovery errors.
        console.error('[NDI] source discovery failed:', err.message);
    }
}

function startDiscovery() {
    if (!available || discoveryTimer) return;
    refreshSources();
    discoveryTimer = setInterval(refreshSources, 15000);
}

function isAvailable() {
    return available;
}

function listSources() {
    return cachedSources;
}

function resolveBandwidth(name) {
    if (!available) return undefined;
    if (name === 'lowest') return grandiose.BANDWIDTH_LOWEST;
    return grandiose.BANDWIDTH_HIGHEST;
}

// Start receiving from a named source. `onFrame` receives
// { format:'BGRA', width, height, rowBytes, data } where data is a Node Buffer.
async function start(config, onFrame) {
    if (!available) throw new Error('NDI not available');
    await stop();

    const sourceName = config && config.sourceName;
    let source = cachedRaw.find(s => s.name === sourceName);
    if (!source && sourceName) source = { name: sourceName };
    if (!source) throw new Error('No NDI source specified');

    receiver = await grandiose.receive({
        source,
        colorFormat: grandiose.COLOR_FORMAT_BGRX_BGRA,
        bandwidth: resolveBandwidth(config && config.bandwidth),
        allowVideoFields: false,
    });
    receiving = true;

    (async () => {
        let consecutiveErrors = 0;
        while (receiving && receiver) {
            let frame;
            try {
                frame = await receiver.video(2000);
                consecutiveErrors = 0;
            } catch (err) {
                // Timeout / source vanished — tolerate a few, then give up so we
                // don't spin or freeze on a dead source.
                if (!receiving) break;
                if (++consecutiveErrors > 5) {
                    console.error('[NDI] receive stopped after repeated errors:', err.message);
                    break;
                }
                continue;
            }
            if (!receiving) break;
            if (frame && frame.type === 'video' && frame.data) {
                try {
                    onFrame({
                        format: 'BGRA',
                        width: frame.xres,
                        height: frame.yres,
                        rowBytes: frame.lineStrideBytes,
                        data: frame.data,
                    });
                } catch (err) {
                    console.error('[NDI] onFrame handler failed:', err.message);
                }
            }
        }
        receiving = false;
    })();

    return { sourceName: source.name };
}

async function stop() {
    receiving = false;
    // grandiose disconnects the receiver on garbage collection; drop the ref.
    receiver = null;
}

module.exports = { isAvailable, listSources, start, stop, startDiscovery };
