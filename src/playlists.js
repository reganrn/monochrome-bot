'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'playlists.json');
const BACKUP_PATH = path.join(DATA_DIR, 'playlists.json.bak');
const MAX_PLAYLIST_NAME_LENGTH = 50;
const MAX_PLAYLISTS_PER_GUILD = 50;

function normalisePlaylistName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function getPlaylist(guildId, name) {
  const key = toPlaylistKey(name);
  if (!key) return null;

  const guildPlaylists = readStore().guilds?.[guildId] ?? {};
  return guildPlaylists[key] ?? null;
}

function listPlaylists(guildId) {
  const guildPlaylists = Object.values(readStore().guilds?.[guildId] ?? {});
  return guildPlaylists
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function createPlaylist(guildId, name, actor = {}) {
  const resolvedName = validatePlaylistName(name);
  const key = toPlaylistKey(resolvedName);
  const store = readStore();
  const guilds = store.guilds ?? {};
  const guildPlaylists = guilds[guildId] ?? {};

  if (guildPlaylists[key]) {
    throw new Error(`Playlist **${resolvedName}** already exists.`);
  }

  if (Object.keys(guildPlaylists).length >= MAX_PLAYLISTS_PER_GUILD) {
    throw new Error(`This server already has ${MAX_PLAYLISTS_PER_GUILD} saved playlists.`);
  }

  const playlist = buildPlaylistRecord(resolvedName, [], actor);
  guildPlaylists[key] = playlist;
  guilds[guildId] = guildPlaylists;
  store.guilds = guilds;
  writeStore(store);

  return playlist;
}

function addTrackToPlaylist(guildId, name, track, actor = {}) {
  const resolvedName = validatePlaylistName(name);
  const key = toPlaylistKey(resolvedName);
  const store = readStore();
  const guildPlaylists = store.guilds?.[guildId] ?? {};
  const existing = guildPlaylists[key];

  if (!existing) {
    throw new Error(`Playlist **${resolvedName}** was not found.`);
  }

  const serialisedTrack = serialiseTrack(track);
  if (!serialisedTrack) {
    throw new Error('That track could not be added to the playlist.');
  }

  const tracks = [...existing.tracks, serialisedTrack];
  const playlist = buildPlaylistRecord(existing.name, tracks, actor, existing);
  guildPlaylists[key] = playlist;
  writeStore(store);

  return playlist;
}

function savePlaylist(guildId, name, tracks, actor = {}) {
  const resolvedName = validatePlaylistName(name);
  const key = toPlaylistKey(resolvedName);

  const playlistTracks = (tracks ?? [])
    .map(serialiseTrack)
    .filter(Boolean);

  if (!playlistTracks.length) {
    throw new Error('There are no tracks to save.');
  }

  const store = readStore();
  const guilds = store.guilds ?? {};
  const guildPlaylists = guilds[guildId] ?? {};
  const now = new Date().toISOString();
  const existing = guildPlaylists[key] ?? null;

  if (!existing && Object.keys(guildPlaylists).length >= MAX_PLAYLISTS_PER_GUILD) {
    throw new Error(`This server already has ${MAX_PLAYLISTS_PER_GUILD} saved playlists.`);
  }

  const playlist = buildPlaylistRecord(resolvedName, playlistTracks, actor, existing);

  guildPlaylists[key] = playlist;
  guilds[guildId] = guildPlaylists;
  store.guilds = guilds;
  writeStore(store);

  return {
    created: !existing,
    playlist,
  };
}

function deletePlaylist(guildId, name) {
  const key = toPlaylistKey(name);
  if (!key) return null;

  const store = readStore();
  const guildPlaylists = store.guilds?.[guildId];
  if (!guildPlaylists?.[key]) return null;

  const removed = guildPlaylists[key];
  delete guildPlaylists[key];

  if (Object.keys(guildPlaylists).length === 0) {
    delete store.guilds[guildId];
  }

  writeStore(store);
  return removed;
}

function serialiseTrack(track) {
  if (!track?.id || !track?.title) return null;

  return {
    id: track.id,
    title: track.title,
    artist: track.artist ?? 'Unknown',
    album: track.album ?? '',
    albumId: track.albumId ?? null,
    duration: track.duration ?? 0,
    durationFormatted: track.durationFormatted ?? null,
    thumbnail: track.thumbnail ?? '',
    coverUuid: track.coverUuid ?? '',
    trackNumber: track.trackNumber ?? null,
    allowStreaming: track.allowStreaming !== false,
    source: track.source ?? 'tidal',
    url: track.url ?? '',
    monochromeUrl: track.monochromeUrl ?? '',
  };
}

function validatePlaylistName(name) {
  const resolvedName = normalisePlaylistName(name);
  if (!resolvedName) {
    throw new Error('Playlist name cannot be empty.');
  }
  if (resolvedName.length > MAX_PLAYLIST_NAME_LENGTH) {
    throw new Error(`Playlist names can be at most ${MAX_PLAYLIST_NAME_LENGTH} characters.`);
  }
  return resolvedName;
}

function buildPlaylistRecord(name, tracks, actor = {}, existing = null) {
  const now = new Date().toISOString();
  return {
    name,
    key: toPlaylistKey(name),
    tracks,
    trackCount: tracks.length,
    totalDuration: tracks.reduce((sum, track) => sum + (track.duration || 0), 0),
    createdAt: existing?.createdAt ?? now,
    createdByUserId: existing?.createdByUserId ?? actor.userId ?? null,
    createdByUsername: existing?.createdByUsername ?? actor.username ?? null,
    updatedAt: now,
    updatedByUserId: actor.userId ?? null,
    updatedByUsername: actor.username ?? null,
  };
}

function toPlaylistKey(name) {
  const resolvedName = normalisePlaylistName(name);
  return resolvedName.toLowerCase();
}

function readStore() {
  ensureDataDir();
  return readStoreFile(STORE_PATH) ?? readStoreFile(BACKUP_PATH) ?? { guilds: {} };
}

function writeStore(store) {
  ensureDataDir();
  const serialised = `${JSON.stringify(store, null, 2)}\n`;
  fs.writeFileSync(STORE_PATH, serialised, 'utf8');
  fs.writeFileSync(BACKUP_PATH, serialised, 'utf8');
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStoreFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    console.error(`[Playlists] Failed to parse ${path.basename(filePath)}: ${err.message}`);
    return null;
  }
}

module.exports = {
  MAX_PLAYLIST_NAME_LENGTH,
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  normalisePlaylistName,
  savePlaylist,
};
