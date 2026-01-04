// utils/hiscores.js
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
  'runecraft',    // 20 (Runecrafting)
  'hunter',       // 21
  'construction', // 22
  'sailing'       // 23 – new skill
];

// In-memory cache (very simple, per process)
const cache = new Map();

/**
 * Get hiscore stats for a player from OSRS hiscore_lite.
 * Returns an object like:
 * {
 *   attack: 75, attack_xp: 1212345,
 *   defence: 70, defence_xp: ...,
 *   ...
 * }
 */
async function getPlayerStats(username) {
  if (!username) throw new Error('No username provided');

  const name = username.trim();
  const cacheKey = name.toLowerCase();

  // 5-minute in-memory cache
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.timestamp) < 5 * 60 * 1000) {
    return cached.data;
  }

  const url = `https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=${encodeURIComponent(name)}`;

  let data;
  try {
    const res = await axios.get(url, {
      responseType: 'text',
      validateStatus: (s) => s === 200 || s === 404
    });

    if (res.status === 404) {
      throw new Error('Player not found on hiscores');
    }

    data = res.data;
    if (typeof data !== 'string' || !data.includes(',')) {
      throw new Error('Unexpected hiscores response');
    }
  } catch (err) {
    // Normalise error message a bit
    if (err.message === 'Player not found on hiscores') {
      throw err;
    }
    throw new Error('Hiscores API error');
  }

  const lines = data.trim().split('\n');

  // First line is Overall, skip it
  const skillLines = lines.slice(1);

  const stats = {};
  for (let i = 0; i < SKILL_ORDER.length; i++) {
    const key = SKILL_ORDER[i];
    const line = skillLines[i];
    if (!line) continue;

    const [rankStr, levelStr, xpStr] = line.split(',');
    const lvl = Number(levelStr) || 1;
    const xp = Number(xpStr) || 0;

    stats[key] = lvl;
    stats[`${key}_xp`] = xp;
  }

  cache.set(cacheKey, { data: stats, timestamp: now });
  return stats;
}

module.exports = {
  getPlayerStats
};
