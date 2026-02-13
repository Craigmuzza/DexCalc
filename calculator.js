// calculator.js — Soul Wars XP/zeal calculation engine
const {
  OSRS_XP_TABLE,
  SW_RATES,
  DAILY_CAP_XP,
  ZEAL_PER_HOUR,
  NORMAL_PRICE_TIERS,
  HP10_PRICE_TIERS,
  SKILL_EMOJIS
} = require('./config');

// ───────── Formatting Helpers ─────────
const fmtInt = n => n.toLocaleString('en-GB');

function hoursToDHMS(hours) {
  const totalMinutes = Math.round(hours * 60);
  const days    = Math.floor(totalMinutes / (60 * 24));
  const rem     = totalMinutes - days * 24 * 60;
  const hrs     = Math.floor(rem / 60);
  const mins    = rem - hrs * 60;
  return { days, hours: hrs, minutes: mins };
}

function formatDHMS(hours) {
  const { days, hours: h, minutes: m } = hoursToDHMS(hours);
  return `${days}d ${h}h ${m}m`;
}

// ───────── XP / Level Lookups ─────────
function getXPForLevel(level) {
  const lvl = Math.max(1, Math.min(99, level | 0));
  return OSRS_XP_TABLE[lvl];
}

function getLevel(xp) {
  if (xp <= 0) return 1;
  if (xp >= OSRS_XP_TABLE[99]) return 99;
  let lo = 1, hi = 99;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (OSRS_XP_TABLE[mid] <= xp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function getSWRateForLevel(lvl, skill) {
  if (lvl < 30) return 0;
  const band = SW_RATES.find(b => lvl >= b.from && lvl <= b.to);
  if (!band) return 0;
  if (skill === 'Prayer') return band.prayer;
  if (skill === 'Magic' || skill === 'Ranged') return band.mageRange;
  return band.meleeHp;
}

// ───────── Pricing ─────────
function gpCost(zeal, acctType) {
  const tiers = acctType === '10hp' ? HP10_PRICE_TIERS : NORMAL_PRICE_TIERS;
  const tier  = tiers.find(t => zeal <= t.maxZeal);
  return { rate: tier.rate, total: zeal * tier.rate, discount: tier.discount };
}

function accountLabel(acctType) {
  return acctType === '10hp' ? '10 HP' : 'Non-10 HP';
}

// ───────── Skill Helpers ─────────
function skillEmoji(skill) {
  return SKILL_EMOJIS[skill] || '⭐';
}

function skillToHiscoreKey(skill) {
  return skill.toLowerCase();
}

// ───────── Progress Bar ─────────
function progressBar(current, target, width = 20) {
  const pct    = Math.max(0, Math.min(1, current / target));
  const filled = Math.round(width * pct);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${(pct * 100).toFixed(1)}%`;
}

// ───────── Core: Plan by XP Bracket ─────────
function calcSoulWarsPlan(startXP, targetLevel, skill) {
  const targetXP   = getXPForLevel(targetLevel);
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

  let currBandKey    = null;
  let bandTokens     = 0;
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
    const lvl  = getLevel(xp);
    const rate = getSWRateForLevel(lvl, skill);
    if (rate <= 0) break;

    const band = SW_RATES.find(b => lvl >= b.from && lvl <= b.to);
    if (!band) break;

    const bandKey = `${band.from}-${band.to}`;

    if (bandKey !== currBandKey) {
      if (currBandKey) pushBandRow(getLevel(xp));
      currBandKey    = bandKey;
      bandTokens     = 0;
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
  const days     = neededXP === 0 ? 0 : Math.max(1, Math.ceil(neededXP / DAILY_CAP_XP));

  return { ok: true, startLevel, targetXP, neededXP, rows, tokens, days, targetXPAbs: targetXP };
}

// ───────── Core: Plan by Day ─────────
function calcPlanByDay(startXP, targetLevel, skill) {
  const targetXP = getXPForLevel(targetLevel);
  let xp = startXP;
  let day = 1, xpDay = 0, tokensDay = 0;
  let dayStartLevel = getLevel(xp);
  const out = [];

  const pushDay = () => {
    out.push({ day, tokens: tokensDay, xp: xpDay, fromLvl: dayStartLevel, toLvl: getLevel(xp) });
    day += 1;
    xpDay = 0;
    tokensDay = 0;
    dayStartLevel = getLevel(xp);
  };

  while (xp < targetXP) {
    const lvl  = getLevel(xp);
    if (lvl < 30) break;
    const rate = getSWRateForLevel(lvl, skill);
    if (rate <= 0) break;

    if (xpDay + rate > DAILY_CAP_XP) { pushDay(); continue; }

    xp += rate;
    xpDay += rate;
    tokensDay += 1;

    if (xp >= targetXP) { pushDay(); break; }
  }

  if (tokensDay > 0 || xpDay > 0) pushDay();
  return out;
}

// ───────── Multi-Skill Quote (for /swquote) ─────────
function calcMultiSkillQuote(stats, targetLevel, acctType, skills) {
  const results = [];
  let grandTotalZeal = 0;

  for (const skill of skills) {
    const key    = skillToHiscoreKey(skill);
    const xpKey  = `${key}_xp`;
    const currXP = stats[xpKey];

    if (currXP === undefined || currXP === null) {
      results.push({ skill, skipped: true, reason: 'unranked' });
      continue;
    }

    const currLevel = getLevel(currXP);
    if (currLevel >= targetLevel) {
      results.push({ skill, skipped: true, reason: 'already_met', level: currLevel, xp: currXP });
      continue;
    }

    const plan = calcSoulWarsPlan(currXP, targetLevel, skill);
    if (!plan.ok) {
      results.push({ skill, skipped: true, reason: plan.reason, level: currLevel, xp: currXP });
      continue;
    }

    const cost  = gpCost(plan.tokens, acctType);
    const hours = plan.tokens / ZEAL_PER_HOUR;

    grandTotalZeal += plan.tokens;

    results.push({
      skill,
      skipped: false,
      level: currLevel,
      xp: currXP,
      targetXP: plan.targetXPAbs,
      zeal: plan.tokens,
      days: plan.days,
      hours,
      cost
    });
  }

  const grandCost = gpCost(grandTotalZeal, acctType);
  const grandHours = grandTotalZeal / ZEAL_PER_HOUR;

  return { results, grandTotalZeal, grandCost, grandHours };
}

module.exports = {
  fmtInt,
  hoursToDHMS,
  formatDHMS,
  getXPForLevel,
  getLevel,
  getSWRateForLevel,
  gpCost,
  accountLabel,
  skillEmoji,
  skillToHiscoreKey,
  progressBar,
  calcSoulWarsPlan,
  calcPlanByDay,
  calcMultiSkillQuote
};
