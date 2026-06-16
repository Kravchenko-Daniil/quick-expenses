const TOKEN_KEY = 'appToken';
const cacheKey = (date) => `cache:day:${date}`;

const $ = (id) => document.getElementById(id);

function readCache(date) {
  try { return JSON.parse(localStorage.getItem(cacheKey(date)) || 'null'); } catch { return null; }
}
function writeCache(date, data) {
  try { localStorage.setItem(cacheKey(date), JSON.stringify(data)); } catch {}
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const pad2 = (n) => String(n).padStart(2, '0');

// "Today" comes from AppConfig (config.js) — the active zone is the single source
// of truth (server KV, GET/PUT /api/config), kept in sync via cacheFrom() below.
const todayLocal = () => AppConfig.today();

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS_SHORT[dt.getUTCDay()]}, ${d} ${MONTHS_GEN[m - 1]} ${y}`;
}

function fmtAmount(n) {
  const isInt = Math.abs(n % 1) < 0.005;
  const s = isInt ? Math.round(n).toString() : (Math.round(n * 100) / 100).toFixed(2);
  const [intPart, decPart] = s.split('.');
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return decPart !== undefined ? `${intFmt}.${decPart}` : intFmt;
}

const CURRENCY_DISPLAY = { THB: '฿', USDT: 'USDT', RUB: '₽', VND: '₫' };
function curSymbol(c) { return CURRENCY_DISPLAY[c] || c || ''; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const state = {
  date: todayLocal(),
  loading: false,
};

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

function renderHeader() {
  const today = todayLocal();
  const label = $('date-label');
  label.textContent = state.date === today ? `Сегодня · ${fmtDate(state.date)}` : fmtDate(state.date);
  label.classList.toggle('today', state.date === today);
  $('next').disabled = state.date >= today;
}

function renderContent(data) {
  const el = $('content');
  const expenses = data.expenses || [];
  const totals = data.totals || (data.total ? { THB: data.total } : {});
  if (expenses.length === 0) {
    el.innerHTML = '<div class="list"><div class="empty">— нет записей —</div></div>';
    return;
  }
  const rows = expenses.map((e) => {
    const cur = curSymbol(e.currency || 'THB');
    const tag = e.source === 'event' ? '<span class="tag">событие</span>' : '';
    return `
      <div class="row">
        <span class="desc">${escapeHtml(e.description)}${tag}</span>
        <span class="amt">${fmtAmount(e.amount)} ${escapeHtml(cur)}</span>
      </div>
    `;
  }).join('');
  const totalsRows = Object.entries(totals)
    .filter(([, v]) => v > 0)
    .map(([cur, v]) => `
      <div class="row total">
        <span class="desc">Итого ${escapeHtml(cur)}</span>
        <span class="amt">${fmtAmount(v)} ${escapeHtml(curSymbol(cur))}</span>
      </div>
    `).join('');
  el.innerHTML = `
    <div class="list">
      ${rows}
      ${totalsRows}
    </div>
  `;
}

async function load() {
  if (state.loading) return;
  const token = getToken();
  if (!token) {
    setStatus('заполни токен', 'err');
    overlay.classList.add('open');
    return;
  }
  state.loading = true;
  renderHeader();

  const cached = readCache(state.date);
  if (cached) {
    renderContent(cached);
    setStatus('');
  } else {
    setStatus('загрузка…');
  }

  const fetchDate = state.date;
  try {
    const res = await fetch(`/api/day?date=${encodeURIComponent(fetchDate)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (state.date !== fetchDate) return;
    if (!res.ok) {
      if (!cached) {
        let detail = '';
        try { const j = await res.json(); detail = j.error || ''; } catch {}
        setStatus(`ошибка ${res.status} ${detail}`, 'err');
        $('content').innerHTML = '';
      }
      return;
    }
    const data = await res.json();
    AppConfig.cacheFrom(data); // keep the local zone in sync with the server
    renderHeader();
    writeCache(fetchDate, data);
    renderContent(data);
    setStatus('');
  } catch {
    if (!cached) setStatus('нет соединения', 'err');
  } finally {
    state.loading = false;
  }
}

function prev() {
  state.date = addDays(state.date, -1);
  load();
}
function next() {
  if (state.date >= todayLocal()) return;
  state.date = addDays(state.date, 1);
  load();
}

$('prev').addEventListener('click', prev);
$('next').addEventListener('click', next);
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') prev();
  if (e.key === 'ArrowRight') next();
});

const overlay = $('overlay');
$('token').value = localStorage.getItem(TOKEN_KEY) || '';
AppConfig.populateSelect($('tz-select'));
$('gear').addEventListener('click', () => { AppConfig.populateSelect($('tz-select')); overlay.classList.add('open'); });
$('close').addEventListener('click', () => overlay.classList.remove('open'));
overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.classList.remove('open'); });
$('save-config').addEventListener('click', async () => {
  localStorage.setItem(TOKEN_KEY, $('token').value.trim());
  await AppConfig.saveTimezone($('tz-select').value);
  overlay.classList.remove('open');
  if (state.date > todayLocal()) state.date = todayLocal();
  load();
});

window.addEventListener('focus', load);
window.addEventListener('pageshow', load);
load();
