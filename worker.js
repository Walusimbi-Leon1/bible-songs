/**
 * Bible Songs — Cloudflare Worker
 *
 * Routes:
 *   /                    → player app (STATIC index.html)
 *   /app.js /style.css /discord.js /vendor/discord-sdk.mjs → static assets
 *   /api/songs           → live song catalog from Firebase (trimmed)
 *   /stream/<songId>     → audio proxy: GitHub release MP3 with Range support
 *   /api/presence        → POST heartbeat / leave (listening dashboard)
 *   /api/listeners       → GET active listeners (name/avatar + count)
 *   /api/chat            → POST message / GET messages since ts
 *   /api/exchange        → Discord OAuth code → token (confidential client)
 *   /privacy /terms      → legal pages
 *   /support             → 302 → voice-support donate page
 *
 * Design notes:
 *  - The Discord Activity sandbox CSP blocks external hosts, so ALL traffic
 *    (catalog, audio, presence, chat) goes through this worker (same-origin).
 *  - Presence + chat live in Firebase (pop-party-1, public-writable, proven
 *    by the trivia games) under the `bible/` namespace. Clients never talk
 *    to Firebase directly — the worker proxies, so the sandbox CSP is happy.
 *  - GitHub release assets redirect to release-assets.githubusercontent.com
 *    with a signed URL; we always fetch the canonical github.com URL, which
 *    re-signs automatically. Range requests pass through (206).
 */

// ── Static assets (inlined at build time) ────────────────────────────────────
const STATIC = {
  "index.html": __INDEX_HTML__,
  "style.css": __STYLE_CSS__,
  "discord.js": __DISCORD_JS__,
  "app.js": __APP_JS__,
  "vendor/discord-sdk.mjs": __VENDOR_DISCORD_SDK_MJS__,
  "privacy.html": __PRIVACY_HTML__,
  "terms.html": __TERMS_HTML__,
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
};

const SONGS_DB = "https://songs-cf1d9-default-rtdb.firebaseio.com/songs.json";
const CATALOG_TTL = 120; // seconds — re-fetch the live catalog at most this often

// Presence + chat store (public-writable RTDB, proven by the trivia games).
const SOC_DB = "https://pop-party-1-default-rtdb.firebaseio.com";
const SOC_NS = "bible"; // namespace: {NS}/presence, {NS}/chat

const PRESENCE_TTL = 45000; // ms — a heartbeat older than this = gone
const CHAT_MAX = 250;       // prune chat when it exceeds this many messages
const CHAT_KEEP = 200;

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

// ── Catalog (live from Firebase, trimmed, cached briefly) ────────────────────
let catalogCache = { at: 0, data: null };

async function getCatalog() {
  const now = Date.now();
  if (catalogCache.data && now - catalogCache.at < CATALOG_TTL * 1000) {
    return catalogCache.data;
  }
  const res = await fetch(SONGS_DB);
  if (!res.ok) throw new Error("catalog upstream " + res.status);
  const raw = await res.json();
  const songs = Object.entries(raw || {})
    .map(([id, s]) => ({
      id,
      title: s?.title || "Untitled",
      artist: s?.artist || "SGSS",
      category: s?.category || "—",
      url: s?.url || "",
    }))
    .filter((s) => s.url.startsWith("https://"));
  catalogCache = { at: now, data: songs };
  return songs;
}

