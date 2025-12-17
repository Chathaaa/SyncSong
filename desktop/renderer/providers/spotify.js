// Renderer-side Spotify helpers (extracted from app.js)
// Exports useful functions the app uses: getSpotifyAccessToken, spotifyFetch, spotifyApi,
// ensureSpotifyWebPlayer, spotifyPlayUriInApp

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

function getStoredClientId() {
  return localStorage.getItem("spotify:client_id") || "e87ab2180d5a438ba6f23670e3c12f3d";
}

function tokenIsValidSoon() {
  const tok = localStorage.getItem("spotify:access_token") || "";
  const exp = Number(localStorage.getItem("spotify:expires_at") || "0");
  if (!tok) return false;
  // treat as expired if within 60s of expiry
  return !exp || Date.now() < exp - 60_000;
}

export async function spotifyRefreshAccessToken() {
  const refreshToken = localStorage.getItem("spotify:refresh_token") || "";
  if (!refreshToken) throw new Error("No Spotify refresh token (need to connect once).");

  const clientId = getStoredClientId();

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error_description || "Spotify refresh failed");

  // Spotify may not return refresh_token on refresh; keep the old one.
  if (json.access_token) localStorage.setItem("spotify:access_token", json.access_token);
  if (json.expires_in) localStorage.setItem("spotify:expires_at", String(Date.now() + json.expires_in * 1000));
  if (json.refresh_token) localStorage.setItem("spotify:refresh_token", json.refresh_token);

  return json.access_token;
}

export async function spotifyEnsureAccessToken() {
  if (tokenIsValidSoon()) return localStorage.getItem("spotify:access_token");
  // try silent refresh
  return spotifyRefreshAccessToken();
}

export function getSpotifyAccessToken() {
  const tok = localStorage.getItem("spotify:access_token") || "";
  const exp = Number(localStorage.getItem("spotify:expires_at") || "0");
  if (!tok) return null;
  if (exp && Date.now() > exp - 10_000) return null;
  return tok;
}

// small helper used by search heuristics
function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function cryptoRandomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

export async function spotifyFetch(path, opts = {}) {
  const token = await spotifyEnsureAccessToken();
  if (!token) throw new Error("Spotify not connected. Click Connect Spotify.");

  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {})
    },
    body: opts.body
  });

  // Many player endpoints return 204 No Content on success
  if (res.status === 204) return null;

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Spotify API error: ${res.status}`);
  return json;
}

export async function spotifyApi(path, opts = {}) {
  return spotifyFetch(path, opts);
}

let spotifyPlayer = null;
let spotifyDeviceId = null;
let deviceReadyPromise = null;

export async function spotifyTransferToThisAppDevice() {
  if (!spotifyDeviceId) return;

  // PUT /me/player to transfer playback to the SDK device
  await spotifyApi("/me/player", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_ids: [spotifyDeviceId], play: false })
  });
}

// The Spotify Web Playback SDK will call this when it loads on the page
window.onSpotifyWebPlaybackSDKReady = () => {
  console.log("[spotify] Web Playback SDK ready");
};

function waitForDeviceId({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (spotifyDeviceId) {
        clearInterval(timer);
        resolve(spotifyDeviceId);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error("Spotify device_id not ready yet."));
      }
    }, 100);
  });
}

export async function ensureSpotifyWebPlayer() {
  if (spotifyPlayer) return spotifyPlayer;

  const token = getSpotifyAccessToken();
  if (!token) throw new Error("Spotify not connected (token missing/expired).");

  if (!window.Spotify || !window.Spotify.Player) {
    throw new Error("Spotify SDK not loaded (check CSP + script tag).");
  }

  spotifyPlayer = new window.Spotify.Player({
    name: "SyncSong (In-App)",
    getOAuthToken: (cb) => cb(getSpotifyAccessToken() || ""),
    volume: 0.8,
  });

  deviceReadyPromise = deviceReadyPromise || new Promise((resolve) => {
    spotifyPlayer.addListener("ready", async ({ device_id }) => {
      spotifyDeviceId = device_id;
      console.log("[spotify] ready device_id=", device_id);
      try { await spotifyTransferToThisAppDevice(); } catch (e) { console.warn("[spotify] transfer failed:", e); }
      resolve(device_id);
    });
  });

  spotifyPlayer.addListener("not_ready", ({ device_id }) => {
    console.log("[spotify] device offline", device_id);
    if (spotifyDeviceId === device_id) spotifyDeviceId = null;
  });

  spotifyPlayer.addListener("authentication_error", ({ message }) =>
    console.error("[spotify] auth error", message)
  );

  const ok = await spotifyPlayer.connect();
  if (!ok) throw new Error("Spotify player connect() failed.");

  return spotifyPlayer;
}

export async function spotifyPlayUriInApp(spotifyUri) {
  if (!spotifyUri) throw new Error("Missing spotifyUri on track.");

  await ensureSpotifyWebPlayer();
  await (deviceReadyPromise || waitForDeviceId()); // <- wait for ready

  if (!spotifyDeviceId) throw new Error("Spotify device_id not ready yet.");

  await spotifyApi(`/me/player/play?device_id=${encodeURIComponent(spotifyDeviceId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uris: [spotifyUri] }),
  });
}

