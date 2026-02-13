// tickets.js — Ticket creation, tracking, and closing
const fs   = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');
const { SUPPORT_ROLE_ID, ALLOWED_CLOSE_ROLES, TICKET_CATEGORY_ID } = require('./config');
const { buildPaymentEmbed } = require('./embeds');
const { buildCloseRow }     = require('./components');

const TICKET_COUNTER_FILE  = path.join(__dirname, 'ticket_counter.json');
const ACTIVE_TICKETS_FILE  = path.join(__dirname, 'active_tickets.json');

// ───────── File I/O Helpers ─────────
function loadJSON(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error(`[tickets] Error loading ${path.basename(filePath)}:`, e.message);
  }
  return fallback;
}

function saveJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[tickets] Error saving ${path.basename(filePath)}:`, e.message);
  }
}

// ───────── Active Ticket Tracking ─────────
function loadActiveTickets() {
  return loadJSON(ACTIVE_TICKETS_FILE);
}

function saveActiveTickets(data) {
  saveJSON(ACTIVE_TICKETS_FILE, data);
}

function addActiveTicket(guildId, userId, channelId) {
  const data = loadActiveTickets();
  data[`${guildId}-${userId}`] = channelId;
  saveActiveTickets(data);
}

function getActiveTicket(guildId, userId) {
  const data = loadActiveTickets();
  return data[`${guildId}-${userId}`] || null;
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

// ───────── Ticket Counter ─────────
async function getNextTicketNumber(guild) {
  const counters = loadJSON(TICKET_COUNTER_FILE);
  const next = (counters[guild.id] || 0) + 1;
  counters[guild.id] = next;
  saveJSON(TICKET_COUNTER_FILE, counters);
  return next;
}

// ───────── Permission Check ─────────
function canCloseTicket(interaction, openerId) {
  if (interaction.user.id === openerId) return true;
  if (SUPPORT_ROLE_ID && interaction.member?.roles?.cache?.has(SUPPORT_ROLE_ID)) return true;
  if (ALLOWED_CLOSE_ROLES.some(roleId => interaction.member?.roles?.cache?.has(roleId))) return true;
  return false;
}

// ───────── Create Ticket Channel ─────────
async function openTicketChannel(interaction, embedsToCopy, componentsToCopy) {
  const guild = interaction.guild;
  if (!guild) throw new Error('No guild on interaction');

  const nextNum = await getNextTicketNumber(guild);
  const name    = `SW-${nextNum}`;

  const everyoneId = guild.roles.everyone.id;
  const overwrites = [
    { id: everyoneId, deny: ['ViewChannel'] },
    { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks'] }
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

  // Send the copied embed(s) if provided
  if (embedsToCopy?.length) {
    await channel.send({
      content: SUPPORT_ROLE_ID ? `<@&${SUPPORT_ROLE_ID}>` : undefined,
      embeds: embedsToCopy,
      components: componentsToCopy
        ? (Array.isArray(componentsToCopy) ? componentsToCopy : [componentsToCopy])
        : []
    });
  }

  // Payment info + close button
  const paymentEmbed = buildPaymentEmbed(interaction);
  const closeRow     = buildCloseRow(interaction.user.id);
  await channel.send({ embeds: [paymentEmbed], components: [closeRow] });

  return channel;
}

// ───────── Close Ticket (from inside ticket channel) ─────────
async function closeTicketChannel(interaction) {
  const parts    = interaction.customId.split('|');
  const openerId = parts[1];

  if (!canCloseTicket(interaction, openerId)) {
    await interaction.deferReply({ ephemeral: true });
    return interaction.editReply({ content: 'Only the opener or staff can close this ticket.' });
  }

  if (!interaction.channel) {
    await interaction.deferReply({ ephemeral: true });
    return interaction.editReply({ content: 'Channel not found (already closed?).' });
  }

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply({ content: 'Closing ticket in 3 seconds…' });

  setTimeout(async () => {
    try { await interaction.channel.delete('Ticket closed'); } catch {}
  }, 3000);
}

// ───────── Close Ticket by ID (from ephemeral) ─────────
async function closeTicketById(interaction, channelId, openerId) {
  if (!canCloseTicket(interaction, openerId)) {
    await interaction.deferReply({ ephemeral: true });
    return interaction.editReply({ content: 'Only the opener or staff can close this ticket.' });
  }

  try {
    let ch = interaction.client.channels.cache.get(channelId);
    if (!ch) {
      try {
        ch = await interaction.client.channels.fetch(channelId);
      } catch {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply({ content: 'That ticket channel no longer exists (already closed or I can\'t see it).' });
      }
    }

    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({ content: 'Closing ticket in 3 seconds…' });

    setTimeout(async () => {
      try { await ch.delete('Ticket closed'); } catch {}
    }, 3000);
  } catch (err) {
    console.error('[tickets] closeTicketById error:', err);
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }
      await interaction.editReply({ content: 'Failed to close ticket (permissions or missing channel).' });
    } catch {}
  }
}

module.exports = {
  loadActiveTickets,
  addActiveTicket,
  getActiveTicket,
  removeActiveTicketByChannelId,
  openTicketChannel,
  closeTicketChannel,
  closeTicketById
};
