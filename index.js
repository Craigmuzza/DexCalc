// index.js — DexCalc Bot Entry Point
// Soul Wars XP/zeal Calculator + Ticket Flow + Multi-Skill Quote + Customer Spend Tracking
//
// Commands:
//   /swcalc      — Single-skill calculator with modal input
//   /swquote     — Multi-skill quote from RSN lookup
//   /payment     — Payment instructions (BTC, LTC, ETH, PayPal, Wise, GP)
//   /paid        — Record a customer payment → Google Sheets (staff only)
//   /refund      — Record a customer refund (staff only)
//   /customer    — Full CRM profile for a customer
//   /totalspent  — Quick total spend lookup
//   /leaderboard — Top spenders leaderboard
//   /revenue     — Monthly revenue dashboard (staff only)
//
// All interactions use defer → edit pattern to survive Render cold starts.

const http = require('http');
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');

// ───────── Modules ─────────
const { TOKEN, DEPLOY_SLASH, VALID_SKILLS, THEME_COLOR, LOGO_URL, WATERMARK_URL, PAID_COMMAND_ROLES, SUPPORT_ROLE_ID, PAYMENT_METHODS } = require('./config');
const { getPlayerStats }      = require('./hiscores');
const { deploySlash }         = require('./deploy');
const {
  fmtInt,
  getXPForLevel,
  getLevel,
  gpCost,
  skillToHiscoreKey,
  calcSoulWarsPlan,
  calcPlanByDay,
  calcMultiSkillQuote
} = require('./calculator');
const {
  buildInfoEmbed,
  buildBannerEmbed,
  buildPaymentEmbed,
  buildTicketCreatedEmbed,
  buildLauncherEmbed,
  buildQuoteEmbed,
  buildTextFileAttachment
} = require('./embeds');
const {
  buildActionRow,
  buildToggleRow,
  buildPaymentCopyRow,
  buildPaymentMethodCopyRow,
  buildBalloonTicketButton,
  buildRaffleTicketButton,
  buildCloseRow,
  buildTicketEphemeralRow,
  buildLauncherRows,
  buildDisabledLauncherRows,
  buildInputModal,
  readCurrentSelections
} = require('./components');
const {
  getActive:      getRaffle,
  createRaffle,
  assignTickets,
  removeTickets,
  rollWinners,
  cancelRaffle
} = require('./raffle');
const {
  getActive:      getBalloonEvent,
  createEvent:    createBalloonEvent,
  giveTicket:     giveBalloonTicket,
  takeTicket:     takeBalloonTicket,
  cancelEvent:    cancelBalloonEvent
} = require('./balloon');
const {
  addActiveTicket,
  getActiveTicket,
  removeActiveTicketByChannelId,
  openTicketChannel,
  closeTicketChannel,
  closeTicketById
} = require('./tickets');
const {
  initSheets,
  addCustomer,
  recordPayment,
  recordRefund,
  getCustomer,
  getAllCustomers,
  getTransactions,
  getRevenueStats,
  getTier,
  fmtUSD,
  CUSTOMER_TIERS
} = require('./sheets');

// ───────── Health Server (Render compatibility) ─────────
const PORT = process.env.PORT || 10000;
http
  .createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK\n'); })
  .listen(PORT, () => console.log(`[health] Listening on port ${PORT}`));

// ───────── Discord Client ─────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers  // Required for guildMemberAdd (auto-add to spreadsheet)
  ],
  partials: [Partials.Channel]
});

// ───────── Logging helper ─────────
const log = (tag, msg) => console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);

// Track whether Sheets integration is active
let sheetsEnabled = false;

// ───────── Permission Check for /paid ─────────
function canUsePaidCommand(member) {
  // Server owner can always use it
  if (member.guild.ownerId === member.id) return true;
  // Check ManageGuild permission
  if (member.permissions?.has('ManageGuild')) return true;
  // Check SUPPORT_ROLE_ID
  if (SUPPORT_ROLE_ID && member.roles?.cache?.has(SUPPORT_ROLE_ID)) return true;
  // Check configured PAID_COMMAND_ROLES
  if (PAID_COMMAND_ROLES.length && PAID_COMMAND_ROLES.some(r => member.roles?.cache?.has(r))) return true;
  return false;
}

// ───────── Auto-Role Assignment ─────────
// Ensures the member has EXACTLY the correct rank role (removes all others)
async function ensureRankRole(guild, userId, targetTier, reason = 'Rank sync') {
  const allTierRoleIds = CUSTOMER_TIERS.map(t => t.roleId).filter(Boolean);
  if (!allTierRoleIds.length) {
    log('roles', `SKIP: No role IDs configured. Set TIER_ROLE_IDS env var.`);
    return null;
  }

  if (!targetTier?.roleId) {
    log('roles', `SKIP: Target tier "${targetTier?.name}" has no roleId mapped.`);
    return null;
  }

  try {
    const member = await guild.members.fetch(userId);

    // Check if they already have the correct role and ONLY the correct role
    const currentTierRoles = allTierRoleIds.filter(id => member.roles.cache.has(id));
    const alreadyCorrect = currentTierRoles.length === 1
      && currentTierRoles[0] === targetTier.roleId;

    if (alreadyCorrect) return null; // nothing to do

    // Remove ALL tier roles first (clean slate)
    if (currentTierRoles.length) {
      await member.roles.remove(currentTierRoles, reason);
      log('roles', `${member.user.username}: removed ${currentTierRoles.length} old rank role(s)`);
    }

    // Add the correct tier role
    await member.roles.add(targetTier.roleId, reason);
    log('roles', `${member.user.username} → ${targetTier.emoji} ${targetTier.name} (${reason})`);
    return targetTier;
  } catch (err) {
    log('roles', `FAILED for ${userId}: ${err.message}`);
    return null;
  }
}

