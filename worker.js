/**
 * Bible Songs — Cloudflare Worker
 *
 * Routes:
 *   /                    → player app (STATIC index.html)
 *   /app.js /style.css /discord.js /vendor/discord-sdk.mjs → static assets
 *   /api/songs           → live song catalog from Firebase (trimmed)
 *   /stream/<songId>     → audio proxy: GitHub release MP3 with Range support
 *   /api/exchange        → Discord OAuth code → token (confidential client)
 *   /privacy /terms      → legal pages
 *   /support             → 302 → voice-support donate page
 *
 * Design notes:
 *  - The Discord Activity sandbox CSP blocks external hosts, so ALL audio
 *    and catalog traffic goes through this worker (same-origin).
 *  - GitHub release assets redirect to release-assets.githubusercontent.com
 *    with a signed URL; we always fetch the canonical github.com URL, which
 *    re-signs automatically. Range requests pass through (206) so the audio
 *    element streams reliably and can resume.
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

// ── Discord OAuth exchange (confidential client) ─────────────────────────────
async function handleExchange(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const { code, client_id } = body;
    if (!code) return json({ error: "missing code" }, 400);

    const clientId = client_id || env.DISCORD_CLIENT_ID;
    const secret = env.DISCORD_CLIENT_SECRET;
    if (!clientId || !secret) return json({ error: "server not configured" }, 500);

    const res = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: secret,
        grant_type: "authorization_code",
        code,
        redirect_uri: env.REDIRECT_URI || new URL(request.url).origin + "/",
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
