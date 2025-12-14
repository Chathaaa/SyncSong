const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  itunes: {
    available: () => ipcRenderer.invoke("itunes:available"),
    nowPlaying: () => ipcRenderer.invoke("itunes:nowPlaying"),
    playFromPlaylist: (playlistIndex, trackIndex) =>
        ipcRenderer.invoke("itunes:playFromPlaylist", playlistIndex, trackIndex),
    // playByPersistentId: (pid) => ipcRenderer.invoke("itunes:playByPersistentId", pid),
    // playByDatabaseId: (dbId) => ipcRenderer.invoke("itunes:playByDatabaseId", dbId),
    // playByTrackId: (trackId) => ipcRenderer.invoke("itunes:playByTrackId", trackId),
    pause: () => ipcRenderer.invoke("itunes:pause"),
    play: () => ipcRenderer.invoke("itunes:play"),
    next: () => ipcRenderer.invoke("itunes:next"),
    listPlaylists: () => ipcRenderer.invoke("itunes:listPlaylists"),
    listTracks: (playlistIndex) => ipcRenderer.invoke("itunes:listTracks", playlistIndex),
  },
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  spotifyConnect: () => ipcRenderer.invoke("spotify:connect"),

});
