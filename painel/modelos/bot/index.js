import { Client, Events, GatewayIntentBits } from 'discord.js';

// Lê o DISCORD_TOKEN do arquivo .env (nunca coloque o token direto no código)
process.loadEnvFile(new URL('./.env', import.meta.url));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set([
    { name: 'ping', description: 'Responde com pong e a latência' },
  ]);
  console.log(`Bot online como ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'ping') {
    await interaction.reply(`Pong! ${client.ws.ping}ms`);
  }
});

client.login(process.env.DISCORD_TOKEN);
