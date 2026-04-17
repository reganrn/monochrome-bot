'use strict';

const { SlashCommandBuilder } = require('discord.js');

function createPlaylistCommand({
  MAX_PLAYLIST_NAME_LENGTH,
  addTrackToPlaylist,
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
}) {
  return {
    data: new SlashCommandBuilder()
      .setName('playlist')
      .setDescription('Save and load server playlists')
      .addSubcommand(s =>
        s.setName('create')
          .setDescription('Create an empty playlist')
          .addStringOption(o =>
            o.setName('name')
              .setDescription('Playlist name')
              .setMinLength(1)
              .setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
              .setRequired(true)))
      .addSubcommand(s =>
        s.setName('add')
          .setDescription('Add a single song to a saved playlist')
          .addStringOption(o =>
            o.setName('name')
              .setDescription('Playlist name')
              .setMinLength(1)
              .setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
              .setRequired(true))
          .addStringOption(o =>
            o.setName('query')
              .setDescription('Song name or track URL')
              .setRequired(true)))
      .addSubcommand(s =>
        s.setName('save')
          .setDescription('Save the current track and queue as a playlist')
          .addStringOption(o =>
            o.setName('name')
              .setDescription('Playlist name')
              .setMinLength(1)
              .setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
              .setRequired(true)))
      .addSubcommand(s =>
        s.setName('load')
          .setDescription('Load a saved playlist into the queue')
          .addStringOption(o =>
            o.setName('name')
              .setDescription('Playlist name')
              .setMinLength(1)
              .setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
              .setRequired(true))
          .addBooleanOption(o =>
            o.setName('replace')
              .setDescription('Replace the current queue and track first')
              .setRequired(false)))
      .addSubcommand(s =>
        s.setName('list')
          .setDescription('List saved playlists for this server'))
      .addSubcommand(s =>
        s.setName('show')
          .setDescription('Show tracks in a saved playlist')
          .addStringOption(o =>
            o.setName('name')
              .setDescription('Playlist name')
              .setMinLength(1)
              .setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
              .setRequired(true)))
      .addSubcommand(s =>
        s.setName('delete')
          .setDescription('Delete a saved playlist')
          .addStringOption(o =>
            o.setName('name')
              .setDescription('Playlist name')
              .setMinLength(1)
              .setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
              .setRequired(true))),

    async execute(interaction, client) {
      const sub = interaction.options.getSubcommand();
      const name = interaction.options.getString('name');

      if (sub === 'create') {
        try {
          const playlist = createPlaylist(interaction.guildId, name, {
            userId: interaction.user.id,
            username: interaction.user.username,
          });

          return interaction.reply({
            embeds: [successEmbed(`Created empty playlist **${playlist.name}**.`)],
            ephemeral: true,
          });
        } catch (err) {
          return interaction.reply({ embeds: [errorEmbed(err.message)], ephemeral: true });
        }
      }

      if (sub === 'add') {
        const query = interaction.options.getString('query', true);

        let tracks;
        try {
          tracks = await resolve(query, interaction.user.username, interaction.guildId);
        } catch (err) {
          return interaction.reply({ embeds: [errorEmbed(`Could not resolve: ${err.message}`)], ephemeral: true });
        }

        if (!tracks.length) {
          return interaction.reply({ embeds: [errorEmbed('No results found.')] , ephemeral: true });
        }

        if (tracks.length !== 1) {
          return interaction.reply({
            embeds: [errorEmbed('`/playlist add` only accepts a single song or track URL.')],
            ephemeral: true,
          });
        }

        try {
          const playlist = addTrackToPlaylist(interaction.guildId, name, tracks[0], {
            userId: interaction.user.id,
            username: interaction.user.username,
          });

          return interaction.reply({
            embeds: [
              successEmbed(
                `Added **${tracks[0].title}** to **${playlist.name}**.\nPlaylist now has **${playlist.trackCount}** track${playlist.trackCount !== 1 ? 's' : ''}.`,
              ),
            ],
            ephemeral: true,
          });
        } catch (err) {
          return interaction.reply({ embeds: [errorEmbed(err.message)], ephemeral: true });
        }
      }

      if (sub === 'save') {
        const player = client.players.get(interaction.guildId);
        const snapshot = getPlaylistSnapshot(player);
        if (!snapshot.length) {
          return interaction.reply({ embeds: [errorEmbed('Nothing is queued right now. Start playback before saving a playlist.')], ephemeral: true });
        }

        try {
          const { created, playlist } = savePlaylist(interaction.guildId, name, snapshot, {
            userId: interaction.user.id,
            username: interaction.user.username,
          });

          return interaction.reply({
            embeds: [
              successEmbed(
                `${created ? 'Saved' : 'Updated'} playlist **${playlist.name}** with **${playlist.trackCount}** track${playlist.trackCount !== 1 ? 's' : ''}.`,
              ),
            ],
            ephemeral: true,
          });
        } catch (err) {
          return interaction.reply({ embeds: [errorEmbed(err.message)], ephemeral: true });
        }
      }

      if (sub === 'list') {
        const playlists = listPlaylists(interaction.guildId);
        if (!playlists.length) {
          return interaction.reply({ embeds: [infoEmbed('No saved playlists for this server yet.')], ephemeral: true });
        }

        return interaction.reply({ embeds: [buildPlaylistListEmbed(playlists)], ephemeral: true });
      }

      if (sub === 'show') {
        const playlist = getPlaylist(interaction.guildId, name);
        if (!playlist) {
          return interaction.reply({ embeds: [errorEmbed(`Playlist **${name}** was not found.`)], ephemeral: true });
        }

        return interaction.reply({ embeds: [buildPlaylistDetailEmbed(playlist)], ephemeral: true });
      }

      if (sub === 'delete') {
        const removed = deletePlaylist(interaction.guildId, name);
        if (!removed) {
          return interaction.reply({ embeds: [errorEmbed(`Playlist **${name}** was not found.`)], ephemeral: true });
        }

        return interaction.reply({
          embeds: [successEmbed(`Deleted playlist **${removed.name}**.`)],
          ephemeral: true,
        });
      }

      if (sub === 'load') {
        const playlist = getPlaylist(interaction.guildId, name);
        if (!playlist) {
          return interaction.reply({ embeds: [errorEmbed(`Playlist **${name}** was not found.`)], ephemeral: true });
        }
        if (!playlist.trackCount) {
          return interaction.reply({ embeds: [errorEmbed(`Playlist **${playlist.name}** is empty. Add songs with \`/playlist add\` first.`)], ephemeral: true });
        }

        const vc = requireVoice(interaction);
        if (!vc) return;

        await interaction.deferReply();

        const replace = interaction.options.getBoolean('replace') ?? false;
        const player = getOrCreatePlayer(interaction.guildId, client);

        if (!player.connection || player.voiceChannel?.id !== vc.id) {
          try {
            await player.connect(vc, interaction.channel);
          } catch (err) {
            return interaction.editReply({ embeds: [errorEmbed(err.message)] });
          }
        }
        player.textChannel = interaction.channel;

        if (replace) {
          player.stop();
        }

        const tracks = playlist.tracks.map(track => ({
          ...track,
          requestedBy: interaction.user.username,
        }));

        try {
          const { added, playing, skipped } = await player.addTracks(tracks, false);
          const startPos = replace
            ? 1
            : Math.max(1, player.queue.length - added + 1);
          const eta = !playing ? queueEtaText(player, startPos) : null;

          return interaction.editReply({
            embeds: [
              successEmbed(
                `Loaded **${playlist.name}** with **${added}** track${added !== 1 ? 's' : ''}.` +
                (replace
                  ? '\nReplaced the current queue.'
                  : `\nAdded from position **#${startPos}** onwards.`) +
                (playing ? '\nStarted playing.' : '') +
                (eta ? `\nEstimated start: **${eta}**` : '') +
                (skipped ? `\nSkipped **${skipped}** unavailable track${skipped !== 1 ? 's' : ''}.` : ''),
              ),
            ],
          });
        } catch (err) {
          return interaction.editReply({ embeds: [errorEmbed(err.message)] });
        }
      }

      return interaction.reply({ embeds: [errorEmbed('Unknown playlist action.')], ephemeral: true });
    },
  };
}

module.exports = { createPlaylistCommand };
