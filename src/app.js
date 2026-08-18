/**
 * Bible Songs — synchronized 24/7 streaming player
 *
 * SYNCHRONIZATION (radio model):
 *  Every client derives the SAME current song + position from the shared
 *  schedule clock (Firebase epoch + per-song durations):
 *      elapsed = (now - epoch) % cycleMs  →  walk songIds + durations
 *  The audio element plays /stream/<id>?start=<offsetSec>, so browsers and
 *  Discord hear the exact same part of the same song at the same time.
 *  A 2s tick re-derives the position and corrects drift (seek) or advances
 *  at song boundaries.
 *
 * Other features:
 *  - Listening dashboard (presence heartbeats → /api/listeners)
 *  - Chat with history (scroll back via pagination), replies, @mentions
 *  - Auto-start 3-2-1 countdown (no start button)
 *  - Volume + mute only (no pause/skip) — keyboard shortcuts ↑/↓/M
 */

import { initDiscord, isDiscord, inDiscordFrame, discordAvatar } from "./discord.js";

const $ = (id) => document.getElementById(id);

// ── State ────────────────────────────────────────────────────────────────────
let sched = null;        // { epoch, cycleMs, songIds, byId }
let cur = null;          // { index, id, offsetMs, durationMs }
let audioSongId = null;  // what's loaded in the <audio> element
let lastSwitchAt = 0;    // avoid seek-correction during buffering grace
let playing = false;
let muted = false;
let lastVol = Number(localStorage.getItem("bible-vol") || 70);

let me = { uid: "", name: "Guest", avatar: "" };
let sessionId = "";
let listeners = [];
let countdownTimer = null;

// Queue-next-song UI state
let nextSongLock = null; // { songId, selectorUid }
let nextSongLockTs = 0;

// Chat state
let chat = new Map();    // id → message (dedupe)
let lastChatTs = Date.now();
let replyTo = null;
let chatLoaded = false;  // initial batch loaded?
let chatLoadingOlder = false;
let chatHasMore = true;
let oldestKey = "";
let seenOthers = 0;

const audio = $("audio");

// ── Small helpers ────────────────────────────────────────────────────────────
function showScreen(name) {
  ["loading", "error", "player", "tap"].forEach((s) => {
    const el = $(`screen-${s}`);
    if (el) el.classList.toggle("hidden", s !== name);
  });
}

function sid() {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  } catch (e) {
    return Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  }
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

