// config.js — Centralised configuration, constants, XP tables, and pricing
require('dotenv').config();

// ───────── Environment ─────────
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env / Render env');
  process.exit(1);
}

const DEPLOY_SLASH = process.env.DEPLOY_SLASH === '1';

// Support both GUILD_IDS (comma-sep) and GUILD_ID (single) for convenience
const GUILD_IDS = (process.env.GUILD_IDS || process.env.GUILD_ID || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;
const SUPPORT_ROLE_ID    = process.env.SUPPORT_ROLE_ID || null;

// Roles allowed to close tickets — configurable via .env (comma-separated)
const ALLOWED_CLOSE_ROLES = (process.env.ALLOWED_CLOSE_ROLES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Roles allowed to use /paid (staff only) — configurable via .env (comma-separated)
const PAID_COMMAND_ROLES = (process.env.PAID_COMMAND_ROLES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ───────── Google Sheets ─────────
const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || null;

// ───────── Artwork / Branding ─────────
const LOGO_URL      = 'https://i.ibb.co/BKZGsfgw/PPGif.gif';
const BANNER_URL    = 'https://i.ibb.co/7xwxnNpP/banner.gif';
const WATERMARK_URL = 'https://i.ibb.co/b59Hb5c0/PPwatermarkletters.png';

// ───────── Theme ─────────
const THEME_COLOR = 0x9b59b6; // Occult Mafia purple

// ───────── Domain Constants ─────────
const VALID_SKILLS  = ['Strength', 'Ranged', 'Magic', 'Hitpoints', 'Attack', 'Defence', 'Prayer'];
const DAILY_CAP_XP  = 1_000_000;
const ZEAL_PER_HOUR = 270;

// ───────── Tiered Pricing ─────────
// Normal Dolo Boost (minimal HP XP)
const NORMAL_PRICE_TIERS = [
  { maxZeal: 2499,     rate: 40_000, discount: 0  },
  { maxZeal: 4999,     rate: 38_000, discount: 5  },
  { maxZeal: 9999,     rate: 36_000, discount: 10 },
  { maxZeal: 14999,    rate: 34_000, discount: 15 },
  { maxZeal: 19999,    rate: 32_000, discount: 20 },
  { maxZeal: Infinity, rate: 30_000, discount: 25 }
];

// 10 HP Restricted
const HP10_PRICE_TIERS = [
  { maxZeal: 2499,     rate: 50_000, discount: 0  },
  { maxZeal: 4999,     rate: 47_500, discount: 5  },
  { maxZeal: 9999,     rate: 45_000, discount: 10 },
  { maxZeal: 14999,    rate: 42_500, discount: 15 },
  { maxZeal: 19999,    rate: 40_000, discount: 20 },
  { maxZeal: Infinity, rate: 37_500, discount: 25 }
];

// Soul Wars XP per zeal by combat level band
const SW_RATES = [
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
const OSRS_XP_TABLE = [
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

// ───────── Customer Tiers (for CRM rewards program) ─────────
const CUSTOMER_TIERS = [
  { name: 'New',      emoji: '🆕', minSpend: 0,    maxSpend: 0      },
  { name: 'Bronze',   emoji: '🥉', minSpend: 0.01, maxSpend: 99.99  },
  { name: 'Silver',   emoji: '🥈', minSpend: 100,  maxSpend: 249.99 },
  { name: 'Gold',     emoji: '🥇', minSpend: 250,  maxSpend: 499.99 },
  { name: 'Platinum', emoji: '💎', minSpend: 500,  maxSpend: 999.99 },
  { name: 'Diamond',  emoji: '👑', minSpend: 1000, maxSpend: Infinity }
];

// Skill emoji mapping
const SKILL_EMOJIS = {
  Strength:  '🗡️',
  Attack:    '⚔️',
  Defence:   '🛡️',
  Hitpoints: '❤️',
  Ranged:    '🏹',
  Magic:     '🪄',
  Prayer:    '🙏'
};

module.exports = {
  TOKEN,
  DEPLOY_SLASH,
  GUILD_IDS,
  TICKET_CATEGORY_ID,
  SUPPORT_ROLE_ID,
  ALLOWED_CLOSE_ROLES,
  PAID_COMMAND_ROLES,
  GOOGLE_SPREADSHEET_ID,
  LOGO_URL,
  BANNER_URL,
  WATERMARK_URL,
  THEME_COLOR,
  VALID_SKILLS,
  DAILY_CAP_XP,
  ZEAL_PER_HOUR,
  NORMAL_PRICE_TIERS,
  HP10_PRICE_TIERS,
  SW_RATES,
  OSRS_XP_TABLE,
  SKILL_EMOJIS,
  CUSTOMER_TIERS
};
