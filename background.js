// Screeners — service worker.
// Owns the capture pipeline: visible tab, full-page stitch, area selection.
// Large images are handed to the editor page via IndexedDB (lib/store.js).

import { putCapture, newCaptureId } from "./lib/store.js";

const CAPTURE_DELAY_MS = 600; // captureVisibleTab is rate-limited to ~2/sec

// ---------------------------------------------------------------- utilities

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isCapturableUrl(url = "") {
  return /^(https?|file):/.test(url);
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function openEditor(blob, meta = {}) {
  const id = newCaptureId();
  await putCapture(id, { blob, type: "image", createdAt: Date.now(), ...meta });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`editor/editor.html?id=${id}`),
  });
}

async function captureVisibleDataUrl(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

// ---------------------------------------------------------------- visible tab

async function captureVisible() {
  const tab = await activeTab();
  if (!tab || !isCapturableUrl(tab.url)) {
    return notifyError("This page can't be captured (browser-internal page).");
  }
  const dataUrl = await captureVisibleDataUrl(tab.windowId);
  const blob = await (await fetch(dataUrl)).blob();
  await openEditor(blob, { source: "visible", pageUrl: tab.url, title: tab.title });
}

// ---------------------------------------------------------------- full page
//
// Scroll-and-stitch with PIXEL MATCHING. Scroll position is only a hint:
// every frame is aligned by finding where its pixels overlap the already-
// stitched canvas (like panorama stitching). This survives sticky headers
// of any construction (shadow DOM, rebuilt-on-scroll), scroll-position
// corrections, and fractional devicePixelRatio.

async function captureFullPage() {
  const tab = await activeTab();
  if (!tab || !isCapturableUrl(tab.url)) {
    return notifyError("This page can't be captured (browser-internal page).");
  }

  // Find the element that actually scrolls. Many sites (and some layouts
  // that only appear at certain window sizes / zoom levels) scroll an inner
  // container rather than the document — in that case window.scrollY never
  // changes and a naive capture yields only the visible area.
  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const style = document.createElement("style");
      style.id = "__screeners_capture_style";
      style.textContent =
        "html::-webkit-scrollbar{display:none!important}" +
        "html{scrollbar-width:none!important;scroll-behavior:auto!important}" +
        "*{scroll-behavior:auto!important}" +
        "*{animation-play-state:paused!important}";
      (document.head || document.documentElement).appendChild(style);

      const vh = window.innerHeight;
      const doc = document.scrollingElement || document.documentElement;
      const docHeight = Math.max(
        doc.scrollHeight, document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0
      );

      // Does the document itself scroll?
      if (docHeight > vh + 4) {
        window.__screenersScroller = null; // means: use the window
        return { totalHeight: docHeight, viewportHeight: vh,
                 originalScrollY: window.scrollY, windowHeight: vh };
      }

      // Otherwise look for the tallest scrollable container filling the view
      let best = null, bestScore = 0;
      for (const el of document.querySelectorAll("body *")) {
        const cs = getComputedStyle(el);
        if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
        if (el.scrollHeight <= el.clientHeight + 4) continue;
        const r = el.getBoundingClientRect();
        if (r.height < vh * 0.5 || r.width < window.innerWidth * 0.5) continue;
        const score = el.scrollHeight;
        if (score > bestScore) { bestScore = score; best = el; }
      }
      if (best) {
        window.__screenersScroller = best;
        return { totalHeight: best.scrollHeight, viewportHeight: best.clientHeight,
                 originalScrollY: best.scrollTop, windowHeight: vh };
      }

      window.__screenersScroller = null;
      return { totalHeight: docHeight, viewportHeight: vh,
               originalScrollY: window.scrollY, usesContainer: false };
    },
  });

  const { totalHeight, viewportHeight, originalScrollY, windowHeight } = metrics;

  const scrollTo = (y) => chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (scrollY) => {
      const el = window.__screenersScroller;
      if (el) el.scrollTop = scrollY;
      else window.scrollTo(0, scrollY);
    },
    args: [y],
  });
  const getScrollY = async () => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = window.__screenersScroller;
        return el ? el.scrollTop : window.scrollY;
      },
    });
    return result;
  };
  const grabFrame = async () => {
    const dataUrl = await captureVisibleDataUrl(tab.windowId);
    return dataUrlToBitmap(dataUrl);
  };

  // Lazy-rendering pages (bank dashboards, virtualized lists) repaint rows
  // shortly after each scroll. A single capture can photograph the page
  // mid-repaint — garbling rows inside the frame itself. So: capture twice
  // and only accept the frame once two consecutive captures look identical.
  const cmpCanvas = new OffscreenCanvas(120, 200);
  const cmpCtx = cmpCanvas.getContext("2d", { willReadFrequently: true });
  const thumb = (bmp) => {
    cmpCtx.clearRect(0, 0, 120, 200);
    cmpCtx.drawImage(bmp, 0, 0, 120, 200);
    return cmpCtx.getImageData(0, 0, 120, 200).data;
  };
  const framesEqual = (a, b) => {
    let diff = 0, n = 0;
    for (let i = 0; i < a.length; i += 16) { diff += Math.abs(a[i] - b[i]); n++; }
    return diff / n < 2;
  };
  const grabStableFrame = async () => {
    let prev = await grabFrame();
    let prevT = thumb(prev);
    for (let i = 0; i < 3; i++) {
      await sleep(500); // respect capture rate limit + let repaints finish
      const next = await grabFrame();
      const nextT = thumb(next);
      if (framesEqual(prevT, nextT)) { next.close(); return prev; }
      prev.close();
      prev = next;
      prevT = nextT;
    }
    return prev; // still changing (e.g. animation) — use the latest
  };

  let canvas = null, ctx = null, W = 0, canvasH = 0;
  let B = 0;           // canvas rows painted so far (device px)
  let frameCanvas = null, fctx = null;

  const frameImageData = (bmp) => {
    if (!frameCanvas || frameCanvas.width !== bmp.width || frameCanvas.height !== bmp.height) {
      frameCanvas = new OffscreenCanvas(bmp.width, bmp.height);
      fctx = frameCanvas.getContext("2d", { willReadFrequently: true });
    }
    fctx.drawImage(bmp, 0, 0);
    return fctx.getImageData(0, 0, bmp.width, bmp.height).data;
  };

  // Pick a reference strip (N rows) from the stitched canvas, close to the
  // bottom, with enough pixel variance to be unambiguous (blank white rows
  // on e.g. banking pages would match everywhere).
  const STRIP = 24;
  function pickStrip() {
    const minS = Math.max(0, B - Math.round(canvasH * 0.4));
    for (let S = B - STRIP; S >= minS; S -= 8) {
      const d = ctx.getImageData(0, S, W, STRIP).data;
      let sum = 0, sumSq = 0, n = 0;
      for (let i = 1; i < d.length; i += 64) { // sample green channel
        sum += d[i]; sumSq += d[i] * d[i]; n++;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      if (variance > 40) return { S, data: d };
    }
    return null;
  }

  // Find the frame row where the strip matches best (sum of abs differences).
  function matchStrip(frame, H, strip, expected) {
    const xStep = 4 * 4, rowStep = 4;
    const evaluate = (r) => {
      let cost = 0, n = 0;
      for (let dy = 0; dy < STRIP; dy += rowStep) {
        const f = (r + dy) * W * 4, s = dy * W * 4;
        for (let x = 0; x < W * 4 - 4; x += xStep) {
          cost += Math.abs(frame[f + x] - strip[s + x])
                + Math.abs(frame[f + x + 1] - strip[s + x + 1])
                + Math.abs(frame[f + x + 2] - strip[s + x + 2]);
          n += 3;
        }
      }
      return cost / n;
    };
    const search = (lo, hi) => {
      let best = -1, bestCost = Infinity;
      for (let r = Math.max(0, lo); r <= Math.min(H - STRIP, hi); r++) {
        const c = evaluate(r);
        if (c < bestCost) { bestCost = c; best = r; }
      }
      return { best, bestCost };
    };
    // Search near the expected offset first; widen if the match is poor.
    let { best, bestCost } = search(expected - 250, expected + 250);
    if (bestCost > 6) {
      const full = search(0, H - STRIP);
      if (full.bestCost < bestCost) ({ best, bestCost } = full);
    }
    return bestCost <= 12 ? best : -1;
  }

  try {
    // ---- Frame 1
    await scrollTo(0);
    await sleep(CAPTURE_DELAY_MS);
    let bmp = await grabStableFrame();
    W = bmp.width;
    // Pixel scale comes from the WINDOW height (the capture is always the
    // full window), while scroll math uses the scroller's viewport height.
    const effDpr0 = bmp.height / (windowHeight || viewportHeight);
    canvasH = Math.min(Math.round(totalHeight * effDpr0), 40000);
    canvas = new OffscreenCanvas(W, canvasH);
    ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    B = bmp.height;
    bmp.close();

    // ---- Remaining frames
    let prevScroll = 0;
    let guard = 0;
    while (B < canvasH && guard++ < 200) {
      const effDpr = B > 0 ? (canvasH / totalHeight) : effDpr0;
      // Ask for ~35% overlap with what we've already stitched
      const target = Math.max(0, B / effDpr - viewportHeight * 0.35);
      await scrollTo(target);
      await sleep(CAPTURE_DELAY_MS);
      const actualY = await getScrollY();
      const atBottom = !(actualY > prevScroll);
      prevScroll = actualY;

      bmp = await grabStableFrame();
      const H = bmp.height;
      const frame = frameImageData(bmp);

      const strip = pickStrip();
      let fB; // frame row corresponding to canvas row B
      if (strip) {
        const expected = Math.round(strip.S - actualY * (H / (windowHeight || viewportHeight)));
        const r = matchStrip(frame, H, strip.data, expected);
        fB = r >= 0 ? r + (B - strip.S) : -1;
      } else {
        fB = -1;
      }
      if (fB < 0) {
        // No reliable pixel match (blank region / animation) — fall back to
        // scroll arithmetic for this frame.
        fB = Math.round(B - actualY * (H / (windowHeight || viewportHeight)));
      }
      fB = Math.max(0, Math.min(H, fB));

      const fresh = H - fB;
      if (fresh > 0) {
        const dh = Math.min(fresh, canvasH - B);
        ctx.drawImage(bmp, 0, fB, W, dh, 0, B, W, dh);
        B += dh;
      }
      bmp.close();

      if (atBottom || fresh <= 0) break; // can't scroll further / nothing new
    }
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (scrollY) => {
        document.getElementById("__screeners_capture_style")?.remove();
        const el = window.__screenersScroller;
        if (el) el.scrollTop = scrollY;
        else window.scrollTo(0, scrollY);
        delete window.__screenersScroller;
      },
      args: [originalScrollY],
    }).catch(() => {});
  }

  // Trim any unpainted rows at the bottom (page shorter than reported)
  let out = canvas;
  if (B < canvasH) {
    out = new OffscreenCanvas(W, B);
    out.getContext("2d").drawImage(canvas, 0, 0);
  }

  const blob = await out.convertToBlob({ type: "image/png" });
  await openEditor(blob, { source: "fullpage", pageUrl: tab.url, title: tab.title });
}

