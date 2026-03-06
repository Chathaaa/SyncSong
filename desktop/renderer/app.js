const IS_DISCORD_ACTIVITY_CONTEXT = (() => {
  try {
    const q = new URL(window.location.href).searchParams;
    return q.get("mode") === "discord_activity" || !!q.get("frame_id");
  } catch {
    return false;
  }
})();

const WS_URL = IS_DISCORD_ACTIVITY_CONTEXT
  ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`
  : "wss://syncsong-2lxp.onrender.com";
const BACKEND_HTTP_BASE = IS_DISCORD_ACTIVITY_CONTEXT ? "/api" : "https://syncsong-2lxp.onrender.com";
const APPLE_SDK_URL = IS_DISCORD_ACTIVITY_CONTEXT
  ? "/apple-sdk/musickit/v3/musickit.js"
  : "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
const SPOTIFY_SDK_URL = IS_DISCORD_ACTIVITY_CONTEXT
  ? "/spotify-sdk/spotify-player.js"
  : "https://sdk.scdn.co/spotify-player.js";

// Import renderer-side providers (keeps app.js slim)
import { getSpotifyAccessToken, spotifyFetch, spotifyApi, ensureSpotifyWebPlayer, spotifyPlayUriInApp } from "./providers/spotify.js";
import { APPLE_DEV_TOKEN_URL, getAppleUserToken, fetchAppleDeveloperToken, ensureAppleConfigured, appleFetch, appleCatalogFetch, appleEnsureAuthorized, appleResolveCatalogSongId, applePlayTrack, applePause, applePlay, appleNext } from "./providers/apple.js";
import { makeControls } from "./controls.js";
import { initDiscordActivity, openExternalLink } from "./discordActivity.js";

const controls = makeControls({
  getPlaybackSource: () => playbackSource,
  getNowPlaying: () => nowPlaying,
  onNextShared: () => playNextInSharedQueue(),
  onPrevShared: () => playPrevInSharedQueue(),
});

const { playerPlay, playerPause, playerSeek, playerNext, playerPrev, playerSetVolume } = controls;


let ws;
let userId = null;
let sessionId = null;
let hostUserId = null;
let lastRejoinAttempt = "";
let pendingJoinCode = "";
let discordActivity = {
  enabled: false,
  token: "",
  context: null,
  error: "",
  debug: null,
};
let linkedProvidersHydrated = false;
let providerLinkPollTimer = null;
let providerLinkPollUntil = 0;

let queue = [];
let nowPlaying = null;
let allowGuestControl = false;
let partyMode = false;

// unified music panel state
let musicSource = localStorage.getItem("syncsong:lastSource") || "spotify"; // "spotify | "apple"
let playlists = [];      // [{id,name}]
let tracks = [];         // unified track objects
let tracksFiltered = [];
let lastLoadedQueueKey = ""; // queueId:playbackSource

// session + UX helpers
let pendingAddTracks = [];
let pendingCreate = false;

// playback behavior
let loopQueue = true; // default
let autoAdvanceLock = false;
let lastApplePosMs = 0;
let lastSpotifyPosMs = 0;
let lastAppleMaxPosMs = 0;      // max position seen (for end detection)
let lastSpotifyMaxPosMs = 0;    // max position seen (for end detection)
let lastAutoAdvanceQueueId = "";
let lastAutoAdvanceSource = "";
let lastHostPlayheadSentAt = 0;
let lastHostPlayheadSentMs = -1;
let localActiveQueueId = "";
let isScrubbing = false;
let scrubWasPlaying = false;

let spotifyPollIgnoreUntil = 0;
// --- Sync/race guards ---
let transitionIgnoreUntil = 0;   // prevent pollers from mutating nowPlaying during track switches
let remoteSeekIgnoreUntil = 0;   // prevent pollers from snapping UI back immediately after we apply a remote seek

const inTransition = () => Date.now() < transitionIgnoreUntil;
const ignoreForMs = (ms) => { transitionIgnoreUntil = Math.max(transitionIgnoreUntil, Date.now() + ms); };

let lastSpotifyUriLoaded = "";
let hostIntentIsPlaying = true; // host's desired play state (source of truth for transitions)
let dragQueueId = null;


// ---------- Unified music panel ----------
const LAST_SOURCE_KEY = "syncsong:lastSource";
const LAST_SPOTIFY_PLAYLIST_KEY = "syncsong:lastSpotifyPlaylistId";
const SPOTIFY_LIBRARY_TRACKS_ID = "__spotify_library_tracks__";
const APPLE_LIBRARY_TRACKS_ID = "__apple_library_tracks__";

const LAST_APPLE_PLAYLIST_KEY = "syncsong:lastApplePlaylistId";
const APPLE_DEV_TOKEN_KEY = "syncsong:appleDevToken";
const APPLE_USER_TOKEN_KEY = "syncsong:appleUserToken";

const PLAYBACK_SOURCE_KEY = "syncsong:playbackSource"; // "apple" | "spotify"

const DISPLAY_NAME_KEY = "syncsong:displayName";
const AUTO_ROOM_HINT_SEEN_KEY = "syncsong:autoRoomHintSeen";
const LAST_SESSION_KEY = "syncsong:lastSessionId";
const LAST_SESSION_AT_KEY = "syncsong:lastSessionAt";
const ROOM_QUERY_PARAM = "room";

function hasSpotifyAuth() {
  return !!(localStorage.getItem("spotify:refresh_token") || localStorage.getItem("spotify:access_token"));
}
function hasAppleAuth() {
  return !!localStorage.getItem(APPLE_USER_TOKEN_KEY);
}

// Prefer stored choice *only if* that provider is actually connected.
// Otherwise fall back to whichever provider is connected.
function pickInitialPlaybackSource() {
  const stored = localStorage.getItem(PLAYBACK_SOURCE_KEY);
  if (stored === "spotify" && hasSpotifyAuth()) return "spotify";
  if (stored === "apple" && hasAppleAuth()) return "apple";
  if (hasSpotifyAuth()) return "spotify";
  if (hasAppleAuth()) return "apple";
  return stored || "spotify";
}

let playbackSource = pickInitialPlaybackSource();
let spotifyTracksLoadRequestId = 0;
let appleTracksLoadRequestId = 0;
let spotifyLibrarySearchRequestId = 0;
let spotifyLibrarySearchTimer = null;
let spotifyLibrarySearchResults = null;
let appleLibrarySearchRequestId = 0;
let appleLibrarySearchTimer = null;
let appleLibrarySearchResults = null;

const VOLUME_KEY = "syncsong:playerVolume01"; // 0..1 local-only

let playerVolume01 = (() => {
  const v = Number(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
})();
let lastNonZeroVolume01 = playerVolume01 > 0 ? playerVolume01 : 1;

// UI helpers
const el = (id) => document.getElementById(id);

function send(type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type, payload }));
  return true;
}

function loadExternalScript(src, { attrs = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing && existing.dataset.loaded === "1") {
      resolve();
      return;
    }
    if (existing && existing.dataset.loading === "1") {
      const onReady = () => {
        existing.removeEventListener("syncsong:loaded", onReady);
        resolve();
      };
      const onErr = () => {
        existing.removeEventListener("syncsong:error", onErr);
        reject(new Error(`Script failed: ${src}`));
      };
      existing.addEventListener("syncsong:loaded", onReady);
      existing.addEventListener("syncsong:error", onErr);
      return;
    }

    const s = existing || document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.loading = "1";
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined) continue;
      s.setAttribute(k, String(v));
    }

    const timer = setTimeout(() => {
      s.dispatchEvent(new Event("syncsong:error"));
      reject(new Error(`Script timeout: ${src}`));
    }, timeoutMs);

    s.onload = () => {
      clearTimeout(timer);
      s.dataset.loading = "0";
      s.dataset.loaded = "1";
      s.dispatchEvent(new Event("syncsong:loaded"));
      resolve();
    };
    s.onerror = () => {
      clearTimeout(timer);
      s.dataset.loading = "0";
      s.dispatchEvent(new Event("syncsong:error"));
      reject(new Error(`Script load failed: ${src}`));
    };

    if (!existing) document.head.appendChild(s);
  });
}

async function loadProviderSdkScripts() {
  // Load both proactively so connect buttons work without race conditions.
  await Promise.all([
    loadExternalScript(APPLE_SDK_URL, { attrs: { "data-web-components-async": "" } }),
    loadExternalScript(SPOTIFY_SDK_URL),
  ]);
}

function activityDebugSummary() {
  const d = discordActivity?.debug;
  if (!d) return "";
  const stage = String(d.stage || "unknown");
  const flags = [
    `sdk:${d.sdk ? "ok" : "no"}`,
    `oauth:${d.oauthToken ? "ok" : "no"}`,
    `token:${d.activityToken ? "ok" : "no"}`,
  ].join(" ");
  const msg = String(d.message || "").trim();
  return `Activity auth debug -> stage:${stage} ${flags}${msg ? ` msg:${msg}` : ""}`;
}

function renderActivityDebugLine() {
  if (!discordActivity?.enabled) return;
  const hint = el("autoRoomHint");
  if (!hint) return;
  const line = activityDebugSummary();
  if (!line) return;
  hint.textContent = line;
  hint.style.display = "block";
}

async function discordAuthedFetch(path, init = {}) {
  const tok = String(discordActivity?.token || "").trim();
  const bearer = tok || String(discordActivity?.context?.discordAccessToken || "").trim();
  if (!bearer) throw new Error("Discord activity token is missing.");
  const headers = {
    ...(init.headers || {}),
    Authorization: `Bearer ${bearer}`,
  };
  return fetch(`${BACKEND_HTTP_BASE}${path}`, { ...init, headers });
}

async function hydrateProvidersFromDiscordLink() {
  const hasBearer = !!(
    String(discordActivity?.token || "").trim() ||
    String(discordActivity?.context?.discordAccessToken || "").trim()
  );
  if (!discordActivity?.enabled || !hasBearer || linkedProvidersHydrated) return false;

  try {
    const res = await discordAuthedFetch("/discord/providers/me");
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));

    let hydratedAny = false;
    const sp = data?.spotify || {};
    if (sp?.connected) {
      const localRefresh = localStorage.getItem("spotify:refresh_token") || "";
      const localAccess = localStorage.getItem("spotify:access_token") || "";
      if (!localRefresh && !localAccess) {
        if (sp.accessToken) localStorage.setItem("spotify:access_token", String(sp.accessToken));
        if (sp.refreshToken) localStorage.setItem("spotify:refresh_token", String(sp.refreshToken));
        if (sp.expiresAt) localStorage.setItem("spotify:expires_at", String(Number(sp.expiresAt) || 0));
        if (sp.clientId) localStorage.setItem("spotify:client_id", String(sp.clientId));
      }
      hydratedAny = hydratedAny || !!(sp.accessToken || sp.refreshToken);
    }

    const ap = data?.apple || {};
    if (ap?.connected) {
      const localAppleToken = localStorage.getItem(APPLE_USER_TOKEN_KEY) || "";
      if (!localAppleToken && ap.userToken) {
        localStorage.setItem(APPLE_USER_TOKEN_KEY, String(ap.userToken));
      }
      hydratedAny = hydratedAny || !!ap.userToken;
    }

    linkedProvidersHydrated = true;
    return hydratedAny;
  } catch {
    // Best-effort only.
    return false;
  }
}

async function syncLocalProvidersToDiscordLink() {
  if (!discordActivity?.enabled || !discordActivity?.token) return;

  const spotifyRefresh = localStorage.getItem("spotify:refresh_token") || "";
  const spotifyAccess = localStorage.getItem("spotify:access_token") || "";
  const spotifyClientId = localStorage.getItem("spotify:client_id") || "";
  const spotifyExpiresAt = Number(localStorage.getItem("spotify:expires_at") || "0") || 0;
  const appleUserToken = localStorage.getItem(APPLE_USER_TOKEN_KEY) || "";

  if (!spotifyRefresh && !spotifyAccess && !appleUserToken) return;

  const body = {};
  if (spotifyRefresh || spotifyAccess) {
    body.spotify = {
      refreshToken: spotifyRefresh,
      accessToken: spotifyAccess,
      clientId: spotifyClientId,
      expiresAt: spotifyExpiresAt,
    };
  }
  if (appleUserToken) {
    body.apple = { userToken: appleUserToken };
  }

  try {
    await discordAuthedFetch("/discord/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Best-effort only.
  }
}

function getProviderLinkContextFromUrl() {
  try {
    const q = new URL(window.location.href).searchParams;
    return {
      provider: String(q.get("linkProvider") || "").trim().toLowerCase(),
      linkToken: String(q.get("linkToken") || "").trim(),
    };
  } catch {
    return { provider: "", linkToken: "" };
  }
}

const providerLinkContext = getProviderLinkContextFromUrl();

async function syncLocalProvidersViaLinkToken() {
  const linkToken = String(providerLinkContext?.linkToken || "").trim();
  if (!linkToken) return false;

  const spotifyRefresh = localStorage.getItem("spotify:refresh_token") || "";
  const spotifyAccess = localStorage.getItem("spotify:access_token") || "";
  const spotifyClientId = localStorage.getItem("spotify:client_id") || "";
  const spotifyExpiresAt = Number(localStorage.getItem("spotify:expires_at") || "0") || 0;
  const appleUserToken = localStorage.getItem(APPLE_USER_TOKEN_KEY) || "";

  const body = { linkToken };
  if (spotifyRefresh || spotifyAccess) {
    body.spotify = {
      refreshToken: spotifyRefresh,
      accessToken: spotifyAccess,
      clientId: spotifyClientId,
      expiresAt: spotifyExpiresAt,
    };
  }
  if (appleUserToken) {
    body.apple = { userToken: appleUserToken };
  }

  if (!body.spotify && !body.apple) return false;

  try {
    const res = await fetch(`${BACKEND_HTTP_BASE}/discord/providers/by-link-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return !!res.ok;
  } catch {
    return false;
  }
}

