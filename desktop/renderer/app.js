
const WS_URL = "wss://syncsong-2lxp.onrender.com";

let ws;
let userId = null;
let sessionId = null;
let hostUserId = null;

let queue = [];
let nowPlaying = null;

const el = (id) => document.getElementById(id);

function send(type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, payload }));
}

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
      renderSessionMeta();
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

function renderSessionMeta() {
  const isHost = userId && hostUserId && userId === hostUserId;
  el("sessionMeta").textContent = sessionId
    ? `Session: ${sessionId} ${isHost ? "(Host)" : ""}`
    : "No session";
}

function fmtMs(ms) {
  if (!ms && ms !== 0) return "";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// ----- iTunes left panel -----
let myTracks = [];
let myTracksFiltered = [];

async function loadItunes() {
  const ok = await window.api.itunes.available();
  if (!ok) {
    el("sessionMeta").textContent = "iTunes not found. Please install iTunes.";
    return;
  }

  const pls = await window.api.itunes.listPlaylists();
  const sel = el("itunesPlaylists");
  sel.innerHTML = "";
  pls.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });

  if (pls[0]) {
    sel.value = pls[0].name;
    await loadItunesTracks(pls[0].name);
  }
}

async function loadItunesTracks(playlistName) {
  const tracks = await window.api.itunes.listTracks(playlistName);
  myTracks = tracks.map((t) => ({
    id: cryptoRandomId(),
    source: "itunes",
    title: t.title,
    artist: t.artist,
    album: t.album,
    durationMs: t.durationMs,
    itunesPersistentId: t.persistentId
  }));
  applySearch();
}

function applySearch() {
  const q = (el("searchMine").value || "").toLowerCase().trim();
  myTracksFiltered = !q
    ? myTracks
    : myTracks.filter((t) =>
        `${t.title} ${t.artist} ${t.album || ""}`.toLowerCase().includes(q)
      );
  renderMyTracks();
}

function renderMyTracks() {
  const box = el("myTracks");
  box.innerHTML = "";
  myTracksFiltered.forEach((t) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="left">
        <div class="title">${escapeHtml(t.title)}</div>
        <div class="meta">${escapeHtml(t.artist)} • ${escapeHtml(t.album || "")} • ${fmtMs(t.durationMs)}</div>
      </div>
      <div class="actions">
        <button data-add="${t.id}">+ Add</button>
      </div>
    `;
    row.querySelector("[data-add]").addEventListener("click", () => addToQueue(t));
    box.appendChild(row);
  });
}

function addToQueue(track) {
  if (!sessionId) {
    el("sessionMeta").textContent = "Create or join a session first.";
    return;
  }
  send("queue:add", { sessionId, track });
}

// ----- right panel -----
function renderQueue() {
  const box = el("queue");
  box.innerHTML = "";

  const isHost = userId && hostUserId && userId === hostUserId;

  queue.forEach((q) => {
    const t = q.track;
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="left">
        <div class="title">${escapeHtml(t.title)}</div>
        <div class="meta">${escapeHtml(t.artist)} • added by ${escapeHtml(q.addedBy?.displayName || "someone")}</div>
      </div>
      <div class="actions">
        ${isHost ? `<button data-play="${q.queueId}">Play</button>` : ``}
        ${isHost ? `<button data-remove="${q.queueId}">Remove</button>` : ``}
      </div>
    `;

    if (isHost) {
      row.querySelector("[data-play]").addEventListener("click", () => hostPlayQueueItem(q));
      row.querySelector("[data-remove]").addEventListener("click", () => send("queue:remove", { sessionId, queueId: q.queueId }));
    }

    box.appendChild(row);
  });
}

