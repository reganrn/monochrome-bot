'use strict';

const hifi = require('./hifi');

/**
 * Resolve a user query into an array of TrackInfo objects.
 * Supports:
 *   - TIDAL track/album/artist URL  → fetched directly via Hi-Fi API
 *   - Monochrome share URL          → same
 *   - Plain text search             → Hi-Fi /search top result
 *
 * @param {string} query
 * @param {string} requestedBy - Discord username
 * @returns {Promise<TrackInfo[]>}
 */
async function resolve(query, requestedBy = null, scope = null) {
  const q = query.trim();

  // ── TIDAL track URL ─────────────────────────────────────────────────────────
  const tidalTrack = q.match(/tidal\.com\/(?:browse\/)?track\/(\d+)/i);
  if (tidalTrack) {
    const t = await hifi.track(tidalTrack[1], scope);
    if (!t) throw new Error('Track not found.');
    t.requestedBy = requestedBy;
    return [t];
  }

  // ── TIDAL album URL ─────────────────────────────────────────────────────────
  const tidalAlbum = q.match(/tidal\.com\/(?:browse\/)?album\/(\d+)/i);
  if (tidalAlbum) {
    const { tracks } = await hifi.album(tidalAlbum[1], scope);
    tracks.forEach(t => { if (t) t.requestedBy = requestedBy; });
    return tracks.filter(Boolean);
  }

  // ── TIDAL artist URL ────────────────────────────────────────────────────────
  const tidalArtist = q.match(/tidal\.com\/(?:browse\/)?artist\/(\d+)/i);
  if (tidalArtist) {
    const { topTracks } = await hifi.artist(tidalArtist[1], scope);
    topTracks.forEach(t => { if (t) t.requestedBy = requestedBy; });
    return topTracks.filter(Boolean);
  }

  // ── TIDAL playlist URL ──────────────────────────────────────────────────────
  const tidalPlaylist = q.match(/tidal\.com\/(?:browse\/)?playlist\/([\w-]+)/i);
  if (tidalPlaylist) {
    const tracks = await hifi.playlist(tidalPlaylist[1], scope).catch(() => []);
    if (tracks.length) {
      tracks.forEach(t => { if (t) t.requestedBy = requestedBy; });
      return tracks.filter(Boolean);
    }
    throw new Error('Could not fetch that playlist. Try a track or album URL.');
  }

  // ── Monochrome share URLs ───────────────────────────────────────────────────
  const monoTrack = q.match(/monochrome\.(?:tf|samidy\.com)\/(?:track|song)\/(\d+)/i);
  if (monoTrack) {
    const t = await hifi.track(monoTrack[1], scope);
    if (!t) throw new Error('Track not found.');
    t.requestedBy = requestedBy;
    return [t];
  }

  const monoAlbum = q.match(/monochrome\.(?:tf|samidy\.com)\/album\/(\d+)/i);
  if (monoAlbum) {
    const { tracks } = await hifi.album(monoAlbum[1], scope);
    tracks.forEach(t => { if (t) t.requestedBy = requestedBy; });
    return tracks.filter(Boolean);
  }

  // ── Plain text → Hi-Fi search ───────────────────────────────────────────────
  const results = await hifi.search(q, 1, scope);
  if (!results.tracks.length) throw new Error(`No results found for: \`${q}\``);
  const t = results.tracks[0];
  t.requestedBy = requestedBy;
  return [t];
}

/**
 * Return up to `limit` track search results (for /search command).
 * @returns {Promise<TrackInfo[]>}
 */
async function searchResults(query, limit = 10, scope = null) {
  const results = await hifi.search(query, limit, scope);
  return results.tracks.slice(0, limit);
}

module.exports = { resolve, searchResults };