// Queue-next-song helpers
async function fetchNextSongLock() {
  try {
    const res = await fetch("/api/next-song", { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function updateNextSongLock() {
  const data = await fetchNextSongLock();
  if (data) {
    nextSongLock = data;
    nextSongLockTs = Date.now();
  }
}

// Render a small lock icon on the selector's avatar in the listeners bar
function renderNextSongLockOnListener(uid) {
  if (!nextSongLock || !nextSongLock.selectorUid) return false;
  return nextSongLock.selectorUid === uid;
}

// Queue UI state
let queueModal = null;
let queueSongs = []; // all songs for selection
let queueLoading = false;

// Load all songs for queue selection
async function loadQueueSongs() {
  try {
    const res = await fetch("/api/songs", { cache: "no-store" });
    if (!res.ok) throw new Error("songs " + res.status);
    const data = await res.json();
    queueSongs = data.songs || [];
  } catch (e) {
    console.error("[Queue] Failed to load songs:", e);
    queueSongs = [];
  }
}

// Open queue modal
function openQueueModal() {
  if (!queueModal) {
    queueModal = $("queue-modal");
  }
  queueModal.classList.remove("hidden");
  queueModal.focus();
  updateQueueUI();
}

// Close queue modal
function closeQueueModal() {
  if (queueModal) {
    queueModal.classList.add("hidden");
  }
}

// Update queue modal UI
async function updateQueueUI() {
  const statusEl = $("queue-status");
  const listEl = $("queue-list");
  
  if (!statusEl || !listEl) return;
  
  // Update lock status
  const lockData = await fetchNextSongLock();
  if (lockData) {
    if (lockData.locked) {
      statusEl.textContent = `🔒 Locked by ${lockData.selectorUid || "someone"}`;
      statusEl.className = "queue-status locked";
    } else {
      statusEl.textContent = "🔓 Unlocked - select a song to queue next";
      statusEl.className = "queue-status unlocked";
    }
  } else {
    statusEl.textContent = "? Checking lock status...";
    statusEl.className = "queue-status unknown";
  }
  
  // Populate song list
  if (queueSongs.length === 0) {
    await loadQueueSongs();
  }
  
  listEl.innerHTML = "";
  
  // Add header
  const header = document.createElement("div");
  header.className = "queue-item header";
  header.innerHTML = `<div class="song-title">Song</div><div class="song-detail">Category</div>`;
  listEl.appendChild(header);
  
  // Add songs
  queueSongs.forEach(song => {
    const item = document.createElement("div");
    item.className = "queue-item";
    
    // Check if this song is currently locked
    const isLocked = lockData && lockData.locked && lockData.songId === song.id;
    if (isLocked) {
      item.classList.add("locked");
    }
    
    item.innerHTML = `
      ${isLocked ? '<span class="lock-icon">🔒</span>' : '<span class="lock-icon"></span>'}
      <div class="song-title">${esc(song.title)}</div>
      <div class="song-detail">${esc(song.category || "")}</div>
    `;
    
    if (!isLocked) {
      item.addEventListener("click", () => {
        selectQueueSong(song.id);
      });
    }
    
    listEl.appendChild(item);
  });
}

// Select a song for queue
async function selectQueueSong(songId) {
  try {
    const res = await fetch("/api/next-song", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        songId: songId,
        uid: me.uid || "guest-" + Math.random().toString(36).slice(2, 9)
      })
    });
    
    if (!res.ok) {
      const error = await res.json();
      alert(error.error || "Failed to lock song");
      return;
    }
    
    const result = await res.json();
    if (result.ok) {
      // Update UI immediately
      updateQueueUI();
      // Close modal after short delay to show feedback
      setTimeout(closeQueueModal, 300);
    } else {
      alert(result.reason || "Failed to lock song");
    }
  } catch (e) {
    console.error("[Queue] Error selecting song:", e);
    alert("Failed to lock song");
  }
}

// Release queue lock (for testing/admin)
async function releaseQueueLock() {
  try {
    await fetch("/api/next-song", { method: "DELETE" });
    updateQueueUI();
  } catch (e) {
    console.error("[Queue] Error releasing lock:", e);
  }
}

// ── Sync engine (shared clock) ───────────────────────────────────────────────
function computeCurrent(now = Date.now()) {
  if (!sched) return null;
  const elapsed = ((now - sched.epoch) % sched.cycleMs + sched.cycleMs) % sched.cycleMs;
  let acc = 0;
  for (let i = 0; i < sched.songIds.length; i++) {
    const id = sched.songIds[i];
    const d = sched.byId[id].durationMs;
    if (acc + d > elapsed) return { index: i, id, offsetMs: elapsed - acc, durationMs: d };
    acc += d;
  }
  const id = sched.songIds[sched.songIds.length - 1];
  return { index: sched.songIds.length - 1, id, offsetMs: 0, durationMs: sched.byId[id].durationMs };
}

async function loadSync() {
  const res = await fetch("/api/sync", { cache: "no-store" });
  if (!res.ok) throw new Error("sync " + res.status);
  const data = await res.json();
  sched = {
    epoch: data.epoch,
    cycleMs: data.cycleMs,
    songIds: data.rotation.map((s) => s.id),
    byId: {},
  };
  data.rotation.forEach((s) => {
    sched.byId[s.id] = { id: s.id, title: s.title, artist: s.artist, category: s.category, durationMs: s.durationMs || 210000 };
  });
  cur = computeCurrent();
}

function remainingInSong(now = Date.now()) {
  if (!sched) return 0;
  const target = computeCurrent(now);
  if (!target) return 0;
  return target.durationMs - target.offsetMs;
}

function applyClock(force) {
  const target = computeCurrent();
  if (!target) return;

  if (cur && cur.id !== target.id) {
    // Song boundary — switch.
    switchTo(target, true);
  } else {
    cur = target;
    if (audioSongId !== target.id) {
      switchTo(target, false);
    } else if (force) {
      const want = target.offsetMs / 1000;
      const have = audio.currentTime || 0;
      if (audio.readyState >= 2 && Math.abs(have - want) > 5) {
        try { audio.currentTime = want; } catch (e) {}
      }
    }
  }
}

function syncTick() {
  const target = computeCurrent();
  if (!target) return;
  if (cur && cur.id !== target.id) {
    switchTo(target, true);
    return;
  }
  cur = target;
  if (audioSongId !== target.id) {
    switchTo(target, false);
    return;
  }
  // Gentle drift correction on the tick (bigger threshold than force-seek,
  // and never during the buffering grace after a switch).
  if (Date.now() - lastSwitchAt < 6000) return;
  const want = target.offsetMs / 1000;
  const have = audio.currentTime || 0;
  if (audio.readyState >= 2 && Math.abs(have - want) > 8) {
    try { audio.currentTime = want; } catch (e) {}
  }
}

function switchTo(target, isBoundary) {
  cur = target;
  const song = sched.byId[target.id];
  if (!song) return;
  const offsetSec = Math.max(0, Math.floor(target.offsetMs / 1000));
  const streamUrl = `/stream/${encodeURIComponent(target.id)}?start=${offsetSec}`;
  if (audio.src !== new URL(streamUrl, location.href).href) {
    audio.src = streamUrl;
  }
  audioSongId = target.id;
  lastSwitchAt = Date.now();
  updateNowPlaying(song, target);
  const p = audio.play();
  if (p) p.catch(() => {});
}

// ── Playback events ──────────────────────────────────────────────────────────
audio.addEventListener("playing", () => {
  playing = true;
  $("eq").classList.remove("stopped");
  $("disc").classList.remove("paused");
});
audio.addEventListener("pause", () => {
  playing = false;
  $("eq").classList.add("stopped");
  $("disc").classList.add("paused");
});
audio.addEventListener("ended", () => {
  // Never rely on 'ended' for advancement — the shared clock decides.
  // If our duration estimate is shorter than the real song, skip to the
  // next song at its clock offset; otherwise just resync at the boundary.
  const remaining = remainingInSong();
  if (remaining > 8000) {
    const next = computeCurrent(Date.now() + remaining + 100);
    if (next && next.id !== cur.id) switchTo(next, true);
  } else {
    applyClock(true);
  }
});
audio.addEventListener("error", () => {
  setTimeout(() => {
    if (!playing) return;
    const target = computeCurrent(Date.now() + 3000);
    if (target && (!cur || target.id !== cur.id)) switchTo(target, true);
    else applyClock(true);
  }, 2500);
});
audio.addEventListener("loadedmetadata", () => {
  // Seek to the correct offset once metadata is known (covers VBR drift).
  if (!cur || audioSongId !== cur.id) return;
  if (Date.now() - lastSwitchAt < 3000) return; // buffering grace
  const want = cur.offsetMs / 1000;
  if (audio.readyState >= 1 && Math.abs((audio.currentTime || 0) - want) > 5) {
    try { audio.currentTime = want; } catch (e) {}
  }
});

function updateNowPlaying(song, target) {
  $("np-title").textContent = song.title || "Untitled";
  $("np-artist").textContent = song.artist || "SGSS";
  $("np-cat").textContent = song.category || "—";
  $("disc-label").textContent = (song.title || "🎵").slice(0, 2).toUpperCase();
  document.title = `🎵 ${song.title || "Bible Songs"}`;
  // Progress ring on the disc (visual, no "Song X of Y" text)
  if (target && target.durationMs > 0) {
    const frac = Math.min(1, Math.max(0, target.offsetMs / target.durationMs));
    $("disc").style.setProperty("--progress", (frac * 360).toFixed(0) + "deg");
  }
}

// ── Volume / mute (the ONLY controls) ───────────────────────────────────────
const volSlider = $("vol-slider");
const volPct = $("vol-pct");
const muteBtn = $("mute-btn");

function volIcon(v) {
  if (muted || v === 0) return "🔇";
  if (v < 50) return "🔉";
  return "🔊";
}

function applyVolume() {
  const v = muted ? 0 : volSlider.value;
  audio.volume = v / 100;
  volPct.textContent = muted ? "0%" : `${v}%`;
  volSlider.style.setProperty("--fill", `${v}%`);
  muteBtn.textContent = volIcon(v);
  localStorage.setItem("bible-vol", String(volSlider.value));
}

volSlider.addEventListener("input", applyVolume);
muteBtn.addEventListener("click", () => {
  muted = !muted;
  if (muted) lastVol = volSlider.value;
  else volSlider.value = lastVol;
  applyVolume();
});
document.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  if (e.key === "ArrowUp") { e.preventDefault(); volSlider.value = Math.min(100, Number(volSlider.value) + 5); applyVolume(); }
  if (e.key === "ArrowDown") { e.preventDefault(); volSlider.value = Math.max(0, Number(volSlider.value) - 5); applyVolume(); }
  if (e.key === "m" || e.key === "M") { muteBtn.click(); }
});

