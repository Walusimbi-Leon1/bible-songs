/**
 * Bible Songs — 24/7 continuous streaming player
 *
 * - Fetches the live song catalog from our worker (/api/songs).
 * - Plays songs back-to-back forever. NO PAUSE — the shared stream keeps
 *   everyone in the channel in sync. Only volume + mute are available.
 * - AUTO-START: on launch a 3-2-1 countdown plays, then the stream starts.
 *   No manual start button. (Browsers may still require one tap for audio —
 *   that shows a compact "tap to enable" screen, not a start gate.)
 * - Listening dashboard: heartbeats presence via /api/presence and polls
 *   /api/listeners to show who's listening + total count.
 * - Chat dashboard: /api/chat with replies to specific messages and direct
 *   @mentions of listeners.
 * - Audio is streamed through our own worker (/stream/<id>), because the
 *   Discord sandbox CSP blocks external hosts; the worker proxies the
 *   GitHub-hosted MP3 with full Range support.
 */

import { initDiscord, isDiscord, inDiscordFrame, discordAvatar } from "./discord.js";

const $ = (id) => document.getElementById(id);

let songs = [];          // [{id, title, artist, category, url, thumb}]
let order = [];          // play order (indices into songs)
let pos = 0;             // current position in order
let playing = false;
let muted = false;
let lastVol = 70;

let me = { uid: "", name: "Guest", avatar: "" };
let sessionId = "";
let lastChatTs = Date.now();
let replyTo = null;      // { id, name, text }
let listeners = [];      // [{sessionId, name, avatar}]
let countdownTimer = null;

const audio = $("audio");

// ── Screen switching ─────────────────────────────────────────────────────────
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

