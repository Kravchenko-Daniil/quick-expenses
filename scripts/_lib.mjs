// Shared helpers for the admin scripts (backup / migrate / format / verify).
// Dependency-free: Node 18+ fetch + node:crypto for the service-account JWT.
// These scripts talk to the Sheets API directly with the service-account key —
// they are operator tools, separate from the Worker (which is the live writer).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

export function loadSA(p) {
  const file = p || process.env.SA_KEY || path.join(ROOT, 'api', 'google-service-account.json');
  if (!fs.existsSync(file)) die(`service-account key not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function spreadsheetId() {
  if (process.env.SPREADSHEET_ID) return process.env.SPREADSHEET_ID;
  const toml = path.join(ROOT, 'api', 'wrangler.toml');
  if (fs.existsSync(toml)) {
    const m = fs.readFileSync(toml, 'utf8').match(/^\s*SPREADSHEET_ID\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  }
  die('SPREADSHEET_ID not set and not found in api/wrangler.toml');
}

export async function getToken(sa) {
  const iat = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat, exp: iat + 3600,
  })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key).toString('base64url');
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(input + '.' + sig)}`,
  });
  if (!res.ok) die(`token exchange ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

const base = (id) => `https://sheets.googleapis.com/v4/spreadsheets/${id}`;

export async function getMeta(token, id, fields) {
  const url = `${base(id)}${fields ? `?fields=${encodeURIComponent(fields)}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) die(`spreadsheets.get ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function valuesGet(token, id, range, render = 'UNFORMATTED_VALUE') {
  const url = `${base(id)}/values/${encodeURIComponent(range)}?valueRenderOption=${render}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) die(`values.get ${range} ${res.status}: ${await res.text()}`);
  return (await res.json()).values || [];
}

export async function valuesUpdate(token, id, range, values, inputOption = 'RAW') {
  const url = `${base(id)}/values/${encodeURIComponent(range)}?valueInputOption=${inputOption}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) die(`values.update ${range} ${res.status}: ${await res.text()}`);
}

export async function valuesBatchUpdate(token, id, data, inputOption = 'RAW') {
  const res = await fetch(`${base(id)}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: inputOption, data }),
  });
  if (!res.ok) die(`values.batchUpdate ${res.status}: ${await res.text()}`);
}

export async function valuesClear(token, id, range) {
  const res = await fetch(`${base(id)}/values/${encodeURIComponent(range)}:clear`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) die(`values.clear ${range} ${res.status}: ${await res.text()}`);
}

export async function batchUpdate(token, id, requests) {
  const res = await fetch(`${base(id)}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) die(`batchUpdate ${res.status}: ${await res.text()}`);
  return res.json();
}
