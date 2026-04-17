'use strict';

/**
 * hifi.js — Client for the Hi-Fi API (the backend powering Monochrome).
 *
 * Official instance:  https://api.monochrome.tf
 * Community mirrors: https://monochrome-api.samidy.com
 *                    https://wolf.qqdl.site
 *                    https://maus.qqdl.site
 *                    https://hifi.geeked.wtf
 *
 * All endpoints are unauthenticated GET requests.
 * The API proxies TIDAL's catalog — search, metadata, stream URLs, lyrics, covers.
 */

const axios = require('axios');

// ─── API Instances (tried in order, first healthy one wins) ───────────────────
const DEFAULT_INSTANCES = [
  'https://triton.squid.wtf',
  'https://vogel.qqdl.site',
  'https://katze.qqdl.site',
  'https://hund.qqdl.site',
  'https://wolf.qqdl.site',
  'https://maus.qqdl.site',
  'https://hifi.p1nkhamster.xyz',
  'https://arran.monochrome.tf',
  'https://eu-central.monochrome.tf',
  'https://us-west.monochrome.tf',
  'https://api.monochrome.tf',
  'https://monochrome-api.samidy.com',
];

const DEFAULT_SCOPE = '__default__';
const scopeStates = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── HTTP client ─────────────────────────────────────────────────────────────

/**
 * Make a GET request to the Hi-Fi API, with automatic failover across instances.
 * @param {string} path   e.g. '/search'
 * @param {object} params query string params
 * @returns {Promise<any>} parsed JSON response body
 */
async function get(path, params = {}, scope = null) {
  const state = getScopeState(scope);
  const cacheKey = path + '?' + new URLSearchParams(params).toString();
  const cached   = state.cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  let lastErr;
  // Try every instance starting from currentIndex, wrap around
  for (let attempt = 0; attempt < state.instances.length; attempt++) {
    const idx  = (state.currentIndex + attempt) % state.instances.length;
    const base = state.instances[idx];
    try {
      const resp = await axios.get(base + path, {
        params,
        timeout: 12_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HiFiBot/1.0)',
          'Origin':     'https://monochrome.tf',
          'Referer':    'https://monochrome.tf/',
        },
      });

      // Mark this instance as working
      state.currentIndex = idx;

      const data = resp.data;
      state.cache.set(cacheKey, { data, ts: Date.now() });
      return data;

    } catch (err) {
      lastErr = err;
      console.warn(`[HiFi] Instance ${base} failed (${err.response?.status ?? err.code}), trying next…`);
    }
  }

  throw new Error(`All Hi-Fi API instances failed. Last error: ${lastErr?.message}`);
}

/** Bypass cache — used for stream manifests (they expire quickly) */
async function getNoCache(path, params = {}, scope = null) {
  const state = getScopeState(scope);
  let lastErr;
  for (let attempt = 0; attempt < state.instances.length; attempt++) {
    const idx  = (state.currentIndex + attempt) % state.instances.length;
    const base = state.instances[idx];
    try {
      const resp = await axios.get(base + path, {
        params,
        timeout: 15_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HiFiBot/1.0)',
          'Origin':     'https://monochrome.tf',
          'Referer':    'https://monochrome.tf/',
        },
      });
      state.currentIndex = idx;
      return resp.data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`All Hi-Fi API instances failed. Last error: ${lastErr?.message}`);
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * Search for tracks, albums, and artists.
 * @returns {{ tracks: TrackItem[], albums: AlbumItem[], artists: ArtistItem[] }}
 */
async function search(query, limit = 10, scope = null) {
  const [tracksResp, artistsResp, albumsResp] = await Promise.allSettled([
    get('/search', { s: query }, scope),
    get('/search', { a: query }, scope),
    get('/search', { al: query }, scope),
  ]);

  const trackData  = getSettledValue(tracksResp);
  const artistData = getSettledValue(artistsResp);
  const albumData  = getSettledValue(albumsResp);

  const trackItems = extractSearchItems(trackData, ['tracks', 'items']);
  const artistItems = extractSearchItems(artistData, ['artists', 'items']);
  const albumItems = extractSearchItems(albumData, ['albums', 'items']);

  if (!trackItems.length && !artistItems.length && !albumItems.length) {
    throw buildSearchError([tracksResp, artistsResp, albumsResp]);
  }

  return {
    tracks:  trackItems.map(normaliseTrackItem).filter(Boolean).slice(0, limit),
    albums:  albumItems.map(normaliseAlbumItem).filter(Boolean).slice(0, limit),
    artists: artistItems.map(normaliseArtistItem).filter(Boolean).slice(0, limit),
  };
}

