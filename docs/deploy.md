# Deploy & install

Step-by-step guide to spin up this project on a fresh Cloudflare account with a Google Sheets backend.

**Time:** ~30–45 minutes.

---

## Architecture

```
[Browser / web app] ──HTTPS──> [Cloudflare]
                              │
   ┌──────────────────────────┴────────────────────────────┐
   │ <your-domain>  (single domain)                        │
   ├───────────────────────────────────────────────────────┤
   │ /, /balances, /events, /expenses, /icon.svg, ...      │
   │   → Cloudflare Pages (web app static assets from web/)│
   │                                                       │
   │ /api/*                                                │
   │   → the API (api/src/index.js)                        │
   │     └─ Google Sheets API → your spreadsheet           │
   │          ├── Events   (append-only log)               │
   │          └── Balances (per-account balances)          │
   └───────────────────────────────────────────────────────┘
```

The web app and API share a single domain (same-origin). The web app fetches relative paths `/api/...` — no CORS, no «API URL» field in settings; only a Bearer token. The API authenticates to Google with a service-account JWT (RS256, signed via WebCrypto) exchanged for an OAuth access token, cached per-isolate.

---

## Step 0. Prerequisites

- A **Cloudflare account** (free tier is enough).
- A domain you own, with DNS managed by Cloudflare. Free `*.workers.dev` won't work for the single-domain setup; you need a real domain to attach both Pages and the Workers Route to.
- A **Google account** and a **Google Cloud project** (free).
- `npm` / `npx` available locally (for `wrangler`), plus Node 18+ if you want to run the migration script.

---

## Step 1. Google service account + spreadsheet

