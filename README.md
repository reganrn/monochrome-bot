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
| Playback | Play, pause, resume, skip, stop, seek (TIDAL only for seek) |
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
YTDLP_COOKIES_FILE=
YTDLP_USER_AGENT=
YTDLP_PLUGIN_DIR=/opt/yt-dlp-plugins
YTDLP_JS_RUNTIMES=node
YTDLP_EXTRACTOR_ARGS=youtube:player_client=mweb||youtubepot-bgutilhttp:base_url=http://bgutil-provider:4416
```

For Docker deployments, the bot automatically checks `./data/youtube-cookies.txt` on the host through the existing `/app/data` volume mount.
Set `YTDLP_COOKIES_FILE` only if you want to use a different cookies path.
The provided `docker-compose.yml` starts a `bgutil-provider` sidecar and the bot image includes the matching yt-dlp plugin zip, so the default `YTDLP_EXTRACTOR_ARGS` uses `mweb` with that provider automatically.
Set `YTDLP_JS_RUNTIMES=node` so yt-dlp enables Node for YouTube's EJS challenge solving inside the container.
When passing multiple `--extractor-args` entries through `YTDLP_EXTRACTOR_ARGS`, separate full entries with `||`.
If you need a different provider endpoint or client selection, override `YTDLP_EXTRACTOR_ARGS`.

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
- Direct YouTube playback requires a fresh `cookies.txt` export and may also require the PO token provider configuration above.
- `/seek` is currently only supported for TIDAL / Monochrome tracks.

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