// ── Header identity ──────────────────────────────────────────────────────────
function myUid() {
  let uid = localStorage.getItem("bible-uid");
  if (!uid) {
    uid = "g-" + sid();
    localStorage.setItem("bible-uid", uid);
  }
  return uid;
}

function renderMe(user) {
  const el = $("header-me");
  if (!el) return;
  if (user) {
    me = {
      uid: String(user.id || ""),
      name: user.global_name || user.username || "Guest",
      avatar: discordAvatar(user),
    };
    el.innerHTML = "";
    const img = document.createElement("img");
    img.src = me.avatar;
    img.alt = "";
    const name = document.createElement("span");
    name.textContent = me.name;
    el.appendChild(img);
    el.appendChild(name);
  } else {
    // Browser / guest — persistent uid so listening hours survive rejoins.
    me = { uid: myUid(), name: "Guest-" + myUid().slice(-4), avatar: "" };
    el.textContent = "🎧 " + me.name;
  }
  heartbeat(true);
  pollLeaderboard();
}

// ── Listening dashboard (presence) ──────────────────────────────────────────
async function heartbeat(gone) {
  try {
    await fetch("/api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        gone
          ? { sessionId, gone: true }
          : { sessionId, uid: me.uid, name: me.name, avatar: me.avatar }
      ),
    });
  } catch (e) { /* non-fatal */ }
}

