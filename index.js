// index.js — DexCalc Bot Entry Point
// Soul Wars XP/zeal Calculator + Ticket Flow + Multi-Skill Quote + Customer Spend Tracking
//
// Commands:
//   /swcalc      — Single-skill calculator with modal input
//   /swquote     — Multi-skill quote from RSN lookup
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
const { TOKEN, DEPLOY_SLASH, VALID_SKILLS, THEME_COLOR, LOGO_URL, WATERMARK_URL, PAID_COMMAND_ROLES, SUPPORT_ROLE_ID } = require('./config');
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
  buildTicketEphemeralRow,
  buildLauncherRows,
  buildDisabledLauncherRows,
  buildInputModal,
  readCurrentSelections
} = require('./components');
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

        const tierUpText = result.tierUp
          ? `\n\n🎉 **TIER UP!** ${result.previousTier.emoji} ${result.previousTier.name} → ${result.tier.emoji} ${result.tier.name}`
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
            `**Tier:** ${result.tier.emoji} ${result.tier.name}`,
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

        const embed = new EmbedBuilder()
          .setColor(0xff6600)
          .setAuthor({ name: 'Refund Recorded', iconURL: LOGO_URL })
          .setTitle(`🔄 Refund — ${fmtUSD(amount)}`)
          .setDescription([
            `**Customer:** <@${targetUser.id}> (${targetUser.username})`,
            `**Refunded:** ${fmtUSD(amount)}`,
            `**New total:** ${fmtUSD(result.newTotal)} _(was ${fmtUSD(result.previousTotal)})_`,
            `**Tier:** ${result.tier.emoji} ${result.tier.name}`,
            note ? `**Reason:** ${note}` : ''
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
          : '🏆 Max tier reached!';

        const embed = new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setAuthor({ name: 'Customer Profile', iconURL: LOGO_URL })
          .setTitle(`${tier.emoji} ${customer.displayName || customer.username}`)
          .setDescription([
            `**Discord:** <@${customer.discordId}>`,
            `**Tier:** ${tier.emoji} ${tier.name}`,
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
            { name: '🎯 Next Tier',      value: tierProgress, inline: false }
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
            `**Tier:** ${tier.emoji} ${tier.name}`,
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
        await i.editReply({ embeds: [buildPaymentEmbed(i)] });
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
