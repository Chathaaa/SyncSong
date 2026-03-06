import { DiscordSDK } from "@discord/embedded-app-sdk";

const ACTIVITY_MODE = "discord_activity";

function pickFirst(...vals) {
  for (const v of vals) {
    const s = String(v || "").trim();
    if (s) return s;
  }
  return "";
}

function randomState() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseContextFromQuery() {
  const u = new URL(window.location.href);
  const q = u.searchParams;
  return {
    mode: pickFirst(q.get("mode")),
    discordUserId: pickFirst(q.get("discordUserId"), q.get("discord_user_id"), q.get("user_id")),
    displayName: pickFirst(q.get("displayName"), q.get("discordDisplayName"), q.get("discord_display_name")),
    guildId: pickFirst(q.get("guildId"), q.get("guild_id")),
    channelId: pickFirst(q.get("channelId"), q.get("channel_id")),
    activityInstanceId: pickFirst(q.get("activityInstanceId"), q.get("activity_instance_id"), q.get("instance_id")),
    discordAccessToken: pickFirst(q.get("discordAccessToken"), q.get("discord_access_token")),
    discordClientId: pickFirst(q.get("discordClientId"), q.get("discord_client_id"), q.get("client_id")),
    frameId: pickFirst(q.get("frame_id")),
    platform: pickFirst(q.get("platform")),
  };
}

function shouldEnableActivityMode(ctx) {
  if (ctx.mode === ACTIVITY_MODE) return true;
  return !!(ctx.frameId && ctx.platform);
}

async function exchangeDiscordOauthCode(code) {
  const res = await fetch("/discord/activity/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    const msg = String(data?.message || data?.error || `OAuth exchange failed (${res.status})`);
    throw new Error(msg);
  }
  return data;
}

async function getAccessTokenFromSdk(ctx) {
  const clientId = pickFirst(import.meta.env.VITE_DISCORD_CLIENT_ID, ctx.discordClientId);
  if (!clientId) {
    throw new Error("Missing Discord client id (set VITE_DISCORD_CLIENT_ID).");
  }

  const discordSdk = new DiscordSDK(clientId);
  await discordSdk.ready();

  const authz = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: randomState(),
    prompt: "none",
    scope: ["identify", "guilds"],
  });

  const oauth = await exchangeDiscordOauthCode(String(authz?.code || ""));
  const accessToken = String(oauth.access_token || "").trim();
  if (!accessToken) throw new Error("Discord OAuth returned no access token.");

  const auth = await discordSdk.commands.authenticate({ access_token: accessToken });
  const user = auth?.user || {};

  return {
    discordAccessToken: accessToken,
    discordUserId: pickFirst(user.id, ctx.discordUserId),
    displayName: pickFirst(user.global_name, user.username, ctx.displayName),
    guildId: pickFirst(discordSdk.guildId, ctx.guildId),
    channelId: pickFirst(discordSdk.channelId, ctx.channelId),
    activityInstanceId: pickFirst(discordSdk.instanceId, ctx.activityInstanceId),
  };
}

async function fetchActivityToken(ctx) {
  const headers = { "Content-Type": "application/json" };
  if (ctx.discordAccessToken) {
    headers.Authorization = `Bearer ${ctx.discordAccessToken}`;
  }

  const res = await fetch("/discord/activity/token", {
    method: "POST",
    headers,
    body: JSON.stringify({
      discordUserId: ctx.discordUserId,
      displayName: ctx.displayName,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      activityInstanceId: ctx.activityInstanceId,
      // Dev fallback only; server ignores this when Authorization bearer token is present.
      discordAccessToken: ctx.discordAccessToken,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.token) {
    const msg = String(data?.message || data?.error || `Token request failed (${res.status})`);
    throw new Error(msg);
  }
  return data.token;
}

export async function initDiscordActivity() {
  const queryCtx = parseContextFromQuery();
  const enabled = shouldEnableActivityMode(queryCtx);
  if (!enabled) {
    return { enabled: false, token: "", context: null, error: "" };
  }

  try {
    let ctx = { ...queryCtx };

    try {
      const sdkCtx = await getAccessTokenFromSdk(queryCtx);
      ctx = { ...ctx, ...sdkCtx };
    } catch (sdkErr) {
      // Preserve compatibility for local/manual testing paths where SDK cannot initialize.
      if (!ctx.discordAccessToken) throw sdkErr;
    }

    const token = await fetchActivityToken(ctx);
    return { enabled: true, token, context: ctx, error: "" };
  } catch (err) {
    return {
      enabled: true,
      token: "",
      context: queryCtx,
      error: `Discord Activity auth failed: ${err?.message || String(err)}`,
    };
  }
}
