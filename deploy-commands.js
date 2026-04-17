'use strict';

require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { getCommandsJSON } = require('./src/commands');

const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  console.error('❌  DISCORD_TOKEN and CLIENT_ID must be set in .env');
  process.exit(1);
}

const rest     = new REST({ version: '10' }).setToken(token);
const commands = getCommandsJSON();

(async () => {
  try {
    console.log(`🔄  Deploying ${commands.length} slash commands…`);

    const data = await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands },
    );

    console.log(`✅  Successfully deployed ${data.length} commands globally.`);
    console.log('   Commands will appear in Discord within ~1 hour (global rollout).');
    console.log('   For instant testing, deploy to a specific guild instead:');
    console.log('   Routes.applicationGuildCommands(clientId, guildId)');
  } catch (err) {
    console.error('❌  Deployment failed:', err.message);
    process.exit(1);
  }
})();