async function requestProviderLinkToken(provider) {
  const res = await discordAuthedFetch("/discord/providers/link-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.linkToken) {
    const msg = String(data?.message || data?.error || `Link token request failed (${res.status})`);
    throw new Error(msg);
  }
  return String(data.linkToken);
}

function makeProviderLinkUrl(provider, linkToken) {
  const base = String(import.meta.env.VITE_PUBLIC_APP_URL || "https://sync-song-opal.vercel.app").trim();
  const u = new URL(base.endsWith("/") ? base : `${base}/`);
  u.searchParams.set("linkProvider", String(provider || ""));
  u.searchParams.set("linkToken", String(linkToken || ""));
  return u.toString();
}

function stopProviderLinkPolling() {
  if (providerLinkPollTimer) {
    clearInterval(providerLinkPollTimer);
    providerLinkPollTimer = null;
  }
  providerLinkPollUntil = 0;
}

async function refreshLinkedProvidersAndUi({ force = false } = {}) {
  if (!discordActivity?.enabled) return false;
  const hadSpotify = hasSpotifyAuth();
  const hadApple = hasAppleAuth();

  if (force) linkedProvidersHydrated = false;
  const hydratedAny = await hydrateProvidersFromDiscordLink();
  const hasNewProvider = (!hadSpotify && hasSpotifyAuth()) || (!hadApple && hasAppleAuth());

  if (hydratedAny || hasNewProvider) {
    const hasSp = hasSpotifyAuth();
    const hasAp = hasAppleAuth();
    let desiredSource = musicSource;
    if (hasAp && !hasSp) desiredSource = "apple";
    else if (hasSp && !hasAp) desiredSource = "spotify";

    if (desiredSource !== musicSource) {
      musicSource = desiredSource;
      localStorage.setItem(LAST_SOURCE_KEY, musicSource);
      try {
        await setSource(musicSource);
      } catch {}
    } else {
      try { await reloadMusic(); } catch {}
    }

    // Keep playback source aligned when only one provider is connected.
    if (hasAp && !hasSp && playbackSource !== "apple") {
      playbackSource = "apple";
      localStorage.setItem(PLAYBACK_SOURCE_KEY, "apple");
      renderPlaybackSource();
    } else if (hasSp && !hasAp && playbackSource !== "spotify") {
      playbackSource = "spotify";
      localStorage.setItem(PLAYBACK_SOURCE_KEY, "spotify");
      renderPlaybackSource();
    }

    renderConnectPrompt();
    renderConnectButtons();
    return true;
  }
  return false;
}