/**
 * Fetch full track metadata.
 * @param {number|string} id  TIDAL track ID
 * @returns {TrackInfo}
 */
async function track(id, scope = null) {
  try {
    const data = await get('/track/', { id }, scope);
    const d = data?.data ?? data;
    const candidate = extractTrackMetadata(d);
    if (candidate) {
      return normaliseTrack(candidate);
    }
  } catch {}

  return normaliseTrack({
    id,
    title: `Track ${id}`,
    artist: 'Unknown',
    url: `https://tidal.com/browse/track/${id}`,
  });
}

/**
 * Fetch stream URL(s) for a track.
 * Returns an array of direct CDN URLs (FLAC / AAC / MP3).
 * @param {number|string} id  TIDAL track ID
 * @returns {string[]}
 */
async function trackManifests(id, scope = null) {
  const data = await getNoCache('/track/', { id, quality: 'LOSSLESS' }, scope);
  const d = data?.data ?? data;

  const directUrls = [
    ...(Array.isArray(d) ? d : []),
    ...(Array.isArray(d?.urls) ? d.urls : []),
    ...(Array.isArray(d?.data?.urls) ? d.data.urls : []),
    ...(typeof d?.url === 'string' ? [d.url] : []),
    ...(typeof d?.originalTrackUrl === 'string' ? [d.originalTrackUrl] : []),
    ...(typeof d?.OriginalTrackUrl === 'string' ? [d.OriginalTrackUrl] : []),
  ].filter(url => typeof url === 'string' && /^https?:\/\//i.test(url));

  if (directUrls.length > 0) {
    return directUrls;
  }

  const manifestValue = d?.manifest ?? d?.dashManifest ?? d?.hlsManifest ?? null;
  if (typeof manifestValue === 'string' && manifestValue.trim()) {
    let manifestText = manifestValue.trim();

    const decodedManifest = maybeDecodeManifest(manifestText);
    if (decodedManifest) {
      manifestText = decodedManifest;
    }

    try {
      const parsed = JSON.parse(manifestText);
      const parsedUrls = [
        ...(Array.isArray(parsed) ? parsed : []),
        ...(Array.isArray(parsed?.urls) ? parsed.urls : []),
        ...(typeof parsed?.url === 'string' ? [parsed.url] : []),
      ].filter(url => typeof url === 'string' && /^https?:\/\//i.test(url));
      if (parsedUrls.length > 0) return parsedUrls;
    } catch {
      // Not JSON; continue with text/XML parsing.
    }

    const baseUrls = [...manifestText.matchAll(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi)]
      .map(m => m[1].trim())
      .filter(Boolean);
    if (baseUrls.length > 0) return baseUrls;

    const textUrls = [...manifestText.matchAll(/https?:\/\/[^\s"'<>]+/gi)]
      .map(m => m[0].trim())
      .filter(Boolean);
    if (textUrls.length > 0) return textUrls;
  }

  throw new Error(`No stream URLs found for track ${id}`);
}

/**
 * Fetch album metadata + track listing.
 * @returns {{ info: AlbumInfo, tracks: TrackInfo[] }}
 */
async function album(id, scope = null) {
  const data = await get('/album/', { id }, scope);
  const d    = data?.data ?? data;
  return {
    info:   normaliseAlbumItem(d),
    tracks: (d?.tracks?.items ?? d?.items ?? []).map(i => normaliseTrack(i?.track ?? i?.item ?? i)).filter(Boolean),
  };
}

/**
 * Fetch artist info + top tracks.
 * @returns {{ info: ArtistInfo, topTracks: TrackInfo[] }}
 */
async function artist(id, scope = null) {
  const [detailData, contentData] = await Promise.all([
    get('/artist/', { id }, scope),
    get('/artist/', { f: id }, scope).catch(() => null),
  ]);

  const d = detailData?.artist ?? detailData?.data ?? detailData;
  return {
    info:      normaliseArtistItem(d),
    topTracks: extractArtistTracks(contentData),
  };
}

/**
 * Similar artists for a given artist ID.
 * @returns {ArtistInfo[]}
 */
async function similarArtists(id, scope = null) {
  const data = await get('/artist/similar', { id }, scope);
  const d    = data?.data ?? data;
  return (d?.items ?? d ?? []).map(normaliseArtistItem);
}

/**
 * Track recommendations (for autoplay).
 * @returns {TrackInfo[]}
 */
async function recommendations(id, scope = null) {
  const data = await get('/recommendations', { id }, scope);
  const d    = data?.data ?? data;
  return (d?.items ?? []).map(i => normaliseTrack(i?.track ?? i));
}

/**
 * Fetch a radio mix for a track (infinite recommendation radio).
 * @returns {TrackInfo[]}
 */
async function mix(id, scope = null) {
  const data = await get('/mix', { id }, scope);
  const d    = data?.data ?? data;
  return (d?.tracks?.items ?? d?.items ?? []).map(i => normaliseTrack(i?.track ?? i));
}

/**
 * Fetch playlist tracks by UUID.
 * @returns {TrackInfo[]}
 */
async function playlist(id, scope = null) {
  const data = await get('/playlist/', { id }, scope);
  const d    = data?.data ?? data;
  return (d?.tracks?.items ?? d?.items ?? []).map(i => normaliseTrack(i?.track ?? i)).filter(Boolean);
}

/**
 * @returns {{ lyrics: string, subtitles: string | null } | null}
 */
async function lyrics(id, scope = null) {
  try {
    const data = await get('/lyrics', { id }, scope);
    const d    = data?.data ?? data;
    const payload = d?.lyrics && typeof d.lyrics === 'object' ? d.lyrics : d;
    return {
      lyrics:    typeof payload?.lyrics === 'string' ? payload.lyrics : null,
      subtitles: typeof payload?.subtitles === 'string' ? payload.subtitles : null,
    };
  } catch {
    return null;
  }
}

/**
 * Get the cover art URL for an album.
 * Uses TIDAL's CDN directly — no API call needed.
 * @param {string} coverUuid  e.g. "0948decd-5591-4b83-b188-8314bfbe7fd3"
 * @param {number} size       Image size (80, 160, 320, 640, 1280)
 */
function coverUrl(coverUuid, size = 320) {
  if (!coverUuid) return '';
  // TIDAL CDN: replace dashes with slashes in the UUID path
  const path = coverUuid.replace(/-/g, '/');
  return `https://resources.tidal.com/images/${path}/${size}x${size}.jpg`;
}

function monochromeUrl(id, type = 'track') {
  if (!id) return '';
  return `https://monochrome.tf/${type}/${id}`;
}

// ─── Instance management ──────────────────────────────────────────────────────

function setInstances(urls, scope = null) {
  if (Array.isArray(urls) && urls.length > 0) {
    const state = getScopeState(scope);
    state.instances = [...urls];
    state.currentIndex = 0;
    clearCache(scope);
  }
}

function getInstances(scope = null) {
  const state = getScopeState(scope);
  return state.instances.map((url, i) => ({ url, active: i === state.currentIndex }));
}

function resetInstances(scope = null) {
  const state = getScopeState(scope);
  state.instances = [...DEFAULT_INSTANCES];
  state.currentIndex = 0;
  clearCache(scope);
}

function clearCache(scope = null) {
  const state = getScopeState(scope);
  state.cache.clear();
}

function getScopeState(scope = null) {
  const key = scope == null ? DEFAULT_SCOPE : String(scope);
  if (!scopeStates.has(key)) {
    scopeStates.set(key, {
      instances: [...DEFAULT_INSTANCES],
      currentIndex: 0,
      cache: new Map(),
    });
  }
  return scopeStates.get(key);
}

function extractTrackMetadata(value) {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (looksLikeTrackMetadata(entry)) {
      return entry;
    }
    if (looksLikeTrackMetadata(entry?.track)) {
      return entry.track;
    }
    if (looksLikeTrackMetadata(entry?.item)) {
      return entry.item;
    }
  }
  return null;
}

function looksLikeTrackMetadata(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.id !== 'undefined'
    && (typeof value.title === 'string' || typeof value.duration === 'number')
    && (value.artist || value.artists || value.album),
  );
}

function extractArtistTracks(payload) {
  const d = payload?.data ?? payload;
  const trackMap = new Map();

  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const candidate = value.item ?? value.track ?? value;
    if (looksLikeTrackMetadata(candidate)) {
      trackMap.set(candidate.id, normaliseTrack(candidate));
    }

    for (const nested of Object.values(value)) {
      visit(nested);
    }
  };

  visit(d);
  return Array.from(trackMap.values())
    .filter(Boolean)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, 10);
}

function getSettledValue(result) {
  return result?.status === 'fulfilled' ? result.value : null;
}

function extractSearchItems(payload, path) {
  const d = payload?.data ?? payload;
  if (!d) return [];

  let current = d;
  for (const key of path) {
    current = current?.[key];
    if (current == null) break;
  }

  if (Array.isArray(current)) {
    return current;
  }

  if (Array.isArray(d?.items)) {
    return d.items;
  }

  return [];
}

function buildSearchError(results) {
  const rejected = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason)
    .filter(Boolean);

  if (rejected.length === 0) {
    return new Error('No search results returned from the Hi-Fi API.');
  }

  return rejected[0] instanceof Error
    ? rejected[0]
    : new Error(String(rejected[0]));
}

