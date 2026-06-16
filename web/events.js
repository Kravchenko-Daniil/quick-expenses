const TOKEN_KEY = 'appToken';
const BAL_CACHE_KEY = 'cache:balances';

const $ = (id) => document.getElementById(id);

// "Today" and the backdate instant come from AppConfig (config.js), whose zone is
// the single source of truth (server KV, GET/PUT /api/config).
const todayLocal = () => AppConfig.today();

function readBalCache() {
  try { return JSON.parse(localStorage.getItem(BAL_CACHE_KEY) || 'null'); } catch { return null; }
}
function writeBalCache(data) {
  try { localStorage.setItem(BAL_CACHE_KEY, JSON.stringify(data)); } catch {}
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const CURRENCY_DISPLAY = { THB: '฿', USDT: 'USDT', RUB: '₽', VND: '₫' };

const state = {
  type: 'income',
  from: null,
  to: null,
  amount: '',
  fromAmount: '',
  note: '',
  accounts: [],
  loaded: false,
  pendingUndoEventId: null,
};

let toastTimer = null;

function fmt(n) {
  const isInt = Math.abs(n % 1) < 0.005;
  const s = isInt ? Math.round(n).toString() : (Math.round(n * 100) / 100).toFixed(2);
  const [intPart, decPart] = s.split('.');
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return decPart !== undefined ? `${intFmt}.${decPart}` : intFmt;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${getToken()}`, ...extra };
}

async function loadBalances() {
  if (!getToken()) {
    setStatus('заполни токен', 'err');
    overlay.classList.add('open');
    return;
  }

  const cached = readBalCache();
  if (cached && Array.isArray(cached.accounts)) {
    state.accounts = cached.accounts;
    state.loaded = true;
    renderAccounts();
    setStatus('');
  }

  try {
    const res = await fetch('/api/balances', { headers: authHeaders() });
    if (!res.ok) {
      if (!cached) setStatus(`ошибка ${res.status}`, 'err');
      return;
    }
    const data = await res.json();
    AppConfig.cacheFrom(data); // keep the local zone in sync with the server
    writeBalCache(data);
    state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    state.loaded = true;
    renderAccounts();
    setStatus('');
  } catch {
    if (!cached) setStatus('нет соединения', 'err');
  }
}

function findAcc(id) { return state.accounts.find((a) => a.id === id); }

function renderAccounts() {
  $('from-block').hidden = state.type === 'income';
  $('to-block').hidden = state.type === 'expense';
  $('from-amount-block').hidden = state.type !== 'exchange';
  $('to-label').textContent = 'Куда';

  renderGrid('from-accounts', state.from, (id) => {
    if (state.from === id) { state.from = null; }
    else {
      state.from = id;
      if (state.to === id) state.to = null;
      if (state.type === 'transfer' && state.to) {
        const f = findAcc(id), t = findAcc(state.to);
        if (f && t && f.currency !== t.currency) state.to = null;
      }
    }
    update();
  }, () => false);

  renderGrid('to-accounts', state.to, (id) => {
    if (state.to === id) { state.to = null; }
    else { state.to = id; }
    update();
  }, (acc) => {
    if (state.from && acc.id === state.from) return true;
    if (state.type === 'transfer' && state.from) {
      const f = findAcc(state.from);
      if (f && f.currency !== acc.currency) return true;
    }
    return false;
  });
}

function renderGrid(elId, selectedId, onTap, isDisabled) {
  const el = $(elId);
  el.innerHTML = '';
  for (const acc of state.accounts) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'acc';
    if (selectedId === acc.id) card.classList.add('active');
    if (isDisabled(acc)) card.classList.add('disabled');
    const cur = CURRENCY_DISPLAY[acc.currency] || acc.currency || '';
    card.innerHTML = `<span class="name">${escapeHtml(acc.name)}</span><span class="bal">${fmt(acc.amount || 0)} ${escapeHtml(cur)}</span>`;
    card.addEventListener('click', () => {
      if (card.classList.contains('disabled')) return;
      onTap(acc.id);
    });
    el.appendChild(card);
  }
}

function update() {
  const toAcc = state.to ? findAcc(state.to) : null;
  const fromAcc = state.from ? findAcc(state.from) : null;
  const cur = (acc) => acc ? (CURRENCY_DISPLAY[acc.currency] || acc.currency) : '';
  if (state.type === 'exchange') {
    $('from-unit').textContent = cur(fromAcc);
    $('unit').textContent = cur(toAcc);
  } else if (state.type === 'transfer') {
    $('unit').textContent = cur(fromAcc) || cur(toAcc);
  } else if (state.type === 'expense') {
    $('unit').textContent = cur(fromAcc);
  } else {
    $('unit').textContent = cur(toAcc);
  }
  renderAccounts();
  validate();
}

function parseAmount(s) {
  const n = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function validate() {
  const amt = parseAmount(state.amount);
  let ok = false;
  if (state.type === 'income') {
    ok = !!state.to && amt !== null;
  } else if (state.type === 'expense') {
    ok = !!state.from && amt !== null;
  } else if (state.type === 'transfer') {
    ok = !!state.from && !!state.to && state.from !== state.to && amt !== null;
  } else if (state.type === 'exchange') {
    const fromAmt = parseAmount(state.fromAmount);
    ok = !!state.from && !!state.to && state.from !== state.to && fromAmt !== null && amt !== null;
  }
  $('submit').disabled = !ok;
  return ok;
}

function setType(type) {
  state.type = type;
  state.from = null;
  state.to = null;
  state.amount = '';
  state.fromAmount = '';
  $('amount').value = '';
  $('from-amount').value = '';
  document.querySelectorAll('.seg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  update();
}

async function submit() {
  if (!validate()) return;
  const amt = parseAmount(state.amount);
  const fromAmt = parseAmount(state.fromAmount);
  const note = state.note.trim();

  const payload = { type: state.type, amount: amt };
  if (state.type === 'income') payload.to = state.to;
  if (state.type === 'expense') payload.from = state.from;
  if (state.type === 'transfer') { payload.from = state.from; payload.to = state.to; }
  if (state.type === 'exchange') {
    payload.from = state.from; payload.to = state.to;
    payload.amount = fromAmt;
    payload.amount_to = amt;
  }
  if (note) payload.note = note;
  const at = $('at').value;
  const today = todayLocal();
  if (at && at !== today) payload.at = AppConfig.zonedNoonISO(at);

  $('submit').disabled = true;
  setStatus('отправляю…');

  try {
    const res = await fetch('/api/event', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.error || ''; } catch {}
      setStatus(`ошибка ${res.status} ${detail}`, 'err');
      $('submit').disabled = false;
      return;
    }
    const data = await res.json();
    if (data.balances && Array.isArray(data.balances.accounts)) {
      state.accounts = data.balances.accounts;
      writeBalCache(data.balances);
    }
    state.pendingUndoEventId = data.event?.id || null;
    showToast(describeEventSummary(data.event), { undoable: true });
    state.from = null;
    state.to = null;
    state.amount = '';
    state.fromAmount = '';
    state.note = '';
    $('amount').value = '';
    $('from-amount').value = '';
    $('note').value = '';
    $('at').value = todayLocal();
    update();
    setStatus('');
  } catch {
    setStatus('нет соединения', 'err');
    $('submit').disabled = false;
  }
}

function describeEventSummary(ev) {
  if (!ev) return 'записано';
  const accName = (id) => {
    const a = findAcc(id);
    return a ? a.name : id;
  };
  if (ev.type === 'income') return `+${fmt(ev.amount)} → ${accName(ev.to)}`;
  if (ev.type === 'expense') return `−${fmt(ev.amount)} ${accName(ev.from)}`;
  if (ev.type === 'transfer') return `${accName(ev.from)} → ${accName(ev.to)}: ${fmt(ev.amount)}`;
  if (ev.type === 'exchange') return `${accName(ev.from)} ${fmt(ev.amount)} → ${accName(ev.to)} ${fmt(ev.amount_to)}`;
  return ev.type;
}

function showToast(msg, opts = {}) {
  const toast = $('toast');
  const undoBtn = $('undo');
  toast.querySelector('.msg').textContent = '✓ ' + msg;
  toast.classList.remove('err');
  if (opts.undoable) undoBtn.hidden = false; else undoBtn.hidden = true;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    state.pendingUndoEventId = null;
  }, 5000);
}

function showErrToast(msg) {
  const toast = $('toast');
  toast.querySelector('.msg').textContent = '✗ ' + msg;
  toast.classList.add('err');
  $('undo').hidden = true;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

async function undoLast() {
  if (!state.pendingUndoEventId) return;
  $('undo').disabled = true;
  try {
    const res = await fetch('/api/event/last', {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) {
      showErrToast(`не вышло (${res.status})`);
      return;
    }
    const data = await res.json();
    if (data.balances && Array.isArray(data.balances.accounts)) {
      state.accounts = data.balances.accounts;
      writeBalCache(data.balances);
    }
    state.pendingUndoEventId = null;
    $('toast').classList.remove('show');
    update();
  } catch {
    showErrToast('нет соединения');
  } finally {
    $('undo').disabled = false;
  }
}

document.querySelectorAll('.seg button').forEach((b) => {
  b.addEventListener('click', () => setType(b.dataset.type));
});

$('amount').addEventListener('input', (e) => { state.amount = e.target.value; validate(); });
$('from-amount').addEventListener('input', (e) => { state.fromAmount = e.target.value; validate(); });
$('note').addEventListener('input', (e) => { state.note = e.target.value; });
$('submit').addEventListener('click', submit);
$('undo').addEventListener('click', undoLast);

$('at').value = todayLocal();
$('at').max = todayLocal();

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
  $('at').value = todayLocal();
  $('at').max = todayLocal();
  loadBalances();
});

window.addEventListener('focus', loadBalances);
window.addEventListener('pageshow', loadBalances);
loadBalances();
