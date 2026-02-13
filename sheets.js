// sheets.js — Google Sheets CRM Integration
//
// Spreadsheet layout:
//   "Customer Spend Totals" — Full CRM dashboard (one row per customer)
//      A: Discord ID | B: Username | C: Display Name | D: Total Spent ($) | E: # Purchases
//      F: Avg Purchase ($) | G: First Purchase | H: Last Purchase Date | I: Last Purchase ($)
//      J: Last Purchase Note | K: Rank | L: Days Inactive | M: Join Date | N: Status
//
//   "Transactions" — Individual payment log
//      A: Date | B: Discord ID | C: Username | D: Amount ($) | E: Running Total ($) | F: Note | G: Logged By
//
const { google } = require('googleapis');

const SPREADSHEET_ID     = process.env.GOOGLE_SPREADSHEET_ID;
const CRM_SHEET          = 'Customer Spend Totals';
const TRANSACTIONS_SHEET = 'Transactions';

const CRM_HEADERS = [
  'Discord ID', 'Username', 'Display Name', 'Total Spent ($)', '# Purchases',
  'Avg Purchase ($)', 'First Purchase', 'Last Purchase Date', 'Last Purchase ($)',
  'Last Purchase Note', 'Rank', 'Days Inactive', 'Join Date', 'Status'
];
const CRM_COL_COUNT = CRM_HEADERS.length; // A through N = 14

const TX_HEADERS = ['Date', 'Discord ID', 'Username', 'Amount ($)', 'Running Total ($)', 'Note', 'Logged By'];

// ───────── Customer Tiers ─────────
const CUSTOMER_TIERS = require('./config').CUSTOMER_TIERS;

function getTier(totalSpent) {
  // Walk backwards through tiers (highest first) to find the matching tier
  for (let i = CUSTOMER_TIERS.length - 1; i >= 0; i--) {
    if (totalSpent >= CUSTOMER_TIERS[i].minSpend) return CUSTOMER_TIERS[i];
  }
  return CUSTOMER_TIERS[0];
}

function getStatus(totalSpent, lastPaymentDate) {
  if (totalSpent <= 0) return 'New';
  if (!lastPaymentDate) return 'New';
  const daysSince = daysBetween(lastPaymentDate, new Date());
  if (daysSince <= 30)  return 'Active';
  if (daysSince <= 90)  return 'Idle';
  return 'Inactive';
}

// ───────── Auth ─────────
let sheetsClient = null;

function getAuth() {
  const credFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const credJSON = process.env.GOOGLE_CREDENTIALS_JSON;

  if (credJSON) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(credJSON),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }
  if (credFile) {
    return new google.auth.GoogleAuth({
      keyFile: credFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }
  throw new Error('No Google credentials configured. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CREDENTIALS_JSON in .env');
}

async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = getAuth();
  const client = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: client });
  return sheetsClient;
}

// ───────── Helpers ─────────
function nowISO() {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

function fmtUSD(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

function daysBetween(dateStr, now) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 999;
    return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  } catch { return 999; }
}

function colLetter(idx) {
  // 0 = A, 1 = B, ..., 13 = N
  return String.fromCharCode(65 + idx);
}

// ───────── Ensure Sheets & Headers ─────────
async function ensureHeaders() {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingSheets = meta.data.sheets.map(s => s.properties.title);

  // Create missing sheets
  const requests = [];
  if (!existingSheets.includes(CRM_SHEET)) {
    requests.push({ addSheet: { properties: { title: CRM_SHEET } } });
  }
  if (!existingSheets.includes(TRANSACTIONS_SHEET)) {
    requests.push({ addSheet: { properties: { title: TRANSACTIONS_SHEET } } });
  }
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });
  }

  // Remove the old "Customers" sheet if it exists and is empty (migration)
  if (existingSheets.includes('Customers')) {
    try {
      const oldData = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Customers!A:A'
      });
      const rows = oldData.data.values || [];
      if (rows.length <= 1) {
        // Only header or empty — safe to remove
        const sheetMeta = meta.data.sheets.find(s => s.properties.title === 'Customers');
        if (sheetMeta) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: { requests: [{ deleteSheet: { sheetId: sheetMeta.properties.sheetId } }] }
          });
          console.log('[sheets] Removed old empty "Customers" sheet');
        }
      }
    } catch (e) { /* ignore */ }
  }

  // CRM headers — always overwrite to keep in sync with code
  const endCol = colLetter(CRM_COL_COUNT - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${CRM_SHEET}'!A1:${endCol}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [CRM_HEADERS] }
  });

  // Transaction headers
  const txH = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${TRANSACTIONS_SHEET}'!A1:G1`
  });
  if (!txH.data.values || !txH.data.values.length || txH.data.values[0].length < TX_HEADERS.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${TRANSACTIONS_SHEET}'!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: { values: [TX_HEADERS] }
    });
  }
}

