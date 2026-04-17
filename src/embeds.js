'use strict';

const { EmbedBuilder } = require('discord.js');

const MONO   = 0x2b2d31;
const ACCENT = MONO;
const GREEN  = MONO;
const RED    = MONO;
const YELLOW = MONO;
const ART_SIZE = 1280;
const PROGRESS_FILLED = '\u2501';
const PROGRESS_EMPTY = '\u2500';
const PROGRESS_MARKER = '\u25CF';

function progressBar(elapsedMs, totalSec, length = 18) {
  if (!totalSec) return PROGRESS_EMPTY.repeat(length);
  const elapsed = Math.min(elapsedMs / 1000, totalSec);
  const pct = elapsed / totalSec;
  const marker = Math.min(length - 1, Math.max(0, Math.round(pct * (length - 1))));
  const left = PROGRESS_FILLED.repeat(marker);
  const right = PROGRESS_EMPTY.repeat(Math.max(0, length - marker - 1));
  return `\`${formatTime(elapsed)}\` ${left}${PROGRESS_MARKER}${right} \`${formatTime(totalSec)}\``;
}

function formatTime(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function buildNowPlayingEmbed(track, player) {
  const elapsed = player.getElapsedMs();
  const status = player.isPaused() ? 'Paused' : 'Now Playing';
  const meta = [
    track.artist || 'Unknown',
    track.album || null,
    capitalise(track.source || 'tidal'),
  ].filter(Boolean).join(' | ');
  const states = [
    player.repeat !== 'off' ? `Repeat ${capitalise(player.repeat)}` : null,
    player.shuffleMode ? 'Shuffle On' : null,
    player.autoplay ? 'Autoplay On' : null,
    `Volume ${Math.round(player.volume * 100)}%`,
  ].filter(Boolean).join(' | ');

  const embed = new EmbedBuilder()
    .setColor(MONO)
    .setAuthor({ name: status })
    .setTitle(truncate(track.title, 256))
    .setURL(track.url)
    .setDescription([
      meta,
      '',
      progressBar(elapsed, track.duration),
      states,
    ].filter(Boolean).join('\n'))
    .setFooter({
      text: `Queue: ${player.queue.length} track${player.queue.length !== 1 ? 's' : ''}${track.requestedBy ? ` | Requested by ${track.requestedBy}` : ''}`,
    });

  const artwork = coverImageUrl(track.thumbnail);
  if (artwork) embed.setImage(artwork);
  return embed;
}

function buildQueuedEmbed(track, position, player) {
  const eta = queueEtaText(player, position);
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: 'Queued' })
    .setTitle(truncate(track.title, 256))
    .setURL(track.url)
    .setDescription([
      track.artist || 'Unknown',
      track.album || null,
      '',
      `Position #${position} | ${track.durationFormatted || '?'}`,
      eta ? `Estimated start: ${eta}` : null,
    ].filter(Boolean).join('\n'));

  const artwork = coverImageUrl(track.thumbnail);
  if (artwork) embed.setImage(artwork);
  return embed;
}

function buildQueueEmbed(player, page = 1) {
  const pageSize = 10;
  const total = player.queue.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(page, 1), pages);
  const start = (currentPage - 1) * pageSize;
  const slice = player.queue.slice(start, start + pageSize);

  const totalDuration = player.queue.reduce((sum, track) => sum + (track.duration || 0), 0);
  const currentDuration = player.currentTrack?.duration ?? 0;
  const currentElapsed = player.getElapsedMs() / 1000;

  const items = slice.map((track, index) =>
    `\`${start + index + 1}.\` [${truncate(track.title, 50)}](${track.url}) | \`${track.durationFormatted || '?'}\``,
  );

  const embed = new EmbedBuilder()
    .setColor(MONO)
    .setTitle('Queue')
    .setDescription([
      player.currentTrack
        ? `Now playing: [${truncate(player.currentTrack.title, 60)}](${player.currentTrack.url})`
        : 'Now playing: _Nothing_',
      '',
      total === 0 ? '_The queue is empty._' : items.join('\n'),
    ].join('\n'))
    .setFooter({
      text: [
        `Page ${currentPage}/${pages}`,
        `${total} track${total !== 1 ? 's' : ''}`,
        `Total ${formatTime(currentDuration - currentElapsed + totalDuration)}`,
        player.repeat !== 'off' ? `Repeat ${player.repeat}` : null,
        player.shuffleMode ? 'Shuffle On' : null,
        player.autoplay ? 'Autoplay On' : null,
      ].filter(Boolean).join(' | '),
    });

  return { embed, pages };
}