// ─── Normalisation helpers ────────────────────────────────────────────────────
// Convert raw API shapes into a consistent TrackInfo / AlbumInfo / ArtistInfo
// regardless of which API version or instance responded.

function normaliseTrackItem(item) {
  // Search results wrap the track: { item: { id, type, track: {...} } } or just { track: {...} }
  const t = item?.track ?? item?.item?.track ?? item;
  return normaliseTrack(t);
}

/**
 * @typedef {object} TrackInfo
 * @property {number}  id
 * @property {string}  title
 * @property {string}  artist
 * @property {string}  album
 * @property {number}  duration    seconds
 * @property {string}  durationFormatted
 * @property {string}  thumbnail   cover art URL
 * @property {string}  coverUuid
 * @property {string}  source      'tidal'
 * @property {string|null} requestedBy
 * @property {number}  trackNumber
 * @property {boolean} allowStreaming
 */
function normaliseTrack(t) {
  if (!t) return null;

  // Artists can be an array or a single object
  const artistName = Array.isArray(t.artists)
    ? t.artists.map(a => a?.name ?? a).filter(Boolean).join(', ')
    : (t.artist?.name ?? t.artist ?? 'Unknown');

  const coverUuid = t.album?.cover ?? t.cover ?? '';
  const dur       = t.duration ?? 0;

  return {
    id:                t.id,
    title:             t.title             ?? 'Unknown',
    artist:            artistName          || 'Unknown',
    album:             t.album?.title      ?? t.album ?? '',
    albumId:           t.album?.id         ?? null,
    duration:          dur,
    durationFormatted: formatTime(dur),
    thumbnail:         coverUrl(coverUuid, 320),
    coverUuid,
    trackNumber:       t.trackNumber       ?? null,
    allowStreaming:    t.allowStreaming     ?? t.streamReady ?? true,
    source:            'tidal',
    url:               t.url               ?? `https://tidal.com/browse/track/${t.id}`,
    monochromeUrl:     monochromeUrl(t.id, 'track'),
    requestedBy:       null,
  };
}