1. **Google Cloud Console** → your project → **APIs & Services → Library** → enable **Google Sheets API**.
2. **APIs & Services → Credentials → Create credentials → Service account.** Name it anything (`<project>-sheets`). No roles needed.
3. Open the service account → **Keys → Add key → Create new key → JSON.** A `*.json` file downloads — this is your `GOOGLE_SA_JSON`. Keep it private (it's a credential).
4. Note the service account's **email** (looks like `name@project-id.iam.gserviceaccount.com`) — it's the `client_email` field inside the JSON.
5. Create a **Google spreadsheet** with two tabs named exactly **`Events`** and **`Balances`**.
6. **Share** the spreadsheet with the service-account email as **Editor**. (Without this the API returns 403.)
7. Grab the spreadsheet id from its URL: `docs.google.com/spreadsheets/d/`**`<THIS>`**`/edit`.

> The API writes headers/rows on first use, but it's simplest to seed the tabs with the migration script (Step 3b) or by hand:
> - `Balances` row 1: `id | name | amount | currency`; cell `E1` = `Обновлено` (label), `F1` = an ISO timestamp; then one row per account.
> - `Events` row 1: `id | type | from | to | amount | amount_to | note | at | client_id`.

---

## Step 2. APP_TOKEN (Bearer for web app → API)

```bash
openssl rand -base64 32
```

Save it — it goes into API secrets AND the web app's localStorage.

---

## Step 3. Configure & deploy API

```bash
cd api
cp wrangler.example.toml wrangler.toml
```

Edit `wrangler.toml`:
- `[[routes]].pattern` → `<your-domain>/api/*`
- `[[routes]].zone_name` → root zone (e.g. `example.com` for `app.example.com/api/*`)
- `[vars].SPREADSHEET_ID` → your spreadsheet id from Step 1
- `[vars].DEFAULT_ACCOUNT_USDT` / `_RUB` / `_THB` → the `id` values of your accounts in the `Balances` tab

Then:

```bash
npx wrangler@latest login                       # auth Cloudflare
npx wrangler@latest secret put GOOGLE_SA_JSON   # paste the FULL service-account JSON from Step 1
npx wrangler@latest secret put APP_TOKEN        # paste token from Step 2
npx wrangler@latest deploy
```

> Pasting `GOOGLE_SA_JSON`: it's a multi-line JSON. `wrangler secret put` reads stdin — paste the whole file content (or `cat key.json | npx wrangler@latest secret put GOOGLE_SA_JSON`).

### Step 3b. (Optional) Migrate existing data

If you're coming from the older JSON/markdown storage, import it into the spreadsheet:

```bash
# from the project root; SOURCE_DIR = local clone of the old data repo
SOURCE_DIR=/path/to/old-data DRY_RUN=1 node scripts/migrate-to-sheets.mjs   # preview, writes nothing
SOURCE_DIR=/path/to/old-data node scripts/migrate-to-sheets.mjs             # clears + rewrites both tabs
```

The script reads the service-account key from `api/google-service-account.json` (override with `SA_KEY=`) and the spreadsheet id from `api/wrangler.toml` (override with `SPREADSHEET_ID=`). It's re-runnable.

### Smoke-test the API

```bash
DOMAIN="your-domain.example.com"
TOKEN="<your APP_TOKEN>"

# GET balances
curl "https://$DOMAIN/api/balances" -H "Authorization: Bearer $TOKEN"

# Quick-expense (main web app screen)
curl -X POST "https://$DOMAIN/api/expense" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"coffee 350"}'

# Quick-expense with a currency token (routes to DEFAULT_ACCOUNT_USDT)
curl -X POST "https://$DOMAIN/api/expense" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"test 5 usdt"}'

# GET day (expenses for a specific day in Bangkok TZ)
curl "https://$DOMAIN/api/day?date=2026-05-08" -H "Authorization: Bearer $TOKEN"

# POST event (structured: income/expense/transfer/exchange)
curl -X POST "https://$DOMAIN/api/event" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"income","to":"<account-id>","amount":1000,"note":"salary"}'

# DELETE last event (undo)
curl -X DELETE "https://$DOMAIN/api/event/last" -H "Authorization: Bearer $TOKEN"
```

All `POST`s return `{ok:true, event:{...}, balances:{...}}`. The event is appended to the `Events` tab and the matching account `amount` is updated on the `Balances` tab.

---

## Step 4. Deploy web app to Cloudflare Pages

```bash
cd ..   # back to project root
npx wrangler@latest pages deploy web --project-name=<your-pages-project-name>
```

**Important:** run from the project root, not from `web/`. Wrangler otherwise misses assets.

Wrangler prints a `<hash>.<project>.pages.dev` URL. Attach your custom domain to the Pages project in Cloudflare Dashboard → Workers & Pages → your Pages project → Custom domains → Set up a custom domain → enter `<your-domain>`.

---

## Step 5. Open web app & configure

Open `https://<your-domain>/` in a browser. On first load the **Settings** panel pops up with a single field:

- **Bearer token** — paste the `APP_TOKEN` from Step 2 → Save.

That's it — no "API URL" field, the web app fetches `/api/...` on the same origin.

### Add to Home Screen (mobile)

- **Android Chrome:** menu (⋮) → *Add to Home screen*.
- **iPhone Safari:** Share (□↑) → *Add to Home Screen*.

### First real test

1. Type `test 50` → green `✓ test 50`.
2. Type `test-usdt 5 usdt` → should route to your USDT account (not the THB default).
3. Open your spreadsheet → the `Events` tab has new rows, `Balances` amounts updated.

---

## End-to-end checklist

- [ ] Spreadsheet shared with the service-account email as Editor
- [ ] `curl` quick-expense with a plain number → new row in the `Events` tab
- [ ] `curl` quick-expense with `usdt` token → routes to your USDT account, not THB default
- [ ] web app opens on `<your-domain>`, Settings has only a token field
- [ ] Recording from web app → row appears in the spreadsheet
- [ ] Undo (`DELETE /api/event/last`) → last row removed, balance reverted

---

## Troubleshooting

**API returns 401 Unauthorized.** `APP_TOKEN` in the API secret doesn't match what's in web app `localStorage`. Re-paste in Settings, or `wrangler secret put APP_TOKEN`.

**API returns 404 on `/api/...`.** The Workers Route isn't configured, or the API isn't deployed to the right zone. Cloudflare Dashboard → Workers → your API → Settings → Domains & Routes — should show `Route: <your-domain>/api/*`. If absent, `cd api && wrangler deploy`.

**Pages returns HTML on `/api/balances` instead of JSON.** The Workers Route isn't matching, or hit Pages first. Workers Routes have priority over Pages by design — verify the pattern is exactly `<your-domain>/api/*` (not `/api*` or `api.<your-domain>/*`), and the zone is correct.

**API 502 `sheets: ... 403`.** The spreadsheet isn't shared with the service-account email, or the Sheets API isn't enabled on the project. Re-check Step 1.6 and 1.1.

**API 502 `sheets: ... 400` / `Unable to parse range`.** Tab names don't match. They must be exactly `Events` and `Balances` (case-sensitive).

**API 502 `sheets: token exchange ...`.** `GOOGLE_SA_JSON` is malformed, truncated, or the key was revoked. Re-paste the full JSON: `wrangler secret put GOOGLE_SA_JSON`.

**web app didn't update after deploy.** Service Worker is caching. Close-reopen web app, or DevTools → Application → Clear storage. Cache version is the `CACHE` constant in `web/sw.js` — bump it on significant changes.

**web app won't install on iPhone.** Safari needs HTTPS (Pages provides it) and a `manifest.json` (present). If "Add to Home Screen" doesn't appear — update Safari, open in actual Safari (not an in-app browser).

**API compute exhausted.** Cloudflare Workers free tier is 100k requests/day. A typical use profile (a few dozen recordings/day) won't come close.

---

## What's intentionally NOT in MVP

- **Auto FX.** Reconciliation done in the spreadsheet (or in a Claude session over exported data).
- **Categories.** Free-text `note`; categorize later.
- **In-web app chat with Claude.** Requires a paid Anthropic API key — use Claude Code locally instead.
- **Multiple users.** Single Bearer token, single spreadsheet. If you need multi-user, that's a different project.

---

## What's in `api/test-smoke.mjs`

Unit tests for pure logic (no fetch / no Sheets calls): `parseExpense`, `bangkokContext` / `bangkokDateOf`, the `rowToEvent`↔`eventToRow` round-trip, `validateEvent`, and `applyMutation` / `reverseMutation`. Run with:

```bash
cd api && node test-smoke.mjs
```

The functions are inline copies of the pure logic in `src/index.js` — keep them in sync when the source changes.
