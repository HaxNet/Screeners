// Screeners — service worker.
// Owns the capture pipeline: visible tab, full-page stitch, area selection.
// Large images are handed to the editor page via IndexedDB (lib/store.js).

import { putCapture, newCaptureId } from "./lib/store.js";

// captureVisibleTab is rate-limited (~2/sec, tightened further in recent
// Chrome builds). Going faster returns stale frames instead of fresh ones.
const CAPTURE_DELAY_MS = 750;

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
// Generic full-page capture that works across very different sites:
//
//  1. SCROLLER DETECTION — some pages scroll the document, others scroll an
//     inner container. We drive whichever one actually moves.
//  2. LAZY-LOAD PRE-PASS — infinite/lazy pages (LinkedIn, feeds, dashboards)
//     only render content as you approach it. We scroll through the page once
//     to force rendering, then return to the top before capturing.
//  3. DYNAMIC HEIGHT — page height is re-measured during capture (it grows on
//     lazy pages), and the canvas grows with it.
//  4. PIXEL-MATCH STITCHING — each frame is aligned by matching its pixels to
//     the stitched image, so sticky headers never repeat and seams stay tight.
//  5. STABLE FRAMES — each frame is captured twice and compared so we never
//     photograph a page mid-repaint.

async function captureFullPage() {
  const tab = await activeTab();
  if (!tab || !isCapturableUrl(tab.url)) {
    return notifyError("This page can't be captured (browser-internal page).");
  }

  const run = (func, args = []) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args })
      .then(([r]) => r?.result);

  // ---- 1. Prepare page + find the real scrolling element
  const init = await run(() => {
    const style = document.createElement("style");
    style.id = "__screeners_capture_style";
    style.textContent =
      "html::-webkit-scrollbar{display:none!important}" +
      "html{scrollbar-width:none!important}" +
      "*{scroll-behavior:auto!important;animation-play-state:paused!important}";
    (document.head || document.documentElement).appendChild(style);

    const vh = window.innerHeight;
    const doc = document.scrollingElement || document.documentElement;
    const docH = Math.max(doc.scrollHeight,
      document.documentElement.scrollHeight, document.body?.scrollHeight || 0);

    if (docH > vh + 4) {
      window.__screenersScroller = null;
      return { viewportHeight: vh, windowHeight: vh, originalScrollY: window.scrollY };
    }
    let best = null, bestH = 0;
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 4) continue;
      const r = el.getBoundingClientRect();
      if (r.height < vh * 0.5 || r.width < window.innerWidth * 0.5) continue;
      if (el.scrollHeight > bestH) { bestH = el.scrollHeight; best = el; }
    }
    window.__screenersScroller = best;
    return {
      viewportHeight: best ? best.clientHeight : vh,
      windowHeight: vh,
      originalScrollY: best ? best.scrollTop : window.scrollY,
    };
  });

  const { viewportHeight, windowHeight, originalScrollY } = init;

  const scrollTo = (y) => run((v) => {
    const el = window.__screenersScroller;
    if (el) el.scrollTop = v; else window.scrollTo(0, v);
  }, [y]);

  const readState = () => run(() => {
    const el = window.__screenersScroller;
    const doc = document.scrollingElement || document.documentElement;
    return {
      y: el ? el.scrollTop : window.scrollY,
      height: el ? el.scrollHeight
        : Math.max(doc.scrollHeight, document.documentElement.scrollHeight,
                   document.body?.scrollHeight || 0),
    };
  });

  // Recent Chrome builds throttle captureVisibleTab harder: calling it too
  // soon either throws MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND or hands back
  // the PREVIOUS frame. A stale frame silently corrupts the stitch (repeated
  // headers, duplicated bands), so every capture is retried on error and
  // verified to be genuinely new before it is used.
  const grabFrame = async () => {
    let wait = 350;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await dataUrlToBitmap(await captureVisibleDataUrl(tab.windowId));
      } catch (e) {
        if (attempt === 4) throw e;
        await sleep(wait);
        wait = Math.min(wait * 2, 2000); // back off through the throttle window
      }
    }
  };

  // Compare downscaled thumbnails so we only accept settled, non-stale frames
  const cmp = new OffscreenCanvas(120, 200);
  const cmpCtx = cmp.getContext("2d", { willReadFrequently: true });
  const thumb = (bmp) => {
    cmpCtx.clearRect(0, 0, 120, 200);
    cmpCtx.drawImage(bmp, 0, 0, 120, 200);
    return cmpCtx.getImageData(0, 0, 120, 200).data;
  };
  const diffOf = (a, b) => {
    let diff = 0, n = 0;
    for (let i = 0; i < a.length; i += 16) { diff += Math.abs(a[i] - b[i]); n++; }
    return diff / n;
  };
  const same = (a, b) => diffOf(a, b) < 2;

  // `staleRef` is the thumbnail of the previously ACCEPTED frame. After a
  // scroll the new frame must differ from it; if it doesn't, the browser
  // returned a cached capture and we wait and ask again.
  const grabStableFrame = async (staleRef = null) => {
    for (let round = 0; round < 4; round++) {
      let prev = await grabFrame(), prevT = thumb(prev);
      let settled = false;
      for (let i = 0; i < 2; i++) {
        await sleep(450);
        const next = await grabFrame(), nextT = thumb(next);
        if (same(prevT, nextT)) { next.close(); settled = true; break; }
        prev.close(); prev = next; prevT = nextT;
      }
      // Reject a capture identical to the last accepted one (stale/throttled)
      if (staleRef && same(prevT, staleRef)) {
        prev.close();
        await sleep(700 + round * 400);
        continue;
      }
      void settled;
      return prev;
    }
    return grabFrame(); // give up on freshness rather than hang
  };

  // Height of any bar pinned to the top of the viewport, in CSS px. Used as a
  // hard floor for the crop so a sticky header can never be stitched twice,
  // even if pixel matching is thrown off. Pierces shadow DOM.
  const measureStickyTop = () => run(() => {
    const vh = window.innerHeight, vw = window.innerWidth;
    let top = 0;
    const visit = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.5 || r.height <= 0 || r.height > vh * 0.5) continue;
        if (r.top <= 2 && r.bottom > 0) top = Math.max(top, Math.min(r.bottom, vh));
      }
    };
    visit(document);
    return Math.ceil(top);
  }).catch(() => 0);

  let canvas = null, ctx = null, W = 0, canvasH = 0, B = 0;
  let frameCanvas = null, fctx = null;
  const frameData = (bmp) => {
    if (!frameCanvas || frameCanvas.width !== bmp.width || frameCanvas.height !== bmp.height) {
      frameCanvas = new OffscreenCanvas(bmp.width, bmp.height);
      fctx = frameCanvas.getContext("2d", { willReadFrequently: true });
    }
    fctx.drawImage(bmp, 0, 0);
    return fctx.getImageData(0, 0, bmp.width, bmp.height).data;
  };

  const MAX_CANVAS_H = 60000;
  function growCanvasTo(h) {
    const target = Math.min(Math.round(h), MAX_CANVAS_H);
    if (target <= canvasH) return;
    const next = new OffscreenCanvas(W, target);
    const nctx = next.getContext("2d", { willReadFrequently: true });
    if (canvas) nctx.drawImage(canvas, 0, 0);
    canvas = next; ctx = nctx; canvasH = target;
  }

  const STRIP = 24;
  function pickStrip() {
    const minS = Math.max(0, B - Math.round((windowHeight || 800) * 2));
    for (let S = B - STRIP; S >= minS; S -= 8) {
      const d = ctx.getImageData(0, S, W, STRIP).data;
      let sum = 0, sumSq = 0, n = 0;
      for (let i = 1; i < d.length; i += 64) { sum += d[i]; sumSq += d[i] * d[i]; n++; }
      const mean = sum / n;
      if (sumSq / n - mean * mean > 40) return { S, data: d };
    }
    return null;
  }
  function matchStrip(frame, H, strip, expected) {
    const xStep = 16, rowStep = 4;
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
    let { best, bestCost } = search(expected - 250, expected + 250);
    if (bestCost > 6) {
      const full = search(0, H - STRIP);
      if (full.bestCost < bestCost) ({ best, bestCost } = full);
    }
    return bestCost <= 12 ? best : -1;
  }

  try {
    // ---- 2. Lazy-load pre-pass: walk the page so content renders, then
    //         return to the top. Stops when scrolling no longer advances.
    const step = Math.max(200, viewportHeight * 0.8);
    let prevY = -1, prevH = 0, stagnant = 0;
    for (let i = 0; i < 60; i++) {
      const s = await readState();
      if (s.y <= prevY + 2 && s.height <= prevH + 2) {
        if (++stagnant >= 2) break;      // bottom reached and nothing new loaded
      } else {
        stagnant = 0;
      }
      prevY = s.y; prevH = s.height;
      if (s.height > MAX_CANVAS_H) break; // endless feed — stop growing
      await scrollTo(s.y + step);
      await sleep(320);                   // let lazy content render
    }
    await scrollTo(0);
    await sleep(700);                     // settle after returning to top

    // ---- 3. Capture loop
    await scrollTo(0);
    await sleep(CAPTURE_DELAY_MS);
    let bmp = await grabStableFrame();
    W = bmp.width;
    const scale = bmp.height / (windowHeight || viewportHeight); // device px per CSS px
    let state = await readState();
    growCanvasTo(state.height * scale);
    ctx.drawImage(bmp, 0, 0);
    B = bmp.height;
    let lastThumb = thumb(bmp); // guards against stale/throttled captures
    bmp.close();

    let lastY = 0, guard = 0;
    while (guard++ < 300) {
      state = await readState();
      growCanvasTo(state.height * scale); // page may have grown (lazy load)
      if (B >= canvasH) break;

      const target = Math.max(0, B / scale - viewportHeight * 0.35);
      await scrollTo(target);
      await sleep(CAPTURE_DELAY_MS);
      const after = await readState();
      const advanced = after.y > lastY + 1;
      lastY = after.y;

      // Sticky bars are measured at THIS scroll position, while they're
      // actually pinned, and converted to device pixels.
      const stickyPx = advanced ? Math.round((await measureStickyTop()) * scale) : 0;

      bmp = await grabStableFrame(advanced ? lastThumb : null);
      const H = bmp.height;
      const frame = frameData(bmp);

      let fB = -1;
      const strip = pickStrip();
      if (strip) {
        const expected = Math.round(strip.S - after.y * scale);
        const r = matchStrip(frame, H, strip.data, expected);
        if (r >= 0) fB = r + (B - strip.S);
      }
      if (fB < 0) fB = Math.round(B - after.y * scale); // fallback: scroll math
      // Hard floor: never stitch pixels from inside the pinned header band,
      // no matter what the matcher concluded.
      fB = Math.max(fB, Math.min(stickyPx, Math.round(H * 0.5)));
      fB = Math.max(0, Math.min(H, fB));

      const fresh = Math.min(H - fB, canvasH - B);
      if (fresh > 0) {
        ctx.drawImage(bmp, 0, fB, W, fresh, 0, B, W, fresh);
        B += fresh;
      }
      lastThumb = thumb(bmp);
      bmp.close();

      if (!advanced) break;        // can't scroll further — done
      if (fresh <= 0) break;       // nothing new captured
    }
  } finally {
    await run((y) => {
      document.getElementById("__screeners_capture_style")?.remove();
      const el = window.__screenersScroller;
      if (el) el.scrollTop = y; else window.scrollTo(0, y);
      delete window.__screenersScroller;
    }, [originalScrollY]).catch(() => {});
  }

  // Trim unpainted rows (page reported taller than it rendered)
  let out = canvas;
  if (B > 0 && B < canvasH) {
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
