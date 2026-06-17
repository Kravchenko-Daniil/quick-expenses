# Changelog

История изменений по сессиям. Свежие записи сверху.

---

## 2026-06-17 — `log_only`: события без движения баланса ⏳ (рабочее дерево, НЕ задеплоено)

Флаг `log_only:true` на `POST /api/event` / `PATCH /api/event/:id`: событие пишется в лог, но баланс **не двигает**. Нужен будущему аггрегатору — счёт, чей баланс зеркалится через `POST /api/snapshot`, нельзя ещё и мутировать операциями (двойной счёт), но операции хочется видеть в логе для аналитики/сторожа.

- `api/src/index.js`: `EVENT_COLS` + `log_only` (скрытая колонка `Events!K`); `rowToEvent`/`eventToRow` (true→boolean `TRUE`, false→пустая ячейка); диапазоны чтения/записи `A:J`→`A:K`; `createEvent` (log_only → только append, без мутации); **условный ребаланс** в `patchEventById` (`reverse(old)` если `!old.log_only`, `apply(new)` если `!new.log_only`; матрица 4 комбо); `deleteEventById`/`handleEventDelete` (log_only → без реверса).
- `api/test-smoke.mjs`: inline-копии в синхроне, **94/0** (+10 тестов).
- `scripts/migrate-schema-v3-logonly.mjs` (новый, re-runnable, `DRY_RUN=1`): пишет `K1='log_only'`, скрывает колонку K. **Против живого листа не запускался.**
- **Статус:** в рабочем дереве, не закоммичено, не задеплоено. Известный gap: код **не** enforce'ит, что зеркалимый счёт получает только `log_only`-операции — пока на дисциплине поллера.

---

## 2026-06-16 — Авто-балансы, конфиг-эндпойнты, CRUD-по-id, реструктуризация ⏳ (закоммичено `8d82bb6`/`2dd0953`, НЕ задеплоено)

Большой батч API-фич под будущий аггрегатор + наведение порядка. **Прод всё ещё на коде 2026-06-05** — этот батч ждёт общего деплоя (ШАГ 0).

### API (`api/src/index.js`)
- **`POST /api/snapshot`** — пишет балансы счетов снимком (SET, не дельта; «сигнал 1» аггрегатора). Зеркалит перечисленные счета из источника, **лог не трогает**, all-or-nothing валидация. Чистая логика `applySnapshot`.
- **`GET` / `PUT /api/config`** — timezone вынесен в **Cloudflare KV** (биндинг `CONFIG`, ключ `timezone`), меняется с сайта без редеплоя. Функции времени параметризованы зоной (`readTimezone`/`zoneContext`/`dateInZone`/`formatWhen`).
- **`PATCH /api/event/:id`** / **`DELETE /api/event/:id`** — правка/удаление **любого** события по id (условный пересчёт балансов), не только последнего.
- **`GET /api/events`** — весь лог (опц. `?type=`/`?limit=`) для reconciliation из Claude Code.
- **Лист `Settings`** (третий лист) — `primary_account`/`primary_currency` читаются из таблицы (`readSettings`); env `PRIMARY_ACCOUNT`/`PRIMARY_CURRENCY` — фолбэк.
- Дедуп `client_id` расширен с «последних 200 строк» до **всего лога** (стабильный source-id для backfill аггрегатора).
- Парсер: добавлены валютные токены `thb | бат | baht | vnd | донг` к `usdt | rub | руб`.

### Структура (`8d82bb6`, `2dd0953`)
- Создана gitignored `dev/` (`raw`/`notes`/`work`) под закулисье (реальные балансы, дизайн аггрегатора). Удалены `sync/`/`hooks/` эпохи GitHub-стораджа. Из текста доков убраны «pwa»/«worker» → «web app»/«API».

---

## 2026-06-05 — Схема таблицы v2: человекочитаемый вид ✅ (задеплоено, `9b2760f`)

