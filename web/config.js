// Single source of the display timezone for the whole site. The zone itself lives
// server-side (KV behind the Worker, GET/PUT /api/config); this module reads it,
// caches it locally, and derives every "today" / day-of / backdate from it. Change
// it in the settings dropdown → PUT /api/config → every device picks it up on next
// load. No build step: this attaches one global, AppConfig, loaded before each
// page script. Other pages get the live value for free off /api/balances and
// /api/day responses (both echo `timezone`) — see AppConfig.cacheFrom().
window.AppConfig = (function () {
  const TZ_CACHE_KEY = 'cache:timezone';
  const TOKEN_KEY = 'appToken';
  const DEFAULT_TZ = 'Asia/Bangkok';

  // Zones offered in the settings dropdown — Daniil's plausible bases first. Any
  // valid IANA zone the Worker accepts works; this list is just the convenient set.
  const ZONES = [
    'Asia/Bangkok',
    'Asia/Ho_Chi_Minh',
    'Europe/Moscow',
    'Asia/Almaty',
    'Asia/Dubai',
    'Asia/Tbilisi',
    'Asia/Yerevan',
    'UTC',
  ];

  function token() { return localStorage.getItem(TOKEN_KEY) || ''; }

  function tz() {
    return localStorage.getItem(TZ_CACHE_KEY) || DEFAULT_TZ;
  }

  function setCache(zone) {
    if (zone && typeof zone === 'string') {
      try { localStorage.setItem(TZ_CACHE_KEY, zone); } catch {}
    }
  }

  // Pull the zone out of any API response that carries it (/api/balances, /api/day).
  function cacheFrom(data) {
    if (data && typeof data.timezone === 'string') setCache(data.timezone);
    return tz();
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  // YYYY-MM-DD for an instant (default: now) in the active zone.
  function dateOf(iso, zone) {
    const z = zone || tz();
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const d = iso ? new Date(iso) : new Date();
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  function today(zone) { return dateOf(null, zone); }

  // UTC ISO instant whose local time in `zone` is exactly 12:00:00 on YYYY-MM-DD.
  // The Worker treats noon-exact as a date-only backdate placeholder. Computed from
  // the zone's actual offset for that date (works for any zone incl. DST), so there
  // is no hardcoded "+07:00" — change the zone and backdates still land right.
  function zonedNoonISO(dateStr, zone) {
    const z = zone || tz();
    const [y, m, d] = dateStr.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d, 12, 0, 0); // noon treated as if UTC
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: z, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    let hh = parseInt(p.hour, 10); if (hh === 24) hh = 0;
    const seen = Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute, +p.second);
    const offset = seen - guess; // ms the zone is ahead of UTC at that local time
    return new Date(guess - offset).toISOString();
  }

  // Fill a <select> with the zone list and select the active one. Falls back to
  // appending the active zone if it isn't in ZONES (e.g. set elsewhere).
  function populateSelect(sel) {
    if (!sel) return;
    const current = tz();
    const zones = ZONES.includes(current) ? ZONES : [current, ...ZONES];
    sel.innerHTML = '';
    for (const z of zones) {
      const opt = document.createElement('option');
      opt.value = z;
      opt.textContent = z.replace(/_/g, ' ');
      if (z === current) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  // GET /api/config → cache + return the zone (used when no balances response has
  // run yet, e.g. to seed the dropdown). Best-effort: keeps the cached value on error.
  async function fetchConfig() {
    if (!token()) return tz();
    try {
      const res = await fetch('/api/config', { headers: { Authorization: `Bearer ${token()}` } });
      if (res.ok) return cacheFrom(await res.json());
    } catch {}
    return tz();
  }

  // PUT /api/config — change the zone for every device. Caches optimistically.
  async function saveTimezone(zone) {
    if (!zone || zone === tz()) { setCache(zone); return tz(); }
    setCache(zone); // optimistic; the server is the authority on next read
    if (!token()) return tz();
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: zone }),
      });
      if (res.ok) return cacheFrom(await res.json());
    } catch {}
    return tz();
  }

  return { ZONES, tz, today, dateOf, zonedNoonISO, cacheFrom, populateSelect, fetchConfig, saveTimezone };
})();
