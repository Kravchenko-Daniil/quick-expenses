#!/usr/bin/env node
// Schema migration v2 — reshapes the live spreadsheet to the human-friendly layout
// the API (src/index.js) now expects. Run backup-sheets.mjs first.
//
//   Accounts:  card_t→tbank_debit, card_vtb→vtb_debit; + new credit accounts.
//              English names (only the Events Note column stays Russian).
//   Events:    columns reordered to  When | Type | From | To | Amount | Received |
//              Note | id | at | client_id  (When is a derived display date; id/at/
//              client_id are hidden). from/to ids remapped to the new account ids.
//   Balances:  "Updated" line up top, accounts table below (header scanned by the
//              API), Totals block below that. Raw updated_at ISO stays at F1.
//
// Styling is applied separately by format-sheets.mjs. This script only moves data.
// DRY_RUN=1 prints the plan without writing.
//
// Usage:  node scripts/migrate-schema-v2.mjs   (or DRY_RUN=1 node ...)

import {
  loadSA, spreadsheetId, getToken, valuesGet, valuesClear, valuesBatchUpdate, die,
} from './_lib.mjs';

const EVENTS = 'Events';
const BALANCES = 'Balances';

// --- account model ---
const RENAME = { card_t: 'tbank_debit', card_vtb: 'vtb_debit' };
const NEW_ACCOUNTS = [
  { id: 'tbank_credit', name: 'T-Bank credit', currency: 'RUB' },
  { id: 'tbank_creditcard', name: 'T-Bank credit card', currency: 'RUB' },
  { id: 'vtb_credit', name: 'VTB credit', currency: 'RUB' },
  { id: 'alfa_creditcard', name: 'Alfa credit card', currency: 'RUB' },
  { id: 'mtc_credit', name: 'MTC credit', currency: 'RUB' },
];
const NAME_OVERRIDE = {
  cash: 'Cash', bybit: 'Bybit', maxswap: 'maxswap',
  tbank_debit: 'T-Bank debit', vtb_debit: 'VTB debit',
};
const ACCOUNT_ORDER = [
  'cash', 'bybit', 'maxswap', 'tbank_debit', 'vtb_debit',
  'tbank_credit', 'tbank_creditcard', 'vtb_credit', 'alfa_creditcard', 'mtc_credit',
];

const EVENTS_HEADER = ['When', 'Type', 'From', 'To', 'Amount', 'Received', 'Note', 'id', 'at', 'client_id'];

// formatWhen — must match api/src/index.js. Noon-exact = backdate placeholder
// → date only; otherwise DD.MM.YYYY HH:MM (Bangkok).
function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const date = `${p.day}.${p.month}.${p.year}`;
  if (p.hour === '12' && p.minute === '00' && p.second === '00') return date;
  return `${date} ${p.hour}:${p.minute}`;
}

const remapAcc = (id) => (id == null || id === '' ? id : (RENAME[id] || id));