Переезд схемы под человеческий вид. Заголовки английские БОЛЬШИЕ; единственная русская колонка — `Note`.
- **Счета**: `card_t`→`tbank_debit`, `card_vtb`→`vtb_debit`; `DEFAULT_ACCOUNT_RUB`→`tbank_debit`.
- **Events**: колонки `When | Type | From | To | Amount | Received | Note` (+ скрытые `id`/`at`/`client_id`). `When` — деривированная display-дата (`formatWhen`): только дата для backdate-плейсхолдера (полдень), иначе дата+время.
- **Balances**: строка `Updated` сверху, таблица счетов ищется **сканом заголовка `id`** (колонка id скрыта), блок `Totals` (SUMIF на валюту) ниже. `readBalances` отдаёт `dataStartRow` писателю.
- Операторские скрипты (общий `scripts/_lib.mjs`): `backup`, `migrate-schema-v2`, `verify`, переписанный `format`. Тесты 63/63.

---

## 2026-06-05 — Миграция стораджа на Google Sheets

Единое онлайн-хранилище вместо приватного GitHub-репо. Теперь данные — Google-таблица с двумя листами (`Events` + `Balances`), которую можно смотреть и править напрямую с любого устройства.

### API (`api/src/index.js`) — полностью переписан storage-слой
- GitHub Contents/Trees API → **Google Sheets API**. Аутентификация: JWT сервис-аккаунта (RS256 через WebCrypto) → OAuth access token, кэш токена в isolate (`getAccessToken`).
- `GET /api/balances` — читает лист `Balances`. `GET /api/day` — фильтрует expense-события из листа `Events` (markdown больше не читается). `POST /api/expense|event` — append в `Events` + мутация колонки amount в `Balances`. `DELETE /api/event/last` — реверс баланса + `deleteDimension` последней строки `Events`.
- Контракт ответов для сайта сохранён байт-в-байт (`{updated_at, accounts}`, `{event, balances}`, `{expenses, totals}`).
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

## 2026-05-03 — UX-полировка сайта (SW v6)

### Поле токена в настройках — скрыто точками
- `web/index.html:164` — `input#token` с `type="text"` → `type="password"`. Браузер маскирует значение, стиль уже покрывает `input[type="password"]` (строка 38).

### Очередь больше не зависает на 4xx, и её можно очистить вручную
- `web/app.js` — `tryPost` теперь возвращает `status` HTTP-ответа.
- `web/app.js` — в `flush()` добавлен ветка: при ответе `4xx` item выкидывается из очереди (4xx — это про сам item, ретраить бесполезно — иначе очередь блокируется навсегда). По итогам `flush` показывается отдельный статус `⚠ выброшено из очереди (ошибки): N`.
- `web/app.js` — у `#queue-info` появился click-handler: тап → `confirm("Очистить очередь (N)?")` → `setQueue([])`. Текст изменён на `В очереди: N (нажми чтобы очистить)`, курсор `pointer` когда есть что чистить.
- **Почему:** записал `test 0` офлайном — попало в очередь, парсер API вернул `400 error value`, и любой следующий flush ронялся на этом же item. Теперь самоисцеляется + есть аварийный выход.

### Tiffany Blue для primary-кнопок
- `web/index.html` — `#4a90e2` → `#0abab5` в трёх местах: `button` (фон), `input:focus` (border), `#panel button.action` (фон). Текст на кнопках стал `#0a0a0a` (тёмный) для контраста на бирюзе вместо белого.

### Service Worker
- `web/sw.js:1` — `CACHE` поднят `v4` → `v5` → `v6`, чтобы старые HTML/JS из кэша инвалидировались на устройствах.

### Деплой
- Финальный URL после трёх деплоев: `https://014b6d7f.my-finance-pwa.pages.dev` (alias `my-finance-pwa.pages.dev` указывает на актуальный production).
- API не трогали — изменений в `api/` нет.
