#!/usr/bin/env node
// One-off migration: GitHub-repo storage (balances.json + events.json + markdown
// archive) → Google Sheets (two tabs: Events + Balances).
//
// Dependency-free: Node 18+ built-in fetch + node:crypto for the service-account
// JWT. Re-runnable — it clears both sheets and rewrites them from source.
//
// Config (env, with sensible fallbacks):
//   SOURCE_DIR        — dir holding balances.json, events.json, archive/*.md
//                       (the local clone of the private data repo). REQUIRED.
//   SPREADSHEET_ID    — target spreadsheet id. Falls back to parsing
//                       api/wrangler.toml.
//   SA_KEY            — path to the service-account JSON.
//                       Default: api/google-service-account.json
//   DEFAULT_ACCOUNT_THB — account id markdown (cash/THB) expenses map to.
//                       Default: cash
//
// Usage:
//   SOURCE_DIR=/path/to/my-finance node scripts/migrate-to-sheets.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_DIR = process.env.SOURCE_DIR;
const SA_KEY = process.env.SA_KEY || path.join(ROOT, 'api', 'google-service-account.json');
const THB_ACCOUNT = process.env.DEFAULT_ACCOUNT_THB || 'cash';

const EVENT_COLS = ['id', 'type', 'from', 'to', 'amount', 'amount_to', 'note', 'at', 'client_id'];
const EVENTS_SHEET = 'Events';
const BALANCES_SHEET = 'Balances';

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

if (!SOURCE_DIR) die('SOURCE_DIR is required (dir with balances.json/events.json/archive)');
if (!fs.existsSync(SA_KEY)) die(`service-account key not found: ${SA_KEY}`);

function spreadsheetId() {
  if (process.env.SPREADSHEET_ID) return process.env.SPREADSHEET_ID;
  const toml = path.join(ROOT, 'api', 'wrangler.toml');
  if (fs.existsSync(toml)) {
    const m = fs.readFileSync(toml, 'utf8').match(/^\s*SPREADSHEET_ID\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  }
  die('SPREADSHEET_ID not set and not found in api/wrangler.toml');
}

const SPREADSHEET_ID = spreadsheetId();

// === Google auth ===

function signJwt(sa) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc(header)}.${enc(claim)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key).toString('base64url');
  return `${input}.${sig}`;
}

