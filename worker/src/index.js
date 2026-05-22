// REPO / BRANCH / DEFAULT_ACCOUNT_* приходят через env (см. wrangler.toml [vars]).
// Никакие личные значения не хранятся в коде — это публичный шаблон.

const WEEKDAYS_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default {
  async fetch(req, env) {
    const auth = req.headers.get('Authorization') || '';
    if (!env.APP_TOKEN || auth !== `Bearer ${env.APP_TOKEN}`) {
      return error(401, 'unauthorized');
    }

    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/api/balances') return getBalances(env);
    if (req.method === 'GET' && url.pathname === '/api/day') return getDay(req, env);
    if (req.method === 'POST' && url.pathname === '/api/event') return handleEvent(req, env);
    if (req.method === 'DELETE' && url.pathname === '/api/event/last') return handleEventDelete(env);
    if (req.method === 'POST' && url.pathname === '/api/expense') return handleQuickExpense(req, env);

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
// used to route to a default account (via env.DEFAULT_ACCOUNT_USDT / _RUB / _THB).
// Unicode-aware word boundaries: JS \b is ASCII-only, so "руб" wouldn't match
// at cyrillic boundaries. Lookbehind/ahead on letter/number guard against
// false positives like "рубероид" / "рубашку".
const CURRENCY_TOKEN_RE = /(?<![\p{L}\p{N}_])(usdt|rub|руб)(?![\p{L}\p{N}_])/giu;

function defaultAccountByCurrency(env) {
  return { USDT: env.DEFAULT_ACCOUNT_USDT, RUB: env.DEFAULT_ACCOUNT_RUB, THB: env.DEFAULT_ACCOUNT_THB };
}

function parseExpense(input) {
  let text = input.replace(/[\r\n]+/g, ' ').trim();
  if (!text) throw new Error('empty input');

  let currency = null;
  const tokens = [...text.matchAll(CURRENCY_TOKEN_RE)];
  if (tokens.length === 1) {
    const tok = tokens[0][1].toLowerCase();
    currency = tok === 'usdt' ? 'USDT' : 'RUB';
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

function bangkokContext(nowISO) {
  const now = nowISO ? new Date(nowISO) : new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);
  const dt = new Date(Date.UTC(year, month - 1, day));
  const weekdayRu = WEEKDAYS_RU[dt.getUTCDay()];
  const monthEn = MONTHS_EN[month - 1];
  return {
    year, month, day, weekdayRu, monthEn,
    filename: `archive/daily-expenses-${monthEn}-${year}.md`,
    sectionHeader: `## ${pad(day)}.${pad(month)}.${year}, ${weekdayRu}`,
  };
}

function bangkokDateOf(iso) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// === MARKDOWN ARCHIVE PARSER ===
// Read-only. Used by GET /day to display historical days from old markdown
// (April + May 2026 before migration to events). Worker no longer writes markdown.

const PIPE_PLACEHOLDER = '';

function parseDay(content, sectionHeader) {
  const lines = content.split('\n');
  const headerIdx = lines.findIndex((l) => l.trim() === sectionHeader);
  if (headerIdx === -1) return [];

  const expenses = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^## \d{2}\.\d{2}\.\d{4}/.test(trimmed)) break;
    if (trimmed === '---' && expenses.length > 0) break;
    if (!trimmed.startsWith('|')) continue;
    if (/^\|\s*Что\s*\|/i.test(trimmed)) continue;
    if (/^\|---/.test(trimmed)) continue;
    if (/^\|\s*\*\*Итого/.test(trimmed)) continue;

    const safe = trimmed.replace(/\\\|/g, PIPE_PLACEHOLDER);
    const m = safe.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (!m) continue;
    const desc = m[1].split(PIPE_PLACEHOLDER).join('|').trim();
    const amountStr = m[2].replace(/\s+/g, '').replace(/\*+/g, '').trim();
    const amount = parseInt(amountStr, 10);
    if (!isFinite(amount) || amount <= 0) continue;
    expenses.push({ description: desc, amount });
  }
  return expenses;
}

// === BALANCES ===

async function getBalances(env) {
  const url = `https://api.github.com/repos/${env.REPO}/contents/balances.json?ref=${env.BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return json({ updated_at: null, accounts: [] });
  if (!res.ok) return error(502, `github GET ${res.status}`);
  const data = await res.json();
  let parsed;
  try { parsed = JSON.parse(base64ToUtf8(data.content)); }
  catch { return error(500, 'balances.json is not valid JSON'); }
  return json(parsed);
}

// === DAY (aggregates archive markdown + expense events) ===

async function getDay(req, env) {
  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');

  let ctx;
  if (dateParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return error(400, 'date must be YYYY-MM-DD');
    ctx = bangkokContext(`${dateParam}T12:00:00+07:00`);
  } else {
    ctx = bangkokContext();
  }

  const dateISO = `${ctx.year}-${pad(ctx.month)}-${pad(ctx.day)}`;

  const [mdResult, eventsData, balancesData] = await Promise.all([
    (async () => {
      const ghUrl = `https://api.github.com/repos/${env.REPO}/contents/${encodeURIComponent(ctx.filename)}?ref=${env.BRANCH}`;
      const r = await fetch(ghUrl, { headers: ghHeaders(env) });
      if (r.status === 404) return { ok: true, content: null };
      if (!r.ok) return { ok: false, status: r.status };
      const j = await r.json();
      return { ok: true, content: base64ToUtf8(j.content) };
    })(),
    readJSONFile(env, 'events.json', env.BRANCH).catch(() => null),
    readJSONFile(env, 'balances.json', env.BRANCH).catch(() => null),
  ]);

  if (!mdResult.ok) return error(502, `github GET ${mdResult.status}`);

  const mdExpenses = mdResult.content
    ? parseDay(mdResult.content, ctx.sectionHeader).map((e) => ({ ...e, currency: 'THB', source: 'md' }))
    : [];

  const accountCurrency = {};
  if (balancesData && Array.isArray(balancesData.accounts)) {
    for (const a of balancesData.accounts) accountCurrency[a.id] = a.currency;
  }

  const eventExpenses = (eventsData && Array.isArray(eventsData.events) ? eventsData.events : [])
    .filter((ev) => ev.type === 'expense' && ev.at && bangkokDateOf(ev.at) === dateISO)
    .map((ev) => ({
      description: ev.note || (ev.from ? `с ${ev.from}` : 'расход'),
      amount: ev.amount,
      currency: accountCurrency[ev.from] || 'THB',
      source: 'event',
      from: ev.from,
      id: ev.id,
    }));

  const all = [...mdExpenses, ...eventExpenses];
  const totals = {};
  for (const e of all) totals[e.currency] = (totals[e.currency] || 0) + e.amount;

  return json({ date: dateISO, section: ctx.sectionHeader, expenses: all, totals });
}

