'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YTDLP_BUFFER_SIZE = 16 * 1024 * 1024;
const PLAYBACK_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_COOKIES_FILES = [
  '/app/data/youtube-cookies.txt',
  path.join(process.cwd(), 'data', 'youtube-cookies.txt'),
];
const DEFAULT_PLUGIN_DIRS = [
  '/opt/yt-dlp-plugins',
  path.join(process.cwd(), 'yt-dlp-plugins'),
];
const playbackCache = new Map();

function resolveYtDlpPath() {
  if (process.env.YTDLP_PATH) {
    return process.env.YTDLP_PATH;
  }
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

function normaliseUrl(value) {
  try {
    return new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
}

function isYouTubeHostUrl(value) {
  const parsed = normaliseUrl(value);
  if (!parsed) return false;

  const host = parsed.hostname.toLowerCase();
  return (
    host === 'youtu.be' ||
    host.endsWith('.youtu.be') ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com')
  );
}

function extractVideoId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (VIDEO_ID_RE.test(raw)) return raw;

  const parsed = normaliseUrl(raw);
  if (!parsed || !isYouTubeHostUrl(raw)) return null;

  const host = parsed.hostname.toLowerCase();
  let videoId = null;

  if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
    videoId = parsed.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (parsed.pathname === '/watch') {
    videoId = parsed.searchParams.get('v');
  } else {
    const match = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/i);
    videoId = match?.[1] ?? null;
  }

  return VIDEO_ID_RE.test(videoId ?? '') ? videoId : null;
}

function isYouTubeUrl(value) {
  return Boolean(extractVideoId(value));
}

function buildWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function getEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getYtDlpArgs() {
  const args = [];
  const pluginDir = resolvePluginDir();
  if (pluginDir) {
    args.push('--plugin-dirs', pluginDir);
  }

  const cookiesFile = resolveCookiesFile();
  if (cookiesFile) {
    args.push('--cookies', cookiesFile);
  }

  const userAgent = getEnv('YTDLP_USER_AGENT');
  if (userAgent) {
    args.push('--user-agent', userAgent);
  }

  const jsRuntimes = getEnv('YTDLP_JS_RUNTIMES');
  if (jsRuntimes) {
    args.push('--js-runtimes', jsRuntimes);
  }

  const extractorArgs = getExtractorArgs();
  for (const value of extractorArgs) {
    args.push('--extractor-args', value);
  }

  return args;
}

function getExtractorArgs() {
  const raw = getEnv('YTDLP_EXTRACTOR_ARGS');
  if (!raw) return [];

  return raw
    .split('||')
    .map(value => value.trim())
    .filter(Boolean);
}

function resolvePluginDir() {
  const configured = getEnv('YTDLP_PLUGIN_DIR');
  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new Error(`Configured YTDLP_PLUGIN_DIR was not found: ${configured}`);
    }
    return configured;
  }

  for (const candidate of DEFAULT_PLUGIN_DIRS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveCookiesFile() {
  const configured = getEnv('YTDLP_COOKIES_FILE');
  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new Error(`Configured YTDLP_COOKIES_FILE was not found: ${configured}`);
    }
    return configured;
  }

  for (const candidate of DEFAULT_COOKIES_FILES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildAuthGuidance(rawError) {
  const details = String(rawError ?? '');
  if (!/sign in to confirm/i.test(details)) {
    return null;
  }

  const cookiesFile = getEnv('YTDLP_COOKIES_FILE');
  if (cookiesFile) {
    return [
      'YouTube blocked this request even with the configured cookies.',
      'Refresh the cookies export, update YTDLP_USER_AGENT if needed, or add YTDLP_EXTRACTOR_ARGS with a YouTube PO token.',
    ].join(' ');
  }

  return [
    'YouTube now requires authenticated yt-dlp requests for this server.',
    'Set YTDLP_COOKIES_FILE to a fresh YouTube cookies.txt export, for example /app/data/youtube-cookies.txt inside Docker.',
  ].join(' ');
}

function buildFormatGuidance(rawError) {
  const details = String(rawError ?? '');
  if (!/requested format is not available/i.test(details)) {
    return null;
  }

  return [
    'YouTube did not expose any playable audio formats for this request.',
    'If cookies are already configured, use a PO Token provider and an mweb player_client via YTDLP_EXTRACTOR_ARGS.',
  ].join(' ');
}

async function runYtDlp(args) {
  try {
    const { stdout, stderr } = await execFileAsync(resolveYtDlpPath(), [
      ...getYtDlpArgs(),
      ...args,
    ], {
      windowsHide: true,
      maxBuffer: YTDLP_BUFFER_SIZE,
    });
    return {
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error('yt-dlp was not found. Install yt-dlp or set YTDLP_PATH.');
    }

    const details = [err?.stderr, err?.stdout, err?.message]
      .filter(Boolean)
      .join('\n')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);

    const fallback = details.at(-1) ?? 'yt-dlp failed.';
    const guidance = buildAuthGuidance(details.join('\n'));
    if (guidance) {
      throw new Error(`${guidance} Original error: ${fallback}`);
    }

    const formatGuidance = buildFormatGuidance(details.join('\n'));
    if (formatGuidance) {
      throw new Error(`${formatGuidance} Original error: ${fallback}`);
    }

    throw new Error(fallback);
  }
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }

  throw new Error('yt-dlp did not return valid JSON.');
}

