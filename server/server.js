import http from "http";
import crypto from "crypto";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
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
    try { msg = JSON.parse(raw.toString()); } catch {
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

    // From here: require a session
    const sessionId = joinedSessionId || String(payload?.sessionId || "").trim().toUpperCase();
    const session = sessions.get(sessionId);
    if (!session) {
      safeSend(ws, { type: "error", message: "Not in a valid session" });
      return;
    }

    if (type === "queue:add") {
      const track = payload?.track;
      if (!track?.title || !track?.artist) {
        safeSend(ws, { type: "error", message: "Invalid track" });
        return;
      }

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
      if (userId !== session.hostUserId) {
        safeSend(ws, { type: "error", message: "Only host can remove" });
        return;
      }
      const queueId = payload?.queueId;
      session.queue = session.queue.filter((q) => q.queueId !== queueId);
      if (session.nowPlaying?.queueId === queueId) session.nowPlaying = null;

      broadcast(session, { type: "queue:updated", queue: session.queue });
      broadcast(session, { type: "nowPlaying:updated", nowPlaying: session.nowPlaying });
      return;
    }

    if (type === "host:state") {
      if (userId !== session.hostUserId) return;
      session.nowPlaying = payload?.nowPlaying || null;
      broadcast(session, { type: "nowPlaying:updated", nowPlaying: session.nowPlaying });
      return;
    }

    if (type === "host:play" || type === "host:pause" || type === "host:resume" || type === "host:next") {
      if (userId !== session.hostUserId) {
        safeSend(ws, { type: "error", message: "Only host can control playback" });
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
