// Unit smoke-tests for the API's pure logic (no fetch / no Sheets calls).
// These are inline copies of the pure functions in src/index.js — keep them in
// sync when the source changes. Run: node test-smoke.mjs

const WEEKDAYS_RU = ['вс','пн','вт','ср','чт','пт','сб'];
const MONTHS_EN = ['january','february','march','april','may','june','july','august','september','october','november','december'];

const pad = (n) => String(n).padStart(2, '0');

const CURRENCY_TOKEN_RE = /(?<![\p{L}\p{N}_])(usdt|rub|руб|thb|бат|baht|vnd|донг)(?![\p{L}\p{N}_])/giu;
const TOKEN_CURRENCY = {
  usdt: 'USDT',
  rub: 'RUB', руб: 'RUB',
  thb: 'THB', бат: 'THB', baht: 'THB',
  vnd: 'VND', донг: 'VND',
};

function parseExpense(input) {
  let text = input.replace(/[\r\n]+/g, ' ').trim();
  if (!text) throw new Error('empty input');

  let currency = null;
  const tokens = [...text.matchAll(CURRENCY_TOKEN_RE)];
  if (tokens.length === 1) {
    const tok = tokens[0][1].toLowerCase();
    currency = TOKEN_CURRENCY[tok] || null;
    text = text.replace(CURRENCY_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
  }

  const matches = [...text.matchAll(/\d+/g)];
  if (matches.length === 0) throw new Error('no amount found');
  const last = matches[matches.length - 1];
  const amount = parseInt(last[0], 10);
  if (!amount || amount < 1) throw new Error('invalid amount');
  const before = text.slice(0, last.index);
  const after = text.slice(last.index + last[0].length);
  let description = (before + ' ' + after).replace(/\s+/g, ' ').trim();
  description = description.replace(/[\s,;:.]+$/, '').replace(/^[\s,;:.]+/, '');
  if (!description) description = '—';
  return { description, amount, currency };
}

function zoneContext(nowISO, tz) {
  const now = nowISO ? new Date(nowISO) : new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return contextFromYMD(parseInt(parts.year, 10), parseInt(parts.month, 10), parseInt(parts.day, 10));
}

function contextFromYMD(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  const weekdayRu = WEEKDAYS_RU[dt.getUTCDay()];
  return {
    year, month, day, weekdayRu, monthEn: MONTHS_EN[month-1],
    sectionHeader: `## ${pad(day)}.${pad(month)}.${year}, ${weekdayRu}`,
  };
}

function dateInZone(iso, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// === Sheets row <-> event mapping (pure) ===

const EVENT_COLS = ['when', 'type', 'from', 'to', 'amount', 'amount_to', 'note', 'id', 'at', 'client_id'];

// Display string for the Events `when` column (in `tz`). Noon-exact = backdate
// placeholder → date only; any other time → `DD.MM.YYYY HH:MM`. Derived from `at`.
function formatWhen(iso, tz) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  const date = `${p.day}.${p.month}.${p.year}`;
  if (p.hour === '12' && p.minute === '00' && p.second === '00') return date;
  return `${date} ${p.hour}:${p.minute}`;
}

function rowToEvent(r) {
  const cell = (i) => (r[i] === undefined || r[i] === '' ? null : r[i]);
  const num = (i) => { const v = cell(i); if (v == null) return null; return typeof v === 'number' ? v : parseFloat(v); };
  // Column 0 is the display-only `when` string (derived from `at`) — ignored here.
  return {
    type: cell(1) != null ? String(cell(1)) : null,
    from: cell(2) != null ? String(cell(2)) : null,
    to: cell(3) != null ? String(cell(3)) : null,
    amount: num(4),
    amount_to: num(5),
    note: cell(6) != null ? String(cell(6)) : null,
    id: cell(7) != null ? String(cell(7)) : null,
    at: cell(8) != null ? String(cell(8)) : null,
    client_id: cell(9) != null ? String(cell(9)) : null,
  };
}

function eventToRow(ev, tz) {
  return EVENT_COLS.map((c) => {
    if (c === 'when') return formatWhen(ev.at, tz);
    const v = ev[c];
    return v == null ? '' : v;
  });
}

// === EVENTS pure logic ===

function validateEvent(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: 'invalid body' };
  const types = ['income', 'transfer', 'exchange', 'expense'];
  if (!types.includes(body.type)) return { ok: false, message: 'type must be income/transfer/exchange/expense' };
  if (typeof body.amount !== 'number' || !isFinite(body.amount) || body.amount <= 0) return { ok: false, message: 'amount must be positive number' };
  if (body.type === 'expense') {
    if (typeof body.from !== 'string' || !body.from) return { ok: false, message: 'from required for expense' };
  } else {
    if (typeof body.to !== 'string' || !body.to) return { ok: false, message: 'to required' };
  }
  if (body.type === 'transfer' || body.type === 'exchange') {
    if (typeof body.from !== 'string' || !body.from) return { ok: false, message: 'from required for transfer/exchange' };
    if (body.from === body.to) return { ok: false, message: 'from and to must differ' };
  }
  if (body.type === 'exchange') {
    if (typeof body.amount_to !== 'number' || !isFinite(body.amount_to) || body.amount_to <= 0) return { ok: false, message: 'amount_to must be positive number' };
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return { ok: false, message: 'note must be string' };
  if (body.at !== undefined && body.at !== null) {
    if (typeof body.at !== 'string') return { ok: false, message: 'at must be ISO string' };
    const d = new Date(body.at);
    if (isNaN(d.getTime())) return { ok: false, message: 'at is not valid date' };
    if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return { ok: false, message: 'at cannot be in the future' };
  }
  if (body.client_id !== undefined && body.client_id !== null) {
    if (typeof body.client_id !== 'string' || body.client_id.length > 64) return { ok: false, message: 'client_id must be string ≤64 chars' };
  }
  return { ok: true };
}

function findAccount(accounts, id) { const a = accounts.find(x => x.id === id); if (!a) throw new Error(`unknown: ${id}`); return a; }
function roundCents(accounts) { for (const a of accounts) a.amount = Math.round(a.amount * 100) / 100; return accounts; }
function applyMutation(accounts, ev) {
  if (ev.type === 'income') findAccount(accounts, ev.to).amount += ev.amount;
  else if (ev.type === 'expense') findAccount(accounts, ev.from).amount -= ev.amount;
  else if (ev.type === 'transfer') {
    const f = findAccount(accounts, ev.from), t = findAccount(accounts, ev.to);
    if (f.currency !== t.currency) throw new Error('transfer requires same currency');
    f.amount -= ev.amount; t.amount += ev.amount;
  } else if (ev.type === 'exchange') {
    findAccount(accounts, ev.from).amount -= ev.amount;
    findAccount(accounts, ev.to).amount += ev.amount_to;
  }
  return roundCents(accounts);
}
function reverseMutation(accounts, ev) {
  if (ev.type === 'income') findAccount(accounts, ev.to).amount -= ev.amount;
  else if (ev.type === 'expense') findAccount(accounts, ev.from).amount += ev.amount;
  else if (ev.type === 'transfer') { findAccount(accounts, ev.from).amount += ev.amount; findAccount(accounts, ev.to).amount -= ev.amount; }
  else if (ev.type === 'exchange') { findAccount(accounts, ev.from).amount += ev.amount; findAccount(accounts, ev.to).amount -= ev.amount_to; }
  return roundCents(accounts);
}

function applySnapshot(accounts, snapshots) {
  const next = accounts.map((a) => ({ ...a }));
  const byId = {};
  for (const a of next) byId[a.id] = a;
  for (const s of snapshots) {
    if (!byId[s.account]) throw new Error(`unknown account: ${s.account}`);
    byId[s.account].amount = s.amount;
  }
  return roundCents(next);
}

const sampleAccounts = () => ([
  { id: 'cash', name: 'Налом', amount: 5000, currency: 'THB' },
  { id: 'bybit', name: 'Bybit', amount: 1000, currency: 'USDT' },
  { id: 'maxswap', name: 'maxswap', amount: 50, currency: 'USDT' },
  { id: 'card_t', name: 'Карта Т', amount: 5000, currency: 'RUB' },
]);
const acc = (accounts, id) => accounts.find(a => a.id === id).amount;

// === TESTS ===

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

console.log('\n=== parseExpense ===');
eq(parseExpense('кофе 350'), { description: 'кофе', amount: 350, currency: null }, '"кофе 350" (no token → currency=null → routes to PRIMARY_ACCOUNT)');
eq(parseExpense('350 кофе'), { description: 'кофе', amount: 350, currency: null }, '"350 кофе" (sum first, but desc captured)');
eq(parseExpense('кофе 1300'), { description: 'кофе', amount: 1300, currency: null }, '"кофе 1300" (no space — write big numbers without space)');
eq(parseExpense('Ресторан Мишлен на 2 530'), { description: 'Ресторан Мишлен на 2', amount: 530, currency: null }, '"Ресторан Мишлен на 2 530" (last number wins → 530)');
eq(parseExpense('массаж 1300'), { description: 'массаж', amount: 1300, currency: null }, '"массаж 1300" (no space)');
eq(parseExpense('  кофе   350  '), { description: 'кофе', amount: 350, currency: null }, 'trim+collapse spaces');
eq(parseExpense('фитнес-зал на месяц 1800'), { description: 'фитнес-зал на месяц', amount: 1800, currency: null }, 'multi-word desc');
try { parseExpense(''); console.log('  ✗ empty should throw'); fail++; } catch { console.log('  ✓ empty throws'); pass++; }
try { parseExpense('кофе'); console.log('  ✗ no number should throw'); fail++; } catch { console.log('  ✓ "кофе" (no amount) throws'); pass++; }

// Currency hint
eq(parseExpense('перевод другу 26 usdt'), { description: 'перевод другу', amount: 26, currency: 'USDT' }, '"... 26 usdt" → USDT');
eq(parseExpense('подписка 500 руб'), { description: 'подписка', amount: 500, currency: 'RUB' }, '"... 500 руб" → RUB');
eq(parseExpense('steam 15 rub'), { description: 'steam', amount: 15, currency: 'RUB' }, '"... 15 rub" → RUB (latin)');
eq(parseExpense('usdt 26'), { description: '—', amount: 26, currency: 'USDT' }, '"usdt 26" (token first, no desc → "—")');
eq(parseExpense('платил usdt за хостинг 12'), { description: 'платил за хостинг', amount: 12, currency: 'USDT' }, 'token in the middle');
eq(parseExpense('тест USDT 10'), { description: 'тест', amount: 10, currency: 'USDT' }, 'USDT uppercase');
eq(parseExpense('тест Руб 100'), { description: 'тест', amount: 100, currency: 'RUB' }, '"Руб" capitalized');
eq(parseExpense('рубероид на крышу 1500'), { description: 'рубероид на крышу', amount: 1500, currency: null }, '"рубероид" не матчит руб');
eq(parseExpense('купил рубашку 800'), { description: 'купил рубашку', amount: 800, currency: null }, '"рубашку" не матчит руб');
eq(parseExpense('обмен usdt в rub 100'), { description: 'обмен usdt в rub', amount: 100, currency: null }, 'два токена → ambiguous, currency=null');
eq(parseExpense('фо бо 50 бат'), { description: 'фо бо', amount: 50, currency: 'THB' }, '"... 50 бат" → THB');
eq(parseExpense('massage 200 baht'), { description: 'massage', amount: 200, currency: 'THB' }, '"... 200 baht" → THB (latin)');
eq(parseExpense('такси 80000 донг'), { description: 'такси', amount: 80000, currency: 'VND' }, '"... 80000 донг" → VND');
eq(parseExpense('обед 120000 vnd'), { description: 'обед', amount: 120000, currency: 'VND' }, '"... 120000 vnd" → VND (latin)');
eq(parseExpense('купил батут 3000'), { description: 'купил батут', amount: 3000, currency: null }, '"батут" не матчит бат');

console.log('\n=== zoneContext / dateInZone (parameterized timezone) ===');
const TZ = 'Asia/Bangkok';
const ctx29 = zoneContext('2026-04-29T08:00:00Z', TZ); // 15:00 in Bangkok same day
eq(ctx29.sectionHeader, '## 29.04.2026, ср', 'section header 29.04.2026 = ср');
eq(ctx29.monthEn, 'april', 'monthEn april');
const ctxLateNight = zoneContext('2026-04-30T17:30:00Z', TZ); // 00:30 May 1 in Bangkok
eq(ctxLateNight.day, 1, 'late UTC night flips to next day in Bangkok');
eq(ctxLateNight.monthEn, 'may', 'late UTC night flips to may');
eq(dateInZone('2026-05-08T09:52:50.378Z', TZ), '2026-05-08', 'UTC morning → same Bangkok day');
eq(dateInZone('2026-04-30T17:30:00Z', TZ), '2026-05-01', 'UTC night → next Bangkok day');
eq(dateInZone('2026-05-08T12:00:00+07:00', TZ), '2026-05-08', 'noon Bangkok offset → same day');
// Same instant, a different zone buckets to a different day — the whole point of
// making the zone a parameter. 23:30 UTC = 06:30 next day in Bangkok, still 23:30 in Moscow.
eq(dateInZone('2026-05-08T23:30:00Z', 'Asia/Bangkok'), '2026-05-09', 'late UTC → next day in Bangkok (+07)');
eq(dateInZone('2026-05-08T23:30:00Z', 'Europe/Moscow'), '2026-05-09', 'same instant in Moscow (+03) → 02:30, next day');
eq(dateInZone('2026-05-08T20:30:00Z', 'Europe/Moscow'), '2026-05-08', '20:30 UTC = 23:30 Moscow → same day');
eq(dateInZone('2026-05-08T20:30:00Z', 'Asia/Bangkok'), '2026-05-09', '20:30 UTC = 03:30 Bangkok next day');
// dateParam path: weekday of a literal calendar date is zone-free.
eq(contextFromYMD(2026, 5, 8).sectionHeader, '## 08.05.2026, пт', 'contextFromYMD weekday is zone-free');

console.log('\n=== formatWhen ===');
eq(formatWhen('2026-05-08T12:00:00+07:00', TZ), '08.05.2026', 'noon placeholder → date only');
eq(formatWhen('2026-05-08T09:52:50.378Z', TZ), '08.05.2026 16:52', 'real time → date + HH:MM (Bangkok)');
eq(formatWhen('2026-05-08T09:52:50.378Z', 'Europe/Moscow'), '08.05.2026 12:52', 'same instant in Moscow → 12:52');
eq(formatWhen('', TZ), '', 'empty → empty');

console.log('\n=== rowToEvent / eventToRow (round-trip) ===');
// Keys are in rowToEvent's output order so JSON round-trip compares equal.
const ev1 = { type: 'expense', from: 'cash', to: null, amount: 350, amount_to: null, note: 'кофе', id: 'ev_abc', at: '2026-05-08T12:00:00+07:00', client_id: null };
eq(eventToRow(ev1, TZ), ['08.05.2026', 'expense', 'cash', '', 350, '', 'кофе', 'ev_abc', '2026-05-08T12:00:00+07:00', ''], 'event → row (when derived, nulls become "")');
eq(rowToEvent(eventToRow(ev1, TZ)), ev1, 'row → event round-trips');
const ev2 = { type: 'exchange', from: 'bybit', to: 'cash', amount: 300, amount_to: 9400, note: null, id: 'ev_x', at: '2026-05-08T09:52:50.378Z', client_id: 'c_123' };
eq(rowToEvent(eventToRow(ev2, TZ)), ev2, 'exchange with client_id round-trips');
// Sheets may return numeric cells as numbers and omit trailing empties — emulate that
eq(rowToEvent(['16.04.2026', 'income', '', 'bybit', 2499, '', 'ЗП', 'ev_y', '2026-05-06T12:00:00+07:00']),
   { type: 'income', from: null, to: 'bybit', amount: 2499, amount_to: null, note: 'ЗП', id: 'ev_y', at: '2026-05-06T12:00:00+07:00', client_id: null },
   'short row (trailing empties omitted) parses with nulls');

console.log('\n=== validateEvent ===');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100 }).ok, true, 'income OK');
eq(validateEvent({ type: 'transfer', from: 'bybit', to: 'maxswap', amount: 50 }).ok, true, 'transfer OK');
eq(validateEvent({ type: 'exchange', from: 'bybit', to: 'cash', amount: 100, amount_to: 3500 }).ok, true, 'exchange OK');
eq(validateEvent({ type: 'wat', to: 'bybit', amount: 100 }).ok, false, 'unknown type rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 0 }).ok, false, 'zero amount rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: -10 }).ok, false, 'negative amount rejected');
eq(validateEvent({ type: 'transfer', to: 'bybit', amount: 10 }).ok, false, 'transfer w/o from rejected');
eq(validateEvent({ type: 'transfer', from: 'a', to: 'a', amount: 10 }).ok, false, 'same from/to rejected');
eq(validateEvent({ type: 'exchange', from: 'a', to: 'b', amount: 100 }).ok, false, 'exchange w/o amount_to rejected');
eq(validateEvent({ type: 'expense', from: 'bybit', amount: 600 }).ok, true, 'expense OK');
eq(validateEvent({ type: 'expense', amount: 600 }).ok, false, 'expense w/o from rejected');
eq(validateEvent({ type: 'expense', from: 'bybit', amount: 0 }).ok, false, 'expense zero amount rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, at: '2026-05-06T10:00:00+07:00' }).ok, true, 'backdate OK');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, at: 'not-a-date' }).ok, false, 'invalid at rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, at: '2099-01-01T00:00:00Z' }).ok, false, 'far future at rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, client_id: 'abc' }).ok, true, 'client_id OK');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, client_id: 'x'.repeat(65) }).ok, false, 'client_id >64 rejected');

