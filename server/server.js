// server.js (ESM) — Combined WatchParty + SyncSong on one Render service

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { URL } from "node:url";
import { WebSocketServer } from "ws";
import { SignJWT, importPKCS8 } from "jose";

const PORT = process.env.PORT || 3000;

/* =========================================================
   CORS (merged)
   - Supports WatchParty's allowlist behavior (CORS_ORIGINS)
   - Also allows headers needed for /apple/dev-token
   ========================================================= */

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function setCors(req, res) {
  const reqOrigin = req?.headers?.origin || "null";
  const allowAny = ALLOWED_ORIGINS.includes("*");
  const isAllowed =
    allowAny ||
    ALLOWED_ORIGINS.includes(reqOrigin) ||
    (reqOrigin === "null" && ALLOWED_ORIGINS.includes("null"));

  res.setHeader(
    "Access-Control-Allow-Origin",
    allowAny ? "*" : isAllowed ? reqOrigin : (ALLOWED_ORIGINS[0] || "*")
  );
  res.setHeader("Vary", "Origin");

  // union of both servers
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization"
  );
}

function json(req, res, status, obj) {
  setCors(req, res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function text(req, res, status, body) {
  setCors(req, res);
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

/* =========================================================
   WatchParty state + helpers
   ========================================================= */

const rooms = new Map(); // roomId -> { clients:Set<ws>, messages:[], userColors:Map<username,color>, lastActive:number }
const HISTORY_LIMIT = 100;
const COLORS = [
  "#FF5733", "#33FF57", "#3357FF", "#FF33A8", "#FFC733",
  "#33FFF2", "#A833FF", "#FF3333", "#33FF8D", "#FF8D33"
];

const feedback = []; // { message, at }
const FEEDBACK_LIMIT = 500;
const ipRateLimits = new Map(); // key -> { count, resetAt }
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

const TRUSTED_FEEDBACK_HOSTS = [
  "chathaaa.github.io",
  "localhost",
  "127.0.0.1",
];

const CHAT_RATE_WINDOW_MS = 10 * 1000;
const CHAT_RATE_LIMIT = 8;

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      messages: [],
      userColors: new Map(),
      lastActive: Date.now(),
    });
  }
  return rooms.get(roomId);
}

function pruneEmptyRooms(now = Date.now()) {
  for (const [rid, r] of rooms.entries()) {
    if (r.clients.size === 0 && now - r.lastActive > ROOM_TTL_MS) rooms.delete(rid);
  }
}

function colorFor(room, username) {
  if (!room.userColors.has(username)) {
    const c = COLORS[Math.floor(Math.random() * COLORS.length)];
    room.userColors.set(username, c);
  }
  return room.userColors.get(username);
}

