// index.js
// Soul Wars XP/zeal Calculator + Ticket Flow
// - /swcalc: in-Discord form → plan & pricing
// - Main channel: Info + Banner + buttons (Band/Day/Breakdown/Payment/Open Ticket)
// - Ticket: copies info embed, ONLY Band/Day buttons, posts Payment Info (with Close Ticket)
// - Ephemeral: confirmation with link + Close Ticket by ID
// - Multi-guild slash deploy via GUILD_IDS (comma-separated). Falls back to global if empty.
// - ALL interactions now use defer → edit pattern to survive Render cold starts

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const TICKET_COUNTER_FILE = path.join(__dirname, 'ticket_counter.json');
const ACTIVE_TICKETS_FILE = path.join(__dirname, 'active_tickets.json');
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID || null;

const ALLOWED_CLOSE_ROLES = [
  '1251990189337743381',
  '1238423254637613086',
  '1238405570491318293'
];

// ───────── Tiny HTTP server for Render (safe no-op for Background Worker) ─────────
const http = require('http');
const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
  })
  .listen(PORT, () => {
    console.log(`Health server listening on port ${PORT}`);
  });

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType
} = require('discord.js');

// ───────── Env / Config ─────────
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env / Render env');
  process.exit(1);
}

const DEPLOY_SLASH = process.env.DEPLOY_SLASH === '1';
const GUILD_IDS = (process.env.GUILD_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;

// ───────── Artwork / Links ─────────
const LOGO_URL = 'https://i.ibb.co/BKZGsfgw/PPGif.gif';
const BANNER_URL = 'https://i.ibb.co/7xwxnNpP/banner.gif';
const WATERMARK_URL = 'https://i.ibb.co/b59Hb5c0/PPwatermarkletters.png';

// ───────── Client ─────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

// ───────── Domain Constants ─────────
const VALID_SKILLS = ['Strength', 'Attack', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer'];
const DAILY_CAP_XP = 1_000_000;
const THEME_RED = 0xff0000;

// Pricing (gp per zeal)
const PRICE_PER_TOKEN = {
  '10hp': 50_000,
  non10hp: 40_000
};

// Soul Wars XP per zeal by band
const swRates = [
  { from: 30, to: 34, meleeHp: 30,  mageRange: 27,  prayer: 14 },
  { from: 35, to: 42, meleeHp: 60,  mageRange: 54,  prayer: 28 },
  { from: 43, to: 48, meleeHp: 90,  mageRange: 81,  prayer: 42 },
  { from: 49, to: 54, meleeHp: 120, mageRange: 108, prayer: 56 },
  { from: 55, to: 59, meleeHp: 150, mageRange: 135, prayer: 70 },
  { from: 60, to: 64, meleeHp: 180, mageRange: 162, prayer: 84 },
  { from: 65, to: 69, meleeHp: 210, mageRange: 189, prayer: 98 },
  { from: 70, to: 73, meleeHp: 240, mageRange: 216, prayer: 112 },
  { from: 74, to: 77, meleeHp: 270, mageRange: 243, prayer: 126 },
  { from: 78, to: 81, meleeHp: 300, mageRange: 270, prayer: 140 },
  { from: 82, to: 84, meleeHp: 330, mageRange: 297, prayer: 154 },
  { from: 85, to: 88, meleeHp: 360, mageRange: 324, prayer: 168 },
  { from: 89, to: 91, meleeHp: 390, mageRange: 351, prayer: 182 },
  { from: 92, to: 94, meleeHp: 420, mageRange: 378, prayer: 196 },
  { from: 95, to: 97, meleeHp: 450, mageRange: 405, prayer: 210 },
  { from: 98, to: 99, meleeHp: 480, mageRange: 432, prayer: 224 }
];

// OSRS XP Table (1→99; index = level)
const OSRS_XP_1_TO_99 = [
  0,
  0, 83, 174, 276, 388, 512, 650, 801, 969, 1154, 1358, 1584, 1833, 2107, 2411, 2746, 3115, 3523, 3973, 4470,
  5018, 5624, 6291, 7028, 7842, 8740, 9730, 10824, 12031, 13363, 14833, 16456, 18247, 20224, 22406, 24815,
  27473, 30408, 33648, 37224, 41171, 45529, 50339, 55649, 61512, 67983, 75127, 83014, 91721, 101333,
  111945, 123660, 136594, 150872, 166636, 184040, 203254, 224466, 247886, 273742, 302288, 333804, 368599,
  407015, 449428, 496254, 547953, 605032, 668051, 737627, 814445, 899257, 992895, 1096278, 1210421,
  1336443, 1475581, 1629200, 1798808, 1986068, 2192818, 2421087, 2673114, 2951373, 3258594, 3597792,
  3972294, 4385776, 4842295, 5346332, 5902831, 6517253, 7195629, 7944614, 8771558, 9684577, 10692629,
  11805606, 13034431
];

// Grind rate — for time estimate
const ZEAL_PER_HOUR = 270;

function hoursToDHMS(hours) {
  const totalMinutes = Math.round(hours * 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const remAfterDays = totalMinutes - days * 24 * 60;
  const hrs = Math.floor(remAfterDays / 60);
  const mins = remAfterDays - hrs * 60;
  return { days, hours: hrs, minutes: mins };
}

function formatDHMS(hours) {
  const { days, hours: h, minutes: m } = hoursToDHMS(hours);
  return `${days}d ${h}h ${m}m`;
}

// ───────── Helpers ─────────
const fmtInt = n => n.toLocaleString('en-GB');

function getXPForLevel(level) {
  const lvl = Math.max(1, Math.min(99, level | 0));
  return OSRS_XP_1_TO_99[lvl];
}

function getLevel(xp) {
  if (xp <= 0) return 1;
  if (xp >= OSRS_XP_1_TO_99[99]) return 99;
  let lo = 1, hi = 99;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (OSRS_XP_1_TO_99[mid] <= xp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function getSWRatesForLevel(lvl, skill) {
  if (lvl < 30) return 0;
  const band = swRates.find(b => lvl >= b.from && lvl <= b.to);
  if (!band) return 0;
  if (skill === 'Prayer') return band.prayer;
  if (skill === 'Magic' || skill === 'Ranged') return band.mageRange;
  return band.meleeHp;
}

function skillTheme(skill) {
  const map = {
    Strength: { emoji: '🗡️' },
    Attack:   { emoji: '⚔️' },
    Defence:  { emoji: '🛡️' },
    Hitpoints:{ emoji: '❤️' },
    Ranged:   { emoji: '🏹' },
    Magic:    { emoji: '🪄' },
    Prayer:   { emoji: '🙏' }
  };
  return map[skill] || { emoji: '⭐' };
}

function progressBar(current, target, width = 20) {
  const pct = Math.max(0, Math.min(1, current / target));
  const filled = Math.round(width * pct);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${(pct * 100).toFixed(1)}%`;
}

function baseFooter(user) {
  return { text: `Requested by ${user.username} • ${new Date().toLocaleString('en-GB')}`, iconURL: LOGO_URL };
}

function gpCost(zeal, acctType) {
  const rate = PRICE_PER_TOKEN[acctType] ?? PRICE_PER_TOKEN['non10hp'];
  return { rate, total: zeal * rate };
}

function accountLabel(acctType) {
  return acctType === '10hp' ? '10 HP' : 'Non-10 HP';
}

// ───────── Core Calculations ─────────
function calcSoulWarsPlan(startXP, targetLevel, skill) {
  const targetXP = getXPForLevel(targetLevel);
  const startLevel = getLevel(startXP);

  if (startXP >= targetXP) {
    return { ok: false, reason: 'already_met', startLevel, targetXP, rows: [], tokens: 0, days: 0, neededXP: 0, targetXPAbs: targetXP };
  }
  if (startLevel < 30) {
    return { ok: false, reason: 'below_30', startLevel, targetXP, rows: [], tokens: 0, days: 0, neededXP: 0, targetXPAbs: targetXP };
  }

  let xp = startXP;
  let tokens = 0;

  const rows = [];
  let currBandKey = null;
  let bandTokens = 0;
  let bandXpPerToken = 0;
  let bandStartLevel = getLevel(xp);

  const pushBandRow = endLvl => {
    if (!currBandKey) return;
    rows.push({
      band: currBandKey,
      xpPerToken: bandXpPerToken,
      tokens: bandTokens,
      levels: `L${bandStartLevel}→L${endLvl}`
    });
  };

  while (xp < targetXP) {
    const lvl = getLevel(xp);
    const rate = getSWRatesForLevel(lvl, skill);
    if (rate <= 0) break;

    const band = swRates.find(b => lvl >= b.from && lvl <= b.to);
    if (!band) break;

    const bandKey = `${band.from}-${band.to}`;

    if (bandKey !== currBandKey) {
      if (currBandKey) pushBandRow(getLevel(xp));
      currBandKey = bandKey;
      bandTokens = 0;
      bandXpPerToken = rate;
      bandStartLevel = lvl;
    }

    xp += rate;
    tokens += 1;
    bandTokens += 1;

    if (xp >= targetXP) {
      pushBandRow(getLevel(Math.min(xp, targetXP)));
      break;
    }
  }

  const neededXP = Math.max(0, targetXP - startXP);
  const days = neededXP === 0 ? 0 : Math.max(1, Math.ceil(neededXP / DAILY_CAP_XP));

  return { ok: true, startLevel, targetXP, neededXP, rows, tokens, days, targetXPAbs: targetXP };
}

function calcPlanByDay(startXP, targetLevel, skill) {
  const targetXP = getXPForLevel(targetLevel);
  let xp = startXP;
  let day = 1;
  let xpDay = 0;
  let tokensDay = 0;
  let dayStartLevel = getLevel(xp);
  const out = [];

  const pushDay = () => {
    const fromLvl = dayStartLevel;
    const toLvl = getLevel(xp);
    out.push({ day, tokens: tokensDay, xp: xpDay, fromLvl, toLvl });
    day += 1;
    xpDay = 0;
    tokensDay = 0;
    dayStartLevel = getLevel(xp);
  };

  while (xp < targetXP) {
    const lvl = getLevel(xp);
    if (lvl < 30) break;
    const rate = getSWRatesForLevel(lvl, skill);
    if (rate <= 0) break;

    if (xpDay + rate > DAILY_CAP_XP) {
      pushDay();
      continue;
    }

    xp += rate;
    xpDay += rate;
    tokensDay += 1;

    if (xp >= targetXP) {
      pushDay();
      break;
    }
  }

  if (tokensDay > 0 || xpDay > 0) pushDay();
  return out;
}

// ───────── Presentation Builders ─────────
function buildBandLines(rows) {
  if (!rows.length) return ['n/a'];
  return rows.map(r => {
    const prettyLevels = r.levels.replace('→', ' > ');
    return `• **${fmtInt(r.tokens)} zeal** for ${prettyLevels} (${r.xpPerToken} XP/zeal)`;
  });
}

function buildDayLines(daysArr) {
  if (!daysArr.length) return ['n/a'];
  return daysArr.map(d => `• Day ${d.day} — **${fmtInt(d.tokens)} zeal** (~${fmtInt(d.xp)} XP) L${d.fromLvl}→L${d.toLvl}`);
}

function buildTextTable(rows) {
  let out = 'Band | XP/Zeal | Zeal | Levels\n';
  out += '-----|--------:|-----:|--------\n';
  for (const r of rows) {
    out += `${r.band.padEnd(5)}| ${String(r.xpPerToken).padStart(7)} | ${String(r.tokens).padStart(4)} | ${r.levels}\n`;
  }
  return out;
}

function buildTextFileAttachment(rows) {
  const text = buildTextTable(rows);
  return [{ attachment: Buffer.from(text, 'utf8'), name: 'SPOILER_sw_breakdown.txt' }];
}

function buildPlanField(titleSingle, lines) {
  return [{ name: titleSingle, value: lines.join('\n') }];
}

function buildInfoEmbed(i, { skill, startXP, targetLevel, acctType }, result, view = 'band') {
  const { emoji } = skillTheme(skill);

  if (!result.ok) {
    const base = new EmbedBuilder()
      .setColor(THEME_RED)
      .setAuthor({ name: 'Soul Wars Calculator', iconURL: LOGO_URL })
      .setThumbnail(WATERMARK_URL)
      .setFooter(baseFooter(i.user));

    if (result.reason === 'already_met') {
      return base
        .setTitle('Already enough XP')
        .setDescription(`You are level **${result.startLevel}** (${fmtInt(startXP)} XP), which meets or exceeds level **${targetLevel}**.`);
    }
    return base
      .setTitle('Level too low for Soul Wars XP')
      .setDescription('You must be at least level 30 in the chosen skill to redeem Soul Wars XP.');
  }

  const { rate, total } = gpCost(result.tokens, acctType);
  const bar = progressBar(startXP, result.targetXPAbs);
  const lines = view === 'band' ? buildBandLines(result.rows) : buildDayLines(calcPlanByDay(startXP, targetLevel, skill));
  const hours = result.ok ? (result.tokens / ZEAL_PER_HOUR) : 0;

  const embed = new EmbedBuilder()
    .setColor(THEME_RED)
    .setAuthor({ name: 'Soul Wars Calculator', iconURL: LOGO_URL })
    .setTitle(`${emoji} ${skill}: ${fmtInt(startXP)} XP → level ${targetLevel}`)
    .setDescription(
      [
        `📊 Current level: **${getLevel(startXP)}**`,
        `🎯 Target XP: **${fmtInt(result.targetXPAbs)}**`,
        `📈 Progress: ${bar}`,
        `🪙 Estimated zeal required: **${fmtInt(result.tokens)}**`,
        `⏱️ Time to complete: **~${formatDHMS(hours)}**`,
        `📅 Daily redeem cap: ${fmtInt(DAILY_CAP_XP)} XP/day → about ${fmtInt(result.days)} day(s) to redeem`
      ].join('\n')
    )
    .setThumbnail(WATERMARK_URL)
    .setFooter(baseFooter(i.user));

  const fieldTitle = view === 'band' ? 'Plan by band' : 'Plan by day';
  embed.addFields(buildPlanField(fieldTitle, lines));

  embed.addFields({
    name: 'Pricing',
    value: `**${accountLabel(acctType)}** — **${fmtInt(total)} gp** _(at ${fmtInt(rate)} gp/zeal)_`
  });

  return embed;
}

function buildBannerEmbed() {
  return new EmbedBuilder().setImage(BANNER_URL);
}

function buildPaymentEmbedPublic(i) {
  return new EmbedBuilder()
    .setColor(THEME_RED)
    .setAuthor({ name: 'Payment Info', iconURL: LOGO_URL })
    .setTitle('💳 Payment Methods')
    .setThumbnail(WATERMARK_URL)
    .setDescription(
      [
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
      ].join('\n')
    )
    .setFooter(baseFooter(i.user));
}

function buildEphemeralCreatedEmbed(i, channelUrl) {
  return new EmbedBuilder()
    .setColor(THEME_RED)
    .setAuthor({ name: 'Ticket Created', iconURL: LOGO_URL })
    .setDescription(`Your ticket is ready: ${channelUrl}`)
    .setFooter(baseFooter(i.user));
}

// ───────── Buttons / Rows ─────────
function buildActionRow(ctx, activeView) {
  const isBand = activeView === 'band';
  const bandBtn = new ButtonBuilder().setCustomId(`${ctx}|band`).setLabel('Plan by band').setStyle(isBand ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const dayBtn  = new ButtonBuilder().setCustomId(`${ctx}|day`).setLabel('Plan by day').setStyle(!isBand ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const dlBtn   = new ButtonBuilder().setCustomId(`${ctx}|dl`).setLabel('Breakdown').setStyle(ButtonStyle.Secondary);
  const payBtn  = new ButtonBuilder().setCustomId(`${ctx}|pay`).setLabel('Payment Info').setStyle(ButtonStyle.Success);
  const ticketBtn = new ButtonBuilder().setCustomId(`${ctx}|ticket`).setLabel('Open Ticket').setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(bandBtn, dayBtn, dlBtn, payBtn, ticketBtn);
}

function buildToggleRow(ctx, activeView) {
  const isBand = activeView === 'band';
  const bandBtn = new ButtonBuilder().setCustomId(`${ctx}|band`).setLabel('Plan by band').setStyle(isBand ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const dayBtn  = new ButtonBuilder().setCustomId(`${ctx}|day`).setLabel('Plan by day').setStyle(!isBand ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(bandBtn, dayBtn);
}

// ───────── Active Ticket Helpers ─────────
function loadActiveTickets() {
  try {
    if (fs.existsSync(ACTIVE_TICKETS_FILE)) {
      return JSON.parse(fs.readFileSync(ACTIVE_TICKETS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error loading active tickets:', e); }
  return {};
}

function saveActiveTickets(data) {
  try {
    fs.writeFileSync(ACTIVE_TICKETS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Error saving active tickets:', e); }
}

function addActiveTicket(guildId, userId, channelId) {
  const data = loadActiveTickets();
  data[`${guildId}-${userId}`] = channelId;
  saveActiveTickets(data);
}

function removeActiveTicketByChannelId(channelId) {
  const data = loadActiveTickets();
  let found = false;
  for (const key in data) {
    if (data[key] === channelId) {
      delete data[key];
      found = true;
    }
  }
  if (found) saveActiveTickets(data);
}

// ───────── Ticket Helpers ─────────
async function getNextTicketNumber(guild) {
  let counters = {};

  try {
    if (fs.existsSync(TICKET_COUNTER_FILE)) {
      const data = fs.readFileSync(TICKET_COUNTER_FILE, 'utf8');
      counters = JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading ticket counter:', err);
  }

  const guildId = guild.id;
  const currentCounter = counters[guildId] || 0;
  const nextNumber = currentCounter + 1;

  counters[guildId] = nextNumber;
  try {
    fs.writeFileSync(TICKET_COUNTER_FILE, JSON.stringify(counters, null, 2));
  } catch (err) {
    console.error('Error saving ticket counter:', err);
  }

  return nextNumber;
}

async function closeTicketChannel(i) {
  const [_, openerId] = i.customId.split('|');
  const isOpener = i.user.id === openerId;

  const hasEnvRole = SUPPORT_ROLE_ID && i.member?.roles?.cache?.has(SUPPORT_ROLE_ID);
  const hasAllowedRole = ALLOWED_CLOSE_ROLES.some(roleId => i.member?.roles?.cache?.has(roleId));

  if (!isOpener && !hasEnvRole && !hasAllowedRole) {
    await i.deferReply({ ephemeral: true });
    return i.editReply({ content: 'Only the opener or staff can close this ticket.' });
  }

  if (!i.channel) {
    await i.deferReply({ ephemeral: true });
    return i.editReply({ content: 'Channel not found (already closed?).' });
  }
  
  await i.deferReply({ ephemeral: true });
  await i.editReply({ content: 'Closing ticket in 3 seconds…' });
  
  setTimeout(async () => {
    try { await i.channel.delete('Ticket closed'); } catch {}
  }, 3000);
}

async function closeTicketById(i, channelId, openerId) {
  const isOpener = i.user.id === openerId;

  const hasEnvRole = SUPPORT_ROLE_ID && i.member?.roles?.cache?.has(SUPPORT_ROLE_ID);
  const hasAllowedRole = ALLOWED_CLOSE_ROLES.some(roleId => i.member?.roles?.cache?.has(roleId));

  if (!isOpener && !hasEnvRole && !hasAllowedRole) {
    await i.deferReply({ ephemeral: true });
    return i.editReply({ content: 'Only the opener or staff can close this ticket.' });
  }

  try {
    let ch = i.client.channels.cache.get(channelId);
    if (!ch) {
      try {
        ch = await i.client.channels.fetch(channelId);
      } catch {
        await i.deferReply({ ephemeral: true });
        return i.editReply({ content: 'That ticket channel no longer exists (already closed or I cant see it).' });
      }
    }
    
    await i.deferReply({ ephemeral: true });
    await i.editReply({ content: 'Closing ticket in 3 seconds…' });
    
    setTimeout(async () => {
      try { await ch.delete('Ticket closed'); } catch {}
    }, 3000);
  } catch (err) {
    console.error('closeTicketById error:', err);
    try {
      if (!i.deferred && !i.replied) {
        await i.deferReply({ ephemeral: true });
      }
      await i.editReply({ content: 'Failed to close ticket (permissions or missing channel).' });
    } catch {}
  }
}

async function openTicketChannel(i, embedsToCopy, componentsToCopy) {
  const guild = i.guild;
  if (!guild) throw new Error('No guild on interaction');

  const nextNum = await getNextTicketNumber(guild);
  const name = `SW-${nextNum}`;

  const everyoneId = guild.roles.everyone.id;
  const overwrites = [
    { id: everyoneId, deny: ['ViewChannel'] },
    { id: i.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks'] }
  ];
  if (SUPPORT_ROLE_ID) {
    overwrites.push({
      id: SUPPORT_ROLE_ID,
      allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks', 'ManageMessages']
    });
  }

  const channel = await guild.channels.create({
    name,
    parent: TICKET_CATEGORY_ID || undefined,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites
  });

  if (embedsToCopy && embedsToCopy.length) {
    await channel.send({
      content: SUPPORT_ROLE_ID ? `<@&${SUPPORT_ROLE_ID}>` : undefined,
      embeds: embedsToCopy,
      components: componentsToCopy ? (Array.isArray(componentsToCopy) ? componentsToCopy : [componentsToCopy]) : []
    });
  }

  const paymentEmbed = buildPaymentEmbedPublic(i);
  const closeBtn = new ButtonBuilder().setCustomId(`ticketclose|${i.user.id}`).setLabel('Close Ticket').setStyle(ButtonStyle.Secondary);
  const closeRow = new ActionRowBuilder().addComponents(closeBtn);
  await channel.send({ embeds: [paymentEmbed], components: [closeRow] });

  return channel;
}

// ───────── Main Flow ─────────
function buildSWCalculationPayload(i, { startXP, targetLevel, skill, acctType }) {
  const result = calcSoulWarsPlan(startXP, targetLevel, skill);
  const view = 'band';
  const info = buildInfoEmbed(i, { skill, startXP, targetLevel, acctType }, result, view);
  const banner = buildBannerEmbed();

  const ctx = `swv3|${startXP}|${targetLevel}|${skill}|${acctType}`;
  const row = buildActionRow(ctx, 'band');
  return { embeds: [info, banner], components: [row] };
}

// ───────── Slash Registration ─────────
async function deploySlash() {
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const appId = client.application?.id;
    if (!appId) {
      console.error('Application ID not ready.');
      return;
    }

    const swCalc = new SlashCommandBuilder()
      .setName('swcalc')
      .setDescription('Soul Wars calculator')
      .toJSON();

    console.log('DEPLOY_SLASH:', DEPLOY_SLASH, 'GUILD_IDS:', GUILD_IDS.join(',') || '(none)');

    // Clear old guild + global commands
    const oldGuildId = '1361036931156283654';
    try {
      await rest.put(Routes.applicationGuildCommands(appId, oldGuildId), { body: [] });
      console.log(`Removed commands from old guild ${oldGuildId}`);
    } catch (e) {
      console.error(`Failed to remove from old guild:`, e);
    }
    try {
      await rest.put(Routes.applicationCommands(appId), { body: [] });
      console.log('Removed global commands');
    } catch (e) {
      console.error('Failed to remove global commands:', e);
    }

    if (GUILD_IDS.length) {
      for (const gid of GUILD_IDS) {
        try {
          await rest.put(Routes.applicationGuildCommands(appId, gid), { body: [swCalc] });
          console.log(`Registered /swcalc in guild ${gid}`);
        } catch (e) {
          console.error(`Failed to register in guild ${gid}:`, e?.code || e?.status || e?.message || e);
        }
      }
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: [swCalc] });
      console.log('Registered /swcalc globally');
    }
  } catch (err) {
    console.error('deploySlash error:', err);
  }
}

// ───────── UI Builders ─────────
function buildModeSelect(selected = 'xp', disabled = false) {
  return new StringSelectMenuBuilder()
    .setCustomId('swcalc_mode')
    .setPlaceholder('Select mode')
    .setDisabled(disabled)
    .addOptions(
      { label: 'XP',  value: 'xp',  default: selected === 'xp'  },
      { label: 'LVL', value: 'lvl', default: selected === 'lvl' }
    );
}

function buildSkillSelect(selected = 'Strength', disabled = false) {
  return new StringSelectMenuBuilder()
    .setCustomId('swcalc_skill')
    .setPlaceholder('Select skill')
    .setDisabled(disabled)
    .addOptions(...VALID_SKILLS.map(s => ({ label: s, value: s, default: s === selected })));
}

function buildAccountSelect(selected = 'non10hp', disabled = false) {
  return new StringSelectMenuBuilder()
    .setCustomId('swcalc_acct')
    .setPlaceholder('Account type')
    .setDisabled(disabled)
    .addOptions(
      { label: 'Non-10 HP (40k gp/zeal)', value: 'non10hp', default: selected === 'non10hp' },
      { label: '10 HP (50k gp/zeal)',     value: '10hp',    default: selected === '10hp' }
    );
}

function buildNextButton(mode, skill, acctType, disabled = false) {
  const cid = `swcalc_next|${mode}|${skill}|${acctType}`;
  return new ButtonBuilder().setCustomId(cid).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(disabled);
}

// ───────── Events ─────────
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`App ID: ${client.application.id}`);
  if (DEPLOY_SLASH) await deploySlash();
});

client.on('interactionCreate', async i => {
  console.log(`[${Date.now()}] Received interaction: ${i.id} | Type: ${i.type} | Command: ${i.commandName || 'N/A'}`);
  
  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // /swcalc launcher - DEFER FIRST to survive cold starts
    // ═══════════════════════════════════════════════════════════════════════════
    if (i.isChatInputCommand() && i.commandName === 'swcalc') {
      await i.deferReply({ ephemeral: true });
      
      const row1 = new ActionRowBuilder().addComponents(buildModeSelect());
      const row2 = new ActionRowBuilder().addComponents(buildSkillSelect());
      const row3 = new ActionRowBuilder().addComponents(buildAccountSelect());
      const row4 = new ActionRowBuilder().addComponents(buildNextButton('xp', 'Strength', 'non10hp'));

      const info = new EmbedBuilder()
        .setColor(THEME_RED)
        .setAuthor({ name: 'Soul Wars Calculator', iconURL: LOGO_URL })
        .setTitle('Soul Wars Calculator')
        .setDescription('Select **Mode**, **Skill**, and **Account Type**, then press **Next**.')
        .setThumbnail(WATERMARK_URL)
        .setFooter(baseFooter(i.user));
      const banner = buildBannerEmbed();

      await i.editReply({ embeds: [info, banner], components: [row1, row2, row3, row4] });
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Mode select - DEFER UPDATE first
    // ═══════════════════════════════════════════════════════════════════════════
    if (i.isStringSelectMenu() && i.customId === 'swcalc_mode') {
      await i.deferUpdate();
      
      const mode = i.values[0];
      const skillComp = i.message.components[1].components[0];
      const selSkill =
        (skillComp?.data?.options?.find?.(o => o.default)?.value) ||
        (skillComp?.options?.find?.(o => o.default)?.value) ||
        'Strength';

      const acctComp = i.message.components[2].components[0];
      const selAcct =
        (acctComp?.data?.options?.find?.(o => o.default)?.value) ||
        (acctComp?.options?.find?.(o => o.default)?.value) ||
        'non10hp';

      const row1 = new ActionRowBuilder().addComponents(buildModeSelect(mode));
      const row2 = new ActionRowBuilder().addComponents(buildSkillSelect(selSkill));
      const row3 = new ActionRowBuilder().addComponents(buildAccountSelect(selAcct));
      const row4 = new ActionRowBuilder().addComponents(buildNextButton(mode, selSkill, selAcct));

      await i.editReply({ components: [row1, row2, row3, row4] });
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Skill select - DEFER UPDATE first
    // ═══════════════════════════════════════════════════════════════════════════
    if (i.isStringSelectMenu() && i.customId === 'swcalc_skill') {
      await i.deferUpdate();
      
      const skill = i.values[0];
      const modeComp = i.message.components[0].components[0];
      const selMode =
        (modeComp?.data?.options?.find?.(o => o.default)?.value) ||
        (modeComp?.options?.find?.(o => o.default)?.value) ||
        'xp';

      const acctComp = i.message.components[2].components[0];
      const selAcct =
        (acctComp?.data?.options?.find?.(o => o.default)?.value) ||
        (acctComp?.options?.find?.(o => o.default)?.value) ||
        'non10hp';

      const row1 = new ActionRowBuilder().addComponents(buildModeSelect(selMode));
      const row2 = new ActionRowBuilder().addComponents(buildSkillSelect(skill));
      const row3 = new ActionRowBuilder().addComponents(buildAccountSelect(selAcct));
      const row4 = new ActionRowBuilder().addComponents(buildNextButton(selMode, skill, selAcct));

      await i.editReply({ components: [row1, row2, row3, row4] });
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Account type select - DEFER UPDATE first
    // ═══════════════════════════════════════════════════════════════════════════
    if (i.isStringSelectMenu() && i.customId === 'swcalc_acct') {
      await i.deferUpdate();
      
      const acctType = i.values[0];
      const modeComp = i.message.components[0].components[0];
      const selMode =
        (modeComp?.data?.options?.find?.(o => o.default)?.value) ||
        (modeComp?.options?.find?.(o => o.default)?.value) ||
        'xp';

      const skillComp = i.message.components[1].components[0];
      const selSkill =
        (skillComp?.data?.options?.find?.(o => o.default)?.value) ||
        (skillComp?.options?.find?.(o => o.default)?.value) ||
        'Strength';

      const row1 = new ActionRowBuilder().addComponents(buildModeSelect(selMode));
      const row2 = new ActionRowBuilder().addComponents(buildSkillSelect(acctType === '10hp' ? selMode : selMode));
      const row2Fixed = new ActionRowBuilder().addComponents(buildSkillSelect(selSkill));
      const row3 = new ActionRowBuilder().addComponents(buildAccountSelect(acctType));
      const row4 = new ActionRowBuilder().addComponents(buildNextButton(selMode, selSkill, acctType));

      await i.editReply({ components: [row1, row2Fixed, row3, row4] });
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Next → modal (showModal MUST be first - cannot defer before modal)
    // ═══════════════════════════════════════════════════════════════════════════
    if (i.isButton() && i.customId.startsWith('swcalc_next|')) {
      const [, mode, skill, acctType] = i.customId.split('|');

      const modal = new ModalBuilder().setCustomId(`swcalc_modal|${mode}|${skill}|${acctType}`).setTitle('Soul Wars Input');

      const startVal = new TextInputBuilder()
        .setCustomId('start_val')
        .setLabel(mode === 'xp' ? 'Start XP' : 'Start Level')
        .setPlaceholder(mode === 'xp' ? 'e.g. 100000' : 'e.g. 30')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const target = new TextInputBuilder()
        .setCustomId('target_level')
        .setLabel('Target level (default 99)')
        .setPlaceholder('e.g. 89  or blank → 99')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      // showModal MUST be the first response - cannot defer before it
      await i.showModal(modal.addComponents(
        new ActionRowBuilder().addComponents(startVal),
        new ActionRowBuilder().addComponents(target)
      ));

      // Disable controls after modal opens (fire and forget)
      const row1 = new ActionRowBuilder().addComponents(buildModeSelect(mode, true));
      const row2 = new ActionRowBuilder().addComponents(buildSkillSelect(skill, true));
      const row3 = new ActionRowBuilder().addComponents(buildAccountSelect(acctType, true));
      const row4 = new ActionRowBuilder().addComponents(buildNextButton(mode, skill, acctType, true));
      i.message.edit({ components: [row1, row2, row3, row4] }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Modal submit → calculation - DEFER FIRST
    // ═══════════════════════════════════════════════════════════════════════════
    if (i.isModalSubmit() && i.customId.startsWith('swcalc_modal|')) {
      console.log(`[${Date.now()}] Modal submit START - ${i.id}`);
      
      // DEFER IMMEDIATELY - this is critical for cold starts
      await i.deferReply();
      console.log(`[${Date.now()}] Deferred - ${i.id}`);
      
      const [, mode, skillSel, acctTypeSel] = i.customId.split('|');
      const startRaw = i.fields.getTextInputValue('start_val').trim();
      const targetRaw = (i.fields.getTextInputValue('target_level') || '').trim();

      const targetLevel = targetRaw ? parseInt(targetRaw, 10) : 99;
      if (!Number.isFinite(targetLevel) || targetLevel < 1 || targetLevel > 99) {
        return i.editReply({ content: 'Target level must be 1–99.' });
      }

      const skill = VALID_SKILLS.includes(skillSel) ? skillSel : 'Strength';
      const acctType = acctTypeSel === '10hp' || acctTypeSel === 'non10hp' ? acctTypeSel : 'non10hp';

      let startXP;
      if (mode === 'xp') {
        const v = parseInt(startRaw, 10);
        if (!Number.isFinite(v) || v < 0) return i.editReply({ content: 'Start XP must be a non-negative number.' });
        startXP = v;
      } else if (mode === 'lvl') {
        const v = parseInt(startRaw, 10);
        if (!Number.isFinite(v) || v < 1 || v > 99) return i.editReply({ content: 'Start level must be 1–99.' });
        startXP = getXPForLevel(v);
      } else {
        return i.editReply({ content: 'Invalid mode.' });
      }

      console.log(`[${Date.now()}] Building payload - ${i.id}`);
      const payload = buildSWCalculationPayload(i, { startXP, targetLevel, skill, acctType });
      
      console.log(`[${Date.now()}] About to editReply - ${i.id}`);
      await i.editReply(payload);
      console.log(`[${Date.now()}] Reply sent - ${i.id}`);
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Buttons on embeds (swv3|...)
    // ═══════════════════════════════════════════════════════════════════════════
    if (i.isButton() && i.customId.startsWith('swv3|')) {
      const parts = i.customId.split('|');
      const startXP = parseInt(parts[1], 10);
      const targetLevel = parseInt(parts[2], 10);
      const skill = parts[3];
      const acctType = parts[4] === '10hp' || parts[4] === 'non10hp' ? parts[4] : 'non10hp';
      const action = parts[5];

      const result = calcSoulWarsPlan(startXP, targetLevel, skill);
      const inTicket = !!(i.channel?.name && /^sw-\d+$/i.test(i.channel.name));

      // ─────────────────────────────────────────────────────────────────────────
      // TICKET button - already defers (slow operation)
      // ─────────────────────────────────────────────────────────────────────────
      if (action === 'ticket') {
        try {
          const guildId = i.guild.id;
          const userId = i.user.id;
          const activeTickets = loadActiveTickets();
          const existingChannelId = activeTickets[`${guildId}-${userId}`];

          if (existingChannelId) {
            const existingChannel = i.guild.channels.cache.get(existingChannelId);
            
            if (existingChannel) {
              await i.deferReply({ ephemeral: true });
              await i.editReply({ content: `You already have an open ticket: ${existingChannel}` });
              return;
            } else {
              removeActiveTicketByChannelId(existingChannelId);
            }
          }

          // Defer here because ticket creation takes time
          await i.deferReply({ ephemeral: true });

          const info = buildInfoEmbed(i, { skill, startXP, targetLevel, acctType }, result, 'band');
          const ctxTicket = `swv3|${startXP}|${targetLevel}|${skill}|${acctType}`;
          const rowToggle = buildToggleRow(ctxTicket, 'band');
          
          const ch = await openTicketChannel(i, [info], rowToggle);

          addActiveTicket(guildId, userId, ch.id);

          const createdEmbed = buildEphemeralCreatedEmbed(i, `<#${ch.id}>`);
          const closeBtn = new ButtonBuilder()
            .setCustomId(`ticketclosebyid|${ch.id}|${i.user.id}`)
            .setLabel('Close Ticket')
            .setStyle(ButtonStyle.Secondary);
          const linkBtn = new ButtonBuilder()
            .setLabel('Go to ticket')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${ch.guild.id}/${ch.id}`);
          const row = new ActionRowBuilder().addComponents(linkBtn, closeBtn);

          await i.editReply({ embeds: [createdEmbed], components: [row] });
          return;
        } catch (err) {
          console.error('openTicketChannel error:', err);
          try { 
            if (!i.deferred && !i.replied) {
              await i.deferReply({ ephemeral: true });
            }
            await i.editReply({ content: 'Could not create ticket channel (check bot permissions & category ID).' }); 
          } catch {}
          return;
        }
      }

      // ─────────────────────────────────────────────────────────────────────────
      // DOWNLOAD button - DEFER FIRST
      // ─────────────────────────────────────────────────────────────────────────
      if (action === 'dl') {
        await i.deferReply({ ephemeral: true });
        
        if (result.ok && result.rows.length) {
          const files = buildTextFileAttachment(result.rows);
          await i.editReply({ files });
        } else {
          await i.editReply({ content: 'No breakdown available for this input.' });
        }
        return;
      }

      // ─────────────────────────────────────────────────────────────────────────
      // PAYMENT button - DEFER FIRST
      // ─────────────────────────────────────────────────────────────────────────
      if (action === 'pay') {
        await i.deferReply({ ephemeral: true });
        
        const payEmbed = buildPaymentEmbedPublic(i);
        await i.editReply({ embeds: [payEmbed] });
        return;
      }

      // ─────────────────────────────────────────────────────────────────────────
      // Toggle view (band/day) - DEFER UPDATE FIRST
      // ─────────────────────────────────────────────────────────────────────────
      if (action === 'band' || action === 'day') {
        await i.deferUpdate();
        
        const view = action === 'day' ? 'day' : 'band';
        const info = buildInfoEmbed(i, { skill, startXP, targetLevel, acctType }, result, view);
        const ctx = `swv3|${startXP}|${targetLevel}|${skill}|${acctType}`;

        if (inTicket) {
          const row = buildToggleRow(ctx, view);
          await i.editReply({ embeds: [info], components: [row] });
        } else {
          const banner = buildBannerEmbed();
          const row = buildActionRow(ctx, view);
          await i.editReply({ embeds: [info, banner], components: [row] });
        }
        return;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Ticket close (inside ticket) - handled in closeTicketChannel with defer
    // ═══════════════════════════════════════════════════════════════════════════
    if (i.isButton() && i.customId.startsWith('ticketclose|')) {
      await closeTicketChannel(i);
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Ephemeral close by id - handled in closeTicketById with defer
    // ═══════════════════════════════════════════════════════════════════════════
    if (i.isButton() && i.customId.startsWith('ticketclosebyid|')) {
      const [, channelId, openerId] = i.customId.split('|');
      await closeTicketById(i, channelId, openerId);
      return;
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
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

// Handle manual channel deletion to free up the user
client.on('channelDelete', channel => {
  if (channel.guild) {
    removeActiveTicketByChannelId(channel.id);
  }
});

// ───────── Start ─────────
client.login(TOKEN)
  .then(() => console.log('Login promise resolved'))
  .catch(err => {
    console.error('Login failed:', err);
  });