async function getAccessToken(sa) {
  const jwt = signJwt(sa);
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!res.ok) die(`token exchange ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// === Sheets helpers ===

let TOKEN;
const api = (p) => `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${p}`;

async function sheetsClear(range) {
  const res = await fetch(api(`/values/${encodeURIComponent(range)}:clear`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) die(`clear ${range} ${res.status}: ${await res.text()}`);
}

async function sheetsBatchUpdate(data) {
  const res = await fetch(api('/values:batchUpdate'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
  if (!res.ok) die(`batchUpdate ${res.status}: ${await res.text()}`);
}

// === Source parsing ===

const bangkokFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
});
function bangkokDateOf(iso) {
  const parts = Object.fromEntries(bangkokFmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function genId() { return `ev_${crypto.randomUUID().slice(0, 12)}`; }

function readJSON(name) {
  const p = path.join(SOURCE_DIR, name);
  if (!fs.existsSync(p)) die(`missing ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Parse one markdown archive into expense events (THB, account = THB_ACCOUNT).
// Walks `## DD.MM.YYYY` sections and 2-col `| desc | amount |` tables, skipping
// the header / separator / **Итого** total rows.
function parseMarkdown(content) {
  const lines = content.split('\n');
  const out = [];
  let date = null;
  for (const line of lines) {
    const t = line.trim();
    const h = t.match(/^## (\d{2})\.(\d{2})\.(\d{4})/);
    if (h) { date = `${h[3]}-${h[2]}-${h[1]}`; continue; }
    if (!date || !t.startsWith('|')) continue;
    if (/^\|\s*Что\s*\|/i.test(t)) continue;
    if (/^\|\s*-+/.test(t) || /^\|---/.test(t)) continue;
    if (/^\|\s*\*\*Итого/.test(t)) continue;
    const m = t.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (!m) continue;
    const desc = m[1].replace(/\\\|/g, '|').trim();
    const amount = parseInt(m[2].replace(/[\s*]/g, ''), 10);
    if (!isFinite(amount) || amount <= 0) continue;
    out.push({
      id: genId(), type: 'expense', from: THB_ACCOUNT, to: null,
      amount, amount_to: null, note: desc,
      at: `${date}T12:00:00+07:00`, client_id: null,
    });
  }
  return out;
}

function collectMarkdownEvents(jsonEvents) {
  const archiveDir = path.join(SOURCE_DIR, 'archive');
  if (!fs.existsSync(archiveDir)) return [];
  // Days already represented as expense events in events.json — trust those,
  // skip the markdown copy to avoid double-counting overlapping days.
  const jsonExpenseDays = new Set(
    jsonEvents.filter((e) => e.type === 'expense' && e.at).map((e) => bangkokDateOf(e.at)),
  );
  const events = [];
  let skipped = 0;
  for (const f of fs.readdirSync(archiveDir)) {
    if (!f.endsWith('.md')) continue;
    const parsed = parseMarkdown(fs.readFileSync(path.join(archiveDir, f), 'utf8'));
    for (const ev of parsed) {
      const day = bangkokDateOf(ev.at);
      if (jsonExpenseDays.has(day)) { skipped++; continue; }
      events.push(ev);
    }
  }
  if (skipped) console.log(`  (skipped ${skipped} markdown rows on days already in events.json)`);
  return events;
}

// === Main ===

(async () => {
  console.log(`Spreadsheet:     ${SPREADSHEET_ID}`);
  console.log(`Source dir:      ${SOURCE_DIR}`);

  const balances = readJSON('balances.json');
  const eventsFile = readJSON('events.json');
  const jsonEvents = Array.isArray(eventsFile.events) ? eventsFile.events : [];

  const mdEvents = collectMarkdownEvents(jsonEvents);

  // Normalize json events to the full column shape, then merge + sort by `at`.
  const normalized = jsonEvents.map((e) => ({
    id: e.id || genId(),
    type: e.type,
    from: e.from ?? null,
    to: e.to ?? null,
    amount: e.amount,
    amount_to: e.amount_to ?? null,
    note: e.note ?? null,
    at: e.at,
    client_id: e.client_id ?? null,
  }));

  const allEvents = [...normalized, ...mdEvents].sort((a, b) => new Date(a.at) - new Date(b.at));

  console.log(`\nEvents:   ${jsonEvents.length} from events.json + ${mdEvents.length} from markdown = ${allEvents.length} total`);
  console.log(`Balances: ${balances.accounts.length} accounts (updated_at ${balances.updated_at})`);

  if (process.env.DRY_RUN) {
    console.log('\n--- DRY_RUN: первые/последние 3 события (запись пропущена) ---');
    const preview = (e) => `  ${e.at}  ${e.type.padEnd(8)} ${(e.from || '·')}→${(e.to || '·')}  ${e.amount}${e.note ? `  «${e.note}»` : ''}`;
    allEvents.slice(0, 3).forEach((e) => console.log(preview(e)));
    console.log('  …');
    allEvents.slice(-3).forEach((e) => console.log(preview(e)));
    console.log('\n✓ DRY_RUN ok (ничего не записано).');
    return;
  }

  const sa = JSON.parse(fs.readFileSync(SA_KEY, 'utf8'));
  console.log(`\nService account: ${sa.client_email}`);
  TOKEN = await getAccessToken(sa);

  // --- Balances sheet ---
  await sheetsClear(`${BALANCES_SHEET}!A:Z`);
  const balanceRows = [
    ['id', 'name', 'amount', 'currency'],
    ...balances.accounts.map((a) => [a.id, a.name, a.amount, a.currency]),
  ];
  await sheetsBatchUpdate([
    { range: `${BALANCES_SHEET}!A1`, values: balanceRows },
    { range: `${BALANCES_SHEET}!E1`, values: [['Обновлено', balances.updated_at || new Date().toISOString()]] },
  ]);
  console.log(`✓ Balances written (${balances.accounts.length} accounts)`);

  // --- Events sheet ---
  await sheetsClear(`${EVENTS_SHEET}!A:Z`);
  const eventRows = [
    EVENT_COLS.slice(),
    ...allEvents.map((ev) => EVENT_COLS.map((c) => (ev[c] == null ? '' : ev[c]))),
  ];
  await sheetsBatchUpdate([{ range: `${EVENTS_SHEET}!A1`, values: eventRows }]);
  console.log(`✓ Events written (${allEvents.length} rows)`);

  console.log('\n✓ Migration complete.');
})().catch((e) => die(e.stack || e.message));
