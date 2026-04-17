'use strict';

const axios = require('axios');
const hifi = require('./hifi');

let GeniusClient;
try { GeniusClient = require('genius-lyrics').Client; } catch {}

let geniusClient = null;
function getGenius() {
  if (!geniusClient && GeniusClient && process.env.GENIUS_ACCESS_TOKEN) {
    geniusClient = new GeniusClient(process.env.GENIUS_ACCESS_TOKEN);
  }
  return geniusClient;
}

/**
 * Fetch lyrics for a track.
 * Strategy:
 *   1. Hi-Fi API /lyrics endpoint (TIDAL's own synced lyrics, no key required)
 *   2. Genius API fallback (requires GENIUS_ACCESS_TOKEN)
 *
 * @param {number|string} trackId   TIDAL track ID (preferred)
 * @param {string}        title     Track title (for Genius fallback)
 * @param {string}        artist    Artist name (for Genius fallback)
 * @returns {Promise<{ lyrics: string, title: string, artist: string, url: string | null, synced: boolean } | null>}
 */
async function fetchLyrics(trackId, title = '', artist = '', scope = null) {
  const resolvedTitle = String(title ?? '').trim();
  const resolvedArtist = String(artist ?? '').trim();

  // ── 1. Hi-Fi / TIDAL built-in lyrics ───────────────────────────────────────
  if (trackId) {
    try {
      const result = await hifi.lyrics(trackId, scope);
      const tidalLyrics = result?.lyrics ?? result?.subtitles ?? '';
      if (tidalLyrics) {
        return {
          lyrics: cleanLrc(tidalLyrics),
          title: resolvedTitle,
          artist: resolvedArtist,
          url:    null,
          synced: Boolean(result.subtitles),
        };
      }
    } catch (err) {
      console.warn('[Lyrics] Hi-Fi lyrics error:', err.message);
    }
  }

  // ── 2. LRCLIB fallback ──────────────────────────────────────────────────────
  const lrcLibResult = await fetchFromLrcLib(resolvedTitle, resolvedArtist);
  if (lrcLibResult) return lrcLibResult;

  // ── 3. lyrics.ovh fallback ──────────────────────────────────────────────────
  const lyricsOvhResult = await fetchFromLyricsOvh(resolvedTitle, resolvedArtist);
  if (lyricsOvhResult) return lyricsOvhResult;

  // ── 4. Genius fallback ──────────────────────────────────────────────────────
  const genius = getGenius();
  if (!genius || !resolvedTitle) return null;

  const query = resolvedArtist ? `${resolvedArtist} ${resolvedTitle}` : resolvedTitle;
  try {
    const searches = await genius.songs.search(query);
    if (!searches?.length) return null;
    const song   = searches[0];
    const lyrics = await song.lyrics();
    if (!lyrics?.trim()) return null;
    return {
      lyrics: cleanLyrics(lyrics),
      title:  song.title        ?? resolvedTitle,
      artist: song.artist?.name ?? resolvedArtist,
      url:    song.url,
      synced: false,
    };
  } catch (err) {
    console.error('[Lyrics] Genius error:', err.message);
    return null;
  }
}

async function fetchFromLrcLib(title, artist) {
  if (!title || !artist) return null;

  try {
    const result = await axios.get('https://lrclib.net/api/get', {
      params: {
        track_name: title,
        artist_name: artist,
      },
      timeout: 12_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HiFiBot/1.0)',
      },
    });

    const data = result?.data;
    const lyrics = data?.syncedLyrics || data?.plainLyrics || '';
    if (!lyrics) return null;

    return {
      lyrics: cleanLrc(lyrics),
      title: data?.trackName ?? title,
      artist: data?.artistName ?? artist,
      url: null,
      synced: Boolean(data?.syncedLyrics),
    };
  } catch (err) {
    console.warn('[Lyrics] LRCLIB error:', err.response?.status ?? err.message);
    return null;
  }
}

async function fetchFromLyricsOvh(title, artist) {
  if (!title || !artist) return null;

  try {
    const result = await axios.get(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
      {
        timeout: 12_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HiFiBot/1.0)',
        },
      },
    );

    const lyrics = String(result?.data?.lyrics ?? '').trim();
    if (!lyrics) return null;

    return {
      lyrics: cleanLyrics(lyrics),
      title,
      artist,
      url: null,
      synced: false,
    };
  } catch (err) {
    console.warn('[Lyrics] lyrics.ovh error:', err.response?.status ?? err.message);
    return null;
  }
}

// ─── Clean helpers ─────────────────────────────────────────────────────────

/** Strip LRC timestamps like [00:12.34] for plain display */
function cleanLrc(raw) {
  if (!raw) return '';
  return raw
    .replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanLyrics(raw) {
  if (!raw) return '';
  return raw
    .replace(/^\d+ Contributors?.*\n/gim, '')
    .replace(/\[(.+?)\]/g, '\n[$1]\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { fetchLyrics };
