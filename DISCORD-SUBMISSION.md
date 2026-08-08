# Bible Songs — Discord Developer Portal Kit

**Live URL:** https://bible-songs.walusimbileon1.workers.dev
**Repo:** https://github.com/Walusimbi-Leon1/bible-songs

## 1. Discord Application (waiting on Leon for client ID + secret)

Create the app in https://discord.com/developers/applications:

1. **New Application** → name it **Bible Songs** (or "Bible" — your call).
2. **General Information**:
   - Description (short, ≤100 chars): `24/7 continuous streaming of Psalms, worship & Scripture songs`
   - Tags: `music`, `streaming`
   - App icon: use `assets/bible-songs-cover.png` (once added)
3. **OAuth2 → General**:
   - Add redirect: `https://bible-songs.walusimbileon1.workers.dev/`
4. **Installation Contexts**: check **Guild Install** + **User Install**.
5. **Activities / Embedded App SDK** (left sidebar): enable **Activities**.
   - Entry point command auto-creates.
6. Send the **Client ID** + **Client Secret** to LA5.

## 2. Enable in the code (once creds arrive)

`src/discord.js`:
```js
const CLIENT_ID = "REPLACE_WITH_BIBLE_SONGS_CLIENT_ID";
```
→ replace with the real client ID. Then:

```bash
CF_API_TOKEN=... DISCORD_CLIENT_ID=<real> DISCORD_CLIENT_SECRET=<real> bash deploy.sh
```
(deploy.sh sets both as Worker secrets and redeploys.)

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

Just launch Bible Songs in a voice channel, tap start, and let the music
carry the room — for minutes, hours, or all day. Perfect for prayer rooms,
bible study servers, fellowship calls, and quiet background worship.

Volume controls are always available. The stream is served through
Cloudflare for fast, reliable playback everywhere.
```

## 4. Art assets (for portal uploads)

- Cover (512×512): `assets/bible-songs-cover.png` *(raw URL below)*
- Banner (1408×768): `assets/bible-songs-banner.png`

Raw URLs (use these for the portal):
```
https://raw.githubusercontent.com/Walusimbi-Leon1/bible-songs/main/assets/bible-songs-cover.png
https://raw.githubusercontent.com/Walusimbi-Leon1/bible-songs/main/assets/bible-songs-banner.png
```

## 5. Test checklist (after creds wired)

- [ ] Launch activity in a voice channel → Discord authorize prompt appears
- [ ] Tap **Start Listening** → audio begins (sandbox needs the gesture)
- [ ] Song auto-advances when it ends (never stops)
- [ ] No pause/skip controls visible — only 🔊 volume + mute
- [ ] Volume slider works; mute toggles
- [ ] Relaunch → same rotation continues
- [ ] Privacy / Terms links work in-window
- [ ] 💛 Support Developer opens donate page in browser (Discord trust prompt)
