#!/usr/bin/env node
// Cosmetic formatting for the finance spreadsheet (tabs: Events + Balances).
//
// Presentation only — it never writes cell VALUES (those are owned by the Worker
// and the migration). It sets fonts, colors, borders, alignment, number formats,
// frozen/hidden columns and conditional formatting, locating data by scanning.
//
// Layout it styles (set by migrate-schema-v2.mjs):
//   Events   A:When B:Type C:From D:To E:Amount F:Received G:Note  | H:id I:at J:client_id (hidden)
//   Balances A1:"Updated" B1:date | accounts header (id/name/amount/currency) below,
//            then a Totals block. F1 = raw updated_at ISO (hidden).
//
// Re-runnable: repeatCell/border/hide/freeze overwrite; conditional rules are
// deleted first each run.  Usage:  node scripts/format-sheets.mjs

import {
  loadSA, spreadsheetId, getToken, valuesGet, getMeta, batchUpdate, die,
} from './_lib.mjs';

const EVENTS = 'Events';
const BALANCES = 'Balances';
const SETTINGS = 'Settings';

// --- style constants ---
const HEADER_BG = { red: 0.20, green: 0.29, blue: 0.37 };
const WHITE = { red: 1, green: 1, blue: 1 };
const GREEN = { red: 0.11, green: 0.50, blue: 0.18 };
const RED = { red: 0.78, green: 0.16, blue: 0.16 };
const INFO_BG = { red: 0.93, green: 0.95, blue: 0.97 };
const GRID = { red: 0.75, green: 0.75, blue: 0.75 };
const TIFFANY = { red: 0.039, green: 0.729, blue: 0.710 };       // #0abab5 — app accent, marks the primary account
const TIFFANY_BG = { red: 0.82, green: 0.95, blue: 0.94 };       // light tint behind the SETTINGS value cells
const NUMFMT = { type: 'NUMBER', pattern: '#,##0.00' }; // ru_RU: optional-decimal patterns dangle a separator
// Per-currency number format: amount stays a number (Worker reads it unchanged),
// the symbol is a display suffix. ₮ = Tether (USDT). Edit symbols here.
const CURSYM = { RUB: '₽', THB: '฿', USDT: '₮', VND: '₫' };
// Currencies with no minor unit — display without decimals (e.g. Vietnamese dong).
const NODEC = new Set(['VND']);
const numFmtCur = (c) => {
  if (!CURSYM[c]) return NUMFMT;
  const digits = NODEC.has(c) ? '#,##0' : '#,##0.00';
  return { type: 'NUMBER', pattern: `${digits}" ${CURSYM[c]}"` };
};
const border = { style: 'SOLID', width: 1, color: GRID };

const HEADER_FIELDS = 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)';
const headerCell = {
  userEnteredFormat: {
    backgroundColor: HEADER_BG, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
    textFormat: { bold: true, foregroundColor: WHITE },
  },
};