// ───────── Parse a CRM Row ─────────
function parseCRMRow(row, rowIndex) {
  return {
    rowIndex,               // 1-based sheet row
    discordId:       row[0]  || '',
    username:        row[1]  || '',
    displayName:     row[2]  || '',
    totalSpent:      parseFloat(row[3]) || 0,
    purchaseCount:   parseInt(row[4])   || 0,
    avgPurchase:     parseFloat(row[5]) || 0,
    firstPurchase:   row[6]  || '',
    lastPurchaseDate:row[7]  || '',
    lastPurchaseAmt: parseFloat(row[8]) || 0,
    lastPurchaseNote:row[9]  || '',
    tier:            row[10] || 'New',
    daysInactive:    parseInt(row[11])  || 0,
    joinDate:        row[12] || '',
    status:          row[13] || 'New'
  };
}

function buildCRMRow(data) {
  const now = new Date();
  const tier = getTier(data.totalSpent);
  const status = getStatus(data.totalSpent, data.lastPurchaseDate);
  const daysInactive = data.lastPurchaseDate ? daysBetween(data.lastPurchaseDate, now) : '';
  const avg = data.purchaseCount > 0 ? (data.totalSpent / data.purchaseCount).toFixed(2) : '0.00';

  return [
    String(data.discordId),
    data.username,
    data.displayName,
    data.totalSpent.toFixed(2),
    String(data.purchaseCount),
    avg,
    data.firstPurchase || '',
    data.lastPurchaseDate || '',
    data.lastPurchaseAmt ? data.lastPurchaseAmt.toFixed(2) : '0.00',
    data.lastPurchaseNote || '',
    `${tier.emoji} ${tier.name}`,
    daysInactive !== '' ? String(daysInactive) : '',
    data.joinDate || '',
    status
  ];
}

// ───────── Find Customer ─────────
async function findCustomer(discordId) {
  const sheets = await getSheets();
  const endCol = colLetter(CRM_COL_COUNT - 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${CRM_SHEET}'!A:${endCol}`
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === String(discordId)) {
      return parseCRMRow(rows[i], i + 1);
    }
  }
  return null;
}

// ───────── Add Customer (auto-add on join / first interaction) ─────────
async function addCustomer(discordId, username, displayName) {
  const existing = await findCustomer(discordId);
  if (existing) {
    // Update username/display name if changed
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${CRM_SHEET}'!B${existing.rowIndex}:C${existing.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[username, displayName]] }
    });
    return { isNew: false, ...existing };
  }

  const data = {
    discordId: String(discordId),
    username,
    displayName,
    totalSpent: 0,
    purchaseCount: 0,
    firstPurchase: '',
    lastPurchaseDate: '',
    lastPurchaseAmt: 0,
    lastPurchaseNote: '',
    joinDate: nowISO()
  };

  const sheets = await getSheets();
  const endCol = colLetter(CRM_COL_COUNT - 1);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${CRM_SHEET}'!A:${endCol}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [buildCRMRow(data)] }
  });

  return { isNew: true, ...data, tier: '🆕 New', status: 'New' };
}

// ───────── Record Payment ─────────
async function recordPayment(discordId, username, displayName, amount, note = '', loggedBy = '') {
  const sheets = await getSheets();

  let customer = await findCustomer(discordId);
  if (!customer) {
    await addCustomer(discordId, username, displayName);
    customer = await findCustomer(discordId);
  }

  const now = nowISO();
  const newTotal = customer.totalSpent + amount;
  const newCount = customer.purchaseCount + 1;

  const updatedData = {
    discordId: String(discordId),
    username,
    displayName,
    totalSpent: newTotal,
    purchaseCount: newCount,
    firstPurchase: customer.firstPurchase || now,
    lastPurchaseDate: now,
    lastPurchaseAmt: amount,
    lastPurchaseNote: note,
    joinDate: customer.joinDate || now
  };

  const endCol = colLetter(CRM_COL_COUNT - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${CRM_SHEET}'!A${customer.rowIndex}:${endCol}${customer.rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [buildCRMRow(updatedData)] }
  });

  // Log transaction
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${TRANSACTIONS_SHEET}'!A:G`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[now, String(discordId), username, amount.toFixed(2), newTotal.toFixed(2), note, loggedBy]]
    }
  });

  const prevTier = getTier(customer.totalSpent);
  const newTier  = getTier(newTotal);
  const tierUp   = newTier.name !== prevTier.name && newTotal > 0;

  return {
    previousTotal: customer.totalSpent,
    newTotal,
    amount,
    purchaseCount: newCount,
    tier: newTier,
    previousTier: prevTier,
    tierUp
  };
}

