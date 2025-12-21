// Renderer-side Apple Music helpers (extracted from app.js)
// Exports: APPLE_DEV_TOKEN_URL, getAppleUserToken, fetchAppleDeveloperToken,
// ensureAppleConfigured, appleFetch, appleCatalogFetch, appleEnsureAuthorized,
// appleResolveCatalogSongId, applePlayTrack, applePause, applePlay, appleNext, appleSetVolume

let wiredForInstance = null;
let appleState = { isPlaying: false, positionMs: 0, durationMs: 0 };
let appleWired = false;
let applePlayInFlight = null;


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
  const waitFor = async (fn, timeoutMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };

  // 1) Wait for MusicKit global
  const hasMK = await waitFor(() => window.MusicKit && typeof window.MusicKit.configure === "function");
  if (!hasMK) throw new Error("MusicKit not ready yet (script still loading).");

  // 2) Configure once (developer token)
  let devToken = localStorage.getItem("syncsong:appleDevToken");
  if (!devToken) devToken = await fetchAppleDeveloperToken();

  if (!window.__appleConfiguredPromise) {
    window.__appleConfiguredPromise = window.MusicKit.configure({
      developerToken: devToken,
      app: { name: "SyncSong", build: "1.0.0" },
    }).then(() => {
      window.__appleConfigured = true;
    });
  }
  await window.__appleConfiguredPromise;

  // 3) Wait for instance to exist
  const mk = await waitFor(() => window.MusicKit.getInstance && window.MusicKit.getInstance(), 15000);
  if (!mk) throw new Error("MusicKit instance not available (not initialized yet).");

  return mk;
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

function applePathFromNext(next) {
  if (!next) return null;
  // Apple often returns "/v1/..." (or sometimes a full URL)
  if (next.startsWith("https://")) {
    const i = next.indexOf("/v1");
    next = i >= 0 ? next.slice(i) : next;
  }
  // appleFetch already prefixes "https://api.music.apple.com/v1"
  return next.startsWith("/v1") ? next.slice(3) : next; // -> "/me/library/..."
}

async function appleFetchAllPages(firstPath) {
  const out = [];
  let path = firstPath;
  while (path) {
    const data = await appleFetch(path);
    if (data?.data?.length) out.push(...data.data);
    path = applePathFromNext(data?.next);
  }
  return out;
}

// --- Apple playback state ---
export const appleCatalogIdCache = new Map(); // key: sourceId -> catalogSongId

