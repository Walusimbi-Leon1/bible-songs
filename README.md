# Bible Songs 🎵

24/7 continuous music streaming for Discord Activities — Psalms, worship & Scripture songs from the SGSS open library.

**Live:** https://bible-songs.walusimbileon1.workers.dev

## Features
- **Always playing** — songs stream back-to-back 24/7; no pause, no skip (everyone in the channel stays in sync).
- **Volume & mute only** — the sole controls, as designed.
- **200+ songs** — Psalms, Worship, Christmas, English, Song of Solomon, 1st Samuel, Thirteen Files.
- **Cloudflare Workers** — catalog + audio proxied same-origin (Discord sandbox CSP-safe), Range-supported streaming.

## Architecture
```
src/            client (index.html, app.js, style.css, discord.js, vendored SDK)
worker.js       routes: / (app), /api/songs (live Firebase catalog),
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
