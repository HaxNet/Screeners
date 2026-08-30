import { getCapture, deleteCapture } from "../lib/store.js";
import { uploadToDrive, getConnectedAccount } from "../lib/drive.js";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const anno = $("anno");          // transparent overlay for previews
const actx = anno.getContext("2d");

let currentBitmap = null;
const history = [];              // committed states for undo (capped)
const HISTORY_MAX = 15;
let captureId = null;

function msg(text, cls = "") {
  $("msg").textContent = text;
  $("msg").className = cls;
}

function timestampName(ext = "png") {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `screeners_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

function draw(bitmap) {
  currentBitmap = bitmap;
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  anno.width = bitmap.width;
  anno.height = bitmap.height;
  ctx.drawImage(bitmap, 0, 0);
  document.title = `Screeners — ${bitmap.width}×${bitmap.height}`;
}

async function canvasBlob() {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function pushHistory() {
  history.push(await createImageBitmap(canvas));
  while (history.length > HISTORY_MAX) history.shift().close();
  $("undoBtn").disabled = false;
}

// Map a mouse event on the overlay to intrinsic canvas coordinates
function toCanvasXY(e) {
  const r = anno.getBoundingClientRect();
  const scale = canvas.width / r.width;
  return {
    x: (e.clientX - r.left) * scale,
    y: (e.clientY - r.top) * scale,
    scale,
  };
}

// ------------------------------------------------------------------ load

async function init() {
  captureId = new URLSearchParams(location.search).get("id");
  const record = captureId && (await getCapture(captureId));
  if (!record) {
    msg("Capture not found — it may have expired.", "err");
    return;
  }
  draw(await createImageBitmap(record.blob));
  $("filename").value = timestampName("png");
  getConnectedAccount().then((email) => {
    if (!email) $("driveBtn").title = "You'll be prompted to connect your Google Drive.";
  });
}

// ------------------------------------------------------------------ annotation tools

let tool = null;                 // 'pen' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'blur' | 'pixelate' | 'redact'
let drag = null;                 // { x, y } drag origin in canvas coords
const EFFECT_TOOLS = ["blur", "pixelate", "redact"];

function setTool(next) {
  tool = tool === next ? null : next;
  document.querySelectorAll("button.tool").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === tool);
  });
  anno.classList.toggle("on", !!tool);
  if (tool) setCropMode(false);
  commitText();                  // leaving text mode commits pending text
}

document.querySelectorAll("button.tool").forEach((b) => {
  b.addEventListener("click", () => setTool(b.dataset.tool));
});

function strokeStyle() {
  return { color: $("color").value, width: Number($("width").value) };
}

function drawShapePreview(a, b) {
  const { color, width } = strokeStyle();
  actx.clearRect(0, 0, anno.width, anno.height);
  actx.strokeStyle = color;
  actx.fillStyle = color;
  actx.lineWidth = width;
  actx.lineCap = "round";
  actx.lineJoin = "round";

  if (EFFECT_TOOLS.includes(tool)) {
    // dashed preview rectangle for blur/pixelate/redact
    actx.setLineDash([8, 6]);
    actx.lineWidth = 2;
    actx.strokeStyle = "#8ab4f8";
    actx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y),
      Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    actx.setLineDash([]);
  } else if (tool === "rect") {
    actx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y),
      Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else if (tool === "ellipse") {
    actx.beginPath();
    actx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2,
      Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    actx.stroke();
  } else if (tool === "arrow") {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = Math.max(12, width * 3);
    actx.beginPath();
    actx.moveTo(a.x, a.y);
    actx.lineTo(b.x, b.y);
    actx.stroke();
    actx.beginPath();
    actx.moveTo(b.x, b.y);
    actx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
    actx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
    actx.closePath();
    actx.fill();
  }
}

anno.addEventListener("mousedown", (e) => {
  if (!tool || e.button !== 0) return;
  const p = toCanvasXY(e);
  if (tool === "text") { placeTextInput(e, p); return; }
  drag = p;
  if (tool === "pen") {
    const { color, width } = strokeStyle();
    actx.strokeStyle = color;
    actx.lineWidth = width;
    actx.lineCap = "round";
    actx.lineJoin = "round";
    actx.beginPath();
    actx.moveTo(p.x, p.y);
  }
});

anno.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const p = toCanvasXY(e);
  if (tool === "pen") {
    actx.lineTo(p.x, p.y);
    actx.stroke();
  } else {
    drawShapePreview(drag, p);
  }
});

window.addEventListener("mouseup", async (e) => {
  if (!drag) return;
  const origin = drag;
  drag = null;
  actx.setLineDash([]);

  if (EFFECT_TOOLS.includes(tool)) {
    actx.clearRect(0, 0, anno.width, anno.height); // remove dashed preview
    const p = toCanvasXY(e);
    let r = {
      x: Math.min(origin.x, p.x), y: Math.min(origin.y, p.y),
      w: Math.abs(p.x - origin.x), h: Math.abs(p.y - origin.y),
    };
    // Single click (no real drag) → quick block centered on the click,
    // sized for a typical line of text and scaled by the width slider.
    if (r.w < 6 || r.h < 6) {
      const s = Number($("width").value);
      const bw = s * 36, bh = s * 9;
      r = { x: p.x - bw / 2, y: p.y - bh / 2, w: bw, h: bh };
    }
    await pushHistory();
    applyEffect(tool, r);
    return;
  }

  // Pen/shape tools: commit the overlay onto the main canvas
  await pushHistory();
  ctx.drawImage(anno, 0, 0);
  actx.clearRect(0, 0, anno.width, anno.height);
});

// ------------------------------------------------------------------ privacy effects

function applyEffect(kind, r) {
  // clamp to canvas, integer pixels
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const w = Math.min(canvas.width - x, Math.round(r.w));
  const h = Math.min(canvas.height - y, Math.round(r.h));
  if (w < 2 || h < 2) return;
  const s = Number($("width").value); // strength from the width slider

  if (kind === "redact") {
    ctx.fillStyle = $("color").value;
    ctx.fillRect(x, y, w, h);
    return;
  }

  if (kind === "pixelate") {
    const cell = Math.max(6, s * 3); // bigger slider → chunkier mosaic
    const tw = Math.max(1, Math.ceil(w / cell));
    const th = Math.max(1, Math.ceil(h / cell));
    const tmp = document.createElement("canvas");
    tmp.width = tw; tmp.height = th;
    const t = tmp.getContext("2d");
    t.imageSmoothingEnabled = true;
    t.drawImage(canvas, x, y, w, h, 0, 0, tw, th);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h);
    ctx.imageSmoothingEnabled = true;
    return;
  }

  // blur — sample a padded region so edges don't bleed transparency
  const radius = Math.max(4, s * 2);
  const pad = radius * 2;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  const t = tmp.getContext("2d");
  t.filter = `blur(${radius}px)`;
  const sx = Math.max(0, x - pad), sy = Math.max(0, y - pad);
  const sw = Math.min(canvas.width - sx, w + pad * 2);
  const sh = Math.min(canvas.height - sy, h + pad * 2);
  t.drawImage(canvas, sx, sy, sw, sh, sx - x, sy - y, sw, sh);
  ctx.drawImage(tmp, x, y);
}

// ------------------------------------------------------------------ text tool

const textInput = $("textInput");
let textPos = null; // intrinsic coords + scale

function placeTextInput(e, p) {
  commitText();
  const wrapRect = $("canvasWrap").getBoundingClientRect();
  textPos = p;
  const { color, width } = strokeStyle();
  const cssFontPx = (width * 4 + 12) / p.scale; // intrinsic → CSS px
  Object.assign(textInput.style, {
    display: "inline-block",
    left: e.clientX - wrapRect.left + "px",
    top: e.clientY - wrapRect.top + "px",
    color,
    font: `700 ${cssFontPx}px system-ui, sans-serif`,
  });
  textInput.textContent = "";
  setTimeout(() => textInput.focus(), 0);
}

async function commitText() {
  const value = textInput.textContent.trim();
  const pos = textPos;
  textInput.style.display = "none";
  textInput.textContent = "";
  textPos = null;
  if (!value || !pos) return;
  const { color, width } = strokeStyle();
  const fontPx = width * 4 + 12; // intrinsic px
  await pushHistory();
  ctx.font = `700 ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  // Slight dark halo for readability on light backgrounds
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.55)";
  ctx.shadowBlur = Math.max(2, fontPx / 8);
  ctx.fillText(value, pos.x, pos.y);
  ctx.restore();
}

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); }
  if (e.key === "Escape") { textInput.textContent = ""; commitText(); }
});
textInput.addEventListener("blur", () => commitText());

