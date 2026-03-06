const ACTIVITY_MODE = "discord_activity";

function pickFirst(...vals) {
  for (const v of vals) {
    const s = String(v || "").trim();
    if (s) return s;
  }
  return "";
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
  const ctx = parseContextFromQuery();
  const enabled = ctx.mode === ACTIVITY_MODE;

  if (!enabled) {
    return { enabled: false, token: "", context: null, error: "" };
  }

  try {
    const token = await fetchActivityToken(ctx);
    return { enabled: true, token, context: ctx, error: "" };
  } catch (err) {
    return {
      enabled: true,
      token: "",
      context: ctx,
      error: `Discord Activity auth failed: ${err?.message || String(err)}`,
    };
  }
}
