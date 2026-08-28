import { connect, disconnect, getConnectedAccount } from "../lib/drive.js";

const $ = (id) => document.getElementById(id);

function msg(text, cls = "") {
  $("msg").textContent = text;
  $("msg").className = cls;
}

async function refresh() {
  const email = await getConnectedAccount();
  $("status").textContent = email ? `Connected as ${email}` : "Not connected";
  $("connect").hidden = !!email;
  $("switch").hidden = !email;
  $("disconnect").hidden = !email;
  const { customClientId } = await chrome.storage.sync.get("customClientId");
  $("clientId").value = customClientId || "";
}

$("connect").addEventListener("click", doConnect);
$("switch").addEventListener("click", doConnect);

async function doConnect() {
  msg("Opening Google sign-in…");
  try {
    const email = await connect();
    msg(`Connected as ${email || "your Google account"}.`, "ok");
  } catch (e) {
    msg(e.message, "err");
  }
  refresh();
}

$("disconnect").addEventListener("click", async () => {
  await disconnect();
  msg("Disconnected. Token revoked.", "ok");
  refresh();
});

$("saveClientId").addEventListener("click", async () => {
  const v = $("clientId").value.trim();
  if (v && !/\.apps\.googleusercontent\.com$/.test(v)) {
    return msg("That doesn't look like a Google OAuth client ID.", "err");
  }
  await chrome.storage.sync.set({ customClientId: v });
  await disconnect(); // old token belongs to old client
  msg("Client ID saved. Reconnect your Drive.", "ok");
  refresh();
});

$("clearClientId").addEventListener("click", async () => {
  await chrome.storage.sync.remove("customClientId");
  await disconnect();
  msg("Reset to the built-in client ID.", "ok");
  refresh();
});

refresh();