async function hostPlayQueueItem(qItem) {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;

  const pid = qItem.track.itunesPersistentId;
  if (!pid) {
    el("sessionMeta").textContent = "This track isn't playable via iTunes (missing persistentId).";
    return;
  }

  const ok = await window.api.itunes.playByPersistentId(pid);
  if (!ok) {
    el("sessionMeta").textContent = "Could not start playback in iTunes.";
    return;
  }

  // Set nowPlaying immediately (we'll refine via polling)
  nowPlaying = {
    queueId: qItem.queueId,
    track: qItem.track,
    isPlaying: true,
    playheadMs: 0,
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  send("host:state", { sessionId, nowPlaying });
}

function renderNowPlaying() {
  const box = el("nowPlaying");
  const bar = el("npBar");

  if (!nowPlaying) {
    box.querySelector(".npTitle").textContent = "Not playing";
    box.querySelector(".npMeta").textContent = "";
    bar.style.width = "0%";
    return;
  }

  const t = nowPlaying.track;
  box.querySelector(".npTitle").textContent = `${t.title}`;
  const playhead = computeExpectedPlayhead(nowPlaying);
  box.querySelector(".npMeta").textContent =
    `${t.artist} • ${fmtMs(playhead)} / ${fmtMs(t.durationMs)} ${nowPlaying.isPlaying ? "• Playing" : "• Paused"}`;

  const pct = t.durationMs ? Math.max(0, Math.min(1, playhead / t.durationMs)) : 0;
  bar.style.width = `${pct * 100}%`;
}

function computeExpectedPlayhead(np) {
  if (!np) return 0;
  if (!np.isPlaying) return np.playheadMs || 0;
  const startedAt = np.startedAt || Date.now();
  const raw = Date.now() - startedAt;
  return Math.max(0, raw);
}

// Host: poll iTunes and publish host state (v2-ready)
async function startHostPolling() {
  setInterval(async () => {
    const isHost = userId && hostUserId && userId === hostUserId;
    if (!isHost || !sessionId) return;

    const np = await window.api.itunes.nowPlaying();
    if (!np?.persistentId) return;

    // Find matching queue item (best effort)
    const current = queue.find(q => q.track?.itunesPersistentId === np.persistentId) || null;

    const isPlaying = np.playerState === 1; // typical value for playing
    const playheadMs = np.playerPositionMs || 0;

    const track = current?.track || {
      id: "unknown",
      source: "itunes",
      title: np.title || "Unknown",
      artist: np.artist || "Unknown",
      album: np.album || "",
      durationMs: np.durationMs || 0,
      itunesPersistentId: np.persistentId
    };

    const queueId = current?.queueId || null;

    const startedAt = isPlaying ? (Date.now() - playheadMs) : (nowPlaying?.startedAt || Date.now() - playheadMs);

    const nextNowPlaying = {
      queueId,
      track,
      isPlaying,
      playheadMs,
      startedAt,
      updatedAt: Date.now()
    };

    // Avoid spamming if nothing changed materially (simple)
    nowPlaying = nextNowPlaying;
    send("host:state", { sessionId, nowPlaying });
    renderNowPlaying();
  }, 1000);
}

// Host control buttons
el("hostPlay").addEventListener("click", async () => {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;
  await window.api.itunes.play();
});
el("hostPause").addEventListener("click", async () => {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;
  await window.api.itunes.pause();
});
el("hostNext").addEventListener("click", async () => {
  const isHost = userId && hostUserId && userId === hostUserId;
  if (!isHost) return;
  await window.api.itunes.next();
});

// Session buttons
el("createSession").addEventListener("click", () => {
  const displayName = (el("displayName").value || "Host").trim().slice(0, 32);
  send("session:create", { displayName });
});
el("joinSession").addEventListener("click", () => {
  const displayName = (el("displayName").value || "Guest").trim().slice(0, 32);
  const code = (el("joinCode").value || "").trim().toUpperCase();
  if (!code) return;
  send("session:join", { sessionId: code, displayName });
});

// UI event wiring
el("reloadItunes").addEventListener("click", loadItunes);
el("itunesPlaylists").addEventListener("change", async (e) => {
  await loadItunesTracks(e.target.value);
});
el("searchMine").addEventListener("input", applySearch);

// Helpers
function cryptoRandomId() {
  // simple, good enough for UI ids
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

// Start everything
connectWS();
loadItunes();
startHostPolling();

// Smooth progress bar updates for non-hosts too
setInterval(renderNowPlaying, 500);
