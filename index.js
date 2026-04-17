'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { loadCommands } = require('./src/commands');

// ─── Client setup ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.commands = new Collection();   // commandName → command
client.players  = new Map();          // guildId     → GuildPlayer

loadCommands(client);

// ─── Events ───────────────────────────────────────────────────────────────────

client.once('clientReady', () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`🎵  HiFiBot — serving ${client.guilds.cache.size} guild(s)`);

  client.user.setActivity('music 🎵 | /play', { type: 2 /* Listening */ });
});

// ── Interactions ────────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction, client);
    } catch (err) {
      console.error(`[Command:${interaction.commandName}]`, err);
      const msg = { content: '❌  An unexpected error occurred.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg).catch(() => {});
      } else {
        await interaction.reply(msg).catch(() => {});
      }
    }
    return;
  }

  // Button interactions (controls row)
  if (interaction.isButton()) {
    const id = interaction.customId;

    // Queue pagination
    if (id.startsWith('queue_')) {
      const player = client.players.get(interaction.guildId);
      const [, dir, pageStr] = id.split('_');
      const page = parseInt(pageStr, 10) + (dir === 'next' ? 1 : -1);
      if (!player) return interaction.update({ components: [] });
      const { buildQueueEmbed } = require('./src/embeds');
      const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
      const { embed, pages } = buildQueueEmbed(player, page);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`queue_prev_${page}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
        new ButtonBuilder().setCustomId(`queue_next_${page}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
      );
      return interaction.update({ embeds: [embed], components: [row] });
    }
    return;
  }
});

// ── Voice state updates ──────────────────────────────────────────────────────

client.on('voiceStateUpdate', (oldState, newState) => {
  const player = client.players.get(oldState.guild.id);
  if (!player) return;

  // Bot was disconnected externally
  if (oldState.member.id === client.user.id && !newState.channelId) {
    player.destroy();
    client.players.delete(oldState.guild.id);
    return;
  }

  // Check if bot is alone in its channel
  if (!player.voiceChannel) return;
  const botChannel = player.voiceChannel;
  const humanCount = botChannel.members.filter(m => !m.user.bot).size;

  if (humanCount === 0) {
    player.startAloneTimer();
  } else {
    player.cancelAloneTimer();
  }
});

// Destroy player when bot leaves guild
client.on('guildDelete', guild => {
  const player = client.players.get(guild.id);
  if (player) {
    player.destroy();
    client.players.delete(guild.id);
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────

if (!process.env.DISCORD_TOKEN) {
  console.error('❌  DISCORD_TOKEN is not set in .env');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
