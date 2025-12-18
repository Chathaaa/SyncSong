const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const itunes = require("./providers-local/itunes");
const { shell } = require("electron");

const SPOTIFY_CLIENT_ID = "e87ab2180d5a438ba6f23670e3c12f3d";

function startStaticRendererServer() {
  const rendererDir = path.join(__dirname, "renderer");

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || "/").split("?")[0];
    const cleanPath = urlPath === "/" ? "/index.html" : urlPath;

    // Prevent path traversal
    const filePath = path.join(rendererDir, cleanPath);
    if (!filePath.startsWith(rendererDir)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const type =
        ext === ".html" ? "text/html; charset=utf-8" :
        ext === ".js"   ? "application/javascript; charset=utf-8" :
        ext === ".css"  ? "text/css; charset=utf-8" :
        "application/octet-stream";

      res.writeHead(200, { "Content-Type": type });
      res.end(data);
    });
  });

  return new Promise((resolve) => {
    const RENDERER_PORT = Number(process.env.RENDERER_PORT || 12121);

    server.listen(RENDERER_PORT, "127.0.0.1", () => {
      resolve({ server, port: RENDERER_PORT });
    });
  });
}

async function createWindow() {
  const { server, port } = await startStaticRendererServer();

  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // optional but helps keep cookies/session stable:
      partition: "persist:syncsong",
    },
  });

  win.on("closed", () => {
    try { server.close(); } catch {}
  });

  win.loadURL(`http://127.0.0.1:${port}/index.html`);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// // iTunes IPC
// ipcMain.handle("itunes:available", async () => itunes.itunesAvailable());
// ipcMain.handle("itunes:nowPlaying", async () => itunes.getNowPlaying());
// ipcMain.handle("itunes:playFromPlaylist", async (_e, playlistIndex, trackIndex) =>
//   itunes.playFromPlaylist(playlistIndex, trackIndex)
// );
// // ipcMain.handle("itunes:playByPersistentId", async (_e, pid) => itunes.playByPersistentId(pid));
// // ipcMain.handle("itunes:playByDatabaseId", async (_e, dbId) => itunes.playByDatabaseId(dbId));
// // ipcMain.handle("itunes:playByTrackId", async (_e, trackId) => itunes.playByTrackId(trackId));
// ipcMain.handle("itunes:pause", async () => (await itunes.pause(), true));
// ipcMain.handle("itunes:play", async () => (await itunes.play(), true));
// ipcMain.handle("itunes:next", async () => (await itunes.nextTrack(), true));
// ipcMain.handle("itunes:listPlaylists", async () => itunes.listPlaylists());
// ipcMain.handle("itunes:listTracks", async (_e, playlistIndex) => itunes.listTracksByIndex(playlistIndex));


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
  console.log("[spotify] connect start");
  try {
    const clientId = SPOTIFY_CLIENT_ID; // or process.env.SPOTIFY_CLIENT_ID
    if (!clientId) throw new Error("Missing Spotify Client ID");

    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(sha256(verifier));

    const port = 53682;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const scopes = [
      "playlist-read-private",
      "playlist-read-collaborative",

      // Web Playback SDK + controlling playback:
      "streaming",
      "user-modify-playback-state",
      "user-read-playback-state",
    ].join(" ");


    const authUrl =
      "https://accounts.spotify.com/authorize" +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code_challenge_method=S256` +
      `&code_challenge=${encodeURIComponent(challenge)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&show_dialog=true`;

    console.log("[spotify] opening auth url", authUrl);

    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
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

          if (err) return reject(new Error(err));
          return resolve(c);
        } catch (ex) {
          console.error('[spotify] callback handler exception', ex && ex.stack ? ex.stack : ex);
          try { server.close(); } catch (__) {}
          reject(ex);
        }
      });

      server.listen(port, "127.0.0.1", () => {
        shell.openExternal(authUrl);
      });
    });

    console.log('[spotify] got code', code ? 'yes' : 'no');

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
    console.log('[spotify] token exchange status', tokenRes.status, 'body', tokenJson);

    if (!tokenRes.ok) {
      throw new Error(tokenJson.error_description || "Spotify token exchange failed");
    }
    
    // Return a plain, minimal object instead of the raw parsed object to avoid
    // any prototype/getter issues when serializing over IPC
    const tokenResult = {
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token,
      expires_in: tokenJson.expires_in,
      token_type: tokenJson.token_type,
      scope: tokenJson.scope,
    };

    console.log("[spotify] granted scopes:", tokenResult.scope);
    return tokenResult; // access_token, refresh_token, expires_in, token_type, scope
  } catch (err) {
    console.error('[spotify] connect error', err && err.stack ? err.stack : err);
    throw err;
  }
});