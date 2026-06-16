// Storage backend: Google Sheets (spreadsheet with two tabs: Events + Balances).
// Auth: a Google service-account JWT (RS256, signed via WebCrypto) is exchanged
// for an OAuth access token, which is cached in-isolate until it expires.
//
// Config comes through env (see wrangler.toml):
//   SPREADSHEET_ID        — the target spreadsheet id
//   GOOGLE_SA_JSON        — full service-account JSON (secret)
//   FINANCE_WORKER_API_TOKEN — bearer token the PWA sends (secret)
//   DEFAULT_ACCOUNT_*     — account id quick-expense routes to per currency
//
// No personal values live in code — this is a public template.
//
// Display timezone is a single configurable value, not a hardcoded zone. It lives
// in KV (binding CONFIG, key `timezone`), is read via readTimezone(), and falls
// back to env.TIMEZONE then 'Asia/Bangkok'. The site reads/writes it through
// GET/PUT /api/config, so one change propagates everywhere (no redeploy). Storage
// stays zone-agnostic: `at` is an absolute UTC instant; the zone is applied only
// when bucketing days (getDay) or formatting the human `when` column.
//
// === Sheet schema ===
// Events  (row 1 = headers): A:when  B:type  C:from  D:to  E:amount  F:amount_to  G:note  H:id  I:at  J:client_id
//   `when` is a display-only column (a short date in the configured timezone,
//   derived from `at`); written on append, ignored on read. `at` (ISO) is truth.
// Balances: F1 = updated_at ISO (raw, hidden). An "Updated" line sits up top; the
//   accounts table is found by scanning column A for the "id" header and read
//   until the first blank row (a totals block sits below that blank, ignored).
//
// Both sheets are read/written with valueInputOption=RAW (no locale parsing) and
// valueRenderOption=UNFORMATTED_VALUE (numbers come back as numbers, the ISO `at`
// stays a plain string). The user may hand-edit either sheet — the Worker never
// assumes it is the only writer beyond the per-request read→mutate→write window.

const WEEKDAYS_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const EVENTS_SHEET = 'Events';
const BALANCES_SHEET = 'Balances';
const SETTINGS_SHEET = 'Settings';
// Column order the Worker reads/writes for the Events sheet. `when` is a
// display-only derived column (see formatWhen); every other key maps 1:1 to the
// event object.
const EVENT_COLS = ['when', 'type', 'from', 'to', 'amount', 'amount_to', 'note', 'id', 'at', 'client_id'];

export default {
  async fetch(req, env) {
    const auth = req.headers.get('Authorization') || '';
    if (!env.FINANCE_WORKER_API_TOKEN || auth !== `Bearer ${env.FINANCE_WORKER_API_TOKEN}`) {
      return error(401, 'unauthorized');
    }

    const url = new URL(req.url);

    try {
      if (req.method === 'GET' && url.pathname === '/api/config') return await getConfig(env);
      if (req.method === 'PUT' && url.pathname === '/api/config') return await putConfig(req, env);
      if (req.method === 'GET' && url.pathname === '/api/balances') return await getBalances(env);
      if (req.method === 'GET' && url.pathname === '/api/day') return await getDay(req, env);
      if (req.method === 'GET' && url.pathname === '/api/events') return await getEvents(req, env);
      if (req.method === 'POST' && url.pathname === '/api/event') return await handleEvent(req, env);
      if (req.method === 'DELETE' && url.pathname === '/api/event/last') return await handleEventDelete(env);
      if (req.method === 'POST' && url.pathname === '/api/expense') return await handleQuickExpense(req, env);
      if (req.method === 'POST' && url.pathname === '/api/snapshot') return await handleSnapshot(req, env);
      // Edit/delete an arbitrary event by id — the reconciliation path Claude Code
      // (and any operator) uses instead of touching Sheets directly. `/api/event/last`
      // is matched above; any other suffix is taken as an event id.
      const idMatch = url.pathname.match(/^\/api\/event\/([^/]+)$/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        if (req.method === 'PATCH') return await patchEventById(req, env, id);
        if (req.method === 'DELETE') return await deleteEventById(env, id);
      }
    } catch (e) {
      return error(502, `sheets: ${e.message}`);
    }

    return error(404, 'not found');
  },
};