function startProviderLinkPolling(providerLabel) {
  stopProviderLinkPolling();
  providerLinkPollUntil = Date.now() + 120000; // up to 2 minutes
  providerLinkPollTimer = setInterval(async () => {
    if (Date.now() > providerLinkPollUntil) {
      stopProviderLinkPolling();
      return;
    }
    const linked = await refreshLinkedProvidersAndUi({ force: true });
    if (linked) {
      stopProviderLinkPolling();
      el("sessionMeta").textContent = `${providerLabel} linked. You can now browse music here.`;
    }
  }, 3000);
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

function setScrubbing(on) {
  document.body.classList.toggle("scrubbing", on);
  el("npProgress")?.classList.toggle("scrubbing", on);
}

function isHost() {
  return userId && hostUserId && userId === hostUserId;
}

function isSilentGuest() {
  return !!sessionId && partyMode && !isHost();
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
  if (!sessionId) return window.location.origin;
  const u = new URL(window.location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set(ROOM_QUERY_PARAM, sessionId);
  return u.toString();
}

function normalizeSessionCode(raw) {
  return String(raw || "").trim().toUpperCase();
}

function isDiscordActivityMode() {
  return !!discordActivity?.enabled;
}

function ensureDiscordActivityReady() {
  if (!isDiscordActivityMode()) return true;
  if (discordActivity.token) return true;
  const err = discordActivity.error || "Discord Activity auth is not ready.";
  el("sessionMeta").textContent = err;
  return false;
}

function shouldAttemptActivityAutoJoin() {
  if (!isDiscordActivityMode()) return false;
  if (sessionId) return false;
  const code = getRoomCodeFromUrl();
  if (code) return false;
  const aid = String(discordActivity?.context?.activityInstanceId || "").trim();
  return !!aid;
}

function requestJoinSession(rawCode) {
  if (!ensureDiscordActivityReady()) return false;

  const code = normalizeSessionCode(rawCode);
  if (!code) return false;

  const displayName = getPreferredDisplayName("Guest");
  lastRejoinAttempt = code;

  if (send("session:join", { sessionId: code, displayName })) {
    pendingJoinCode = "";
    return true;
  }

  pendingJoinCode = code;
  el("sessionMeta").textContent = "Connecting... joining room when ready.";
  return false;
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

function getDisplayName(defaultName) {
  const v = (el("displayName")?.value || localStorage.getItem(DISPLAY_NAME_KEY) || defaultName || "").trim();
  return (v || defaultName || "Guest").slice(0, 32);
}

function getPreferredDisplayName(defaultName) {
  const discordName = String(discordActivity?.context?.displayName || "").trim();
  if (discordName) return discordName.slice(0, 32);
  return getDisplayName(defaultName);
}

function updatePeopleMeta() {
  const box = el("sessionPeople");
  if (!box) return;

  if (!sessionId) {
    box.style.display = "none";
    box.textContent = "";
    return;
  }

  const names = [];

  // Always include "You"
  const you = (el("displayName")?.value || localStorage.getItem(DISPLAY_NAME_KEY) || "You").trim();
  if (you) names.push(you);

  // Add anyone we've seen contribute (from queue metadata)
  for (const q of (queue || [])) {
    const n = q?.addedBy?.displayName;
    if (n) names.push(String(n).trim());
  }

  const set = new Set(names.filter(Boolean));
  const uniq = Array.from(set).slice(0, 8);
  const extra = Math.max(0, set.size - uniq.length);

  box.style.display = "block";
  box.textContent = `Listening: ${uniq.join(", ")}${extra ? ` +${extra}` : ""}`;
}

function renderRejoinButton() {
  const btn = el("rejoinLast");
  if (!btn) return;

  // only show when NOT in a session
  if (sessionId) {
    btn.style.display = "none";
    return;
  }

  const last = (localStorage.getItem(LAST_SESSION_KEY) || "").trim().toUpperCase();
  const at = Number(localStorage.getItem(LAST_SESSION_AT_KEY) || 0);

  // hide if empty or very old (7 days)
  const tooOld = !at || (Date.now() - at) > 7 * 24 * 60 * 60 * 1000;
  if (!last || tooOld) {
    btn.style.display = "none";
    return;
  }

  btn.style.display = "inline-block";
  btn.textContent = `Rejoin ${last}`;
}

function canControlPlayback() {
  return !!(userId && hostUserId && (userId === hostUserId || allowGuestControl));
}

function renderGuestControlToggle() {
  const btn = el("toggleGuestControl");
  if (!btn) return;
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!sessionId || !isHost) {
    btn.style.display = "none";
    return;
  }
  btn.style.display = "inline-block";
  btn.textContent = `Guest controls: ${allowGuestControl ? "On" : "Off"}`;
}

function renderPartyModeToggle() {
  const btn = el("togglePartyMode");
  if (!btn) return;
  if (!sessionId || !isHost()) { btn.style.display = "none"; return; }
  btn.style.display = "inline-block";
  btn.textContent = `Party mode: ${partyMode ? "On" : "Off"}`;
}

// ---------- Session meta ----------
function renderSessionMeta() {
  const isHost = userId && hostUserId && userId === hostUserId;
  
  // Toggle topbar modes
  const pre = el("topbarPreSession");
  const ins = el("topbarInSession");
  if (sessionId) {
    if (pre) pre.style.display = "none";
    if (ins) ins.style.display = "flex";
  } else {
    if (pre) pre.style.display = "flex";
    if (ins) ins.style.display = "none";
  }

  // Update header text when in session
  if (sessionId) {
    const you = (el("displayName")?.value || localStorage.getItem(DISPLAY_NAME_KEY) || "You").trim() || "You";
    const hostLabel = hostUserId
      ? (hostUserId === userId ? you : "Host")
      : "Host";

    const hdr = el("sessionHeaderText");
    if (hdr) {
      hdr.textContent = `🎧 SyncSong | Room: ${sessionId} | You: ${you}${isHost ? " (host)" : ""} | Host: ${hostLabel}`;
    }
  }

  // Keep existing share/copy logic if you have it
  renderShareButton();
  renderRejoinButton();
  updatePeopleMeta();
  renderGuestControlToggle();
  renderPartyModeToggle();

    // Visual cue: guest playback controls locked
  document.body.classList.toggle(
    "guestLocked",
    !!sessionId && !isHost && !allowGuestControl
  );
  // If we're in a session, the auto-room hint is no longer relevant
  if (sessionId) el("autoRoomHint") && (el("autoRoomHint").style.display = "none");
}

async function leaveSession() {
  if (!sessionId) return;

  const leavingSessionId = sessionId;

  // Stop playback/timers first so we don’t keep playing after leaving
  try { await stopAllLocalPlayback(); } catch {}

  // Best-effort notify server (safe if server ignores this message)
  try { send("session:leave", { sessionId: leavingSessionId }); } catch {}

  // Clear local session state
  sessionId = null;
  hostUserId = null;
  queue = [];
  nowPlaying = null;
  localActiveQueueId = "";
  lastLoadedQueueKey = "";
  pendingCreate = false;
  autoAdvanceLock = false;

  // Reset UI fields
  if (el("joinCode")) el("joinCode").value = "";

  // Re-render UI back to pre-session mode
  try { renderNowPlaying(); } catch {}
  try { renderQueue(); } catch {}
  try { renderSessionMeta(); } catch {}

  if (el("sessionMeta")) el("sessionMeta").textContent = "Left room.";
}

let guestHintShown = false;

function maybeShowGuestHint() {
  if (guestHintShown || allowGuestControl || isHost()) return;
  guestHintShown = true;
  el("sessionMeta").textContent = "Playback requests are sent to the host.";
}

function getRoomCodeFromUrl() {
  try {
    const u = new URL(window.location.href);
    const code =
      normalizeSessionCode(u.searchParams.get(ROOM_QUERY_PARAM)) ||
      normalizeSessionCode(u.searchParams.get("session")) ||
      normalizeSessionCode(u.searchParams.get("code"));
    return code;
  } catch {
    return "";
  }
}

// ---------- WS ----------
function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    el("sessionMeta").textContent = "";
    pendingCreate = false; // allow session:create to be attempted again

    if (discordActivity.enabled && discordActivity.token) {
      send("auth:discordActivity", { token: discordActivity.token });
    }

    renderRejoinButton();

    if (pendingJoinCode) {
      requestJoinSession(pendingJoinCode);
    }
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "hello") {
      userId = msg.userId;
      return;
    }

    if (msg.type === "auth:ok" && msg.provider === "discord_activity") {
      const name = String(msg.displayName || "");
      if (!sessionId) {
        el("sessionMeta").textContent = name
          ? `Discord Activity linked as ${name}.`
          : "Discord Activity linked.";
      }
      renderActivityDebugLine();
      if (shouldAttemptActivityAutoJoin()) {
        send("session:autoJoinActivity", {});
      }
      return;
    }

    if (msg.type === "session:autoJoined") {
      sessionId = String(msg.sessionId || "").trim().toUpperCase();
      if (sessionId) {
        localStorage.setItem(LAST_SESSION_KEY, sessionId);
        localStorage.setItem(LAST_SESSION_AT_KEY, String(Date.now()));
      }
      return;
    }

    if (msg.type === "session:autoJoin:miss") {
      if (!sessionId && isDiscordActivityMode()) {
        el("sessionMeta").textContent = "No active room in this Discord Activity yet. Add a song to create one.";
      }
      return;
    }

    if (msg.type === "session:created") {
      sessionId = msg.sessionId;
      localStorage.setItem(LAST_SESSION_KEY, sessionId);
      localStorage.setItem(LAST_SESSION_AT_KEY, String(Date.now()));
      pendingCreate = false;
      renderSessionMeta();

      // If user clicked +Add before session existed, add now
      if (pendingAddTracks.length) {
        const batch = pendingAddTracks.slice();
        pendingAddTracks.length = 0;

        for (const t of batch) {
          send("queue:add", { sessionId, track: t });
        }

        setTimeout(() => autoCopyInvitePulse(), 50);
      } else {
        setTimeout(() => autoCopyInvitePulse(), 50);
      }
      return;
    }

    if (msg.type === "session:state") {
      sessionId = msg.sessionId;
      localStorage.setItem(LAST_SESSION_KEY, sessionId);
      localStorage.setItem(LAST_SESSION_AT_KEY, String(Date.now()));
      hostUserId = msg.hostUserId;
      allowGuestControl = !!msg.allowGuestControl;
      partyMode = !!msg.partyMode
      queue = msg.queue || [];
      nowPlaying = msg.nowPlaying || null;

      updatePeopleMeta();
      renderSessionMeta();
      renderQueue();
      if (!document.hidden) renderNowPlaying();


      // ✅ IMPORTANT: guest join sync guard
      const isHost = userId && hostUserId && userId === hostUserId;
      if (!isHost && nowPlaying?.playheadMs > 0) {
        // give the seek time to apply before pollers fight it
        remoteSeekIgnoreUntil = Date.now() + 1200;
      }

      // ✅ Party mode: guests do NOT sync playback. They should stop audio.
      if (isSilentGuest()) {
        await stopAllLocalPlayback();
        return;
      }
      syncClientToNowPlaying();
      return;
    }

    if (msg.type === "queue:updated") {
      queue = msg.queue || [];
      updatePeopleMeta();
      renderQueue();
      return;
    }

    if (msg.type === "nowPlaying:updated") {
      const prev = nowPlaying;
      nowPlaying = msg.nowPlaying || null;

      // ✅ NEW: if playhead jumped, give the client a short window to apply the seek
      const prevMs = Number(prev?.playheadMs || 0);
      const nextMs = Number(nowPlaying?.playheadMs || 0);
      if (Math.abs(nextMs - prevMs) > 1500) {
        remoteSeekIgnoreUntil = Date.now() + 900;
      }

      if (!document.hidden) renderNowPlaying();
      if (isSilentGuest()) {
        return;
      }
      syncClientToNowPlaying();
      return;
    }

    if (msg.type === "control:next") {
      const isHost = userId && hostUserId && userId === hostUserId;
      if (!isHost) return;
      await playNextInSharedQueue();
      return;
    }

    if (msg.type === "control:prev") {
      const isHost = userId && hostUserId && userId === hostUserId;
      if (!isHost) return;
      await playPrevInSharedQueue();
      return;
    }

    if (msg.type === "control:toggle") {
      const isHost = userId && hostUserId && userId === hostUserId;
      if (!isHost) return;

      if (!nowPlaying?.queueId && queue.length) {
        await hostPlayQueueItem(queue[0]);
        return;
      }
      if (!nowPlaying?.track) return;

      const willPlay = !nowPlaying.isPlaying;
      hostIntentIsPlaying = willPlay;

      try {
        if (playbackSource === "apple") {
          if (willPlay) await applePlay();
          else await applePause();
        } else if (playbackSource === "spotify") {
          if (willPlay) await playerPlay();
          else await playerPause();
        }
      } catch {}

      nowPlaying = { ...nowPlaying, isPlaying: willPlay, updatedAt: Date.now() };
      send("host:state", { sessionId, nowPlaying });
      if (!document.hidden) renderNowPlaying();
      return;
    }

    if (msg.type === "control:seek") {
      const isHost = userId && hostUserId && userId === hostUserId;
      if (!isHost) return;

      const secs = Number(msg.payload?.secs);
      if (!Number.isFinite(secs) || secs < 0) return;

      ignoreForMs(900);
      stopSpotifyStateSync();
      stopAppleStateSync();

      try {
        if (playbackSource === "apple") {
          const { appleSeek } = await import("./providers/apple.js");
          await appleSeek(secs);
        } else {
          await playerSeek(secs);
        }
      } catch {}

      const playheadMs = Math.floor(secs * 1000);
      nowPlaying = { ...nowPlaying, playheadMs, updatedAt: Date.now() };
      send("host:state", { sessionId, nowPlaying });
      if (!document.hidden) renderNowPlaying();
      return;
    }


    if (msg.type === "error") {
      const message = String(msg.message || "");

      // If the user clicked "Rejoin" but the room is gone, stop showing the button.
      if (!sessionId && lastRejoinAttempt && /session not found/i.test(message)) {
        const stored = (localStorage.getItem(LAST_SESSION_KEY) || "").trim().toUpperCase();
        if (stored === lastRejoinAttempt) {
          localStorage.removeItem(LAST_SESSION_KEY);
          localStorage.removeItem(LAST_SESSION_AT_KEY);
          lastRejoinAttempt = "";
          renderRejoinButton();
          el("sessionMeta").textContent = "That room has ended.";
          return;
        }
      }

      el("sessionMeta").textContent = `Error: ${message}`;
    }
  };

  ws.onclose = () => {
    el("sessionMeta").textContent = "Disconnected (reconnect in 2s)";
    setTimeout(connectWS, 2000);
  };
}