async function pollListeners() {
  try {
    const res = await fetch("/api/listeners", { cache: "no-store" });
    const data = await res.json();
    listeners = data.listeners || [];
    $("lb-count").textContent = `${data.count || 0} listening`;
    const chips = $("lb-chips");
    chips.innerHTML = "";
    listeners.forEach((l) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.title = l.name;
      if (l.avatar) {
        const img = document.createElement("img");
        img.src = l.avatar;
        img.alt = "";
        chip.appendChild(img);
      } else {
        const dot = document.createElement("span");
        dot.className = "chip-dot";
        chip.appendChild(dot);
      }
      const nm = document.createElement("span");
      nm.textContent = l.name;
      chip.appendChild(nm);
      // If this listener has the queue lock, add a lock icon after the name
      if (renderNextSongLockOnListener(l.uid)) {
        const lockIcon = document.createElement("span");
        lockIcon.className = "lock-icon";
        lockIcon.title = "Has queued next song";
        lockIcon.textContent = "🔒";
        chip.appendChild(lockIcon);
      }
      chip.addEventListener("click", () => mention(l.name, l.sessionId));
      chips.appendChild(chip);
    });
  } catch (e) { /* non-fatal */ }
}

// ── Leaderboard (cumulative listening hours) ─────────────────────────────────
function fmtHours(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s >= 3600) return (s / 3600).toFixed(1).replace(/\.0$/, "") + "h";
  if (s >= 60) return Math.round(s / 60) + "m";
  return s + "s";
}

function lbAvatarHTML(u) {
  if (u.avatar) return `<img class="lb-av" src="${esc(u.avatar)}" alt="">`;
  const ch = ((u.name || "?").trim().charAt(0) || "?").toUpperCase();
  return `<span class="lb-av lb-initial" style="background:${nameColor(u.name || "?")}">${esc(ch)}</span>`;
}