// ------------------------------------------------------------------ crop

const cropLayer = $("cropLayer");
const cropRect = $("cropRect");
let cropSel = null;    // {x,y,w,h} in CSS px relative to the image
let cropAct = null;    // active gesture: {type:'new'|'move'|'resize', handle, sx, sy, orig, W, H}

function setCropMode(on) {
  if (on) setTool(null);
  cropLayer.style.display = on ? "block" : "none";
  $("applyCrop").hidden = !on;
  $("cancelCrop").hidden = !on;
  $("cropDims").hidden = !on;
  $("cropBtn").hidden = on;
  if (!on) {
    cropRect.style.display = "none";
    cropSel = null;
    cropAct = null;
  } else {
    $("cropW").value = "";
    $("cropH").value = "";
  }
}

function cropScale() {
  return canvas.width / cropLayer.getBoundingClientRect().width; // intrinsic px per CSS px
}

$("cropBtn").addEventListener("click", () => setCropMode(true));
$("cancelCrop").addEventListener("click", () => setCropMode(false));

function layerPoint(e) {
  const r = cropLayer.getBoundingClientRect();
  return {
    x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
    y: Math.min(Math.max(e.clientY - r.top, 0), r.height),
    W: r.width, H: r.height,
  };
}

function renderCrop() {
  if (!cropSel) return;
  Object.assign(cropRect.style, {
    display: "block",
    left: cropSel.x + "px", top: cropSel.y + "px",
    width: cropSel.w + "px", height: cropSel.h + "px",
  });
  const scale = cropScale();
  if (!Number.isFinite(scale) || scale <= 0) return;
  const w = Math.round(cropSel.w * scale);
  const h = Math.round(cropSel.h * scale);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  $("cropSize").textContent = `${w} × ${h}`;
  // Keep the W/H inputs in sync unless the user is typing in them.
  // Use "" instead of 0/NaN — number inputs reject out-of-range values.
  if (document.activeElement !== $("cropW")) $("cropW").value = w >= 1 ? w : "";
  if (document.activeElement !== $("cropH")) $("cropH").value = h >= 1 ? h : "";
}

