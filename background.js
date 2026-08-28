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

async function captureFullPage() {
  const tab = await activeTab();
  if (!tab || !isCapturableUrl(tab.url)) {
    return notifyError("This page can't be captured (browser-internal page).");
  }

  // 1. Read page metrics + prepare page (hide scrollbar, remember scroll pos)
  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const doc = document.documentElement;
      const style = document.createElement("style");
      style.id = "__screeners_capture_style";
      style.textContent =
        "html::-webkit-scrollbar{display:none!important}" +
        "html{scrollbar-width:none!important;scroll-behavior:auto!important}" +
        "*{animation-play-state:paused!important}";
      (document.head || document.documentElement).appendChild(style);
      return {
        totalHeight: Math.max(doc.scrollHeight, document.body?.scrollHeight || 0),
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        dpr: window.devicePixelRatio,
        originalScrollY: window.scrollY,
      };
    },
  });

  const { totalHeight, viewportHeight, viewportWidth, dpr, originalScrollY } = metrics;
  const MAX_HEIGHT_PX = 40000; // canvas safety cap
  const cappedHeight = Math.min(totalHeight, MAX_HEIGHT_PX / dpr);
  const steps = [];
  for (let y = 0; y < cappedHeight; y += viewportHeight) {
    steps.push(Math.min(y, cappedHeight - viewportHeight));
  }
  const uniqueSteps = [...new Set(steps.map((y) => Math.max(0, Math.round(y))))];

  const canvas = new OffscreenCanvas(
    Math.round(viewportWidth * dpr),
    Math.round(cappedHeight * dpr)
  );
  const ctx = canvas.getContext("2d");

  try {
    for (const y of uniqueSteps) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scrollY) => window.scrollTo(0, scrollY),
        args: [y],
      });
      await sleep(CAPTURE_DELAY_MS); // let layout settle + respect rate limit
      const dataUrl = await captureVisibleDataUrl(tab.windowId);
      const bmp = await dataUrlToBitmap(dataUrl);
      // The last step may overlap the previous one; drawing at y*dpr is
      // correct because we scrolled to exactly y.
      ctx.drawImage(bmp, 0, Math.round(y * dpr));
      bmp.close();
    }
  } finally {
    // Restore the page regardless of errors
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (scrollY) => {
        document.getElementById("__screeners_capture_style")?.remove();
        window.scrollTo(0, scrollY);
      },
      args: [originalScrollY],
    }).catch(() => {});
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
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
  // Popup may already be closed; badge is a lightweight fallback signal.
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
          // Ack immediately so the popup can close without killing the message;
          // the capture then runs to completion in the worker.
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
