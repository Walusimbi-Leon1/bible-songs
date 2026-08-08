/**
 * Bible Songs — Discord SDK integration
 *
 * Proven pattern from English Trivia / Trivia Rumble Elite (2026-08-08):
 *  - Vendored same-origin SDK (@discord/embedded-app-sdk@2.5.0) — Discord's
 *    Activity sandbox blocks external hosts (jsDelivr/gstatic fetch failed).
 *  - authorize() handles BOTH result shapes:
 *      { access_token } → Public Client / PKCE → authenticate() directly
 *      { code }         → confidential → /api/exchange → authenticate()
 *  - The SDK's authorize is a native command: Discord's client builds the
 *    OAuth URL and uses the ACTIVITY URL as redirect_uri, so our token
 *    exchange sends location.origin + location.pathname to match.
 *  - authenticate({ access_token }) returns { user }; getUser() requires
 *    an explicit id in SDK 2.5.0 and fails with "child id is required".
 */

import { DiscordSDK } from "./vendor/discord-sdk.mjs";

// Discord Application Client ID (Bible Songs — provided by Leon 2026-08-08)
const CLIENT_ID = "1535729840827670655";

export let discordSdk = null;
export let isDiscord = false;
export let channelId = "lobby";

export const inDiscordFrame = (() => {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.has("frame_id") || params.has("instance_id");
})();

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("[discord] " + label + " timed out after " + ms + "ms")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function initDiscord() {
  if (!inDiscordFrame) {
    isDiscord = false;
    channelId = new URLSearchParams(window.location.search).get("channel_id") || "lobby";
    return { isDiscord: false, channelId, user: null };
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const clientId = params.get("client_id") || CLIENT_ID;
    discordSdk = new DiscordSDK(clientId);
    await withTimeout(discordSdk.ready(), 8000, "sdk.ready");
    isDiscord = true;
    channelId = discordSdk.channelId || "lobby";

    const user = await runAuthorize(clientId);
    return { isDiscord: true, channelId, user };
  } catch (err) {
    console.error("[Discord] init failed:", err);
    isDiscord = false;
    return { isDiscord: false, channelId: "lobby", user: null };
  }
}

async function runAuthorize(clientId) {
  if (!discordSdk) return null;

  const result = await withTimeout(
    discordSdk.commands.authorize({ client_id: clientId, scope: ["identify"] }),
    12000,
    "authorize",
  );
  if (!result) return null;

  // SDK 2.5.0: if a `code` comes back, exchange it server-side (confidential
  // flow through our worker which holds the client secret).
  let accessToken = null;
  if (result.access_token) {
    accessToken = result.access_token;
  } else if (result.code) {
    const redirectUri = window.location.origin + window.location.pathname;
    const exchange = await fetch("/api/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: result.code, client_id: clientId, redirect_uri: redirectUri }),
    });
    const data = await exchange.json().catch(() => ({}));
    accessToken = data.access_token || null;
  }
  if (!accessToken) return null;

  const auth = await withTimeout(
    discordSdk.commands.authenticate({ access_token: accessToken }),
    10000,
    "authenticate",
  );
  return auth?.user || null;
}

export function discordAvatar(user, size = 64) {
  if (!user) return "";
  if (!user.avatar) return `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`;
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=${size}`;
}
