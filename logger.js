// logger.js — minimal file logger for the main process.
//
// The player normally runs as a packaged (NSIS) app with no console attached,
// so console.log/warn/error output is lost. This writes timestamped lines to a
// rotating log file under the user-data directory so failures — e.g. the NDI or
// DeckLink native addon failing to load — can be diagnosed after the fact. It
// also mirrors to the console so `npm start` development output is unchanged.
//
// Safe to require before the app 'ready' event: app.getPath('userData') is
// valid early, and every logging operation is wrapped so a logging failure can
// never crash the player.

const path = require('path');
const fs = require('fs');
const os = require('os');

let app = null;
try { app = require('electron').app; } catch (_) { /* not an Electron main process */ }

const MAX_BYTES = 5 * 1024 * 1024; // rotate after 5 MB, keeping one backup (.1)
let logPath = null;
let initialized = false;

function resolveLogPath() {
    let base = null;
    try {
        if (app && app.getPath) base = app.getPath('userData');
    } catch (_) { /* getPath can throw very early — fall back below */ }
    if (!base) base = path.join(os.tmpdir(), 'cmx-player');
    return path.join(base, 'logs', 'cmx-player.log');
}

function init() {
    if (initialized) return;
    initialized = true;
    try {
        logPath = resolveLogPath();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
    } catch (_) {
        logPath = null; // file logging disabled; console mirror still works
    }
}

function rotateIfNeeded() {
    if (!logPath) return;
    try {
        const { size } = fs.statSync(logPath);
        if (size > MAX_BYTES) fs.renameSync(logPath, logPath + '.1'); // overwrites old backup
    } catch (_) { /* file may not exist yet, or a rename raced — ignore */ }
}

function stringify(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    try { return JSON.stringify(arg); } catch (_) { return String(arg); }
}

function write(level, args) {
    init();
    const line = `${new Date().toISOString()} [${level}] ${args.map(stringify).join(' ')}`;

    // Mirror to console for development runs.
    const sink = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    sink(line);

    if (!logPath) return;
    try {
        rotateIfNeeded();
        fs.appendFileSync(logPath, line + '\n');
    } catch (_) { /* never let logging crash the caller */ }
}

function info(...args) { write('INFO', args); }
function warn(...args) { write('WARN', args); }
function error(...args) { write('ERROR', args); }

function getLogPath() {
    init();
    return logPath;
}

module.exports = { info, warn, error, getLogPath };