console.log('\n=== applyMutation / reverseMutation ===');
let a = sampleAccounts();
applyMutation(a, { type: 'income', to: 'bybit', amount: 2499 });
eq(acc(a, 'bybit'), 3499, 'income +2499 → bybit');

a = sampleAccounts();
applyMutation(a, { type: 'transfer', from: 'bybit', to: 'maxswap', amount: 600 });
eq(acc(a, 'bybit'), 400, 'transfer bybit -600');
eq(acc(a, 'maxswap'), 650, 'transfer maxswap +600');

a = sampleAccounts();
applyMutation(a, { type: 'exchange', from: 'bybit', to: 'cash', amount: 200, amount_to: 6200 });
eq(acc(a, 'bybit'), 800, 'exchange bybit -200');
eq(acc(a, 'cash'), 11200, 'exchange cash +6200');

a = sampleAccounts();
applyMutation(a, { type: 'expense', from: 'bybit', amount: 600 });
eq(acc(a, 'bybit'), 400, 'expense bybit -600');

a = sampleAccounts();
const evE = { type: 'expense', from: 'bybit', amount: 600 };
applyMutation(a, evE); reverseMutation(a, evE);
eq(acc(a, 'bybit'), 1000, 'reverse expense returns to original');

a = sampleAccounts();
const ev = { type: 'income', to: 'bybit', amount: 2499 };
applyMutation(a, ev); reverseMutation(a, ev);
eq(acc(a, 'bybit'), 1000, 'reverse income returns to original');