(async () => {
  const id = spreadsheetId();
  const token = await getToken(loadSA());
  const sep = ';'; // ru_RU spreadsheet locale → formula list separator

  // --- read current state ---
  const balRows = await valuesGet(token, id, `${BALANCES}!A1:F`);
  const updatedAt = (balRows[0] && balRows[0][5] != null && balRows[0][5] !== '') ? String(balRows[0][5]) : new Date().toISOString();
  // old accounts: header row 1, data row 2+ until blank A
  const oldAcc = {};
  for (let i = 1; i < balRows.length; i++) {
    const r = balRows[i];
    if (!r || r[0] == null || r[0] === '') continue;
    const newId = remapAcc(String(r[0]));
    oldAcc[newId] = {
      amount: typeof r[2] === 'number' ? r[2] : parseFloat(r[2]) || 0,
      currency: r[3] != null ? String(r[3]) : '',
    };
  }

  // assemble final accounts in canonical order
  const newDefs = Object.fromEntries(NEW_ACCOUNTS.map((a) => [a.id, a]));
  const accounts = ACCOUNT_ORDER.map((aid) => {
    const existing = oldAcc[aid];
    const def = newDefs[aid];
    const currency = existing ? existing.currency : (def ? def.currency : 'RUB');
    const amount = existing ? existing.amount : 0;
    const name = NAME_OVERRIDE[aid] || (def ? def.name : aid);
    return { id: aid, name, amount, currency };
  });

  // currencies for totals, in appearance order
  const currencies = [];
  for (const a of accounts) if (!currencies.includes(a.currency)) currencies.push(a.currency);

  // --- read + reorder events ---
  const evRows = await valuesGet(token, id, `${EVENTS}!A1:I`);
  const events = [];
  for (let i = 1; i < evRows.length; i++) {
    const r = evRows[i];
    if (!r || r[0] == null || r[0] === '') continue;
    // old order: id,type,from,to,amount,amount_to,note,at,client_id
    const [oid, type, from, to, amount, amount_to, note, at, client_id] = r;
    events.push({
      id: oid, type, from: remapAcc(from), to: remapAcc(to),
      amount, amount_to, note, at, client_id,
    });
  }

  // --- preview ---
  console.log(`Spreadsheet: ${id}`);
  console.log(`\nAccounts (${accounts.length}):`);
  for (const a of accounts) console.log(`  ${a.id.padEnd(18)} ${String(a.amount).padStart(10)} ${a.currency.padEnd(5)} ${a.name}`);
  console.log(`\nEvents: ${events.length} rows  (from/to remapped: ${Object.entries(RENAME).map(([k, v]) => `${k}→${v}`).join(', ')})`);
  const remappedCount = events.filter((e) => Object.values(RENAME).includes(e.from) || Object.values(RENAME).includes(e.to)).length;
  console.log(`  rows touching renamed accounts: ${remappedCount}`);
  console.log('  sample (last 3):');
  events.slice(-3).forEach((e) => console.log(`    ${formatWhen(e.at).padEnd(17)} ${String(e.type).padEnd(8)} ${(e.from || '·')}→${(e.to || '·')} ${e.amount}${e.note ? `  «${e.note}»` : ''}`));

  if (process.env.DRY_RUN) { console.log('\n✓ DRY_RUN — nothing written.'); return; }

  // --- build Balances grid ---
  const headerRow = 3;            // accounts header (id/name/amount/currency)
  const dataStart = headerRow + 1;
  const dataEnd = dataStart + accounts.length - 1;
  const totalsHeaderRow = dataEnd + 2; // one blank row between accounts and totals
  const totalsStart = totalsHeaderRow + 1;

  // RAW writes (text/number/ISO — no formula auto-conversion of the F1 ISO)
  const rawData = [
    { range: `${BALANCES}!A1`, values: [['Updated']] },
    { range: `${BALANCES}!F1`, values: [[updatedAt]] },
    { range: `${BALANCES}!A${headerRow}:D${headerRow}`, values: [['id', 'name', 'amount', 'currency']] },
    { range: `${BALANCES}!A${dataStart}:D${dataEnd}`, values: accounts.map((a) => [a.id, a.name, a.amount, a.currency]) },
    { range: `${BALANCES}!A${totalsHeaderRow}`, values: [['Totals']] },
    { range: `${BALANCES}!A${totalsStart}:A${totalsStart + currencies.length - 1}`, values: currencies.map((c) => [c]) },
  ];
  // USER_ENTERED writes (formulas)
  // F1 is raw UTC ISO (…Z); shift +7h for Bangkok display (Thailand = UTC+7, no DST).
  const prettyUpdated = `=IF($F$1=""${sep}"—"${sep}IFERROR(TEXT(DATEVALUE(LEFT($F$1${sep}10))+TIMEVALUE(MID($F$1${sep}12${sep}8))+7/24${sep}"DD.MM.YYYY HH:MM")${sep}$F$1))`;
  const formulaData = [
    { range: `${BALANCES}!B1`, values: [[prettyUpdated]] },
    { range: `${BALANCES}!B${totalsStart}:B${totalsStart + currencies.length - 1}`, values: currencies.map((c) => [`=SUMIF(D:D${sep}"${c}"${sep}C:C)`]) },
  ];

  // --- build Events grid ---
  const eventGrid = [EVENTS_HEADER, ...events.map((e) => [
    formatWhen(e.at), e.type, e.from ?? '', e.to ?? '', e.amount ?? '', e.amount_to ?? '',
    e.note ?? '', e.id ?? '', e.at ?? '', e.client_id ?? '',
  ])];

  // --- write ---
  await valuesClear(token, id, `${BALANCES}!A1:Z`);
  await valuesBatchUpdate(token, id, rawData, 'RAW');
  await valuesBatchUpdate(token, id, formulaData, 'USER_ENTERED');
  console.log(`\n✓ Balances written (${accounts.length} accounts, totals: ${currencies.join('/')})`);

  await valuesClear(token, id, `${EVENTS}!A1:Z`);
  await valuesBatchUpdate(token, id, [{ range: `${EVENTS}!A1`, values: eventGrid }], 'RAW');
  console.log(`✓ Events written (${events.length} rows, reordered)`);
  console.log('\n✓ Migration complete. Run format-sheets.mjs next for styling.');
})().catch((e) => die(e.stack || e.message));