// ---------- Music panel rendering + loading ----------

function renderConnectPrompt() {
  const box = el("connectPrompt");
  if (!box) return;

  const needsConnect = !hasSpotifyAuth() && !hasAppleAuth();
  box.style.display = needsConnect ? "block" : "none";
}

function renderConnectButtons() {
  const sp = el("connectSpotify");
  const ap = el("connectApple");
  const spOut = el("signOutSpotify");
  const apOut = el("signOutApple");
  const prompt = el("connectPrompt");

  const promptVisible = prompt && prompt.style.display !== "none";

  // If the big prompt is visible, hide the small buttons
  if (promptVisible) {
    if (sp) sp.style.display = "none";
    if (ap) ap.style.display = "none";
    if (spOut) spOut.style.display = "none";
    if (apOut) apOut.style.display = "none";
    return;
  }

  // Only show the connect button for the CURRENT music tab
  if (musicSource === "spotify") {
    if (sp) sp.style.display = hasSpotifyAuth() ? "none" : "inline-block";
    if (spOut) spOut.style.display = hasSpotifyAuth() ? "inline-block" : "none";
    if (ap) ap.style.display = "none";
    if (apOut) apOut.style.display = "none";
    return;
  }

  if (musicSource === "apple") {
    if (ap) ap.style.display = hasAppleAuth() ? "none" : "inline-block";
    if (apOut) apOut.style.display = hasAppleAuth() ? "inline-block" : "none";
    if (sp) sp.style.display = "none";
    if (spOut) spOut.style.display = "none";
    return;
  }

  // default safety
  if (sp) sp.style.display = "none";
  if (ap) ap.style.display = "none";
  if (spOut) spOut.style.display = "none";
  if (apOut) apOut.style.display = "none";
}

function renderMusicTabs() {
  el("sourceSpotify")?.classList.toggle("active", musicSource === "spotify");
  el("sourceApple")?.classList.toggle("active", musicSource === "apple");

  renderConnectPrompt();
  renderConnectButtons();

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
  if (musicSource === "spotify") desired = localStorage.getItem(LAST_SPOTIFY_PLAYLIST_KEY);
  if (musicSource === "apple") desired = localStorage.getItem(LAST_APPLE_PLAYLIST_KEY);

  const exists = desired && playlists.some(p => String(p.id) === String(desired));
  const initialId = exists ? String(desired) : String(playlists[0].id);

  sel.value = initialId;
}

function applySearch() {
  const q = (el("searchMine")?.value || "").toLowerCase().trim();
  const isSpotifyAllLibrary =
    musicSource === "spotify" &&
    String(el("musicPlaylists")?.value || "") === SPOTIFY_LIBRARY_TRACKS_ID;
  const isAppleAllLibrary =
    musicSource === "apple" &&
    String(el("musicPlaylists")?.value || "") === APPLE_LIBRARY_TRACKS_ID;

  if (isSpotifyAllLibrary && q && spotifyLibrarySearchResults) {
    tracksFiltered = spotifyLibrarySearchResults;
    renderMusicTracks();
    return;
  }

  if (isAppleAllLibrary && q && appleLibrarySearchResults) {
    tracksFiltered = appleLibrarySearchResults;
    renderMusicTracks();
    return;
  }

  tracksFiltered = !q
    ? tracks
    : tracks.filter((t) =>
        `${t.title} ${t.artist} ${t.album || ""}`.toLowerCase().includes(q)
      );
  renderMusicTracks();
}

async function searchAppleLibraryNow(term) {
  const requestId = ++appleLibrarySearchRequestId;
  const q = String(term || "").trim();
  if (!q) {
    appleLibrarySearchResults = null;
    applySearch();
    return;
  }

  el("sessionMeta").textContent = `Searching Apple library for "${q}"...`;
  try {
    const { searchAppleLibrarySongs } = await import("./providers/apple.js");
    const { tracks: found } = await searchAppleLibrarySongs(q, { limit: 100 });
    if (requestId !== appleLibrarySearchRequestId) return;
    appleLibrarySearchResults = found;
    tracksFiltered = found;
    renderMusicTracks();
    el("sessionMeta").textContent = `Found ${found.length} Apple library songs for "${q}".`;
  } catch (e) {
    if (requestId !== appleLibrarySearchRequestId) return;
    appleLibrarySearchResults = null;
    applySearch();
    el("sessionMeta").textContent = `Apple search failed: ${e?.message || String(e)}`;
  }
}

async function searchSpotifyLibraryNow(term) {
  const requestId = ++spotifyLibrarySearchRequestId;
  const q = String(term || "").trim();
  if (!q) {
    spotifyLibrarySearchResults = null;
    applySearch();
    return;
  }

  el("sessionMeta").textContent = `Searching Spotify library for "${q}"...`;
  try {
    const { searchSpotifyLibrarySongs } = await import("./providers/spotify.js");
    const { tracks: found } = await searchSpotifyLibrarySongs(q, { limit: 50 });
    if (requestId !== spotifyLibrarySearchRequestId) return;
    spotifyLibrarySearchResults = found;
    tracksFiltered = found;
    renderMusicTracks();
    el("sessionMeta").textContent = `Found ${found.length} Spotify library songs for "${q}".`;
  } catch (e) {
    if (requestId !== spotifyLibrarySearchRequestId) return;
    spotifyLibrarySearchResults = null;
    applySearch();
    el("sessionMeta").textContent = `Spotify search failed: ${e?.message || String(e)}`;
  }
}

function handleSearchInput() {
  const q = (el("searchMine")?.value || "").trim();
  const isSpotifyAllLibrary =
    musicSource === "spotify" &&
    String(el("musicPlaylists")?.value || "") === SPOTIFY_LIBRARY_TRACKS_ID;
  const isAppleAllLibrary =
    musicSource === "apple" &&
    String(el("musicPlaylists")?.value || "") === APPLE_LIBRARY_TRACKS_ID;

  if (!isSpotifyAllLibrary && !isAppleAllLibrary) {
    spotifyLibrarySearchRequestId += 1;
    spotifyLibrarySearchResults = null;
    if (spotifyLibrarySearchTimer) clearTimeout(spotifyLibrarySearchTimer);
    appleLibrarySearchRequestId += 1;
    appleLibrarySearchResults = null;
    if (appleLibrarySearchTimer) clearTimeout(appleLibrarySearchTimer);
    applySearch();
    return;
  }

  if (!q) {
    spotifyLibrarySearchRequestId += 1;
    spotifyLibrarySearchResults = null;
    if (spotifyLibrarySearchTimer) clearTimeout(spotifyLibrarySearchTimer);
    appleLibrarySearchRequestId += 1;
    appleLibrarySearchResults = null;
    if (appleLibrarySearchTimer) clearTimeout(appleLibrarySearchTimer);
    applySearch();
    return;
  }

  if (isSpotifyAllLibrary) {
    if (spotifyLibrarySearchTimer) clearTimeout(spotifyLibrarySearchTimer);
    spotifyLibrarySearchTimer = setTimeout(() => {
      searchSpotifyLibraryNow(q);
    }, 220);
    return;
  }

  if (isAppleAllLibrary) {
    if (appleLibrarySearchTimer) clearTimeout(appleLibrarySearchTimer);
    appleLibrarySearchTimer = setTimeout(() => {
      searchAppleLibraryNow(q);
    }, 220);
  }
}

function renderMusicTracks() {
  const box = el("musicTracks");
  if (!box) return;

  box.innerHTML = "";
  tracksFiltered.forEach((t) => {
    const row = document.createElement("div");
    row.className = "item";

    row.innerHTML = `
      <div class="left trackLeft">
        <img class="trackArt" src="${escapeHtml(t.artworkUrl || "")}" alt="" loading="lazy" />
        <div class="trackText">
          <div class="title">${escapeHtml(t.title)}</div>
          <div class="meta">${escapeHtml(t.artist)} • ${escapeHtml(t.album || "")} • ${fmtMs(t.durationMs)}</div>
        </div>
      </div>
      <div class="actions">
        <button data-add="${t.id}">+ Add</button>
      </div>
    `;

    const img = row.querySelector(".trackArt");
    if (img) {
      img.onerror = () => { img.style.display = "none"; };
      if (!t.artworkUrl) img.style.display = "none";
    }

    row.querySelector("[data-add]").addEventListener("click", () => addToQueue(t));

    box.appendChild(row);
  });
  updateAddAllButton();
}

function addAllToQueue() {
  tracksFiltered.forEach((t) => {
    addToQueue(t);
  })
}

function updateAddAllButton() {
  const btn = el("addAllTracks");
  if (!btn) return;
  btn.disabled = !tracksFiltered.length;
}

async function ensureSpotifyLibraryReady() {
  // We consider "connected" if refresh token exists (best) or access token exists
  const rt = localStorage.getItem("spotify:refresh_token") || "";
  const at = localStorage.getItem("spotify:access_token") || "";

  if (!rt && !at) return false;

  try {
    const { spotifyEnsureAccessToken, spotifyFetch } = await import("./providers/spotify.js");

    // If refresh token exists, refresh/ensure silently
    if (rt) await spotifyEnsureAccessToken();

    // sanity check: forces 401/403 to surface
    await spotifyFetch("/me");
    return true;
  } catch (e) {
    // If token is invalid/expired and refresh didn’t work, clear and show connect again
    console.warn("[spotify] auth invalid; clearing tokens", e);
    localStorage.removeItem("spotify:access_token");
    localStorage.removeItem("spotify:refresh_token");
    localStorage.removeItem("spotify:expires_at");
    return false;
  }
}

// Spotify playlist/track helpers moved to providers/spotify.js
async function loadSpotifyPlaylistsAndTracks() {
  const ok = await ensureSpotifyLibraryReady();
  if (!ok) {
    playlists = [];
    tracks = [];
    renderMusicPlaylists();
    applySearch();
    el("sessionMeta").textContent = "Sign in with Spotify to load your library.";
    renderConnectPrompt();
    renderConnectButtons();
    return;
  }

  const { playlists: pls, note } =
    await import("./providers/spotify.js").then(m => m.loadSpotifyPlaylistsAndTracks());

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
  const selId = el("musicPlaylists").value;
  if (selId) {
    await loadSpotifyTracks(selId);
  }
}


