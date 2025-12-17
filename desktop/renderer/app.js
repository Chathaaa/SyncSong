const WS_URL = "wss://syncsong-2lxp.onrender.com";

// Import renderer-side providers (keeps app.js slim)
import { getSpotifyAccessToken, spotifyFetch, spotifyApi, ensureSpotifyWebPlayer, spotifyPlayUriInApp } from "./providers/spotify.js";
import { APPLE_DEV_TOKEN_URL, getAppleUserToken, fetchAppleDeveloperToken, ensureAppleConfigured, appleFetch, appleCatalogFetch, appleEnsureAuthorized, appleResolveCatalogSongId, applePlayTrack, applePause, applePlay, appleNext } from "./providers/apple.js";
import { makeControls } from "./controls.js";

const controls = makeControls({
  getPlaybackSource: () => playbackSource,
  getNowPlaying: () => nowPlaying,
  onNextShared: () => playNextInSharedQueue(),
  onPrevShared: () => playPrevInSharedQueue(),
});

const { playerPlay, playerPause, playerSeek, playerNext, playerPrev } = controls;


let ws;
let userId = null;
let sessionId = null;
let hostUserId = null;

let queue = [];
let nowPlaying = null;

// unified music panel state
let musicSource = localStorage.getItem("syncsong:lastSource") || "spotify"; // "itunes" | "spotify | "apple"
let playlists = [];      // [{id,name}]
let tracks = [];         // unified track objects
let tracksFiltered = [];
let lastLoadedQueueKey = ""; // queueId:playbackSource


let currentItunesPlaylistIndex = null;

// session + UX helpers
let pendingAddTrack = null;
let pendingCreate = false;

// playback behavior
let loopQueue = true; // default
let autoAdvanceLock = false;
let isScrubbing = false;
let scrubWasPlaying = false;


// ---------- Unified music panel ----------
const LAST_SOURCE_KEY = "syncsong:lastSource";
const LAST_ITUNES_PLAYLIST_KEY = "syncsong:lastItunesPlaylistIndex";
const LAST_SPOTIFY_PLAYLIST_KEY = "syncsong:lastSpotifyPlaylistId";

const LAST_APPLE_PLAYLIST_KEY = "syncsong:lastApplePlaylistId";
const APPLE_DEV_TOKEN_KEY = "syncsong:appleDevToken";
const APPLE_USER_TOKEN_KEY = "syncsong:appleUserToken";

const PLAYBACK_SOURCE_KEY = "syncsong:playbackSource"; // "apple" | "spotify"
let playbackSource = localStorage.getItem(PLAYBACK_SOURCE_KEY) || "apple";

const isWeb = typeof window.api === "undefined";

// UI helpers
const el = (id) => document.getElementById(id);

function send(type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type, payload }));
  return true;
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
    pendingCreate = false; // allow session:create to be attempted again
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
      syncClientToNowPlaying();
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
      syncClientToNowPlaying();
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

// Apple developer token endpoint is provided by ./providers/apple.js

// Spotify renderer helpers are moved to ./providers/spotify.js
// See: renderer/providers/spotify.js

// ---------- Music panel rendering + loading ----------