// ───────── Record Refund ─────────
async function recordRefund(discordId, username, displayName, amount, note = '', loggedBy = '') {
  const sheets = await getSheets();

  const customer = await findCustomer(discordId);
  if (!customer) return null;

  const now = nowISO();
  const newTotal = Math.max(0, customer.totalSpent - amount);

  const updatedData = {
    discordId: String(discordId),
    username,
    displayName,
    totalSpent: newTotal,
    purchaseCount: customer.purchaseCount, // don't decrement
    firstPurchase: customer.firstPurchase,
    lastPurchaseDate: customer.lastPurchaseDate,
    lastPurchaseAmt: customer.lastPurchaseAmt,
    lastPurchaseNote: customer.lastPurchaseNote,
    joinDate: customer.joinDate
  };

  const endCol = colLetter(CRM_COL_COUNT - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${CRM_SHEET}'!A${customer.rowIndex}:${endCol}${customer.rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [buildCRMRow(updatedData)] }
  });

  // Log refund as negative transaction
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${TRANSACTIONS_SHEET}'!A:G`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[now, String(discordId), username, (-amount).toFixed(2), newTotal.toFixed(2), `REFUND: ${note}`, loggedBy]]
    }
  });

  return { previousTotal: customer.totalSpent, newTotal, amount, tier: getTier(newTotal) };
}

// ───────── Getters ─────────
async function getCustomer(discordId) {
  const customer = await findCustomer(discordId);
  if (!customer) return null;
  const tier = getTier(customer.totalSpent);
  const status = getStatus(customer.totalSpent, customer.lastPurchaseDate);
  return { ...customer, tierObj: tier, liveStatus: status };
}

async function getAllCustomers() {
  const sheets = await getSheets();
  const endCol = colLetter(CRM_COL_COUNT - 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${CRM_SHEET}'!A:${endCol}`
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return [];

  return rows.slice(1)
    .map((r, idx) => parseCRMRow(r, idx + 2))
    .sort((a, b) => b.totalSpent - a.totalSpent);
}

async function getTransactions(discordId, limit = 10) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${TRANSACTIONS_SHEET}'!A:G`
  });

  const rows = res.data.values || [];
  return rows.slice(1)
    .filter(r => r[1] === String(discordId))
    .map(r => ({
      date: r[0] || '',
      discordId: r[1] || '',
      username: r[2] || '',
      amount: parseFloat(r[3]) || 0,
      runningTotal: parseFloat(r[4]) || 0,
      note: r[5] || '',
      loggedBy: r[6] || ''
    }))
    .reverse()
    .slice(0, limit);
}

// ───────── Revenue Stats ─────────
async function getRevenueStats() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${TRANSACTIONS_SHEET}'!A:G`
  });

  const rows = res.data.values || [];
  const txRows = rows.slice(1);
  if (!txRows.length) return { monthly: [], allTime: 0, thisMonth: 0, lastMonth: 0, txCount: 0 };

  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

  const monthly = {};
  let allTime = 0;
  let txCount = 0;

  for (const r of txRows) {
    const amount = parseFloat(r[3]) || 0;
    const dateStr = r[0] || '';

    allTime += amount;
    txCount++;

    // Extract YYYY-MM from date
    const match = dateStr.match(/^(\d{4}-\d{2})/);
    if (match) {
      const key = match[1];
      monthly[key] = (monthly[key] || 0) + amount;
    }
  }

  // Sort monthly desc
  const sortedMonthly = Object.entries(monthly)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 12)
    .map(([month, total]) => ({ month, total }));

  return {
    monthly: sortedMonthly,
    allTime,
    thisMonth: monthly[thisMonthKey] || 0,
    lastMonth: monthly[lastMonthKey] || 0,
    txCount
  };
}

// ───────── Refresh All CRM Data (recalculate tiers, status, days inactive) ─────────
async function refreshAllCRM() {
  const sheets = await getSheets();
  const endCol = colLetter(CRM_COL_COUNT - 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${CRM_SHEET}'!A:${endCol}`
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return 0;

  const updates = [];
  for (let i = 1; i < rows.length; i++) {
    const customer = parseCRMRow(rows[i], i + 1);
    const freshRow = buildCRMRow(customer);
    updates.push({
      range: `'${CRM_SHEET}'!A${i + 1}:${endCol}${i + 1}`,
      values: [freshRow]
    });
  }

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates
      }
    });
  }

  return updates.length;
}

// ───────── Init ─────────
async function initSheets() {
  if (!SPREADSHEET_ID) {
    console.warn('[sheets] GOOGLE_SPREADSHEET_ID not set — Sheets integration disabled.');
    return false;
  }

  try {
    await ensureHeaders();
    // Refresh all tiers/status on startup
    const refreshed = await refreshAllCRM();
    console.log(`[sheets] Connected. CRM headers verified. Refreshed ${refreshed} customer rows.`);
    return true;
  } catch (err) {
    console.error('[sheets] Init failed:', err.message);
    return false;
  }
}

module.exports = {
  initSheets,
  addCustomer,
  recordPayment,
  recordRefund,
  getCustomer,
  getAllCustomers,
  getTransactions,
  getRevenueStats,
  refreshAllCRM,
  getTier,
  getStatus,
  fmtUSD,
  CUSTOMER_TIERS
};