// === QUICK EXPENSE (POST /) — main screen of PWA ===

async function handleQuickExpense(req, env) {
  let body;
  try { body = await req.json(); } catch { return error(400, 'invalid json'); }
  if (!body || typeof body.text !== 'string') return error(400, 'missing field "text"');

  let parsed;
  try { parsed = parseExpense(body.text); } catch (e) { return error(400, e.message); }

  const defaults = defaultAccountByCurrency(env);
  const from = defaults[parsed.currency || 'THB'];
  if (!from) return error(500, `no default account configured for currency ${parsed.currency || 'THB'}`);

  return createEvent(env, {
    type: 'expense',
    from,
    amount: parsed.amount,
    note: parsed.description,
    at: body.now,
    client_id: body.client_id,
  });
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

function findAccount(balances, id) {
  const acc = (balances.accounts || []).find((a) => a.id === id);
  if (!acc) throw new Error(`unknown account: ${id}`);
  return acc;
}

function roundCents(balances) {
  for (const a of balances.accounts || []) a.amount = Math.round(a.amount * 100) / 100;
  return balances;
}

function applyMutation(balances, event) {
  if (event.type === 'income') {
    findAccount(balances, event.to).amount += event.amount;
  } else if (event.type === 'expense') {
    findAccount(balances, event.from).amount -= event.amount;
  } else if (event.type === 'transfer') {
    const from = findAccount(balances, event.from);
    const to = findAccount(balances, event.to);
    if (from.currency !== to.currency) throw new Error('transfer requires same currency');
    from.amount -= event.amount;
    to.amount += event.amount;
  } else if (event.type === 'exchange') {
    findAccount(balances, event.from).amount -= event.amount;
    findAccount(balances, event.to).amount += event.amount_to;
  } else {
    throw new Error(`unknown event type: ${event.type}`);
  }
  return roundCents(balances);
}

function reverseMutation(balances, event) {
  if (event.type === 'income') {
    findAccount(balances, event.to).amount -= event.amount;
  } else if (event.type === 'expense') {
    findAccount(balances, event.from).amount += event.amount;
  } else if (event.type === 'transfer') {
    findAccount(balances, event.from).amount += event.amount;
    findAccount(balances, event.to).amount -= event.amount;
  } else if (event.type === 'exchange') {
    findAccount(balances, event.from).amount += event.amount;
    findAccount(balances, event.to).amount -= event.amount_to;
  } else {
    throw new Error(`unknown event type: ${event.type}`);
  }
  return roundCents(balances);
}

function describeEvent(ev) {
  if (ev.type === 'income') return `+${ev.amount} → ${ev.to}${ev.note ? ` (${ev.note})` : ''}`;
  if (ev.type === 'expense') return `−${ev.amount} ${ev.from}${ev.note ? ` (${ev.note})` : ''}`;
  if (ev.type === 'transfer') return `${ev.from} → ${ev.to}: ${ev.amount}${ev.note ? ` (${ev.note})` : ''}`;
  if (ev.type === 'exchange') return `${ev.from} ${ev.amount} → ${ev.to} ${ev.amount_to}${ev.note ? ` (${ev.note})` : ''}`;
  return ev.type;
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

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
  };
  if (clientId) event.client_id = clientId;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const snap = await getBranchSnapshot(env);
      const [balances, eventsFile] = await Promise.all([
        readJSONFile(env, 'balances.json', snap.commitSha),
        readJSONFile(env, 'events.json', snap.commitSha),
      ]);
      if (!balances) return error(500, 'balances.json missing');
      const events = (eventsFile && eventsFile.events) || [];

      // Idempotency: if a recent event has the same client_id, the previous POST
      // already committed — return it without a second write. Window of 200 covers
      // any plausible PWA-queue flush burst.
      if (clientId) {
        const existing = events.slice(-200).find((e) => e.client_id === clientId);
        if (existing) return ok({ event: existing, balances, deduped: true });
      }

      const newBalances = applyMutation(deepClone(balances), event);
      newBalances.updated_at = event.at;
      const newEvents = { events: [...events, event] };

      await commitMultiple(env, snap, [
        { path: 'balances.json', content: JSON.stringify(newBalances, null, 2) + '\n' },
        { path: 'events.json', content: JSON.stringify(newEvents, null, 2) + '\n' },
      ], `Event: ${describeEvent(event)}`);

      return ok({ event, balances: newBalances });
    } catch (e) {
      if (e.message === 'ref conflict' && attempt < 3) continue;
      return error(500, e.message);
    }
  }
  return error(500, 'too many conflicts');
}