function renderMusicTabs() {
  //el("sourceItunes")?.classList.toggle("active", musicSource === "itunes");
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
  
  if (isWeb) {
    throw new Error("iTunes is only available in the desktop app.");
  }

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

// Spotify playlist/track helpers moved to providers/spotify.js
async function loadSpotifyPlaylistsAndTracks() {
  const { playlists: pls } = await import("./providers/spotify.js").then(m => m.loadSpotifyPlaylistsAndTracks());
  // app.js maintains the UI state
  playlists = pls;
  renderMusicPlaylists();
  const selId = el("musicPlaylists").value;
  if (selId) {
    const { tracks: t } = await import("./providers/spotify.js").then(m => m.loadSpotifyTracks(selId));
    tracks = t;
    applySearch();
  }
}

async function loadSpotifyTracks(playlistId) {
  const { tracks: t } = await import("./providers/spotify.js").then(m => m.loadSpotifyTracks(playlistId));
  tracks = t;
  applySearch();
}

async function spotifyFindUriForTrack(track) {
  const { spotifyFindUriForTrack: _find } = await import("./providers/spotify.js");
  return _find(track);
}

// Apple playlist/track helpers moved to providers/apple.js
async function loadApplePlaylistsAndTracks() {
  const { playlists: pls, note } = await import("./providers/apple.js").then(m => m.loadApplePlaylistsAndTracks());

  if (note) {
    playlists = [];
    tracks = [];
    renderMusicPlaylists();
    applySearch();
    el("sessionMeta").textContent = note;
    return;
  }

  playlists = pls;
  renderMusicPlaylists();
  const selId = el("musicPlaylists")?.value;
  if (selId) await loadAppleTracks(selId);
}

async function loadAppleTracks(playlistId) {
  const { tracks: t } = await import("./providers/apple.js").then(m => m.loadAppleTracks(playlistId));
  tracks = t;
  applySearch();
}


// Apple renderer helpers have been moved to ./providers/apple.js
// See: renderer/providers/apple.js



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

  // If we're not connected yet, don't lock pendingCreate forever
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    el("sessionMeta").textContent = "Connecting… try again in a moment.";
    return false;
  }

  if (!pendingCreate) {
    pendingCreate = true;
    const displayName = (el("displayName").value || "Host").trim().slice(0, 32);

    const ok = send("session:create", { displayName });
    if (!ok) {
      pendingCreate = false; // allow retries
      el("sessionMeta").textContent = "Couldn’t create session (not connected).";
      return false;
    }

    el("sessionMeta").textContent = "Creating session…";
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

  // Broadcast the shared state (everyone plays it on their chosen platform)
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

  // Optional: let the host ALSO listen on their chosen source
  await syncClientToNowPlaying();
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

async function playPrevInSharedQueue() {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;
  if (!queue.length) return;

  if (!nowPlaying?.queueId) {
    await hostPlayQueueItem(queue[0]);
    return;
  }

  const idx = queue.findIndex(q => q.queueId === nowPlaying.queueId);
  const prevIdx = idx <= 0 ? (loopQueue ? queue.length - 1 : 0) : idx - 1;
  await hostPlayQueueItem(queue[prevIdx]);
}

// async function syncAppleClientToNowPlaying() {
//   if (!nowPlaying?.track || nowPlaying.track.source !== "apple") return;

//   // Only apply if this is a new update
//   const key = `${nowPlaying.queueId}:${nowPlaying.updatedAt || 0}:${nowPlaying.isPlaying ? "1" : "0"}`;
//   if (key === lastAppliedNowPlayingKey) return;
//   lastAppliedNowPlayingKey = key;

//   try {
//     if (nowPlaying.isPlaying) {
//       // Play the track inside the app (MusicKit)
//       await applePlayTrack(nowPlaying.track);
//     } else {
//       await applePause();
//     }
//   } catch (e) {
//     el("sessionMeta").textContent = `Apple sync error: ${e?.message || String(e)}`;
//   }
// }

let lastClientPlayedKey = "";

async function playTrackOnMySource(track) {
  if (!track) return;

  if (playbackSource === "apple") {
    await applePlayTrack(track);
    return;
  }

  if (playbackSource === "spotify") {
    const uri = await spotifyFindUriForTrack(track);
    if (!uri) throw new Error("Could not find this track on Spotify via search.");

    await spotifyPlayUriInApp(uri);
    startSpotifyStateSync();
    return;
  }
}


async function syncClientToNowPlaying() {
  if (!nowPlaying?.track) return;

  const loadKey = `${nowPlaying.queueId}:${playbackSource}`;

  // If paused: pause locally (Apple + Spotify if you have SDK wired)
  if (!nowPlaying.isPlaying) {
    try { await playerPause(); } catch {}
    return;
  }

  // If same track already loaded, just resume (don't restart)
  if (loadKey === lastLoadedQueueKey) {
    try { await playerPlay(); } catch {}
    return;
  }

  // New track: load/open it once
  lastLoadedQueueKey = loadKey;

  try {
    await playTrackOnMySource(nowPlaying.track);
  } catch (e) {
    el("sessionMeta").textContent =
      `Playback sync failed (${playbackSource}): ${e?.message || String(e)}`;
  }
}



let spotifyStateTimer = null;

async function startSpotifyStateSync() {
  stopSpotifyStateSync();
  spotifyStateTimer = setInterval(async () => {
    try {
      const { spotifyGetPlaybackState } = await import("./providers/spotify.js");
      const s = await spotifyGetPlaybackState();
      if (!s) return;
    
      // Update unified UI
      if (playbackSource !== "spotify") return;
      if (!nowPlaying?.track) return;
      if (isScrubbing) return;
      const dur = Number(s.duration || 0);
      const pos = Number(s.position || 0);
      const paused = !!s.paused;

      nowPlaying = {
        ...nowPlaying,
        isPlaying: !paused,
        playheadMs: pos,
        startedAt: Date.now(),     // ✅ snapshot time for this base
        // keep whatever track metadata you already have
      };

      // do NOT broadcast client polling
      renderNowPlaying();
    } catch {}
  }, 500);
}

function stopSpotifyStateSync() {
  if (spotifyStateTimer) clearInterval(spotifyStateTimer);
  spotifyStateTimer = null;
}

// ---------- Now playing UI ----------
function computeExpectedPlayhead(np) {
  if (!np) return 0;

  const base = Number(np.playheadMs ?? 0);

  // While paused, freeze at playheadMs
  if (!np.isPlaying) return Math.max(0, base);

  // While playing, advance from playheadMs using startedAt as the moment
  // playback resumed (startedAt = Date.now() - playheadMs at resume time).
  const startedAt = Number(np.startedAt ?? Date.now());
  const elapsed = Date.now() - startedAt;

  return Math.max(0, base + elapsed);
}

function renderNowPlaying() {
  const box = el("nowPlaying");
  if (!box) return;
  if (isScrubbing) return; // don't fight the user

  // Prefer IDs (matches your current index.html)
  const titleEl = el("npTitle") || box.querySelector(".npTitle");
  const subEl   = el("npSub")   || box.querySelector(".npSub") || box.querySelector(".npMeta");
  const barEl   = el("npBar")   || box.querySelector("#npBar") || box.querySelector(".bar");
  const ppBtn = el("npPlayPause");
  const posEl = el("npPos");
  const durEl = el("npDur");

  if (!titleEl || !barEl) return; // don't crash the app if markup changes

  if (!nowPlaying?.track) {
    titleEl.textContent = "Not playing";
    if (subEl) subEl.textContent = "";
    barEl.style.width = "0%";
    return;
  }

  const t = nowPlaying.track;
  const playhead = computeExpectedPlayhead(nowPlaying);

  if (posEl) posEl.textContent = fmtMs(playhead);
  if (durEl) durEl.textContent = fmtMs(t.durationMs || 0);

  titleEl.textContent = t.title || "Unknown title";

  if (ppBtn) ppBtn.textContent = nowPlaying.isPlaying ? "❚❚" : "▶"; 

  if (subEl) {
    const sourceLabel =
      t.source === "spotify" ? "Spotify" :
      t.source === "apple" ? "Apple Music" :
      t.source === "itunes" ? "iTunes" : (t.source || "");

    subEl.textContent =
      `${t.artist || ""}${t.album ? ` • ${t.album}` : ""} • ${fmtMs(playhead)} / ${fmtMs(t.durationMs || 0)} ` +
      `${nowPlaying.isPlaying ? "• Playing" : "• Paused"}${sourceLabel ? ` • ${sourceLabel}` : ""}`;
  }

  const dur = Math.max(1, t.durationMs || 1);
  const pct = Math.max(0, Math.min(1, playhead / dur));
  barEl.style.width = `${pct * 100}%`;
  const thumb = el("npThumb");
  if (thumb) thumb.style.left = `${pct * 100}%`;
}



function renderPlaybackSource() {
    const sel = el("playbackSource");
    if (!sel) return;
    sel.value = playbackSource;
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
  setInterval(() => {
    if (playbackSource === "spotify") return; // ✅ let Spotify polling drive UI
    renderNowPlaying();
  }, 500);
}

// ---------- Button wiring ----------
function wireUi() {
  const isHostNow = () => userId && hostUserId && userId === hostUserId;
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
    if (musicSource === "spotify") await loadSpotifyTracks(id);
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
  el("npPlayPause")?.addEventListener("click", async () => {
    if (!isHostNow()) return;

    if (!nowPlaying?.queueId && queue.length) {
      await hostPlayQueueItem(queue[0]);
      return;
    }
    if (!nowPlaying?.track) return;

    const willPlay = !nowPlaying.isPlaying;
    const currentPlayhead = computeExpectedPlayhead(nowPlaying);

    // --- ACTUAL playback control ---
    if (nowPlaying.track?.source === "itunes") {
      if (willPlay) await window.api.itunes.play();
      else await window.api.itunes.pause();
    } else {
      if (!willPlay) {
        await playerPause();
      } else {
        // First-play fix: ensure the track is loaded on this client before resume
        const loadKey = `${nowPlaying.queueId}:${playbackSource}`;
        if (loadKey !== lastLoadedQueueKey) {
          lastLoadedQueueKey = loadKey;
          await playTrackOnMySource(nowPlaying.track); // loads + starts
        } else {
          await playerPlay(); // resume
        }
      }
    }

    // --- Update shared state (UI + sync) ---
    nowPlaying = {
      ...nowPlaying,
      isPlaying: willPlay,
      playheadMs: currentPlayhead,
      startedAt: willPlay ? Date.now() : nowPlaying.startedAt,
      updatedAt: Date.now(),
    };

    send("host:state", { sessionId, nowPlaying });
    renderNowPlaying();
  });


  el("npNext")?.addEventListener("click", async () => {
    if (!isHostNow()) return;
    await playerNext();
  });

  el("npPrev")?.addEventListener("click", async () => {
    if (!isHostNow()) return;
    await playerPrev();
  });

  // Seek bar
  const prog = el("nowPlaying")?.querySelector(".npProgress");
  if (prog) {
    let dragging = false;

    const pctFromEvent = (ev) => {
      const rect = prog.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX);
      return Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    };

    const previewToPct = (pct) => {
      const dur = nowPlaying?.track?.durationMs || 0;
      if (!dur) return;
      const ms = dur * pct;
      el("npBar") && (el("npBar").style.width = `${pct * 100}%`);
      el("npPos") && (el("npPos").textContent = fmtMs(ms));
      el("npThumb") && (el("npThumb").style.left = `${pct * 100}%`);
    };

    // const commitToPct = async (pct) => {
    //   if (!nowPlaying?.track) return;

    //   let durMs = Number(nowPlaying.track.durationMs || 0);

    //   // ✅ Spotify: use the real playing item's duration from the SDK
    //   if (playbackSource === "spotify") {
    //     try {
    //       const { spotifyGetPlaybackState } = await import("./providers/spotify.js");
    //       const s = await spotifyGetPlaybackState();
    //       if (s?.duration) durMs = Number(s.duration);
    //     } catch {}
    //   }

    //   if (!durMs) return;

    //   // Clamp pct and compute target
    //   pct = Math.max(0, Math.min(1, pct));
    //   const targetMs = Math.max(0, Math.min(durMs - 250, Math.floor(durMs * pct))); // avoid seeking past end
    //   const secs = targetMs / 1000;

    //   await playerSeek(secs);

    //   // Broadcast (host) so everyone syncs
    //   const playheadMs = Math.floor(secs * 1000);
    //   nowPlaying = {
    //     ...nowPlaying,
    //     playheadMs,
    //     startedAt: nowPlaying.isPlaying ? (Date.now() - playheadMs) : nowPlaying.startedAt,
    //     updatedAt: Date.now(),
    //   };

    //   send("host:state", { sessionId, nowPlaying });
    //   renderNowPlaying();
    // };

    prog.addEventListener("mousedown", async (e) => {
      if (!isHostNow() || !nowPlaying) return;

      isScrubbing = true;
      scrubWasPlaying = !!nowPlaying.isPlaying;

      // Optional but recommended for smoothness:
      // pause locally while scrubbing if it was playing
      if (scrubWasPlaying && nowPlaying.track?.source !== "itunes") {
        try { await playerPause(); } catch {}
      }

      dragging = true;
      previewToPct(pctFromEvent(e));
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      previewToPct(pctFromEvent(e));
    });

    window.addEventListener("mouseup", async (e) => {
      if (!dragging) return;
      dragging = false;

      if (!isHostNow() || !nowPlaying) { isScrubbing = false; return; }

      const pct = pctFromEvent(e);
      const dur = nowPlaying.track?.durationMs || 0;
      if (dur) {
        const secs = (dur * pct) / 1000;

        // seek
        await playerSeek(secs);

        // resume if it was playing
        if (scrubWasPlaying && nowPlaying.track?.source !== "itunes") {
          try { await playerPlay(); } catch {}
        }

        // broadcast accurate shared state
        const playheadMs = Math.floor(secs * 1000);
        nowPlaying = {
          ...nowPlaying,
          playheadMs,
          startedAt: Date.now(), // ✅ snapshot moment of this base
          updatedAt: Date.now(),
        };
        send("host:state", { sessionId, nowPlaying });
        renderNowPlaying();

        send("host:state", { sessionId, nowPlaying });
      }

      isScrubbing = false;
      renderNowPlaying();
    });


  }

  window.addEventListener("message", (event) => {
    // Security: only accept messages from our own origin
    if (event.origin !== window.location.origin) return;

    const msg = event.data;
    if (!msg || msg.type !== "spotify:token" || !msg.token) return;

    const tok = msg.token;

    localStorage.setItem("spotify:access_token", tok.access_token || "");
    localStorage.setItem("spotify:refresh_token", tok.refresh_token || "");
    localStorage.setItem(
      "spotify:expires_at",
      String(Date.now() + (tok.expires_in || 0) * 1000)
    );

    console.log("[spotify] token received via postMessage");
  });



  // Spotify connect
  function waitForSpotifyToken({ timeoutMs = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();

      const timer = setInterval(() => {
        const tok = localStorage.getItem("spotify:access_token");
        if (tok) {
          clearInterval(timer);
          resolve(tok);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for Spotify token."));
        }
      }, 200);
    });
  }

  el("connectSpotify")?.addEventListener("click", async () => {
    try {
      // Web: if we already have a refresh token, refresh silently and skip popup.
      if (!window?.api?.spotifyConnect) {
        const { spotifyEnsureAccessToken } = await import("./providers/spotify.js");
        const rt = localStorage.getItem("spotify:refresh_token") || "";
        if (rt) {
          await spotifyEnsureAccessToken();
          el("sessionMeta").textContent = "Spotify connected!";
          await reloadMusic();
          return;
        }
      }
      const ipcSpotifyConnect = window?.api?.spotifyConnect;

      // Electron path (unchanged)
      if (typeof ipcSpotifyConnect === "function") {
        const tok = await ipcSpotifyConnect();
        localStorage.setItem("spotify:access_token", tok.access_token);
        localStorage.setItem("spotify:refresh_token", tok.refresh_token || "");
        localStorage.setItem("spotify:expires_at", String(Date.now() + tok.expires_in * 1000));
        el("sessionMeta").textContent = "Spotify connected!";
        await reloadMusic();
        return;
      }

      // Web path
      el("sessionMeta").textContent = "Opening Spotify authorization...";
      await import("./providers/spotify.js").then((m) => m.spotifyWebConnect());

      // IMPORTANT: wait for callback to store token before using Spotify API
      await waitForSpotifyToken();
      el("sessionMeta").textContent = "Spotify connected!";
      await reloadMusic();

    } catch (e) {
      console.error("[spotify] connect failed", e);
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

  el("playbackSource")?.addEventListener("change", async () => {
    playbackSource = el("playbackSource").value;
    localStorage.setItem(PLAYBACK_SOURCE_KEY, playbackSource);

    lastLoadedQueueKey = ""; // force a fresh load on next play
    await syncClientToNowPlaying();
  });

}

// ---------- Boot ----------
connectWS();
wireUi();
renderMusicTabs();
renderLoopToggle();
renderShareButton();
renderPlaybackSource();
setSource(musicSource);
startHostPolling();