function lbRowHTML(u, rank) {
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `<span class="lb-rank">${rank}</span>`;
  const isMe = u.uid && u.uid === me.uid;
  return `<div class="lb-row${isMe ? " me" : ""}">
    <span class="lb-medal">${medal}</span>
    ${lbAvatarHTML(u)}
    <span class="lb-name">${esc(u.name)}${isMe ? '<em class="lb-you-tag">you</em>' : ""}</span>
    <span class="lb-hours">${fmtHours(u.seconds)}</span>
  </div>`;
}

function renderLeaderboard(data) {
  const list = data.leaderboard || [];
  $("lb-sub").textContent = `${data.total || 0} listeners · all time`;
  $("lb-rows").innerHTML = list.slice(0, 5).map((u, i) => lbRowHTML(u, i + 1)).join("");
  $("lb-modal-rows").innerHTML = list.map((u, i) => lbRowHTML(u, i + 1)).join("");
  const myIdx = list.findIndex((u) => u.uid === me.uid);
  const youEl = $("lb-you");
  if (myIdx >= 0 && myIdx >= 5) {
    youEl.classList.remove("hidden");
    youEl.innerHTML = `<span>…</span>${lbRowHTML(list[myIdx], myIdx + 1)}`;
  } else {
    youEl.classList.add("hidden");
  }
}

async function pollLeaderboard() {
  try {
    const res = await fetch("/api/leaderboard", { cache: "no-store" });
    if (!res.ok) return;
    renderLeaderboard(await res.json());
  } catch (e) { /* non-fatal */ }
}

// ── Chat ─────────────────────────────────────────────────────────────────────
function mention(name, id) {
  const input = $("chat-input");
  const current = input.value.trim();
  input.value = current ? current + " @" + name + " " : "@" + name + " ";
  input.focus();
}

function setReplyChip(r) {
  replyTo = r;
  const chip = $("chat-reply-chip");
  if (r) {
    $("chat-reply-text").textContent = `↩ Replying to ${r.name}: ${r.text.slice(0, 60)}`;
    chip.classList.remove("hidden");
  } else {
    chip.classList.add("hidden");
  }
}

function nameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 75%, 68%)`;
}

function renderChatMessage(m, prepend) {
  const box = $("chat-msgs");
  const empty = box.querySelector(".chat-empty");
  if (empty) empty.remove();

  const mine = m.user && m.user.uid && m.user.uid === me.uid;
  const div = document.createElement("div");
  div.className = "msg" + (mine ? " mine" : "");
  div.dataset.id = m.id;

  let inner = "";
  if (m.replyTo) {
    inner += `<div class="msg-reply" data-reply="${esc(m.replyTo.id)}">↩ <b style="color:${nameColor(m.replyTo.name)}">${esc(m.replyTo.name)}</b><span class="rep-snip">${esc(m.replyTo.text)}</span></div>`;
  }
  inner += `<div class="msg-head">`;
  if (m.user && m.user.avatar) inner += `<img class="msg-avatar" src="${esc(m.user.avatar)}" alt="">`;
  inner += `<span class="msg-name" style="color:${nameColor((m.user && m.user.name) || "Guest")}" data-uid="${esc((m.user && m.user.uid) || "")}" data-sname="${esc((m.user && m.user.name) || "")}">${esc((m.user && m.user.name) || "Guest")}</span>`;
  if (m.mention) inner += `<span class="msg-mention">@${esc(m.mention.name)}</span>`;
  inner += `<span class="msg-time">${timeAgo(Number(m.ts) || Date.now())}</span>`;
  inner += `</div>`;
  inner += `<div class="msg-text">${esc(m.text)}</div>`;
  inner += `<div class="msg-actions">
    <button class="msg-act" data-act="reply" title="Reply">↩</button>
    <button class="msg-act" data-act="mention" title="Mention">@</button>
  </div>`;

  div.innerHTML = inner;
  if (prepend) {
    box.insertBefore(div, box.firstChild);
  } else {
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  div.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.act === "reply") {
        setReplyChip({ id: m.id, name: (m.user && m.user.name) || "Guest", text: m.text });
        $("chat-input").focus();
      } else {
        mention((m.user && m.user.name) || "Guest", (m.user && m.user.uid) || "");
      }
    });
  });
  div.querySelectorAll(".msg-name").forEach((nm) => {
    nm.addEventListener("click", () => mention(nm.dataset.sname, nm.dataset.uid));
  });
}

function renderChatList() {
  const box = $("chat-msgs");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = "";
  const ordered = [...chat.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  ordered.forEach((m) => renderChatMessage(m, false));
  if (atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = box.scrollHeight; // keep at bottom after initial render
}

async function loadChatHistory(reset) {
  if (chatLoadingOlder) return;
  chatLoadingOlder = true;
  try {
    const url = reset
      ? "/api/chat?limit=200"
      : `/api/chat?limit=200&before=${encodeURIComponent(oldestKey)}`;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    const msgs = data.messages || [];
    if (reset) {
      chat.clear();
      msgs.forEach((m) => chat.set(m.id, m));
      if (msgs.length) lastChatTs = Math.max(...msgs.map((m) => Number(m.ts) || 0));
      renderChatList();
    } else if (msgs.length) {
      const box = $("chat-msgs");
      const prevHeight = box.scrollHeight;
      const prevTop = box.scrollTop;
      const prevFirst = box.querySelector(".msg")?.dataset.id || "";
      msgs.forEach((m) => chat.set(m.id, m));
      // Re-render just the new ones above
      msgs.forEach((m) => {
        if (!document.querySelector(`#chat-msgs .msg[data-id="${m.id}"]`)) {
          renderChatMessage(m, true);
        }
      });
      box.scrollTop = box.scrollTop + (box.scrollHeight - prevHeight);
    }
    chatHasMore = data.hasMore;
    oldestKey = [...chat.values()].sort((a, b) => (a.id < b.id ? -1 : 1))[0]?.id || "";
    chatLoaded = true;
  } catch (e) { /* non-fatal */ }
  chatLoadingOlder = false;
}

async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  const msg = {
    id: `${Date.now()}-${sid()}`,
    text,
    user: { uid: me.uid, name: me.name, avatar: me.avatar },
  };
  if (replyTo) {
    msg.replyTo = { id: replyTo.id, name: replyTo.name, text: replyTo.text };
    const m = text.match(/^@(\S+)\s*/);
    if (m) {
      const target = listeners.find((l) => l.name === m[1] || l.sessionId === m[1]);
      if (target) msg.mention = { id: target.sessionId, name: target.name };
    }
  }
  try {
    await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    input.value = "";
    setReplyChip(null);
    chat.set(msg.id, msg);
    lastChatTs = Math.max(lastChatTs, msg.ts || Date.now());
    renderChatMessage(msg, false);
    openChat(true);
  } catch (e) { /* keep text in input on failure */ }
}

async function pollChat() {
  try {
    const res = await fetch(`/api/chat?limit=50&since=0`, { cache: "no-store" });
    const data = await res.json();
    (data.messages || []).forEach((m) => {
      const ts = Number(m.ts || 0);
      if (!chat.has(m.id)) {
        chat.set(m.id, m);
        lastChatTs = Math.max(lastChatTs, ts);
        if (chatLoaded) renderChatMessage(m, false);
      }
    });
    const badge = $("chat-badge");
    const open = !$("chat-body").classList.contains("hidden");
    const unread = chatUnread();
    badge.hidden = open || unread === 0;
    badge.textContent = String(unread);
  } catch (e) { /* non-fatal */ }
}

function chatUnread() {
  let n = 0;
  chat.forEach((m) => {
    if (!m._seen && !(m.user && m.user.uid && m.user.uid === me.uid)) n++;
  });
  return n;
}

function openChat(force) {
  const body = $("chat-body");
  const opening = body.classList.contains("hidden");
  if (force && !opening) return;
  body.classList.toggle("hidden");
  body.classList.toggle("open");
  $("chat-badge").hidden = true;
  if (opening) {
    chat.forEach((m) => { m._seen = true; });
    $("chat-msgs").scrollTop = $("chat-msgs").scrollHeight;
    $("chat-input").focus();
    if (!chatLoaded) loadChatHistory(true);
  }
}