async function handleEventDelete(env) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const snap = await getBranchSnapshot(env);
      const [balances, eventsFile] = await Promise.all([
        readJSONFile(env, 'balances.json', snap.commitSha),
        readJSONFile(env, 'events.json', snap.commitSha),
      ]);

      const events = (eventsFile && eventsFile.events) || [];
      if (events.length === 0) return error(404, 'no events to undo');
      if (!balances) return error(500, 'balances.json missing');

      const last = events[events.length - 1];
      const newBalances = reverseMutation(deepClone(balances), last);
      newBalances.updated_at = new Date().toISOString();
      const newEvents = { events: events.slice(0, -1) };

      await commitMultiple(env, snap, [
        { path: 'balances.json', content: JSON.stringify(newBalances, null, 2) + '\n' },
        { path: 'events.json', content: JSON.stringify(newEvents, null, 2) + '\n' },
      ], `Undo: ${describeEvent(last)}`);

      return ok({ undone: last, balances: newBalances });
    } catch (e) {
      if (e.message === 'ref conflict' && attempt < 3) continue;
      return error(500, e.message);
    }
  }
  return error(500, 'too many conflicts');
}

// === GITHUB HELPERS ===

function ghHeaders(env) {
  return {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'my-finance-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function getBranchSnapshot(env) {
  const res = await fetch(`https://api.github.com/repos/${env.REPO}/branches/${env.BRANCH}`, { headers: ghHeaders(env) });
  if (!res.ok) throw new Error(`branches ${res.status}`);
  const j = await res.json();
  return { commitSha: j.commit.sha, treeSha: j.commit.commit.tree.sha };
}

async function readJSONFile(env, path, ref) {
  const url = `https://api.github.com/repos/${env.REPO}/contents/${encodeURIComponent(path)}?ref=${ref}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github GET ${path}: ${res.status}`);
  const j = await res.json();
  try { return JSON.parse(base64ToUtf8(j.content)); }
  catch { throw new Error(`${path} is not valid JSON`); }
}

async function commitMultiple(env, snap, files, message) {
  const jsonHeaders = { ...ghHeaders(env), 'Content-Type': 'application/json' };

  const treeRes = await fetch(`https://api.github.com/repos/${env.REPO}/git/trees`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      base_tree: snap.treeSha,
      tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    }),
  });
  if (!treeRes.ok) throw new Error(`tree ${treeRes.status}`);
  const newTree = await treeRes.json();

  const commitRes = await fetch(`https://api.github.com/repos/${env.REPO}/git/commits`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ message, tree: newTree.sha, parents: [snap.commitSha] }),
  });
  if (!commitRes.ok) throw new Error(`commit ${commitRes.status}`);
  const newCommit = await commitRes.json();

  const refRes = await fetch(`https://api.github.com/repos/${env.REPO}/git/refs/heads/${env.BRANCH}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  if (refRes.status === 422) throw new Error('ref conflict');
  if (!refRes.ok) throw new Error(`update ref ${refRes.status}`);

  return newCommit.sha;
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const clean = b64.replace(/\s/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
