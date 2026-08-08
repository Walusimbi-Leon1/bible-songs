/**
 * Bible Songs — Cloudflare Worker
 *
 * Routes:
 *   /                    → player app (STATIC index.html)
 *   /app.js /style.css /discord.js /vendor/discord-sdk.mjs → static assets
 *   /api/songs           → live song catalog from Firebase (trimmed)
 *   /api/sync            → SHARED playback schedule + current song/position
 *   /stream/<songId>?start=<sec> → audio proxy (GitHub MP3, Range + seek)
 *   /api/presence        → POST heartbeat / leave (listening dashboard)
 *   /api/listeners       → GET active listeners (name/avatar + count)
 *   /api/chat            → POST message / GET history (paginated)
 *   /api/exchange        → Discord OAuth code → token (confidential client)
 *   /privacy /terms      → legal pages
 *   /support             → 302 → voice-support donate page
 *
 * SYNCHRONIZED STREAMING (radio model):
 *  A shared schedule lives in Firebase: { epoch, songIds, cycleMs }.
 *  Every client derives the SAME current song + position from the clock:
 *      elapsed = (now - epoch) % cycleMs  →  walk songIds + durations
 *  No per-client shuffles — browser and Discord hear the exact same song
 *  at the same position. Durations were probed from the MP3s (Xing/CBR)
 *  and stored in bible/durations.json.
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

// Presence + chat + schedule store (public-writable RTDB, proven by trivia games).
const SOC_DB = "https://pop-party-1-default-rtdb.firebaseio.com";
const SOC_NS = "bible";

const PRESENCE_TTL = 45000; // ms — a heartbeat older than this = gone
const CHAT_MAX = 2000;      // prune chat when it exceeds this many messages
const CHAT_KEEP = 1500;

const DEFAULT_MS = 210000;  // fallback song duration (3.5 min)

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

// ── Shared schedule (radio clock) ────────────────────────────────────────────
let schedCache = { at: 0, data: null };
let durationsCache = { at: 0, data: null };
let sizeCache = {}; // songId → content-length

async function readJson(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function getDurations() {
  const now = Date.now();
  if (durationsCache.data && now - durationsCache.at < 60000) return durationsCache.data;
  const data = (await readJson(`${SOC_DB}/${SOC_NS}/durations.json`)) || {};
  durationsCache = { at: now, data };
  return data;
}

async function getSchedule() {
  const now = Date.now();
  if (schedCache.data && now - schedCache.at < 15000) return schedCache.data;
  const data = (await readJson(`${SOC_DB}/${SOC_NS}/schedule.json`)) || null;
  if (data) schedCache = { at: now, data };
  return data;
}

async function ensureSchedule() {
  const songs = await getCatalog();
  const hash = songs.map((s) => s.id).sort().join("|");
  let sched = await getSchedule();
  if (sched && sched.hash === hash && Array.isArray(sched.songIds) && sched.songIds.length === songs.length) {
    return sched;
  }
  // Rebuild from stored durations (no probing loop — kept light for the sandbox).
  const durations = await getDurations();
  const songIds = songs.map((s) => s.id);
  // Deterministic seeded shuffle from the catalog hash (stable across rebuilds).
  let seed = 0;
  for (let i = 0; i < hash.length; i++) seed = (seed * 31 + hash.charCodeAt(i)) >>> 0;
  for (let i = songIds.length - 1; i > 0; i--) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const j = ((t ^ (t >>> 14)) >>> 0) % (i + 1);
    [songIds[i], songIds[j]] = [songIds[j], songIds[i]];
  }
  const cycleMs = songIds.reduce((a, id) => a + (durations[id] || DEFAULT_MS), 0);
  const epoch = Date.now() - (Date.now() % 60000) - 60000;
  sched = { hash, epoch, songIds, cycleMs, count: songIds.length, updatedAt: Date.now() };
  await fetch(`${SOC_DB}/${SOC_NS}/schedule.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sched),
  });
  schedCache = { at: Date.now(), data: sched };
  return sched;
}

function schedulePosition(sched, durations, now) {
  const elapsed = ((now - sched.epoch) % sched.cycleMs + sched.cycleMs) % sched.cycleMs;
  let acc = 0;
  for (let i = 0; i < sched.songIds.length; i++) {
    const id = sched.songIds[i];
    const d = durations[id] || DEFAULT_MS;
    if (acc + d > elapsed) {
      return { index: i, id, offsetMs: elapsed - acc, durationMs: d };
    }
    acc += d;
  }
  const id = sched.songIds[sched.songIds.length - 1];
  return { index: sched.songIds.length - 1, id, offsetMs: 0, durationMs: durations[id] || DEFAULT_MS };
}

async function handleSync() {
  try {
    const [sched, durations, songs] = await Promise.all([ensureSchedule(), getDurations(), getCatalog()]);
    const now = Date.now();
    const cur = schedulePosition(sched, durations, now);
    const byId = {};
    songs.forEach((s) => { byId[s.id] = { id: s.id, title: s.title, artist: s.artist, category: s.category }; });
    const rotation = sched.songIds.map((id) => ({
      ...(byId[id] || { id, title: "Untitled", artist: "SGSS", category: "—" }),
      durationMs: durations[id] || DEFAULT_MS,
    }));
    return json({
      epoch: sched.epoch,
      cycleMs: sched.cycleMs,
      now,
      current: { ...cur, song: byId[cur.id] || null },
      rotation,
      count: sched.songIds.length,
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

// ── Audio streaming proxy (Range passthrough + start-offset seek) ────────────
async function getSize(songUrl) {
  const key = songUrl;
  if (sizeCache[key]) return sizeCache[key];
  try {
    const head = await fetch(songUrl, { method: "HEAD", redirect: "follow" });
    const size = Number(head.headers.get("content-length")) || 0;
    if (size) sizeCache[key] = size;
    return size;
  } catch (e) {
    return 0;
  }
}

async function handleStream(request, env, ctx, songId, url) {
  try {
    const songs = await getCatalog();
    const song = songs.find((s) => s.id === decodeURIComponent(songId));
    if (!song) return json({ error: "song not found" }, 404);

    const durations = await getDurations();
    const durationMs = durations[song.id] || DEFAULT_MS;

    let range = request.headers.get("Range") || "";
    // Seek support: ?start=<seconds> → byte offset (duration ratio).
    const startSec = Number(url.searchParams.get("start") || 0);
    if (!range && startSec > 0) {
      const size = await getSize(song.url);
      if (size > 0) {
        const ratio = Math.min(1, Math.max(0, startSec / (durationMs / 1000)));
        const startByte = Math.round(ratio * (size - 1));
        range = `bytes=${startByte}-`;
      }
    }

    const upstream = await fetch(song.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BibleSongs/1.0)",
        Range: range,
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
        fetch(PRESENCE_URL(sessionId), { method: "DELETE" }).catch(() => {});
        continue;
      }
      active.push({
        sessionId,
        name: String(p.name || "Guest").slice(0, 40),
        avatar: String(p.avatar || "").slice(0, 300),
      });
    }
    active.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return json({ listeners: active, count: active.length });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ── Chat (history + pagination) ──────────────────────────────────────────────
const CHAT_URL = (id) => `${SOC_DB}/${SOC_NS}/chat/${id}.json`;
const CHAT_ALL = (params) => `${SOC_DB}/${SOC_NS}/chat.json${params}`;

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
    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit") || 200)));
    const before = cleanStr(url.searchParams.get("before"), 80);

    // Firebase REST: keys are `${ts}-${rand}` → lexicographic order = chronological.
    // Fetch limit+1 (or limit+2 with endAt, which is inclusive) so we can
    // detect "hasMore" reliably.
    let params;
    if (before) {
      params = `?orderBy="$key"&endAt="${before}"&limitToLast=${limit + 2}`;
    } else {
      params = `?orderBy="$key"&limitToLast=${limit + 1}`;
    }

    const res = await fetch(CHAT_ALL(params));
    const raw = (await res.json().catch(() => ({}))) || {};
    const keys = Object.keys(raw).sort();

    // Total size check for pruning (separate cheap call is not needed — we
    // prune lazily on POST by counting; here we just paginate).
    let messages = keys
      .filter((k) => !before || k < before)
      .map((k) => ({ id: k, ...(raw[k] || {}) }))
      .filter((m) => m && typeof m === "object")
      .sort((a, b) => (a.id < b.id ? -1 : 1));

    const hasMore = messages.length > limit;
    if (hasMore) messages = messages.slice(messages.length - limit);

    // Prune: keep the newest CHAT_KEEP (best-effort, throttled).
    const totalRes = await fetch(`${SOC_DB}/${SOC_NS}/chat.json?orderBy="$key"&limitToLast=1&shallow=true`).catch(() => null);
    if (totalRes && totalRes.ok) {
      const newest = await totalRes.json().catch(() => null);
      if (newest) {
        const newestKey = Object.keys(newest)[0];
        // Approximate count via a range query is costly; skip aggressive prune.
        void newestKey;
      }
    }

    return json({ messages, count: messages.length, hasMore });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function pruneChat() {
  // Keep newest CHAT_KEEP; delete older (batched).
  try {
    const res = await fetch(`${SOC_DB}/${SOC_NS}/chat.json?orderBy="$key"&limitToLast=${CHAT_MAX + 1}`);
    const raw = await res.json().catch(() => null);
    if (!raw) return;
    const keys = Object.keys(raw).sort();
    if (keys.length <= CHAT_MAX) return;
    const excess = keys.length - CHAT_KEEP;
    const toDelete = keys.slice(0, Math.min(excess, 100));
    await Promise.all(toDelete.map((k) => fetch(CHAT_URL(k), { method: "DELETE" }).catch(() => {})));
  } catch (e) { /* best-effort */ }
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
      if (path === "/api/sync") return await handleSync();
      if (path === "/api/presence" && request.method === "POST") return await handlePresence(request);
      if (path === "/api/listeners") return await handleListeners();
      if (path === "/api/chat" && request.method === "POST") {
        const r = await handleChatPost(request);
        ctx.waitUntil(pruneChat());
        return r;
      }
      if (path === "/api/chat" && request.method === "GET") return await handleChatGet(request);
      if (path.startsWith("/stream/")) {
        const songId = path.slice("/stream/".length);
        return await handleStream(request, env, ctx, songId, url);
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
