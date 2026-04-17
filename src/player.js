'use strict';

const {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');
const { execSync } = require('child_process');
const { PassThrough } = require('stream');
const hifi = require('./hifi');

const DEFAULT_VOLUME = parseInt(process.env.DEFAULT_VOLUME ?? '80', 10) / 100;
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE ?? '500', 10);
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT ?? '300', 10) * 1000;
const ALONE_TIMEOUT = parseInt(process.env.ALONE_TIMEOUT ?? '30', 10) * 1000;
const EMBED_COLOR = 0x2b2d31;
const DEFAULT_OPUS_BITRATE = 128000;
const MIN_OPUS_BITRATE = 64000;
const MAX_OPUS_BITRATE = 256000;

function resolveFfmpegPath() {
  try {
    const p = require('ffmpeg-static');
    const fs = require('fs');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  try {
    const which = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    return execSync(which).toString().trim().split('\n')[0];
  } catch {}
  return null;
}

const FFMPEG_PATH = resolveFfmpegPath();
const VOICE_READY_TIMEOUT = 10_000;
const VOICE_READY_ATTEMPTS = 3;

class GuildPlayer {
  constructor(guildId, options = {}) {
    this.guildId = guildId;
    this.queue = [];
    this.currentTrack = null;
    this.lastTrack = null;
    this.voiceChannel = null;
    this.textChannel = null;
    this.connection = null;
    this.resource = null;
    this.volume = DEFAULT_VOLUME;
    this.repeat = 'off';
    this.shuffleMode = false;
    this.autoplay = false;
    this.startedAt = null;
    this.pausedAt = null;
    this.pausedElapsed = 0;
    this._idleTimer = null;
    this._aloneTimer = null;
    this._destroying = false;
    this.onDestroy = typeof options.onDestroy === 'function' ? options.onDestroy : null;
    this._ffmpegProcess = null;
    this._sourceStream = null;

    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      if (!this._destroying) this._advance();
    });

    this.audioPlayer.on('error', err => {
      console.error(`[Player:${guildId}] Audio error:`, err.message);
      if (this.textChannel) {
        this.textChannel
          .send({ embeds: [{ color: EMBED_COLOR, description: `❌  Stream error for **${this.currentTrack?.title ?? 'Unknown'}**. Skipping...` }] })
          .catch(() => {});
      }
      if (!this._destroying) this._advance();
    });
  }

  async connect(voiceChannel, textChannel) {
    this.cancelAloneTimer();
    this._clearIdleTimer();
    this.voiceChannel = voiceChannel;
    this.textChannel = textChannel;

    if (voiceChannel.full) {
      throw new Error('That voice channel is full.');
    }
    if (voiceChannel.viewable === false || voiceChannel.joinable === false) {
      throw new Error('The bot cannot access that voice channel. Check View Channel and Connect permissions.');
    }

    if (this.connection) {
      try { this.connection.destroy(); } catch {}
    }

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
      debug: true,
    });

    const prefix = `[Voice:${voiceChannel.guild.id}:${voiceChannel.id}]`;
    let trackedNetworking = null;
    this.connection.on('debug', msg => {
      console.log(`${prefix} ${msg}`);
    });
    this.connection.on('error', err => {
      console.error(`${prefix} error: ${err.message}`);
    });
    this.connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`${prefix} state ${oldState.status} -> ${newState.status}`);
      }

      const networking = newState.networking;
      if (networking && networking !== trackedNetworking) {
        trackedNetworking = networking;
        networking.on('close', code => {
          console.warn(`${prefix} networking close code: ${code}`);
        });
        networking.on('error', err => {
          console.error(`${prefix} networking error: ${err.message}`);
        });
      }
    });

    try {
      await waitForReady(this.connection, voiceChannel);
    } catch (err) {
      const failedConnection = this.connection;
      this.connection.destroy();
      this.connection = null;
      throw new Error(formatVoiceJoinError(voiceChannel, failedConnection, err));
    }

    this.connection.subscribe(this.audioPlayer);

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });
  }

  async addTrack(track, playNext = false) {
    if (!track?.allowStreaming) {
      throw new Error(`"${track?.title ?? 'This track'}" is not streamable from the current Hi-Fi instance or region.`);
    }
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      throw new Error(`Queue is full (max ${MAX_QUEUE_SIZE} tracks).`);
    }
    if (playNext) this.queue.unshift(track);
    else this.queue.push(track);

    if (!this.currentTrack) {
      const next = this.queue.shift();
      await this._play(next);
      return 'playing';
    }
    return 'queued';
  }

  async addTracks(tracks, playNext = false) {
    const streamable = tracks.filter(track => track?.allowStreaming !== false);
    const skipped = tracks.length - streamable.length;
    const available = MAX_QUEUE_SIZE - this.queue.length;
    const toAdd = streamable.slice(0, available);

    if (!toAdd.length) {
      if (skipped > 0) {
        throw new Error('None of the requested tracks are streamable from the current Hi-Fi instance or region.');
      }
      throw new Error(`Queue is full (max ${MAX_QUEUE_SIZE} tracks).`);
    }

    if (playNext) this.queue.unshift(...toAdd);
    else this.queue.push(...toAdd);

    if (!this.currentTrack && this.queue.length > 0) {
      const next = this.queue.shift();
      await this._play(next);
      return { added: toAdd.length, playing: true, skipped };
    }
    return { added: toAdd.length, playing: false, skipped };
  }

  async insertTrack(track, position = 1) {
    if (!track?.allowStreaming) {
      throw new Error(`"${track?.title ?? 'This track'}" is not streamable from the current Hi-Fi instance or region.`);
    }
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      throw new Error(`Queue is full (max ${MAX_QUEUE_SIZE} tracks).`);
    }

    const insertPosition = this._insertQueueItems([track], position);

    if (!this.currentTrack) {
      const next = this.queue.shift();
      await this._play(next);
      return { status: 'playing', position: 1 };
    }

    return { status: 'queued', position: insertPosition };
  }

  async insertTracks(tracks, position = 1) {
    const streamable = tracks.filter(track => track?.allowStreaming !== false);
    const skipped = tracks.length - streamable.length;
    const available = MAX_QUEUE_SIZE - this.queue.length;
    const toAdd = streamable.slice(0, available);

    if (!toAdd.length) {
      if (skipped > 0) {
        throw new Error('None of the requested tracks are streamable from the current Hi-Fi instance or region.');
      }
      throw new Error(`Queue is full (max ${MAX_QUEUE_SIZE} tracks).`);
    }

    const insertPosition = this._insertQueueItems(toAdd, position);

    if (!this.currentTrack && this.queue.length > 0) {
      const next = this.queue.shift();
      await this._play(next);
      return { added: toAdd.length, playing: true, skipped, position: 1 };
    }

    return { added: toAdd.length, playing: false, skipped, position: insertPosition };
  }

  _insertQueueItems(items, position = 1) {
    const index = Math.min(Math.max((position ?? 1) - 1, 0), this.queue.length);
    this.queue.splice(index, 0, ...items);
    return index + 1;
  }

  async _play(track, seekSeconds = 0) {
    this._clearIdleTimer();
    this.cancelAloneTimer();
    this._cleanupPlaybackResources();
    try {
      const urls = await hifi.trackManifests(track.id, this.guildId);
      const streamUrl = urls[0];
      if (!streamUrl) throw new Error(`No stream URL returned for track ${track.id}`);

      const resource = await this._createResource(streamUrl, seekSeconds);

      this.currentTrack = track;
      this.lastTrack = track;
      this.startedAt = Date.now();
      this.pausedAt = null;
      this.pausedElapsed = 0;

      if (seekSeconds > 0) {
        this.startedAt = Date.now() - seekSeconds * 1000;
      }

      this.resource = resource;
      this.audioPlayer.play(resource);
    } catch (err) {
      this.currentTrack = null;
      this.startedAt = null;
      this.pausedAt = null;
      this.pausedElapsed = 0;
      throw new Error(`Could not start "${track.title}": ${err.message}`);
    }
  }

  async _createResource(streamUrl, seekSeconds = 0) {
    if (!FFMPEG_PATH) {
      throw new Error('ffmpeg was not found. Install ffmpeg or ensure ffmpeg-static is available.');
    }
    return this._createFfmpegResource(streamUrl, seekSeconds);
  }

  _createFfmpegResource(streamUrl, seekSeconds) {
    const { spawn } = require('child_process');
    const bitrate = `${Math.round(this._getTargetBitrate() / 1000)}k`;
    const args = [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-headers', 'Origin: https://monochrome.tf\r\nReferer: https://monochrome.tf/\r\n',
      ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
      '-i', streamUrl,
      '-vn',
      '-af', `volume=${this.volume.toFixed(4)}`,
      '-acodec', 'libopus',
      '-application', 'audio',
      '-vbr', 'on',
      '-compression_level', '10',
      '-b:a', bitrate,
      '-ar', '48000',
      '-ac', '2',
      '-f', 'opus',
      '-loglevel', 'error',
      'pipe:1',
    ];

    const ff = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const pass = new PassThrough();
    let stderr = '';

    this._ffmpegProcess = ff;
    this._sourceStream = pass;

    ff.stdout.pipe(pass);
    ff.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    ff.on('error', err => pass.destroy(err));
    ff.on('close', code => {
      this._ffmpegProcess = null;
      if (code && code !== 0 && !pass.destroyed) {
        pass.destroy(new Error(`ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`));
      }
    });

    return createAudioResource(pass, {
      inputType: StreamType.OggOpus,
    });
  }

  _getTargetBitrate() {
    const channelBitrate = Number(this.voiceChannel?.bitrate) || DEFAULT_OPUS_BITRATE;
    return Math.min(Math.max(channelBitrate, MIN_OPUS_BITRATE), MAX_OPUS_BITRATE);
  }

  _cleanupPlaybackResources() {
    if (this._sourceStream && !this._sourceStream.destroyed) {
      try { this._sourceStream.destroy(); } catch {}
    }
    this._sourceStream = null;

    if (this._ffmpegProcess) {
      try { this._ffmpegProcess.kill('SIGKILL'); } catch {}
    }
    this._ffmpegProcess = null;

    this.resource = null;
  }

  async _advance() {
    if (this.repeat === 'track' && this.currentTrack) {
      await this._play(this.currentTrack).catch(console.error);
      return;
    }

    if (this.repeat === 'queue' && this.currentTrack) {
      this.queue.push(this.currentTrack);
    }

    this.currentTrack = null;

    if (!this.queue.length) {
      if (this.autoplay && this.lastTrack) {
        await this._playAutoplay();
        return;
      }
      this._startIdleTimer();
      if (this.textChannel) {
        this.textChannel
          .send({ embeds: [{ color: EMBED_COLOR, description: 'ℹ️  Queue finished. Add more songs with `/play`!' }] })
          .catch(() => {});
      }
      return;
    }

    const next = this.shuffleMode
      ? this.queue.splice(Math.floor(Math.random() * this.queue.length), 1)[0]
      : this.queue.shift();

    try {
      await this._play(next);
      if (this.textChannel) {
        const { buildNowPlayingEmbed } = require('./embeds');
        this.textChannel
          .send({ embeds: [buildNowPlayingEmbed(next, this)] })
          .catch(() => {});
      }
    } catch {
      await this._advance();
    }
  }

  async _playAutoplay() {
    try {
      let recs = await hifi.recommendations(this.lastTrack.id, this.guildId);
      if (!recs.length) recs = await hifi.mix(this.lastTrack.id, this.guildId);
      const filtered = recs.filter(t => t && t.id !== this.lastTrack?.id);
      if (!filtered.length) {
        this._startIdleTimer();
        return;
      }
      const pick = filtered[Math.floor(Math.random() * Math.min(filtered.length, 5))];
      pick.requestedBy = null;
      await this._play(pick);
      if (this.textChannel) {
        const { buildNowPlayingEmbed } = require('./embeds');
        this.textChannel
          .send({ content: '🤖 **Autoplay:**', embeds: [buildNowPlayingEmbed(pick, this)] })
          .catch(() => {});
      }
    } catch (err) {
      console.error('[Autoplay]', err.message);
      this._startIdleTimer();
    }
  }

  pause() {
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Playing) return false;
    this.audioPlayer.pause();
    this.pausedAt = Date.now();
    this.pausedElapsed += this.pausedAt - (this.startedAt ?? this.pausedAt);
    this.startedAt = null;
    return true;
  }

  resume() {
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Paused) return false;
    this.audioPlayer.unpause();
    this.startedAt = Date.now();
    this.pausedAt = null;
    return true;
  }

  skip(count = 1) {
    if (!this.currentTrack) return false;
    if (count > 1) this.queue.splice(0, count - 1);
    const saved = this.repeat;
    this.repeat = 'off';
    this.audioPlayer.stop();
    this.repeat = saved;
    return true;
  }

  stop() {
    this._destroying = true;
    this.queue = [];
    this.currentTrack = null;
    this.audioPlayer.stop(true);
    this._cleanupPlaybackResources();
    this._destroying = false;
    this._startIdleTimer();
  }

  async seek(seconds) {
    if (!this.currentTrack) return false;
    await this._play(this.currentTrack, seconds);
    return true;
  }

  async setVolume(pct) {
    this.volume = Math.min(Math.max(pct / 100, 0), 1);
    if (!this.currentTrack) return;

    const track = this.currentTrack;
    const seekSeconds = Math.max(0, Math.floor(this.getElapsedMs() / 1000));
    const shouldPause = this.isPaused();

    await this._play(track, seekSeconds);

    if (shouldPause) {
      this.pause();
    }
  }

  setRepeat(mode) { this.repeat = mode; }

  toggleShuffle() {
    this.shuffleMode = !this.shuffleMode;
    return this.shuffleMode;
  }

  toggleAutoplay() {
    this.autoplay = !this.autoplay;
    return this.autoplay;
  }

  shuffleNow() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  remove(index) {
    const i = index - 1;
    if (i < 0 || i >= this.queue.length) return null;
    return this.queue.splice(i, 1)[0];
  }

  move(from, to) {
    const f = from - 1;
    const t = to - 1;
    if (f < 0 || f >= this.queue.length || t < 0 || t >= this.queue.length) return false;
    const [track] = this.queue.splice(f, 1);
    this.queue.splice(t, 0, track);
    return true;
  }

  clear() {
    this.queue = [];
  }

  getElapsedMs() {
    if (!this.currentTrack) return 0;
    if (this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      return this.pausedElapsed;
    }
    return this.pausedElapsed + (Date.now() - (this.startedAt ?? Date.now()));
  }

  isPlaying() {
    return this.audioPlayer.state.status === AudioPlayerStatus.Playing;
  }

  isPaused() {
    return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
  }

  _startIdleTimer() {
    this._clearIdleTimer();
    this._idleTimer = setTimeout(() => {
      if (!this.currentTrack) {
        if (this.textChannel) {
          this.textChannel
            .send({ embeds: [{ color: EMBED_COLOR, description: 'ℹ️  Left due to inactivity. See you next time! 👋' }] })
            .catch(() => {});
        }
        this.destroy();
      }
    }, IDLE_TIMEOUT);
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  startAloneTimer() {
    if (this._aloneTimer) return;
    this._aloneTimer = setTimeout(() => {
      if (this.textChannel) {
        this.textChannel
          .send({ embeds: [{ color: EMBED_COLOR, description: 'ℹ️  Everyone left the voice channel. Goodbye! 👋' }] })
          .catch(() => {});
      }
      this.destroy();
    }, ALONE_TIMEOUT);
  }

  cancelAloneTimer() {
    if (this._aloneTimer) {
      clearTimeout(this._aloneTimer);
      this._aloneTimer = null;
    }
  }

  destroy() {
    if (this._destroying) return;

    this._destroying = true;
    this._clearIdleTimer();
    this.cancelAloneTimer();
    this.queue = [];
    this.currentTrack = null;
    this.lastTrack = null;
    this.audioPlayer.stop(true);
    this._cleanupPlaybackResources();
    try { this.connection?.destroy(); } catch {}
    this.connection = null;
    this.voiceChannel = null;

    try { this.onDestroy?.(); } catch {}

    this._destroying = false;
  }
}

async function waitForReady(connection, voiceChannel) {
  for (let attempt = 1; attempt <= VOICE_READY_ATTEMPTS; attempt++) {
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT);
      return;
    } catch (err) {
      const prefix = `[Voice:${voiceChannel.guild.id}:${voiceChannel.id}]`;
      console.warn(
        `${prefix} Ready timeout on attempt ${attempt}/${VOICE_READY_ATTEMPTS}. Current state: ${connection.state.status}`,
      );

      if (attempt === VOICE_READY_ATTEMPTS) {
        throw err;
      }

      connection.rejoin({
        channelId: voiceChannel.id,
        selfDeaf: true,
        selfMute: false,
      });
    }
  }
}

function formatVoiceJoinError(voiceChannel, connection) {
  const channelKind = String(voiceChannel.type).toLowerCase().includes('stage') ? 'stage' : 'voice';
  const status = connection?.state?.status ?? 'unknown';
  const hint = channelKind === 'stage'
    ? 'If this is a Stage channel, test again in a normal voice channel.'
    : 'This usually means Discord voice negotiation did not complete from the current host/network.';

  return `Could not connect to the ${channelKind} channel. Final voice state: ${status}. ${hint}`;
}

module.exports = { GuildPlayer };