function pickThumbnail(info) {
  if (info?.thumbnail) return info.thumbnail;
  if (!Array.isArray(info?.thumbnails)) return '';

  for (let i = info.thumbnails.length - 1; i >= 0; i--) {
    const url = info.thumbnails[i]?.url;
    if (url) return url;
  }

  return '';
}

function pickArtist(info) {
  return (
    info?.artist ||
    info?.channel ||
    info?.uploader ||
    info?.creator ||
    'YouTube'
  );
}

function sanitiseHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;

  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'undefined' || value === null || value === '') continue;
    result[name] = String(value);
  }

  return Object.keys(result).length ? result : null;
}

function pickRequestedDownload(info) {
  const requestedDownloads = Array.isArray(info?.requested_downloads) ? info.requested_downloads : [];
  for (const item of requestedDownloads) {
    if (item?.url) return item;
  }

  const requestedFormats = Array.isArray(info?.requested_formats) ? info.requested_formats : [];
  for (const item of requestedFormats) {
    if (item?.url) return item;
  }

  if (info?.url) return info;

  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const audioFormats = formats.filter(format => format?.url && format.vcodec === 'none');
  audioFormats.sort((a, b) => (Number(b?.abr) || 0) - (Number(a?.abr) || 0));
  return audioFormats[0] ?? null;
}

function getCachedPlayback(videoId) {
  const cached = playbackCache.get(videoId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    playbackCache.delete(videoId);
    return null;
  }
  return {
    url: cached.url,
    headers: cached.headers,
  };
}

function setCachedPlayback(videoId, source) {
  playbackCache.set(videoId, {
    url: source.url,
    headers: source.headers ?? null,
    expiresAt: Date.now() + PLAYBACK_CACHE_TTL_MS,
  });
}

async function resolveVideo(query, requestedBy = null) {
  const videoId = extractVideoId(query);
  if (!videoId) {
    throw new Error('Only direct YouTube video URLs are supported.');
  }

  const { stdout } = await runYtDlp([
    '--no-playlist',
    '--no-warnings',
    '--dump-single-json',
    buildWatchUrl(videoId),
  ]);

  const info = parseLastJsonLine(stdout);
  const duration = Number(info?.duration) || 0;

  return [{
    id: info?.id || videoId,
    title: info?.title || `YouTube video ${videoId}`,
    artist: pickArtist(info),
    album: info?.channel || '',
    albumId: null,
    duration,
    durationFormatted: info?.is_live ? 'LIVE' : formatDuration(duration),
    thumbnail: pickThumbnail(info),
    coverUuid: '',
    trackNumber: null,
    allowStreaming: true,
    source: 'youtube',
    url: info?.webpage_url || buildWatchUrl(videoId),
    monochromeUrl: '',
    requestedBy,
  }];
}

async function getPlaybackSource(value) {
  const videoId = extractVideoId(value);
  if (!videoId) {
    throw new Error('Invalid YouTube video identifier.');
  }

  const cached = getCachedPlayback(videoId);
  if (cached) {
    return cached;
  }

  const { stdout } = await runYtDlp([
    '--no-playlist',
    '--no-warnings',
    '--dump-single-json',
    '--format',
    'bestaudio[acodec!=none]/bestaudio/best[acodec!=none]/best',
    buildWatchUrl(videoId),
  ]);

  const info = parseLastJsonLine(stdout);
  const selected = pickRequestedDownload(info);
  if (!selected?.url) {
    throw new Error('yt-dlp did not return a playable audio URL.');
  }

  const source = {
    url: selected.url,
    headers: sanitiseHeaders(selected.http_headers || info.http_headers),
  };

  setCachedPlayback(videoId, source);
  return source;
}

async function getPlaybackUrl(value) {
  const source = await getPlaybackSource(value);
  return source.url;
}

module.exports = {
  extractVideoId,
  getPlaybackSource,
  getPlaybackUrl,
  isYouTubeHostUrl,
  isYouTubeUrl,
  resolveVideo,
};
