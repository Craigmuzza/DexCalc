// embeds.js — All Discord embed builders
const { EmbedBuilder } = require('discord.js');
const { THEME_COLOR, LOGO_URL, BANNER_URL, WATERMARK_URL, VALID_SKILLS } = require('./config');
const {
  fmtInt,
  formatDHMS,
  getLevel,
  gpCost,
  accountLabel,
  skillEmoji,
  progressBar,
  calcPlanByDay,
  calcMultiSkillQuote
} = require('./calculator');

// ───────── Shared Footer ─────────
function baseFooter(user) {
  return {
    text: `Requested by ${user.username} • ${new Date().toLocaleString('en-GB')}`,
    iconURL: LOGO_URL
  };
}

// ───────── Band / Day Line Builders ─────────
function buildBandLines(rows) {
  if (!rows.length) return ['n/a'];
  return rows.map(r => {
    const prettyLevels = r.levels.replace('→', ' > ');
    return `• **${fmtInt(r.tokens)} zeal** for ${prettyLevels} (${r.xpPerToken} XP/zeal)`;
  });
}

function buildDayLines(daysArr) {
  if (!daysArr.length) return ['n/a'];
  return daysArr.map(d =>
    `• Day ${d.day} — **${fmtInt(d.tokens)} zeal** (~${fmtInt(d.xp)} XP) L${d.fromLvl}→L${d.toLvl}`
  );
}

// ───────── Text Table (for download) ─────────
function buildTextTable(rows) {
  let out = 'Band | XP/Zeal | Zeal | Levels\n';
  out    += '-----|--------:|-----:|--------\n';
  for (const r of rows) {
    out += `${r.band.padEnd(5)}| ${String(r.xpPerToken).padStart(7)} | ${String(r.tokens).padStart(4)} | ${r.levels}\n`;
  }
  return out;
}

function buildTextFileAttachment(rows) {
  return [{ attachment: Buffer.from(buildTextTable(rows), 'utf8'), name: 'SPOILER_sw_breakdown.txt' }];
}

// ───────── Main Info Embed (single-skill) ─────────
function buildInfoEmbed(interaction, { skill, startXP, targetLevel, acctType, rsn }, result, view = 'band') {
  const emoji = skillEmoji(skill);

  if (!result.ok) {
    const base = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setAuthor({ name: 'Soul Wars Calculator', iconURL: LOGO_URL })
      .setThumbnail(WATERMARK_URL)
      .setFooter(baseFooter(interaction.user));

    if (result.reason === 'already_met') {
      return base
        .setTitle('Already enough XP')
        .setDescription(`You are level **${result.startLevel}** (${fmtInt(startXP)} XP), which meets or exceeds level **${targetLevel}**.`);
    }
    return base
      .setTitle('Level too low for Soul Wars XP')
      .setDescription('You must be at least level 30 in the chosen skill to redeem Soul Wars XP.');
  }

  const { rate, total, discount } = gpCost(result.tokens, acctType);
  const bar   = progressBar(startXP, result.targetXPAbs);
  const lines = view === 'band'
    ? buildBandLines(result.rows)
    : buildDayLines(calcPlanByDay(startXP, targetLevel, skill));
  const hours = result.tokens / (require('./config').ZEAL_PER_HOUR);

  const titleRsn = rsn ? ` (${rsn})` : '';

  const embed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setAuthor({ name: 'Soul Wars Calculator', iconURL: LOGO_URL })
    .setTitle(`${emoji} ${skill}${titleRsn}: ${fmtInt(startXP)} XP → level ${targetLevel}`)
    .setDescription([
      `📊 Current level: **${getLevel(startXP)}**`,
      `🎯 Target XP: **${fmtInt(result.targetXPAbs)}**`,
      `📈 Progress: ${bar}`,
      `🪙 Estimated zeal required: **${fmtInt(result.tokens)}**`,
      `⏱️ Time to complete: **~${formatDHMS(hours)}**`,
      `📅 Daily redeem cap: ${fmtInt(require('./config').DAILY_CAP_XP)} XP/day → about ${fmtInt(result.days)} day(s) to redeem`
    ].join('\n'))
    .setThumbnail(WATERMARK_URL)
    .setFooter(baseFooter(interaction.user));

  const fieldTitle = view === 'band' ? 'Zeal spend by XP Bracket' : 'Plan by day';
  embed.addFields({ name: fieldTitle, value: lines.join('\n') });

  const discountText = discount > 0 ? ` _(${discount}% bulk discount applied!)_` : '';
  embed.addFields({
    name: 'Pricing',
    value: `**${accountLabel(acctType)}** — **${fmtInt(total)} gp** _(at ${fmtInt(rate)} gp/zeal)_${discountText}`
  });

  return embed;
}