export async function appleEnsureAuthorized() {
  await ensureAppleConfigured();

  // ✅ Always grab the live instance (don’t rely on a cached object)
  const mk = window.MusicKit.getInstance();

  if (!getAppleUserToken()) {
    const userToken = await mk.authorize();
    localStorage.setItem("syncsong:appleUserToken", userToken);
  }

  // ✅ Re-wire if instance changed
  if (wiredForInstance !== mk) {
    wiredForInstance = mk;
    appleWired = false;       // allow wiring again
    wireAppleEvents(mk);
  } else {
    wireAppleEvents(mk);
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

function trackKey(t) {
  return (
    t.isrc ||
    t.catalogId ||
    t.sourceId ||          // apple library id
    t.spotifyTrackId ||    // spotify id
    `${(t.title||"").toLowerCase()}|${(t.artist||"").toLowerCase()}|${(t.album||"").toLowerCase()}`
  );
}

// Resolve a playable catalog song id from a track (cache results)
export async function appleResolveCatalogSongId(track) {
  if (track.catalogId) return track.catalogId;

  const key = trackKey(track);
  if (appleCatalogIdCache.has(key)) return appleCatalogIdCache.get(key);

  const mk = await appleEnsureAuthorized();
  if (!mk) throw new Error("Apple Music not initialized. Click Connect Apple and try again.");

  const storefront = mk.storefrontId || "us";

  // If you have ISRC, prefer it (more accurate)
  let data = null;
  if (track.isrc) {
    try {
      data = await appleCatalogFetch(
        `/catalog/${storefront}/songs?filter[isrc]=${encodeURIComponent(track.isrc)}&limit=1`
      );
      const song = data?.data?.[0];
      const catalogId = song?.id || "";
      if (catalogId) {
        appleCatalogIdCache.set(key, catalogId);
        track.catalogId = catalogId;
        return catalogId;
      }
    } catch {}
  }

  // Fallback: title + artist search (your existing behavior)
  const term = encodeURIComponent(`${track.title} ${track.artist}`.trim());
  data = await appleCatalogFetch(`/catalog/${storefront}/search?types=songs&limit=5&term=${term}`);

  const song = data?.results?.songs?.data?.[0];
  const catalogId = song?.id || "";
  if (!catalogId) throw new Error("Could not resolve Apple catalog song id (search returned nothing).");

  appleCatalogIdCache.set(key, catalogId);
  track.catalogId = catalogId;
  return catalogId;
}


export async function applePlayTrack(track) {
  const mk = await appleEnsureAuthorized();
  const catalogId = await appleResolveCatalogSongId(track);

  if (track?.durationMs) appleState.durationMs = Number(track.durationMs) || appleState.durationMs;
  appleState.positionMs = 0;
  appleState.isPlaying = true;

  // Best-effort: ensure playback is paused first to avoid a brief blip
  try {
    if (typeof mk.pause === "function") await mk.pause();
  } catch {}

  // Helper: wait for the next mediaItemDidChange event (fallback to timeout)
  const waitForMediaItemChange = (timeoutMs = 800) => new Promise((resolve) => {
    let done = false;
    const handler = () => {
      if (done) return;
      done = true;
      try { mk.removeEventListener("mediaItemDidChange", handler); } catch {}
      resolve(true);
    };
    try { mk.addEventListener("mediaItemDidChange", handler); } catch {}
    setTimeout(() => {
      if (done) return;
      done = true;
      try { mk.removeEventListener("mediaItemDidChange", handler); } catch {}
      resolve(false);
    }, timeoutMs);
  });

  // Replace queue with the new song (wait briefly for the SDK to load the item)
  await mk.setQueue({ song: catalogId });

  try {
    // Wait for the SDK to report the new item (avoids playing the old item briefly)
    //await waitForMediaItemChange(800);
  } catch {}

  // Kick playback once the new item is available
  await applePlay();

  // Immediately sample player values once (helps even if events are flaky)
  try {
    appleState.isPlaying =
      mk.player?.playbackState === window.MusicKit?.PlaybackStates?.playing;
    appleState.positionMs = Math.floor((mk.player?.currentPlaybackTime || 0) * 1000);
    const d = Math.floor((mk.player?.currentPlaybackDuration || 0) * 1000);
    if (d > 0) appleState.durationMs = d;
  } catch {}
}

export async function applePause() {
  if (!getAppleUserToken()) return;
  const mk = await appleEnsureAuthorized();
  await mk.pause();
}

export async function applePlay() {
  if (applePlayInFlight) return applePlayInFlight;

  applePlayInFlight = (async () => {
    const mk = await appleEnsureAuthorized();

    const PLAYING = window.MusicKit?.PlaybackStates?.playing ?? 2;
    try {
      if (mk?.playbackState === PLAYING) return;
    } catch {}

    await mk.play();
  })();

  try {
    return await applePlayInFlight;
  } finally {
    applePlayInFlight = null;
  }
}

export async function appleNext() {
  const mk = await appleEnsureAuthorized();
  mk.skipToNextItem();
}

export async function appleSetVolume(v) {
  try {
    const mk = await ensureAppleConfigured();
    const vol = Math.max(0, Math.min(1, Number(v)));
    // MusicKit volume is 0..1; set on instance if available
    if (typeof mk.volume !== "undefined") mk.volume = vol;
    else if (mk.player && typeof mk.player.volume !== "undefined") mk.player.volume = vol;
  } catch {}
}


// Playlist & library helpers
export async function loadApplePlaylistsAndTracks() {
  await ensureAppleConfigured();

  if (!getAppleUserToken()) {
    return { playlists: [], tracks: [], note: "Sign in with Apple Music to load your library playlists." };
  }

  const pls = await appleFetchAllPages("/me/library/playlists?limit=100");

  const playlists = pls.map(p => ({ id: p.id, name: p.attributes?.name || "Untitled" }));
  return { playlists };
}

export async function loadAppleTracks(playlistId) {
  localStorage.setItem("syncsong:lastApplePlaylistId", String(playlistId));

  const items = await appleFetchAllPages(`/me/library/playlists/${playlistId}/tracks?limit=100`);

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
    const art = t.attributes?.artwork;
    const artworkUrl = art
      ? art.url.replace("{w}", "300").replace("{h}", "300")
      : "";
    return {
      id: cryptoRandomId(),
      source: "apple",
      sourceId: t.id,
      isrc: t.attributes?.isrc || "",
      title: t.attributes?.name || "Unknown",
      artist: t.attributes?.artistName || "Unknown",
      album: t.attributes?.albumName || "",
      durationMs: t.attributes?.durationInMillis || 0,

      // ✅ prefer API url, otherwise fall back to a search URL
      url: directUrl || appleFallbackUrlFromTrack(t),

      catalogId: "", // <-- we will resolve this when we need to play

      artworkUrl,
    };
  });

  return { tracks };
}

