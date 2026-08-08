#!/usr/bin/env node
/**
 * Bible Songs — probe MP3 durations + build the shared playback schedule.
 *
 * For each song in the catalog:
 *   HEAD the GitHub release URL → content-length
 *   GET Range: bytes=0-65535 → parse ID3v2 size + first MPEG frame header
 *     · CBR: duration = (size - id3) * 8 / bitrate
 *     · VBR (Xing/Info tag): duration = frames * samplesPerFrame / sampleRate
 * Writes:
 *   bible/durations.json  { songId: ms }
 *   bible/schedule.json   { hash, epoch, songIds, cycleMs, updatedAt }
 * to pop-party-1-default-rtdb (public-writable, namespace bible).
 *
 * Usage: node scripts/probe-durations.js
 */
const FB = "https://pop-party-1-default-rtdb.firebaseio.com";
const NS = "bible";

const BITRATE_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR_MPEG1 = [44100, 48000, 32000];
const SR_MPEG2 = [22050, 24000, 16000];
const SR_MPEG25 = [11025, 12000, 8000];

const DEFAULT_MS = 210000;

async function getCatalog() {
  const res = await fetch("https://bible-songs.walusimbileon1.workers.dev/api/songs", { cache: "no-store" });
  const data = await res.json();
  return data.songs || [];
}

async function getSize(url) {
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  return Number(res.headers.get("content-length")) || 0;
}

function parseFirstFrame(buf, offset) {
  // Scan for a VALID MPEG frame: sync + sane version/layer/bitrate/sr, then
  // validate frame spacing (the next frame starts exactly frameSize later).
  for (let i = offset; i < buf.length - 8; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const b1 = buf[i + 1], b2 = buf[i + 2];
    const version = (b1 >> 3) & 0x03;   // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layer = (b1 >> 1) & 0x03;     // 3=Layer I, 2=Layer II, 1=Layer III
    const brIdx = (b2 >> 4) & 0x0f;
    const srIdx = (b2 >> 2) & 0x03;
    if (layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const table = version === 3 ? BITRATE_MPEG1_L3 : BITRATE_MPEG2_L3;
    const kbps = table[brIdx];
    const srs = version === 3 ? SR_MPEG1 : version === 2 ? SR_MPEG2 : SR_MPEG25;
    const sampleRate = srs[srIdx];
    if (!kbps || !sampleRate) continue;
    const padding = (b2 >> 1) & 1;
    const mult = version === 3 ? 144 : 72;
    const frameSize = Math.floor((mult * kbps * 1000) / sampleRate) + padding;
    // Validate spacing: a sync should exist frameSize bytes later. Do NOT
    // require the same bitrate there — VBR files vary bitrate per frame.
    if (i + frameSize + 4 > buf.length) return null;
    if (buf[i + frameSize] !== 0xff || (buf[i + frameSize + 1] & 0xe0) !== 0xe0) continue;
    return { frameStart: i, version, kbps, sampleRate };
  }
  return null;
}

function id3Size(buf) {
  // ID3v2: "ID3" + ver + flags + 4-byte syncsafe size
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  }
  return 0;
}

async function probe(url) {
  const size = await getSize(url);
  if (!size) return null;

  const res = await fetch(url, { headers: { Range: "bytes=0-262143" }, redirect: "follow" });
  const buf = Buffer.from(await res.arrayBuffer());

  const id3 = id3Size(buf);
  // Start scanning right AFTER the ID3 tag — scanning inside it hits false
  // sync bytes in tag metadata (APIC/text) and breaks the layer check.
  const frame = parseFirstFrame(buf, Math.min(id3 + 4, Math.max(0, buf.length - 8)));

  if (!frame) return null;

  const audioBytes = size - id3;
  // Xing/Info VBR header inside the FIRST frame (offset relative to frame start)
  const vbrOff = frame.version === 3 ? 36 : 21;
  const frameStart = frame.frameStart;
  if (buf.length > frameStart + vbrOff + 16) {
    const tag = buf.slice(frameStart + vbrOff, frameStart + vbrOff + 4).toString("latin1");
    if (tag === "Xing" || tag === "Info") {
      const frames = buf.readUInt32BE(frameStart + vbrOff + 8);
      const spf = frame.version === 3 ? 1152 : 576;
      if (frames > 0) return Math.round((frames * spf) / frame.sampleRate * 1000);
    }
  }
  // CBR estimate
  return Math.round((audioBytes * 8) / (frame.kbps * 1000) * 1000);
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  console.log("Fetching catalog…");
  const songs = await getCatalog();
  console.log(`Catalog: ${songs.length} songs`);

  const existing = await fetch(`${FB}/${NS}/durations.json`).then((r) => r.json()).catch(() => ({})) || {};
  const durations = {};
  let fromCache = 0, probed = 0, failed = 0;

  const queue = songs.filter((s) => !existing[s.id]);
  console.log(`Known: ${songs.length - queue.length}, to probe: ${queue.length}`);

  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const song = queue[cursor++];
      try {
        const ms = await probe(song.url);
        if (ms && ms > 10000) {
          durations[song.id] = ms;
          probed++;
        } else {
          durations[song.id] = DEFAULT_MS;
          failed++;
          console.log(`  fallback ${song.title}: ${ms || "parse fail"}`);
        }
      } catch (e) {
        durations[song.id] = DEFAULT_MS;
        failed++;
        console.log(`  error ${song.title}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));

  for (const s of songs) if (existing[s.id]) { durations[s.id] = existing[s.id]; fromCache++; }

  console.log(`Probed: ${probed}, cached: ${fromCache}, fallback: ${failed}`);

  const hash = songs.map((s) => s.id).sort().join("|");
  const songIds = seededShuffle(songs.map((s) => s.id), hashStr(hash));
  const cycleMs = songIds.reduce((a, id) => a + (durations[id] || DEFAULT_MS), 0);

  // Epoch: aligned to the minute, one minute back (so offset isn't 0 at boot).
  const epoch = Date.now() - (Date.now() % 60000) - 60000;
  const schedule = { hash, epoch, songIds, cycleMs, count: songIds.length, updatedAt: Date.now() };

  console.log(`cycleMs: ${Math.round(cycleMs / 60000)} min (${songIds.length} songs)`);

  await fetch(`${FB}/${NS}/durations.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(durations) });
  await fetch(`${FB}/${NS}/schedule.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(schedule) });
  console.log("✅ durations + schedule written to Firebase");

  const check = await fetch(`${FB}/${NS}/schedule.json`).then((r) => r.json());
  console.log(`Verify: epoch=${check.epoch} songs=${check.count} cycleMs=${check.cycleMs}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
