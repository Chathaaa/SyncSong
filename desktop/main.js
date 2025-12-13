const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const itunes = require("./providers/itunes");

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
ipcMain.handle("itunes:playByPersistentId", async (_e, pid) => itunes.playByPersistentId(pid));
ipcMain.handle("itunes:pause", async () => (await itunes.pause(), true));
ipcMain.handle("itunes:play", async () => (await itunes.play(), true));
ipcMain.handle("itunes:next", async () => (await itunes.nextTrack(), true));
ipcMain.handle("itunes:listPlaylists", async () => itunes.listPlaylists());
ipcMain.handle("itunes:listTracks", async (_e, playlistName) => itunes.listTracks(playlistName));
