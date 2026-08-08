# Bible Songs — Discord Developer Portal Kit

**Live URL:** https://bible-songs.walusimbileon1.workers.dev
**Repo:** https://github.com/Walusimbi-Leon1/bible-songs
**Client ID:** 1535729840827670655 *(wired in — `src/discord.js` + `wrangler.toml`)*
**Client Secret:** set as Worker secret `DISCORD_CLIENT_SECRET` *(never committed)*
**Auth redirect URI:** `https://bible-songs.walusimbileon1.workers.dev` — register in the portal

## 1. Portal configuration (verify these are set)

1. **General Information**: name, icon, short description `24/7 continuous streaming of Psalms, worship & Scripture songs`, tags `music`, `streaming`.
2. **OAuth2 → General**: add redirect `https://bible-songs.walusimbileon1.workers.dev`.
3. **Installation Contexts**: Guild Install + User Install checked.
4. **Activities / Embedded App SDK**: Activities enabled (required to launch in voice channels).
5. **Rich Presence / artwork**: cover + banner (raw URLs below).

## 2. Code status

- Client ID baked into `src/discord.js` + `wrangler.toml [vars]`.
- Client secret stored as Worker secret (set 2026-08-08, verified — Discord returns `invalid_grant` for fake codes, meaning the secret is bound and validating).
- `/api/exchange` uses the SDK's native redirect_uri (`location.origin + location.pathname`) so the token exchange matches Discord's embedded flow exactly.
- Users joining via Discord get the authorize prompt → names + avatars appear in the header, listening dashboard, and chat.

## 3. Portal fields (paste these)

| Field | Value |
|---|---|
| Short description | `24/7 continuous streaming of Psalms, worship & Scripture songs` |
| Long description | see below |
| Privacy Policy | `https://bible-songs.walusimbileon1.workers.dev/privacy` |
| Terms of Service | `https://bible-songs.walusimbileon1.workers.dev/terms` |

### Long description (~700 chars)

```
🎵 Bible Songs — 24/7 continuous worship streaming, right inside Discord.

Hit play and the stream never stops. Psalms, worship songs, Scripture-based
music from the SGSS open library — playing around the clock for you and your
server.

• Always on: songs flow one after another, non-stop, in sync with everyone
  in the channel.
• No pause, no skipping: the shared stream keeps the whole server together.
  Adjust volume or mute anytime.
• Fresh rotation: 200+ songs across Psalms, Worship, Christmas, English,
  Song of Solomon and more.
• See who's listening: a live dashboard shows every listener in the room.
• Chat with the room: send messages, reply to anyone, and @mention friends
  while the music plays.

Just launch Bible Songs in a voice channel, and the stream starts itself —
for minutes, hours, or all day. Perfect for prayer rooms, bible study
servers, fellowship calls, and quiet background worship.
```

## 4. Art assets (for portal uploads)

- Cover (512×512): `assets/bible-songs-cover.png`
- Banner (1408×768): `assets/bible-songs-banner.png`

Raw URLs (use these for the portal):
```
https://raw.githubusercontent.com/Walusimbi-Leon1/bible-songs/main/assets/bible-songs-cover.png
https://raw.githubusercontent.com/Walusimbi-Leon1/bible-songs/main/assets/bible-songs-banner.png
```

## 5. Test checklist (in Discord)

- [ ] Launch activity in a voice channel → Discord authorize prompt appears
- [ ] After authorize: your name/avatar shows in the top bar
- [ ] 3-2-1 countdown auto-runs → stream starts with NO button press
- [ ] Song auto-advances when it ends (never stops)
- [ ] No pause/skip controls — only 🔊 volume + mute
- [ ] Listening dashboard shows everyone in the channel + live count
- [ ] Open chat → send a message; others see it within ~3s
- [ ] Reply to a specific message (↩) → shows "Replying to X: …"
- [ ] @mention a listener → chip renders in the message
- [ ] Relaunch → same rotation continues, presence updates
- [ ] Privacy / Terms links work in-window
- [ ] 💛 Support Developer opens donate page in browser (Discord trust prompt)
