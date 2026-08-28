<p align="center">
  <img src="icons/icon128.png" alt="Screeners logo" width="110" />
</p>

<h1 align="center">Screeners</h1>

<p align="center"><strong>Screenshot & screen recorder extension for Chrome.</strong><br>
Capture, crop, annotate, record — save locally or to your own Google Drive.</p>

---

## Features

- 🖥️ **Visible area screenshot** — capture what's on screen (`Alt+Shift+V`)
- ✂️ **Select area** — drag a rectangle over any part of the page (`Alt+Shift+A`)
- 📜 **Full page** — auto-scrolls and stitches the entire page into one image
- 🎨 **Editor** — crop (drag, resize with 8 handles, or type exact pixel dimensions), annotate with pen, rectangle, circle, arrow, and text, pick colors and stroke width, undo with `Ctrl/Cmd+Z`
- 🔒 **Privacy tools** — hide confidential info with 🌫️ blur, ▦ pixelate, or ⬛ solid redact: drag over an area, or just single-click on the sensitive spot for a quick block. *Tip: for text you truly need hidden, use pixelate or redact — heavy research shows light blur on text can sometimes be reversed.*
- 🎥 **Screen recording** (`Alt+Shift+R`) — record a tab, window, or your whole screen, **or drag a region on the live preview to record just that area**; optional microphone and system audio; saves as `.webm`
- 💾 **Save anywhere** — download to your computer, copy to clipboard, or upload to a `Screeners` folder in **your own** Google Drive

## Install

Until it's on the Chrome Web Store, install it in developer mode (takes a minute):

1. Download this repo: **Code → Download ZIP** and unzip it (or `git clone`).
2. Open `chrome://extensions` in Chrome (also works in Brave/Edge).
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the unzipped folder.
5. Pin Screeners to your toolbar: puzzle-piece icon → 📌 next to Screeners.

## How to use

### Screenshots

Click the Screeners icon and pick a capture mode — or use the keyboard shortcuts above. Every screenshot opens in the editor, where you can:

- **Crop** — click ✂️ Crop, drag a selection, then move it, resize it from the corner/edge handles, or type exact **W / H pixel values** in the toolbar. Press Enter or "Apply crop".
- **Annotate** — pick a tool (✏️ pen, ▭ rectangle, ◯ circle, ↗ arrow, 🅰 text), choose a color and stroke width, and draw right on the image. For text: click where you want it, type, press Enter.
- **Export** — 📋 Copy to clipboard, ⬇️ Save locally, or ☁️ Save to Google Drive. Rename the file in the toolbar first if you like.

### Screen recording

1. Click 🎥 **Record screen** in the popup (or `Alt+Shift+R`).
2. Choose the microphone / system-audio options, then pick what to share: a tab, a window, or the whole screen.
3. You'll see a **live preview**. Either click **⏺ Record full**, or drag a rectangle on the preview and click **⏺ Record selected region** to capture only that area.
4. Hit **■ Stop** (or end sharing from Chrome's bar). Preview the result, then save locally or upload to Drive.

> Keep the recorder window open while recording — behind other windows is fine, just don't minimize it.

### Google Drive (optional)

Local saving works out of the box. To enable Drive uploads:

1. Right-click the Screeners icon → **Options** (or click Options in the popup footer).
2. Click **Connect Google Drive…** and pick **your** Google account in Google's account chooser.
3. That's it — the ☁️ buttons now upload to a `Screeners` folder in your Drive.

**Your privacy:** every user connects their *own* Google account — nothing is shared with the developer or anyone else. The extension uses Google's narrow `drive.file` permission, meaning it can only see files it created itself, never the rest of your Drive. Disconnect anytime from Options (the token is revoked immediately). No analytics, no third-party servers — captures go only where you send them.

Don't want to use the built-in Google client? Paste your own OAuth Client ID under **Options → Advanced** (see [Developer setup](#developer-setup) below).

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Screenshot visible area | `Alt+Shift+V` |
| Select area | `Alt+Shift+A` |
| Open screen recorder | `Alt+Shift+R` |
| Undo (in editor) | `Ctrl/Cmd+Z` |
| Apply crop (in editor) | `Enter` |
| Cancel area selection | `Esc` |

Customize shortcuts at `chrome://extensions/shortcuts`.

## Known limitations

- Chrome-internal pages (`chrome://…`, the Web Store) can't be captured — Chrome blocks this for all extensions.
- Full-page capture takes ~0.6s per screen height (Chrome rate-limits captures); pages with sticky headers may repeat the header in the stitch.
- Recordings are WebM (VP9/VP8). Convert externally if you need MP4.

---

## Developer setup

Only needed if you're forking this repo or want your own Google OAuth client.

### Google Drive OAuth (one-time, free)

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **Google Auth Platform** → configure the consent screen: External, add scopes `https://www.googleapis.com/auth/drive.file` and `.../userinfo.email`. While in "Testing" status, add your account under **Test users**; publish to Production for public use.
4. **Clients → Create client** → type **Web application** → add authorized redirect URI:
   ```
   https://<YOUR_EXTENSION_ID>.chromiumapp.org/
   ```
5. Put the client ID in `config.js` (`DEFAULT_GOOGLE_CLIENT_ID`) or in the extension's Options page.

### About the private key

The extension ID is pinned by the public `"key"` field in `manifest.json`. The matching **private key must never live inside the extension folder or the repo** — keep it elsewhere on your machine. You only need it once more: to preserve the extension ID on the first Chrome Web Store upload, include it in the zip root named `key.pem`, then remove it. Never commit it.

### Project layout

```
manifest.json          MV3 manifest (pinned extension ID via "key")
config.js              OAuth client ID + Drive settings
background.js          Service worker: capture pipeline, commands, routing
content/selector.js    Drag-to-select overlay (top-layer dialog)
popup/                 Toolbar popup
editor/                Screenshot editor (crop, annotate, export)
recorder/              Screen recorder (full or region via canvas crop)
options/               Drive connect/disconnect, custom client ID
lib/store.js           IndexedDB handoff for large captures
lib/drive.js           OAuth (account chooser) + Drive multipart upload
icons/                 Extension icons (512px source included for store listing)
```

## License

MIT