async function loadSpotifyTracks(playlistId) {
  const requestId = ++spotifyTracksLoadRequestId;
  const selectedId = String(playlistId || "");
  const isAllLibrary = selectedId === SPOTIFY_LIBRARY_TRACKS_ID;
  let lastUiUpdateAt = 0;

  spotifyLibrarySearchRequestId += 1;
  spotifyLibrarySearchResults = null;
  if (spotifyLibrarySearchTimer) clearTimeout(spotifyLibrarySearchTimer);

  tracks = [];
  applySearch();
  if (isAllLibrary) {
    el("sessionMeta").textContent = "Loading Spotify library songs...";
  }

  const { loadSpotifyTracksProgressive } = await import("./providers/spotify.js");
  const { tracks: t } = await loadSpotifyTracksProgressive(playlistId, {
    onChunk: ({ tracks: chunkedTracks, total, done }) => {
      if (requestId !== spotifyTracksLoadRequestId) return;

      const now = Date.now();
      if (!done && now - lastUiUpdateAt < 250) return;
      lastUiUpdateAt = now;

      tracks = chunkedTracks;
      const currentSearchText = (el("searchMine")?.value || "").trim();
      if (!(isAllLibrary && currentSearchText)) {
        applySearch();
      }

      if (isAllLibrary) {
        el("sessionMeta").textContent = done
          ? `Loaded ${total} Spotify library songs.`
          : `Loading Spotify library songs... ${total} loaded`;
      }
    },
  });

  if (requestId !== spotifyTracksLoadRequestId) return;
  tracks = t;
  const currentSearchText = (el("searchMine")?.value || "").trim();
  if (!(isAllLibrary && currentSearchText)) {
    applySearch();
  }

  if (isAllLibrary && currentSearchText) {
    handleSearchInput();
  }
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
  const requestId = ++appleTracksLoadRequestId;
  const selectedId = String(playlistId || "");
  const isAllLibrary = selectedId === APPLE_LIBRARY_TRACKS_ID;
  let lastUiUpdateAt = 0;

  appleLibrarySearchRequestId += 1;
  appleLibrarySearchResults = null;
  if (appleLibrarySearchTimer) clearTimeout(appleLibrarySearchTimer);

  tracks = [];
  applySearch();
  if (isAllLibrary) {
    el("sessionMeta").textContent = "Loading Apple library songs...";
  }

  const { loadAppleTracksProgressive } = await import("./providers/apple.js");
  const { tracks: t } = await loadAppleTracksProgressive(playlistId, {
    onChunk: ({ tracks: chunkedTracks, total, done }) => {
      if (requestId !== appleTracksLoadRequestId) return;

      const now = Date.now();
      if (!done && now - lastUiUpdateAt < 250) return;
      lastUiUpdateAt = now;

      tracks = chunkedTracks;
      const currentSearchText = (el("searchMine")?.value || "").trim();
      if (!(isAllLibrary && currentSearchText)) {
        applySearch();
      }

      if (isAllLibrary) {
        el("sessionMeta").textContent = done
          ? `Loaded ${total} Apple library songs.`
          : `Loading Apple library songs... ${total} loaded`;
      }
    },
  });

  if (requestId !== appleTracksLoadRequestId) return;
  tracks = t;
  const currentSearchText = (el("searchMine")?.value || "").trim();
  if (!(isAllLibrary && currentSearchText)) {
    applySearch();
  }

  if (isAllLibrary && currentSearchText) {
    handleSearchInput();
  }
}


// Apple renderer helpers have been moved to ./providers/apple.js
// See: renderer/providers/apple.js



// ---------- Music reload ----------

async function reloadMusic() {
  if (musicSource === "apple") return loadApplePlaylistsAndTracks();
  if (musicSource === "spotify") {
    return loadSpotifyPlaylistsAndTracks();
  }
  return loadApplePlaylistsAndTracks();
}

async function setSource(next) {
  musicSource = next;
  localStorage.setItem(LAST_SOURCE_KEY, musicSource);
  renderMusicTabs();
  await reloadMusic();
}

// ---------- Queue + playback ----------
function ensureSessionForAdd(track) {
  if (!ensureDiscordActivityReady()) return false;
  if (sessionId) return true;

  pendingAddTracks.push(track);

  // If we're not connected yet, don't lock pendingCreate forever
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    el("sessionMeta").textContent = "Connecting… try again in a moment.";
    return false;
  }

  if (!pendingCreate) {
    pendingCreate = true;
    const displayName = getPreferredDisplayName("Host");

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

function capitalizeFirstLetter(val) {
    return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

function applyAndSendQueueOrder(newQueue) {
  if (!sessionId) return;
  queue = newQueue;
  updatePeopleMeta?.();
  renderQueue();
  // Send only the order of queueIds (server should reorder its queue)
  send("queue:reorder", { sessionId, order: queue.map(q => q.queueId) });
}

function renderQueue() {
  const box = el("queue");
  if (!box) return;

  box.innerHTML = "";
  const isHost = userId && hostUserId && userId === hostUserId;
  const canControl = canControlPlayback();

  queue.forEach((q) => {
    const t = q.track;
    const row = document.createElement("div");
    row.className = "item";
    if (canControl) row.classList.add("queueItemHost");
    row.innerHTML = `
      <div class="trackLeft">
        <img class="trackArt" src="${escapeHtml(t.artworkUrl || "")}" alt="" loading="lazy" />
        <div class="trackText">
          <div class="title">${escapeHtml(t.title)}</div>
          <div class="meta">${escapeHtml(t.artist)} •  ${escapeHtml(t.album || "")} • added by ${escapeHtml(q.addedBy?.displayName || "someone")} from ${escapeHtml(capitalizeFirstLetter(t.source) || "")}</div>
        </div>
          </div>
      <div class="actions">
        ${canControl ? `<span class="dragHandle" title="Drag to reorder" aria-label="Drag to reorder">☰</span>` : ``}
        ${canControl ? `<button data-play="${q.queueId}">Play</button>` : ``}
        ${canControl ? `<button data-remove="${q.queueId}">Remove</button>` : ``}
      </div>
    `;

    if (canControl) {
      row.querySelector("[data-play]").addEventListener("click", () => hostPlayQueueItem(q));
      row.querySelector("[data-remove]").addEventListener("click", () =>
        send("queue:remove", { sessionId, queueId: q.queueId })
      );
    }

    if (canControl) {
      // Drag reorder (controller-only)
      row.draggable = true;
      row.dataset.qid = q.queueId;

      row.addEventListener("dragstart", (e) => {
        dragQueueId = q.queueId;
        row.classList.add("queueDragging");
        try { e.dataTransfer.effectAllowed = "move"; } catch {}
      });

      row.addEventListener("dragend", () => {
        dragQueueId = null;
        row.classList.remove("queueDragging");
        document.querySelectorAll(".queueDragOver").forEach(n => n.classList.remove("queueDragOver"));
      });

      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        row.classList.add("queueDragOver");
        try { e.dataTransfer.dropEffect = "move"; } catch {}
      });

      row.addEventListener("dragleave", () => {
        row.classList.remove("queueDragOver");
      });

      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("queueDragOver");
        const fromId = dragQueueId;
        const toId = row.dataset.qid;
        if (!fromId || !toId || fromId === toId) return;

        const fromIdx = queue.findIndex(x => x.queueId === fromId);
        const toIdx = queue.findIndex(x => x.queueId === toId);
        if (fromIdx < 0 || toIdx < 0) return;

        const next = queue.slice();
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        applyAndSendQueueOrder(next);
      });
    }



    const img = row.querySelector(".trackArt");
    if (img) {
      img.onerror = () => { img.style.display = "none"; };
      if (!t.artworkUrl) img.style.display = "none";
    }

    box.appendChild(row);
  });
}

async function hostPlayQueueItem(qItem, { isPlaying } = {}) {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;

  autoAdvanceLock = false;

  const nextIsPlaying = (typeof isPlaying === "boolean") ? isPlaying : true;

  hostIntentIsPlaying = nextIsPlaying;

  nowPlaying = {
    queueId: qItem.queueId,
    track: qItem.track,
    isPlaying: nextIsPlaying,
    playheadMs: 0,
    updatedAt: Date.now(),
  };

  localActiveQueueId = nowPlaying.queueId;

  send("host:state", { sessionId, nowPlaying });
  if (!document.hidden) renderNowPlaying();

  await syncClientToNowPlaying();
}

async function playNextInSharedQueue() {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;
  if (!queue.length) return;

  // prevent pollers from fighting the transition
  ignoreForMs(1500);
  stopSpotifyStateSync();
  stopAppleStateSync();

  const wasPlaying = hostIntentIsPlaying;

  if (!nowPlaying?.queueId) {
    await hostPlayQueueItem(queue[0], { isPlaying: wasPlaying });
    return;
  }

  const idx = queue.findIndex(q => q.queueId === nowPlaying.queueId);
  if (idx < 0) {
    await hostPlayQueueItem(queue[0], { isPlaying: wasPlaying });
    return;
  }

  const nextIdx = idx + 1;

  if (nextIdx >= queue.length) {
    if (!loopQueue) return;
    await hostPlayQueueItem(queue[0], { isPlaying: wasPlaying });
    return;
  }

  await hostPlayQueueItem(queue[nextIdx], { isPlaying: wasPlaying });
}


async function playPrevInSharedQueue() {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;
  if (!queue.length) return;

  ignoreForMs(1500);
  stopSpotifyStateSync();
  stopAppleStateSync();

  if (!nowPlaying?.queueId) {
    await hostPlayQueueItem(queue[0]);
    return;
  }

  const idx = queue.findIndex(q => q.queueId === nowPlaying.queueId);
  const prevIdx = idx <= 0 ? (loopQueue ? queue.length - 1 : 0) : idx - 1;
  await hostPlayQueueItem(queue[prevIdx]);
}

async function playTrackOnMySource(track) {
  if (!track) return;


  if (playbackSource === "apple") {
    await applePlayTrack(track);
    startAppleStateSync();
    return;
  }

  if (playbackSource === "spotify") {
    spotifyPollIgnoreUntil = Date.now() + 1200; // 1.2s transition window
    const uri = await spotifyFindUriForTrack(track);
    if (!uri) throw new Error("Could not find this track on Spotify via search.");

    lastSpotifyUriLoaded = uri; // ✅ remember what we intended to play
    await spotifyPlayUriInApp(uri);
    startSpotifyStateSync();
    return;
  }
}

