import { DiscordSDK } from "@discord/embedded-app-sdk";

const ACTIVITY_MODE = "discord_activity";
let discordSdkSingleton = null;

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

function apiBaseForContext(ctx) {
  return shouldEnableActivityMode(ctx) ? "/api" : "";
}

async function exchangeDiscordOauthCode(code, apiBase, redirectUri) {
  const res = await fetch(`${apiBase}/discord/activity/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    const msg = String(data?.message || data?.error || `OAuth exchange failed (${res.status})`);
    throw new Error(msg);
  }
  return data;
}

async function getAccessTokenFromSdk(ctx, apiBase) {
  const clientId = pickFirst(import.meta.env.VITE_DISCORD_CLIENT_ID, ctx.discordClientId);
  if (!clientId) {
    throw new Error("Missing Discord client id (set VITE_DISCORD_CLIENT_ID).");
  }
  const redirectUri = pickFirst(
    import.meta.env.VITE_DISCORD_OAUTH_REDIRECT_URI,
    `${window.location.origin}/`
  );

  const discordSdk = new DiscordSDK(clientId);
  discordSdkSingleton = discordSdk;
  await discordSdk.ready();

  const authz = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: randomState(),
    prompt: "none",
    scope: ["identify", "guilds"],
  });

  const oauth = await exchangeDiscordOauthCode(String(authz?.code || ""), apiBase, redirectUri);
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

async function fetchActivityToken(ctx, apiBase) {
  const headers = { "Content-Type": "application/json" };
  if (ctx.discordAccessToken) {
    headers.Authorization = `Bearer ${ctx.discordAccessToken}`;
  }

  const res = await fetch(`${apiBase}/discord/activity/token`, {
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
    return { enabled: false, token: "", context: null, error: "", debug: null };
  }

  const debug = {
    stage: "init",
    sdk: false,
    oauthCode: false,
    oauthToken: false,
    activityToken: false,
    message: "",
  };

  try {
    let ctx = { ...queryCtx };
    const apiBase = apiBaseForContext(queryCtx);

    try {
      debug.stage = "sdk_auth";
      const sdkCtx = await getAccessTokenFromSdk(queryCtx, apiBase);
      debug.sdk = true;
      debug.oauthCode = true;
      debug.oauthToken = !!sdkCtx?.discordAccessToken;
      ctx = { ...ctx, ...sdkCtx };
    } catch (sdkErr) {
      debug.message = `sdk_auth_failed:${sdkErr?.message || String(sdkErr)}`;
      // Preserve compatibility for local/manual testing paths where SDK cannot initialize.
      if (!ctx.discordAccessToken) throw sdkErr;
    }

    debug.stage = "activity_token";
    const token = await fetchActivityToken(ctx, apiBase);
    debug.activityToken = !!token;
    debug.stage = "ready";
    return { enabled: true, token, context: ctx, error: "", debug };
  } catch (err) {
    debug.stage = debug.stage === "init" ? "failed" : debug.stage;
    debug.message = debug.message || String(err?.message || err);
    return {
      enabled: true,
      token: "",
      context: queryCtx,
      error: `Discord Activity auth failed: ${err?.message || String(err)}`,
      debug,
    };
  }
}

export async function openExternalLink(url) {
  const nextUrl = String(url || "").trim();
  if (!nextUrl) return false;

  try {
    if (discordSdkSingleton?.commands?.openExternalLink) {
      await discordSdkSingleton.commands.openExternalLink({ url: nextUrl });
      return true;
    }
  } catch {
    // fall through
  }

  const w = window.open(nextUrl, "_blank", "noopener,noreferrer");
  if (w) return true;
  try {
    window.location.assign(nextUrl);
    return true;
  } catch {
    return false;
  }
}
