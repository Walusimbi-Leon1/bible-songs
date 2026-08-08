# Bible Songs 🎵

24/7 continuous music streaming for Discord Activities — Psalms, worship & Scripture songs from the SGSS open library.

**Live:** https://bible-songs.walusimbileon1.workers.dev

## Features
- **Synchronized 24/7 stream (radio model)** — everyone hears the SAME song at the SAME position, browser or Discord. A shared schedule clock in Firebase (epoch + probed per-song durations) drives every client.
- **Always playing** — songs flow back-to-back; no pause, no skip (only volume + mute, + keyboard ↑/↓/M).
- **Auto-start** — 3-2-1 countdown on launch, then the stream begins; no start button.
- **All-time leaderboard** — every user who ever launched/authorized the app is stored and ranked by cumulative listening hours (worker credits real listening time from heartbeat deltas; guests get a persistent localStorage uid).
- **Current-song display** — title, artist (SGSS), genre only. No playlist, no counters.
- **Listening dashboard** — live view of who's listening + total count.
- **Chat with history** — scroll back through old messages, reply to specific messages, @mention listeners.
- **Psalms + Song of Solomon** — 144 songs (128 Psalms, 16 Song of Solomon); other genres removed from the rotation (2026-08-08).
- **Cloudflare Workers** — catalog + audio proxied same-origin (Discord sandbox CSP-safe), Range + byte-seek supported.

## Architecture
```
src/            client (index.html, app.js, style.css, discord.js, vendored SDK)
worker.js       routes: / (app), /api/sync (shared schedule clock), /api/songs,
                /stream/<id> (GitHub MP3 proxy w/ Range), /api/exchange (Discord OAuth),
                /privacy /terms /support
build.js        inlines src/* → dist/worker.js
deploy.sh       wrangler deploy (or versions API fallback)
```

- Song catalog: Firebase RTDB `songs-cf1d9-default-rtdb` (live, 120s cache).
- Audio: GitHub release MP3s (`Walusimbi-Leon/songs-content`), proxied with byte-range passthrough.

## Deploy
```bash
CF_API_TOKEN=... bash deploy.sh
# with Discord creds (one-time):
CF_API_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... bash deploy.sh
```

## Discord
See [DISCORD-SUBMISSION.md](DISCORD-SUBMISSION.md) for the portal kit (descriptions, legal links, art assets, test checklist).
