// raffle.js — Raffle data management
const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'raffles.json');

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
  const r = data.active;
  if (!r || r.guildId !== guildId || r.status !== 'active') return null;
  return r;
}

function createRaffle(guildId, channelId, title, totalTickets, prizes) {
  const data    = load();
  data.counter  = (data.counter || 0) + 1;
  data.active   = {
    id:           data.counter,
    guildId,
    channelId,
    title,
    totalTickets,
    prizes,
    nextTicketNum: 1,
    tickets:       {},   // userId -> [ticketNums]
    soldCount:     0,
    status:        'active'
  };
  save(data);
  return data.active;
}

// Returns { tickets, soldCount, totalTickets, complete, raffle }
// or      { error: 'no_raffle' | 'full' }
function assignTickets(guildId, userId, amount) {
  const data   = load();
  const raffle = data.active;
  if (!raffle || raffle.guildId !== guildId || raffle.status !== 'active') return { error: 'no_raffle' };

  const remaining = raffle.totalTickets - raffle.soldCount;
  if (remaining <= 0) return { error: 'full', raffle };

  const toAssign = Math.min(amount, remaining);
  if (!raffle.tickets[userId]) raffle.tickets[userId] = [];

  const newNums = [];
  for (let i = 0; i < toAssign; i++) {
    newNums.push(raffle.nextTicketNum++);
  }
  raffle.tickets[userId].push(...newNums);
  raffle.soldCount += toAssign;

  const complete = raffle.soldCount >= raffle.totalTickets;
  save(data);
  return { tickets: newNums, soldCount: raffle.soldCount, totalTickets: raffle.totalTickets, complete, raffle };
}

// Returns { removed, soldCount, totalTickets, raffle }
// or      { error: 'no_raffle' | 'no_tickets' }
function removeTickets(guildId, userId, amount) {
  const data   = load();
  const raffle = data.active;
  if (!raffle || raffle.guildId !== guildId || raffle.status !== 'active') return { error: 'no_raffle' };

  const userTickets = raffle.tickets[userId];
  if (!userTickets || !userTickets.length) return { error: 'no_tickets', raffle };

  const toRemove = Math.min(amount, userTickets.length);
  const removed  = userTickets.splice(-toRemove, toRemove);
  if (!userTickets.length) delete raffle.tickets[userId];

  raffle.soldCount -= toRemove;
  save(data);
  return { removed, soldCount: raffle.soldCount, totalTickets: raffle.totalTickets, raffle };
}

// Returns { winners: [{userId, ticketNum, prize}], raffle }
// or      { error: 'no_raffle' | 'no_tickets' }
function rollWinners(guildId) {
  const data   = load();
  const raffle = data.active;
  if (!raffle || raffle.guildId !== guildId || raffle.status !== 'active') return { error: 'no_raffle' };

  // Build flat ticket pool
  const pool = [];
  for (const [userId, nums] of Object.entries(raffle.tickets)) {
    for (const num of nums) pool.push({ userId, num });
  }
  if (!pool.length) return { error: 'no_tickets', raffle };

  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const winners   = [];
  const usedUsers = new Set();

  for (const prize of raffle.prizes) {
    if (!pool.length) break;
    // Prefer a winner who hasn't won yet
    const idx     = pool.findIndex(t => !usedUsers.has(t.userId));
    const pick    = idx >= 0 ? pool.splice(idx, 1)[0] : pool.splice(0, 1)[0];
    winners.push({ userId: pick.userId, ticketNum: pick.num, prize });
    usedUsers.add(pick.userId);
  }

  raffle.status  = 'completed';
  raffle.winners = winners;
  save(data);
  return { winners, raffle };
}

function cancelRaffle(guildId) {
  const data = load();
  if (!data.active || data.active.guildId !== guildId || data.active.status !== 'active') return false;
  const title = data.active.title;
  data.active.status = 'cancelled';
  save(data);
  return title;
}

module.exports = { getActive, createRaffle, assignTickets, removeTickets, rollWinners, cancelRaffle };
