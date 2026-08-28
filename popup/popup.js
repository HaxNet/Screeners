import { getConnectedAccount } from "../lib/drive.js";

const send = (type) => chrome.runtime.sendMessage({ type });

document.getElementById("visible").addEventListener("click", async () => {
  await send("CAPTURE_VISIBLE");
  window.close();
});

document.getElementById("area").addEventListener("click", async () => {
  await send("START_AREA_SELECT");
  window.close();
});

document.getElementById("fullpage").addEventListener("click", async () => {
  await send("CAPTURE_FULLPAGE"); // background acks instantly, then captures
  window.close();
});

document.getElementById("record").addEventListener("click", async () => {
  await send("OPEN_RECORDER");
  window.close();
});

document.getElementById("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

getConnectedAccount().then((email) => {
  document.getElementById("drive").textContent = email
    ? `Drive: ${email}`
    : "Drive: not connected";
});
