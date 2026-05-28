# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CMX Windows Player is an Electron-based digital signage player for Windows that receives playlists and commands from a CMS (Content Management System) over HTTP APIs. The player handles video/image playback, capture card input, video wall cropping, and includes a local REST API for third-party control.

**Key Technologies:**
- Electron 28.0.0 (main + renderer process architecture)
- Express.js (local REST API on port 8081)
- Axios (HTTP client for CMS communication)
- Node.js 20+
- Windows 10/11 target platform

## Architecture

### Process Model
- **Main Process** (`main.js`): Electron app lifecycle, CMS communication, IPC coordination, local Express API
- **Renderer Process** (`renderer.js`): DOM manipulation, media playback logic, user input handling
- **Preload Script** (`preload.js`): IPC bridge using contextBridge for secure main↔renderer communication

### Data Flow

1. **Enrollment & Registration:**
   - Player requests enrollment code from CMS (`/api/v1/players/enroll/request`)
   - Polls for approval status (`/api/v1/players/enroll/{code}/status`)
   - Once approved, saves `player_id` to `config.json` in user data directory

2. **Playlist & Content Management:**
   - Heartbeat loop (every 500ms) checks CMS for commands via `/api/v1/players/{player_id}/heartbeat`
   - CMS can push `load_playlist`, `load_content`, `load_wall_content`, `show_capture`, `hide_capture`, or playback control commands
   - Playlist items are downloaded and cached locally in `{userData}/cache/` directory
   - Offline fallback: cached playlist stored in `offline_playlist.json` for network outages

3. **IPC Channels** (Renderer ↔ Main):
   - `prompt-cms-url` / `submit-cms-url` - Setup/configuration
   - `show-enrollment-code` / `hide-enrollment-code` - Registration UI
   - `update-playlist` / `append-playlist` - Content updates
   - `control-command` - Playback controls (play, pause, next, previous, restart)
   - `start-capture` / `stop-capture` - Capture card control
   - `set-crop` - Video wall crop region (normalized 0.0–1.0 coordinates)
   - `download-progress` / `memory-error` - Status messages
   - `get-capture-devices` - Query available capture devices (ipcMain.handle)

### Cache Management
- **Location:** `{userData}/cache/`
- **Size limit:** 50 GB hard cap; prevents new downloads if exceeded
- **Garbage collection:** LRU-based cleanup keeps current playlist + up to 1000 unassigned cached files
- **File extensions supported:** .mp4, .webm, .mkv, .avi, .mov (videos); .png, .jpg, .jpeg, .gif, .webp, .bmp, .svg (images)

### Playback Logic
- **Dual video players (playerA/playerB):** Seamless switching via opacity transitions
- **Image handling:** Images trigger timeout (10s default) before advancing
- **Video wall cropping:** Canvas-based pixel cropping for specific regions of video/image
- **Capture card:** Shows live media input stream, pauses playlist during capture
- **Preloading:** Hidden player pre-buffers next video while active player plays current

### REST API (Local, port 8081)

**Playback Control:**
- `POST /api/play`, `/api/pause`, `/api/restart` - Direct playback commands
- `POST /api/sys-reboot` - System reboot via `shutdown /r /t 0`

**Preview Streaming:**
- `GET /api/preview/stream` - MJPEG stream (3 FPS, 640×360, quality 50)
- `GET /api/preview/snapshot` - Single JPEG frame
- `GET /api/preview/config` - Preview configuration metadata

**Capture Card:**
- `GET /api/capture/devices` - List available video input devices
- `POST /api/capture/start` - Start capture (deviceId, width, height in body)
- `POST /api/capture/stop` - Stop capture, resume playlist

**Device Info:**
- `GET /api/device` - System metadata (IP, MAC, disk space, memory, cache size, NDI support flags)

## Commands

### Development
```bash
npm install              # Install dependencies
npm start               # Run Electron app in development mode
npm run build           # Build Windows NSIS installer to dist/
```

### Build Configuration
The app uses electron-builder with these settings:
- **appId:** `com.antigravity.cmxplayer`
- **productName:** `CMX Player`
- **Target:** Windows NSIS installer
- **Entry point:** `main.js`

## Key Configuration Files

**`main.js` - Configuration object (lines 21-24):**
```javascript
let config = {
    cms_url: '',      // CMS server URL (http://ip:port or similar)
    player_id: null   // Set after enrollment approval
};
```
- Loaded from/saved to `{userData}/config.json`
- Update `cms_url` in setup overlay when player starts without config

**`package.json`:**
- Version: 2.3.0
- Main entry: `main.js`
- Dependencies: axios, cors, eventsource, express
- Dev dependencies: electron, electron-builder

## Important Implementation Details

### Heartbeat & Command Deduplication
- Heartbeat polls every 500ms with `playlist_hash` or `content_id` to avoid redundant operations
- Uses `global.last_playlist_hash`, `global.last_content_id`, `global.last_wall_key` to skip duplicate commands
- `global.boot_cache_loaded` flag prevents race conditions on startup

### Offline Mode
- If network fails and `boot_cache_loaded` is false, falls back to `offline_playlist.json`
- Cached files are never deleted unless garbage collection exceeds limits or player is deleted in CMS

### Error Handling
- Failed enrollments retry every 10 seconds
- If CMS returns 404 on heartbeat, player was deleted → clears config and prompts for new CMS URL
- Memory errors show overlay when cache exceeds 50 GB
- Capture errors handled with user-friendly messages (device not found, in use, permissions)

### Video Wall Cropping
- CMS sends `crop` in heartbeat: `{ x, y, w, h, canvas_w, canvas_h }`
- Renderer normalizes to 0.0–1.0 range before rendering
- Canvas-based drawing ensures exact pixel-level cropping for both video and images

## File Structure

```
.
├── main.js              # Electron main process (515 lines)
├── renderer.js          # Renderer/DOM logic (480 lines)
├── preload.js           # IPC bridge (19 lines)
├── api.js               # Express REST API (231 lines)
├── index.html           # UI template
├── cmx_player_js.js     # Legacy/utility code (49 lines)
├── package.json         # Dependencies & build config
├── openapi.json         # API schema (external reference)
├── cmxPlayer.code-workspace  # VS Code workspace settings
├── README.md            # User documentation
└── .gitignore
```

## Development Notes

- **Context Isolation:** Enabled (`contextIsolation: true`), no direct nodeIntegration
- **Security:** Preload script uses contextBridge to expose only necessary IPC methods
- **Kiosk Mode:** App starts fullscreen, always-on-top, with auto-hidden menu bar
- **No Test Framework:** Current project has no automated tests; consider adding Jest or Mocha if testing is needed

