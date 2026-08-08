/**
 * Bible Songs — 24/7 continuous streaming player
 *
 * - Fetches the live song catalog from our worker (/api/songs).
 * - Plays songs back-to-back forever. NO PAUSE — the shared stream keeps
 *   everyone in the channel in sync. Only volume + mute are available.
 * - Audio is streamed through our own worker (/stream/<id>), because the
 *   Discord sandbox CSP blocks external hosts; the worker proxies the
 *   GitHub-hosted MP3 with full Range support.
 * - The Discord sandbox requires a user gesture before audio can start,
 *   so we show a "Start Listening" gate; after that it never stops.
 */

import { initDiscord, isDiscord, inDiscordFrame, discordAvatar } from "./discord.js";

const $ = (id) => document.getElementById(id);

let songs = [];          // [{id, title, artist, category, url, thumb}]
let order = [];          // play order (indices into songs)
let pos = 0;             // current position in order
let playing = false;
let muted = false;
let lastVol = 70;

const audio = $("audio");

// ── Screen switching ─────────────────────────────────────────────────────────
function showScreen(name) {
  ["loading", "error", "player", "start"].forEach((s) => {
    const el = $(`screen-${s}`);
    if (el) el.classList.toggle("hidden", s !== name);
  });
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
  if (p) p.catch(() => { /* user gesture gate handles this */ });
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
  // We never expose pause — but if the sandbox stalls the stream, keep the
  // disc spinning look honest while we recover.
  playing = false;
  $("eq").classList.add("stopped");
  $("disc").classList.add("paused");
});

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
    el.innerHTML = "";
    const img = document.createElement("img");
    img.src = discordAvatar(user);
    img.alt = "";
    const name = document.createElement("span");
    name.textContent = user.global_name || user.username || "Player";
    el.appendChild(img);
    el.appendChild(name);
  } else if (isDiscord) {
    el.textContent = "🎧";
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
  showScreen("loading");
  try {
    const [discordInfo] = await Promise.all([
      initDiscord(),
      loadSongs(),
    ]);
    renderMe(discordInfo?.user || null);

    // Autoplay gate: audio needs a user gesture (especially in Discord).
    $("start-btn").addEventListener("click", () => {
      showScreen("player");
      playCurrent();
    });

    // Try to start immediately; if the browser blocks it (autoplay policy),
    // the start screen stays until the user taps.
    showScreen("player");
    playCurrent();
    const p = audio.play();
    if (p) {
      p.then(() => showScreen("player")).catch(() => showScreen("start"));
    }
    applyVolume();
    wireSupport();
  } catch (err) {
    console.error("[bible-songs] boot failed:", err);
    $("error-msg").textContent = err.message || "Could not load the stream.";
    showScreen("error");
    $("retry-btn").addEventListener("click", () => location.reload());
  }
}

boot();
