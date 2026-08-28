// Screeners — area selection overlay (injected on demand).
// Drag a rectangle; Esc cancels.
// Rendered inside a top-layer <dialog> so page CSS (transforms, zoom,
// z-index games) can't shift it — the overlay always covers the visible
// viewport, regardless of scroll position.

(() => {
  if (window.__screenersSelectorActive) return;
  window.__screenersSelectorActive = true;

  const dlg = document.createElement("dialog");
  dlg.style.cssText = [
    "position:fixed", "inset:0", "margin:0", "padding:0", "border:none",
    "width:100vw", "height:100vh", "max-width:100vw", "max-height:100vh",
    "background:transparent", "outline:none", "overflow:hidden",
  ].join(";");

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:absolute", "inset:0", "cursor:crosshair",
    "background:rgba(0,0,0,.35)", "user-select:none",
  ].join(";");

  const box = document.createElement("div");
  box.style.cssText = [
    "position:absolute", "display:none",
    "border:2px solid #4f8ef7", "background:rgba(79,142,247,.15)",
    "box-shadow:0 0 0 100000px rgba(0,0,0,.35)", "pointer-events:none",
  ].join(";");

  const hint = document.createElement("div");
  hint.textContent = "Drag to select an area — Esc to cancel";
  hint.style.cssText = [
    "position:absolute", "top:16px", "left:50%", "transform:translateX(-50%)",
    "background:#202124", "color:#fff",
    "font:13px/1.4 system-ui,sans-serif", "padding:8px 14px",
    "border-radius:20px", "pointer-events:none",
    "box-shadow:0 2px 12px rgba(0,0,0,.4)",
  ].join(";");

  const label = document.createElement("div");
  label.style.cssText = [
    "position:absolute", "display:none",
    "background:#202124", "color:#fff", "font:11px/1 system-ui,sans-serif",
    "padding:3px 6px", "border-radius:4px", "pointer-events:none",
  ].join(";");

  dlg.append(overlay, box, hint, label);
  document.documentElement.append(dlg);
  dlg.showModal();

  let startX = 0, startY = 0, dragging = false;

  function cleanup() {
    try { dlg.close(); } catch { /* already closed */ }
    dlg.remove();
    window.__screenersSelectorActive = false;
  }

  // Esc closes the dialog natively — treat that as cancel
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); cleanup(); });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); cleanup(); }
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    overlay.style.background = "transparent";
    box.style.display = "block";
    update(e);
  });

  function rectFrom(e) {
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    return { x, y, w, h };
  }

  function update(e) {
    const { x, y, w, h } = rectFrom(e);
    box.style.left = x + "px"; box.style.top = y + "px";
    box.style.width = w + "px"; box.style.height = h + "px";
    label.style.display = "block";
    label.textContent = `${w} × ${h}`;
    label.style.left = x + "px";
    label.style.top = Math.max(0, y - 22) + "px";
  }

  overlay.addEventListener("mousemove", (e) => { if (dragging) update(e); });

  overlay.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    dragging = false;
    const { x, y, w, h } = rectFrom(e);
    cleanup();
    if (w < 5 || h < 5) return;
    chrome.runtime.sendMessage({
      type: "AREA_SELECTED",
      rect: { x, y, width: w, height: h, dpr: window.devicePixelRatio },
    });
  });
})();
