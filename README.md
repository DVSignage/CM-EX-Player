# CMX Windows Player

Electron-based digital signage player for Windows with NDI support.

## Features

- **Content playback** - Video, images, and templates
- **NDI receive/send** - Network Device Interface integration for video I/O
- **WebSocket API** - Real-time control and status updates
- **Auto-enrollment** - Automatic player registration with the CMS
- **Content caching** - Local caching for reliable offline playback

## Requirements

- Node.js 20+
- Windows 10/11
- NDI Runtime (optional, for NDI features)

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure your CMS URL in `main.js`:
   ```javascript
   cms_url: 'https://your-cms-server.com'
   ```

3. Start the player:
   ```bash
   npm start
   ```

## Building Installer

```bash
npm run rebuild && npm run build
```

This produces a `.exe` installer in the `dist/` directory.

## NDI Support

NDI features require the **NDI Runtime Tools** from [ndi.video](https://ndi.video). Without it, the player works normally without NDI capabilities.