// === RESPONSE HELPERS ===

function json(payload) {
  return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
}
function ok(data) {
  return new Response(JSON.stringify({ ok: true, ...data }), { headers: JSON_HEADERS });
}
function error(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: JSON_HEADERS });
}

// === DATE / PARSING HELPERS ===

const pad = (n) => String(n).padStart(2, '0');

// Currency tokens recognized in quick-expense text. Stripped from description,
// used to route to a default account (via env.DEFAULT_ACCOUNT_USDT / _RUB / _THB / _VND).
// Unicode-aware word boundaries: JS \b is ASCII-only, so "руб" wouldn't match
// at cyrillic boundaries. Lookbehind/ahead on letter/number guard against
// false positives like "рубероид" / "рубашку". Tokens match the bare stem only
// (e.g. "руб" matches "руб" but not "рублей", "донг" not "донгов") — same dumb
// contract as the amount parser.
const CURRENCY_TOKEN_RE = /(?<![\p{L}\p{N}_])(usdt|rub|руб|thb|бат|baht|vnd|донг)(?![\p{L}\p{N}_])/giu;

// Token stem (lowercased) → currency code.
const TOKEN_CURRENCY = {
  usdt: 'USDT',
  rub: 'RUB', руб: 'RUB',
  thb: 'THB', бат: 'THB', baht: 'THB',
  vnd: 'VND', донг: 'VND',
};

function defaultAccountByCurrency(env) {
  return {
    USDT: env.DEFAULT_ACCOUNT_USDT,
    RUB: env.DEFAULT_ACCOUNT_RUB,
    THB: env.DEFAULT_ACCOUNT_THB,
    VND: env.DEFAULT_ACCOUNT_VND,
  };
}

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

// "Today" (and weekday/section header) in the given zone. `dateParam` builds the
// same shape from a literal YYYY-MM-DD (weekday of a calendar date is zone-free).
function zoneContext(nowISO, tz) {
  const now = nowISO ? new Date(nowISO) : new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return contextFromYMD(parseInt(parts.year, 10), parseInt(parts.month, 10), parseInt(parts.day, 10));
}

function contextFromYMD(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  const weekdayRu = WEEKDAYS_RU[dt.getUTCDay()];
  const monthEn = MONTHS_EN[month - 1];
  return {
    year, month, day, weekdayRu, monthEn,
    sectionHeader: `## ${pad(day)}.${pad(month)}.${year}, ${weekdayRu}`,
  };
}

function dateInZone(iso, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Display string for the Events `when` column: a short date in `tz`. Noon-exact
// (12:00:00) is the backdate placeholder — no real time-of-day — so it shows the
// date only; any other time shows `DD.MM.YYYY HH:MM`. Derived from `at` on write.
function formatWhen(iso, tz) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const date = `${p.day}.${p.month}.${p.year}`;
  if (p.hour === '12' && p.minute === '00' && p.second === '00') return date;
  return `${date} ${p.hour}:${p.minute}`;
}

// === CONFIG (display timezone, single source of truth in KV) ===

// Brief in-isolate cache. The zone changes rarely; a 30s TTL keeps getDay/createEvent
// from hitting KV every call, and putConfig refreshes it immediately on change.
let cachedTz = null; // { value, exp } (exp in epoch ms)

async function readTimezone(env) {
  const now = Date.now();
  if (cachedTz && cachedTz.exp > now) return cachedTz.value;
  let value = null;
  if (env.CONFIG) { try { value = await env.CONFIG.get('timezone'); } catch { value = null; } }
  const tz = (value && isValidTimeZone(value)) ? value : (env.TIMEZONE || 'Asia/Bangkok');
  cachedTz = { value: tz, exp: now + 30_000 };
  return tz;
}

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

async function getConfig(env) {
  return json({ timezone: await readTimezone(env) });
}

async function putConfig(req, env) {
  let body;
  try { body = await req.json(); } catch { return error(400, 'invalid json'); }
  if (!body || typeof body.timezone !== 'string') return error(400, 'missing field "timezone"');
  if (!isValidTimeZone(body.timezone)) return error(400, `invalid IANA timezone: ${body.timezone}`);
  if (!env.CONFIG) return error(500, 'CONFIG KV namespace not bound');
  await env.CONFIG.put('timezone', body.timezone);
  cachedTz = { value: body.timezone, exp: Date.now() + 30_000 };
  return json({ timezone: body.timezone });
}

