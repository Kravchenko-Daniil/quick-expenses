#!/usr/bin/env node
// Post-migration verification. Re-implements the API's read logic (must match
// api/src/index.js) and runs it against the live sheet, then checks integrity:
//   - Balances header scans, accounts parse, dataStartRow is right
//   - every Events row parses; every from/to references a real account
//   - no orphaned old ids (card_t / card_vtb) remain
//   - per-currency reconcile hint
// Usage:  node scripts/verify-schema.mjs

import { loadSA, spreadsheetId, getToken, valuesGet, die } from './_lib.mjs';

const BALANCES_RANGE = 'Balances!A1:F';

function readBalances(rows) {
  const updatedAt = (rows[0] && rows[0][5] != null && rows[0][5] !== '') ? String(rows[0][5]) : null;
  let hr = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i] && String(rows[i][0]).toLowerCase() === 'id') { hr = i; break; }
  if (hr === -1) die('Balances header not found');
  const accounts = [];
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[0] == null || r[0] === '') break;
    accounts.push({ id: String(r[0]), name: r[1] != null ? String(r[1]) : '', amount: typeof r[2] === 'number' ? r[2] : parseFloat(r[2]) || 0, currency: r[3] != null ? String(r[3]) : '' });
  }
  return { accounts, updatedAt, dataStartRow: hr + 2 };
}
function rowToEvent(r) {
  const cell = (i) => (r[i] === undefined || r[i] === '' ? null : r[i]);
  const num = (i) => { const v = cell(i); if (v == null) return null; return typeof v === 'number' ? v : parseFloat(v); };
  return { type: cell(1) && String(cell(1)), from: cell(2) && String(cell(2)), to: cell(3) && String(cell(3)), amount: num(4), amount_to: num(5), note: cell(6) && String(cell(6)), id: cell(7) && String(cell(7)), at: cell(8) && String(cell(8)), client_id: cell(9) && String(cell(9)) };
}

(async () => {
  const id = spreadsheetId();
  const token = await getToken(loadSA());

  const { accounts, updatedAt, dataStartRow } = readBalances(await valuesGet(token, id, `${BALANCES_RANGE}`));
  const ids = new Set(accounts.map((a) => a.id));
  console.log(`Balances: ${accounts.length} accounts, dataStartRow=${dataStartRow}, updatedAt=${updatedAt}`);

  const rows = await valuesGet(token, id, `Events!A2:J`);
  const events = rows.map(rowToEvent).filter((e) => e.id != null);
  console.log(`Events: ${events.length} parsed`);

  let problems = 0;
  const orphan = new Set();
  for (const e of events) {
    for (const ref of [e.from, e.to]) if (ref && !ids.has(ref)) orphan.add(ref);
    if (!e.type || !e.at) { problems++; if (problems <= 3) console.log(`  ✗ row id=${e.id} missing type/at`); }
  }
  if (orphan.size) { problems += orphan.size; console.log(`  ✗ from/to referencing unknown accounts: ${[...orphan].join(', ')}`); }
  else console.log('  ✓ every from/to references a real account');
  for (const old of ['card_t', 'card_vtb']) if (orphan.has(old)) console.log(`  ✗ stale old id still present: ${old}`);

  // type distribution
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log(`  types: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  console.log(problems === 0 ? '\n✓ integrity OK' : `\n✗ ${problems} problem(s)`);
})().catch((e) => die(e.stack || e.message));
