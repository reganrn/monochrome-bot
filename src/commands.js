'use strict';

const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { GuildPlayer } = require('./player');
const { resolve, searchResults }       = require('./search');
const { fetchLyrics }                  = require('./lyrics');
const {
  addTrackToPlaylist,
  MAX_PLAYLIST_NAME_LENGTH,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  savePlaylist,
} = require('./playlists');
const { createPlaylistCommand }        = require('./playlist-command');
const { getDownloadLinks }             = require('./download');
const {
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
  queueEtaText,
} = require('./embeds');

// ─── Guard helpers ─────────────────────────────────────────────────────────────

function getOrCreatePlayer(guildId, client) {
  if (!client.players.has(guildId)) {
    client.players.set(guildId, new GuildPlayer(guildId, {
      onDestroy: () => client.players.delete(guildId),
    }));
  }
  return client.players.get(guildId);
}

function requireVoice(interaction) {
  const vc = interaction.member?.voice?.channel;
  if (!vc) {
    const payload = { embeds: [errorEmbed('You must be in a voice channel.')], ephemeral: true };
    if (interaction.deferred || interaction.replied) interaction.editReply(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
    return null;
  }
  return vc;
}

function requirePlayer(interaction, client) {
  const player = client.players.get(interaction.guildId);
  if (!player?.currentTrack) {
    const payload = { embeds: [errorEmbed('Nothing is playing right now.')], ephemeral: true };
    if (interaction.deferred || interaction.replied) interaction.editReply(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
    return null;
  }
  return player;
}

function requireManageGuild(interaction) {
  if (!interaction.inGuild()) {
    interaction.reply({ embeds: [errorEmbed('This command can only be used in a server.')], ephemeral: true }).catch(() => {});
    return false;
  }

  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    return true;
  }

  interaction.reply({ embeds: [errorEmbed('You need the **Manage Server** permission to change API instances.')], ephemeral: true }).catch(() => {});
  return false;
}

function normaliseInstanceUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('Instance URL must be a valid HTTPS URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Instance URL must use HTTPS.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Instance URL must not include credentials.');
  }

  if (isPrivateInstanceHost(parsed.hostname)) {
    throw new Error('Instance URL must point to a public host.');
  }

  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function isPrivateInstanceHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') {
    return true;
  }

  const ipv4 = /^(\d{1,3})(?:\.(\d{1,3})){3}$/.exec(host);
  if (!ipv4) return false;

  const parts = host.split('.').map(Number);
  if (parts.some(part => Number.isNaN(part) || part < 0 || part > 255)) {
    return true;
  }

  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function getPlaylistSnapshot(player) {
  const tracks = [];
  if (player?.currentTrack) tracks.push(player.currentTrack);
  if (Array.isArray(player?.queue)) tracks.push(...player.queue);
  return tracks.filter(track => track?.id && track?.title);
}

function buildPlaylistListEmbed(playlists) {
  const lines = playlists.map((playlist, index) => {
    const updatedAt = playlist.updatedAt ? Math.floor(new Date(playlist.updatedAt).getTime() / 1000) : null;
    return [
      `**${index + 1}. ${playlist.name}**`,
      `${playlist.trackCount} track${playlist.trackCount !== 1 ? 's' : ''} | ${formatTime(playlist.totalDuration || 0)}${updatedAt ? ` | Updated <t:${updatedAt}:R>` : ''}`,
    ].join('\n');
  });

  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('Saved Playlists')
    .setDescription(lines.join('\n\n'));
}