const R = (sheetId, r0, r1, c0, c1) => {
  const range = { sheetId, startColumnIndex: c0, endColumnIndex: c1 };
  if (r0 != null) range.startRowIndex = r0;
  if (r1 != null) range.endRowIndex = r1;
  return range;
};
function header(sheetId, row, c0, c1) {
  return { repeatCell: { range: R(sheetId, row, row + 1, c0, c1), cell: headerCell, fields: HEADER_FIELDS } };
}
function align(sheetId, r0, c, h, numfmt) {
  const uef = { horizontalAlignment: h, verticalAlignment: 'MIDDLE' };
  let fields = 'userEnteredFormat(horizontalAlignment,verticalAlignment';
  if (numfmt) { uef.numberFormat = numfmt; fields += ',numberFormat'; }
  fields += ')';
  return { repeatCell: { range: R(sheetId, r0, null, c, c + 1), cell: { userEnteredFormat: uef }, fields } };
}
function borders(sheetId, r0, r1, c0, c1) {
  return { updateBorders: { range: R(sheetId, r0, r1, c0, c1), top: border, bottom: border, left: border, right: border, innerHorizontal: border, innerVertical: border } };
}
function freeze(sheetId, n) {
  return { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: n } }, fields: 'gridProperties.frozenRowCount' } };
}
function hidden(sheetId, start, end, value) {
  return { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: end }, properties: { hiddenByUser: value }, fields: 'hiddenByUser' } };
}
function width(sheetId, start, px) {
  return { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: start + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } };
}
function rowHeight(sheetId, idx, px) {
  return { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } };
}
function boldCell(sheetId, r, c) {
  return { repeatCell: { range: R(sheetId, r, r + 1, c, c + 1), cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat' } };
}

(async () => {
  const id = spreadsheetId();
  const token = await getToken(loadSA());
  const meta = await getMeta(token, id, 'sheets(properties(sheetId,title),conditionalFormats)');
  const byTitle = Object.fromEntries(meta.sheets.map((s) => [s.properties.title, s]));
  const ev = byTitle[EVENTS] || die('Events sheet not found');
  const bal = byTitle[BALANCES] || die('Balances sheet not found');
  const settings = byTitle[SETTINGS] || null; // optional dedicated settings tab
  const evId = ev.properties.sheetId;
  const balId = bal.properties.sheetId;
  const setId = settings ? settings.properties.sheetId : null;

  // Events: read When/Type/From/To for data rows (When column A non-empty).
  const evData = await valuesGet(token, id, `${EVENTS}!A2:D`);
  const evRows = evData.filter((r) => r[0] != null && r[0] !== '');
  const lastEv = 1 + evRows.length; // 1-based

  // Balances: scan for accounts header + count + currencies + id→currency map.
  const balRows = await valuesGet(token, id, `${BALANCES}!A1:F`);
  let hr = -1;
  for (let i = 0; i < balRows.length; i++) if (balRows[i] && String(balRows[i][0]).toLowerCase() === 'id') { hr = i; break; }
  if (hr === -1) die('Balances: accounts header not found');
  const currencies = [];
  const curMap = {};
  const accCurs = [];           // per-account currency, in row order
  let acc = 0;
  for (let i = hr + 1; i < balRows.length; i++) {
    const r = balRows[i];
    if (!r || r[0] == null || r[0] === '') break;
    acc++;
    const c = r[3] != null ? String(r[3]) : '';
    accCurs.push(c);
    curMap[String(r[0])] = c;
    if (c !== '' && !currencies.includes(c)) currencies.push(c);
  }
  const headerRow = hr;                 // 0-based row of "id" header
  const dataStart = hr + 1;             // 0-based first account row
  const dataEnd = dataStart + acc;      // 0-based exclusive
  const totalsHeader = dataEnd + 1;     // 0-based "Totals" row
  const totalsStart = totalsHeader + 1; // 0-based first currency row
  const totalsEnd = totalsStart + currencies.length; // exclusive
  console.log(`Events: ${lastEv - 1} rows   Balances: ${acc} accounts, header row ${headerRow + 1}, totals row ${totalsHeader + 1}`);

  const reqs = [];

  // delete existing conditional rules (idempotency)
  for (const s of [ev, bal, settings].filter(Boolean)) {
    const n = (s.conditionalFormats || []).length;
    for (let i = 0; i < n; i++) reqs.push({ deleteConditionalFormatRule: { sheetId: s.properties.sheetId, index: 0 } });
  }

  // Full format reset on both sheets BEFORE repainting — clears stale cell
  // formatting (dark header leftovers next to "Updated", orphan borders in far
  // columns) that earlier schema/format runs left behind. Repaints below override.
  // Dimension props (hidden/frozen/widths) are not userEnteredFormat, so untouched.
  reqs.push({ repeatCell: { range: { sheetId: evId }, cell: {}, fields: 'userEnteredFormat' } });
  reqs.push({ repeatCell: { range: { sheetId: balId }, cell: {}, fields: 'userEnteredFormat' } });
  if (setId != null) reqs.push({ repeatCell: { range: { sheetId: setId }, cell: {}, fields: 'userEnteredFormat' } });

  // ---- Events ----
  reqs.push(freeze(evId, 1));
  reqs.push(rowHeight(evId, 0, 30));
  reqs.push(header(evId, 0, 0, 7));                       // A1:G1 visible header
  reqs.push(align(evId, 1, 0, 'CENTER'));                 // When
  reqs.push(align(evId, 1, 1, 'CENTER'));                 // Type
  reqs.push(align(evId, 1, 2, 'CENTER'));                 // From
  reqs.push(align(evId, 1, 3, 'CENTER'));                 // To
  reqs.push(align(evId, 1, 4, 'RIGHT'));                  // Amount (numFmt set per-row below)
  reqs.push(align(evId, 1, 5, 'RIGHT'));                  // Received (numFmt set per-row below)
  reqs.push(align(evId, 1, 6, 'LEFT'));                   // Note
  // Per-row currency suffix. Amount (E) currency = to-account for income, else
  // from-account; Received (F) is only set on exchange rows = to-account currency.
  const eCurOf = (type, from, to) => (type === 'income' ? curMap[to] : curMap[from]);
  const eCurs = evRows.map((r) => eCurOf(String(r[1]), r[2], r[3]));
  for (let s = 0; s < eCurs.length;) {            // run-length: one repeatCell per same-currency block
    let e = s + 1; while (e < eCurs.length && eCurs[e] === eCurs[s]) e++;
    reqs.push({ repeatCell: { range: R(evId, 1 + s, 1 + e, 4, 5), cell: { userEnteredFormat: { numberFormat: numFmtCur(eCurs[s]) } }, fields: 'userEnteredFormat.numberFormat' } });
    s = e;
  }
  evRows.forEach((r, i) => {
    if (String(r[1]) === 'exchange') reqs.push({ repeatCell: { range: R(evId, 1 + i, 2 + i, 5, 6), cell: { userEnteredFormat: { numberFormat: numFmtCur(curMap[r[3]]) } }, fields: 'userEnteredFormat.numberFormat' } });
  });
  reqs.push(borders(evId, 0, lastEv, 0, 7));              // A1:G{last}
  reqs.push(hidden(evId, 0, 7, false));                   // A..G visible
  reqs.push(hidden(evId, 7, 10, true));                   // id, at, client_id hidden
  const evW = { 0: 130, 1: 80, 2: 120, 3: 120, 4: 95, 5: 95, 6: 240 };
  for (const [c, px] of Object.entries(evW)) reqs.push(width(evId, Number(c), px));
  // amount colored by type (Type=B, Amount=E, Received=F) — open-ended rows
  const cond = (formula, color) => ({
    addConditionalFormatRule: {
      rule: { ranges: [R(evId, 1, null, 4, 6)], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format: { textFormat: { foregroundColor: color, bold: true } } } },
      index: 0,
    },
  });
  reqs.push(cond('=$B2="income"', GREEN));
  reqs.push(cond('=$B2="expense"', RED));

  // ---- Balances ----
  // Column A holds the account `id` (Worker's scan key) but is hidden — only
  // Name/Amount/Currency are shown. The "Updated" and "Totals" side-labels were
  // moved one column right (into B/C) so they stay visible.
  reqs.push(freeze(balId, 0));
  reqs.push(boldCell(balId, 0, 1));                       // B1 "Updated"
  reqs.push(align(balId, 0, 2, 'LEFT'));                  // C1 date (single row via align from row 0)
  reqs.push(header(balId, headerRow, 0, 4));              // accounts header (A hidden, B:D shown)
  // account rows alignment
  reqs.push({ repeatCell: { range: R(balId, dataStart, dataEnd, 0, 1), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment)' } });
  reqs.push({ repeatCell: { range: R(balId, dataStart, dataEnd, 1, 2), cell: { userEnteredFormat: { horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment)' } });
  accCurs.forEach((c, i) => reqs.push({ repeatCell: { range: R(balId, dataStart + i, dataStart + i + 1, 2, 3), cell: { userEnteredFormat: { horizontalAlignment: 'RIGHT', verticalAlignment: 'MIDDLE', numberFormat: numFmtCur(c) } }, fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,numberFormat)' } }));
  reqs.push({ repeatCell: { range: R(balId, dataStart, dataEnd, 3, 4), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment)' } });
  // totals block — styled like the accounts table: a dark "TOTALS" header bar
  // (merged across B:C, centered) over bordered currency rows.
  reqs.push({ unmergeCells: { range: R(balId, totalsHeader, totalsHeader + 1, 1, 3) } });
  reqs.push({ mergeCells: { range: R(balId, totalsHeader, totalsHeader + 1, 1, 3), mergeType: 'MERGE_ALL' } });
  reqs.push(header(balId, totalsHeader, 1, 3));          // dark bar across B:C, centered
  reqs.push({ repeatCell: { range: R(balId, totalsStart, totalsEnd, 1, 2), cell: { userEnteredFormat: { horizontalAlignment: 'LEFT', textFormat: { bold: true } } }, fields: 'userEnteredFormat(horizontalAlignment,textFormat)' } });
  currencies.forEach((c, i) => reqs.push({ repeatCell: { range: R(balId, totalsStart + i, totalsStart + i + 1, 2, 3), cell: { userEnteredFormat: { horizontalAlignment: 'RIGHT', numberFormat: numFmtCur(c) } }, fields: 'userEnteredFormat(horizontalAlignment,numberFormat)' } }));
  // light bg on the Updated label + date (B1:C1)
  reqs.push({ repeatCell: { range: R(balId, 0, 1, 1, 3), cell: { userEnteredFormat: { backgroundColor: INFO_BG } }, fields: 'userEnteredFormat.backgroundColor' } });
  // borders
  reqs.push(borders(balId, headerRow, dataEnd, 0, 4));   // accounts table
  reqs.push(borders(balId, 0, 1, 1, 3));                 // Updated box (B1:C1)
  reqs.push(borders(balId, totalsHeader, totalsEnd, 1, 3)); // totals box (B:C)
  // hide the id column (A) and raw machinery (E spacer, F raw ISO); show B..D
  reqs.push(hidden(balId, 0, 1, true));
  reqs.push(hidden(balId, 1, 4, false));
  reqs.push(hidden(balId, 4, 6, true));
  const balW = { 0: 60, 1: 175, 2: 110, 3: 90 };
  for (const [c, px] of Object.entries(balW)) reqs.push(width(balId, Number(c), px));

  // Primary-account highlight: the everyday account (chosen on the Settings sheet) is
  // marked Tiffany on the accounts table. Conditional formulas can't reference another
  // sheet directly, so Balances!E1 mirrors Settings!C3 (hidden) and the rule compares
  // each row's id (col A) against $E$1 — it auto-follows whatever Settings holds.
  reqs.push({
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [R(balId, dataStart, dataEnd, 1, 4)], // B:D over account rows
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=$A${dataStart + 1}=$E$1` }] },
          format: { backgroundColor: TIFFANY, textFormat: { bold: true } },
        },
      },
    },
  });

  // ---- Settings sheet (dedicated tab) ----
  // Layout: A = hidden machine key (primary_account / primary_currency), B = human
  // label, C = value (account via dropdown, currency via VLOOKUP). Styled prominent.
  if (setId != null) {
    const SET_TITLE = { red: 0.04, green: 0.45, blue: 0.44 }; // deep Tiffany for the title bar
    // title bar B1:C1
    reqs.push({ unmergeCells: { range: R(setId, 0, 1, 1, 3) } });
    reqs.push({ mergeCells: { range: R(setId, 0, 1, 1, 3), mergeType: 'MERGE_ALL' } });
    reqs.push({ repeatCell: { range: R(setId, 0, 1, 1, 3), cell: { userEnteredFormat: { backgroundColor: SET_TITLE, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, fontSize: 12, foregroundColor: WHITE } } }, fields: HEADER_FIELDS } });
    reqs.push(rowHeight(setId, 0, 34));
    // label cells (B3:B4) bold-left; value cells (C3:C4) Tiffany tint, bold, centered
    reqs.push({ repeatCell: { range: R(setId, 2, 4, 1, 2), cell: { userEnteredFormat: { horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE', textFormat: { bold: true } } }, fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat)' } });
    reqs.push({ repeatCell: { range: R(setId, 2, 4, 2, 3), cell: { userEnteredFormat: { backgroundColor: TIFFANY_BG, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)' } });
    reqs.push(borders(setId, 2, 4, 1, 3)); // box around the two key/value rows
    // help note (B6) — muted italic
    reqs.push({ repeatCell: { range: R(setId, 5, 6, 1, 3), cell: { userEnteredFormat: { wrapStrategy: 'WRAP', textFormat: { italic: true, foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } } } }, fields: 'userEnteredFormat(wrapStrategy,textFormat)' } });
    // dropdown of account ids on the "Primary account" value cell (Settings!C3),
    // sourced from the hidden id column on Balances (cross-sheet ONE_OF_RANGE).
    reqs.push({
      setDataValidation: {
        range: R(setId, 2, 3, 2, 3),
        rule: {
          condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: `=${BALANCES}!$A$${dataStart + 1}:$A$${dataEnd}` }] },
          showCustomUi: true, strict: true,
        },
      },
    });
    // dropdown of currencies on the "Primary currency" value cell (Settings!C4).
    reqs.push({
      setDataValidation: {
        range: R(setId, 3, 4, 2, 3),
        rule: {
          condition: { type: 'ONE_OF_LIST', values: Object.keys(CURSYM).map((c) => ({ userEnteredValue: c })) },
          showCustomUi: true, strict: true,
        },
      },
    });
    // hide the machine-key column A; widen B/C for readability
    reqs.push(hidden(setId, 0, 1, true));
    reqs.push(width(setId, 1, 150));
    reqs.push(width(setId, 2, 130));
    console.log('  Settings sheet styled; dropdown + highlight (via Balances!E1) wired');
  } else {
    console.log('  (no Settings sheet — primary highlight uses Balances!E1 mirror only)');
  }

  await batchUpdate(token, id, reqs);
  console.log(`✓ formatting applied (${reqs.length} requests)`);
})().catch((e) => die(e.stack || e.message));
