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
| Copy image to clipboard (in editor) | `Ctrl/Cmd+C` |
| Undo (in editor) | `Ctrl/Cmd+Z` |
| Apply crop (in editor) | `Enter` |
| Cancel area selection | `Esc` |

> In the editor, `Ctrl/Cmd+C` copies the edited image (crop and annotations included). If you're typing in a field or have text selected, it copies the text as usual.

Customize shortcuts at `chrome://extensions/shortcuts`.

## Known limitations

- Chrome-internal pages (`chrome://…`, the Web Store) can't be captured — Chrome blocks this for all extensions.
- Full-page capture is deliberately unhurried: it pre-scrolls the page to trigger lazy-loaded content, then captures each frame twice to confirm the page has settled (Chrome also rate-limits captures). Expect several seconds on long pages — that's the cost of clean, correctly aligned output.
- Endless feeds (an infinite-scroll timeline with no bottom) are capped rather than captured forever. Profile and article pages capture in full.
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

## Changelog

### 1.0.5 — 2026-09-25

- **Fixed full-page capture on updated Chromium browsers.** Recent Chrome/Brave/Vivaldi/Edge builds throttle `captureVisibleTab` more aggressively and return the *previous* frame instead of erroring when called too quickly. Those stale frames were being stitched as if they were new, causing repeated headers and duplicated content.
  - Captures are retried with exponential backoff when the browser throttles.
  - Each frame is verified to differ from the last accepted one; a stale capture is discarded and re-requested.
  - Spacing between captures increased to stay inside the new throttle window.
- **Sticky headers can no longer be stitched twice.** The pinned bar is measured at each scroll position and enforced as a hard floor on the crop, so even if pixel matching is thrown off, the header band is never pasted into the image again.

### 1.0.4 — 2026-09-06

- **Full-page capture now handles lazy-loading and infinite-scroll pages** (LinkedIn profiles, feeds, dashboards). Before capturing, the extension scrolls through the page once to force content to render, then returns to the top — previously these pages captured only the first screen or two.
- **Page height is re-measured during capture** and the canvas grows with it, so content that loads mid-capture is included.
- Capture stops cleanly when scrolling stops advancing, and endless feeds are capped rather than running forever.

### 1.0.3 — 2026-08-31

- **Full-page capture now works on sites that scroll an inner container** instead of the document (previously it returned only the visible area on those layouts). The capture detects the real scrolling element, drives it directly, and restores its position afterward.
- Pixel scale is derived from the window height independently of the scroller, fixing alignment when a scrolling container is shorter than the window.

### 1.0.2 — 2026-08-30

- `Ctrl/Cmd+C` in the editor copies the image straight to the clipboard (skipped while typing in a field or when text is selected).

### 1.0.1 — 2026-08-28

- **Full-page capture rewritten** with pixel-matching stitching (panorama-style): sticky/fixed headers no longer repeat in the output, seams align even when sites adjust scroll position, and the bottom is trimmed when pages over-report their height.
- **Stable-frame capture**: each frame is captured twice and compared, so lazily rendered pages (dashboards, virtualized lists) no longer produce garbled rows mid-repaint. Full-page captures are a bit slower in exchange for accuracy.
- **Privacy tools in the editor**: blur, pixelate, and solid redact — drag an area or single-click to scramble a text-sized block.
- **Adjustable crop**: move the selection, resize from 8 handles, or type exact pixel width/height; Enter applies.
- **Region screen recording**: after picking what to share, drag on the live preview to record only that area.
- **Area selector** rendered in the browser top layer so page CSS can't misplace it; scroll position no longer affects where the selection starts.
- New icon set (16/48/128/512) generated from the refined logo.

### 1.0.0 — 2026-08-28

- Initial release: visible/area/full-page screenshots, editor with crop and annotations (pen, rectangle, ellipse, arrow, text), screen recording with mic/system audio, local save, clipboard copy, and Google Drive upload with per-user OAuth (account chooser, `drive.file` scope only).

## License

MIT