// ───────── Build Full Calculation Payload ─────────
function buildSWCalculationPayload(i, { startXP, targetLevel, skill, acctType, rsn }) {
  const result = calcSoulWarsPlan(startXP, targetLevel, skill);
  const info   = buildInfoEmbed(i, { skill, startXP, targetLevel, acctType, rsn }, result, 'band');
  const banner = buildBannerEmbed();

  const rsnPart = rsn ? `|${encodeURIComponent(rsn)}` : '';
  const ctx = `swv3|${startXP}|${targetLevel}|${skill}|${acctType}${rsnPart}`;
  const row = buildActionRow(ctx, 'band');

  return { embeds: [info, banner], components: [row] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// READY
// ═══════════════════════════════════════════════════════════════════════════════
client.once('clientReady', async () => {
  log('bot', `Logged in as ${client.user.tag} (${client.application.id})`);

  // Initialise Google Sheets
  sheetsEnabled = await initSheets();
  if (sheetsEnabled) log('bot', 'Google Sheets integration active');
  else log('bot', 'Google Sheets integration disabled (check config)');

  // Log tier role config status
  const configuredRoles = CUSTOMER_TIERS.filter(t => t.roleId).length;
  log('bot', `Rank roles: ${configuredRoles}/${CUSTOMER_TIERS.length} configured ${configuredRoles === 0 ? '⚠️ Set TIER_ROLE_IDS env var!' : '✅'}`);

  if (DEPLOY_SLASH) await deploySlash(client);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-ADD NEW MEMBERS TO SPREADSHEET
// ═══════════════════════════════════════════════════════════════════════════════
client.on('guildMemberAdd', async member => {
  if (!sheetsEnabled) return;
  if (member.user.bot) return; // skip bots

  try {
    const result = await addCustomer(member.id, member.user.username, member.displayName);
    if (result.isNew) {
      log('sheets', `Auto-added new member: ${member.user.username} (${member.id})`);
    }
    // Assign their rank role based on spend (Street Runner for new, or existing rank if returning)
    const totalSpent = result.totalSpent || 0;
    const tier = getTier(totalSpent);
    await ensureRankRole(member.guild, member.id, tier, 'New member join');
  } catch (err) {
    log('sheets', `Failed to auto-add ${member.user.username}: ${err.message}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTERACTION HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
client.on('interactionCreate', async i => {
  log('interaction', `${i.id} | Type: ${i.type} | ${i.commandName || i.customId || 'N/A'}`);

  try {
    // ─────────────────────────────────────────────────────────
    // /swcalc — launcher (ephemeral with selects)
    // ─────────────────────────────────────────────────────────
    if (i.isChatInputCommand() && i.commandName === 'swcalc') {
      await i.deferReply({ ephemeral: true });

      const info   = buildLauncherEmbed(i);
      const banner = buildBannerEmbed();
      const rows   = buildLauncherRows();

      await i.editReply({ embeds: [info, banner], components: rows });
      return;
    }

    // ─────────────────────────────────────────────────────────
    // /swquote — multi-skill quote from RSN
    // ─────────────────────────────────────────────────────────
    if (i.isChatInputCommand() && i.commandName === 'swquote') {
      await i.deferReply();

      const rsn         = i.options.getString('rsn');
      const acctType    = i.options.getString('account_type') || 'non10hp';
      const targetLevel = i.options.getInteger('target_level') || 99;

      if (!rsn) return i.editReply({ content: 'Please provide a RuneScape name.' });

      try {
        log('swquote', `Looking up ${rsn}`);
        const stats = await getPlayerStats(rsn);
        const quote = calcMultiSkillQuote(stats, targetLevel, acctType, VALID_SKILLS);
        const embed = buildQuoteEmbed(i, rsn, acctType, targetLevel, quote);
        const banner = buildBannerEmbed();

        await i.editReply({ embeds: [embed, banner] });
      } catch (err) {
        log('swquote', `Error: ${err.message}`);
        await i.editReply({ content: `Could not look up **${rsn}**: ${err.message}` });
      }
      return;
    }

    // ─────────────────────────────────────────────────────────
    // /paid @user amount — Record a payment (staff only)
    // ─────────────────────────────────────────────────────────
    if (i.isChatInputCommand() && i.commandName === 'paid') {
      await i.deferReply();

      if (!sheetsEnabled) return i.editReply({ content: 'Google Sheets integration is not configured.' });
      if (!canUsePaidCommand(i.member)) return i.editReply({ content: 'You do not have permission to use this command.' });

      const targetUser = i.options.getUser('user');
      const amount     = i.options.getNumber('amount');
      const note       = i.options.getString('note') || '';

      if (!targetUser) return i.editReply({ content: 'Please mention a valid user.' });

      try {
        let displayName = targetUser.username;
        try { const m = await i.guild.members.fetch(targetUser.id); displayName = m.displayName; } catch {}

        const result = await recordPayment(targetUser.id, targetUser.username, displayName, amount, note, i.user.username);

        // Always ensure correct rank role (assigns if missing, upgrades on rank up)
        const roleUpdated = await ensureRankRole(i.guild, targetUser.id, result.tier, result.tierUp ? 'Rank up' : 'Payment sync');

        const tierUpText = result.tierUp
          ? `\n\n🎉 **RANK UP!** ${result.previousTier.emoji} ${result.previousTier.name} → ${result.tier.emoji} ${result.tier.name}${roleUpdated ? '\n✅ Role updated automatically' : ''}`
          : '';

        const embed = new EmbedBuilder()
          .setColor(result.tierUp ? 0xffd700 : 0x00cc44)
          .setAuthor({ name: 'Payment Recorded', iconURL: LOGO_URL })
          .setTitle(`💰 Payment Logged — ${fmtUSD(amount)}`)
          .setDescription([
            `**Customer:** <@${targetUser.id}> (${targetUser.username})`,
            `**Amount:** ${fmtUSD(amount)}`,
            `**New total:** ${fmtUSD(result.newTotal)} _(was ${fmtUSD(result.previousTotal)})_`,
            `**Purchase #:** ${result.purchaseCount}`,
            `**Rank:** ${result.tier.emoji} ${result.tier.name}`,
            note ? `**Note:** ${note}` : '',
            tierUpText
          ].filter(Boolean).join('\n'))
          .setThumbnail(WATERMARK_URL)
          .setFooter({ text: `Logged by ${i.user.username}`, iconURL: LOGO_URL })
          .setTimestamp();

        await i.editReply({ embeds: [embed] });
        log('paid', `${i.user.username} recorded ${fmtUSD(amount)} for ${targetUser.username} → ${fmtUSD(result.newTotal)} (${result.tier.name})`);
      } catch (err) {
        log('paid', `Error: ${err.message}`);
        await i.editReply({ content: `Failed to record payment: ${err.message}` });
      }
      return;
    }

    // ─────────────────────────────────────────────────────────
    // /refund @user amount — Record a refund (staff only)
    // ─────────────────────────────────────────────────────────
    if (i.isChatInputCommand() && i.commandName === 'refund') {
      await i.deferReply();

      if (!sheetsEnabled) return i.editReply({ content: 'Google Sheets integration is not configured.' });
      if (!canUsePaidCommand(i.member)) return i.editReply({ content: 'You do not have permission to use this command.' });

      const targetUser = i.options.getUser('user');
      const amount     = i.options.getNumber('amount');
      const note       = i.options.getString('note') || '';

      if (!targetUser) return i.editReply({ content: 'Please mention a valid user.' });

      try {
        let displayName = targetUser.username;
        try { const m = await i.guild.members.fetch(targetUser.id); displayName = m.displayName; } catch {}

        const result = await recordRefund(targetUser.id, targetUser.username, displayName, amount, note, i.user.username);

        if (!result) return i.editReply({ content: `**${targetUser.username}** has no records to refund.` });

        // Always ensure correct rank role after refund
        const prevTier = getTier(result.previousTotal);
        await ensureRankRole(i.guild, targetUser.id, result.tier, 'Refund adjustment');

        const tierChangeText = prevTier.name !== result.tier.name
          ? `\n⚠️ Rank changed: ${prevTier.emoji} ${prevTier.name} → ${result.tier.emoji} ${result.tier.name}`
          : '';

        const embed = new EmbedBuilder()
          .setColor(0xff6600)
          .setAuthor({ name: 'Refund Recorded', iconURL: LOGO_URL })
          .setTitle(`🔄 Refund — ${fmtUSD(amount)}`)
          .setDescription([
            `**Customer:** <@${targetUser.id}> (${targetUser.username})`,
            `**Refunded:** ${fmtUSD(amount)}`,
            `**New total:** ${fmtUSD(result.newTotal)} _(was ${fmtUSD(result.previousTotal)})_`,
            `**Rank:** ${result.tier.emoji} ${result.tier.name}`,
            note ? `**Reason:** ${note}` : '',
            tierChangeText
          ].filter(Boolean).join('\n'))
          .setFooter({ text: `Processed by ${i.user.username}`, iconURL: LOGO_URL })
          .setTimestamp();

        await i.editReply({ embeds: [embed] });
        log('refund', `${i.user.username} refunded ${fmtUSD(amount)} for ${targetUser.username}`);
      } catch (err) {
        log('refund', `Error: ${err.message}`);
        await i.editReply({ content: `Failed to record refund: ${err.message}` });
      }
      return;
    }

    // ─────────────────────────────────────────────────────────
    // /customer @user — Full CRM profile
    // ─────────────────────────────────────────────────────────
    if (i.isChatInputCommand() && i.commandName === 'customer') {
      await i.deferReply();

      if (!sheetsEnabled) return i.editReply({ content: 'Google Sheets integration is not configured.' });

      const targetUser = i.options.getUser('user');
      if (!targetUser) return i.editReply({ content: 'Please mention a valid user.' });

      try {
        const customer = await getCustomer(targetUser.id);

        if (!customer) {
          return i.editReply({ content: `**${targetUser.username}** has no CRM record yet. They'll be added on their next interaction.` });
        }

        const tier = customer.tierObj;
        const recentTx = await getTransactions(targetUser.id, 5);
        const txLines = recentTx.length
          ? recentTx.map(tx => {
              const dateShort = tx.date.split(' ')[0];
              const sign = tx.amount < 0 ? '' : '+';
              return `\`${dateShort}\` ${sign}${fmtUSD(tx.amount)}${tx.note ? ` — ${tx.note}` : ''}`;
            }).join('\n')
          : '_No transactions yet_';

        // Find next tier
        const tierIdx = CUSTOMER_TIERS.findIndex(t => t.name === tier.name);
        const nextTier = CUSTOMER_TIERS[tierIdx + 1] || null;
        const tierProgress = nextTier
          ? `${fmtUSD(customer.totalSpent)} / ${fmtUSD(nextTier.minSpend)} to ${nextTier.emoji} ${nextTier.name}`
          : '🏆 Max rank reached!';

        const embed = new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setAuthor({ name: 'Customer Profile', iconURL: LOGO_URL })
          .setTitle(`${tier.emoji} ${customer.displayName || customer.username}`)
          .setDescription([
            `**Discord:** <@${customer.discordId}>`,
            `**Rank:** ${tier.emoji} ${tier.name}`,
            `**Status:** ${customer.liveStatus}`,
            `**Member since:** ${customer.joinDate || 'Unknown'}`
          ].join('\n'))
          .addFields(
            { name: '💰 Total Spent',   value: fmtUSD(customer.totalSpent),        inline: true },
            { name: '🛒 Purchases',      value: String(customer.purchaseCount),      inline: true },
            { name: '📊 Avg Purchase',   value: fmtUSD(customer.avgPurchase),        inline: true },
            { name: '📅 First Purchase', value: customer.firstPurchase || 'N/A',     inline: true },
            { name: '📅 Last Purchase',  value: customer.lastPurchaseDate || 'N/A',  inline: true },
            { name: '💵 Last Amount',    value: customer.lastPurchaseAmt > 0 ? fmtUSD(customer.lastPurchaseAmt) : 'N/A', inline: true },
            { name: '⏳ Days Inactive',  value: customer.daysInactive > 0 ? `${customer.daysInactive} days` : 'N/A', inline: true },
            { name: '🎯 Next Rank',      value: tierProgress, inline: false }
          )
          .addFields({ name: '📝 Recent Transactions', value: txLines })
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setFooter({ text: `Requested by ${i.user.username}`, iconURL: LOGO_URL })
          .setTimestamp();

        await i.editReply({ embeds: [embed] });
      } catch (err) {
        log('customer', `Error: ${err.message}`);
        await i.editReply({ content: `Failed to load profile: ${err.message}` });
      }
      return;
    }

    // ─────────────────────────────────────────────────────────
    // /totalspent @user — Quick total lookup
    // ─────────────────────────────────────────────────────────
    if (i.isChatInputCommand() && i.commandName === 'totalspent') {
      await i.deferReply();

      if (!sheetsEnabled) return i.editReply({ content: 'Google Sheets integration is not configured.' });

      const targetUser = i.options.getUser('user');
      if (!targetUser) return i.editReply({ content: 'Please mention a valid user.' });

      try {
        const customer = await getCustomer(targetUser.id);

        if (!customer) {
          return i.editReply({ content: `**${targetUser.username}** has no records in the system yet.` });
        }

        const tier = customer.tierObj;

        const embed = new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setAuthor({ name: 'Total Spent', iconURL: LOGO_URL })
          .setTitle(`${tier.emoji} ${targetUser.username}`)
          .setDescription([
            `**Total spent:** ${fmtUSD(customer.totalSpent)}`,
            `**Rank:** ${tier.emoji} ${tier.name}`,
            `**Purchases:** ${customer.purchaseCount}`,
            customer.lastPurchaseDate ? `**Last purchase:** ${customer.lastPurchaseDate}` : ''
          ].filter(Boolean).join('\n'))
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setFooter({ text: `Requested by ${i.user.username}`, iconURL: LOGO_URL })
          .setTimestamp();

        await i.editReply({ embeds: [embed] });
      } catch (err) {
        log('totalspent', `Error: ${err.message}`);
        await i.editReply({ content: `Failed to look up spend data: ${err.message}` });
      }
      return;
    }

    // ─────────────────────────────────────────────────────────
    // /leaderboard — Top spenders
    // ─────────────────────────────────────────────────────────
    if (i.isChatInputCommand() && i.commandName === 'leaderboard') {
      await i.deferReply();

      if (!sheetsEnabled) return i.editReply({ content: 'Google Sheets integration is not configured.' });

      const limit = i.options.getInteger('limit') || 10;

      try {
        const customers = await getAllCustomers();
        const top = customers.filter(c => c.totalSpent > 0).slice(0, limit);

        if (!top.length) return i.editReply({ content: 'No customer spend data yet.' });

        const medals = ['🥇', '🥈', '🥉'];
        const lines = top.map((c, idx) => {
          const prefix = medals[idx] || `**${idx + 1}.**`;
          const tier = getTier(c.totalSpent);
          return `${prefix} ${tier.emoji} **${c.displayName || c.username}** — ${fmtUSD(c.totalSpent)} _(${c.purchaseCount} purchases)_`;
        });

        const totalRevenue = customers.reduce((sum, c) => sum + c.totalSpent, 0);
        const payingCustomers = customers.filter(c => c.totalSpent > 0).length;

        const embed = new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setAuthor({ name: 'Customer Leaderboard', iconURL: LOGO_URL })
          .setTitle('🏆 Top Spenders')
          .setDescription(lines.join('\n'))
          .addFields(
            { name: '💵 Total Revenue',    value: fmtUSD(totalRevenue),       inline: true },
            { name: '👥 Paying Customers', value: String(payingCustomers),     inline: true },
            { name: '📊 Avg per Customer', value: payingCustomers > 0 ? fmtUSD(totalRevenue / payingCustomers) : '$0.00', inline: true }
          )
          .setThumbnail(WATERMARK_URL)
          .setFooter({ text: `Requested by ${i.user.username}`, iconURL: LOGO_URL })
          .setTimestamp();

        await i.editReply({ embeds: [embed] });
      } catch (err) {
        log('leaderboard', `Error: ${err.message}`);
        await i.editReply({ content: `Failed to load leaderboard: ${err.message}` });
      }
      return;
    }

    // ─────────────────────────────────────────────────────────
    // /revenue — Monthly revenue breakdown (staff only)
    // ─────────────────────────────────────────────────────────
    if (i.isChatInputCommand() && i.commandName === 'revenue') {
      await i.deferReply();

      if (!sheetsEnabled) return i.editReply({ content: 'Google Sheets integration is not configured.' });
      if (!canUsePaidCommand(i.member)) return i.editReply({ content: 'You do not have permission to use this command.' });

      try {
        const stats = await getRevenueStats();

        if (stats.txCount === 0) return i.editReply({ content: 'No transactions recorded yet.' });

        const monthLines = stats.monthly.length
          ? stats.monthly.map(m => {
              const [year, month] = m.month.split('-');
              const date = new Date(year, parseInt(month) - 1);
              const label = date.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
              return `• **${label}** — ${fmtUSD(m.total)}`;
            }).join('\n')
          : '_No monthly data_';

        // Month-over-month change
        let momText = '';
        if (stats.lastMonth > 0) {
          const change = ((stats.thisMonth - stats.lastMonth) / stats.lastMonth * 100).toFixed(1);
          const arrow = change >= 0 ? '📈' : '📉';
          momText = `${arrow} **${change >= 0 ? '+' : ''}${change}%** vs last month`;
        }

        const embed = new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setAuthor({ name: 'Revenue Dashboard', iconURL: LOGO_URL })
          .setTitle('💵 Revenue Breakdown')
          .setDescription([
            `**All-time revenue:** ${fmtUSD(stats.allTime)}`,
            `**This month:** ${fmtUSD(stats.thisMonth)}`,
            `**Last month:** ${fmtUSD(stats.lastMonth)}`,
            momText,
            `**Total transactions:** ${stats.txCount}`
          ].filter(Boolean).join('\n'))
          .addFields({ name: '📅 Monthly Breakdown (last 12)', value: monthLines })
          .setThumbnail(WATERMARK_URL)
          .setFooter({ text: `Requested by ${i.user.username}`, iconURL: LOGO_URL })
          .setTimestamp();

        await i.editReply({ embeds: [embed] });
      } catch (err) {
        log('revenue', `Error: ${err.message}`);
        await i.editReply({ content: `Failed to load revenue data: ${err.message}` });
      }
      return;
    }

    // ─────────────────────────────────────────────────────────
    // /syncranks — Bulk-assign rank roles to all customers (staff only)
    // ─────────────────────────────────────────────────────────
    if (i.isChatInputCommand() && i.commandName === 'syncranks') {
      await i.deferReply();

      if (!sheetsEnabled) return i.editReply({ content: 'Google Sheets integration is not configured.' });
      if (!canUsePaidCommand(i.member)) return i.editReply({ content: 'You do not have permission to use this command.' });

      try {
        const customers = await getAllCustomers();
        let updated = 0;
        let failed  = 0;
        let skipped = 0;

        for (const c of customers) {
          const tier = getTier(c.totalSpent);
          try {
            const result = await ensureRankRole(i.guild, c.discordId, tier, 'Bulk rank sync');
            if (result) updated++;
            else skipped++;
          } catch {
            failed++;
          }
        }

        const embed = new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setAuthor({ name: 'Rank Sync Complete', iconURL: LOGO_URL })
          .setTitle('🔄 Bulk Rank Assignment')
          .setDescription([
            `**Total customers:** ${customers.length}`,
            `**Roles updated:** ${updated}`,
            `**Already correct:** ${skipped}`,
            failed > 0 ? `**Failed:** ${failed} _(member may have left server)_` : ''
          ].filter(Boolean).join('\n'))
          .setFooter({ text: `Triggered by ${i.user.username}`, iconURL: LOGO_URL })
          .setTimestamp();

        await i.editReply({ embeds: [embed] });
        log('syncranks', `Sync complete: ${updated} updated, ${skipped} skipped, ${failed} failed`);
      } catch (err) {
        log('syncranks', `Error: ${err.message}`);
        await i.editReply({ content: `Sync failed: ${err.message}` });
      }
      return;
    }

    // ─────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────
    // Raffle Commands
    // ─────────────────────────────────────────────────────────

    // Helper: post ticket update + auto-roll if raffle is complete
    async function postTicketUpdate(channel, userId, username, result) {
      const { tickets, soldCount, totalTickets, complete, raffle } = result;
      const numList = tickets.join(', ');
      const plural  = tickets.length === 1 ? '' : 's';
      await channel.send(
        `🎟️ <@${userId}> just got **${tickets.length}** ticket${plural}!\n` +
        `▸ Ticket Numbers: **${numList}**\n` +
        `**${soldCount}/${totalTickets}** ticket${totalTickets === 1 ? '' : 's'} sold — (RAFFLE ID: ${raffle.id})`
      );

      if (complete) {
        const rolled = rollWinners(channel.guild.id);
        if (rolled.error) return;
        const lines = rolled.winners.map((w, idx) =>
          `**(${idx + 1})** ▸ <@${w.userId}> (Ticket #${w.ticketNum}) ▸ ${w.prize}`
        ).join('\n');
        const winEmbed = new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setTitle('🏆 Raffle Winners 🏆')
          .setDescription(`🎉 **${rolled.raffle.title}** — (RAFFLE ID: ${rolled.raffle.id})\n\n${lines}`)
          .setTimestamp();
        await channel.send({ embeds: [winEmbed] });
      }
    }

    // /raffle — Create a new raffle
    if (i.isChatInputCommand() && i.commandName === 'raffle') {
      await i.deferReply({ ephemeral: true });
      if (getRaffle(i.guild.id)) return i.editReply({ content: 'There is already an active raffle. Use `/rcancel` to end it first.' });

      const title        = i.options.getString('title');
      const totalTickets = i.options.getInteger('tickets');
      const prizes       = [
        i.options.getString('prize1'),
        i.options.getString('prize2'),
        i.options.getString('prize3')
      ].filter(Boolean);

      const raffle = createRaffle(i.guild.id, i.channel.id, title, totalTickets, prizes);

      const ordinals = ['1st', '2nd', '3rd'];
      const prizeLines = prizes.map((p, idx) => `( ${ordinals[idx] || `${idx + 1}th`} ) ➛ ${p}`).join('\n');

      const embed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle(`🎊 ${title} 🎊`)
        .setDescription([
          `🎟️ **${totalTickets} TICKETS AVAILABLE!** 🎟️`,
          '',
          '_The Raffle Will Automatically Roll When The Last Ticket Is Sold._',
          '',
          `🎁 **Prizes:**\n${prizeLines}`,
          '',
          `*(RAFFLE ID: ${raffle.id})*`
        ].join('\n'))
        .setTimestamp();

      await i.channel.send({ embeds: [embed], components: [buildRaffleTicketButton(raffle.id)] });
      await i.editReply({ content: `✅ Raffle **${title}** created! (${totalTickets} tickets, ${prizes.length} prize${prizes.length > 1 ? 's' : ''})` });
      return;
    }

    // /rgive — Give tickets to a user (posts update in raffle channel)
    if (i.isChatInputCommand() && i.commandName === 'rgive') {
      await i.deferReply({ ephemeral: true });
      const target = i.options.getUser('user');
      const amount = i.options.getInteger('amount');
      const result = assignTickets(i.guild.id, target.id, amount);

      if (result.error === 'no_raffle') return i.editReply({ content: 'No active raffle. Use `/raffle` to create one.' });
      if (result.error === 'full')      return i.editReply({ content: `Raffle is full! (${result.raffle.soldCount}/${result.raffle.totalTickets} tickets sold)` });

      const raffleChannel = i.guild.channels.cache.get(result.raffle.channelId) || i.channel;
      await postTicketUpdate(raffleChannel, target.id, target.username, result);
      await i.editReply({ content: `✅ Gave **${result.tickets.length}** ticket${result.tickets.length > 1 ? 's' : ''} to ${target}.` });
      return;
    }

    // /rtake — Remove tickets from a user (posts update in raffle channel)
    if (i.isChatInputCommand() && i.commandName === 'rtake') {
      await i.deferReply({ ephemeral: true });
      const target = i.options.getUser('user');
      const amount = i.options.getInteger('amount');
      const result = removeTickets(i.guild.id, target.id, amount);

      if (result.error === 'no_raffle')  return i.editReply({ content: 'No active raffle.' });
      if (result.error === 'no_tickets') return i.editReply({ content: `${target} has no tickets in the active raffle.` });

      const raffleChannel = i.guild.channels.cache.get(result.raffle.channelId) || i.channel;
      await raffleChannel.send(
        `🗑️ **${result.removed.length}** ticket${result.removed.length > 1 ? 's' : ''} removed from <@${target.id}>. ` +
        `(Tickets: ${result.removed.join(', ')})\n` +
        `**${result.soldCount}/${result.totalTickets}** tickets sold — (RAFFLE ID: ${result.raffle.id})`
      );
      await i.editReply({ content: `✅ Removed **${result.removed.length}** ticket${result.removed.length > 1 ? 's' : ''} from ${target}.` });
      return;
    }

    // /rcancel — Cancel the active raffle (posts in raffle channel)
    if (i.isChatInputCommand() && i.commandName === 'rcancel') {
      await i.deferReply({ ephemeral: true });
      const activeRaffle = getRaffle(i.guild.id);
      const title = cancelRaffle(i.guild.id);
      if (!title) return i.editReply({ content: 'No active raffle to cancel.' });
      const raffleChannel = (activeRaffle && i.guild.channels.cache.get(activeRaffle.channelId)) || i.channel;
      await raffleChannel.send(`📢 **${title}** was canceled!\n❌ Canceled`);
      await i.editReply({ content: `✅ Raffle **${title}** has been cancelled.` });
      return;
    }

    // /rroll — Force roll winners now (posts in raffle channel)
    if (i.isChatInputCommand() && i.commandName === 'rroll') {
      await i.deferReply({ ephemeral: true });
      const activeRaffle = getRaffle(i.guild.id);
      const result = rollWinners(i.guild.id);
      if (result.error === 'no_raffle')  return i.editReply({ content: 'No active raffle.' });
      if (result.error === 'no_tickets') return i.editReply({ content: 'No tickets have been sold yet.' });

      const lines = result.winners.map((w, idx) =>
        `**(${idx + 1})** ▸ <@${w.userId}> (Ticket #${w.ticketNum}) ▸ ${w.prize}`
      ).join('\n');
      const winEmbed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle('🏆 Raffle Winners 🏆')
        .setDescription(`🎉 **${result.raffle.title}** — (RAFFLE ID: ${result.raffle.id})\n\n${lines}`)
        .setTimestamp();
      const raffleChannel = (activeRaffle && i.guild.channels.cache.get(activeRaffle.channelId)) || i.channel;
      await raffleChannel.send({ embeds: [winEmbed] });
      await i.editReply({ content: '✅ Winners rolled!' });
      return;
    }

    // /rstatus — Show active raffle status
    if (i.isChatInputCommand() && i.commandName === 'rstatus') {
      await i.deferReply({ ephemeral: true });
      const raffle = getRaffle(i.guild.id);
      if (!raffle) return i.editReply({ content: 'No active raffle.' });

      const entries = Object.entries(raffle.tickets);
      const holderLines = entries.length
        ? entries.map(([uid, nums]) => `<@${uid}> — tickets ${nums.join(', ')}`).join('\n')
        : '_No tickets sold yet._';

      const embed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle(`🎟️ ${raffle.title} (RAFFLE ID: ${raffle.id})`)
        .addFields(
          { name: 'Tickets Sold', value: `${raffle.soldCount} / ${raffle.totalTickets}`, inline: true },
          { name: 'Prizes', value: raffle.prizes.join('\n'), inline: true },
          { name: 'Ticket Holders', value: holderLines }
        )
        .setTimestamp();
      await i.editReply({ embeds: [embed] });
      return;
    }

    // /rannounce — Ping all raffle ticket holders with a reminder
    if (i.isChatInputCommand() && i.commandName === 'rannounce') {
      await i.deferReply({ ephemeral: true });
      const raffle = getRaffle(i.guild.id);
      if (!raffle) return i.editReply({ content: 'No active raffle.' });

      const holderIds = Object.keys(raffle.tickets);
      if (!holderIds.length) return i.editReply({ content: 'No ticket holders to announce to yet.' });

      const pings      = holderIds.map(uid => `<@${uid}>`).join(' ');
      const ordinals   = ['1st', '2nd', '3rd'];
      const prizeLines = raffle.prizes.map((p, idx) => `( ${ordinals[idx] || `${idx + 1}th`} ) ➛ ${p}`).join('\n');

      const embed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle(`🎟️ ${raffle.title} — Raffle Update`)
        .setDescription([
          `🎁 **Prizes:**\n${prizeLines}`,
          '',
          `🎟️ **${raffle.soldCount} / ${raffle.totalTickets}** tickets sold`,
          '',
          `*(RAFFLE ID: ${raffle.id})*`
        ].join('\n'))
        .setTimestamp();

      const raffleChannel = i.guild.channels.cache.get(raffle.channelId) || i.channel;
      await raffleChannel.send({ content: `${pings}\n🚨 **Raffle reminder!**`, embeds: [embed] });
      await i.editReply({ content: '✅ Announcement posted and all ticket holders pinged!' });
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Balloon Drop Commands
    // ─────────────────────────────────────────────────────────

    // /balloon — Create a balloon drop event
    if (i.isChatInputCommand() && i.commandName === 'balloon') {
      await i.deferReply({ ephemeral: true });
      if (getBalloonEvent(i.guild.id)) return i.editReply({ content: 'There is already an active balloon event. Use `/bcancel` first.' });

      const title        = i.options.getString('title');
      const totalTickets = i.options.getInteger('tickets');
      const price        = i.options.getString('price');
      const eventTime    = i.options.getString('event_time');
      const world        = i.options.getInteger('world');
      const items        = i.options.getString('items');
      const balloons     = i.options.getInteger('balloons');

      const event = createBalloonEvent(i.guild.id, i.channel.id, title, totalTickets, price, eventTime, world, items, balloons);

      const itemLines = items.split(',').map(s => `• ${s.trim()}`).join('\n');
      const balloonLine = balloons ? `🎈 **${balloons} filled balloons** (out of 200 in the room)\n` : '';

      const embed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle(`🎈 ${title} 🎈`)
        .setDescription([
          `🎟️ **${totalTickets} SPOTS AVAILABLE** 🎟️`,
          '',
          `📅 **When:** ${eventTime}`,
          `🌍 **World:** ${world}`,
          `💰 **Ticket Price:** ${price}`,
          '',
          balloonLine + `🎁 **Items Being Dropped:**\n${itemLines}`,
          '',
          '_Secure your spot by clicking the button below. A ticket will open and staff will confirm your payment._',
          '',
          `*(EVENT ID: ${event.id})*`
        ].join('\n'))
        .setThumbnail(WATERMARK_URL)
        .setTimestamp();

      await i.channel.send({ embeds: [embed], components: [buildBalloonTicketButton(event.id)] });
      await i.editReply({ content: `✅ Balloon event **${title}** created! (${totalTickets} spots, World ${world}, ${eventTime})` });
      return;
    }

    // /bgive — Confirm payment and give a spot
    if (i.isChatInputCommand() && i.commandName === 'bgive') {
      await i.deferReply({ ephemeral: true });
      const target = i.options.getUser('user');
      const result = giveBalloonTicket(i.guild.id, target.id);

      if (result.error === 'no_event')         return i.editReply({ content: 'No active balloon event. Use `/balloon` to create one.' });
      if (result.error === 'already_has_ticket') return i.editReply({ content: `${target} already has a spot in this event.` });
      if (result.error === 'full')              return i.editReply({ content: `Event is full! (${result.event.attendees.length}/${result.event.totalTickets} spots taken)` });

      const event = result.event;
      const soldCount = event.attendees.length;
      const eventChannel = i.guild.channels.cache.get(event.channelId) || i.channel;

      await eventChannel.send(
        `🎈 <@${target.id}> has secured a spot!\n` +
        `**${soldCount} / ${event.totalTickets}** spots filled — (EVENT ID: ${event.id})`
      );
      await i.editReply({ content: `✅ Spot confirmed for ${target}. (${soldCount}/${event.totalTickets} filled)` });
      return;
    }

    // /btake — Remove a user from the event
    if (i.isChatInputCommand() && i.commandName === 'btake') {
      await i.deferReply({ ephemeral: true });
      const target = i.options.getUser('user');
      const result = takeBalloonTicket(i.guild.id, target.id);

      if (result.error === 'no_event')  return i.editReply({ content: 'No active balloon event.' });
      if (result.error === 'no_ticket') return i.editReply({ content: `${target} does not have a spot in the active event.` });

      const event = result.event;
      const eventChannel = i.guild.channels.cache.get(event.channelId) || i.channel;

      await eventChannel.send(
        `🗑️ <@${target.id}>'s spot has been removed.\n` +
        `**${event.attendees.length} / ${event.totalTickets}** spots filled — (EVENT ID: ${event.id})`
      );
      await i.editReply({ content: `✅ Removed ${target} from the event.` });
      return;
    }

    // /bcancel — Cancel the active balloon event
    if (i.isChatInputCommand() && i.commandName === 'bcancel') {
      await i.deferReply({ ephemeral: true });
      const activeEvent = getBalloonEvent(i.guild.id);
      const title = cancelBalloonEvent(i.guild.id);
      if (!title) return i.editReply({ content: 'No active balloon event to cancel.' });
      const eventChannel = (activeEvent && i.guild.channels.cache.get(activeEvent.channelId)) || i.channel;
      await eventChannel.send(`📢 **${title}** has been canceled.\n❌ Canceled`);
      await i.editReply({ content: `✅ Balloon event **${title}** has been cancelled.` });
      return;
    }

    // /bstatus — Show current event status
    if (i.isChatInputCommand() && i.commandName === 'bstatus') {
      await i.deferReply({ ephemeral: true });
      const event = getBalloonEvent(i.guild.id);
      if (!event) return i.editReply({ content: 'No active balloon event.' });

      const attendeeLines = event.attendees.length
        ? event.attendees.map((uid, idx) => `${idx + 1}. <@${uid}>`).join('\n')
        : '_No spots filled yet._';

      const embed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle(`🎈 ${event.title} (EVENT ID: ${event.id})`)
        .addFields(
          { name: 'Spots Filled',  value: `${event.attendees.length} / ${event.totalTickets}`, inline: true },
          { name: 'Ticket Price',  value: event.price,                                          inline: true },
          { name: 'When',          value: event.eventTime,                                      inline: true },
          { name: 'World',         value: String(event.world),                                  inline: true },
          { name: 'Items Dropped', value: event.items,                                          inline: false },
          { name: 'Attendees',     value: attendeeLines,                                        inline: false }
        )
        .setTimestamp();
      await i.editReply({ embeds: [embed] });
      return;
    }

    // /bannounce — Post a day-of reminder pinging all ticket holders
    if (i.isChatInputCommand() && i.commandName === 'bannounce') {
      await i.deferReply({ ephemeral: true });
      const event = getBalloonEvent(i.guild.id);
      if (!event) return i.editReply({ content: 'No active balloon event.' });
      if (!event.attendees.length) return i.editReply({ content: 'No attendees to announce to yet.' });

      const pings  = event.attendees.map(uid => `<@${uid}>`).join(' ');
      const itemLines = event.items.split(',').map(s => `• ${s.trim()}`).join('\n');
      const balloonLine = event.balloons ? `🎈 **${event.balloons} filled balloons**\n` : '';

      const embed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle(`🎈 ${event.title} — IT'S TIME! 🎈`)
        .setDescription([
          `📅 **${event.eventTime}**`,
          `🌍 **World ${event.world}** — Head to the Clan Hall party room!`,
          '',
          balloonLine + `🎁 **What's being dropped:**\n${itemLines}`,
          '',
          `🎟️ **${event.attendees.length} / ${event.totalTickets}** spots filled`,
          '',
          '**Get in-game and get ready!**'
        ].join('\n'))
        .setTimestamp();

      const eventChannel = i.guild.channels.cache.get(event.channelId) || i.channel;
      await eventChannel.send({ content: `${pings}\n🚨 **Balloon Drop is happening NOW!**`, embeds: [embed] });
      await i.editReply({ content: '✅ Announcement posted and all ticket holders pinged!' });
      return;
    }

    // /payment — Payment method instructions
    // ─────────────────────────────────────────────────────────
    if (i.isChatInputCommand() && i.commandName === 'payment') {
      await i.deferReply();

      const method = i.options.getString('method');
      const info = PAYMENT_METHODS[method];

      if (!info) {
        return i.editReply({ content: 'Unknown payment method.' });
      }

      const embed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setAuthor({ name: 'Payment Instructions', iconURL: LOGO_URL })
        .setTitle(`${info.emoji} ${info.title}`)
        .addFields(info.fields)
        .setThumbnail(WATERMARK_URL)
        .setFooter({ text: `Requested by ${i.user.username}`, iconURL: LOGO_URL })
        .setTimestamp();

      const replyPayload = { embeds: [embed] };
      if (info.copyButtons?.length) {
        replyPayload.components = [buildPaymentMethodCopyRow(method, info.copyButtons)];
      }
      await i.editReply(replyPayload);
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Mode select menu
    // ─────────────────────────────────────────────────────────
    if (i.isStringSelectMenu() && i.customId === 'swcalc_mode') {
      await i.deferUpdate();
      const { skill, acctType } = readCurrentSelections(i.message);
      const mode = i.values[0];
      await i.editReply({ components: buildLauncherRows(mode, skill, acctType) });
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Skill select menu
    // ─────────────────────────────────────────────────────────
    if (i.isStringSelectMenu() && i.customId === 'swcalc_skill') {
      await i.deferUpdate();
      const { mode, acctType } = readCurrentSelections(i.message);
      const skill = i.values[0];
      await i.editReply({ components: buildLauncherRows(mode, skill, acctType) });
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Account type select menu
    // ─────────────────────────────────────────────────────────
    if (i.isStringSelectMenu() && i.customId === 'swcalc_acct') {
      await i.deferUpdate();
      const { mode, skill } = readCurrentSelections(i.message);
      const acctType = i.values[0];
      await i.editReply({ components: buildLauncherRows(mode, skill, acctType) });
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Next button → show modal (must NOT defer before showModal)
    // ─────────────────────────────────────────────────────────
    if (i.isButton() && i.customId.startsWith('swcalc_next|')) {
      const [, mode, skill, acctType] = i.customId.split('|');
      await i.showModal(buildInputModal(mode, skill, acctType));

      // Disable controls after modal opens (fire-and-forget)
      i.message.edit({ components: buildDisabledLauncherRows(mode, skill, acctType) }).catch(() => {});
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Modal submit → run calculation
    // ─────────────────────────────────────────────────────────
    if (i.isModalSubmit() && i.customId.startsWith('swcalc_modal|')) {
      await i.deferReply();

      const [, mode, skillSel, acctTypeSel] = i.customId.split('|');
      const targetRaw   = (i.fields.getTextInputValue('target_level') || '').trim();
      const targetLevel = targetRaw ? parseInt(targetRaw, 10) : 99;

      if (!Number.isFinite(targetLevel) || targetLevel < 1 || targetLevel > 99) {
        return i.editReply({ content: 'Target level must be 1–99.' });
      }

      const skill    = VALID_SKILLS.includes(skillSel) ? skillSel : 'Strength';
      const acctType = (acctTypeSel === '10hp' || acctTypeSel === 'non10hp') ? acctTypeSel : 'non10hp';

      let startXP;
      let rsn = null;

      if (mode === 'rsn') {
        rsn = i.fields.getTextInputValue('rsn').trim();
        if (!rsn) return i.editReply({ content: 'Please enter a RuneScape name.' });

        try {
          log('modal', `RSN lookup: ${rsn}`);
          const stats     = await getPlayerStats(rsn);
          const hKey      = skillToHiscoreKey(skill);
          const xpKey     = `${hKey}_xp`;

          if (stats[xpKey] === undefined) {
            return i.editReply({ content: `Could not find ${skill} XP for **${rsn}**. The player may be unranked in this skill.` });
          }
          startXP = stats[xpKey];
          log('modal', `${rsn} ${skill} XP: ${startXP}`);
        } catch (err) {
          log('modal', `Hiscores error: ${err.message}`);
          return i.editReply({ content: `${err.message || 'Could not look up player stats.'}` });
        }
      } else if (mode === 'xp') {
        const v = parseInt(i.fields.getTextInputValue('start_val').trim(), 10);
        if (!Number.isFinite(v) || v < 0) return i.editReply({ content: 'Start XP must be a non-negative number.' });
        startXP = v;
      } else if (mode === 'lvl') {
        const v = parseInt(i.fields.getTextInputValue('start_val').trim(), 10);
        if (!Number.isFinite(v) || v < 1 || v > 99) return i.editReply({ content: 'Start level must be 1–99.' });
        startXP = getXPForLevel(v);
      } else {
        return i.editReply({ content: 'Invalid mode.' });
      }

      const payload = buildSWCalculationPayload(i, { startXP, targetLevel, skill, acctType, rsn });
      await i.editReply(payload);
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Balloon "Buy Ticket" button → opens a support ticket
    // ─────────────────────────────────────────────────────────
    if (i.isButton() && i.customId.startsWith('balloon_buy|')) {
      const eventId = i.customId.split('|')[1];
      const event   = getBalloonEvent(i.guild.id);

      if (!event || String(event.id) !== eventId) {
        await i.deferReply({ ephemeral: true });
        return i.editReply({ content: 'This event is no longer active.' });
      }
      if (event.attendees.includes(i.user.id)) {
        await i.deferReply({ ephemeral: true });
        return i.editReply({ content: 'You already have a spot in this event!' });
      }
      if (event.attendees.length >= event.totalTickets) {
        await i.deferReply({ ephemeral: true });
        return i.editReply({ content: 'Sorry — this event is fully booked.' });
      }

      const existingChannelId = getActiveTicket(i.guild.id, i.user.id);
      if (existingChannelId) {
        const existing = i.guild.channels.cache.get(existingChannelId);
        if (existing) {
          await i.deferReply({ ephemeral: true });
          return i.editReply({ content: `You already have an open ticket: ${existing}` });
        }
        removeActiveTicketByChannelId(existingChannelId);
      }

      await i.deferReply({ ephemeral: true });

      const itemLines = event.items.split(',').map(s => `• ${s.trim()}`).join('\n');
      const balloonLine = event.balloons ? `🎈 **${event.balloons} filled balloons**\n\n` : '';

      const eventInfoEmbed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setAuthor({ name: '🎈 Balloon Drop — Ticket Request', iconURL: LOGO_URL })
        .setTitle(event.title)
        .setDescription([
          `You're securing a spot for **${event.title}**!`,
          '',
          `📅 **When:** ${event.eventTime}`,
          `🌍 **World:** ${event.world}`,
          `💰 **Price:** ${event.price}`,
          '',
          balloonLine + `🎁 **Items Being Dropped:**\n${itemLines}`,
          '',
          `🎟️ **${event.attendees.length} / ${event.totalTickets}** spots filled`,
          '',
          `Please send payment of **${event.price}** and a staff member will confirm your spot.`
        ].join('\n'))
        .setThumbnail(WATERMARK_URL)
        .setFooter({ text: `EVENT ID: ${event.id}` });

      const ch = await openTicketChannel(i, [eventInfoEmbed], buildCloseRow(i.user.id));
      addActiveTicket(i.guild.id, i.user.id, ch.id);

      const createdEmbed = buildTicketCreatedEmbed(i, `<#${ch.id}>`);
      const row = buildTicketEphemeralRow(ch.guild.id, ch.id, i.user.id);
      await i.editReply({ embeds: [createdEmbed], components: [row] });
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Raffle "Buy Tickets" button → opens a support ticket
    // ─────────────────────────────────────────────────────────
    if (i.isButton() && i.customId.startsWith('raffle_buy|')) {
      const raffleId = i.customId.split('|')[1];
      const raffle   = getRaffle(i.guild.id);

      if (!raffle || String(raffle.id) !== raffleId) {
        await i.deferReply({ ephemeral: true });
        return i.editReply({ content: 'This raffle is no longer active.' });
      }

      const existingChannelId = getActiveTicket(i.guild.id, i.user.id);
      if (existingChannelId) {
        const existing = i.guild.channels.cache.get(existingChannelId);
        if (existing) {
          await i.deferReply({ ephemeral: true });
          return i.editReply({ content: `You already have an open ticket: ${existing}` });
        }
        removeActiveTicketByChannelId(existingChannelId);
      }

      await i.deferReply({ ephemeral: true });

      const ordinals   = ['1st', '2nd', '3rd'];
      const prizeLines = raffle.prizes.map((p, idx) => `( ${ordinals[idx] || `${idx + 1}th`} ) ➛ ${p}`).join('\n');

      const raffleInfoEmbed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setAuthor({ name: '🎟️ Ticket Purchase Request', iconURL: LOGO_URL })
        .setTitle(raffle.title)
        .setDescription([
          `Welcome! You're requesting tickets for **${raffle.title}**.`,
          '',
          `🎁 **Prizes:**\n${prizeLines}`,
          '',
          `🎟️ **${raffle.soldCount} / ${raffle.totalTickets}** tickets sold`,
          '',
          'Please tell us:\n• How many tickets you would like\n• Your preferred payment method',
          '',
          '_A staff member will confirm your payment and assign your tickets._'
        ].join('\n'))
        .setThumbnail(WATERMARK_URL)
        .setFooter({ text: `RAFFLE ID: ${raffle.id}` });

      const ch = await openTicketChannel(i, [raffleInfoEmbed], buildCloseRow(i.user.id));
      addActiveTicket(i.guild.id, i.user.id, ch.id);

      const createdEmbed = buildTicketCreatedEmbed(i, `<#${ch.id}>`);
      const row = buildTicketEphemeralRow(ch.guild.id, ch.id, i.user.id);
      await i.editReply({ embeds: [createdEmbed], components: [row] });
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Payment copy buttons (copypay|method)
    // ─────────────────────────────────────────────────────────
    if (i.isButton() && i.customId.startsWith('copypay|')) {
      await i.deferReply({ ephemeral: true });
      const method = i.customId.split('|')[1];
      const addresses = {
        btc:    'bc1qh4l4t9j2uu79g972r89m3cr2nf3wgg8kkz8xp7',
        paypal: 'takedexosrs@gmail.com'
      };
      const addr = addresses[method];
      if (!addr) return i.editReply({ content: 'Unknown payment method.' });
      await i.editReply({ content: addr });
      return;
    }

    // ─────────────────────────────────────────────────────────
    // /payment command copy buttons (copypayment|METHOD|INDEX)
    // ─────────────────────────────────────────────────────────
    if (i.isButton() && i.customId.startsWith('copypayment|')) {
      await i.deferReply({ ephemeral: true });
      const parts  = i.customId.split('|');
      const method = parts[1];
      const idx    = parseInt(parts[2], 10);
      const info   = PAYMENT_METHODS[method];
      const btn    = info?.copyButtons?.[idx];
      if (!btn) return i.editReply({ content: 'Unknown payment method.' });
      await i.editReply({ content: btn.value });
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Embed buttons (swv3|...|action)
    // ─────────────────────────────────────────────────────────
    if (i.isButton() && i.customId.startsWith('swv3|')) {
      const parts       = i.customId.split('|');
      const startXP     = parseInt(parts[1], 10);
      const targetLevel = parseInt(parts[2], 10);
      const skill       = parts[3];
      const acctType    = (parts[4] === '10hp' || parts[4] === 'non10hp') ? parts[4] : 'non10hp';
      const action      = parts[parts.length - 1];
      const rsn         = parts.length === 7 ? decodeURIComponent(parts[5]) : null;

      const result   = calcSoulWarsPlan(startXP, targetLevel, skill);
      const inTicket = !!(i.channel?.name && /^sw-\d+$/i.test(i.channel.name));

      // ── Open Ticket ──
      if (action === 'ticket') {
        try {
          const guildId = i.guild.id;
          const userId  = i.user.id;
          const existingChannelId = getActiveTicket(guildId, userId);

          if (existingChannelId) {
            const existingChannel = i.guild.channels.cache.get(existingChannelId);
            if (existingChannel) {
              await i.deferReply({ ephemeral: true });
              return i.editReply({ content: `You already have an open ticket: ${existingChannel}` });
            }
            removeActiveTicketByChannelId(existingChannelId);
          }

          await i.deferReply({ ephemeral: true });

          const info       = buildInfoEmbed(i, { skill, startXP, targetLevel, acctType, rsn }, result, 'band');
          const rsnPart    = rsn ? `|${encodeURIComponent(rsn)}` : '';
          const ctxTicket  = `swv3|${startXP}|${targetLevel}|${skill}|${acctType}${rsnPart}`;
          const rowToggle  = buildToggleRow(ctxTicket, 'band');

          const ch = await openTicketChannel(i, [info], rowToggle);
          addActiveTicket(guildId, userId, ch.id);

          const createdEmbed = buildTicketCreatedEmbed(i, `<#${ch.id}>`);
          const row = buildTicketEphemeralRow(ch.guild.id, ch.id, userId);

          await i.editReply({ embeds: [createdEmbed], components: [row] });
        } catch (err) {
          log('ticket', `Error: ${err.message}`);
          try {
            if (!i.deferred && !i.replied) await i.deferReply({ ephemeral: true });
            await i.editReply({ content: 'Could not create ticket channel (check bot permissions & category ID).' });
          } catch {}
        }
        return;
      }

      // ── Download Breakdown ──
      if (action === 'dl') {
        await i.deferReply({ ephemeral: true });
        if (result.ok && result.rows.length) {
          await i.editReply({ files: buildTextFileAttachment(result.rows) });
        } else {
          await i.editReply({ content: 'No breakdown available for this input.' });
        }
        return;
      }

      // ── Payment Info ──
      if (action === 'pay') {
        await i.deferReply({ ephemeral: true });
        await i.editReply({ embeds: [buildPaymentEmbed(i)], components: [buildPaymentCopyRow()] });
        return;
      }

      // ── Toggle Band / Day View ──
      if (action === 'band' || action === 'day') {
        await i.deferUpdate();
        const view    = action;
        const info    = buildInfoEmbed(i, { skill, startXP, targetLevel, acctType, rsn }, result, view);
        const rsnPart = rsn ? `|${encodeURIComponent(rsn)}` : '';
        const ctx     = `swv3|${startXP}|${targetLevel}|${skill}|${acctType}${rsnPart}`;

        if (inTicket) {
          await i.editReply({ embeds: [info], components: [buildToggleRow(ctx, view)] });
        } else {
          await i.editReply({ embeds: [info, buildBannerEmbed()], components: [buildActionRow(ctx, view)] });
        }
        return;
      }
    }

    // ─────────────────────────────────────────────────────────
    // Close ticket (inside ticket channel)
    // ─────────────────────────────────────────────────────────
    if (i.isButton() && i.customId.startsWith('ticketclose|')) {
      await closeTicketChannel(i);
      return;
    }

    // ─────────────────────────────────────────────────────────
    // Close ticket by ID (from ephemeral)
    // ─────────────────────────────────────────────────────────
    if (i.isButton() && i.customId.startsWith('ticketclosebyid|')) {
      const [, channelId, openerId] = i.customId.split('|');
      await closeTicketById(i, channelId, openerId);
      return;
    }

  } catch (err) {
    console.error('[interaction] Unhandled error:', err);
    try {
      if (i.isRepliable() && !i.replied && !i.deferred) {
        await i.deferReply({ ephemeral: true });
        await i.editReply({ content: `Error: ${err?.name || 'Exception'}${err?.message ? ` — ${err.message}` : ''}` });
      } else if (i.deferred) {
        await i.editReply({ content: `Error: ${err?.name || 'Exception'}${err?.message ? ` — ${err.message}` : ''}` });
      }
    } catch {}
  }
});

// ───────── Channel Delete (free up ticket tracking) ─────────
client.on('channelDelete', channel => {
  if (channel.guild) removeActiveTicketByChannelId(channel.id);
});

// ───────── Graceful Shutdown ─────────
function shutdown(signal) {
  log('shutdown', `Received ${signal}, shutting down…`);
  client.destroy();
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ───────── Start ─────────
client.login(TOKEN)
  .then(() => log('bot', 'Login promise resolved'))
  .catch(err => {
    console.error('[bot] Login failed:', err);
    process.exit(1);
  });