async function handleCatalog() {
  try {
    const songs = await getCatalog();
    return json({ songs, count: songs.length });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

// ── Audio streaming proxy (Range passthrough) ────────────────────────────────
async function handleStream(request, env, ctx, songId) {
  try {
    const songs = await getCatalog();
    const song = songs.find((s) => s.id === decodeURIComponent(songId));
    if (!song) return json({ error: "song not found" }, 404);

    const upstream = await fetch(song.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BibleSongs/1.0)",
        Range: request.headers.get("Range") || "",
        Accept: "audio/*,*/*;q=0.8",
      },
    });
    if (!upstream.ok && upstream.status !== 206) {
      return json({ error: "stream upstream " + upstream.status }, 502);
    }

    const headers = new Headers();
    headers.set("Content-Type", "audio/mpeg");
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "public, max-age=86400");
    const cr = upstream.headers.get("Content-Range");
    const cl = upstream.headers.get("Content-Length");
    if (cr) headers.set("Content-Range", cr);
    if (cl) headers.set("Content-Length", cl);

    return new Response(upstream.body, {
      status: upstream.status === 206 ? 206 : 200,
      headers,
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

// ── Presence (listening dashboard) ───────────────────────────────────────────
const PRESENCE_URL = (id) => `${SOC_DB}/${SOC_NS}/presence/${id}.json`;
const PRESENCE_ALL = () => `${SOC_DB}/${SOC_NS}/presence.json`;

async function handlePresence(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = String(body.sessionId || "").slice(0, 64);
    if (!sessionId) return json({ error: "missing sessionId" }, 400);

    if (body.gone) {
      await fetch(PRESENCE_URL(sessionId), { method: "DELETE" });
      return json({ ok: true });
    }

    const name = String(body.name || "Guest").slice(0, 40);
    const avatar = String(body.avatar || "").slice(0, 300);
    const ts = Date.now();
    await fetch(PRESENCE_URL(sessionId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, avatar, ts }),
    });
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleListeners() {
  try {
    const res = await fetch(PRESENCE_ALL());
    const raw = (await res.json().catch(() => ({}))) || {};
    const now = Date.now();
    const active = [];
    for (const [sessionId, p] of Object.entries(raw)) {
      if (!p || typeof p !== "object") continue;
      const ts = Number(p.ts) || 0;
      if (now - ts > PRESENCE_TTL) {
        // Stale — sweep it (best-effort; caller's heartbeat re-adds if alive).
        fetch(PRESENCE_URL(sessionId), { method: "DELETE" }).catch(() => {});
        continue;
      }
      active.push({
        sessionId,
        name: String(p.name || "Guest").slice(0, 40),
        avatar: String(p.avatar || "").slice(0, 300),
      });
    }
    // Stable ordering: oldest heartbeat first.
    active.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return json({ listeners: active, count: active.length });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────
const CHAT_URL = (id) => `${SOC_DB}/${SOC_NS}/chat/${id}.json`;
const CHAT_ALL = () => `${SOC_DB}/${SOC_NS}/chat.json`;

function cleanStr(v, max) {
  return String(v || "").slice(0, max);
}

async function handleChatPost(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const id = cleanStr(body.id, 80);
    const text = cleanStr(body.text, 500).trim();
    if (!id || !text) return json({ error: "missing id or text" }, 400);

    const user = body.user && typeof body.user === "object" ? body.user : {};
    const msg = {
      id,
      text,
      ts: Date.now(),
      user: {
        uid: cleanStr(user.uid, 64),
        name: cleanStr(user.name || "Guest", 40),
        avatar: cleanStr(user.avatar, 300),
      },
    };
    if (body.replyTo && typeof body.replyTo === "object") {
      msg.replyTo = {
        id: cleanStr(body.replyTo.id, 80),
        name: cleanStr(body.replyTo.name, 40),
        text: cleanStr(body.replyTo.text, 120),
      };
    }
    if (body.mention && typeof body.mention === "object") {
      msg.mention = {
        id: cleanStr(body.mention.id, 64),
        name: cleanStr(body.mention.name, 40),
      };
    }

    // Idempotent PUT: client-generated keys mean retries never duplicate.
    await fetch(CHAT_URL(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleChatGet(request) {
  try {
    const url = new URL(request.url);
    const since = Number(url.searchParams.get("since") || 0);
    const res = await fetch(CHAT_ALL());
    const raw = (await res.json().catch(() => ({}))) || {};

    const keys = Object.keys(raw).sort(); // keys are timestamps → chronological
    if (keys.length > CHAT_MAX) {
      // Prune oldest messages beyond CHAT_KEEP.
      const excess = keys.length - CHAT_KEEP;
      await Promise.all(
        keys.slice(0, Math.min(excess, 50)).map((k) =>
          fetch(CHAT_URL(k), { method: "DELETE" }).catch(() => {}),
        ),
      );
    }

    const messages = keys
      .map((k) => ({ id: k, ...(raw[k] || {}) }))
      .filter((m) => Number(m.ts || 0) > since)
      .slice(-100);
    return json({ messages, count: messages.length });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ── Discord OAuth exchange (confidential client) ─────────────────────────────
async function handleExchange(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const { code, client_id } = body;
    if (!code) return json({ error: "missing code" }, 400);

    const clientId = client_id || env.DISCORD_CLIENT_ID;
    const secret = env.DISCORD_CLIENT_SECRET;
    if (!clientId || !secret) return json({ error: "server not configured" }, 500);

    // The SDK's authorize is a native command — Discord's client uses the
    // activity URL as redirect_uri. The client echoes it back so we match
    // EXACTLY what the OAuth request used.
    const redirectUri = body.redirect_uri || env.REDIRECT_URI || new URL(request.url).origin + "/";

    const res = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: secret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data.error || "exchange failed" }, res.status);
    return json({ access_token: data.access_token });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ── Support redirect ─────────────────────────────────────────────────────────
const SUPPORT_URL = "https://walusimbi-leon1.github.io/voice-support/";

function notFound() {
  return new Response("Not found", { status: 404 });
}

// ── Router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/exchange" && request.method === "POST") return await handleExchange(request, env);
      if (path === "/api/songs") return await handleCatalog();
      if (path === "/api/presence" && request.method === "POST") return await handlePresence(request);
      if (path === "/api/listeners") return await handleListeners();
      if (path === "/api/chat" && request.method === "POST") return await handleChatPost(request);
      if (path === "/api/chat" && request.method === "GET") return await handleChatGet(request);
      if (path.startsWith("/stream/")) {
        const songId = path.slice("/stream/".length);
        return await handleStream(request, env, ctx, songId);
      }
      if (path === "/privacy") return html(STATIC["privacy.html"]);
      if (path === "/terms") return html(STATIC["terms.html"]);
      if (path === "/support") return Response.redirect(SUPPORT_URL, 302);
      if (path === "/" || path === "") {
        return html(STATIC["index.html"]);
      }
      const assetPath = path.slice(1);
      const content = STATIC[assetPath];
      if (content !== undefined) {
        const ext = "." + (assetPath.split(".").pop() || "");
        return new Response(content, {
          headers: { "Content-Type": CONTENT_TYPES[ext] || "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      return notFound();
    } catch (err) {
      console.error("[BibleSongs] error:", err.message);
      return json({ error: "Internal error" }, 500);
    }
  },
};