// === BALANCES (read Balances sheet → {updated_at, accounts}) ===

async function getBalances(env) {
  const token = await getAccessToken(env);
  const [{ accounts, updatedAt }, { primaryAccount, primaryCurrency }, timezone] = await Promise.all([
    readBalances(env, token),
    readSettings(env, token),
    readTimezone(env),
  ]);
  // `primary` / `primary_currency` let the site surface the everyday account first
  // (highlighted on the balances screen). `timezone` is the active display zone, so
  // read screens compute "today"/day-of from the same source the Worker uses.
  return json({
    updated_at: updatedAt,
    accounts,
    primary: primaryAccount,
    primary_currency: primaryCurrency,
    timezone,
  });
}

// === DAY (filters expense events from the Events sheet for a given local day) ===

async function getDay(req, env) {
  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');
  const tz = await readTimezone(env);

  let ctx;
  if (dateParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return error(400, 'date must be YYYY-MM-DD');
    const [y, m, d] = dateParam.split('-').map(Number);
    ctx = contextFromYMD(y, m, d);
  } else {
    ctx = zoneContext(null, tz);
  }

  const dateISO = `${ctx.year}-${pad(ctx.month)}-${pad(ctx.day)}`;

  const [events, { accounts }, { primaryCurrency }] = await Promise.all([
    readEvents(env), readBalances(env), readSettings(env),
  ]);

  const accountCurrency = {};
  for (const a of accounts) accountCurrency[a.id] = a.currency;
  const fallbackCurrency = primaryCurrency || 'THB';

  const expenses = events
    .filter((ev) => ev.type === 'expense' && ev.at && dateInZone(ev.at, tz) === dateISO)
    .map((ev) => ({
      description: ev.note || (ev.from ? `с ${ev.from}` : 'расход'),
      amount: ev.amount,
      currency: accountCurrency[ev.from] || fallbackCurrency,
      source: 'event',
      from: ev.from,
      id: ev.id,
    }));

  const totals = {};
  for (const e of expenses) totals[e.currency] = (totals[e.currency] || 0) + e.amount;

  return json({ date: dateISO, section: ctx.sectionHeader, expenses, totals, timezone: tz });
}

// === EVENTS LOG (GET /api/events) — full read-only log for reconciliation ===

// Returns every logged event in sheet order (oldest first). Optional filters:
//   ?type=income|expense|transfer|exchange  — keep only that type
//   ?limit=N                                — keep only the last N (after filtering)
// client_id is the internal idempotency key and is never echoed back.
async function getEvents(req, env) {
  const url = new URL(req.url);
  const type = url.searchParams.get('type');
  if (type && !['income', 'expense', 'transfer', 'exchange'].includes(type)) {
    return error(400, 'type must be income/expense/transfer/exchange');
  }
  const limitParam = url.searchParams.get('limit');
  let limit = null;
  if (limitParam != null) {
    limit = parseInt(limitParam, 10);
    if (!Number.isInteger(limit) || limit < 1) return error(400, 'limit must be a positive integer');
  }

  const events = await readEvents(env);
  let list = events.map(({ client_id, ...pub }) => pub);
  if (type) list = list.filter((e) => e.type === type);
  if (limit) list = list.slice(-limit);

  return json({ count: list.length, events: list });
}

// === QUICK EXPENSE (POST /api/expense) — main screen of PWA ===

async function handleQuickExpense(req, env) {
  let body;
  try { body = await req.json(); } catch { return error(400, 'invalid json'); }
  if (!body || typeof body.text !== 'string') return error(400, 'missing field "text"');

  let parsed;
  try { parsed = parseExpense(body.text); } catch (e) { return error(400, e.message); }

  // No currency token → the everyday "primary" account, read from the Settings
  // sheet (so the user switches it by editing a cell, no redeploy). A currency
  // token routes to that currency's default account (env) instead.
  let from;
  if (parsed.currency) {
    from = defaultAccountByCurrency(env)[parsed.currency];
    if (!from) return error(500, `no default account configured for currency ${parsed.currency}`);
  } else {
    const { primaryAccount } = await readSettings(env);
    from = primaryAccount;
    if (!from) return error(500, 'no primary account configured (set it on the Settings sheet)');
  }

  return createEvent(env, {
    type: 'expense',
    from,
    amount: parsed.amount,
    note: parsed.description,
    at: body.now,
    client_id: body.client_id,
  });
}

