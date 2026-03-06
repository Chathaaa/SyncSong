# SyncSong

SyncSong is a social listening app where friends join a shared room and listen to the same queue together, with real-time playback sync and host-managed controls.

It currently supports Spotify and Apple Music playback paths and a live shared queue over WebSockets.

## Why It Exists

Most group listening tools assume everyone uses one platform. SyncSong focuses on keeping a group session coordinated even when users come from different ecosystems.

## Features

- Shared listening rooms with short room codes
- Real-time queue and playback state sync over WebSockets
- Spotify and Apple Music provider integrations
- Host controls for play/pause/seek/next/previous
- Optional guest-control mode and party mode

## Current Limitations

### Spotify developer mode cap

Spotify limits this app to approved test users in development mode (currently up to 25 users). New users must be added manually in the Spotify developer dashboard before Spotify playback works for them.

### Spotify playlist API caveat

Some Spotify-owned editorial/algorithmic playlists do not return tracks through the Web API. User-created playlists generally work.

If a playlist fails to load, copy it into your own Spotify account and use the copied playlist.

## Tech Stack

- Frontend: Vanilla JavaScript, HTML, CSS
- Frontend tooling: Vite (`desktop/`)
- Backend: Node.js + WebSocket server (`server/`)
- Music APIs:
  - Spotify Web API + Web Playback SDK
  - Apple Music (MusicKit JS + server-issued dev token)

## Repo Structure

```text
SyncSong/
  desktop/   # Vite web client
  server/    # Node HTTP + WebSocket backend
```

## Local Development

### 1) Install dependencies

```bash
cd desktop && npm install
cd ../server && npm install
```

### 2) Run backend

```bash
cd server
npm start
```

Default backend port is `3000`.

### 3) Run frontend

In a second terminal:

```bash
cd desktop
npm run dev
```

Default frontend URL is `http://localhost:5173`.

## Backend Environment Variables

The server can run with minimal config, but Apple token issuance and deploy behavior depend on env vars:

- `PORT` (optional, default `3000`)
- `CORS_ORIGINS` (optional, default `*`; comma-separated)
- `DISCORD_FEEDBACK_WEBHOOK` (optional)
- `APPLE_PRIVATE_KEY_P8_BASE64` (required for Apple dev token endpoint)
- `APPLE_TEAM_ID` (required for Apple dev token endpoint)
- `APPLE_KEY_ID` (required for Apple dev token endpoint)
- `APPLE_DEV_TOKEN_TTL_DAYS` (optional, default `180`)
- `APPLE_DEV_TOKEN_CACHE_SKEW_SECONDS` (optional, default `300`)
- `DISCORD_ACTIVITY_JWT_SECRET` (required for Discord Activity auth token minting)
- `DISCORD_APPLICATION_ID` (recommended in production; verifies bearer token belongs to your Discord app)
- `DISCORD_CLIENT_ID` (required for Discord OAuth code exchange; usually same as `DISCORD_APPLICATION_ID`)
- `DISCORD_CLIENT_SECRET` (required for Discord OAuth code exchange)
- `DISCORD_OAUTH_REDIRECT_URI` (optional; set if your Discord OAuth app config requires it)
- `DISCORD_ACTIVITY_ALLOW_INSECURE_DEV` (optional, set `1` for local dev only; do not enable in production)

Discord Activity notes:
- In Activity mode (`?mode=discord_activity`), clients can request a SyncSong token from `/discord/activity/token`.
- Activity client auth flow now uses Discord Embedded App SDK (`authorize`) and backend OAuth code exchange at `/discord/activity/oauth/token`.
- Production path expects a Discord bearer token (Authorization header) that the server verifies via Discord API.
- Sessions are now bound to Discord `activityInstanceId`; other participants in the same Activity can auto-join via WebSocket (`session:autoJoinActivity`).

Frontend env:
- `VITE_DISCORD_CLIENT_ID` (required for Embedded App SDK initialization in the web client)

## Project Status

This is an active personal project and still evolving. APIs, flows, and deployment assumptions may change while core sync behavior is hardened.

## Roadmap

- Better onboarding and auth UX for first-time users
- Stronger queue conflict handling and reconnection behavior
- Automated tests for core room/session behavior
- Better observability around playback drift and sync events

## License

This project is licensed under the PolyForm Noncommercial License 1.0.0. See the [LICENSE](LICENSE) file for details.

Commercial use is not permitted without a separate written agreement.


