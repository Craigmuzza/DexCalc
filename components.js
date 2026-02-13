// components.js — Discord UI components (buttons, selects, action rows)
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const { VALID_SKILLS } = require('./config');

// ───────── Select Menus ─────────
function buildModeSelect(selected = 'rsn', disabled = false) {
  return new StringSelectMenuBuilder()
    .setCustomId('swcalc_mode')
    .setPlaceholder('Select mode')
    .setDisabled(disabled)
    .addOptions(
      { label: 'RSN Lookup', value: 'rsn', default: selected === 'rsn' },
      { label: 'XP',         value: 'xp',  default: selected === 'xp'  },
      { label: 'LVL',        value: 'lvl', default: selected === 'lvl' }
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
      { label: '10 HP (50k gp/zeal)',      value: '10hp',    default: selected === '10hp'    }
    );
}

// ───────── Buttons ─────────
function buildNextButton(mode, skill, acctType, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(`swcalc_next|${mode}|${skill}|${acctType}`)
    .setLabel('Next')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled);
}

// ───────── Action Rows ─────────
// Full action row (main channel): Band | Day | Breakdown | Payment | Open Ticket
function buildActionRow(ctx, activeView) {
  const isBand = activeView === 'band';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ctx}|band`).setLabel('Zeal spend by XP Bracket').setStyle(isBand ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ctx}|day`).setLabel('Plan by day').setStyle(!isBand ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ctx}|dl`).setLabel('Breakdown').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ctx}|pay`).setLabel('Payment Info').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${ctx}|ticket`).setLabel('Open Ticket').setStyle(ButtonStyle.Danger)
  );
}

// Minimal toggle row (inside tickets): Band | Day only
function buildToggleRow(ctx, activeView) {
  const isBand = activeView === 'band';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ctx}|band`).setLabel('Zeal spend by XP Bracket').setStyle(isBand ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ctx}|day`).setLabel('Plan by day').setStyle(!isBand ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
}

// Close ticket button row
function buildCloseRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticketclose|${userId}`).setLabel('Close Ticket').setStyle(ButtonStyle.Secondary)
  );
}

// Ephemeral row after ticket creation: Link + Close by ID
function buildTicketEphemeralRow(guildId, channelId, userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Go to ticket')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guildId}/${channelId}`),
    new ButtonBuilder()
      .setCustomId(`ticketclosebyid|${channelId}|${userId}`)
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Secondary)
  );
}

// ───────── Launcher Rows (/swcalc initial) ─────────
function buildLauncherRows(mode = 'rsn', skill = 'Strength', acctType = 'non10hp') {
  return [
    new ActionRowBuilder().addComponents(buildModeSelect(mode)),
    new ActionRowBuilder().addComponents(buildSkillSelect(skill)),
    new ActionRowBuilder().addComponents(buildAccountSelect(acctType)),
    new ActionRowBuilder().addComponents(buildNextButton(mode, skill, acctType))
  ];
}

function buildDisabledLauncherRows(mode, skill, acctType) {
  return [
    new ActionRowBuilder().addComponents(buildModeSelect(mode, true)),
    new ActionRowBuilder().addComponents(buildSkillSelect(skill, true)),
    new ActionRowBuilder().addComponents(buildAccountSelect(acctType, true)),
    new ActionRowBuilder().addComponents(buildNextButton(mode, skill, acctType, true))
  ];
}

// ───────── Modal Builders ─────────
function buildInputModal(mode, skill, acctType) {
  const modal = new ModalBuilder()
    .setCustomId(`swcalc_modal|${mode}|${skill}|${acctType}`)
    .setTitle('Soul Wars Input');

  if (mode === 'rsn') {
    const rsnInput = new TextInputBuilder()
      .setCustomId('rsn')
      .setLabel('RuneScape Name (RSN)')
      .setPlaceholder('e.g. Zezima')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(12);

    const target = new TextInputBuilder()
      .setCustomId('target_level')
      .setLabel('Target level (default 99)')
      .setPlaceholder('e.g. 89  or blank → 99')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(rsnInput),
      new ActionRowBuilder().addComponents(target)
    );
  } else if (mode === 'xp') {
    const startVal = new TextInputBuilder()
      .setCustomId('start_val')
      .setLabel('Start XP')
      .setPlaceholder('Min XP - 13,363')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const target = new TextInputBuilder()
      .setCustomId('target_level')
      .setLabel('Target level (default 99)')
      .setPlaceholder('e.g. 89  or blank → 99')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(startVal),
      new ActionRowBuilder().addComponents(target)
    );
  } else {
    // lvl mode
    const startVal = new TextInputBuilder()
      .setCustomId('start_val')
      .setLabel('Start Level')
      .setPlaceholder('Min LVL - 30')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const target = new TextInputBuilder()
      .setCustomId('target_level')
      .setLabel('Target level (default 99)')
      .setPlaceholder('e.g. 89  or blank → 99')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(startVal),
      new ActionRowBuilder().addComponents(target)
    );
  }

  return modal;
}

// ───────── Helper: Read current selections from message components ─────────
function readCurrentSelections(message) {
  const getDefault = (compIndex) => {
    const comp = message.components[compIndex]?.components?.[0];
    return comp?.data?.options?.find?.(o => o.default)?.value
        || comp?.options?.find?.(o => o.default)?.value;
  };

  return {
    mode:    getDefault(0) || 'rsn',
    skill:   getDefault(1) || 'Strength',
    acctType: getDefault(2) || 'non10hp'
  };
}

module.exports = {
  buildModeSelect,
  buildSkillSelect,
  buildAccountSelect,
  buildNextButton,
  buildActionRow,
  buildToggleRow,
  buildCloseRow,
  buildTicketEphemeralRow,
  buildLauncherRows,
  buildDisabledLauncherRows,
  buildInputModal,
  readCurrentSelections
};