// === SNAPSHOT (POST /api/snapshot) — mirror source balances, no log write ===

// Sets one or more account balances directly from a source's reported snapshot.
// Body: { balances: [{ account, amount }], updated_at? }. Used by the aggregator's
// pollers (bybit/Trongrid/ZenMoney) to keep connected accounts mirrored. This is
// the ONLY write path that sets a balance without an event: snapshots are not
// operations, so the Events log is untouched. Accounts not listed keep their
// amount. Validated all-or-nothing — an unknown id rejects the whole batch.
//
// NOTE on double-counting: an account mirrored by snapshot must NOT also have its
// operations mutate the balance (that would move it twice). Logging the source's
// operations for analytics/watchdog without touching the balance ("log-only"
// events) is the coupled next step — it needs an Events schema column so PATCH/
// DELETE don't reverse a mutation that never happened. Speced in
// dev/notes/aggregator-design.md; not implemented here.
async function handleSnapshot(req, env) {
  let body;
  try { body = await req.json(); } catch { return error(400, 'invalid json'); }
  if (!body || !Array.isArray(body.balances) || body.balances.length === 0) {
    return error(400, 'missing field "balances" (non-empty array of {account, amount})');
  }
  for (const b of body.balances) {
    if (!b || typeof b.account !== 'string' || !b.account) return error(400, 'each balance needs a string "account"');
    if (typeof b.amount !== 'number' || !isFinite(b.amount)) return error(400, `amount must be a finite number (account ${b && b.account})`);
  }
  if (body.updated_at !== undefined && body.updated_at !== null) {
    if (typeof body.updated_at !== 'string' || isNaN(new Date(body.updated_at).getTime())) {
      return error(400, 'updated_at must be an ISO string');
    }
  }

  const token = await getAccessToken(env);
  const { accounts, dataStartRow } = await readBalances(env, token);

  let next;
  try {
    next = applySnapshot(accounts, body.balances);
  } catch (e) {
    return error(400, e.message); // unknown account id
  }

  const updatedAt = body.updated_at ? new Date(body.updated_at).toISOString() : new Date().toISOString();
  await writeBalanceAmounts(env, next, updatedAt, token, dataStartRow);

  return ok({ balances: { updated_at: updatedAt, accounts: next } });
}

// === EVENTS ===

function validateEvent(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: 'invalid body' };
  const types = ['income', 'transfer', 'exchange', 'expense'];
  if (!types.includes(body.type)) return { ok: false, message: 'type must be income/transfer/exchange/expense' };
  if (typeof body.amount !== 'number' || !isFinite(body.amount) || body.amount <= 0) {
    return { ok: false, message: 'amount must be positive number' };
  }
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
    if (typeof body.amount_to !== 'number' || !isFinite(body.amount_to) || body.amount_to <= 0) {
      return { ok: false, message: 'amount_to must be positive number' };
    }
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    return { ok: false, message: 'note must be string' };
  }
  if (body.at !== undefined && body.at !== null) {
    if (typeof body.at !== 'string') return { ok: false, message: 'at must be ISO string' };
    const d = new Date(body.at);
    if (isNaN(d.getTime())) return { ok: false, message: 'at is not valid date' };
    if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return { ok: false, message: 'at cannot be in the future' };
  }
  if (body.client_id !== undefined && body.client_id !== null) {
    if (typeof body.client_id !== 'string' || body.client_id.length > 64) {
      return { ok: false, message: 'client_id must be string ≤64 chars' };
    }
  }
  return { ok: true };
}

function findAccount(accounts, id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) throw new Error(`unknown account: ${id}`);
  return acc;
}

function roundCents(accounts) {
  for (const a of accounts) a.amount = Math.round(a.amount * 100) / 100;
  return accounts;
}