function sendFeedbackToDiscord(message) {
  const webhookUrl = process.env.DISCORD_FEEDBACK_WEBHOOK;
  if (!webhookUrl) return;

  try {
    const url = new URL(webhookUrl);
    const payload = JSON.stringify({
      content: `💬 New site request:\n> ${message}`,
    });

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(url, options, (res) => {
      res.on("data", () => {});
    });

    req.on("error", (err) => {
      console.error("[DISCORD] error sending feedback:", err);
    });

    req.write(payload);
    req.end();
  } catch (err) {
    console.error("[DISCORD] invalid webhook URL:", err);
  }
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function getOriginHostname(origin) {
  if (!origin || origin === "null") return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isChromeExtensionOrigin(origin) {
  return typeof origin === "string" && origin.startsWith("chrome-extension://");
}

function isTrustedFeedbackOrigin(origin) {
  if (!origin || origin === "null") return true;
  if (isChromeExtensionOrigin(origin)) return true;

  const hostname = getOriginHostname(origin);
  return !!hostname && TRUSTED_FEEDBACK_HOSTS.includes(hostname);
}

function isRateLimited(key, limit, windowMs, now = Date.now()) {
  const entry = ipRateLimits.get(key);
  if (!entry || now >= entry.resetAt) {
    ipRateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  if (entry.count >= limit) return true;

  entry.count += 1;
  return false;
}

/* =========================================================
   SyncSong Apple developer token (unchanged logic)
   ========================================================= */

let cachedAppleToken = null;      // string
let cachedAppleTokenExpMs = 0;    // epoch ms
let cachedAppleKeyPromise = null; // Promise<CryptoKey>

async function getAppleSigningKey() {
  if (cachedAppleKeyPromise) return cachedAppleKeyPromise;

  cachedAppleKeyPromise = (async () => {
    const b64 = process.env.APPLE_PRIVATE_KEY_P8_BASE64;
    if (!b64) throw new Error("Missing APPLE_PRIVATE_KEY_P8_BASE64");

    const pem = Buffer.from(b64, "base64").toString("utf8").trim();
    return importPKCS8(pem, "ES256");
  })();

  return cachedAppleKeyPromise;
}

async function getAppleDevToken() {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  if (!teamId) throw new Error("Missing APPLE_TEAM_ID");
  if (!keyId) throw new Error("Missing APPLE_KEY_ID");

  const ttlDays = Number(process.env.APPLE_DEV_TOKEN_TTL_DAYS || 180) || 180;
  const skewSec = Number(process.env.APPLE_DEV_TOKEN_CACHE_SKEW_SECONDS || 300) || 300;

  const nowMs = Date.now();
  const skewMs = skewSec * 1000;

  if (cachedAppleToken && cachedAppleTokenExpMs - nowMs > skewMs) {
    return { token: cachedAppleToken, expMs: cachedAppleTokenExpMs };
  }

  const key = await getAppleSigningKey();

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlDays * 24 * 60 * 60;

  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);

  cachedAppleToken = jwt;
  cachedAppleTokenExpMs = exp * 1000;

  return { token: cachedAppleToken, expMs: cachedAppleTokenExpMs };
}

/* =========================================================
   SyncSong realtime sessions (WS) (mostly unchanged)
   ========================================================= */

const sessions = new Map(); // sessionId -> session

const uid = () => crypto.randomBytes(8).toString("hex");
const makeSessionId = () => crypto.randomBytes(3).toString("hex").toUpperCase();

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(session, obj) {
  for (const m of session.members.values()) safeSend(m.ws, obj);
}
function state(sessionId, session) {
  return {
    type: "session:state",
    sessionId,
    hostUserId: session.hostUserId,
    allowGuestControl: !!session.allowGuestControl,
    partyMode: !!session.partyMode,
    members: Array.from(session.members.entries()).map(([userId, m]) => ({
      userId,
      displayName: m.displayName,
    })),
    queue: session.queue,
    nowPlaying: session.nowPlaying || null,
  };
}

/* =========================================================
   HTTP server (merged routes)
   ========================================================= */

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Shared health
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/health"))) {
    text(req, res, 200, "ok\n");
    return;
  }

  // SyncSong: Apple Music dev token endpoint
  if (req.method === "GET" && req.url === "/apple/dev-token") {
    try {
      const { token, expMs } = await getAppleDevToken();
      json(req, res, 200, { token, exp: expMs });
    } catch (e) {
      json(req, res, 500, { error: e?.message || String(e) });
    }
    return;
  }

  // WatchParty: list active rooms
  if (req.method === "GET" && req.url.startsWith("/games")) {
    const now = Date.now();
    pruneEmptyRooms(now);

    const games = [];
    for (const [rid, r] of rooms.entries()) {
      if (r.clients.size > 0) {
        games.push({ roomId: rid, clients: r.clients.size, lastActive: r.lastActive });
      }
    }
    games.sort((a, b) => (b.clients - a.clients) || (b.lastActive - a.lastActive));

    json(req, res, 200, { ok: true, games });
    return;
  }

  // WatchParty: feedback endpoint
  if (req.method === "POST" && req.url.startsWith("/feedback")) {
    if (!isTrustedFeedbackOrigin(req.headers.origin)) {
      json(req, res, 403, { ok: false, error: "forbidden_origin" });
      return;
    }

    const ip = getClientIp(req);
    if (isRateLimited(`feedback:${ip}`, 5, 5 * 60 * 1000)) {
      json(req, res, 429, { ok: false, error: "rate_limited" });
      return;
    }

    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        body = "";
        json(req, res, 413, { ok: false, error: "payload_too_large" });
        req.socket.destroy();
      }
    });

    req.on("end", () => {
      let msg = "";
      try {
        const parsed = JSON.parse(body || "{}");
        msg = (parsed.message || "").toString().trim();
      } catch {
        json(req, res, 400, { ok: false, error: "invalid_json" });
        return;
      }

      if (!msg) {
        json(req, res, 400, { ok: false, error: "empty_message" });
        return;
      }

      const entry = { message: msg.slice(0, 1000), at: Date.now() };
      feedback.push(entry);
      if (feedback.length > FEEDBACK_LIMIT) feedback.shift();

      console.log("[FEEDBACK]", entry);
      sendFeedbackToDiscord(entry.message);

      json(req, res, 200, { ok: true });
    });

    return;
  }

  // WatchParty: dashboard
  if (req.method === "GET" && req.url.startsWith("/dashboard")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>WatchParty Live Rooms</title>
  <style>
    body { font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#0f172a; color:#e5e7eb; margin:0; padding:16px; }
    h1 { margin-top:0; font-size:1.4rem; }
    .updated { font-size:0.85rem; color:#9ca3af; margin-bottom:12px; }
    table { width:100%; border-collapse:collapse; margin-top:8px; font-size:0.9rem; }
    th, td { padding:8px 10px; border-bottom:1px solid rgba(55,65,81,0.7); text-align:left; }
    th { background: rgba(15, 23, 42, 0.9); position: sticky; top: 0; }
    tr:nth-child(even) td { background: rgba(15, 23, 42, 0.5); }
    code { font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace; }
    .empty { margin-top:16px; color:#9ca3af; }
  </style>
</head>
<body>
  <h1>WatchParty – Live Rooms</h1>
  <div class="updated" id="updated">Loading…</div>
  <table id="rooms-table" style="display:none;">
    <thead>
      <tr><th>Room ID</th><th>Clients</th><th>Last Active</th></tr>
    </thead>
    <tbody id="rooms-body"></tbody>
  </table>
  <div id="empty" class="empty" style="display:none;">No active rooms right now.</div>

  <script>
    async function loadRooms() {
      const updatedEl = document.getElementById("updated");
      const table = document.getElementById("rooms-table");
      const tbody = document.getElementById("rooms-body");
      const emptyEl = document.getElementById("empty");

      try {
        const res = await fetch("/games");
        const data = await res.json();
        const games = data.games || [];

        const now = new Date();
        updatedEl.textContent = "Last updated: " + now.toLocaleTimeString();
        tbody.innerHTML = "";

        if (!games.length) {
          table.style.display = "none";
          emptyEl.style.display = "block";
          return;
        }

        emptyEl.style.display = "none";
        table.style.display = "table";

        games.forEach(g => {
          const tr = document.createElement("tr");

          const tdRoom = document.createElement("td");
          const code = document.createElement("code");
          code.textContent = g.roomId;
          tdRoom.appendChild(code);

          const tdClients = document.createElement("td");
          tdClients.textContent = g.clients;

          const tdLast = document.createElement("td");
          tdLast.textContent = g.lastActive ? new Date(g.lastActive).toLocaleString() : "";

          tr.appendChild(tdRoom);
          tr.appendChild(tdClients);
          tr.appendChild(tdLast);
          tbody.appendChild(tr);
        });
      } catch (err) {
        console.error("Error loading rooms:", err);
        updatedEl.textContent = "Error loading rooms (see console).";
        table.style.display = "none";
        emptyEl.style.display = "block";
        emptyEl.textContent = "Error loading rooms.";
      }
    }

    loadRooms();
    setInterval(loadRooms, 5000);
  </script>
</body>
</html>`);
    return;
  }

  // Fallback
  text(req, res, 404, "not found\n");
});

/* =========================================================
   WebSockets (two servers, one upgrade router)
   - WatchParty: only /chat/<roomId>
   - SyncSong: everything else (keeps existing WS_URL working)
   ========================================================= */

const wssWatchParty = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const wssSyncSong = new WebSocketServer({ noServer: true, perMessageDeflate: false });

// --- Heartbeats (good on Render) ---
function heartbeat() { this.isAlive = true; }

function addHeartbeat(wss, label) {
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", heartbeat);
  });

  wss.on("close", () => clearInterval(pingInterval));
}

addHeartbeat(wssWatchParty, "watchparty");
addHeartbeat(wssSyncSong, "syncsong");

// --- Upgrade router ---
server.on("upgrade", (req, socket, head) => {
  try {
    const upgrade = req.headers.upgrade && String(req.headers.upgrade).toLowerCase();
    if (upgrade !== "websocket") {
      socket.destroy();
      return;
    }

    // Parse path
    const u = new URL(req.url, "http://localhost");
    const path = u.pathname || "/";

    // Route /chat/* to WatchParty; everything else -> SyncSong
    const isWatchPartyChat = path.startsWith("/chat/") && path.length > "/chat/".length;

    const target = isWatchPartyChat ? wssWatchParty : wssSyncSong;

    target.handleUpgrade(req, socket, head, (ws) => {
      target.emit("connection", ws, req);
    });
  } catch {
    try { socket.destroy(); } catch {}
  }
});

/* =========================================================
   WatchParty WS behavior (/chat/<roomId>)
   ========================================================= */

wssWatchParty.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost");
  const roomId = decodeURIComponent(u.pathname.slice("/chat/".length));

  const room = getRoom(roomId);
  room.clients.add(ws);
  room.lastActive = Date.now();
  ws._roomId = roomId;
  ws._chatRate = { count: 0, resetAt: Date.now() + CHAT_RATE_WINDOW_MS };

  console.log(`[WP CONNECT] room="${roomId}" clients=${room.clients.size}`);

  ws.send(JSON.stringify({ type: "history", messages: room.messages }));

  ws.on("message", (data) => {
    const now = Date.now();
    if (!ws._chatRate || now >= ws._chatRate.resetAt) {
      ws._chatRate = { count: 0, resetAt: now + CHAT_RATE_WINDOW_MS };
    }
    ws._chatRate.count += 1;
    if (ws._chatRate.count > CHAT_RATE_LIMIT) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: "error",
          message: "You are sending messages too quickly.",
        }));
      }
      return;
    }

    let incoming;
    try { incoming = JSON.parse(data); }
    catch {
      console.error("[WP ERROR] Invalid JSON:", data?.toString?.().slice(0, 200));
      return;
    }

    if (!incoming || typeof incoming.text !== "string" || !incoming.user) {
      console.error("[WP ERROR] Missing fields:", incoming);
      return;
    }

    const msg = {
      type: "chat",
      user: String(incoming.user).slice(0, 40),
      text: String(incoming.text).slice(0, 2000),
      timestamp: incoming.timestamp || Date.now(),
      color: colorFor(room, incoming.user),
      roomId,
    };

    room.messages.push(msg);
    if (room.messages.length > HISTORY_LIMIT) room.messages.shift();
    room.lastActive = Date.now();

    room.clients.forEach((client) => {
      if (client.readyState === 1) client.send(JSON.stringify(msg));
    });
  });

  ws.on("close", () => {
    const rid = ws._roomId;
    const r = rooms.get(rid);
    if (r) {
      r.clients.delete(ws);
      r.lastActive = Date.now();
      console.log(`[WP DISCONNECT] room="${rid}" clients=${r.clients.size}`);
    }
  });
});

setInterval(() => {
  pruneEmptyRooms();
}, 60 * 60 * 1000);

/* =========================================================
   SyncSong WS behavior (default route)
   ========================================================= */

wssSyncSong.on("connection", (ws) => {
  const userId = uid();
  let joinedSessionId = null;

  safeSend(ws, { type: "hello", userId });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      safeSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    const { type, payload } = msg || {};
    if (!type) return;

    if (type === "session:create") {
      const sessionId = makeSessionId();
      const displayName = String(payload?.displayName || "Host").slice(0, 32);

      const session = {
        hostUserId: userId,
        allowGuestControl: false,
        partyMode: false,
        members: new Map(),
        queue: [],
        nowPlaying: null,
      };

      session.members.set(userId, { displayName, ws });
      sessions.set(sessionId, session);
      joinedSessionId = sessionId;

      safeSend(ws, { type: "session:created", sessionId });
      broadcast(session, state(sessionId, session));
      return;
    }

    if (type === "session:join") {
      const sessionId = String(payload?.sessionId || "").trim().toUpperCase();
      const displayName = String(payload?.displayName || "Guest").slice(0, 32);

      const session = sessions.get(sessionId);
      if (!session) {
        safeSend(ws, { type: "error", message: "Session not found" });
        return;
      }

      session.members.set(userId, { displayName, ws });
      joinedSessionId = sessionId;

      broadcast(session, state(sessionId, session));
      return;
    }

    if (type === "session:setGuestControl") {
      const sessionId = joinedSessionId || String(payload?.sessionId || "").trim().toUpperCase();
      const session = sessions.get(sessionId);
      if (!session) {
        safeSend(ws, { type: "error", message: "Not in a valid session" });
        return;
      }
      if (userId !== session.hostUserId) {
        safeSend(ws, { type: "error", message: "Only host can change permissions" });
        return;
      }
      session.allowGuestControl = !!payload?.allowGuestControl;
      broadcast(session, state(sessionId, session));
      return;
    }

    if (type === "session:setPartyMode") {
      const sessionId = joinedSessionId || String(payload?.sessionId || "").trim().toUpperCase();
      const session = sessions.get(sessionId);
      if (!session) {
        safeSend(ws, { type: "error", message: "Not in a valid session" });
        return;
      }
      if (userId !== session.hostUserId) {
        safeSend(ws, { type: "error", message: "Only host can change party mode" });
        return;
      }

      session.partyMode = !!payload?.partyMode;
      broadcast(session, state(sessionId, session));
      return;
    }

    // From here: require a session
    const sessionId = joinedSessionId || String(payload?.sessionId || "").trim().toUpperCase();
    const session = sessions.get(sessionId);
    if (!session) {
      safeSend(ws, { type: "error", message: "Not in a valid session" });
      return;
    }

    const canControl = (userId === session.hostUserId) || !!session.allowGuestControl;
    const isHost = userId === session.hostUserId;

    if (
      type === "control:next" ||
      type === "control:prev" ||
      type === "control:toggle" ||
      type === "control:seek" ||
      type === "control:queue-play" ||
      type === "control:queue-remove" ||
      type === "control:queue-reorder"
    ) {
      if (!canControl) {
        safeSend(ws, { type: "error", message: "Host has not enabled guest controls" });
        return;
      }

      const host = session.members.get(session.hostUserId);
      if (!host?.ws) {
        safeSend(ws, { type: "error", message: "Host not connected" });
        return;
      }

      safeSend(host.ws, {
        type,
        payload: {
          ...payload,
          fromUserId: userId,
          fromName: session.members.get(userId)?.displayName || "Guest",
          sessionId,
        },
      });
      return;
    }

    if (type === "queue:add") {
      const t = payload?.track;
      const title = String(t?.title || "").trim();
      const artist = String(t?.artist || "").trim();

      const source = String(t?.source || "").trim(); // apple/spotify/itunes
      const sourceId = String(
        t?.sourceId ||
          t?.spotifyTrackId ||
          t?.itunesPersistentId ||
          t?.itunesTrackId ||
          ""
      ).trim();

      if (!title || !artist) {
        safeSend(ws, { type: "error", message: "Invalid track (missing title/artist)" });
        return;
      }
      if ((source === "apple" || source === "spotify") && !sourceId) {
        safeSend(ws, { type: "error", message: "Invalid track (missing sourceId)" });
        return;
      }

      const track = {
        source: source || "unknown",
        sourceId: sourceId || "",
        title,
        artist,
        album: t?.album ? String(t.album).slice(0, 120) : "",
        durationMs: Number(t?.durationMs || 0) || 0,
        artworkUrl: t?.artworkUrl ? String(t.artworkUrl).slice(0, 500) : "",
        url: t?.url ? String(t.url).slice(0, 500) : "",
      };

      const queueItem = {
        queueId: uid(),
        track,
        addedBy: {
          userId,
          displayName: session.members.get(userId)?.displayName || "Someone",
        },
        addedAt: Date.now(),
      };

      session.queue.push(queueItem);
      broadcast(session, { type: "queue:updated", queue: session.queue });
      return;
    }

    if (type === "queue:remove") {
      if (!isHost) {
        safeSend(ws, { type: "error", message: "Only host can remove directly" });
        return;
      }
      const queueId = payload?.queueId;
      session.queue = session.queue.filter((q) => q.queueId !== queueId);
      if (session.nowPlaying?.queueId === queueId) session.nowPlaying = null;

      broadcast(session, { type: "queue:updated", queue: session.queue });
      broadcast(session, { type: "nowPlaying:updated", nowPlaying: session.nowPlaying });
      return;
    }

    if (type === "queue:reorder") {
      if (!isHost) {
        safeSend(ws, { type: "error", message: "Only host can reorder directly" });
        return;
      }

      const order = payload?.order;
      if (!Array.isArray(order) || order.length === 0) {
        safeSend(ws, { type: "error", message: "Invalid reorder payload" });
        return;
      }

      const byId = new Map(session.queue.map((q) => [q.queueId, q]));
      const next = [];
      for (const id of order) {
        const item = byId.get(id);
        if (item) next.push(item);
      }
      if (next.length !== session.queue.length) {
        const seen = new Set(order);
        for (const q of session.queue) {
          if (!seen.has(q.queueId)) next.push(q);
        }
      }

      session.queue = next;
      broadcast(session, { type: "queue:updated", queue: session.queue });
      return;
    }

    if (type === "host:state") {
      if (!isHost) {
        safeSend(ws, { type: "error", message: "Only host can publish playback state" });
        return;
      }
      session.nowPlaying = payload?.nowPlaying || null;
      broadcast(session, { type: "nowPlaying:updated", nowPlaying: session.nowPlaying });
      return;
    }

    if (type === "host:play" || type === "host:pause" || type === "host:resume" || type === "host:next") {
      if (!isHost) {
        safeSend(ws, { type: "error", message: "Only host can broadcast playback commands" });
        return;
      }
      broadcast(session, { type, payload });
      return;
    }
  });

  ws.on("close", () => {
    if (!joinedSessionId) return;
    const session = sessions.get(joinedSessionId);
    if (!session) return;

    session.members.delete(userId);

    if (session.hostUserId === userId) {
      broadcast(session, { type: "error", message: "Host disconnected. Session ended." });
      sessions.delete(joinedSessionId);
      return;
    }

    if (session.members.size === 0) sessions.delete(joinedSessionId);
    else broadcast(session, state(joinedSessionId, session));
  });
});

/* =========================================================
   Start
   ========================================================= */

server.listen(PORT, () => {
  console.log(`Combined HTTP+WS server listening on :${PORT}`);
});
