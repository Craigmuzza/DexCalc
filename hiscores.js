// hiscores.js — OSRS Hiscores API integration with caching and retry
const axios = require('axios');

// Order of skills in OSRS hiscore_lite (after the "Overall" line)
const SKILL_ORDER = [
  'attack',       // 0
  'defence',      // 1
  'strength',     // 2
  'hitpoints',    // 3
  'ranged',       // 4
  'prayer',       // 5
  'magic',        // 6
  'cooking',      // 7
  'woodcutting',  // 8
  'fletching',    // 9
  'fishing',      // 10
  'firemaking',   // 11
  'crafting',     // 12
  'smithing',     // 13
  'mining',       // 14
  'herblore',     // 15
  'agility',      // 16
  'thieving',     // 17
  'slayer',       // 18
  'farming',      // 19
  'runecraft',    // 20
  'hunter',       // 21
  'construction', // 22
  'sailing'       // 23
];

const HISCORES_URL = 'https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES  = 2;
const RETRY_DELAY  = 1000; // 1 second

// In-memory cache (per process)
const cache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch and parse hiscore stats for a player.
 * Returns { attack: 75, attack_xp: 1212345, defence: 70, defence_xp: ..., ... }
 */
async function getPlayerStats(username) {
  if (!username) throw new Error('No username provided.');

  const name     = username.trim();
  const cacheKey = name.toLowerCase();

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `${HISCORES_URL}?player=${encodeURIComponent(name)}`;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.get(url, {
        responseType: 'text',
        timeout: 8000,
        validateStatus: s => s === 200 || s === 404
      });

      if (res.status === 404) {
        throw new Error(`Player **${name}** not found on hiscores.`);
      }

      const data = res.data;
      if (typeof data !== 'string' || !data.includes(',')) {
        throw new Error('Unexpected hiscores response format.');
      }

      const lines      = data.trim().split('\n');
      const skillLines = lines.slice(1); // skip "Overall"

      const stats = {};
      for (let i = 0; i < SKILL_ORDER.length; i++) {
        const key  = SKILL_ORDER[i];
        const line = skillLines[i];
        if (!line) continue;

        const [, levelStr, xpStr] = line.split(',');
        stats[key]          = Number(levelStr) || 1;
        stats[`${key}_xp`]  = Number(xpStr) || 0;
      }

      cache.set(cacheKey, { data: stats, timestamp: Date.now() });
      return stats;

    } catch (err) {
      lastError = err;

      // Don't retry on 404 (player not found) — that's definitive
      if (err.message.includes('not found')) throw err;

      if (attempt < MAX_RETRIES) {
        console.warn(`[hiscores] Attempt ${attempt + 1} failed for "${name}", retrying in ${RETRY_DELAY}ms…`);
        await sleep(RETRY_DELAY);
      }
    }
  }

  throw new Error(lastError?.message || 'Hiscores API error — please try again.');
}

/**
 * Invalidate cache for a specific player (useful for forced re-fetch).
 */
function invalidateCache(username) {
  if (username) cache.delete(username.trim().toLowerCase());
}

module.exports = {
  getPlayerStats,
  invalidateCache,
  SKILL_ORDER
};