function applyMutation(accounts, event) {
  if (event.type === 'income') {
    findAccount(accounts, event.to).amount += event.amount;
  } else if (event.type === 'expense') {
    findAccount(accounts, event.from).amount -= event.amount;
  } else if (event.type === 'transfer') {
    const from = findAccount(accounts, event.from);
    const to = findAccount(accounts, event.to);
    if (from.currency !== to.currency) throw new Error('transfer requires same currency');
    from.amount -= event.amount;
    to.amount += event.amount;
  } else if (event.type === 'exchange') {
    findAccount(accounts, event.from).amount -= event.amount;
    findAccount(accounts, event.to).amount += event.amount_to;
  } else {
    throw new Error(`unknown event type: ${event.type}`);
  }
  return roundCents(accounts);
}

function reverseMutation(accounts, event) {
  if (event.type === 'income') {
    findAccount(accounts, event.to).amount -= event.amount;
  } else if (event.type === 'expense') {
    findAccount(accounts, event.from).amount += event.amount;
  } else if (event.type === 'transfer') {
    findAccount(accounts, event.from).amount += event.amount;
    findAccount(accounts, event.to).amount -= event.amount;
  } else if (event.type === 'exchange') {
    findAccount(accounts, event.from).amount += event.amount;
    findAccount(accounts, event.to).amount -= event.amount_to;
  } else {
    throw new Error(`unknown event type: ${event.type}`);
  }
  return roundCents(accounts);
}

// Overlay a source's balance snapshot onto a copy of accounts. Listed accounts are
// SET to the reported balance (authority = the source itself, NOT a delta off the
// log); accounts not in the snapshot keep their current amount. Throws on an
// unknown id so handleSnapshot can reject the whole batch before any write.
// This is the model's "signal 1" (snapshot): connected accounts mirror their
// source instead of being recomputed from Σevents, so one missed op can't drift
// them. See dev/notes/aggregator-design.md §2.
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