// ── Auto-start countdown ─────────────────────────────────────────────────────
function runCountdown(onDone) {
  const overlay = $("countdown");
  const num = $("cd-num");
  overlay.classList.remove("hidden");
  let n = 3;
  num.textContent = String(n);
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(countdownTimer);
      overlay.classList.add("hidden");
      onDone();
      return;
    }
    num.textContent = String(n);
  }, 1000);
}

function startStream() {
  showScreen("player");
  applyClock(true);
  const p = audio.play();
  if (p) {
    p.then(() => showScreen("player")).catch(() => showScreen("tap"));
  }
}

function wireTapFallback() {
  const enable = () => {
    audio.play().then(() => showScreen("player")).catch(() => {});
    document.removeEventListener("pointerdown", enable, true);
  };
  document.addEventListener("pointerdown", enable, true);
}

// ── Support link ─────────────────────────────────────────────────────────────
function wireSupport() {
  document.querySelectorAll("a.support-link, a[href='/support']").forEach((a) => {
    a.addEventListener("click", (e) => {
      const url = "https://walusimbi-leon1.github.io/voice-support/";
      if (inDiscordFrame) {
        e.preventDefault();
        import("./discord.js").then(({ discordSdk }) => {
          if (discordSdk && typeof discordSdk.commands.openExternalLink === "function") {
            discordSdk.commands.openExternalLink({ url }).catch((err) => {
              console.error("[support] openExternalLink failed:", err);
              window.open(url, "_blank");
            });
          } else {
            window.open(url, "_blank");
          }
        });
      }
    });
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  sessionId = sid();
  showScreen("loading");
  try {
    const [discordInfo] = await Promise.all([
      initDiscord(),
      loadSync(),
    ]);
    renderMe(discordInfo?.user || null);

    applyVolume();
    wireSupport();

    // Presence + listeners
    setInterval(() => heartbeat(false), 15000);
    pollListeners();
    setInterval(pollListeners, 10000);
    window.addEventListener("beforeunload", () => heartbeat(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") heartbeat(true);
    });

    // Leaderboard
    $("lb-show").addEventListener("click", () => $("lb-modal").classList.remove("hidden"));
    $("lb-close").addEventListener("click", () => $("lb-modal").classList.add("hidden"));
    $("lb-modal").addEventListener("click", (e) => {
      if (e.target === $("lb-modal")) $("lb-modal").classList.add("hidden");
    });
    setInterval(pollLeaderboard, 20000);

    // Chat wiring
    $("chat-send").addEventListener("click", sendChat);
    $("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });
    $("chat-toggle").addEventListener("click", () => openChat(false));
    $("chat-reply-x").addEventListener("click", () => setReplyChip(null));
    const msgsEl = $("chat-msgs");
    msgsEl.addEventListener("scroll", () => {
      if (msgsEl.scrollTop < 40 && chatLoaded && chatHasMore) {
        loadChatHistory(false);
      }
    });
    pollChat();
    setInterval(pollChat, 3000);

    // Queue next song
    $("queue-btn").addEventListener("click", openQueueModal);
    $("queue-close").addEventListener("click", closeQueueModal);
    $("queue-modal").addEventListener("click", (e) => {
      if (e.target === $("queue-modal")) closeQueueModal();
    });
    loadQueueSongs(); // load once
    setInterval(updateNextSongLock, 5000); // keep lock status fresh
    setInterval(updateQueueUI, 5000); // update UI if modal open

    // Sync clock tick
    setInterval(() => syncTick(), 2000);

    // AUTO-START: countdown → stream (no manual start button)
    runCountdown(() => {
      startStream();
      wireTapFallback();
    });
  } catch (err) {
    console.error("[bible-songs] boot failed:", err);
    $("error-msg").textContent = err.message || "Could not load the stream.";
    showScreen("error");
    $("retry-btn").addEventListener("click", () => location.reload());
  }
}

boot();