async function syncClientToNowPlaying() {
  if (isSilentGuest()) return
  if (!nowPlaying?.track) return;

  const loadKey = `${nowPlaying.queueId}:${playbackSource}`;

  if (!nowPlaying.isPlaying) {
    try {
      if (playbackSource === "apple") await applePause();
      else await playerPause();
    } catch {}
    return;
  }

  const targetMs = Number(nowPlaying.playheadMs || 0);

  // helper: only seek when it’s meaningful, and don’t fight the user while scrubbing
  const maybeSeekToTarget = async () => {
    if (!targetMs || isScrubbing) return;

    const localMs =
      playbackSource === "spotify" ? Number(lastSpotifyPosMs || 0)
      : playbackSource === "apple" ? Number(lastApplePosMs || 0)
      : 0;

    const drift = Math.abs(localMs - targetMs);

    // Only correct meaningful drift so we don't constantly micro-adjust
    if (drift <= 1200) return;

    try {
      // ✅ give the seek a moment to apply before pollers snap UI back
      remoteSeekIgnoreUntil = Date.now() + 900;
      if (playbackSource === "apple") {
        const { appleSeek } = await import("./providers/apple.js");
        await appleSeek(targetMs / 1000);
      } else {
        await playerSeek(targetMs / 1000);
      }
    } catch {}
  };

  if (loadKey === lastLoadedQueueKey) {
    try {
      if (playbackSource === "apple") {
        await applePlay();
        startAppleStateSync();
      } else if (playbackSource === "spotify") {
        //await playerPlay();
        startSpotifyStateSync();
      }
    } catch {}
    await maybeSeekToTarget();          // ✅ apply seek on guests too
    return;
  }


  lastLoadedQueueKey = loadKey;
  localActiveQueueId = nowPlaying.queueId;

  try {
    await stopAllLocalPlayback();
    await playTrackOnMySource(nowPlaying.track);
  } catch (e) {
    el("sessionMeta").textContent =
      `Playback sync failed (${playbackSource}): ${e?.message || String(e)}`;
  }

  await maybeSeekToTarget();            // ✅ apply seek after load
}


async function stopAllLocalPlayback() {
  // stop Spotify polling if we leave spotify
  stopSpotifyStateSync?.();
  stopAppleStateSync?.();

  // Pause both engines best-effort
  try { await playerPause(); } catch {}
  try { await applePause(); } catch {}

  // If you added mk.stop() inside applePlayTrack you can optionally expose an appleStop() too
  // try { await appleStop(); } catch {}
}


let spotifyStateTimer = null;

async function startSpotifyStateSync() {
  if (isSilentGuest()) return;
  // If we're in the ignore window, schedule a start right after it ends.
  const waitMs = Math.max(0, spotifyPollIgnoreUntil - Date.now());
  if (waitMs > 0) {
    setTimeout(() => startSpotifyStateSync(), waitMs + 50);
    return;
  }

  stopSpotifyStateSync();

  spotifyStateTimer = setInterval(async () => {
    try {
      if (inTransition()) return;
      if (Date.now() < remoteSeekIgnoreUntil) return;

      const { spotifyGetPlaybackState } = await import("./providers/spotify.js");
      const s = await spotifyGetPlaybackState();
      const currentUri = s?.track_window?.current_track?.uri || "";
      if (lastSpotifyUriLoaded && currentUri && currentUri !== lastSpotifyUriLoaded) {
        // Spotify drifted (autoplay/other device/etc). Ignore this state so we don't
        // advance the shared queue based on the wrong track.
        return;
      }
      if (!s) return;

      if (playbackSource !== "spotify") return;
      if (!nowPlaying?.track) return;
      if (isScrubbing) return;

      // inside the interval tick, before mutating nowPlaying:
      if (!nowPlaying?.queueId) return;
      if (nowPlaying.queueId !== localActiveQueueId) return; // ✅ ignore stale tick

      const dur = Number(s.duration || 0);
      const pos = Math.max(0, Math.min(Number(s.position || 0), dur || Infinity));
      lastSpotifyPosMs = pos;
      const paused = !!s.paused;

      nowPlaying = {
        ...nowPlaying,
        isPlaying: !paused,
        playheadMs: pos,
      };

      if (!document.hidden) renderNowPlaying();
      maybeBroadcastHostPlayhead();
    } catch {}
  }, 500);
}


function stopSpotifyStateSync() {
  if (spotifyStateTimer) clearInterval(spotifyStateTimer);
  spotifyStateTimer = null;
}

let appleStateTimer = null;

function stopAppleStateSync() {
  if (appleStateTimer) clearInterval(appleStateTimer);
  appleStateTimer = null;
}

async function startAppleStateSync() {
  if (isSilentGuest()) return;
  stopAppleStateSync();

  appleStateTimer = setInterval(async () => {
    try {
      if (playbackSource !== "apple") return;
      if (!nowPlaying?.track) return;
      if (isScrubbing) return;
      if (nowPlaying.queueId !== localActiveQueueId) return; // ✅ prevents mismatched UI
      if (inTransition()) return;
      if (Date.now() < remoteSeekIgnoreUntil) return;

      const { appleGetPlaybackState } = await import("./providers/apple.js");
      const a = await appleGetPlaybackState();

      if (!a) return;

      lastApplePosMs = Number(a.positionMs) || 0;

      // Keep UI driven by the *real* player clock
      nowPlaying = {
        ...nowPlaying,
        isPlaying: !!a.isPlaying,
        playheadMs: Number(a.positionMs),
        // NOTE: no startedAt updates here (you wanted to remove manual timestamping)
      };

      if (!document.hidden) renderNowPlaying();
      maybeBroadcastHostPlayhead();
    } catch {}
  }, 500);
}

function maybeBroadcastHostPlayhead() {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;
  if (!sessionId) return;
  if (!nowPlaying?.track) return;
  if (!nowPlaying.isPlaying) return;

  const now = Date.now();

  // throttle: at most once per second
  if (now - lastHostPlayheadSentAt < 1000) return;

  const ms = Math.floor(Number(nowPlaying.playheadMs || 0));

  // don’t spam identical values
  if (Math.abs(ms - lastHostPlayheadSentMs) < 800) return;

  lastHostPlayheadSentAt = now;
  lastHostPlayheadSentMs = ms;

  send("host:state", {
    sessionId,
    nowPlaying: {
      ...nowPlaying,
      playheadMs: ms,
      updatedAt: now,
    },
  });
}

// ---------- Now playing UI ----------

