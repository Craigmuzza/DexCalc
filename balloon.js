// balloon.js — Balloon drop party event management
const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'balloons.json');

// ───────── Persistence ─────────
function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { counter: 0, active: null };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { counter: 0, active: null };
  }
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ───────── Public API ─────────

function getActive(guildId) {
  const data = load();
  const e = data.active;
  if (!e || e.guildId !== guildId || e.status !== 'active') return null;
  return e;
}

// price, eventTime, world, items are all display strings
function createEvent(guildId, channelId, title, totalTickets, price, eventTime, world, items, balloons = null) {
  const data   = load();
  data.counter = (data.counter || 0) + 1;
  data.active  = {
    id:           data.counter,
    guildId,
    channelId,
    title,
    totalTickets,
    price,
    eventTime,
    world,
    items,
    balloons,
    attendees:    [],   // array of userIds (one spot per person)
    status:       'active'
  };
  save(data);
  return data.active;
}

// Returns { event } on success, { error: 'no_event' | 'full' | 'already_has_ticket' }
function giveTicket(guildId, userId) {
  const data  = load();
  const event = data.active;
  if (!event || event.guildId !== guildId || event.status !== 'active') return { error: 'no_event' };
  if (event.attendees.includes(userId))                                  return { error: 'already_has_ticket', event };
  if (event.attendees.length >= event.totalTickets)                      return { error: 'full', event };

  event.attendees.push(userId);
  save(data);
  return { event };
}

// Returns { event } on success, { error: 'no_event' | 'no_ticket' }
function takeTicket(guildId, userId) {
  const data  = load();
  const event = data.active;
  if (!event || event.guildId !== guildId || event.status !== 'active') return { error: 'no_event' };

  const idx = event.attendees.indexOf(userId);
  if (idx === -1) return { error: 'no_ticket', event };

  event.attendees.splice(idx, 1);
  save(data);
  return { event };
}

// Returns the event title on success, false if none active
function cancelEvent(guildId) {
  const data = load();
  if (!data.active || data.active.guildId !== guildId || data.active.status !== 'active') return false;
  const title = data.active.title;
  data.active.status = 'cancelled';
  save(data);
  return title;
}

module.exports = { getActive, createEvent, giveTicket, takeTicket, cancelEvent };