// Typing exact pixel dimensions resizes the selection (top-left anchored)
function applyTypedDims() {
  const scale = cropScale();
  if (!Number.isFinite(scale) || scale <= 0) return;
  const layer = cropLayer.getBoundingClientRect();
  const wPx = Number($("cropW").value);
  const hPx = Number($("cropH").value);
  if (!(wPx > 0) && !(hPx > 0)) return; // ignore empty/NaN input

  if (!cropSel) cropSel = { x: 0, y: 0, w: 0, h: 0 };
  if (wPx > 0) cropSel.w = wPx / scale;
  if (hPx > 0) cropSel.h = hPx / scale;

  // Clamp size to the image, sliding the origin if needed
  cropSel.w = Math.min(cropSel.w, layer.width);
  cropSel.h = Math.min(cropSel.h, layer.height);
  cropSel.x = Math.min(cropSel.x, layer.width - cropSel.w);
  cropSel.y = Math.min(cropSel.y, layer.height - cropSel.h);
  renderCrop();
}

$("cropW").addEventListener("input", applyTypedDims);
$("cropH").addEventListener("input", applyTypedDims);
["cropW", "cropH"].forEach((id) => {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $(id).blur(); $("applyCrop").click(); }
  });
});

// Start a NEW selection (empty area of the layer)
cropLayer.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const p = layerPoint(e);
  cropAct = { type: "new", sx: p.x, sy: p.y, W: p.W, H: p.H };
  cropSel = { x: p.x, y: p.y, w: 0, h: 0 };
  renderCrop();
  e.preventDefault();
});

// MOVE (drag inside the rect) or RESIZE (drag a handle)
cropRect.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !cropSel) return;
  const p = layerPoint(e);
  const handle = e.target.dataset?.h;
  cropAct = {
    type: handle ? "resize" : "move",
    handle,
    sx: p.x, sy: p.y,
    orig: { ...cropSel },
    W: p.W, H: p.H,
  };
  e.preventDefault();
  e.stopPropagation();
});

