# HiFiBot

A Discord music bot that streams from the TIDAL catalog through the Hi-Fi API used by Monochrome.

Streaming path:

```text
User -> Discord bot -> Hi-Fi API (/track/) -> TIDAL CDN -> ffmpeg -> Discord voice
```

## Features

| Category | Features |
|---|---|
| Streaming | TIDAL catalog playback through the Hi-Fi API, plus direct YouTube video URL playback |
| Sources | TIDAL URLs, Monochrome share URLs, YouTube video URLs, plain text search |
| Queue | Add, insert, remove, move, clear, shuffle |
| Playback | Play, pause, resume, skip, stop, seek |
| Modes | Repeat (off/track/queue), autoplay |
| Lyrics | Hi-Fi/TIDAL lyrics first, Genius fallback |
| Downloads | Monochrome lossless track links without Discord upload limits |
| Instances | Multiple API instances with failover |

## Setup

Prerequisites:

- Node.js 22.12+
- `ffmpeg` available on the system, or provided by `ffmpeg-static`
- `yt-dlp` available on the system `PATH` for direct YouTube URL playback, or set via `YTDLP_PATH`

Install:

```bash
npm install
```

Configure `.env`:

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
GENIUS_ACCESS_TOKEN=optional
DEFAULT_VOLUME=80
MAX_QUEUE_SIZE=500
ALONE_TIMEOUT=30
IDLE_TIMEOUT=300
YTDLP_PATH=
```

Deploy slash commands:

```bash
npm run deploy
```

Start the bot:

```bash
npm start
```

## Commands

Playback:

- `/play <query>` -> supports TIDAL, Monochrome, plain text, and direct YouTube video URLs
- `/insert <query> [position]`
- `/search <query>`
- `/pause`
- `/resume`
- `/skip [count]`
- `/stop`
- `/seek <time>`
- `/nowplaying`
- `/volume <0-100>`

Queue:

- `/queue [page]`
- `/remove <position>`
- `/move <from> <to>`
- `/clear`
- `/shuffle`
- `/repeat <off|track|queue>`
- `/autoplay`

Music tools:

- `/lyrics [song]`
- `/download [query]` -> returns Monochrome and TIDAL links for the requested track

Notes:

- YouTube support is URL-only. Plain text search still resolves through the Hi-Fi / TIDAL path.
- Playlist and channel YouTube URLs are not supported. Use a direct video URL.

Connection and API:

- `/join`
- `/leave`
- `/instances list`
- `/instances add <url>` -> adds a custom API instance for the current server
- `/instances reset` -> restores the default API instance order for the current server
- `/help`

## Download Behavior

`/download` no longer uploads MP3 files back to Discord.

Instead it:

1. Resolves the requested track.
2. Builds the canonical `https://monochrome.tf/track/<id>` link.
3. Returns link buttons for Monochrome and TIDAL.

This avoids Discord's attachment size cap and preserves access to the original-quality source.

## Default API Instances

- `https://api.monochrome.tf`
- `https://triton.squid.wtf`
- `https://vogel.qqdl.site`
- `https://katze.qqdl.site`
- `https://hund.qqdl.site`
- `https://wolf.qqdl.site`
- `https://maus.qqdl.site`
- `https://hifi.p1nkhamster.xyz`
- `https://arran.monochrome.tf`
- `https://eu-central.monochrome.tf`
- `https://us-west.monochrome.tf`
- `https://monochrome-api.samidy.com`

## Project Structure

```text
index.js
deploy-commands.js
package.json
src/
  commands.js
  download.js
  embeds.js
  hifi.js
  lyrics.js
  player.js
  search.js
  youtube.js
```