// ── Fetch catalog ────────────────────────────────────────────────────────────
async function loadSongs() {
  const res = await fetch("/api/songs", { cache: "no-store" });
  if (!res.ok) throw new Error("catalog " + res.status);
  const data = await res.json();
  songs = (data.songs || []).filter((s) => s && s.id && s.url);
  if (!songs.length) throw new Error("empty catalog");
  // Deterministic rotation: keep a stable start, then shuffle lightly.
  order = songs.map((_, i) => i);
  // Fisher-Yates with a time seed so every session starts somewhere fresh,
  // but stays continuous once running.
  let seed = Date.now() & 0xffff;
  for (let i = order.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  renderList();
  $("np-count").textContent = `Song 1 of ${songs.length}`;
}

function currentSong() {
  return songs[order[pos]];
}

// ── Playback ────────────────────────────────────────────────────────────────
function playCurrent() {
  const song = currentSong();
  if (!song) return;
  const streamUrl = `/stream/${encodeURIComponent(song.id)}`;
  if (audio.src !== new URL(streamUrl, location.href).href) {
    audio.src = streamUrl;
  }
  const p = audio.play();
  if (p) p.catch(() => { /* autoplay fallback handles this */ });
  updateNowPlaying(song);
}

function updateNowPlaying(song) {
  $("np-title").textContent = song.title || "Untitled";
  $("np-artist").textContent = song.artist || "SGSS";
  $("np-cat").textContent = song.category || "—";
  $("disc-label").textContent = (song.title || "🎵").slice(0, 2).toUpperCase();
  $("np-count").textContent = `Song ${pos + 1} of ${songs.length}`;
  document.title = `🎵 ${song.title || "Bible Songs"}`;

  // Highlight in list
  const lis = document.querySelectorAll("#song-ul li");
  lis.forEach((li, i) => li.classList.toggle("playing", i === order[pos]));
  const active = document.querySelector("#song-ul li.playing");
  if (active && active.scrollIntoView) {
    try { active.scrollIntoView({ block: "nearest" }); } catch (e) {}
  }
}

function renderList() {
  const ul = $("song-ul");
  ul.innerHTML = "";
  songs.forEach((s, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="s-num">${i + 1}</span><span class="s-title"></span><span class="s-cat"></span>`;
    li.querySelector(".s-title").textContent = s.title || "Untitled";
    li.querySelector(".s-cat").textContent = s.category || "";
    ul.appendChild(li);
  });
}

// Auto-advance when a song ends → never stops.
audio.addEventListener("ended", () => {
  pos = (pos + 1) % order.length;
  playCurrent();
});

// If the stream hiccups, recover to the next song after a short grace.
audio.addEventListener("error", () => {
  setTimeout(() => {
    if (!playing) return;
    pos = (pos + 1) % order.length;
    playCurrent();
  }, 2500);
});

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

// ── Auto-start: 3-2-1 countdown → play ──────────────────────────────────────
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
  playCurrent();
  const p = audio.play();
  if (p) {
    p.then(() => showScreen("player")).catch(() => showScreen("tap"));
  }
}

function wireTapFallback() {
  // Any tap anywhere starts audio (browser autoplay policy fallback).
  const enable = () => {
    audio.play().then(() => showScreen("player")).catch(() => {});
    document.removeEventListener("pointerdown", enable, true);
  };
  document.addEventListener("pointerdown", enable, true);
}

// ── Volume / mute (the ONLY controls) ───────────────────────────────────────
const volSlider = $("vol-slider");
const volPct = $("vol-pct");
const muteBtn = $("mute-btn");

function applyVolume() {
  audio.volume = muted ? 0 : volSlider.value / 100;
  volPct.textContent = muted ? "0%" : `${volSlider.value}%`;
  muteBtn.textContent = muted || Number(volSlider.value) === 0 ? "🔇" : "🔊";
}

volSlider.addEventListener("input", applyVolume);
muteBtn.addEventListener("click", () => {
  muted = !muted;
  if (muted) lastVol = volSlider.value;
  else volSlider.value = lastVol;
  applyVolume();
});

// ── Header identity ─────────────────────────────────────────────────────────
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
  } else if (isDiscord) {
    me = { uid: "", name: "Guest", avatar: "" };
    el.textContent = "🎧";
  } else {
    me = { uid: "", name: "Guest-" + sessionId.slice(0, 4), avatar: "" };
  }
  // Acknowledged presence update
  heartbeat(true);
}

// ── Listening dashboard (presence) ──────────────────────────────────────────
async function heartbeat(gone) {
  try {
    await fetch("/api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gone ? { sessionId, gone: true } : { sessionId, name: me.name, avatar: me.avatar }),
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
      chip.addEventListener("click", () => mention(l.name, l.sessionId));
      chips.appendChild(chip);
    });
  } catch (e) { /* non-fatal */ }
}

// ── Chat dashboard ──────────────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

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
    // Convert a leading @mention into a structured mention too.
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
    // Optimistic render (the poll will dedupe by id).
    renderChatMessage(msg);
    lastChatTs = Math.max(lastChatTs, msg.ts || Date.now());
    openChat(true);
  } catch (e) {
    /* keep text in input on failure */
  }
}

function renderChatMessage(m) {
  const box = $("chat-msgs");
  const empty = box.querySelector(".chat-empty");
  if (empty) empty.remove();

  const mine = m.user && m.user.uid && m.user.uid === me.uid;
  const div = document.createElement("div");
  div.className = "msg" + (mine ? " mine" : "");
  div.dataset.id = m.id;

  let inner = "";
  if (m.replyTo) {
    inner += `<div class="msg-reply" data-reply="${esc(m.replyTo.id)}">↩ <b>${esc(m.replyTo.name)}</b>: ${esc(m.replyTo.text)}</div>`;
  }
  inner += `<div class="msg-head">`;
  if (m.user && m.user.avatar) inner += `<img class="msg-avatar" src="${esc(m.user.avatar)}" alt="">`;
  inner += `<span class="msg-name" data-uid="${esc((m.user && m.user.uid) || "")}" data-sname="${esc((m.user && m.user.name) || "")}">${esc((m.user && m.user.name) || "Guest")}</span>`;
  if (m.mention) inner += `<span class="msg-mention">@${esc(m.mention.name)}</span>`;
  inner += `</div>`;
  inner += `<div class="msg-text">${esc(m.text)}</div>`;
  inner += `<div class="msg-actions">
    <button class="msg-act" data-act="reply">↩ Reply</button>
    <button class="msg-act" data-act="mention">@</button>
  </div>`;

  div.innerHTML = inner;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;

  // Wire actions
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
    nm.addEventListener("click", () => {
      mention(nm.dataset.sname, nm.dataset.uid);
    });
  });
}

async function pollChat() {
  try {
    const res = await fetch(`/api/chat?since=${lastChatTs}`, { cache: "no-store" });
    const data = await res.json();
    (data.messages || []).forEach((m) => {
      const ts = Number(m.ts || 0);
      if (ts <= lastChatTs) return;
      lastChatTs = ts;
      if (!document.querySelector(`#chat-msgs .msg[data-id="${m.id}"]`)) {
        renderChatMessage(m);
      }
    });
    const badge = $("chat-badge");
    const open = !$("chat-body").classList.contains("hidden");
    const unread = countUnread();
    badge.hidden = open || unread === 0;
    badge.textContent = String(unread);
  } catch (e) { /* non-fatal */ }
}

function countUnread() {
  return document.querySelectorAll("#chat-msgs .msg:not(.mine)").length - seenOthers;
}
let seenOthers = 0;

function openChat(force) {
  const body = $("chat-body");
  const opening = body.classList.contains("hidden");
  if (force && !opening) return;
  body.classList.toggle("hidden");
  $("chat-badge").hidden = true;
  if (opening) {
    seenOthers = document.querySelectorAll("#chat-msgs .msg:not(.mine)").length;
    $("chat-msgs").scrollTop = $("chat-msgs").scrollHeight;
    $("chat-input").focus();
  }
}

// ── Support link (opens in real browser — Discord sandbox blocks popups) ────
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

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  sessionId = sid();
  showScreen("loading");
  try {
    const [discordInfo] = await Promise.all([
      initDiscord(),
      loadSongs(),
    ]);
    renderMe(discordInfo?.user || null);

    applyVolume();
    wireSupport();

    // Heartbeats + polling
    setInterval(() => heartbeat(false), 15000);
    pollListeners();
    setInterval(pollListeners, 10000);
    pollChat();
    setInterval(pollChat, 3000);
    window.addEventListener("beforeunload", () => heartbeat(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") heartbeat(true);
    });

    // Chat wiring
    $("chat-send").addEventListener("click", sendChat);
    $("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });
    $("chat-toggle").addEventListener("click", () => openChat(false));
    $("chat-reply-x").addEventListener("click", () => setReplyChip(null));

    // AUTO-START: countdown 3-2-1 then play (no manual start button).
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
