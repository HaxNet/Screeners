import { uploadToDrive } from "../lib/drive.js";

const $ = (id) => document.getElementById(id);

let display = null;        // getDisplayMedia stream
let mic = null;            // microphone stream
let recorder = null;
let chunks = [];
let resultBlob = null;
let timerInterval = null;
let region = null;         // {x,y,w,h} in CSS px on the preview
let cropStop = null;       // function to stop the canvas draw loop

function msg(text, cls = "") {
  $("msg").textContent = text;
  $("msg").className = cls;
}

function timestampName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `screeners_rec_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.webm`;
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function startTimer() {
  const start = Date.now();
  $("timer").classList.add("on");
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    const pad = (n) => String(n).padStart(2, "0");
    $("timer").textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }, 500);
}

function stopTimer() {
  clearInterval(timerInterval);
  $("timer").classList.remove("on");
}

function stopAllTracks() {
  [display, mic].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  display = mic = null;
}

// ------------------------------------------------------------------ share

$("share").addEventListener("click", async () => {
  msg("");
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: $("sysAudio").checked,
    });
    if ($("mic").checked) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        msg("Microphone unavailable — recording without mic.", "err");
      }
    }
    $("live").srcObject = display;
    $("setup").hidden = true;
    $("preview").style.display = "block";
    // Stop if user ends sharing from Chrome's bar before/without recording
    display.getVideoTracks()[0].addEventListener("ended", () => {
      if (recorder?.state === "recording") recorder.stop();
      else location.reload();
    });
  } catch (e) {
    msg(e.name === "NotAllowedError" ? "Sharing was cancelled." : e.message, "err");
  }
});

$("cancelShare").addEventListener("click", () => { stopAllTracks(); location.reload(); });

// ------------------------------------------------------------------ region selection on the live preview

const liveWrap = $("liveWrap");
const live = $("live");
const regionRect = $("regionRect");
let dragStart = null;

function setRegion(r) {
  region = r;
  $("recRegion").disabled = !r;
  $("clearRegion").disabled = !r;
  if (!r) {
    regionRect.style.display = "none";
    $("regionInfo").textContent = "Drag on the preview to select a region, or record everything.";
    return;
  }
  Object.assign(regionRect.style, {
    display: "block",
    left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px",
  });
  const s = videoScale();
  $("regionInfo").textContent =
    `Region: ${Math.round(r.w * s)} × ${Math.round(r.h * s)} px`;
}

function videoScale() {
  const rect = live.getBoundingClientRect();
  return rect.width ? live.videoWidth / rect.width : 1;
}

liveWrap.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const r = liveWrap.getBoundingClientRect();
  dragStart = { x: e.clientX - r.left, y: e.clientY - r.top };
  setRegion(null);
  e.preventDefault();
});

window.addEventListener("mousemove", (e) => {
  if (!dragStart) return;
  const r = liveWrap.getBoundingClientRect();
  const cx = Math.min(Math.max(e.clientX - r.left, 0), r.width);
  const cy = Math.min(Math.max(e.clientY - r.top, 0), r.height);
  setRegion({
    x: Math.min(dragStart.x, cx),
    y: Math.min(dragStart.y, cy),
    w: Math.abs(cx - dragStart.x),
    h: Math.abs(cy - dragStart.y),
  });
});

window.addEventListener("mouseup", () => {
  if (dragStart && region && (region.w < 10 || region.h < 10)) setRegion(null);
  dragStart = null;
});

$("clearRegion").addEventListener("click", () => setRegion(null));

// ------------------------------------------------------------------ record

$("recFull").addEventListener("click", () => startRecording(false));
$("recRegion").addEventListener("click", () => startRecording(true));

function buildAudioTracks() {
  const sources = [];
  if (display?.getAudioTracks().length) sources.push(new MediaStream(display.getAudioTracks()));
  if (mic) sources.push(mic);
  if (!sources.length) return [];
  if (sources.length === 1) return sources[0].getAudioTracks();
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  sources.forEach((s) => ac.createMediaStreamSource(s).connect(dest));
  return dest.stream.getAudioTracks();
}

function croppedVideoTrack() {
  const s = videoScale();
  // Even dimensions keep encoders happy
  const sx = Math.round(region.x * s);
  const sy = Math.round(region.y * s);
  const sw = Math.max(2, Math.round((region.w * s) / 2) * 2);
  const sh = Math.max(2, Math.round((region.h * s) / 2) * 2);

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");

  let running = true;
  const draw = () => {
    if (!running) return;
    ctx.drawImage(live, sx, sy, sw, sh, 0, 0, sw, sh);
    if (live.requestVideoFrameCallback) live.requestVideoFrameCallback(draw);
  };
  if (live.requestVideoFrameCallback) {
    live.requestVideoFrameCallback(draw);
  } else {
    const iv = setInterval(() => running && ctx.drawImage(live, sx, sy, sw, sh, 0, 0, sw, sh), 33);
    cropStop = () => { running = false; clearInterval(iv); };
  }
  if (!cropStop) cropStop = () => { running = false; };

  return canvas.captureStream(30).getVideoTracks()[0];
}

function startRecording(useRegion) {
  const videoTrack = useRegion && region
    ? croppedVideoTrack()
    : display.getVideoTracks()[0];
  const stream = new MediaStream([videoTrack, ...buildAudioTracks()]);

  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = onRecorderStop;
  recorder.start(1000);

  // Hide preview controls, keep the live element playing (needed for cropping)
  $("preview").style.display = "none";
  if (useRegion) {
    // keep video decoding: move it offscreen-ish but playing
    liveWrap.style.position = "fixed";
    liveWrap.style.opacity = "0.001";
    liveWrap.style.pointerEvents = "none";
    document.body.appendChild(liveWrap);
  }
  $("stop").hidden = false;
  startTimer();
}

$("stop").addEventListener("click", () => {
  if (recorder?.state === "recording") recorder.stop();
});

function onRecorderStop() {
  stopTimer();
  cropStop?.();
  cropStop = null;
  stopAllTracks();
  resultBlob = new Blob(chunks, { type: "video/webm" });
  chunks = [];

  $("stop").hidden = true;
  $("playback").style.display = "block";
  $("played").src = URL.createObjectURL(resultBlob);
  $("filename").style.display = "block";
  $("filename").value = timestampName();
  $("actions").hidden = false;
  msg(`Recording ready (${(resultBlob.size / 1048576).toFixed(1)} MB).`, "ok");
}

// ------------------------------------------------------------------ output

$("download").addEventListener("click", async () => {
  const url = URL.createObjectURL(resultBlob);
  await chrome.downloads.download({
    url,
    filename: $("filename").value || timestampName(),
    saveAs: true,
  });
  msg("Saved.", "ok");
});

$("drive").addEventListener("click", async () => {
  $("drive").disabled = true;
  msg("Uploading to your Google Drive…");
  try {
    const file = await uploadToDrive(resultBlob, $("filename").value || timestampName());
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
    $("drive").disabled = false;
  }
});

$("again").addEventListener("click", () => location.reload());