// ---------------------------------------------------------------- area select

async function startAreaSelection() {
  const tab = await activeTab();
  if (!tab || !isCapturableUrl(tab.url)) {
    return notifyError("This page can't be captured (browser-internal page).");
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content/selector.js"],
  });
}

async function captureArea(rect, sender) {
  // rect: { x, y, width, height, dpr } in CSS pixels of the visible viewport
  const windowId = sender.tab ? sender.tab.windowId : undefined;
  await sleep(150); // let the selection overlay fully disappear
  const dataUrl = await captureVisibleDataUrl(windowId);
  const bmp = await dataUrlToBitmap(dataUrl);

  const { x, y, width, height, dpr } = rect;
  const sx = Math.max(0, Math.round(x * dpr));
  const sy = Math.max(0, Math.round(y * dpr));
  const sw = Math.min(bmp.width - sx, Math.round(width * dpr));
  const sh = Math.min(bmp.height - sy, Math.round(height * dpr));
  if (sw < 1 || sh < 1) return;

  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  bmp.close();

  const blob = await canvas.convertToBlob({ type: "image/png" });
  await openEditor(blob, {
    source: "area",
    pageUrl: sender.tab?.url,
    title: sender.tab?.title,
  });
}

// ---------------------------------------------------------------- recorder

async function openRecorder() {
  await chrome.windows.create({
    url: chrome.runtime.getURL("recorder/recorder.html"),
    type: "popup",
    width: 480,
    height: 560,
  });
}

// ---------------------------------------------------------------- misc

function notifyError(message) {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
  console.warn("[Screeners]", message);
}

// ---------------------------------------------------------------- routing

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "CAPTURE_VISIBLE": await captureVisible(); break;
        case "CAPTURE_FULLPAGE":
          // Ack immediately so the popup can close without killing the message
          sendResponse({ ok: true });
          chrome.action.setBadgeText({ text: "…" });
          try {
            await captureFullPage();
          } finally {
            chrome.action.setBadgeText({ text: "" });
          }
          return;
        case "START_AREA_SELECT": await startAreaSelection(); break;
        case "AREA_SELECTED": await captureArea(msg.rect, sender); break;
        case "OPEN_RECORDER": await openRecorder(); break;
        default: return;
      }
      sendResponse({ ok: true });
    } catch (e) {
      console.error("[Screeners]", e);
      notifyError(e.message);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep the message channel open for async sendResponse
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-visible") captureVisible();
  else if (command === "capture-area") startAreaSelection();
  else if (command === "start-recording") openRecorder();
});
