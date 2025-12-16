const WS_URL = "wss://syncsong-2lxp.onrender.com";

let ws;
let userId = null;
let sessionId = null;
let hostUserId = null;

let queue = [];
let nowPlaying = null;

// unified music panel state
let musicSource = localStorage.getItem("syncsong:lastSource") || "itunes"; // "itunes" | "spotify | "apple"
let playlists = [];      // [{id,name}]
let tracks = [];         // unified track objects
let tracksFiltered = [];

let currentItunesPlaylistIndex = null;

// session + UX helpers
let pendingAddTrack = null;
let pendingCreate = false;

// playback behavior
let loopQueue = true; // default
let autoAdvanceLock = false;

// UI helpers
const el = (id) => document.getElementById(id);

function send(type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, payload }));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

function cryptoRandomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// ---------- Clipboard / Share ----------
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      document.body.removeChild(ta);
      return false;
    }
  }
}

function getInviteText() {
  return `Join my SyncSong session: ${sessionId}\n\nOpen the app → paste the code → Join.`;
}

function renderShareButton() {
  const btn = el("copySession");
  if (!btn) return;

  if (!sessionId) {
    btn.style.display = "none";
    return;
  }
  btn.style.display = "inline-block";
}

async function autoCopyInvitePulse() {
  const btn = el("copySession");
  if (!btn || !sessionId) return;

  const ok = await copyTextToClipboard(getInviteText());
  if (ok) {
    const old = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = old), 1200);
  }
}

// ---------- Session meta ----------
function renderSessionMeta() {
  const isHost = userId && hostUserId && userId === hostUserId;
  el("sessionMeta").textContent = sessionId
    ? `Session: ${sessionId} ${isHost ? "(Host)" : ""}`
    : "No session";
  renderShareButton();
}

// ---------- WS ----------
function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    el("sessionMeta").textContent = "Connected";
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "hello") {
      userId = msg.userId;
      return;
    }

    if (msg.type === "session:created") {
      sessionId = msg.sessionId;
      pendingCreate = false;
      renderSessionMeta();

      // If user clicked +Add before session existed, add now
      if (pendingAddTrack) {
        const t = pendingAddTrack;
        pendingAddTrack = null;
        send("queue:add", { sessionId, track: t });
        // auto-copy invite for convenience
        setTimeout(() => autoCopyInvitePulse(), 50);
      } else {
        // created manually; still nice to copy
        setTimeout(() => autoCopyInvitePulse(), 50);
      }
      return;
    }

    if (msg.type === "session:state") {
      sessionId = msg.sessionId;
      hostUserId = msg.hostUserId;
      queue = msg.queue || [];
      nowPlaying = msg.nowPlaying || null;
      renderSessionMeta();
      renderQueue();
      renderNowPlaying();
      syncAppleClientToNowPlaying();
      return;
    }

    if (msg.type === "queue:updated") {
      queue = msg.queue || [];
      renderQueue();
      return;
    }

    if (msg.type === "nowPlaying:updated") {
      nowPlaying = msg.nowPlaying || null;
      renderNowPlaying();
      syncAppleClientToNowPlaying();
      return;
    }

    if (msg.type === "error") {
      el("sessionMeta").textContent = `Error: ${msg.message}`;
    }
  };

  ws.onclose = () => {
    el("sessionMeta").textContent = "Disconnected (reconnect in 2s)";
    setTimeout(connectWS, 2000);
  };
}

// ---------- Unified music panel ----------
const LAST_SOURCE_KEY = "syncsong:lastSource";
const LAST_ITUNES_PLAYLIST_KEY = "syncsong:lastItunesPlaylistIndex";
const LAST_SPOTIFY_PLAYLIST_KEY = "syncsong:lastSpotifyPlaylistId";

const LAST_APPLE_PLAYLIST_KEY = "syncsong:lastApplePlaylistId";
const APPLE_DEV_TOKEN_KEY = "syncsong:appleDevToken";
const APPLE_USER_TOKEN_KEY = "syncsong:appleUserToken";

