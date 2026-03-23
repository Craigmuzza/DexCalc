// deploy.js — Slash command registration
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { TOKEN, GUILD_IDS } = require('./config');

async function deploySlash(client) {
  try {
    const rest  = new REST({ version: '10' }).setToken(TOKEN);
    const appId = client.application?.id;
    if (!appId) {
      console.error('[deploy] Application ID not ready.');
      return;
    }

    // ─── Soul Wars Commands ───

    const swCalc = new SlashCommandBuilder()
      .setName('swcalc')
      .setDescription('Soul Wars calculator — single skill')
      .toJSON();

    const swQuote = new SlashCommandBuilder()
      .setName('swquote')
      .setDescription('Soul Wars multi-skill quote from RSN lookup')
      .addStringOption(opt =>
        opt.setName('rsn')
          .setDescription('RuneScape name to look up')
          .setRequired(true)
          .setMaxLength(12))
      .addStringOption(opt =>
        opt.setName('account_type')
          .setDescription('Account type for pricing')
          .setRequired(false)
          .addChoices(
            { name: 'Non-10 HP (40k gp/zeal)', value: 'non10hp' },
            { name: '10 HP (50k gp/zeal)',      value: '10hp' }
          ))
      .addIntegerOption(opt =>
        opt.setName('target_level')
          .setDescription('Target level (default 99)')
          .setRequired(false)
          .setMinValue(31)
          .setMaxValue(99))
      .toJSON();

    // ─── CRM Commands ───

    const paid = new SlashCommandBuilder()
      .setName('paid')
      .setDescription('Record a customer payment (staff only)')
      .addUserOption(opt =>
        opt.setName('user')
          .setDescription('The customer who paid')
          .setRequired(true))
      .addNumberOption(opt =>
        opt.setName('amount')
          .setDescription('Amount in USD (e.g. 250)')
          .setRequired(true)
          .setMinValue(0.01))
      .addStringOption(opt =>
        opt.setName('note')
          .setDescription('Optional note (e.g. "Strength 30-99")')
          .setRequired(false)
          .setMaxLength(200))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON();

    const refund = new SlashCommandBuilder()
      .setName('refund')
      .setDescription('Record a customer refund (staff only)')
      .addUserOption(opt =>
        opt.setName('user')
          .setDescription('The customer to refund')
          .setRequired(true))
      .addNumberOption(opt =>
        opt.setName('amount')
          .setDescription('Refund amount in USD')
          .setRequired(true)
          .setMinValue(0.01))
      .addStringOption(opt =>
        opt.setName('note')
          .setDescription('Reason for refund')
          .setRequired(false)
          .setMaxLength(200))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON();

    const customer = new SlashCommandBuilder()
      .setName('customer')
      .setDescription('Full CRM profile for a customer')
      .addUserOption(opt =>
        opt.setName('user')
          .setDescription('The customer to look up')
          .setRequired(true))
      .toJSON();

    const totalSpent = new SlashCommandBuilder()
      .setName('totalspent')
      .setDescription('Quick check — customer total spend')
      .addUserOption(opt =>
        opt.setName('user')
          .setDescription('The customer to look up')
          .setRequired(true))
      .toJSON();

    const leaderboard = new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show top spenders')
      .addIntegerOption(opt =>
        opt.setName('limit')
          .setDescription('Number of entries (default 10)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(25))
      .toJSON();

    const revenue = new SlashCommandBuilder()
      .setName('revenue')
      .setDescription('Monthly revenue breakdown (staff only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON();

    const syncranks = new SlashCommandBuilder()
      .setName('syncranks')
      .setDescription('Bulk-assign rank roles to all customers (staff only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON();

    const payment = new SlashCommandBuilder()
      .setName('payment')
      .setDescription('Get payment instructions for a specific method')
      .addStringOption(opt =>
        opt.setName('method')
          .setDescription('Payment method')
          .setRequired(true)
          .addChoices(
            { name: 'Bitcoin (BTC)', value: 'BTC' },
            { name: 'Litecoin (LTC)', value: 'LTC' },
            { name: 'Ethereum (ETH)', value: 'ETH' },
            { name: 'PayPal', value: 'PayPal' },
            { name: 'Wise', value: 'Wise' },
            { name: 'Australian Bank Transfer', value: 'Aus_Bank_Transfer' },
            { name: 'GP (In-Game)', value: 'GP' }
          ))
      .toJSON();

    // ─── Raffle Commands ───

    const raffle = new SlashCommandBuilder()
      .setName('raffle')
      .setDescription('Create a new raffle (staff only)')
      .addStringOption(opt =>
        opt.setName('title').setDescription('Raffle title').setRequired(true).setMaxLength(80))
      .addIntegerOption(opt =>
        opt.setName('tickets').setDescription('Total number of tickets').setRequired(true).setMinValue(1).setMaxValue(500))
      .addStringOption(opt =>
        opt.setName('prize1').setDescription('1st place prize').setRequired(true).setMaxLength(100))
      .addStringOption(opt =>
        opt.setName('prize2').setDescription('2nd place prize').setRequired(false).setMaxLength(100))
      .addStringOption(opt =>
        opt.setName('prize3').setDescription('3rd place prize').setRequired(false).setMaxLength(100))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON();

    const rgive = new SlashCommandBuilder()
      .setName('rgive')
      .setDescription('Give raffle tickets to a user (staff only)')
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to give tickets to').setRequired(true))
      .addIntegerOption(opt =>
        opt.setName('amount').setDescription('Number of tickets').setRequired(true).setMinValue(1).setMaxValue(100))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON();

    const rtake = new SlashCommandBuilder()
      .setName('rtake')
      .setDescription('Remove raffle tickets from a user (staff only)')
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to remove tickets from').setRequired(true))
      .addIntegerOption(opt =>
        opt.setName('amount').setDescription('Number of tickets to remove').setRequired(true).setMinValue(1).setMaxValue(100))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON();

    const rcancel = new SlashCommandBuilder()
      .setName('rcancel')
      .setDescription('Cancel the active raffle (staff only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON();

    const rroll = new SlashCommandBuilder()
      .setName('rroll')
      .setDescription('Force roll the active raffle now (staff only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON();

    const rstatus = new SlashCommandBuilder()
      .setName('rstatus')
      .setDescription('Show the current raffle status')
      .toJSON();

    const commands = [swCalc, swQuote, paid, refund, customer, totalSpent, leaderboard, revenue, syncranks, payment, raffle, rgive, rtake, rcancel, rroll, rstatus];

    console.log(`[deploy] GUILD_IDS: ${GUILD_IDS.join(', ') || '(none — global)'}`);

    // Clear old global commands
    try {
      await rest.put(Routes.applicationCommands(appId), { body: [] });
      console.log('[deploy] Cleared global commands');
    } catch (e) {
      console.error('[deploy] Failed to clear global commands:', e.message);
    }

    if (GUILD_IDS.length) {
      for (const gid of GUILD_IDS) {
        try {
          await rest.put(Routes.applicationGuildCommands(appId, gid), { body: commands });
          console.log(`[deploy] Registered ${commands.length} command(s) in guild ${gid}`);
        } catch (e) {
          console.error(`[deploy] Failed in guild ${gid}:`, e?.code || e?.status || e?.message || e);
        }
      }
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: commands });
      console.log(`[deploy] Registered ${commands.length} command(s) globally`);
    }
  } catch (err) {
    console.error('[deploy] deploySlash error:', err);
  }
}

module.exports = { deploySlash };