// ───────── Banner Embed ─────────
function buildBannerEmbed() {
  return new EmbedBuilder().setImage(BANNER_URL);
}

// ───────── Payment Embed ─────────
function buildPaymentEmbed(interaction) {
  return new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setAuthor({ name: 'Payment Info', iconURL: LOGO_URL })
    .setTitle('💳 Payment Methods')
    .setThumbnail(WATERMARK_URL)
    .setDescription([
      '**BTC (Bitcoin)**',
      '```',
      'bc1qh4l4t9j2uu79g972r89m3cr2nf3wgg8kkz8xp7',
      '```',
      '**PayPal**',
      '```',
      'takedexosrs@gmail.com',
      '```',
      '**GP - POH Tip Jar**',
      'To avoid imposters only discuss payments inside the TICKET — for GP payments, RSN + world for the POH will be provided'
    ].join('\n'))
    .setFooter(baseFooter(interaction.user));
}

// ───────── Ticket Created Embed (ephemeral) ─────────
function buildTicketCreatedEmbed(interaction, channelUrl) {
  return new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setAuthor({ name: 'Ticket Created', iconURL: LOGO_URL })
    .setDescription(`Your ticket is ready: ${channelUrl}`)
    .setFooter(baseFooter(interaction.user));
}

// ───────── Launcher Embed (/swcalc initial) ─────────
function buildLauncherEmbed(interaction) {
  return new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setAuthor({ name: 'Soul Wars Calculator', iconURL: LOGO_URL })
    .setTitle('Soul Wars Calculator')
    .setDescription([
      'Select **Mode**, **Skill**, and **Account Type**, then press **Next**.',
      '',
      '**Modes:**',
      '• **RSN Lookup** — Enter your RuneScape name to auto-fetch your current XP',
      '• **XP** — Enter your current XP manually',
      '• **LVL** — Enter your current level manually'
    ].join('\n'))
    .setThumbnail(WATERMARK_URL)
    .setFooter(baseFooter(interaction.user));
}

// ───────── Multi-Skill Quote Embed (/swquote) ─────────
function buildQuoteEmbed(interaction, rsn, acctType, targetLevel, quote) {
  const { results, grandTotalZeal, grandCost, grandHours } = quote;

  const skillLines = results.map(r => {
    const emoji = skillEmoji(r.skill);
    if (r.skipped) {
      if (r.reason === 'already_met') return `${emoji} **${r.skill}** — Level ${r.level} ✅ Already at target`;
      if (r.reason === 'below_30')    return `${emoji} **${r.skill}** — Level ${r.level || '?'} ⚠️ Below level 30`;
      return `${emoji} **${r.skill}** — ⚠️ Unranked`;
    }
    return `${emoji} **${r.skill}** — L${r.level} → L${targetLevel} | **${fmtInt(r.zeal)} zeal** | ${fmtInt(r.cost.total)} gp | ~${formatDHMS(r.hours)}`;
  });

  const discountText = grandCost.discount > 0
    ? `\n🏷️ **${grandCost.discount}% bulk discount** applied (${fmtInt(grandCost.rate)} gp/zeal)`
    : '';

  const embed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setAuthor({ name: 'Soul Wars Multi-Skill Quote', iconURL: LOGO_URL })
    .setTitle(`📋 Full Quote for ${rsn}`)
    .setDescription([
      `**Account type:** ${accountLabel(acctType)} | **Target:** Level ${targetLevel}`,
      '',
      ...skillLines
    ].join('\n'))
    .addFields(
      {
        name: '📊 Grand Total',
        value: [
          `🪙 **${fmtInt(grandTotalZeal)} zeal** total`,
          `💰 **${fmtInt(grandCost.total)} gp** (at ${fmtInt(grandCost.rate)} gp/zeal)${discountText}`,
          `⏱️ ~**${formatDHMS(grandHours)}** estimated time`
        ].join('\n')
      }
    )
    .setThumbnail(WATERMARK_URL)
    .setFooter(baseFooter(interaction.user));

  return embed;
}

module.exports = {
  baseFooter,
  buildBandLines,
  buildDayLines,
  buildTextTable,
  buildTextFileAttachment,
  buildInfoEmbed,
  buildBannerEmbed,
  buildPaymentEmbed,
  buildTicketCreatedEmbed,
  buildLauncherEmbed,
  buildQuoteEmbed
};
