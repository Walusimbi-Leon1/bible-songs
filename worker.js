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

// Only these genres remain in the rotation (per Leon, 2026-08-08).
const ALLOWED_CATEGORIES = new Set(["Psalms", "Song of Solomon"]);

// ── Version grouping ────────────────────────────────────────────────────────
// One catalog entry per audio file. Songs with multiple recordings (e.g.
// "Psalm 1 (1)") share a BASE title ("Psalm 1"). We group them so the app
// shows only the base title but can play a different recording each loop.
function baseTitle(title) {
  return title.replace(/\s*\(\d+\)\s*$/, "").trim();
}

function variantIndex(title, base) {
  const m = title.slice(base.length).trim().match(/^\((\d+)\)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// FNV-1a hash → stable 32-bit unsigned. Used for deterministic, sync-safe
// version selection so EVERY client hears the SAME recording at the SAME time.
function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Build groups from the flat catalog. Each group:
//   { id, title, artist, category, versions: [{id, url, title, variant}] }
// versions are sorted by variant index (0 = primary, 1 = "(1)", ...).
function buildGroups(songs) {
  const byBase = new Map();
  for (const s of songs) {
    const base = baseTitle(s.title);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(s);
  }
  const groups = [];
  for (const [base, list] of byBase) {
    const versions = list
      .map((s) => ({
        id: s.id,
        url: s.url,
        title: s.title,
        variant: variantIndex(s.title, base),
      }))
      .sort((a, b) => a.variant - b.variant);
    const primary = versions[0];
    groups.push({
      id: base,
      title: base,
      artist: list[0].artist,
      category: list[0].category,
      primaryId: primary.id,
      versions,
    });
  }
  groups.sort((a, b) => a.id.localeCompare(b.id));
  return groups;
}

// Which version of a group plays for a given loop index (deterministic).
function selectVersionIndex(group, loopIndex) {
  const n = group.versions.length;
  if (n <= 1) return 0;
  return hashStr(group.id + "\u0000" + loopIndex) % n;
}

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
    .filter((s) => s.url.startsWith("https://"))
    .filter((s) => ALLOWED_CATEGORIES.has(s.category));
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

// Grouped catalog for the queue picker: ONE entry per base title
// (e.g. "Psalm 115"), hiding duplicate copies like "Psalm 115 (1)".
// The app still handles which version plays via the sync-safe selector.
// Order: Psalms 1→150, then Song of Solomon 1→N (numeric within each book).
function groupSortKey(id) {
  const m = id.match(/^(.*?)\s+(\d+)(?:-\d+)?\s*$/);
  if (m) {
    const book = m[1].toLowerCase();
    const rank = book.includes("psalm") ? 0 : book.includes("song of solomon") ? 1 : 2;
    return [rank, parseInt(m[2], 10), id];
  }
  return [3, 0, id];
}

async function handleGroups() {
  try {
    const songs = await getCatalog();
    const groups = buildGroups(songs);
    groups.sort((a, b) => {
      const ka = groupSortKey(a.id), kb = groupSortKey(b.id);
      for (let i = 0; i < 3; i++) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      }
      return 0;
    });
    const out = groups.map((g) => ({ id: g.id, title: g.title, category: g.category }));
    return json({ groups: out, count: out.length });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

// ── Shared schedule (radio clock) ────────────────────────────────────────────
let schedCache = { at: 0, data: null };
let durationsCache = { at: 0, data: null };
let sizeCache = {}; // songId → content-length

// Queue-next-song lock (first-come, first-served per round)
let nextSongLockCache = { at: 0, data: null };
const NEXT_SONG_TTL = 15000; // ms — re-fetch lock state at most this often

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

async function getNextSongLock() {
  const now = Date.now();
  if (nextSongLockCache.data && now - nextSongLockCache.at < NEXT_SONG_TTL) return nextSongLockCache.data;
  const data = (await readJson(`${SOC_DB}/${SOC_NS}/nextSongLock.json`)) || null;
  if (data) nextSongLockCache = { at: now, data };
  return data;
}

async function getSchedule() {
  const now = Date.now();
  if (schedCache.data && now - schedCache.at < 15000) return schedCache.data;
  const data = (await readJson(`${SOC_DB}/${SOC_NS}/schedule.json`)) || null;
  if (data) schedCache = { at: now, data };
  return data;
}

function loopIndexFor(now, sched) {
  if (!sched || !sched.cycleMs) return 0;
  return Math.floor((now - sched.epoch) / sched.cycleMs);
}

async function ensureSchedule() {
  const songs = await getCatalog();
  const groups = buildGroups(songs);
  const hash = groups.map((g) => g.id).sort().join("|");
  let sched = await getSchedule();
  if (sched && sched.hash === hash && Array.isArray(sched.groupIds) && sched.groupIds.length === groups.length) {
    return sched;
  }
  // Rebuild from stored durations (no probing loop — kept light for the sandbox).
  const durations = await getDurations();
  const groupIds = groups.map((g) => g.id);
  // Deterministic seeded shuffle from the catalog hash (stable across rebuilds).
  let seed = 0;
  for (let i = 0; i < hash.length; i++) seed = (seed * 31 + hash.charCodeAt(i)) >>> 0;
  for (let i = groupIds.length - 1; i > 0; i--) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const j = ((t ^ (t >>> 14)) >>> 0) % (i + 1);
    [groupIds[i], groupIds[j]] = [groupIds[j], groupIds[i]];
  }
  const byId = {};
  groups.forEach((g) => { byId[g.id] = g; });
  const cycleMs = groupIds.reduce((a, id) => a + (durations[byId[id].primaryId] || DEFAULT_MS), 0);
  const epoch = Date.now() - (Date.now() % 60000) - 60000;
  sched = { hash, epoch, groupIds, cycleMs, count: groupIds.length, updatedAt: Date.now() };
  await fetch(`${SOC_DB}/${SOC_NS}/schedule.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sched),
  });
  schedCache = { at: Date.now(), data: sched };
  return sched;
}

function schedulePosition(sched, durations, now) {
  const groupIds = sched.groupIds;
  const elapsed = ((now - sched.epoch) % sched.cycleMs + sched.cycleMs) % sched.cycleMs;
  let acc = 0;
  for (let i = 0; i < groupIds.length; i++) {
    const id = groupIds[i];
    const d = durations[id] || DEFAULT_MS;
    if (acc + d > elapsed) {
      return { index: i, id, offsetMs: elapsed - acc, durationMs: d };
    }
    acc += d;
  }
  const id = groupIds[groupIds.length - 1];
  return { index: groupIds.length - 1, id, offsetMs: 0, durationMs: durations[id] || DEFAULT_MS };
}

async function handleSync() {
  try {
    const [sched, durations, songs] = await Promise.all([ensureSchedule(), getDurations(), getCatalog()]);
    const now = Date.now();
    const loop = loopIndexFor(now, sched);
    const groups = buildGroups(songs);
    const byId = {};
    groups.forEach((g) => { byId[g.id] = g; });
    const cur = schedulePosition(sched, durations, now);

    // Honor a queue lock: the locked song MUST be the very next song played,
    // overriding the seeded rotation. Splice the locked group into the
    // rotation right after the current song, then consume (clear) the lock
    // so it only affects the single upcoming transition.
    const lock = await getNextSongLock();
    let lockedSong = null;
    let rotationGroupIds = sched.groupIds.slice();
    if (lock && lock.songId && byId[lock.songId]) {
      const gIdx = rotationGroupIds.indexOf(lock.songId);
      if (gIdx > -1) rotationGroupIds.splice(gIdx, 1); // remove from scheduled slot
      // Insert right after the current song so it is unambiguously "next".
      const insertAt = Math.min(cur.index + 1, rotationGroupIds.length);
      rotationGroupIds.splice(insertAt, 0, lock.songId);
      lockedSong = { songId: lock.songId, selectorUid: lock.uid, selectorName: lock.name || lock.uid };
      // Consume the lock: it only governs the single upcoming transition.
      await fetch(`${SOC_DB}/${SOC_NS}/nextSongLock.json`, { method: "DELETE" });
      nextSongLockCache = { at: now, data: null };
    }

    // Resolve each group to its chosen version for this loop (sync-safe).
    const rotation = rotationGroupIds.map((id) => {
      const g = byId[id] || { id, title: id, artist: "SGSS", category: "-", versions: [{ id, url: "", title: id }] };
      const vIdx = selectVersionIndex(g, loop);
      const v = g.versions[vIdx] || g.versions[0];
      const primaryDur = durations[g.primaryId] || DEFAULT_MS;
      return {
        id: g.id,
        title: g.title,
        artist: g.artist,
        category: g.category,
        url: v.url,
        versionTitle: v.title,
        variant: v.variant,
        durationMs: primaryDur,
      };
    });
    // Recompute cur against the *adjusted* rotation (a lock may have shifted indices)
    // so the client's position math stays aligned with the injected next-song.
    const curIdxInAdjusted = rotationGroupIds.indexOf(cur.id);
    const curAdj = curIdxInAdjusted > -1 ? { index: curIdxInAdjusted, id: cur.id, offsetMs: cur.offsetMs, durationMs: cur.durationMs } : cur;
    const curGroup = byId[curAdj.id] || { id: curAdj.id, title: curAdj.id, artist: "SGSS", category: "-", primaryId: curAdj.id, versions: [{ id: curAdj.id, url: "", title: curAdj.id }] };
    const cIdx = selectVersionIndex(curGroup, loop);
    const cV = curGroup.versions[cIdx] || curGroup.versions[0];
    // Next song = the track right after current in the adjusted rotation.
    const nextIdx = (curIdxInAdjusted + 1) % rotationGroupIds.length;
    const nextSong = rotation[nextIdx];
    return json({
      epoch: sched.epoch,
      cycleMs: sched.cycleMs,
      now,
      loop,
      current: { ...curAdj, song: { id: curGroup.id, title: curGroup.title, artist: curGroup.artist, category: curGroup.category, url: cV.url, versionTitle: cV.title } },
      next: nextSong,
      lockedSong,
      rotation,
      count: rotationGroupIds.length,
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
    const groups = buildGroups(songs);
    const base = decodeURIComponent(songId);
    const group = groups.find((g) => g.id === base);
    if (!group) return json({ error: "song not found" }, 404);

    // Pick the version for the current loop — must match /api/sync (sync-safe).
    const sched = await ensureSchedule();
    const loop = loopIndexFor(Date.now(), sched);
    const vIdx = selectVersionIndex(group, loop);
    const song = group.versions[vIdx] || group.versions[0];

    const durations = await getDurations();
    const durationMs = durations[group.primaryId] || DEFAULT_MS;

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

// ── Presence (listening dashboard) + Leaderboard (cumulative hours) ─────────
const PRESENCE_URL = (id) => `${SOC_DB}/${SOC_NS}/presence/${id}.json`;
const PRESENCE_ALL = () => `${SOC_DB}/${SOC_NS}/presence.json`;
const USERS_URL = (uid) => `${SOC_DB}/${SOC_NS}/users/${uid}.json`;
const USERS_ALL = () => `${SOC_DB}/${SOC_NS}/users.json`;
const LISTEN_STEP_MAX = 60000; // max ms credited per heartbeat (clients beat every 15s)
const LB_TOP = 200;            // leaderboard rows returned

async function readUser(uid) {
  const res = await fetch(USERS_URL(uid));
  const etag = res.headers.get("etag") || "";
  const body = await res.json().catch(() => null);
  return { etag, user: body && typeof body === "object" ? body : null };
}

// Atomic-ish read-modify-write (If-Match retry) — safe across worker isolates.
// resetBeat=true → zero the accrual clock (user left); next live beat credits 0.
async function addListeningTime(uid, deltaMs, name, avatar, resetBeat) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { etag, user } = await readUser(uid);
    const now = Date.now();
    const next = {
      uid,
      name: cleanStr(name || "Guest", 40),
      avatar: cleanStr(avatar, 300),
      seconds: Math.max(0, Number(user?.seconds) || 0) + (resetBeat ? 0 : Math.max(0, deltaMs) / 1000),
      lastBeat: resetBeat ? 0 : now,
      lastSeen: now,
      firstSeen: user?.firstSeen || now,
    };
    const res = await fetch(USERS_URL(uid), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
      body: JSON.stringify(next),
    });
    if (res.ok) return next;
    if (res.status === 412) continue; // concurrent write — retry with fresh read
    return null;
  }
  return null;
}

async function handlePresence(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = String(body.sessionId || "").slice(0, 64);
    if (!sessionId) return json({ error: "missing sessionId" }, 400);
    const uid = cleanStr(body.uid, 64) || "anon";
    const name = cleanStr(body.name || "Guest", 40);
    const avatar = cleanStr(body.avatar, 300);
    const now = Date.now();

    if (body.gone) {
      await fetch(PRESENCE_URL(sessionId), { method: "DELETE" });
      // Zero the accrual clock so a later return starts fresh (no catch-up).
      await addListeningTime(uid, 0, name, avatar, true);
      return json({ ok: true });
    }

    // Credit listening time since the last beat (capped to stop abuse).
    const { user } = await readUser(uid);
    const lastBeat = Number(user?.lastBeat || 0);
    const delta = lastBeat ? Math.min(Math.max(now - lastBeat, 0), LISTEN_STEP_MAX) : 0;
    await addListeningTime(uid, delta, name, avatar);

    await fetch(PRESENCE_URL(sessionId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, avatar, ts: now, uid }),
    });
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleLeaderboard() {
  try {
    const res = await fetch(USERS_ALL());
    const raw = (await res.json().catch(() => ({}))) || {};
    const users = [];
    for (const [uid, u] of Object.entries(raw)) {
      if (!u || typeof u !== "object") continue;
      users.push({
        uid,
        name: cleanStr(u.name || "Guest", 40),
        avatar: cleanStr(u.avatar, 300),
        seconds: Math.max(0, Number(u.seconds) || 0),
        firstSeen: Number(u.firstSeen) || 0,
        lastSeen: Number(u.lastSeen) || 0,
      });
    }
    users.sort((a, b) => b.seconds - a.seconds || (a.firstSeen || 0) - (b.firstSeen || 0));
    return json({ leaderboard: users.slice(0, LB_TOP), total: users.length });
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

// Queue-next-song lock (first-come, first-served per round)
async function handleNextSongGet() {
  try {
    const lock = await getNextSongLock();
    if (!lock) return json({ locked: false });
    // Prefer the name stored on the lock when it was set; fall back to the
    // selector's live presence record, then to their uid.
    let selectorName = lock.name;
    if (!selectorName && lock.uid) {
      const presence = (await readJson(`${SOC_DB}/${SOC_NS}/presence.json`)) || {};
      for (const p of Object.values(presence)) {
        if (p && p.uid === lock.uid && p.name) { selectorName = p.name; break; }
      }
    }
    return json({ locked: true, songId: lock.songId, selectorUid: lock.uid, selectorName: selectorName || lock.uid });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

async function handleNextSongPost(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const songId = cleanStr(body.songId, 64);
    if (!songId) return json({ error: "missing songId" }, 400);
    const uid = cleanStr(body.uid, 64) || "anon";

    const now = Date.now();
    const name = cleanStr(body.name || "Guest", 40);
    const lock = await getNextSongLock();
    // If no lock exists, or the same user is trying to re-select, allow update.
    if (!lock || lock.uid === uid) {
      await fetch(`${SOC_DB}/${SOC_NS}/nextSongLock.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songId, uid, name, ts: now }),
      });
      nextSongLockCache = { at: now, data: { songId, uid, name, ts: now } };
      return json({ ok: true, locked: true });
    }
    // Lock already held by a different user.
    return json({ ok: false, locked: true, reason: "locked by another user" }, 409);
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

async function handleNextSongDelete(request) {
  try {
    await fetch(`${SOC_DB}/${SOC_NS}/nextSongLock.json`, { method: "DELETE" });
    nextSongLockCache = { at: Date.now(), data: null };
    return json({ ok: true });
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
      if (path === "/api/groups") return await handleGroups();
      if (path === "/api/sync") return await handleSync();
      if (path === "/api/presence" && request.method === "POST") return await handlePresence(request);
      if (path === "/api/listeners") return await handleListeners();
      if (path === "/api/leaderboard") return await handleLeaderboard();
      if (path === "/api/chat" && request.method === "POST") {
        const r = await handleChatPost(request);
        ctx.waitUntil(pruneChat());
        return r;
      }
      if (path === "/api/next-song" && request.method === "GET") return await handleNextSongGet();
      if (path === "/api/next-song" && request.method === "POST") {
        const r = await handleNextSongPost(request);
        ctx.waitUntil(pruneChat()); // also prune chat on next-song POST for consistency
        return r;
      }
      if (path === "/api/next-song" && request.method === "DELETE") {
        const r = await handleNextSongDelete(request);
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
