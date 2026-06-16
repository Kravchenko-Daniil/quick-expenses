# Changelog

История изменений по сессиям. Свежие записи сверху.

---

## 2026-06-05 — Миграция стораджа на Google Sheets

Единое онлайн-хранилище вместо приватного GitHub-репо. Теперь данные — Google-таблица с двумя листами (`Events` + `Balances`), которую можно смотреть и править напрямую с любого устройства.

### Worker (`api/src/index.js`) — полностью переписан storage-слой
- GitHub Contents/Trees API → **Google Sheets API**. Аутентификация: JWT сервис-аккаунта (RS256 через WebCrypto) → OAuth access token, кэш токена в isolate (`getAccessToken`).
- `GET /api/balances` — читает лист `Balances`. `GET /api/day` — фильтрует expense-события из листа `Events` (markdown больше не читается). `POST /api/expense|event` — append в `Events` + мутация колонки amount в `Balances`. `DELETE /api/event/last` — реверс баланса + `deleteDimension` последней строки `Events`.
- Контракт ответов для PWA сохранён байт-в-байт (`{updated_at, accounts}`, `{event, balances}`, `{expenses, totals}`).
- Нет кросс-табличной атомарности (у Sheets нет транзакции между листами) — append/mutate последовательны; для одного пользователя окно гонки ничтожно, дрейф восстановим из лога. Идемпотентность по `client_id` сохранена (поиск в последних 200 строках `Events`).

### Конфиг
- `wrangler.toml`: убраны `REPO`/`BRANCH`/`GITHUB_TOKEN`; добавлены `SPREADSHEET_ID` (var) и `GOOGLE_SA_JSON` (secret).
- Ключ сервис-аккаунта — `api/google-service-account.json` (gitignored).

### Миграция
- `scripts/migrate-to-sheets.mjs` — одноразовый импорт `balances.json` + `events.json` + markdown-архива в таблицу. Dependency-free Node, JWT через `node:crypto`, `DRY_RUN=1` для превью. Прогон: 77 событий из лога + 104 из markdown (8 дублей по дням отброшены) = 181 событие, 5 счетов.

### Тесты
- `api/test-smoke.mjs` переписан: убраны markdown-тесты (`insertExpense`/`parseDay`), добавлены `bangkokDateOf` и round-trip `rowToEvent`↔`eventToRow`. 60/60 зелёные.

### Retired
- Приватный data-репо `my-finance`, WSL cron (`sync/pull.sh`) и SessionStart hook заморожены как бэкап — в рантайме Sheets-трекера не участвуют.

---

## 2026-05-03 — UX-полировка PWA (SW v6)

### Поле токена в настройках — скрыто точками
- `web/index.html:164` — `input#token` с `type="text"` → `type="password"`. Браузер маскирует значение, стиль уже покрывает `input[type="password"]` (строка 38).

### Очередь больше не зависает на 4xx, и её можно очистить вручную
- `web/app.js` — `tryPost` теперь возвращает `status` HTTP-ответа.
- `web/app.js` — в `flush()` добавлен ветка: при ответе `4xx` item выкидывается из очереди (4xx — это про сам item, ретраить бесполезно — иначе очередь блокируется навсегда). По итогам `flush` показывается отдельный статус `⚠ выброшено из очереди (ошибки): N`.
- `web/app.js` — у `#queue-info` появился click-handler: тап → `confirm("Очистить очередь (N)?")` → `setQueue([])`. Текст изменён на `В очереди: N (нажми чтобы очистить)`, курсор `pointer` когда есть что чистить.
- **Почему:** записал `test 0` офлайном — попало в очередь, парсер Worker'а вернул `400 error value`, и любой следующий flush ронялся на этом же item. Теперь самоисцеляется + есть аварийный выход.

### Tiffany Blue для primary-кнопок
- `web/index.html` — `#4a90e2` → `#0abab5` в трёх местах: `button` (фон), `input:focus` (border), `#panel button.action` (фон). Текст на кнопках стал `#0a0a0a` (тёмный) для контраста на бирюзе вместо белого.

### Service Worker
- `web/sw.js:1` — `CACHE` поднят `v4` → `v5` → `v6`, чтобы старые HTML/JS из кэша инвалидировались на устройствах.

### Деплой
- Финальный URL после трёх деплоев: `https://014b6d7f.my-finance-pwa.pages.dev` (alias `my-finance-pwa.pages.dev` указывает на актуальный production).
- Worker не трогали — изменений в `api/` нет.