function buildSearchEmbed(results, query) {
  const lines = results.map((track, index) =>
    `**${index + 1}.** [${truncate(track.title, 60)}](${track.url})\n   ${track.artist ?? 'Unknown'} | ${track.durationFormatted ?? '?'}`,
  );

  return new EmbedBuilder()
    .setColor(MONO)
    .setAuthor({ name: `Search: ${truncate(query, 60)}` })
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: 'Select a result below to play it.' });
}

function buildLyricsEmbed(lyrics, title, artist, url) {
  const maxLen = 3800;
  const body = lyrics.length > maxLen
    ? `${lyrics.slice(0, maxLen)}\n\n_...truncated. Click title for full lyrics._`
    : lyrics;

  const embed = new EmbedBuilder()
    .setColor(MONO)
    .setAuthor({ name: 'Lyrics' })
    .setTitle(`${truncate(artist, 80)} - ${truncate(title, 80)}`)
    .setDescription(body);

  if (url) embed.setURL(url);
  return embed;
}

function buildDownloadEmbed(track) {
  const embed = new EmbedBuilder()
    .setColor(GREEN)
    .setAuthor({ name: 'Preparing Download Link' })
    .setTitle(truncate(track.title, 256))
    .setDescription([
      track.artist || 'Unknown',
      track.album || null,
      '',
      'Resolving the Monochrome track page for original-quality download access.',
    ].filter(Boolean).join('\n'));

  const artwork = coverImageUrl(track.thumbnail);
  if (artwork) embed.setImage(artwork);
  return embed;
}

function buildDownloadReadyEmbed(track) {
  const embed = new EmbedBuilder()
    .setColor(GREEN)
    .setAuthor({ name: 'Lossless Download Ready' })
    .setTitle(truncate(track.title, 256))
    .setDescription([
      track.artist || 'Unknown',
      track.album || null,
      '',
      'Open the Monochrome link below to access the original-quality track without Discord upload limits.',
    ].filter(Boolean).join('\n'));

  const artwork = coverImageUrl(track.thumbnail);
  if (artwork) embed.setImage(artwork);
  if (track.monochromeUrl) embed.setURL(track.monochromeUrl);
  return embed;
}

function errorEmbed(msg) {
  return new EmbedBuilder().setColor(RED).setDescription(`ERROR  ${msg}`);
}

function successEmbed(msg) {
  return new EmbedBuilder().setColor(GREEN).setDescription(`OK  ${msg}`);
}

function infoEmbed(msg) {
  return new EmbedBuilder().setColor(ACCENT).setDescription(`INFO  ${msg}`);
}

function warnEmbed(msg) {
  return new EmbedBuilder().setColor(YELLOW).setDescription(`WARN  ${msg}`);
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : `${str.slice(0, max - 3)}...`;
}

function capitalise(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function coverImageUrl(url, size = ART_SIZE) {
  if (!url) return '';
  return url.replace(/\/\d+x\d+\.(jpg|jpeg|png)$/i, `/${size}x${size}.$1`);
}

function queueEtaSeconds(player, position = 1) {
  if (!player) return null;

  const remainingCurrent = player.currentTrack
    ? Math.max(0, (player.currentTrack.duration ?? 0) - (player.getElapsedMs() / 1000))
    : 0;
  const aheadCount = Math.max((position ?? 1) - 1, 0);
  const queueAhead = player.queue
    .slice(0, aheadCount)
    .reduce((sum, track) => sum + (track?.duration || 0), 0);

  return Math.max(0, Math.round(remainingCurrent + queueAhead));
}

function queueEtaText(player, position = 1) {
  const eta = queueEtaSeconds(player, position);
  if (eta == null) return null;
  if (eta <= 1) return 'Up next';
  return formatTime(eta);
}

module.exports = {
  buildNowPlayingEmbed,
  buildQueuedEmbed,
  buildQueueEmbed,
  buildSearchEmbed,
  buildLyricsEmbed,
  buildDownloadEmbed,
  buildDownloadReadyEmbed,
  errorEmbed,
  successEmbed,
  infoEmbed,
  warnEmbed,
  formatTime,
  progressBar,
  queueEtaText,
  queueEtaSeconds,
};