function computeExpectedPlayhead(np) {
  // No manual clock: UI uses last provider-reported position
  return Math.max(0, Number(np?.playheadMs ?? 0));
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
  const artEl = el("npArt");

  if (!titleEl || !barEl) return; // don't crash the app if markup changes


  if (!nowPlaying?.track) {
    titleEl.textContent = "Not playing";
    if (subEl) subEl.textContent = "";
    if (artEl) {
      artEl.src = "";
      artEl.style.display = "none";
    }
    barEl.style.width = "0%";
    return;
  }

  const t = nowPlaying.track;
  const dur = Math.max(0, Number(t.durationMs || 0));
  let playhead = computeExpectedPlayhead(nowPlaying);

  // ✅ clamp so UI can’t run past the end
  if (dur > 0) playhead = Math.max(0, Math.min(playhead, dur));

  if (posEl) posEl.textContent = fmtMs(playhead);
  if (durEl) durEl.textContent = fmtMs(t.durationMs || 0);
  if (artEl) {

    artEl.src = t.artworkUrl || "";
    artEl.style.display = t.artworkUrl ? "block" : "none";  
  }

  titleEl.textContent = t.title || "Unknown title";

  if (ppBtn) ppBtn.textContent = nowPlaying.isPlaying ? "❚❚" : "▶"; 

  if (subEl) {
    const sourceLabel =
      t.source === "spotify" ? "Spotify" :
      t.source === "apple" ? "Apple Music" :

      // ${fmtMs(playhead)} / ${fmtMs(t.durationMs || 0)}
    subEl.textContent =
      `${t.artist || ""}${t.album ? ` • ${t.album}` : ""}` +
      `${sourceLabel ? ` • ${sourceLabel}` : ""}`;
  }

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


let hostAutoAdvanceTimer = null;

function startHostAutoAdvance() {
  if (hostAutoAdvanceTimer) clearInterval(hostAutoAdvanceTimer);

  hostAutoAdvanceTimer = setInterval(async () => {
//     console.log("[autoAdvance tick]", {
//   lock: autoAdvanceLock,
//   queueId: nowPlaying?.queueId,
//   src: playbackSource,
//   hasTrack: !!nowPlaying?.track,
//   qlen: queue?.length
// });
    const isHost = userId && hostUserId && userId === hostUserId;
    if (!isHost || !sessionId) return;

    if (!nowPlaying) return;     // ✅ null-safe and allows end-of-track handling
    if (!queue?.length) return;

    // ✅ New shared item loaded → reset Apple end-detection state
    if (nowPlaying.queueId !== lastAutoAdvanceQueueId || playbackSource !== lastAutoAdvanceSource) {
      lastAutoAdvanceQueueId = nowPlaying.queueId;
      lastAutoAdvanceSource = playbackSource;
      lastApplePosMs = 0;
      lastSpotifyPosMs = 0;
      lastAppleMaxPosMs = 0;
      lastSpotifyMaxPosMs = 0;
      // ✅ new track is active → allow the next end-of-track advance
      autoAdvanceLock = false;
      
      return;
    }

    if (autoAdvanceLock) return;

    try {
      let posMs = null;
      let durMs = Number(nowPlaying?.track?.durationMs || 0);
      const END_BUFFER_MS = playbackSource === "apple" ? 1000 : 1000;

      let providerIsPlaying = true; // default
      let ended = false;

      if (playbackSource === "spotify") {
        const { spotifyGetPlaybackState } = await import("./providers/spotify.js");
        const s = await spotifyGetPlaybackState();
        if (!s) return; // or just skip this tick

        const currentUri = s?.track_window?.current_track?.uri || "";
        if (lastSpotifyUriLoaded && currentUri && currentUri !== lastSpotifyUriLoaded) return;

        const posMsNow = Number(s.position ?? 0);
        const durMsNow = Number(s.duration ?? 0);

        // update shared locals
        posMs = posMsNow;
        durMs = durMsNow || durMs; // fallback if provider missing
        providerIsPlaying = !s.paused;

        // ✅ max tracking for end detection
        const prevMaxPos = lastSpotifyMaxPosMs;
        if (posMsNow > lastSpotifyMaxPosMs) lastSpotifyMaxPosMs = posMsNow;

        const wasNearEnd = (durMsNow > 10_000) && (prevMaxPos >= durMsNow - END_BUFFER_MS);
        const jumpedToStart = (posMsNow < 1000) && (prevMaxPos > 5000);

        // Because you said Spotify reports paused=true at end, you can include it (optional)
        if (wasNearEnd && jumpedToStart && s.paused) ended = true;
      }

      if (playbackSource === "apple") {
        const { appleGetPlaybackState } = await import("./providers/apple.js");
        const a = await appleGetPlaybackState();
        if (!a) return;

        const aPos = Number(a.positionMs);
        const aDur = Number(a.durationMs);

        // Use provider duration if available, else fall back to track metadata duration (NOT a clock)
        if (aDur > 1000) durMs = aDur;

        posMs = aPos;
        providerIsPlaying = !!a.isPlaying;

        // Track last good position so we can detect the "snap to 0 when ended"
        const prevMaxPos = lastAppleMaxPosMs;
        if (posMs > lastAppleMaxPosMs) lastAppleMaxPosMs = posMs;

        const jumpedToStart = (posMs < 1000) && (prevMaxPos > 5000);
        const wasNearEnd = (durMs > 10_000) && (prevMaxPos >= durMs - END_BUFFER_MS);
        if (wasNearEnd && jumpedToStart && !providerIsPlaying) ended = true;
      }


      if (!ended) return;

      autoAdvanceLock = true;

      const unlockTimer = setTimeout(() => {
        // if we're still locked, release it so polling resumes
        autoAdvanceLock = false;
      }, 4000);
      try {
        lastAppleMaxPosMs = 0;
        lastSpotifyMaxPosMs = 0;
        await playNextInSharedQueue();
        clearTimeout(unlockTimer);
      } catch (e) {
        clearTimeout(unlockTimer);
        console.warn("[autoAdvance] advance failed", e);
        console.warn("[autoAdvance] failed; unlocking", e);
        // Important: don't get stuck
        autoAdvanceLock = false;
      }


    } catch {
      // ignore transient polling failures
    }
  }, 500);
}

async function advanceNextLikeButton() {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;

  // IMPORTANT: capture intent before we pause for the transition
  const wasPlaying = hostIntentIsPlaying;

  // advance shared queue; hostPlayQueueItem receives isPlaying via playNextInSharedQueue
  hostIntentIsPlaying = wasPlaying;
  await playNextInSharedQueue()

  // DO NOT call applePlay()/playerPlay() here.
  // hostPlayQueueItem() will do it after the new track is loaded.
}

async function switchPlaybackSource(next) {
  if (!next || next === playbackSource) return;

  // switching sources mid-session should be clean
  await stopAllLocalPlayback();

  playbackSource = next;
  localStorage.setItem(PLAYBACK_SOURCE_KEY, playbackSource);
  renderPlaybackSource();

  // force a reload of the currently shared track on the new provider
  lastLoadedQueueKey = "";

  if (playbackSource === "apple") startAppleStateSync();
  else stopAppleStateSync();

  await syncClientToNowPlaying();
}

// ---------- Button wiring ----------
function wireUi() {
  const isHostNow = () => userId && hostUserId && userId === hostUserId;
  // Session buttons

  // Display name: everyone can set this; persist locally
  const dn = el("displayName");
  if (dn) {
    const saved = (localStorage.getItem(DISPLAY_NAME_KEY) || "").trim();
    if (!dn.value && saved) dn.value = saved;
    dn.addEventListener("input", () => {
      const v = (dn.value || "").trim().slice(0, 32);
      localStorage.setItem(DISPLAY_NAME_KEY, v);
    });
  }

  // One-time hint: rooms are created automatically
  const hint = el("autoRoomHint");
  if (hint && !sessionId && !localStorage.getItem(AUTO_ROOM_HINT_SEEN_KEY)) {
    hint.textContent = "Rooms are created automatically when the host adds a song.";
    hint.style.display = "block";
    localStorage.setItem(AUTO_ROOM_HINT_SEEN_KEY, "1");
    setTimeout(() => { if (!sessionId) hint.style.display = "none"; }, 8000);
  }

  el("joinSession")?.addEventListener("click", () => {
    const code = normalizeSessionCode(el("joinCode").value);
    if (!code) return;
    requestJoinSession(code);

    // Hide hint once user takes action
    if (el("autoRoomHint")) el("autoRoomHint").style.display = "none";
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

  // Copy button in "in-session" header
  el("copySession2")?.addEventListener("click", async () => {
    await autoCopyInvitePulse();
  });

  el("leaveSession")?.addEventListener("click", async () => {
    await leaveSession();
  });

  el("toggleGuestControl")?.addEventListener("click", () => {
    const isHost = userId && hostUserId && userId === hostUserId;
    if (!isHost || !sessionId) return;
    send("session:setGuestControl", {
      sessionId,
      allowGuestControl: !allowGuestControl,
    });
  });

  el("togglePartyMode")?.addEventListener("click", () => {
    if (!isHost() || !sessionId) return;
    send("session:setPartyMode", { sessionId, partyMode: !partyMode });
  });

  el("rejoinLast")?.addEventListener("click", () => {
    const code = normalizeSessionCode(localStorage.getItem(LAST_SESSION_KEY));
    if (!code) return;
    requestJoinSession(code);
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

  el("addAllTracks")?.addEventListener("click", addAllToQueue)

  // Search
  el("searchMine")?.addEventListener("input", handleSearchInput);

  // Loop toggle
  el("toggleLoop")?.addEventListener("click", () => {
    if (!canControlPlayback()) return;
    loopQueue = !loopQueue;
    renderLoopToggle();
  });

  // Host controls
  el("npPlayPause")?.addEventListener("click", async () => {
    const isHost = userId && hostUserId && userId === hostUserId;
    if (!isHost) {
      send("control:toggle", { sessionId });
      return;
    }
    if (!canControlPlayback()) return;


    if (!nowPlaying?.queueId && queue.length) {
      await hostPlayQueueItem(queue[0]);
      return;
    }
    if (!nowPlaying?.track) return;


    const willPlay = !nowPlaying.isPlaying;

    hostIntentIsPlaying = willPlay;

    // ✅ Tell the local provider first (host is the source of truth for play/pause)
    try {
      if (playbackSource === "apple") {
        if (willPlay) await applePlay();
        else await applePause();
      } else if (playbackSource === "spotify") {
        if (willPlay) await playerPlay();
        else await playerPause();
      }
    } catch (e) {
      console.warn("[play/pause] provider command failed", e);
    }

    // ✅ Broadcast shared state (no manual timestamps)
    nowPlaying = {
      ...nowPlaying,
      isPlaying: willPlay,
      // keep the last provider-derived playhead (don’t overwrite it)
      playheadMs: Number(nowPlaying.playheadMs || 0),
      updatedAt: Date.now(),
    };

    maybeShowGuestHint();
    send("host:state", { sessionId, nowPlaying });
    if (!document.hidden) renderNowPlaying();
  });


  el("npNext")?.addEventListener("click", async () => {
    if (!canControlPlayback()) return;

    const isHost = userId && hostUserId && userId === hostUserId;
    if (!isHost) {
      maybeShowGuestHint();
      send("control:next", { sessionId });
      return;
    }

    hostIntentIsPlaying = !!nowPlaying?.isPlaying;
    await playNextInSharedQueue();
  });

  el("npPrev")?.addEventListener("click", async () => {
    if (!canControlPlayback()) return;

    const isHost = userId && hostUserId && userId === hostUserId;
    if (!isHost) {
      maybeShowGuestHint();
      send("control:prev", { sessionId });
      return;
    }

    await playPrevInSharedQueue();
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
      if (!canControlPlayback() || !nowPlaying) return;

      isScrubbing = true;
      scrubWasPlaying = !!nowPlaying.isPlaying;

      // Optional but recommended for smoothness:
      // pause locally while scrubbing if it was playing
      if (scrubWasPlaying) {
        try {
          if (playbackSource === "apple") await applePause();
          else await playerPause();
        } catch {}
      }

      dragging = true;
      setScrubbing(true);
      previewToPct(pctFromEvent(e));
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      previewToPct(pctFromEvent(e));
    });

    window.addEventListener("mouseup", async (e) => {
      if (!dragging) return;
      dragging = false;

      if (!nowPlaying) {
        isScrubbing = false;
        setScrubbing(false);
        return;
      }

      const pct = pctFromEvent(e);
      const durMs = Number(nowPlaying.track?.durationMs || 0);
      if (!durMs) {
        isScrubbing = false;
        setScrubbing(false);
        return;
      }

      // Clamp and compute target
      const clampedPct = Math.max(0, Math.min(1, pct));
      const targetMs = Math.max(0, Math.min(durMs - 250, Math.floor(durMs * clampedPct)));
      const secs = targetMs / 1000;

      const isHost = userId && hostUserId && userId === hostUserId;

      if (!isHost) {
        // -------------------------
        // GUEST: request seek from host
        // -------------------------
        send("control:seek", {
          sessionId,
          secs,
        });

        // Optimistic UI update (will be corrected by host broadcast)
        nowPlaying = {
          ...nowPlaying,
          playheadMs: targetMs,
        };
        if (!document.hidden) renderNowPlaying();

        isScrubbing = false;
        setScrubbing(false);
        return;
      }

      // -------------------------
      // HOST: perform the seek
      // -------------------------
      try {
        // prevent pollers from snapping UI back mid-seek
        ignoreForMs(900);
        stopSpotifyStateSync();
        stopAppleStateSync();

        if (playbackSource === "apple") {
          const { appleSeek } = await import("./providers/apple.js");
          await appleSeek(secs);
          if (scrubWasPlaying) {
            try { await applePlay(); } catch {}
          }
        } else {
          await playerSeek(secs);
          if (scrubWasPlaying) {
            try { await playerPlay(); } catch {}
          }
        }
        nowPlaying = {
          ...nowPlaying,
          playheadMs: targetMs,
          updatedAt: Date.now(),
        };

        send("host:state", { sessionId, nowPlaying });
        if (!document.hidden) renderNowPlaying();
      } catch (err) {
        console.warn("[seek] failed", err);
      }

      isScrubbing = false;
      setScrubbing(false);
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

    renderConnectPrompt();
    renderConnectButtons();
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

  // Connect prompt buttons (first-time users)
  el("connectPromptSpotify")?.addEventListener("click", () => {
    el("connectSpotify")?.click();
  });
  el("connectPromptApple")?.addEventListener("click", () => {
    el("connectApple")?.click();
  });

  el("signOutSpotify")?.addEventListener("click", async () => {
    localStorage.removeItem("spotify:access_token");
    localStorage.removeItem("spotify:refresh_token");
    localStorage.removeItem("spotify:expires_at");
    localStorage.removeItem("spotify:oauth_state");
    localStorage.removeItem("syncsong:lastSpotifyPlaylistId");
    renderConnectPrompt();
    renderConnectButtons();
    await reloadMusic();
    el("sessionMeta").textContent = "Signed out of Spotify.";
  });

  el("signOutApple")?.addEventListener("click", async () => {
    localStorage.removeItem("syncsong:appleUserToken");
    localStorage.removeItem("syncsong:lastApplePlaylistId");
    renderConnectPrompt();
    renderConnectButtons();
    await reloadMusic();
    el("sessionMeta").textContent = "Signed out of Apple Music.";
  });


  el("connectSpotify")?.addEventListener("click", async () => {
    try {
      if (IS_DISCORD_ACTIVITY_CONTEXT) {
        const linkToken = await requestProviderLinkToken("spotify");
        const linkUrl = makeProviderLinkUrl("spotify", linkToken);
        const opened = await openExternalLink(linkUrl);
        if (!opened) throw new Error("Could not open external browser for Spotify link.");
        startProviderLinkPolling("Spotify");
        el("sessionMeta").textContent =
          "Opened browser to link Spotify. Complete sign-in there, then return to Discord Activity.";
        return;
      }

      // Web: if we already have a refresh token, refresh silently and skip popup.
      if (!window?.api?.spotifyConnect) {
        const { spotifyEnsureAccessToken } = await import("./providers/spotify.js");
        const rt = localStorage.getItem("spotify:refresh_token") || "";
        if (rt) {
          await spotifyEnsureAccessToken();
          el("sessionMeta").textContent = "Spotify connected!";
          await syncLocalProvidersToDiscordLink();
          await syncLocalProvidersViaLinkToken();
          await switchPlaybackSource("spotify");
          await reloadMusic();
          renderConnectPrompt();
          renderConnectButtons();
          return;
        }
      }

      // Web path
      el("sessionMeta").textContent = "Opening Spotify authorization...";
      await import("./providers/spotify.js").then((m) => m.spotifyWebConnect({
        useRedirect: !!IS_DISCORD_ACTIVITY_CONTEXT,
      }));

      // In Discord Activity mode we use full-page redirect OAuth; this page will unload.
      if (IS_DISCORD_ACTIVITY_CONTEXT) return;

      // IMPORTANT: wait for callback to store token before using Spotify API
      await waitForSpotifyToken();
      try {
        const { spotifyFetch } = await import("./providers/spotify.js");
        await spotifyFetch("/me"); // forces allowlist/premium issues to show immediately
        
        el("sessionMeta").textContent = "Spotify connected!";
        await syncLocalProvidersToDiscordLink();
        await syncLocalProvidersViaLinkToken();
        await switchPlaybackSource("spotify");
        await reloadMusic();
        renderConnectPrompt();
        renderConnectButtons();
      } catch (e) {
        // Keep the token (OAuth succeeded), but give a clear next step.
        el("sessionMeta").textContent = (e?.message || String(e));
      }

    } catch (e) {
      console.error("[spotify] connect failed", e);
      const dbg = activityDebugSummary();
      el("sessionMeta").textContent =
        "Spotify connect failed: " + (e?.message || String(e)) + (dbg ? ` | ${dbg}` : "");
    }
  });

  // Apple Music connect
  el("connectApple")?.addEventListener("click", async () => {
    try {
      if (IS_DISCORD_ACTIVITY_CONTEXT) {
        const linkToken = await requestProviderLinkToken("apple");
        const linkUrl = makeProviderLinkUrl("apple", linkToken);
        const opened = await openExternalLink(linkUrl);
        if (!opened) throw new Error("Could not open external browser for Apple Music link.");
        startProviderLinkPolling("Apple Music");
        el("sessionMeta").textContent =
          "Opened browser to link Apple Music. Complete sign-in there, then return to Discord Activity.";
        return;
      }

      const mk = await ensureAppleConfigured();
      const userToken = await mk.authorize(); // triggers Apple sign-in
      localStorage.setItem(APPLE_USER_TOKEN_KEY, userToken);
      el("sessionMeta").textContent = "Apple Music connected!";
      await syncLocalProvidersToDiscordLink();
      await syncLocalProvidersViaLinkToken();
      await switchPlaybackSource("apple");
      await reloadMusic();
      renderConnectPrompt();
      renderConnectButtons();
    } catch (e) {
      const base = "Apple connect failed: " + (e?.message || String(e));
      if (IS_DISCORD_ACTIVITY_CONTEXT) {
        el("sessionMeta").textContent =
          `${base} In Discord Activity, Apple sign-in may be blocked by embedded popup restrictions.` +
          (activityDebugSummary() ? ` | ${activityDebugSummary()}` : "");
      } else {
        el("sessionMeta").textContent = base;
      }
    }
  });

  el("playbackSource")?.addEventListener("change", async () => {
    await stopAllLocalPlayback();
    playbackSource = el("playbackSource").value;
    localStorage.setItem(PLAYBACK_SOURCE_KEY, playbackSource);

    lastLoadedQueueKey = "";

    // start/stop UI pollers based on source
    if (playbackSource === "apple") startAppleStateSync();
    else stopAppleStateSync();

    await syncClientToNowPlaying();
    try { await playerSetVolume(playerVolume01); } catch {}
  });

   // -------------------------
  // Local volume + mute (does not sync)
  // -------------------------
  const vol = el("playerVolume");
  const volVal = el("playerVolumeVal");
  const muteBtn = el("playerMute");
  //const muteTip = el("playerMuteTip");

  function setSliderFill() { if (vol) vol.style.setProperty("--vol", `${Math.round(playerVolume01 * 100)}%`); }

  function setMuteIcon() {
    if (!muteBtn) return;
    // 🔇 when muted, 🔊 otherwise
    muteBtn.textContent = playerVolume01 <= 0 ? "🔇" : "🔊";
    const isMuted = playerVolume01 <= 0;
    //if (muteTip) muteTip.setAttribute("data-tip", isMuted ? "Unmute" : "Mute");
    muteBtn.setAttribute("aria-label", isMuted ? "Unmute" : "Mute");
  }

  async function applyVolume() {
    try { await playerSetVolume(playerVolume01); } catch {}
  }

  if (vol) {
    vol.value = String(Math.round(playerVolume01 * 100));
    if (volVal) volVal.textContent = `${Math.round(playerVolume01 * 100)}%`;
    setSliderFill();
    setMuteIcon();

    vol.addEventListener("input", async () => {
      playerVolume01 = Math.max(0, Math.min(1, Number(vol.value) / 100));
      if (playerVolume01 > 0) lastNonZeroVolume01 = playerVolume01;
      localStorage.setItem(VOLUME_KEY, String(playerVolume01));
      if (volVal) volVal.textContent = `${Math.round(playerVolume01 * 100)}%`;
      setSliderFill();
      setMuteIcon();
      await applyVolume();
    });

    // apply on boot
    applyVolume();
  }

  muteBtn?.addEventListener("click", async () => {
    if (playerVolume01 > 0) {
      lastNonZeroVolume01 = playerVolume01;
      playerVolume01 = 0;
    } else {
      playerVolume01 = Math.max(0.05, lastNonZeroVolume01 || 1);
    }
    localStorage.setItem(VOLUME_KEY, String(playerVolume01));
    if (vol) vol.value = String(Math.round(playerVolume01 * 100));
    if (volVal) volVal.textContent = `${Math.round(playerVolume01 * 100)}%`;
    setSliderFill();
    setMuteIcon();
    await applyVolume();
  });



}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    try { renderNowPlaying(); } catch {}
    try { renderQueue(); } catch {}
    if (IS_DISCORD_ACTIVITY_CONTEXT) {
      refreshLinkedProvidersAndUi({ force: true }).catch(() => {});
    }
  }
});

// ---------- Boot ----------
(async function boot() {
  const roomCodeFromUrl = getRoomCodeFromUrl();

  try {
    await loadProviderSdkScripts();
  } catch (e) {
    console.error("[boot] SDK script load failed", e);
    if (IS_DISCORD_ACTIVITY_CONTEXT) {
      el("sessionMeta").textContent =
        `Music SDK load failed in Activity context. Check Discord URL mappings for /apple-sdk and /spotify-sdk.`;
    }
  }

  wireUi();
  discordActivity = await initDiscordActivity();
  if (discordActivity.enabled) {
    const dn = el("displayName");
    const activityName = String(discordActivity?.context?.displayName || "").trim();
    if (dn && activityName) {
      dn.value = activityName.slice(0, 32);
      dn.disabled = true;
      dn.title = "Display name is managed by Discord Activity identity.";
    }
    if (discordActivity.error) {
      el("sessionMeta").textContent = discordActivity.error;
    } else {
      el("sessionMeta").textContent = "Discord Activity mode enabled.";
      await refreshLinkedProvidersAndUi({ force: true });
      await syncLocalProvidersToDiscordLink();
    }
    renderActivityDebugLine();
  }

  connectWS();
  if (roomCodeFromUrl && el("joinCode")) {
    el("joinCode").value = roomCodeFromUrl;
  }
  renderRejoinButton();
  renderLoopToggle();
  renderShareButton();
  renderPlaybackSource();
  renderConnectPrompt();
  renderConnectButtons();
  startHostAutoAdvance();

  if (!IS_DISCORD_ACTIVITY_CONTEXT && providerLinkContext.linkToken) {
    const p = providerLinkContext.provider === "apple" ? "Apple Music" : "Spotify";
    const linked = await syncLocalProvidersViaLinkToken();
    if (linked) {
      el("sessionMeta").textContent = `${p} linked to your Discord Activity account.`;
    } else {
      el("sessionMeta").textContent = `Complete ${p} sign-in, then return to this page to finish linking.`;
    }
  }

  if (roomCodeFromUrl) {
    requestJoinSession(roomCodeFromUrl);
    if (el("autoRoomHint")) el("autoRoomHint").style.display = "none";
  }

  try {
    await setSource(musicSource); // <-- IMPORTANT
  } catch (e) {
    console.error("[boot] setSource failed", e);
    el("sessionMeta").textContent = `Load failed: ${e?.message || String(e)}`;
  }
})();