window.addEventListener("mousemove", (e) => {
  if (!cropAct) return;
  const p = layerPoint(e);
  const dx = p.x - cropAct.sx;
  const dy = p.y - cropAct.sy;

  if (cropAct.type === "new") {
    cropSel = {
      x: Math.min(cropAct.sx, p.x),
      y: Math.min(cropAct.sy, p.y),
      w: Math.abs(p.x - cropAct.sx),
      h: Math.abs(p.y - cropAct.sy),
    };
  } else if (cropAct.type === "move") {
    const o = cropAct.orig;
    cropSel = {
      x: Math.min(Math.max(o.x + dx, 0), cropAct.W - o.w),
      y: Math.min(Math.max(o.y + dy, 0), cropAct.H - o.h),
      w: o.w, h: o.h,
    };
  } else {
    // resize: anchor is the side/corner opposite the dragged handle
    const o = cropAct.orig;
    const h = cropAct.handle;
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (h.includes("w")) x1 = p.x;
    if (h.includes("e")) x2 = p.x;
    if (h.includes("n")) y1 = p.y;
    if (h.includes("s")) y2 = p.y;
    cropSel = {
      x: Math.min(x1, x2), y: Math.min(y1, y2),
      w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    };
  }
  renderCrop();
});

window.addEventListener("mouseup", () => { cropAct = null; });

// Enter applies the crop while in crop mode
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("applyCrop").hidden && document.activeElement !== textInput
      && document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    $("applyCrop").click();
  }
});

$("applyCrop").addEventListener("click", async () => {
  if (!cropSel || cropSel.w < 3 || cropSel.h < 3) {
    return msg("Drag on the image first to choose the crop area.", "err");
  }
  const scale = canvas.width / canvas.getBoundingClientRect().width;
  const sx = Math.round(cropSel.x * scale);
  const sy = Math.round(cropSel.y * scale);
  const sw = Math.max(1, Math.round(cropSel.w * scale));
  const sh = Math.max(1, Math.round(cropSel.h * scale));

  await pushHistory();
  const snap = await createImageBitmap(canvas, sx, sy, sw, sh);
  draw(snap);
  setCropMode(false);
  msg(`Cropped to ${sw}×${sh}.`, "ok");
});

// ------------------------------------------------------------------ undo

$("undoBtn").addEventListener("click", () => {
  const prev = history.pop();
  if (prev) draw(prev);
  $("undoBtn").disabled = history.length === 0;
});

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && document.activeElement !== textInput) {
    e.preventDefault();
    $("undoBtn").click();
  }
  // Ctrl/Cmd+C copies the image — unless the user is copying text they
  // selected or is typing in a field.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
    const el = document.activeElement;
    const typing = el === textInput || el.tagName === "INPUT";
    const hasTextSelection = !window.getSelection().isCollapsed;
    if (!typing && !hasTextSelection) {
      e.preventDefault();
      $("copyBtn").click();
    }
  }
});

// ------------------------------------------------------------------ output

$("downloadBtn").addEventListener("click", async () => {
  await commitText();
  const blob = await canvasBlob();
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: $("filename").value || timestampName("png"),
    saveAs: true,
  });
  msg("Saved.", "ok");
});

$("copyBtn").addEventListener("click", async () => {
  try {
    await commitText();
    const blob = await canvasBlob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    msg("Copied to clipboard.", "ok");
  } catch (e) {
    msg(`Copy failed: ${e.message}`, "err");
  }
});

$("driveBtn").addEventListener("click", async () => {
  const btn = $("driveBtn");
  btn.disabled = true;
  msg("Uploading to your Google Drive…");
  try {
    await commitText();
    const blob = await canvasBlob();
    const file = await uploadToDrive(blob, $("filename").value || timestampName("png"));
    msg("Uploaded ✓ ", "ok");
    if (file.webViewLink) {
      const a = document.createElement("a");
      a.href = file.webViewLink;
      a.target = "_blank";
      a.textContent = "Open in Drive";
      a.style.color = "#8ab4f8";
      $("msg").appendChild(a);
    }
  } catch (e) {
    msg(e.message, "err");
  } finally {
    btn.disabled = false;
  }
});

window.addEventListener("beforeunload", () => {
  if (captureId) deleteCapture(captureId);
});

init();
