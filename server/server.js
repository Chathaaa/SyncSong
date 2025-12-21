import http from "http";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import { SignJWT, importPKCS8 } from "jose";

const PORT = process.env.PORT || 3000;

/**
 * Apple Music developer token caching (in-memory)
 */
let cachedAppleToken = null;     // string
let cachedAppleTokenExpMs = 0;   // number (epoch ms)
let cachedAppleKeyPromise = null; // Promise<CryptoKey>

/**
 * Minimal CORS helpers (so Electron renderer / web clients can fetch the token)
 */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function json(res, status, obj) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function text(res, status, body) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

/**
 * Load Apple private key from base64 env var and import as ES256 key for jose.
 * IMPORTANT: We never log key contents.
 */
async function getAppleSigningKey() {
  if (cachedAppleKeyPromise) return cachedAppleKeyPromise;

  cachedAppleKeyPromise = (async () => {
    const b64 = process.env.APPLE_PRIVATE_KEY_P8_BASE64;
    if (!b64) throw new Error("Missing APPLE_PRIVATE_KEY_P8_BASE64");

    // The base64 you generated encodes the PEM text (BEGIN/END PRIVATE KEY)
    const pem = Buffer.from(b64, "base64").toString("utf8").trim();

    // jose expects PKCS#8 PEM for importPKCS8 (this matches Apple's .p8 format)
    return importPKCS8(pem, "ES256");
  })();

  return cachedAppleKeyPromise;
}

/**
 * Return a cached Apple Music developer token, minting a fresh one when needed.
 */
async function getAppleDevToken() {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  if (!teamId) throw new Error("Missing APPLE_TEAM_ID");
  if (!keyId) throw new Error("Missing APPLE_KEY_ID");

  const ttlDays = Number(process.env.APPLE_DEV_TOKEN_TTL_DAYS || 180) || 180;
  const skewSec = Number(process.env.APPLE_DEV_TOKEN_CACHE_SKEW_SECONDS || 300) || 300;

  const nowMs = Date.now();
  const skewMs = skewSec * 1000;

  // If cached token is still safely valid, reuse it
  if (cachedAppleToken && cachedAppleTokenExpMs - nowMs > skewMs) {
    return { token: cachedAppleToken, expMs: cachedAppleTokenExpMs };
  }

  const key = await getAppleSigningKey();

  // Apple dev tokens are JWTs signed with ES256.
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

const server = http.createServer(async (req, res) => {
  // Always allow preflight for /apple/dev-token
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/health") {
    text(res, 200, "ok");
    return;
  }

  // NEW: Apple Music developer token endpoint
  if (req.url === "/apple/dev-token" && req.method === "GET") {
    try {
      const { token, expMs } = await getAppleDevToken();
      json(res, 200, { token, exp: expMs });
    } catch (e) {
      json(res, 500, { error: e?.message || String(e) });
    }
    return;
  }

  text(res, 404, "not found");
});

const wss = new WebSocketServer({ server });

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
    members: Array.from(session.members.entries()).map(([userId, m]) => ({
      userId,
      displayName: m.displayName,
    })),
    queue: session.queue,
    nowPlaying: session.nowPlaying || null,
  };
}

wss.on("connection", (ws) => {
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

    // From here: require a session
    const sessionId = joinedSessionId || String(payload?.sessionId || "").trim().toUpperCase();
    const session = sessions.get(sessionId);
    if (!session) {
      safeSend(ws, { type: "error", message: "Not in a valid session" });
      return;
    }

    const canControl = (userId === session.hostUserId) || !!session.allowGuestControl;

    // --- Guest/host control commands: forward ONLY to host ---
    if (type === "control:next" || type === "control:prev" || type === "control:toggle" || type === "control:seek") {
      if (!canControl) {
        safeSend(ws, { type: "error", message: "Host has not enabled guest controls" });
        return;
      }

      const host = session.members.get(session.hostUserId);
      if (!host?.ws) {
        safeSend(ws, { type: "error", message: "Host not connected" });
        return;
      }

      // Forward to host only; include who requested it (optional)
      safeSend(host.ws, {
        type,
        payload: {
          ...payload,
          fromUserId: userId,
          fromName: session.members.get(userId)?.displayName || "Guest",
          sessionId,
        }
      });
      return;
    }

    if (type === "queue:add") {
      const t = payload?.track;

      // backwards compatible: allow old shape that has title/artist
      const title = String(t?.title || "").trim();
      const artist = String(t?.artist || "").trim();

      // new: prefer stable ids
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

      // For apple/spotify we really want a stable id:
      if ((source === "apple" || source === "spotify") && !sourceId) {
        safeSend(ws, { type: "error", message: "Invalid track (missing sourceId)" });
        return;
      }

      // Sanitize what you store (prevents huge payloads)
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
      if (!canControl) {
        safeSend(ws, { type: "error", message: "Only host can remove (or host must enable guest controls)" });
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
      if (!canControl) {
        safeSend(ws, { type: "error", message: "Only host can reorder (or host must enable guest controls)" });
        return;
      }

      const order = payload?.order;
      if (!Array.isArray(order) || order.length === 0) {
        safeSend(ws, { type: "error", message: "Invalid reorder payload" });
        return;
      }

      const byId = new Map(session.queue.map((q) => [q.queueId, q]));
      const next = [];

      // Build queue in requested order (ignore unknown ids)
      for (const id of order) {
        const item = byId.get(id);
        if (item) next.push(item);
      }

      // Append anything missing (safety)
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
      if (!canControl) return;
      session.nowPlaying = payload?.nowPlaying || null;
      broadcast(session, { type: "nowPlaying:updated", nowPlaying: session.nowPlaying });
      return;
    }

    if (
      type === "host:play" ||
      type === "host:pause" ||
      type === "host:resume" ||
      type === "host:next"
    ) {
      if (!canControl) {
        safeSend(ws, { type: "error", message: "Only host can control playback (or host must enable guest controls)" });
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

server.listen(PORT, () => console.log("Server listening on", PORT));
