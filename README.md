# SyncSong

SyncSong is a web app that lets friends listen to a shared music queue together using **Spotify and Apple Music**, with real-time playback control and synchronization.

The goal is to make it easy for multiple people to listen to the same queue — even when tracks come from different platforms.

---

## Features

- 🎧 Shared listening sessions
- 🔄 Real-time sync via WebSockets
- 🎵 Spotify and Apple Music support
- ⏭ Host-controlled playback (play / pause / next / previous)
- 📃 Shared queue management

---

## Current Limitations

### Users
Due to Spotify developer restrictions, only 25 Spotify users can be supported. Each user has to be manually added so a request to the developer needs to be made.

### Spotify Playlists
Due to Spotify Web API restrictions:

- **Playlists created by Spotify (editorial / algorithmic playlists) do not load**
- **User-created playlists work normally**
- If a Spotify playlist doesn’t load, make a copy of it in Spotify and use the copied version

This is an API limitation, not a bug in SyncSong.

---

## Tech Stack

- Frontend: Vanilla JavaScript + HTML + CSS
- Build tool: Vite
- Backend: Node.js
- Real-time sync: WebSockets
- APIs:
  - Spotify Web API + Web Playback SDK
  - Apple Music (MusicKit JS)

---

## Development

### Install
```bash
npm install
```
Run locally
```bash
npm run dev
```
The app will be available at:
http://localhost:5173

Notes
This project started as an Electron app and was later converted to a web app.

Some Electron-related files or logic may still exist.

This is an early-stage project primarily used by friends for testing.

License
Private / experimental project. Not intended for production use.