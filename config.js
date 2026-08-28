// ============================================================
// Screeners configuration
// ============================================================
// GOOGLE OAUTH CLIENT ID (required only for the Google Drive feature).
//
// This is a PUBLIC identifier, not a secret. Each user of the extension
// signs into THEIR OWN Google account through Google's account chooser —
// files are uploaded to the signed-in user's Drive only. The extension
// uses the narrow `drive.file` scope: it can only see files it created,
// never the rest of anyone's Drive.
//
// To set this up (free):
//   1. https://console.cloud.google.com/ → create a project
//   2. APIs & Services → Enable "Google Drive API"
//   3. OAuth consent screen → External → add scope
//      https://www.googleapis.com/auth/drive.file
//   4. Credentials → Create OAuth client ID → type "Web application"
//   5. Add authorized redirect URI:
//      https://<YOUR_EXTENSION_ID>.chromiumapp.org/
//      (find your extension ID at chrome://extensions with Developer
//      mode on; note it changes if the extension is re-packed without
//      a fixed key — pin it before publishing)
//   6. Paste the client ID below.
//
// Users can also override this with their own client ID in Options,
// so nobody is forced to trust the shipped one.
// ============================================================

export const DEFAULT_GOOGLE_CLIENT_ID =
  "750968618920-mjnsuhthdrf7a8pht5810a0h8l1nkph6.apps.googleusercontent.com";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

// Name of the folder created in the user's Drive for uploads.
export const DRIVE_FOLDER_NAME = "Screeners";