// IMPORTANT: set this to your server endpoint that returns { token: "..." }
const APPLE_DEV_TOKEN_URL = "https://syncsong-2lxp.onrender.com/apple/dev-token";

// Spotify token helpers (renderer-side API calls)
function getSpotifyAccessToken() {
  const tok = localStorage.getItem("spotify:access_token") || "";
  const exp = Number(localStorage.getItem("spotify:expires_at") || "0");
  if (!tok) return null;
  if (exp && Date.now() > exp - 10_000) return null;
  return tok;
}

async function spotifyFetch(path) {
  const token = getSpotifyAccessToken();
  if (!token) throw new Error("Spotify not connected (or token expired). Click Connect Spotify.");

  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Spotify API error: ${res.status}`);
  return json;
}

function renderMusicTabs() {
  el("sourceItunes")?.classList.toggle("active", musicSource === "itunes");
  el("sourceSpotify")?.classList.toggle("active", musicSource === "spotify");
  el("sourceApple")?.classList.toggle("active", musicSource === "apple");

  el("connectSpotify").style.display = (musicSource === "spotify") ? "inline-block" : "none";
  el("connectApple").style.display = (musicSource === "apple") ? "inline-block" : "none";
}

function renderLoopToggle() {
  const btn = el("toggleLoop");
  if (!btn) return;
  btn.textContent = `Loop: ${loopQueue ? "On" : "Off"}`;
}

function clearMusicPanel() {
  playlists = [];
  tracks = [];
  tracksFiltered = [];
  const sel = el("musicPlaylists");
  const box = el("musicTracks");
  if (sel) sel.innerHTML = "";
  if (box) box.innerHTML = "";
}

function renderMusicPlaylists() {
  const sel = el("musicPlaylists");
  if (!sel) return;

  sel.innerHTML = "";
  playlists.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = String(p.id);
    opt.textContent = p.name;
    sel.appendChild(opt);
  });

  if (!playlists.length) return;

  let desired = null;
  if (musicSource === "itunes") desired = localStorage.getItem(LAST_ITUNES_PLAYLIST_KEY);
  if (musicSource === "spotify") desired = localStorage.getItem(LAST_SPOTIFY_PLAYLIST_KEY);
  if (musicSource === "apple") desired = localStorage.getItem(LAST_APPLE_PLAYLIST_KEY);

  const exists = desired && playlists.some(p => String(p.id) === String(desired));
  const initialId = exists ? String(desired) : String(playlists[0].id);

  sel.value = initialId;
}

function applySearch() {
  const q = (el("searchMine")?.value || "").toLowerCase().trim();
  tracksFiltered = !q
    ? tracks
    : tracks.filter((t) =>
        `${t.title} ${t.artist} ${t.album || ""}`.toLowerCase().includes(q)
      );
  renderMusicTracks();
}

function renderMusicTracks() {
  const box = el("musicTracks");
  if (!box) return;

  box.innerHTML = "";
  tracksFiltered.forEach((t) => {
    const row = document.createElement("div");
    row.className = "item";

    const extraBtn =
      t.source === "spotify"
        ? `<button data-open="${t.id}">Open</button>`
        : ``;

    row.innerHTML = `
        <div class="left">
            <div class="title">${escapeHtml(t.title)}</div>
            <div class="meta">${escapeHtml(t.artist)} • ${escapeHtml(t.album || "")} • ${fmtMs(t.durationMs)}</div>
        </div>
        <div class="actions">
            <button data-add="${t.id}">+ Add</button>
            <button data-open="${t.id}" ${(t.source === "spotify" || t.source === "apple") ? "" : "disabled"}>Open</button>
        </div>
        `;

    row.querySelector("[data-add]").addEventListener("click", () => addToQueue(t));

    const canOpen = (t.source === "spotify" && t.spotifyUri) || (t.source === "apple" && t.url);

    row.querySelector("[data-open]").toggleAttribute("disabled", !canOpen);

    row.querySelector("[data-open]").addEventListener("click", async () => {
      if (t.source === "spotify") {
        const ok = await window.api.openExternal(t.spotifyUri);
        if (!ok && t.spotifyUrl) await window.api.openExternal(t.spotifyUrl);
      } else if (t.source === "apple") {
        //await window.api.openExternal(t.url);
      }
    });

    box.appendChild(row);
  });
}

async function loadItunesPlaylistsAndTracks() {
  const ok = await window.api.itunes.available();
  if (!ok) throw new Error("iTunes not found. Please install iTunes.");

  const pls = await window.api.itunes.listPlaylists();
  playlists = pls.map(p => ({ id: String(p.index), name: p.name }));
  renderMusicPlaylists();

  const selId = el("musicPlaylists").value;
  await loadItunesTracks(selId);
}

async function loadItunesTracks(playlistIndex) {
  localStorage.setItem(LAST_ITUNES_PLAYLIST_KEY, String(playlistIndex));

  const raw = await window.api.itunes.listTracks(Number(playlistIndex));
  currentItunesPlaylistIndex = Number(playlistIndex);

  tracks = raw.map((t) => ({
    id: cryptoRandomId(),
    source: "itunes",
    title: t.title,
    artist: t.artist,
    album: t.album,
    durationMs: t.durationMs,

    itunesPlaylistIndex: currentItunesPlaylistIndex,
    itunesPlaylistTrackIndex: Number(t.trackIndex ?? 0),

    // optional ids (may be blank/0, but kept)
    itunesTrackId: Number(t.trackId ?? 0),
    itunesPersistentId: String(t.persistentId ?? ""),
  }));

  applySearch();
}

async function loadSpotifyPlaylistsAndTracks() {
  const tok = getSpotifyAccessToken();
  if (!tok) throw new Error("Spotify not connected. Click Connect Spotify.");

  const data = await spotifyFetch("/me/playlists?limit=50");
  const pls = data.items || [];

  playlists = pls.map(p => ({ id: p.id, name: p.name }));
  renderMusicPlaylists();

  const selId = el("musicPlaylists").value;
  await loadSpotifyTracks(selId);
}

async function loadSpotifyTracks(playlistId) {
  localStorage.setItem(LAST_SPOTIFY_PLAYLIST_KEY, String(playlistId));

  const data = await spotifyFetch(`/playlists/${playlistId}/tracks?limit=100`);
  const items = data.items || [];

  tracks = items
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
      spotifyUrl: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : ""),
    }));

  applySearch();
}

async function loadApplePlaylistsAndTracks() {
  await ensureAppleConfigured();

  if (!getAppleUserToken()) {
    playlists = [];
    tracks = [];
    renderMusicPlaylists();
    applySearch();
    el("sessionMeta").textContent = "Click “Connect Apple” to load your library playlists.";
    return;
  }

  const data = await appleFetch("/me/library/playlists?limit=100");
  const pls = data.data || [];

  playlists = pls.map(p => ({
    id: p.id,
    name: p.attributes?.name || "Untitled",
  }));

  renderMusicPlaylists();

  const selId = el("musicPlaylists")?.value;
  if (selId) await loadAppleTracks(selId);
}

async function loadAppleTracks(playlistId) {
  localStorage.setItem(LAST_APPLE_PLAYLIST_KEY, String(playlistId));

  const data = await appleFetch(`/me/library/playlists/${playlistId}/tracks?limit=100`);
  const items = data.data || [];

  function appleFallbackUrlFromTrack(t) {
    const name = t.attributes?.name || "";
    const artist = t.attributes?.artistName || "";
    const q = encodeURIComponent(`${name} ${artist}`.trim());
    // Always works even when library track has no url
    return q ? `https://music.apple.com/search?term=${q}` : "";
  }

  tracks = items.map(t => {
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
  applySearch();
}


// Apple Music helper functions

function getAppleUserToken() {
  return localStorage.getItem(APPLE_USER_TOKEN_KEY) || null;
}

async function fetchAppleDeveloperToken() {
  const res = await fetch(APPLE_DEV_TOKEN_URL);
  if (!res.ok) throw new Error("Failed to fetch Apple developer token");
  const json = await res.json();
  if (!json?.token) throw new Error("Apple developer token missing from server response");
  localStorage.setItem(APPLE_DEV_TOKEN_KEY, json.token);
  return json.token;
}

async function ensureAppleConfigured() {
  // MusicKit script is loaded via index.html
  if (!window.MusicKit) throw new Error("MusicKit not loaded. Check CSP + script tag.");

  let devToken = localStorage.getItem(APPLE_DEV_TOKEN_KEY);
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

async function appleFetch(path) {
  const devToken = localStorage.getItem(APPLE_DEV_TOKEN_KEY);
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
const appleCatalogIdCache = new Map(); // key: sourceId -> catalogSongId
let lastAppliedNowPlayingKey = "";     // prevents loops on repeated state messages

async function appleEnsureAuthorized() {
  const mk = await ensureAppleConfigured();
  if (!getAppleUserToken()) {
    // If not authorized yet, this will pop the sign-in
    const userToken = await mk.authorize();
    localStorage.setItem(APPLE_USER_TOKEN_KEY, userToken);
  }
  return mk;
}

// Catalog endpoints do NOT require Music-User-Token, only Developer Token
async function appleCatalogFetch(path) {
  const devToken = localStorage.getItem(APPLE_DEV_TOKEN_KEY);
  if (!devToken) throw new Error("Apple dev token missing.");
  const res = await fetch(`https://api.music.apple.com/v1${path}`, {
    headers: { Authorization: `Bearer ${devToken}` }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.errors?.[0]?.detail || `Apple catalog error: ${res.status}`);
  return json;
}

// Resolve a playable catalog song id from a track (cache results)
async function appleResolveCatalogSongId(track) {
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

async function applePlayTrack(track) {
  const mk = await appleEnsureAuthorized();
  const catalogId = await appleResolveCatalogSongId(track);

  // Replace queue with a single song and start playing
  await mk.setQueue({ song: catalogId, startPlaying: true });
}

async function applePause() {
  const mk = await appleEnsureAuthorized();
  mk.pause();
}

async function applePlay() {
  const mk = await appleEnsureAuthorized();
  mk.play();
}

async function appleNext() {
  const mk = await appleEnsureAuthorized();
  mk.skipToNextItem();
}


// ---------- Music reload ----------

async function reloadMusic() {
  if (musicSource === "itunes") return loadItunesPlaylistsAndTracks();
  if (musicSource === "spotify") return loadSpotifyPlaylistsAndTracks();
  return loadApplePlaylistsAndTracks();
}

function setSource(next) {
  musicSource = next;
  localStorage.setItem(LAST_SOURCE_KEY, musicSource);
  renderMusicTabs();
  reloadMusic();
}

// ---------- Queue + playback ----------
function ensureSessionForAdd(track) {
  if (sessionId) return true;

  pendingAddTrack = track;

  if (!pendingCreate) {
    pendingCreate = true;
    const displayName = (el("displayName").value || "Host").trim().slice(0, 32);
    send("session:create", { displayName });
    el("sessionMeta").textContent = "Creating session...";
  }
  return false;
}

function addToQueue(track) {
  if (!ensureSessionForAdd(track)) return;
  send("queue:add", { sessionId, track });
}

function renderQueue() {
  const box = el("queue");
  if (!box) return;

  box.innerHTML = "";
  const isHost = userId && hostUserId && userId === hostUserId;

  queue.forEach((q) => {
    const t = q.track;
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="left">
        <div class="title">${escapeHtml(t.title)}</div>
        <div class="meta">${escapeHtml(t.artist)} • added by ${escapeHtml(q.addedBy?.displayName || "someone")} • ${escapeHtml(t.source || "")}</div>
      </div>
      <div class="actions">
        ${isHost ? `<button data-play="${q.queueId}">Play</button>` : ``}
        ${isHost ? `<button data-remove="${q.queueId}">Remove</button>` : ``}
      </div>
    `;

    if (isHost) {
      row.querySelector("[data-play]").addEventListener("click", () => hostPlayQueueItem(q));
      row.querySelector("[data-remove]").addEventListener("click", () =>
        send("queue:remove", { sessionId, queueId: q.queueId })
      );
    }

    box.appendChild(row);
  });
}

async function hostPlayQueueItem(qItem) {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;

  autoAdvanceLock = false;

  // iTunes track: play via COM
  if (qItem.track.source === "itunes") {
    const pIdx = qItem.track.itunesPlaylistIndex;
    const tIdx = qItem.track.itunesPlaylistTrackIndex;

    if (!pIdx || !tIdx) {
      el("sessionMeta").textContent =
        "This track can't be played (missing playlist/track index). Reload playlist and try again.";
      return;
    }

    const ok = await window.api.itunes.playFromPlaylist(pIdx, tIdx);
    if (!ok) {
      el("sessionMeta").textContent = "Could not start playback in iTunes.";
      return;
    }
  }

  // Spotify track: we can't control playback via Spotify API yet; open locally
  if (qItem.track.source === "spotify") {
    const ok = await window.api.openExternal(qItem.track.spotifyUri);
    if (!ok && qItem.track.spotifyUrl) await window.api.openExternal(qItem.track.spotifyUrl);
  }

  // Apple Music track: we can't control playback via API yet; open locally
  if (qItem.track.source === "apple") {
    try {
      await applePlayTrack(qItem.track);
    } catch (e) {
      el("sessionMeta").textContent = "Apple playback failed: " + (e?.message || String(e));
      return;
    }
  }

  // Set nowPlaying immediately (polling refines for iTunes)
  nowPlaying = {
    queueId: qItem.queueId,
    track: qItem.track,
    isPlaying: true,
    playheadMs: 0,
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  send("host:state", { sessionId, nowPlaying });
  renderNowPlaying();
}

async function playNextInSharedQueue() {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;
  if (!queue.length) return;

  if (!nowPlaying?.queueId) {
    await hostPlayQueueItem(queue[0]);
    return;
  }

  const idx = queue.findIndex(q => q.queueId === nowPlaying.queueId);
  if (idx < 0) {
    await hostPlayQueueItem(queue[0]);
    return;
  }

  const nextIdx = idx + 1;

  if (nextIdx >= queue.length) {
    if (!loopQueue) {
      // stop at end
      return;
    }
    await hostPlayQueueItem(queue[0]);
    return;
  }

  await hostPlayQueueItem(queue[nextIdx]);
}

async function syncAppleClientToNowPlaying() {
  if (!nowPlaying?.track || nowPlaying.track.source !== "apple") return;

  // Only apply if this is a new update
  const key = `${nowPlaying.queueId}:${nowPlaying.updatedAt || 0}:${nowPlaying.isPlaying ? "1" : "0"}`;
  if (key === lastAppliedNowPlayingKey) return;
  lastAppliedNowPlayingKey = key;

  try {
    if (nowPlaying.isPlaying) {
      // Play the track inside the app (MusicKit)
      await applePlayTrack(nowPlaying.track);
    } else {
      await applePause();
    }
  } catch (e) {
    el("sessionMeta").textContent = `Apple sync error: ${e?.message || String(e)}`;
  }
}


// ---------- Now playing UI ----------
function computeExpectedPlayhead(np) {
  if (!np) return 0;
  if (!np.isPlaying) return np.playheadMs || 0;
  const startedAt = np.startedAt || Date.now();
  return Math.max(0, Date.now() - startedAt);
}

function renderNowPlaying() {
  const box = el("nowPlaying");
  const bar = el("npBar");
  if (!box || !bar) return;

  if (!nowPlaying) {
    box.querySelector(".npTitle").textContent = "Not playing";
    box.querySelector(".npMeta").textContent = "";
    bar.style.width = "0%";
    return;
  }

  const t = nowPlaying.track;
  const playhead = computeExpectedPlayhead(nowPlaying);

  box.querySelector(".npTitle").textContent = `${t.title}`;
  box.querySelector(".npMeta").textContent =
    `${t.artist} • ${fmtMs(playhead)} / ${fmtMs(t.durationMs)} ${nowPlaying.isPlaying ? "• Playing" : "• Paused"} • ${t.source === "spotify" ? "Spotify" : t.source === "apple" ? "Apple Music" : "iTunes"}`;

  const pct = t.durationMs ? Math.max(0, Math.min(1, playhead / t.durationMs)) : 0;
  bar.style.width = `${pct * 100}%`;
}

// ---------- Host polling (iTunes only) ----------
let lastPos = null;

function startHostPolling() {
  setInterval(async () => {
    const isHost = userId && hostUserId && userId === hostUserId;
    if (!isHost || !sessionId) return;

    // Only poll/refine when current is iTunes track
    if (!nowPlaying || nowPlaying.track?.source !== "itunes") {
      return;
    }

    const np = await window.api.itunes.nowPlaying();
    if (!np) return;

    const pos = Number(np.playerPositionMs ?? 0);
    const state = Number(np.playerState ?? 0);

    const positionMoved = lastPos !== null && Math.abs(pos - lastPos) > 250;
    const isPlaying = (state === 1) || positionMoved;
    lastPos = pos;

    // Keep the queueId + track from our queue item (authoritative)
    const currentQueueItem = queue.find(q => q.queueId === nowPlaying.queueId) || null;
    const track = currentQueueItem?.track || nowPlaying.track;

    const startedAt = isPlaying
      ? (Date.now() - pos)
      : (nowPlaying.startedAt ?? (Date.now() - pos));

    // Auto-advance: trigger BEFORE iTunes advances its own playlist
    const dur = Number(track.durationMs ?? 0);
    const shouldAutoAdvance =
      isPlaying &&
      dur > 0 &&
      pos >= dur - 1200 && // ~1.2s before end
      !autoAdvanceLock;

    if (shouldAutoAdvance) {
      autoAdvanceLock = true;

      // stop iTunes from continuing its own playlist
      await window.api.itunes.pause();

      // advance our queue (respects loopQueue)
      await playNextInSharedQueue();

      setTimeout(() => { autoAdvanceLock = false; }, 1500);
      return; // stop this poll tick
    }

    nowPlaying = {
      queueId: nowPlaying.queueId,
      track,
      isPlaying,
      playheadMs: pos,
      startedAt,
      updatedAt: Date.now()
    };

    send("host:state", { sessionId, nowPlaying });
    renderNowPlaying();
  }, 500);

  // Smooth progress bar updates on everyone
  setInterval(renderNowPlaying, 500);
}

// ---------- Button wiring ----------
function wireUi() {
  // Session buttons
  el("createSession")?.addEventListener("click", () => {
    const displayName = (el("displayName").value || "Host").trim().slice(0, 32);
    send("session:create", { displayName });
  });

  el("joinSession")?.addEventListener("click", () => {
    const displayName = (el("displayName").value || "Guest").trim().slice(0, 32);
    const code = (el("joinCode").value || "").trim().toUpperCase();
    if (!code) return;
    send("session:join", { sessionId: code, displayName });
  });

  // Copy invite
  el("copySession")?.addEventListener("click", async () => {
    if (!sessionId) return;
    const ok = await copyTextToClipboard(getInviteText());
    if (ok) {
      const btn = el("copySession");
      const old = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = old), 1200);
    } else {
      el("sessionMeta").textContent = "Couldn’t copy to clipboard.";
    }
  });

  // Source toggle + reload
  el("sourceItunes")?.addEventListener("click", () => setSource("itunes"));
  el("sourceSpotify")?.addEventListener("click", () => setSource("spotify"));
  el("sourceApple")?.addEventListener("click", async () => {
    musicSource = "apple";
    localStorage.setItem("syncsong:lastSource", musicSource);
    renderMusicTabs();
    await reloadMusic();
  });

  el("reloadMusic")?.addEventListener("click", reloadMusic);

  // Playlist change
  el("musicPlaylists")?.addEventListener("change", async () => {
    const id = el("musicPlaylists").value;
    if (musicSource === "itunes") await loadItunesTracks(id);
    else if (musicSource === "spotify") await loadSpotifyTracks(id);
    else await loadAppleTracks(id);
  });

  // Search
  el("searchMine")?.addEventListener("input", applySearch);

  // Loop toggle
  el("toggleLoop")?.addEventListener("click", () => {
    loopQueue = !loopQueue;
    renderLoopToggle();
  });

  // Host controls
  el("hostPlay")?.addEventListener("click", async () => {
    const isHost = userId && hostUserId && userId === hostUserId;
    if (!isHost) return;

    // If currently iTunes track, resume iTunes
    if (nowPlaying?.track?.source === "itunes") {
      await window.api.itunes.play();
      if (nowPlaying) {
        const playheadMs = nowPlaying.playheadMs ?? 0;
        nowPlaying = {
          ...nowPlaying,
          isPlaying: true,
          startedAt: Date.now() - playheadMs,
          updatedAt: Date.now()
        };
        send("host:state", { sessionId, nowPlaying });
        renderNowPlaying();
      }
      return;
    }

    // If spotify track, "play" just opens it
    if (nowPlaying?.track?.source === "spotify") {
      const ok = await window.api.openExternal(nowPlaying.track.spotifyUri);
      if (!ok && nowPlaying.track.spotifyUrl) await window.api.openExternal(nowPlaying.track.spotifyUrl);
      return;
    }

    // If apple track, "play" just opens it
    if (nowPlaying?.track?.source === "apple") {
      console.log("[debug] ignoring hostPlay for apple (no openExternal, no resume)");
      //const ok = await window.api.openExternal(nowPlaying.track.url);
      // if (!ok) el("sessionMeta").textContent = "Could not open Apple Music.";
      return;
    }

    // If nothing playing, start first queue item
    if (!nowPlaying?.queueId && queue.length) {
      await hostPlayQueueItem(queue[0]);
    }
  });

  el("hostPause")?.addEventListener("click", async () => {
    const isHost = userId && hostUserId && userId === hostUserId;
    if (!isHost) return;

    // Pause only meaningful for iTunes; for spotify we just mark paused
    if (nowPlaying?.track?.source === "itunes") {
      await window.api.itunes.pause();
    }

    if (nowPlaying) {
      nowPlaying = {
        ...nowPlaying,
        isPlaying: false,
        updatedAt: Date.now()
      };
      send("host:state", { sessionId, nowPlaying });
      renderNowPlaying();
    }
  });

  el("hostNext")?.addEventListener("click", async () => {
    await playNextInSharedQueue();
  });

  // Spotify connect
  el("connectSpotify")?.addEventListener("click", async () => {
    try {
      const tok = await window.api.spotifyConnect();
      localStorage.setItem("spotify:access_token", tok.access_token);
      localStorage.setItem("spotify:refresh_token", tok.refresh_token || "");
      localStorage.setItem("spotify:expires_at", String(Date.now() + tok.expires_in * 1000));
      el("sessionMeta").textContent = "Spotify connected!";
      await reloadMusic();
    } catch (e) {
      el("sessionMeta").textContent = "Spotify connect failed: " + (e?.message || String(e));
    }
  });

  // Apple Music connect
  el("connectApple")?.addEventListener("click", async () => {
    try {
      const mk = await ensureAppleConfigured();
      const userToken = await mk.authorize(); // triggers Apple sign-in
      localStorage.setItem(APPLE_USER_TOKEN_KEY, userToken);
      el("sessionMeta").textContent = "Apple Music connected!";
      await reloadMusic();
    } catch (e) {
      el("sessionMeta").textContent = "Apple connect failed: " + (e?.message || String(e));
    }
  });

}

// ---------- Boot ----------
connectWS();
wireUi();
renderMusicTabs();
renderLoopToggle();
renderShareButton();
setSource(musicSource);
startHostPolling();