a = sampleAccounts();
const ev2x = { type: 'exchange', from: 'bybit', to: 'cash', amount: 200, amount_to: 6200 };
applyMutation(a, ev2x); reverseMutation(a, ev2x);
eq(acc(a, 'bybit'), 1000, 'reverse exchange bybit');
eq(acc(a, 'cash'), 5000, 'reverse exchange cash');

a = sampleAccounts();
try { applyMutation(a, { type: 'transfer', from: 'bybit', to: 'cash', amount: 100 }); console.log('  ✗ transfer different currency should throw'); fail++; }
catch { console.log('  ✓ transfer different currency throws'); pass++; }

a = sampleAccounts();
try { applyMutation(a, { type: 'income', to: 'wat', amount: 10 }); console.log('  ✗ unknown account should throw'); fail++; }
catch { console.log('  ✓ unknown account throws'); pass++; }

a = sampleAccounts();
for (let i = 0; i < 10; i++) applyMutation(a, { type: 'income', to: 'bybit', amount: 0.1 });
eq(acc(a, 'bybit'), 1001, 'no float drift after 10×0.1');

console.log('\n=== applySnapshot (mirror source balances, SET not delta) ===');
a = sampleAccounts();
let snap = applySnapshot(a, [{ account: 'bybit', amount: 745.27 }]);
eq(acc(snap, 'bybit'), 745.27, 'snapshot SETs bybit to source value (not a delta)');
eq(acc(snap, 'cash'), 5000, 'unlisted account untouched');
eq(acc(a, 'bybit'), 1000, 'original accounts not mutated (works on a copy)');