function buildPlaylistDetailEmbed(playlist) {
  const previewTracks = playlist.tracks.slice(0, 10).map((track, index) => {
    const title = track.url ? `[${track.title}](${track.url})` : track.title;
    return `\`${index + 1}.\` ${title} | ${track.artist ?? 'Unknown'} | \`${track.durationFormatted || formatTime(track.duration || 0)}\``;
  });

  if (playlist.tracks.length > 10) {
    previewTracks.push(`_...and ${playlist.tracks.length - 10} more track${playlist.tracks.length - 10 !== 1 ? 's' : ''}._`);
  }

  const updatedAt = playlist.updatedAt ? Math.floor(new Date(playlist.updatedAt).getTime() / 1000) : null;
  const createdDate = playlist.createdAt
    ? new Date(playlist.createdAt).toISOString().slice(0, 10)
    : null;

  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(playlist.name)
    .setDescription(previewTracks.join('\n') || '_No tracks saved._')
    .addFields(
      {
        name: 'Tracks',
        value: String(playlist.trackCount ?? playlist.tracks.length),
        inline: true,
      },
      {
        name: 'Duration',
        value: formatTime(playlist.totalDuration || 0),
        inline: true,
      },
      {
        name: 'Updated',
        value: updatedAt ? `<t:${updatedAt}:R>` : 'Unknown',
        inline: true,
      },
    )
    .setFooter({
      text: [
        createdDate ? `Created ${createdDate}` : null,
        playlist.createdByUsername ? `by ${playlist.createdByUsername}` : null,
      ].filter(Boolean).join(' '),
    });
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const commands = [

  // ── /play ──────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('play')
      .setDescription('▶️  Play a song, album, or playlist')
      .addStringOption(o =>
        o.setName('query')
          .setDescription('Song name, TIDAL URL, Monochrome share URL, YouTube video URL, or playlist')
          .setRequired(true))
      .addBooleanOption(o =>
        o.setName('next')
          .setDescription('Insert at the front of the queue')
          .setRequired(false)),

    async execute(interaction, client) {
      const vc = requireVoice(interaction);
      if (!vc) return;

      await interaction.deferReply();

      const query    = interaction.options.getString('query', true);
      const playNext = interaction.options.getBoolean('next') ?? false;
      const player   = getOrCreatePlayer(interaction.guildId, client);

      // Connect if needed
      if (!player.connection || player.voiceChannel?.id !== vc.id) {
        try {
          await player.connect(vc, interaction.channel);
        } catch (err) {
          return interaction.editReply({ embeds: [errorEmbed(err.message)] });
        }
      }
      player.textChannel = interaction.channel;

      let tracks;
      try {
        tracks = await resolve(query, interaction.user.username, interaction.guildId);
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed(`Could not resolve: ${err.message}`)] });
      }

      if (!tracks.length) {
        return interaction.editReply({ embeds: [errorEmbed('No results found.')] });
      }

      // Multiple tracks (playlist)
      if (tracks.length > 1) {
        try {
          const { added, playing, skipped } = await player.addTracks(tracks, playNext);
          const startPos = playNext ? 1 : Math.max(1, player.queue.length - added + 1);
          const eta = !playing ? queueEtaText(player, startPos) : null;
          const embed = successEmbed(
            `Added **${added}** track${added !== 1 ? 's' : ''} to the queue.\n` +
            (playing ? '▶️  Started playing!' : `Position: **#${startPos}** onwards`) +
            (eta ? `\nEstimated start: **${eta}**` : '') +
            (skipped ? `\n⚠️  Skipped **${skipped}** unavailable track${skipped !== 1 ? 's' : ''}.` : ''),
          );
          embed.setTitle(query.slice(0, 100));
          return interaction.editReply({ embeds: [embed] });
        } catch (err) {
          return interaction.editReply({ embeds: [errorEmbed(err.message)] });
        }
      }

      // Single track
      const [track] = tracks;
      let status;
      try {
        status = await player.addTrack(track, playNext);
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed(err.message)] });
      }

      if (status === 'playing') {
        return interaction.editReply({ embeds: [buildNowPlayingEmbed(track, player)] });
      } else {
        const pos = playNext ? 1 : player.queue.length;
        return interaction.editReply({ embeds: [buildQueuedEmbed(track, pos, player)] });
      }
    },
  },

  // ── /insert ────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('insert')
      .setDescription('↪️  Insert a song, album, or playlist at a queue position after the current track')
      .addStringOption(o =>
        o.setName('query')
          .setDescription('Song name, TIDAL URL, Monochrome share URL, YouTube video URL, or playlist')
          .setRequired(true))
      .addIntegerOption(o =>
        o.setName('position')
          .setDescription('Queue position after the current track (1 = next)')
          .setMinValue(1)),

    async execute(interaction, client) {
      const player = requirePlayer(interaction, client);
      if (!player) return;

      await interaction.deferReply();

      const query = interaction.options.getString('query', true);
      const position = interaction.options.getInteger('position') ?? 1;
      let tracks;
      try {
        tracks = await resolve(query, interaction.user.username, interaction.guildId);
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed(`Could not resolve: ${err.message}`)] });
      }

      if (!tracks.length) {
        return interaction.editReply({ embeds: [errorEmbed('No results found.')] });
      }

      if (tracks.length > 1) {
        try {
          const { added, skipped, position: insertedAt } = await player.insertTracks(tracks, position);
          const eta = queueEtaText(player, insertedAt);
          const embed = successEmbed(
            `Inserted **${added}** track${added !== 1 ? 's' : ''} at position **#${insertedAt}**.` +
            (eta ? `\nEstimated start: **${eta}**` : '') +
            (skipped ? `\n⚠️  Skipped **${skipped}** unavailable track${skipped !== 1 ? 's' : ''}.` : ''),
          );
          embed.setTitle(query.slice(0, 100));
          return interaction.editReply({ embeds: [embed] });
        } catch (err) {
          return interaction.editReply({ embeds: [errorEmbed(err.message)] });
        }
      }

      const [track] = tracks;
      let result;
      try {
        result = await player.insertTrack(track, position);
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed(err.message)] });
      }

      if (result.status === 'playing') {
        return interaction.editReply({ embeds: [buildNowPlayingEmbed(track, player)] });
      }

      return interaction.editReply({ embeds: [buildQueuedEmbed(track, result.position, player)] });
    },
  },

  // ── /search ────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('search')
      .setDescription('🔍  Search for a song and pick from results')
      .addStringOption(o =>
        o.setName('query').setDescription('Search query').setRequired(true))
      .addIntegerOption(o =>
        o.setName('results').setDescription('Number of results (1-10)').setMinValue(1).setMaxValue(10)),

    async execute(interaction, client) {
      const vc = requireVoice(interaction);
      if (!vc) return;

      await interaction.deferReply();

      const query = interaction.options.getString('query', true);
      const limit = interaction.options.getInteger('results') ?? 5;

      let results;
      try {
        results = await searchResults(query, limit, interaction.guildId);
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed(err.message)] });
      }

      if (!results.length) {
        return interaction.editReply({ embeds: [errorEmbed('No results found.')] });
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`search_select_${interaction.id}`)
        .setPlaceholder('Select a track to play…')
        .addOptions(results.map((r, i) => ({
          label:       `${i + 1}. ${(r.title ?? 'Unknown').slice(0, 95)}`,
          description: `${r.artist ?? 'Unknown'} • ${r.durationFormatted ?? '?'}`,
          value:       r.url,
        })));

      const row = new ActionRowBuilder().addComponents(selectMenu);
      const msg = await interaction.editReply({
        embeds:     [buildSearchEmbed(results, query)],
        components: [row],
      });

      // Wait for selection
      const collector = msg.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id && i.customId === `search_select_${interaction.id}`,
        time:   30_000,
        max:    1,
      });

      collector.on('collect', async selectInteraction => {
        await selectInteraction.deferUpdate();
        const url    = selectInteraction.values[0];
        const picked = results.find(r => r.url === url);
        if (!picked) return;

        const existingPlayer = client.players.get(interaction.guildId);
        const player = existingPlayer ?? getOrCreatePlayer(interaction.guildId, client);
        if (!player.connection || player.voiceChannel?.id !== vc.id) {
          try {
            await player.connect(vc, interaction.channel);
          } catch (err) {
            if (!existingPlayer) {
              client.players.delete(interaction.guildId);
            }
            await interaction.editReply({
              embeds: [errorEmbed(err.message)],
              components: [],
            });
            return;
          }
        }
        player.textChannel = interaction.channel;

        const track = { ...picked, requestedBy: interaction.user.username };
        let status;
        try {
          status = await player.addTrack(track);
        } catch (err) {
          await interaction.editReply({
            embeds: [errorEmbed(err.message)],
            components: [],
          });
          return;
        }

        if (status === 'playing') {
          await interaction.editReply({ embeds: [buildNowPlayingEmbed(track, player)] });
        } else {
          await interaction.editReply({
            embeds:     [buildQueuedEmbed(track, player.queue.length, player)],
            components: [],
          });
        }
      });

      collector.on('end', collected => {
        if (collected.size === 0) {
          interaction.editReply({ components: [] }).catch(() => {});
        }
      });
    },
  },

  // ── /pause ─────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('pause')
      .setDescription('⏸  Pause the current track'),

    async execute(interaction, client) {
      const player = requirePlayer(interaction, client);
      if (!player) return;
      const ok = player.pause();
      await interaction.reply({
        embeds: [ok ? successEmbed('Paused.') : warnEmbed('Already paused.')],
        ephemeral: !ok,
      });
    },
  },

  // ── /resume ────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('resume')
      .setDescription('▶️  Resume the paused track'),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player) return interaction.reply({ embeds: [errorEmbed('Nothing to resume.')], ephemeral: true });
      const ok = player.resume();
      await interaction.reply({
        embeds: [ok ? successEmbed('Resumed.') : warnEmbed('Not paused.')],
        ephemeral: !ok,
      });
    },
  },

  // ── /skip ──────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('skip')
      .setDescription('⏭  Skip the current track')
      .addIntegerOption(o =>
        o.setName('count').setDescription('Number of tracks to skip').setMinValue(1).setMaxValue(50)),

    async execute(interaction, client) {
      const player = requirePlayer(interaction, client);
      if (!player) return;
      const count = interaction.options.getInteger('count') ?? 1;
      const skipped = player.currentTrack?.title ?? 'the current track';
      player.skip(count);
      await interaction.reply({
        embeds: [successEmbed(
          count > 1
            ? `Skipped **${count}** tracks.`
            : `Skipped **${skipped}**.`,
        )],
      });
    },
  },

  // ── /stop ──────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('stop')
      .setDescription('⏹  Stop playback and clear the queue'),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player) return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
      player.stop();
      await interaction.reply({ embeds: [successEmbed('Stopped and cleared the queue.')] });
    },
  },

  // ── /queue ─────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('queue')
      .setDescription('📋  Show the current queue')
      .addIntegerOption(o =>
        o.setName('page').setDescription('Page number').setMinValue(1)),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player) return interaction.reply({ embeds: [infoEmbed('The queue is empty.')], ephemeral: true });

      const page        = interaction.options.getInteger('page') ?? 1;
      const { embed, pages } = buildQueueEmbed(player, page);

      // Add prev/next buttons if multi-page
      const components = [];
      if (pages > 1) {
        const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`queue_prev_${page}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
          new ButtonBuilder().setCustomId(`queue_next_${page}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
        );
        components.push(row);
      }

      await interaction.reply({ embeds: [embed], components });
    },
  },

  // ── /nowplaying ────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('nowplaying')
      .setDescription('🎵  Show the currently playing track'),

    async execute(interaction, client) {
      const player = requirePlayer(interaction, client);
      if (!player) return;
      const track = player.currentTrack;
      await interaction.reply({ embeds: [buildNowPlayingEmbed(track, player)] });
    },
  },

  // ── /volume ────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('volume')
      .setDescription('🔊  Set the playback volume')
      .addIntegerOption(o =>
        o.setName('level').setDescription('Volume level 0-100').setMinValue(0).setMaxValue(100).setRequired(true)),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player) return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
      const level = interaction.options.getInteger('level', true);
      await interaction.deferReply();
      try {
        await player.setVolume(level);
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed(`Could not set volume: ${err.message}`)] });
      }
      const emoji = level === 0 ? '🔇' : level < 40 ? '🔈' : level < 70 ? '🔉' : '🔊';
      await interaction.editReply({ embeds: [successEmbed(`${emoji}  Volume set to **${level}%**.`)] });
    },
  },

  // ── /shuffle ───────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('shuffle')
      .setDescription('🔀  Toggle shuffle mode (or shuffle the queue now)')
      .addBooleanOption(o =>
        o.setName('now').setDescription('Shuffle the queue immediately').setRequired(false)),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player) return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });

      if (interaction.options.getBoolean('now')) {
        player.shuffleNow();
        return interaction.reply({ embeds: [successEmbed('Queue shuffled! 🔀')] });
      }

      const on = player.toggleShuffle();
      await interaction.reply({ embeds: [successEmbed(`Shuffle **${on ? 'enabled' : 'disabled'}**. 🔀`)] });
    },
  },

  // ── /repeat ────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('repeat')
      .setDescription('🔁  Set repeat mode')
      .addStringOption(o =>
        o.setName('mode')
          .setDescription('Repeat mode')
          .setRequired(true)
          .addChoices(
            { name: 'Off',   value: 'off'   },
            { name: 'Track', value: 'track' },
            { name: 'Queue', value: 'queue' },
          )),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player) return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });

      const mode = interaction.options.getString('mode', true);
      player.setRepeat(mode);
      const icons = { off: '➡️', track: '🔂', queue: '🔁' };
      await interaction.reply({ embeds: [successEmbed(`Repeat set to **${mode}** ${icons[mode]}`)] });
    },
  },

  // ── /autoplay ──────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('autoplay')
      .setDescription('🤖  Toggle autoplay (plays related tracks when queue ends)'),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player) return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
      const on = player.toggleAutoplay();
      await interaction.reply({ embeds: [successEmbed(`Autoplay **${on ? 'enabled' : 'disabled'}**. 🤖`)] });
    },
  },

  // ── /seek ──────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('seek')
      .setDescription('⏩  Seek to a position in the current track')
      .addStringOption(o =>
        o.setName('position')
          .setDescription('Time in seconds, or mm:ss format (e.g. 1:30)')
          .setRequired(true)),

    async execute(interaction, client) {
      const player = requirePlayer(interaction, client);
      if (!player) return;

      const raw  = interaction.options.getString('position', true);
      const secs = parseTime(raw);
      if (secs === null) {
        return interaction.reply({ embeds: [errorEmbed('Invalid time format. Use seconds (e.g. `90`) or `mm:ss` (e.g. `1:30`).')], ephemeral: true });
      }

      await interaction.deferReply();
      try {
        await player.seek(secs);
        await interaction.editReply({ embeds: [successEmbed(`Seeked to **${formatTime(secs)}**.`)] });
      } catch (err) {
        await interaction.editReply({ embeds: [errorEmbed(`Could not seek: ${err.message}`)] });
      }
    },
  },

  // ── /lyrics ────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('lyrics')
      .setDescription('🎶  Show lyrics for the current or a specific song')
      .addStringOption(o =>
        o.setName('song').setDescription('Song name (leave blank for current track)')),

    async execute(interaction, client) {
      await interaction.deferReply();

      let title, artist, trackId;

      const manual = interaction.options.getString('song');
      if (manual) {
        try {
          const tracks = await resolve(manual, interaction.user.username, interaction.guildId);
          const track = tracks[0];
          title   = track?.title ?? manual.trim();
          artist  = track?.artist ?? '';
          trackId = track?.id ?? null;
        } catch {
          title   = manual.trim();
          artist  = '';
          trackId = null;
        }
      } else {
        const player = client.players.get(interaction.guildId);
        if (!player?.currentTrack) {
          return interaction.editReply({ embeds: [errorEmbed('Nothing is playing. Provide a song name.')] });
        }
        title   = player.currentTrack.title;
        artist  = player.currentTrack.artist;
        trackId = player.currentTrack.id;
      }

      const result = await fetchLyrics(trackId, title, artist, interaction.guildId);
      if (!result) {
        const label = artist
          ? `${artist} - ${title || manual?.trim() || 'that track'}`
          : (title || manual?.trim() || 'that track');
        return interaction.editReply({ embeds: [errorEmbed(`No lyrics found for **${label}**.`)] });
      }

      const embed = buildLyricsEmbed(result.lyrics, result.title, result.artist, result.url);

      // Handle Discord's 4096 char embed description limit by splitting into pages
      if (result.lyrics.length > 3800) {
        const pages  = splitLyrics(result.lyrics, 3800);
        let current  = 0;
        const getEmbed = () => buildLyricsEmbed(
          pages[current] + (pages.length > 1 ? `\n\n*Page ${current + 1}/${pages.length}*` : ''),
          result.title, result.artist, result.url,
        );
        const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
        const row = () => new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ly_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
          new ButtonBuilder().setCustomId('ly_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(current === pages.length - 1),
        );

        const msg = await interaction.editReply({ embeds: [getEmbed()], components: [row()] });
        const collector = msg.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 120_000 });
        collector.on('collect', async btn => {
          await btn.deferUpdate();
          if (btn.customId === 'ly_prev' && current > 0) current--;
          if (btn.customId === 'ly_next' && current < pages.length - 1) current++;
          await interaction.editReply({ embeds: [getEmbed()], components: [row()] });
        });
        collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
        return;
      }

      await interaction.editReply({ embeds: [embed] });
    },
  },

  // ── /download ──────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('download')
      .setDescription('⬇️  Get a Monochrome lossless download link for the current or a specific song')
      .addStringOption(o =>
        o.setName('query').setDescription('Song name or URL (leave blank for current track)')),

    async execute(interaction, client) {
      await interaction.deferReply();

      let track;

      const query = interaction.options.getString('query');
      if (query) {
        try {
          const tracks = await resolve(query, interaction.user.username, interaction.guildId);
          track = tracks[0];
        } catch (err) {
          return interaction.editReply({ embeds: [errorEmbed(`Could not find: ${err.message}`)] });
        }
      } else {
        const player = client.players.get(interaction.guildId);
        if (!player?.currentTrack) {
          return interaction.editReply({ embeds: [errorEmbed('Nothing is playing. Provide a song name or URL.')] });
        }
        track = player.currentTrack;
      }

      if (track?.source !== 'tidal') {
        return interaction.editReply({
          embeds: [errorEmbed('Downloads are only available for TIDAL / Monochrome tracks.')],
        });
      }

      await interaction.editReply({ embeds: [buildDownloadEmbed(track)] });

      try {
        const linkedTrack = await getDownloadLinks(track);
        const buttons = [
          new ButtonBuilder()
            .setLabel('Open in Monochrome')
            .setStyle(ButtonStyle.Link)
            .setURL(linkedTrack.monochromeUrl),
        ];

        if (linkedTrack.tidalUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open in TIDAL')
              .setStyle(ButtonStyle.Link)
              .setURL(linkedTrack.tidalUrl),
          );
        }

        await interaction.editReply({
          embeds: [buildDownloadReadyEmbed(linkedTrack)],
          components: [new ActionRowBuilder().addComponents(...buttons)],
        });
      } catch (err) {
        console.error('[Download]', err);
        await interaction.editReply({ embeds: [errorEmbed(`Download failed: ${err.message}`)], components: [] });
      }
    },
  },

  // ── /remove ────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('remove')
      .setDescription('🗑️  Remove a track from the queue')
      .addIntegerOption(o =>
        o.setName('position').setDescription('Queue position (1-based)').setMinValue(1).setRequired(true)),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player || !player.queue.length) {
        return interaction.reply({ embeds: [errorEmbed('The queue is empty.')], ephemeral: true });
      }
      const pos     = interaction.options.getInteger('position', true);
      const removed = player.remove(pos);
      if (!removed) {
        return interaction.reply({ embeds: [errorEmbed(`Invalid position **${pos}**. Queue has **${player.queue.length}** tracks.`)], ephemeral: true });
      }
      await interaction.reply({ embeds: [successEmbed(`Removed **${removed.title}** from the queue.`)] });
    },
  },

  // ── /move ──────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('move')
      .setDescription('↕️  Move a track within the queue')
      .addIntegerOption(o => o.setName('from').setDescription('Current position').setMinValue(1).setRequired(true))
      .addIntegerOption(o => o.setName('to').setDescription('Target position').setMinValue(1).setRequired(true)),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player || !player.queue.length) {
        return interaction.reply({ embeds: [errorEmbed('The queue is empty.')], ephemeral: true });
      }
      const from = interaction.options.getInteger('from', true);
      const to   = interaction.options.getInteger('to',   true);
      const ok   = player.move(from, to);
      if (!ok) {
        return interaction.reply({ embeds: [errorEmbed('Invalid position(s).')], ephemeral: true });
      }
      await interaction.reply({ embeds: [successEmbed(`Moved track from position **${from}** to **${to}**.`)] });
    },
  },

  // ── /clear ─────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('clear')
      .setDescription('🧹  Clear the queue (keeps the current track)'),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player) return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
      const count = player.queue.length;
      player.clear();
      await interaction.reply({ embeds: [successEmbed(`Cleared **${count}** track${count !== 1 ? 's' : ''} from the queue.`)] });
    },
  },

  // ── /leave ─────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('leave')
      .setDescription('👋  Disconnect the bot from the voice channel'),

    async execute(interaction, client) {
      const player = client.players.get(interaction.guildId);
      if (!player) return interaction.reply({ embeds: [errorEmbed('Not connected to any voice channel.')], ephemeral: true });
      player.destroy();
      client.players.delete(interaction.guildId);
      await interaction.reply({ embeds: [successEmbed('Left the voice channel. 👋')] });
    },
  },

  // ── /join ──────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('join')
      .setDescription('🔗  Join your voice channel without playing anything'),

    async execute(interaction, client) {
      const vc = requireVoice(interaction);
      if (!vc) return;
      const existingPlayer = client.players.get(interaction.guildId);
      const player = existingPlayer ?? getOrCreatePlayer(interaction.guildId, client);
      try {
        await player.connect(vc, interaction.channel);
        await interaction.reply({ embeds: [successEmbed(`Joined **${vc.name}**.`)] });
      } catch (err) {
        if (!existingPlayer) {
          client.players.delete(interaction.guildId);
        }
        await interaction.reply({ embeds: [errorEmbed(err.message)], ephemeral: true });
      }
    },
  },

  // ── /instances ─────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('instances')
      .setDescription('🌐  View or set Hi-Fi API instances (Monochrome backend)')
      .addSubcommand(s =>
        s.setName('list').setDescription('List configured API instances'))
      .addSubcommand(s =>
        s.setName('add')
          .setDescription('Add a custom API instance')
          .addStringOption(o => o.setName('url').setDescription('Instance URL').setRequired(true)))
      .addSubcommand(s =>
        s.setName('reset').setDescription('Reset to default instances')),

    async execute(interaction) {
      const hifi   = require('./hifi');
      const sub    = interaction.options.getSubcommand();
      const { EmbedBuilder } = require('discord.js');

      if (sub === 'list') {
        const list = hifi.getInstances(interaction.guildId);
        const lines = list.map((i, n) =>
          `${i.active ? '✅' : '⬜'} \`${n + 1}.\` ${i.url}${i.active ? ' ← **active**' : ''}`,
        ).join('\n');
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2b2d31)
              .setTitle('🌐  Hi-Fi API Instances')
              .setDescription(lines)
              .setFooter({ text: 'The order applies only to this server. The bot tries each instance until one responds.' }),
          ],
          ephemeral: true,
        });
      }

      if (sub === 'add') {
        if (!requireManageGuild(interaction)) return;

        let url;
        try {
          url = normaliseInstanceUrl(interaction.options.getString('url', true));
        } catch (err) {
          return interaction.reply({ embeds: [errorEmbed(err.message)], ephemeral: true });
        }

        const current = hifi.getInstances(interaction.guildId).map(i => i.url);
        if (current.includes(url)) {
          return interaction.reply({ embeds: [warnEmbed(`\`${url}\` is already in the list.`)], ephemeral: true });
        }
        hifi.setInstances([url, ...current], interaction.guildId);
        return interaction.reply({ embeds: [successEmbed(`Added \`${url}\` as the priority instance for this server.`)], ephemeral: true });
      }

      if (sub === 'reset') {
        if (!requireManageGuild(interaction)) return;
        hifi.resetInstances(interaction.guildId);
        return interaction.reply({ embeds: [successEmbed('Reset this server to the default Hi-Fi API instances.')], ephemeral: true });
      }
    },
  },

  // ── /help ──────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription('📖  Show all commands'),

    async execute(interaction) {
      const { EmbedBuilder } = require('discord.js');
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setAuthor({ name: '🎵  HiFiBot — Command Reference' })
        .setDescription('A Discord music bot that streams from the TIDAL catalog through the Hi-Fi API.')
        .addFields(
          {
            name: '▶️  Playback',
            value: [
              '`/play <query>` — Play a song, TIDAL URL, Monochrome share URL, YouTube video URL, or playlist',
              '`/insert <query> [position]` — Insert a song, URL, or playlist after the current track',
              '`/search <query>` — Search and pick from results',
              '`/pause` — Pause',
              '`/resume` — Resume',
              '`/skip [count]` — Skip one or more tracks',
              '`/stop` — Stop and clear the queue',
              '`/seek <time>` — Seek to position (seconds or mm:ss)',
              '`/nowplaying` — Show current track with progress bar',
            ].join('\n'),
          },
          {
            name: '📋  Queue',
            value: [
              '`/queue [page]` — View the queue',
              '`/remove <pos>` — Remove a track',
              '`/move <from> <to>` — Reorder tracks',
              '`/clear` — Clear the queue',
              '`/shuffle` — Toggle shuffle / shuffle now',
              '`/repeat <off|track|queue>` — Set repeat mode',
              '`/autoplay` — Toggle autoplay recommendations',
            ].join('\n'),
          },
          {
            name: '🎶  Music Tools',
            value: [
              '`/lyrics [song]` — Lyrics with pagination',
              '`/download [query]` — Get a Monochrome lossless download link',
              '`/volume <0-100>` — Set volume',
            ].join('\n'),
          },
          {
            name: '🔗  Connection',
            value: [
              '`/join` — Join your voice channel',
              '`/leave` — Disconnect',
            ].join('\n'),
          },
          {
            name: '📝  Sources',
            value: 'TIDAL catalog via the **Hi-Fi API** (Monochrome backend)\nSupports TIDAL track/album/artist/playlist URLs, Monochrome share URLs, direct YouTube video URLs, or plain search',
          },
          {
            name: '🌐  Instances',
            value: '`/instances list` — view this server\'s API instances\n`/instances add <url>` — add a custom instance for this server\n`/instances reset` — restore this server\'s defaults',
          },
        )
        .setFooter({ text: 'Use slash commands for playback and queue control.' });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

commands.push(createPlaylistCommand({
  addTrackToPlaylist,
  MAX_PLAYLIST_NAME_LENGTH,
  createPlaylist,
  deletePlaylist,
  getOrCreatePlayer,
  getPlaylist,
  getPlaylistSnapshot,
  listPlaylists,
  buildPlaylistDetailEmbed,
  buildPlaylistListEmbed,
  queueEtaText,
  requireVoice,
  resolve,
  savePlaylist,
  errorEmbed,
  successEmbed,
  infoEmbed,
}));

function parseTime(str) {
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  const match = /^(\d+):(\d{2})$/.exec(str);
  if (match) return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  return null;
}

function splitLyrics(lyrics, maxLen) {
  const pages = [];
  let start   = 0;
  while (start < lyrics.length) {
    let end = start + maxLen;
    if (end < lyrics.length) {
      // Try to break at paragraph boundary
      const paraBreak = lyrics.lastIndexOf('\n\n', end);
      if (paraBreak > start) end = paraBreak;
    }
    pages.push(lyrics.slice(start, end).trim());
    start = end;
  }
  return pages;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

function loadCommands(client) {
  for (const cmd of commands) {
    client.commands.set(cmd.data.name, cmd);
  }
  console.log(`[Commands] Loaded ${commands.length} commands.`);
}

function getCommandsJSON() {
  return commands.map(c => c.data.toJSON());
}

module.exports = { loadCommands, getCommandsJSON };
