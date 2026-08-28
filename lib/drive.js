// Screeners — Google Drive integration.
//
// Privacy model (important for a public extension):
//   • Auth uses chrome.identity.launchWebAuthFlow with Google's ACCOUNT
//     CHOOSER (prompt=select_account) — every user connects THEIR OWN
//     Google account. Nothing is hard-wired to the developer's Drive.
//   • Scope is drive.file only: the extension can see/manage only files
//     it created, never the rest of the user's Drive.
//   • Users may override the OAuth client ID in Options with their own.
//   • Disconnect wipes the stored token immediately.

import { DEFAULT_GOOGLE_CLIENT_ID, DRIVE_SCOPE, DRIVE_FOLDER_NAME } from "../config.js";

const TOKEN_KEY = "driveToken"; // { accessToken, expiresAt, email }

async function getClientId() {
  const { customClientId } = await chrome.storage.sync.get("customClientId");
  return (customClientId || DEFAULT_GOOGLE_CLIENT_ID || "").trim();
}

function redirectUri() {
  return `https://${chrome.runtime.id}.chromiumapp.org/`;
}

function buildAuthUrl(clientId, { interactive, loginHint }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: `${DRIVE_SCOPE} email`,
    include_granted_scopes: "true",
  });
  if (interactive) {
    p.set("prompt", "select_account"); // ← the account chooser
  } else {
    p.set("prompt", "none");
    if (loginHint) p.set("login_hint", loginHint);
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

function parseRedirect(url) {
  const hash = new URL(url).hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const err = params.get("error");
  if (err) throw new Error(`Google auth error: ${err}`);
  const accessToken = params.get("access_token");
  const expiresIn = Number(params.get("expires_in") || 3500);
  if (!accessToken) throw new Error("No access token returned by Google.");
  return { accessToken, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
}

async function fetchEmail(accessToken) {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    return (await r.json()).email || null;
  } catch {
    return null;
  }
}

async function storedToken() {
  const data = await chrome.storage.local.get(TOKEN_KEY);
  return data[TOKEN_KEY] || null;
}

async function saveToken(token) {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

/** Connected account email, or null. Does not trigger any UI. */
export async function getConnectedAccount() {
  const t = await storedToken();
  return t?.email || null;
}

/** Interactive connect — always shows Google's account chooser. */
export async function connect() {
  const clientId = await getClientId();
  if (!clientId) {
    throw new Error(
      "No Google OAuth client ID configured. Open Options → Google Drive to add one (see README)."
    );
  }
  const redirect = await chrome.identity.launchWebAuthFlow({
    url: buildAuthUrl(clientId, { interactive: true }),
    interactive: true,
  });
  const token = parseRedirect(redirect);
  token.email = await fetchEmail(token.accessToken);
  await saveToken(token);
  return token.email;
}

/** Disconnect: revoke + forget the token. */
export async function disconnect() {
  const t = await storedToken();
  if (t?.accessToken) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.accessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }).catch(() => {});
  }
  await chrome.storage.local.remove([TOKEN_KEY, "driveFolderId"]);
}

/** Valid access token; silently refreshes, else re-prompts. */
async function getAccessToken() {
  let t = await storedToken();
  if (t && t.expiresAt > Date.now()) return t.accessToken;

  const clientId = await getClientId();
  if (!clientId) throw new Error("No Google OAuth client ID configured.");

  // Silent refresh for the previously chosen account
  if (t?.email) {
    try {
      const redirect = await chrome.identity.launchWebAuthFlow({
        url: buildAuthUrl(clientId, { interactive: false, loginHint: t.email }),
        interactive: false,
      });
      const fresh = parseRedirect(redirect);
      fresh.email = t.email;
      await saveToken(fresh);
      return fresh.accessToken;
    } catch {
      /* fall through to interactive */
    }
  }
  await connect();
  return (await storedToken()).accessToken;
}

async function driveFetch(path, accessToken, init = {}) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Drive API ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ensureFolder(accessToken) {
  const cached = (await chrome.storage.local.get("driveFolderId")).driveFolderId;
  if (cached) {
    try {
      const f = await driveFetch(`files/${cached}?fields=id,trashed`, accessToken);
      if (!f.trashed) return cached;
    } catch { /* recreate below */ }
  }
  const q = encodeURIComponent(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const found = await driveFetch(`files?q=${q}&fields=files(id)`, accessToken);
  let id = found.files?.[0]?.id;
  if (!id) {
    const created = await driveFetch("files?fields=id", accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: DRIVE_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      }),
    });
    id = created.id;
  }
  await chrome.storage.local.set({ driveFolderId: id });
  return id;
}

/**
 * Upload a blob to the user's Drive (Screeners folder).
 * Returns { id, webViewLink }.
 */
export async function uploadToDrive(blob, filename) {
  const accessToken = await getAccessToken();
  const folderId = await ensureFolder(accessToken);

  const metadata = { name: filename, parents: [folderId] };
  const boundary = "screeners_" + Math.random().toString(36).slice(2);
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  );

  const r = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!r.ok) throw new Error(`Drive upload failed (${r.status}): ${await r.text()}`);
  return r.json();
}