export async function appleSeek(seconds) {
  const mk = await appleEnsureAuthorized();
  // MusicKit uses seconds
  mk.seekToTime(Number(seconds) || 0);
}

export async function applePrev() {
  const mk = await appleEnsureAuthorized();
  mk.skipToPreviousItem();
}

export async function appleGetPlaybackState() {
  const mk = await appleEnsureAuthorized();
  wireAppleEvents(mk);

  // Try to refresh from instance fields (v3) if they exist
  const t = mk?.playbackTime ?? mk?.currentPlaybackTime;
  if (typeof t === "number" && Number.isFinite(t)) {
    appleState.positionMs = Math.floor(t * 1000);
  }

  const d = mk?.playbackDuration ?? mk?.currentPlaybackDuration;
  if (typeof d === "number" && Number.isFinite(d) && d > 0) {
    appleState.durationMs = Math.floor(d * 1000);
  }

  const state = mk?.playbackState;
  const PLAYING = window.MusicKit?.PlaybackStates?.playing ?? 2;
  if (typeof state !== "undefined") {
    appleState.isPlaying = state === PLAYING;
  }

  return { ...appleState };
}


function wireAppleEvents(mk) {
  if (appleWired || !mk?.addEventListener) return;
  appleWired = true;

  // playbackStateDidChange payload in MusicKit Web is numeric (forums examples show {state: 2/3...}). :contentReference[oaicite:2]{index=2}
  mk.addEventListener("playbackStateDidChange", (e) => {
    const state = e?.state ?? mk?.playbackState;
    const PLAYING = window.MusicKit?.PlaybackStates?.playing ?? 2;
    appleState.isPlaying = state === PLAYING;
  });

  mk.addEventListener("playbackTimeDidChange", (e) => {
    // Prefer event payload; fall back to instance fields if present
    const t =
      e?.playbackTime ??
      e?.currentPlaybackTime ??
      mk?.playbackTime ??
      mk?.currentPlaybackTime;

    if (typeof t === "number" && Number.isFinite(t)) {
      appleState.positionMs = Math.floor(t * 1000);
    }

    const d =
      e?.playbackDuration ??
      e?.currentPlaybackDuration ??
      mk?.playbackDuration ??
      mk?.currentPlaybackDuration;

    if (typeof d === "number" && Number.isFinite(d) && d > 0) {
      appleState.durationMs = Math.floor(d * 1000);
    }
  });

  mk.addEventListener("mediaItemDidChange", (e) => {
    appleState.positionMs = 0;

    const d =
      e?.playbackDuration ??
      e?.currentPlaybackDuration ??
      mk?.playbackDuration ??
      mk?.currentPlaybackDuration;

    if (typeof d === "number" && Number.isFinite(d) && d > 0) {
      appleState.durationMs = Math.floor(d * 1000);
    }
  });
}

