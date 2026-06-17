# quick-expenses

Hot-capture personal expense tracker. web app on the home screen → the API → a **Google Sheets** spreadsheet you own. The point is to log one expense («coffee 350») in ≤5–10 seconds at the moment of purchase — and because the store is a plain spreadsheet, you can look at and edit your data directly from anywhere (phone, desktop), no special tooling.

This repository contains the **code** (API, web app, migration script). The **data** lives in your own Google spreadsheet.

---

## Architecture

```
[Browser / web app] ──HTTPS──> [Cloudflare]
                              │
   ┌──────────────────────────┴───────────────────────────┐
   │ <your-domain>  (single domain)                       │
   ├──────────────────────────────────────────────────────┤
   │ /                       → Cloudflare Pages (web app) │
   │ /api/*                  → the API                    │
   │                            └─ Google Sheets API ─────┼──> [your spreadsheet]
   └──────────────────────────────────────────────────────┘     ├── Events   (append-only log)
                                                                 ├── Balances (per-account balances)
                                                                 └── Settings (primary account / currency)
                                                                        ▲
                                                          you read / edit it by hand
```

Same-origin: the web app fetches relative paths `/api/...` — no CORS, and the user's web app settings only need a Bearer token, never an "API URL". The API authenticates to Google with a **service-account JWT** (RS256, signed inside the API via WebCrypto) exchanged for an OAuth access token.

---

## What's in this repo

| Folder | What |
|---|---|
| `api/` | The API — single-file vanilla JS on Cloudflare Workers. Endpoints: `POST /api/expense` (quick capture), `GET /api/balances`, `GET /api/day`, `GET /api/events`, `POST /api/event`, `PATCH`/`DELETE /api/event/:id`, `DELETE /api/event/last` (undo), `POST /api/snapshot` (mirror balances from an external source), `GET`/`PUT /api/config` (display timezone, stored in Cloudflare KV). Talks to Google Sheets. |
| `web/` | The web app: vanilla HTML/CSS/JS + Service Worker. Four pages: record expense, view balances, structured events, daily log. No build step. |
| `scripts/` | `migrate-to-sheets.mjs` (one-off importer from the older JSON/markdown storage) plus operator scripts (backup, schema migrations, format, verify) sharing `_lib.mjs`. Dependency-free Node. |
| `docs/` | Changelog + the full setup guide (`deploy.md`). |

---

## Data layout (in your spreadsheet)

Three tabs:

- **`Events`** — append-only event log. Columns: `when | type | from | to | amount | amount_to | note | at | client_id` (the `id`, `at` and `client_id` columns are hidden; `when` is a derived human-readable date). Types: `income | expense | transfer | exchange`.
- **`Balances`** — current balance per account. The accounts table is located by scanning column A for an `id` header (the `id` column is hidden — it's the key that `from`/`to` reference); the visible columns are name / amount / currency. An "Updated" line sits on top and a `Totals` block (one `SUMIF` per currency) below. The API mutates only the `amount` column and the timestamp cell.
- **`Settings`** — the primary (everyday) account and currency, used for a quick-expense typed without a currency token. The API reads it at runtime; the `PRIMARY_ACCOUNT` / `PRIMARY_CURRENCY` env vars are the fallback.

Google Sheets has no cross-tab transaction, so the two writes (append event, update balances) are sequential rather than atomic. For a single user the race window is negligible, and balances can always be recomputed from the log. You may hand-edit either tab at any time — the API doesn't assume it's the only writer.

`POST` writes are idempotent on an optional `client_id` (the web app's offline queue may resend) — a repeated id returns the already-committed event instead of double-writing.

---

## Quick-expense parser

The main web app screen takes free text like:

- `coffee 350` → expense 350 in default currency (THB) from default cash account.
- `subscription 26 usdt` → routes to your USDT account, expense 26.
- `подписка 500 руб` → routes to your RUB account.

Rules: the last contiguous number is the amount; everything else is the note. Currency tokens (`usdt | rub | руб | thb | бат | baht | vnd | донг`, case-insensitive) get stripped from the note and route to the corresponding `DEFAULT_ACCOUNT_*` configured in `wrangler.toml`. Exactly one token → that currency's account; zero or two-plus tokens → the primary account. Unicode-aware word boundaries so words like «рубероид» don't false-match `руб`.

The parser is intentionally dumb — no categories, no FX, no autocomplete. Designed for ≤5-second capture, not for analysis.

---

## Why this shape

Most expense trackers fail at the moment of capture: too many fields, too many taps, too much friction. So you either don't record, or record later and forget. This project gives up flexibility at capture time (free-text only, one default account per currency) to win on the only metric that matters — **did you actually log it**.

Reconciliation, categorization, currency conversion, charting — all of that is one spreadsheet away. The data is just rows in your own Google Sheet: open it on any device, edit by hand, or point Claude Code at the exported data. The architecture explicitly preserves your ownership of the data.

---

## Setup

See **[docs/deploy.md](./docs/deploy.md)**. ~30–45 minutes:

1. A Google Cloud **service account** + its JSON key, with the Sheets API enabled
2. Create a spreadsheet with three tabs (`Events`, `Balances`, `Settings`) and **share it with the service-account email** (Editor)
3. Random `APP_TOKEN` for Bearer auth
4. `cp api/wrangler.example.toml api/wrangler.toml`, fill in your domain / spreadsheet id / account ids
5. `wrangler secret put GOOGLE_SA_JSON` and `APP_TOKEN`, then `npx wrangler deploy` for the API
6. `npx wrangler pages deploy web --project-name=...` for the web app, attach the same custom domain
7. Open `https://<your-domain>/`, paste the Bearer token in Settings, done

---

## Status

Used daily by the author. Stable, no active development beyond personal needs. Pull requests welcome but unlikely to be reviewed quickly — fork freely.

---

## License

MIT.
