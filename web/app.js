const QUEUE_KEY = 'expenseQueue';
const TOKEN_KEY = 'appToken';

const $ = (id) => document.getElementById(id);

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const tokenInput = $('token');
tokenInput.value = localStorage.getItem(TOKEN_KEY) || '';

const overlay = $('overlay');
const openSettings = () => overlay.classList.add('open');
const closeSettings = () => overlay.classList.remove('open');

AppConfig.populateSelect($('tz-select'));
$('gear').addEventListener('click', () => { AppConfig.populateSelect($('tz-select')); openSettings(); });
$('close').addEventListener('click', closeSettings);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

$('save-config').addEventListener('click', async () => {
  localStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
  await AppConfig.saveTimezone($('tz-select').value);
  setStatus('Настройки сохранены', 'ok');
  closeSettings();
  flush();
});

if (!localStorage.getItem(TOKEN_KEY)) {
  openSettings();
  setStatus('Заполни токен в настройках', 'err');
}

$('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;

  if (!localStorage.getItem(TOKEN_KEY)) {
    setStatus('нет токена', 'err');
    openSettings();
    return;
  }

  $('text').value = '';
  setStatus(`✓ ${text}`, 'ok');
  enqueue(text);
  updateQueueInfo();
  flush();
});

async function tryPost(item) {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return { ok: false, error: 'нет токена' };

  try {
    const res = await fetch('/api/expense', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // Send the capture time (queuedAt), not the flush time — a delayed flush
      // (offline / missing token / 5xx) must still date the expense to when it
      // was typed, otherwise old queued items resurface on the day they finally
      // send. Fall back to now for items queued before this field existed.
      body: JSON.stringify({ text: item.text, now: item.queuedAt || new Date().toISOString(), client_id: item.client_id }),
    });
    if (res.ok) return { ok: true };
    let detail = '';
    try { const j = await res.json(); detail = j.error || ''; } catch {}
    return { ok: false, error: `${res.status} ${detail}`, status: res.status };
  } catch {
    return { ok: false, networkError: true };
  }
}

function genClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function enqueue(text) {
  const q = getQueue();
  q.push({ text, queuedAt: new Date().toISOString(), client_id: genClientId() });
  setQueue(q);
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    let q = getQueue();
    if (q.length === 0) return;
    let droppedCount = 0;
    while (q.length > 0) {
      const item = q[0];
      // Backfill client_id for items queued before this build — keeps idempotency
      // working on the first post-upgrade flush.
      if (!item.client_id) { item.client_id = genClientId(); setQueue(q); }
      const result = await tryPost(item);
      if (result.ok) {
        q.shift();
        setQueue(q);
      } else if (result.status && result.status >= 400 && result.status < 500) {
        q.shift();
        setQueue(q);
        droppedCount++;
      } else {
        break;
      }
    }
    if (droppedCount > 0) {
      setStatus(`⚠ выброшено из очереди (ошибки): ${droppedCount}`, 'err');
    }
  } finally {
    flushing = false;
    updateQueueInfo();
  }
}

function updateQueueInfo() {
  const q = getQueue();
  const el = $('queue-info');
  el.textContent = q.length ? `В очереди: ${q.length} (нажми чтобы очистить)` : '';
  el.style.cursor = q.length ? 'pointer' : 'default';
}

$('queue-info').addEventListener('click', () => {
  const q = getQueue();
  if (q.length === 0) return;
  if (confirm(`Очистить очередь (${q.length})?`)) {
    setQueue([]);
    setStatus('очередь очищена', 'ok');
    updateQueueInfo();
  }
});

updateQueueInfo();
window.addEventListener('online', flush);
window.addEventListener('focus', flush);
window.addEventListener('pageshow', flush);
setInterval(flush, 30_000);
flush();
