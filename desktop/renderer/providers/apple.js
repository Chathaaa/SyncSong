// Renderer-side Apple Music helpers (extracted from app.js)
// Exports: APPLE_DEV_TOKEN_URL, getAppleUserToken, fetchAppleDeveloperToken,
// ensureAppleConfigured, appleFetch, appleCatalogFetch, appleEnsureAuthorized,
// appleResolveCatalogSongId, applePlayTrack, applePause, applePlay, appleNext

export const APPLE_DEV_TOKEN_URL = "https://syncsong-2lxp.onrender.com/apple/dev-token";

export function getAppleUserToken() {
  return localStorage.getItem("syncsong:appleUserToken") || null;
}

export async function fetchAppleDeveloperToken() {
  const res = await fetch(APPLE_DEV_TOKEN_URL);
  if (!res.ok) throw new Error("Failed to fetch Apple developer token");
  const json = await res.json();
  if (!json?.token) throw new Error("Apple developer token missing from server response");
  localStorage.setItem("syncsong:appleDevToken", json.token);
  return json.token;
}

export async function ensureAppleConfigured() {
  // MusicKit script is loaded via index.html
  if (!window.MusicKit) throw new Error("MusicKit not loaded. Check CSP + script tag.");

  let devToken = localStorage.getItem("syncsong:appleDevToken");
  if (!devToken) devToken = await fetchAppleDeveloperToken();

  if (!window.__appleConfigured) {
    window.MusicKit.configure({
      developerToken: devToken,
      app: { name: "SyncSong", build: "1.0.0" },
    });
    window.__appleConfigured = true;
  }
  return window.MusicKit.getInstance();
}

export async function appleFetch(path) {
  const devToken = localStorage.getItem("syncsong:appleDevToken");
  const userToken = getAppleUserToken();
  if (!devToken) throw new Error("Apple dev token missing. Click Connect Apple.");
  if (!userToken) throw new Error("Apple not authorized. Click Connect Apple.");

  const res = await fetch(`https://api.music.apple.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${devToken}`,
      "Music-User-Token": userToken,
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.errors?.[0]?.detail || `Apple Music API error: ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

// --- Apple playback state ---
export const appleCatalogIdCache = new Map(); // key: sourceId -> catalogSongId

export async function appleEnsureAuthorized() {
  const mk = await ensureAppleConfigured();
  if (!getAppleUserToken()) {
    // If not authorized yet, this will pop the sign-in
    const userToken = await mk.authorize();
    localStorage.setItem("syncsong:appleUserToken", userToken);
  }
  return mk;
}

// Catalog endpoints do NOT require Music-User-Token, only Developer Token
export async function appleCatalogFetch(path) {
  const devToken = localStorage.getItem("syncsong:appleDevToken");
  if (!devToken) throw new Error("Apple dev token missing.");
  const res = await fetch(`https://api.music.apple.com/v1${path}`, {
    headers: { Authorization: `Bearer ${devToken}` }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.errors?.[0]?.detail || `Apple catalog error: ${res.status}`);
  return json;
}

// Resolve a playable catalog song id from a track (cache results)
export async function appleResolveCatalogSongId(track) {
  if (track.catalogId) return track.catalogId;
  if (appleCatalogIdCache.has(track.sourceId)) return appleCatalogIdCache.get(track.sourceId);

  const mk = await appleEnsureAuthorized();
  const storefront = mk.storefrontId || "us";

  const term = encodeURIComponent(`${track.title} ${track.artist}`.trim());
  const data = await appleCatalogFetch(`/catalog/${storefront}/search?types=songs&limit=5&term=${term}`);

  const song = data?.results?.songs?.data?.[0];
  const catalogId = song?.id || "";

  if (!catalogId) throw new Error("Could not resolve Apple catalog song id (search returned nothing).");

  appleCatalogIdCache.set(track.sourceId, catalogId);
  track.catalogId = catalogId; // also mutate local track object for reuse
  return catalogId;
}

export async function applePlayTrack(track) {
  const mk = await appleEnsureAuthorized();
  const catalogId = await appleResolveCatalogSongId(track);

  // Replace queue with a single song and start playing
  await mk.setQueue({ song: catalogId, startPlaying: true });
}

export async function applePause() {
  const mk = await appleEnsureAuthorized();
  mk.pause();
}

export async function applePlay() {
  const mk = await appleEnsureAuthorized();
  mk.play();
}

export async function appleNext() {
  const mk = await appleEnsureAuthorized();
  mk.skipToNextItem();
}

// Playlist & library helpers
export async function loadApplePlaylistsAndTracks() {
  await ensureAppleConfigured();

  if (!getAppleUserToken()) {
    return { playlists: [], tracks: [], note: "Click \u201CConnect Apple\u201D to load your library playlists." };
  }

  const data = await appleFetch("/me/library/playlists?limit=100");
  const pls = data.data || [];

  const playlists = pls.map(p => ({ id: p.id, name: p.attributes?.name || "Untitled" }));
  return { playlists };
}

export async function loadAppleTracks(playlistId) {
  localStorage.setItem("syncsong:lastApplePlaylistId", String(playlistId));

  const data = await appleFetch(`/me/library/playlists/${playlistId}/tracks?limit=100`);
  const items = data.data || [];

  function appleFallbackUrlFromTrack(t) {
    const name = t.attributes?.name || "";
    const artist = t.attributes?.artistName || "";
    const q = encodeURIComponent(`${name} ${artist}`.trim());
    // Always works even when library track has no url
    return q ? `https://music.apple.com/search?term=${q}` : "";
  }

  function cryptoRandomId() {
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  const tracks = items.map(t => {
    const directUrl = t.attributes?.url || "";

    return {
      id: cryptoRandomId(),
      source: "apple",
      sourceId: t.id,

      title: t.attributes?.name || "Unknown",
      artist: t.attributes?.artistName || "Unknown",
      album: t.attributes?.albumName || "",
      durationMs: t.attributes?.durationInMillis || 0,

      // ✅ prefer API url, otherwise fall back to a search URL
      url: directUrl || appleFallbackUrlFromTrack(t),

      catalogId: "", // <-- we will resolve this when we need to play

      artworkUrl: t.attributes?.artwork?.url
        ? t.attributes.artwork.url.replace("{w}", "120").replace("{h}", "120")
        : "",
    };
  });

  return { tracks };
}
