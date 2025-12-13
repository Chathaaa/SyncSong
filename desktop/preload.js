const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  itunes: {
    available: () => ipcRenderer.invoke("itunes:available"),
    nowPlaying: () => ipcRenderer.invoke("itunes:nowPlaying"),
    playByPersistentId: (pid) => ipcRenderer.invoke("itunes:playByPersistentId", pid),
    pause: () => ipcRenderer.invoke("itunes:pause"),
    play: () => ipcRenderer.invoke("itunes:play"),
    next: () => ipcRenderer.invoke("itunes:next"),
    listPlaylists: () => ipcRenderer.invoke("itunes:listPlaylists"),
    listTracks: (playlistName) => ipcRenderer.invoke("itunes:listTracks", playlistName),
  },
});