snap = applySnapshot(sampleAccounts(), [{ account: 'bybit', amount: 0 }, { account: 'card_t', amount: 5650 }]);
eq(acc(snap, 'bybit'), 0, 'batch snapshot: bybit → 0');
eq(acc(snap, 'card_t'), 5650, 'batch snapshot: card_t → 5650 (anchor fix)');

snap = applySnapshot(sampleAccounts(), [{ account: 'maxswap', amount: 7.366666 }]);
eq(acc(snap, 'maxswap'), 7.37, 'snapshot rounds to cents');

try { applySnapshot(sampleAccounts(), [{ account: 'nope', amount: 1 }]); console.log('  ✗ unknown account should throw'); fail++; }
catch { console.log('  ✓ snapshot unknown account throws (batch rejected)'); pass++; }

console.log('\n=== edit event (reverse old + apply new) ===');
// PATCH /api/event/:id math: take the live balances, reverse the stored event,
// then apply the corrected one. Net effect == as if the corrected event had been
// logged in the first place.
const applyEdit = (accounts, oldEv, newEv) => applyMutation(reverseMutation(accounts, oldEv), newEv);

a = sampleAccounts();
const oldExp = { type: 'expense', from: 'bybit', amount: 600 };
applyMutation(a, oldExp); // live state after original log: bybit 400
applyEdit(a, oldExp, { type: 'expense', from: 'bybit', amount: 500 });
eq(acc(a, 'bybit'), 500, 'edit expense 600→500 leaves bybit as if 500 logged');

a = sampleAccounts();
const oldInc = { type: 'income', to: 'bybit', amount: 2499 };
applyMutation(a, oldInc); // bybit 3499
applyEdit(a, oldInc, { type: 'expense', from: 'cash', amount: 1000 }); // change type + account
eq(acc(a, 'bybit'), 1000, 'edit reverts wrong income off bybit');
eq(acc(a, 'cash'), 4000, 'edit applies corrected expense on cash');

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
