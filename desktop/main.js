const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const itunes = require("./providers/itunes");

const { shell } = require("electron");
const http = require("http");
const crypto = require("crypto");

const SPOTIFY_CLIENT_ID = "e87ab2180d5a438ba6f23670e3c12f3d"

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// iTunes IPC
ipcMain.handle("itunes:available", async () => itunes.itunesAvailable());
ipcMain.handle("itunes:nowPlaying", async () => itunes.getNowPlaying());
ipcMain.handle("itunes:playFromPlaylist", async (_e, playlistIndex, trackIndex) =>
  itunes.playFromPlaylist(playlistIndex, trackIndex)
);
// ipcMain.handle("itunes:playByPersistentId", async (_e, pid) => itunes.playByPersistentId(pid));
// ipcMain.handle("itunes:playByDatabaseId", async (_e, dbId) => itunes.playByDatabaseId(dbId));
// ipcMain.handle("itunes:playByTrackId", async (_e, trackId) => itunes.playByTrackId(trackId));
ipcMain.handle("itunes:pause", async () => (await itunes.pause(), true));
ipcMain.handle("itunes:play", async () => (await itunes.play(), true));
ipcMain.handle("itunes:next", async () => (await itunes.nextTrack(), true));
ipcMain.handle("itunes:listPlaylists", async () => itunes.listPlaylists());
ipcMain.handle("itunes:listTracks", async (_e, playlistIndex) => itunes.listTracksByIndex(playlistIndex));


function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest();
}

// Spotify IPC 
ipcMain.handle("app:openExternal", async (_e, url) => {
  try {
    // shell.openExternal returns a Promise<void>, but may reject if protocol handler missing
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("spotify:connect", async () => {
  const clientId = SPOTIFY_CLIENT_ID; // or process.env.SPOTIFY_CLIENT_ID
  if (!clientId) throw new Error("Missing Spotify Client ID");

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(sha256(verifier));

  const port = 53682;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const scopes = [
    "playlist-read-private",
    "playlist-read-collaborative",
  ].join(" ");

  const authUrl =
    "https://accounts.spotify.com/authorize" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge_method=S256` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&scope=${encodeURIComponent(scopes)}`;

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url || !req.url.startsWith("/callback")) {
        res.writeHead(404);
        res.end();
        return;
      }

      const u = new URL(`http://127.0.0.1:${port}${req.url}`);
      
      const c = u.searchParams.get("code");
      const err = u.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h3>${c ? "Spotify connected. You can close this tab." : "Spotify auth failed."}</h3>`);

      server.close();

      if (err) reject(new Error(err));
      else resolve(c);
    });

    server.listen(port, "127.0.0.1", () => {
      shell.openExternal(authUrl);
    });
  });

  // Exchange code for tokens
  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error(tokenJson.error_description || "Spotify token exchange failed");
  }

  return tokenJson; // access_token, refresh_token, expires_in, token_type, scope
});