function maybeDecodeManifest(value) {
  if (!looksLikeBase64(value)) return null;

  const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
  return looksLikeManifest(decoded) ? decoded : null;
}

function looksLikeBase64(value) {
  return value.length >= 16
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/=]+$/.test(value);
}

function looksLikeManifest(value) {
  return /^(https?:\/\/|<\?xml|<MPD|<BaseURL|[{[])/i.test(value);
}

function normaliseAlbumItem(a) {
  if (!a) return null;
  const artistName = Array.isArray(a.artists)
    ? a.artists.map(x => x?.name).filter(Boolean).join(', ')
    : (a.artist?.name ?? '');
  return {
    id:         a.id,
    title:      a.title     ?? 'Unknown',
    artist:     artistName  || 'Unknown',
    coverUuid:  a.cover     ?? '',
    thumbnail:  coverUrl(a.cover ?? '', 320),
    numTracks:  a.numberOfTracks ?? null,
    releaseDate:a.releaseDate    ?? null,
    url:        `https://tidal.com/browse/album/${a.id}`,
  };
}

function normaliseArtistItem(a) {
  if (!a) return null;
  return {
    id:        a.id,
    name:      a.name      ?? 'Unknown',
    thumbnail: coverUrl(a.picture ?? '', 320),
    url:       `https://tidal.com/browse/artist/${a.id}`,
  };
}

function formatTime(s) {
  s = Math.round(s);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

module.exports = {
  search,
  track,
  trackManifests,
  album,
  artist,
  playlist,
  similarArtists,
  recommendations,
  mix,
  lyrics,
  coverUrl,
  monochromeUrl,
  setInstances,
  getInstances,
  resetInstances,
  clearCache,
  normaliseTrack,
};