function describeEvent(ev) {
  if (ev.type === 'income') return `+${ev.amount} → ${ev.to}${ev.note ? ` (${ev.note})` : ''}`;
  if (ev.type === 'expense') return `−${ev.amount} ${ev.from}${ev.note ? ` (${ev.note})` : ''}`;
  if (ev.type === 'transfer') return `${ev.from} → ${ev.to}: ${ev.amount}${ev.note ? ` (${ev.note})` : ''}`;
  if (ev.type === 'exchange') return `${ev.from} ${ev.amount} → ${ev.to} ${ev.amount_to}${ev.note ? ` (${ev.note})` : ''}`;
  return ev.type;
}

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `ev_${crypto.randomUUID().slice(0, 12)}`;
  return `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function handleEvent(req, env) {
  let body;
  try { body = await req.json(); } catch { return error(400, 'invalid json'); }
  return createEvent(env, body);
}

async function createEvent(env, body) {
  const v = validateEvent(body);
  if (!v.ok) return error(400, v.message);

  const clientId = typeof body.client_id === 'string' && body.client_id ? body.client_id : null;

  const event = {
    id: genId(),
    type: body.type,
    from: body.from || null,
    to: body.to || null,
    amount: Math.round(body.amount * 100) / 100,
    amount_to: body.amount_to != null ? Math.round(body.amount_to * 100) / 100 : null,
    note: body.note || null,
    at: body.at ? new Date(body.at).toISOString() : new Date().toISOString(),
    client_id: clientId,
  };

  const token = await getAccessToken(env);
  const tz = await readTimezone(env);

  // Read current balances + the event log (the latter only when we need to
  // de-duplicate a retried write). One round-trip each, in parallel.
  const [{ accounts, updatedAt, dataStartRow }, events] = await Promise.all([
    readBalances(env, token),
    clientId ? readEvents(env, token) : Promise.resolve(null),
  ]);

  // Idempotency: if any logged event carries the same client_id, the previous POST
  // already committed — return it without a second write. Scans the FULL log, not a
  // trailing window: a poller using client_id as a stable source-id (e.g. a
  // ZenMoney op id or a tx hash) must dedup against all history, else a backfill
  // rerun silently doubles rows once the earlier ones scroll past a fixed window.
  if (clientId && events) {
    const existing = events.find((e) => e.client_id === clientId);
    if (existing) {
      const { client_id, ...publicExisting } = existing;
      return ok({ event: publicExisting, balances: { updated_at: updatedAt, accounts }, deduped: true });
    }
  }

  const newAccounts = applyMutation(accounts.map((a) => ({ ...a })), event);
  const newUpdatedAt = event.at;

  // Append the event row first (the log is the source of truth — balances can
  // always be recomputed from it), then write the new balances. Two requests:
  // Sheets has no cross-tab transaction, but for a single user the window is
  // negligible and a crash between them leaves only a recoverable drift.
  await appendEvent(env, event, token, tz);
  await writeBalanceAmounts(env, newAccounts, newUpdatedAt, token, dataStartRow);

  // Don't echo client_id back to the client (internal idempotency key).
  const { client_id, ...publicEvent } = event;
  return ok({ event: publicEvent, balances: { updated_at: newUpdatedAt, accounts: newAccounts } });
}

async function handleEventDelete(env) {
  const token = await getAccessToken(env);

  const [events, { accounts, dataStartRow }] = await Promise.all([
    readEvents(env, token),
    readBalances(env, token),
  ]);

  if (events.length === 0) return error(404, 'no events to undo');

  const last = events[events.length - 1];
  const newAccounts = reverseMutation(accounts.map((a) => ({ ...a })), last);
  const updatedAt = new Date().toISOString();

  // Reverse the balance first, then drop the row. If the row delete failed the
  // log would keep a phantom entry — reversing first means balances are right
  // and a re-issued undo simply pops the same row.
  await writeBalanceAmounts(env, newAccounts, updatedAt, token, dataStartRow);
  await deleteEventRow(env, events.length + 1, token); // last event row = data count + header

  const { client_id, ...publicEvent } = last;
  return ok({ undone: publicEvent, balances: { updated_at: updatedAt, accounts: newAccounts } });
}

// Fields a PATCH may change. id and client_id are immutable (the row's identity
// and the idempotency key); `when` is derived from `at`, never set directly.
const PATCHABLE_FIELDS = ['type', 'from', 'to', 'amount', 'amount_to', 'note', 'at'];

// PATCH /api/event/:id — correct an arbitrary past event. Merges the given fields
// over the stored event, re-validates, then rebalances by reversing the old
// mutation and applying the new one. The log is the source of truth, so the row
// is rewritten first, then balances (a crash between leaves a recoverable drift,
// same contract as createEvent's append→balances order). Pass an explicit null to
// clear a field (e.g. {"note": null}); omitted fields keep their stored value.
async function patchEventById(req, env, id) {
  let body;
  try { body = await req.json(); } catch { return error(400, 'invalid json'); }
  if (!body || typeof body !== 'object') return error(400, 'invalid body');

  const token = await getAccessToken(env);
  const tz = await readTimezone(env);
  const [events, { accounts, dataStartRow }] = await Promise.all([
    readEvents(env, token),
    readBalances(env, token),
  ]);

  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return error(404, `event not found: ${id}`);
  const old = events[idx];

  const merged = { ...old };
  for (const k of PATCHABLE_FIELDS) if (k in body) merged[k] = body[k];

  const v = validateEvent(merged);
  if (!v.ok) return error(400, v.message);

  const newEvent = {
    id: old.id,
    type: merged.type,
    from: merged.from || null,
    to: merged.to || null,
    amount: Math.round(merged.amount * 100) / 100,
    amount_to: merged.amount_to != null ? Math.round(merged.amount_to * 100) / 100 : null,
    note: merged.note || null,
    at: merged.at ? new Date(merged.at).toISOString() : old.at,
    client_id: old.client_id,
  };

  // Reverse the stored event, then apply the corrected one, on one snapshot.
  let newAccounts = accounts.map((a) => ({ ...a }));
  newAccounts = reverseMutation(newAccounts, old);
  newAccounts = applyMutation(newAccounts, newEvent);
  const updatedAt = new Date().toISOString();
  const rowNumber = idx + 2; // header at row 1, events start at row 2

  await writeEventRow(env, rowNumber, newEvent, token, tz);
  await writeBalanceAmounts(env, newAccounts, updatedAt, token, dataStartRow);

  const { client_id, ...publicEvent } = newEvent;
  return ok({ updated: publicEvent, balances: { updated_at: updatedAt, accounts: newAccounts } });
}

// DELETE /api/event/:id — drop an arbitrary past event. Mirrors undo-last:
// reverse the balance first (so balances are right even if the row delete fails;
// a re-issued delete by id is a no-op once the row is gone), then delete the row.
async function deleteEventById(env, id) {
  const token = await getAccessToken(env);
  const [events, { accounts, dataStartRow }] = await Promise.all([
    readEvents(env, token),
    readBalances(env, token),
  ]);

  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return error(404, `event not found: ${id}`);
  const target = events[idx];

  const newAccounts = reverseMutation(accounts.map((a) => ({ ...a })), target);
  const updatedAt = new Date().toISOString();
  const rowNumber = idx + 2; // header at row 1, events start at row 2

  await writeBalanceAmounts(env, newAccounts, updatedAt, token, dataStartRow);
  await deleteEventRow(env, rowNumber, token);

  const { client_id, ...publicEvent } = target;
  return ok({ deleted: publicEvent, balances: { updated_at: updatedAt, accounts: newAccounts } });
}

// === GOOGLE AUTH (service-account JWT → OAuth access token) ===

// Cached per-isolate. Workers reuse isolates across requests, so most requests
// skip the token exchange entirely.
let cachedToken = null; // { value, exp } (exp in epoch ms)

function getServiceAccount(env) {
  if (!env.GOOGLE_SA_JSON) throw new Error('GOOGLE_SA_JSON not configured');
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SA_JSON); }
  catch { throw new Error('GOOGLE_SA_JSON is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_SA_JSON missing client_email/private_key');
  return sa;
}

async function getAccessToken(env) {
  const now = Date.now();
  if (cachedToken && cachedToken.exp > now + 60_000) return cachedToken.value;

  const sa = getServiceAccount(env);
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat,
    exp,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64urlBytes(new Uint8Array(sig))}`;

  const res = await fetch(claim.aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, exp: now + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function importPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = base64ToBytes(body);
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

// === GOOGLE SHEETS API ===

function sheetsHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function sheetsValuesGet(env, range, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`values.get ${range} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.values || [];
}

async function readBalances(env, token) {
  token = token || await getAccessToken(env);
  // A1:F covers the accounts (id/name/amount/currency) plus the raw updated_at at
  // F1. The accounts table no longer starts at row 1: find its header by scanning
  // column A for "id", then read rows until the first blank (a totals block lives
  // below that blank and must not be read as accounts). dataStartRow (1-based) is
  // returned so the writer targets the right amount cells.
  const rows = await sheetsValuesGet(env, `${BALANCES_SHEET}!A1:F`, token);
  const updatedAt = (rows[0] && rows[0][5] != null && rows[0][5] !== '') ? String(rows[0][5]) : null;
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && String(rows[i][0]).toLowerCase() === 'id') { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error('Balances: accounts header (id) not found');
  const accounts = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const id = r && r[0];
    if (id == null || id === '') break;
    accounts.push({
      id: String(id),
      name: r[1] != null ? String(r[1]) : '',
      amount: typeof r[2] === 'number' ? r[2] : parseFloat(r[2]) || 0,
      currency: r[3] != null ? String(r[3]) : '',
    });
  }
  return { accounts, updatedAt, dataStartRow: headerIdx + 2 };
}

// The everyday account/currency live on a dedicated `Settings` sheet so the user
// can switch them by editing a cell (dropdown) — no redeploy. Layout: column A is a
// hidden machine key (`primary_account` / `primary_currency`), column C the value.
// env vars (PRIMARY_ACCOUNT / PRIMARY_CURRENCY) are the fallback when absent/blank.
async function readSettings(env, token) {
  token = token || await getAccessToken(env);
  let rows = [];
  try {
    rows = await sheetsValuesGet(env, `${SETTINGS_SHEET}!A1:C`, token);
  } catch {
    rows = []; // Settings sheet missing → fall back to env below
  }
  let primaryAccount = null;
  let primaryCurrency = null;
  for (const r of rows) {
    if (!r) continue;
    const key = String(r[0] != null ? r[0] : '').trim().toLowerCase();
    const value = r[2] != null && r[2] !== '' ? String(r[2]).trim() : null;
    if (key === 'primary_account') primaryAccount = value;
    else if (key === 'primary_currency') primaryCurrency = value;
  }
  return {
    primaryAccount: primaryAccount || env.PRIMARY_ACCOUNT || null,
    primaryCurrency: primaryCurrency || env.PRIMARY_CURRENCY || null,
  };
}

async function readEvents(env, token) {
  token = token || await getAccessToken(env);
  const rows = await sheetsValuesGet(env, `${EVENTS_SHEET}!A2:J`, token);
  const events = [];
  for (const r of rows) {
    const ev = rowToEvent(r);
    if (ev.id == null) continue; // blank/incomplete row
    events.push(ev);
  }
  return events;
}

function rowToEvent(r) {
  const cell = (i) => (r[i] === undefined || r[i] === '' ? null : r[i]);
  const num = (i) => {
    const v = cell(i);
    if (v == null) return null;
    return typeof v === 'number' ? v : parseFloat(v);
  };
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
    if (c === 'when') return formatWhen(ev.at, tz); // display-only, derived from `at`
    const v = ev[c];
    return v == null ? '' : v;
  });
}

async function appendEvent(env, event, token, tz) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(EVENTS_SHEET + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: sheetsHeaders(token),
    body: JSON.stringify({ values: [eventToRow(event, tz)] }),
  });
  if (!res.ok) throw new Error(`values.append ${res.status}: ${await res.text()}`);
}

// Writes the amount column (C2:C{n+1}) and the updated_at cell (F1) in one
// atomic values.batchUpdate. Amounts are written by row position, matching the
// order they were just read in.
async function writeBalanceAmounts(env, accounts, updatedAt, token, dataStartRow) {
  const start = dataStartRow || 2;
  const lastRow = start + accounts.length - 1;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: sheetsHeaders(token),
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: [
        { range: `${BALANCES_SHEET}!C${start}:C${lastRow}`, values: accounts.map((a) => [a.amount]) },
        { range: `${BALANCES_SHEET}!F1`, values: [[updatedAt]] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`values.batchUpdate ${res.status}: ${await res.text()}`);
}

// sheetId (gid) per tab title, needed for structural row deletion. Cached per-isolate.
let cachedSheetIds = null;

async function getSheetId(env, title, token) {
  if (!cachedSheetIds) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}?fields=sheets.properties(sheetId,title)`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`spreadsheets.get ${res.status}: ${await res.text()}`);
    const data = await res.json();
    cachedSheetIds = {};
    for (const s of data.sheets || []) cachedSheetIds[s.properties.title] = s.properties.sheetId;
  }
  const id = cachedSheetIds[title];
  if (id == null) throw new Error(`sheet not found: ${title}`);
  return id;
}

// Overwrites one event row in place (A:J) with the given event. Used by PATCH to
// persist a corrected event; `when` is re-derived from `at` by eventToRow.
async function writeEventRow(env, rowNumber, event, token, tz) {
  const range = `${EVENTS_SHEET}!A${rowNumber}:J${rowNumber}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: sheetsHeaders(token),
    body: JSON.stringify({ values: [eventToRow(event, tz)] }),
  });
  if (!res.ok) throw new Error(`values.update ${range} ${res.status}: ${await res.text()}`);
}

// Deletes one data row of the Events sheet by 1-based sheet row number (header is
// row 1, so the structural dimension index is rowNumber - 1).
async function deleteEventRow(env, rowNumber, token) {
  const sheetId = await getSheetId(env, EVENTS_SHEET, token);
  const startIndex = rowNumber - 1;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: sheetsHeaders(token),
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex, endIndex: startIndex + 1 },
        },
      }],
    }),
  });
  if (!res.ok) throw new Error(`batchUpdate(delete) ${res.status}: ${await res.text()}`);
}

// === BASE64 HELPERS ===

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64urlBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64url(text) {
  return base64urlBytes(new TextEncoder().encode(text));
}