// Playlist & search helpers
export async function loadSpotifyPlaylistsAndTracks() {
  const tok = getSpotifyAccessToken();
  if (!tok) throw new Error("Spotify not connected. Click Connect Spotify.");

  const data = await spotifyFetch("/me/playlists?limit=50");
  const pls = data.items || [];

  const playlists = pls.map(p => ({ id: p.id, name: p.name }));

  // load tracks for selected playlist id (caller may call loadSpotifyTracks)
  return { playlists };
}

export async function loadSpotifyTracks(playlistId) {
  localStorage.setItem("syncsong:lastSpotifyPlaylistId", String(playlistId));

  const data = await spotifyFetch(`/playlists/${playlistId}/tracks?limit=100`);
  const items = data.items || [];

  const tracks = items
    .map(it => it.track)
    .filter(Boolean)
    .map(t => ({
      id: cryptoRandomId(),
      source: "spotify",
      title: t.name,
      artist: t.artists?.[0]?.name || "Unknown",
      album: t.album?.name || "",
      durationMs: t.duration_ms || 0,
      spotifyTrackId: t.id,
      spotifyUri: t.uri,
      //spotifyUrl: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : ""),
      artworkUrl: t.album?.images?.[0]?.url || "",

    }));

  return { tracks };
}

export async function spotifyFindUriForTrack(track) {
  if (track.source === "spotify" && track.spotifyUri) return track.spotifyUri;

  // If ISRC exists, this is the best match
  if (track.isrc) {
    const q = encodeURIComponent(`isrc:${track.isrc}`);
    const res = await spotifyFetch(`/search?type=track&limit=1&q=${q}`);
    const hit = res?.tracks?.items?.[0];
    if (hit?.uri) return hit.uri;
  }

  // Fallback: title + artist (your existing behavior)
  const q = encodeURIComponent(`${track.title} ${track.artist}`.trim());
  const res = await spotifyFetch(`/search?type=track&limit=5&q=${q}`);

  const items = res?.tracks?.items || [];
  if (!items.length) return null;

  const best = items[0];
  return best?.uri || null;
}

export async function spotifyWebConnect() {
  const SPOTIFY_CLIENT_ID = "e87ab2180d5a438ba6f23670e3c12f3d"; // same one you use in Electron
  const redirectUri = `${window.location.origin}/spotify-callback.html`;

  // PKCE
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...verifierBytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

  async function sha256(str) {
    const data = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return new Uint8Array(digest);
  }

  function b64url(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  const challenge = b64url(await sha256(verifier));

  const state = Math.random().toString(16).slice(2) + Date.now().toString(16);

  localStorage.setItem("spotify:pkce_verifier", verifier);
  localStorage.setItem("spotify:client_id", SPOTIFY_CLIENT_ID);
  localStorage.setItem("spotify:redirect_uri", redirectUri);
  localStorage.setItem("spotify:oauth_state", state);

  const scopes = [
    "playlist-read-private",
    "playlist-read-collaborative",
    "streaming",
    "user-modify-playback-state",
    "user-read-playback-state",
  ].join(" ");

  const authUrl =
    "https://accounts.spotify.com/authorize" +
    `?client_id=${encodeURIComponent(SPOTIFY_CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge_method=S256` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${encodeURIComponent(state)}` +
    `&show_dialog=true`;

  // Popup window
  const w = window.open(authUrl, "spotify_auth", "width=520,height=680");
  if (!w) throw new Error("Popup blocked. Allow popups and try again.");
}


export async function spotifyPlay() {
  const p = await ensureSpotifyWebPlayer();
  await p.resume();
}

export async function spotifyPause() {
  const p = await ensureSpotifyWebPlayer();
  await p.pause();
}

export async function spotifySeek(seconds) {
  const p = await ensureSpotifyWebPlayer();
  // SDK expects milliseconds
  await p.seek(Math.max(0, Math.floor(seconds * 1000)));
}

export async function spotifyNext() {
  await ensureSpotifyWebPlayer(); // ensure device exists/active
  await spotifyApi("/me/player/next", { method: "POST" });
}

export async function spotifyPrev() {
  await ensureSpotifyWebPlayer();
  await spotifyApi("/me/player/previous", { method: "POST" });
}

// Helpful for UI progress + play state
export async function spotifyGetPlaybackState() {
  const p = await ensureSpotifyWebPlayer();
  return p.getCurrentState(); // { paused, position, duration, track_window, ... } or null
}