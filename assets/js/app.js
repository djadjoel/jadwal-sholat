/* Jadwal Sholat — aplikasi klien (tanpa dependensi). */
'use strict';

const API = 'api.php';
const PRAYERS = {
  imsak:   { name: 'Imsak',   ar: 'إمساك' },
  subuh:   { name: 'Subuh',   ar: 'الفجر' },
  terbit:  { name: 'Terbit',  ar: 'الشروق' },
  dhuha:   { name: 'Dhuha',   ar: 'الضحى' },
  dzuhur:  { name: 'Dzuhur',  ar: 'الظهر' },
  ashar:   { name: 'Ashar',   ar: 'العصر' },
  maghrib: { name: 'Maghrib', ar: 'المغرب' },
  isya:    { name: 'Isya',    ar: 'العشاء' },
};
const KEYS = Object.keys(PRAYERS);
const MAIN = ['subuh', 'dzuhur', 'ashar', 'maghrib', 'isya'];
const AUX = new Set(['imsak', 'terbit', 'dhuha']);
const TZ_LABEL = { 7: 'WIB', 8: 'WITA', 9: 'WIT' };
const DEFAULT_CITY = { id: '1301', lokasi: 'KOTA JAKARTA' };
const REMIND_BEFORE = 10 * 60e3;
const RING_LEN = 376.99;
const HOUR = 36e5, DAY = 864e5;

/* ---------- utilitas ---------- */
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage penuh/diblokir */ } },
};
const titleCase = (s) => String(s).toLowerCase()
  .replace(/(^|[\s(\-/])([a-z])/g, (_, p, c) => p + c.toUpperCase());
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const isValidCity = (c) => c && /^\d{4}$/.test(c.id) && typeof c.lokasi === 'string';

const ymdUTC = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (date, n) => { const [y, m, d] = date.split('-').map(Number); return ymdUTC(new Date(Date.UTC(y, m - 1, d + n))); };

const fmtGreg = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtMonth = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtWeekday = new Intl.DateTimeFormat('id-ID', { weekday: 'short', timeZone: 'UTC' });
let fmtHijri = null;
try { fmtHijri = new Intl.DateTimeFormat('id-ID-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch { /* tidak didukung */ }

/* ---------- state ---------- */
const savedCity = store.get('js.city', null);
const state = {
  city: isValidCity(savedCity) ? savedCity : DEFAULT_CITY,
  tz: store.get('js.tz', 7),
  daerah: '',
  months: new Map(),      // "id-YYYY-MM" → { days: Map, tz, daerah, lokasi }
  pending: new Map(),     // promise dedupe
  view: null,             // { y, m } bulan di tabel
  today: null,            // tanggal kota "YYYY-MM-DD"
  lastNow: 0,
  lastMinute: -1,
  notify: store.get('js.notify', false) === true,
  cities: null,
  loadToken: 0,
};

/* ---------- waktu kota (tidak bergantung zona waktu perangkat) ---------- */
const cityDate = (now = Date.now()) => new Date(now + state.tz * HOUR);
const toEpoch = (date, hm) => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - state.tz * HOUR;
};
const monthKey = (id, y, m) => `${id}-${y}-${pad(m)}`;
const dayRow = (date) => {
  const mo = state.months.get(monthKey(state.city.id, ...date.split('-').slice(0, 2).map(Number)));
  return mo ? mo.days.get(date) || null : null;
};

/* ---------- API ---------- */
async function api(params) {
  const res = await fetch(`${API}?${new URLSearchParams(params)}`, {
    headers: { Accept: 'application/json' }, credentials: 'same-origin',
  });
  let body = null;
  try { body = await res.json(); } catch { /* bukan JSON */ }
  if (!res.ok || !body || body.ok !== true) {
    throw new Error(body?.error || `Gagal memuat data (${res.status}).`);
  }
  return body.data;
}

function ingestMonth(data) {
  const mo = {
    lokasi: data.lokasi, daerah: data.daerah, tz: data.tz,
    days: new Map(Object.entries(data.days)),
  };
  const [y, m] = data.month.split('-').map(Number);
  state.months.set(monthKey(data.id, y, m), mo);
  return mo;
}

function loadMonth(id, y, m) {
  const key = monthKey(id, y, m);
  if (state.months.has(key)) return Promise.resolve(state.months.get(key));
  if (state.pending.has(key)) return state.pending.get(key);
  const p = api({ action: 'schedule', city: id, year: y, month: m })
    .then((data) => {
      const mo = ingestMonth(data);
      // Snapshot bulan berjalan agar tampilan berikutnya instan.
      const cd = cityDate();
      if (y === cd.getUTCFullYear() && m === cd.getUTCMonth() + 1) store.set('js.snap', data);
      return mo;
    })
    .finally(() => state.pending.delete(key));
  state.pending.set(key, p);
  return p;
}

/* ---------- toast ---------- */
function toast(msg, { error = false, action = null, timeout = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' is-error' : '');
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = `<svg class="ico"><use href="#${error ? 'i-x' : 'i-bell'}"/></svg><span></span>`;
  el.querySelector('span').textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { dismiss(); action.run(); });
    el.append(b);
  }
  const dismiss = () => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  $('toasts').append(el);
  if (timeout) setTimeout(dismiss, timeout);
}

/* ---------- render: hari ini ---------- */
const cards = new Map([...document.querySelectorAll('[data-prayer]')].map((el) => [el.dataset.prayer, {
  el, time: el.querySelector('.time-card__time'), badge: el.querySelector('.time-card__badge'),
}]));

function renderHeader() {
  const name = titleCase(state.city.lokasi);
  $('cityName').textContent = name;
  $('regionLabel').textContent = state.daerah ? `${name} · ${titleCase(state.daerah)}` : name;
  $('tzLabel').textContent = TZ_LABEL[state.tz] || `UTC+${state.tz}`;
}

function renderToday() {
  const row = dayRow(state.today);
  const grid = $('timeGrid');
  if (!row) { grid.classList.add('is-loading'); return; }
  grid.classList.remove('is-loading');
  for (const k of KEYS) cards.get(k).time.textContent = row[k];
  const d = cityDate();
  $('dateGreg').textContent = fmtGreg.format(d);
  $('dateHijri').textContent = fmtHijri ? fmtHijri.format(d) : '';
  state.cardSig = '';
}

/* Daftar waktu wajib kemarin–besok; data yang belum dimuat diperkirakan dari hari ini. */
function timeline() {
  const ref = dayRow(state.today);
  if (!ref) return null;
  const evs = (date) => {
    const row = dayRow(date);
    const shift = row ? 0 : Math.round((Date.parse(date) - Date.parse(state.today)) / DAY) * DAY;
    const src = row || ref, base = row ? date : state.today;
    return MAIN.map((k) => ({ k, date, at: toEpoch(base, src[k]) + shift }));
  };
  return [...evs(addDays(state.today, -1)).slice(-1), ...evs(state.today), ...evs(addDays(state.today, 1)).slice(0, 1)];
}

function updateCards(now, prev, next) {
  const row = dayRow(state.today);
  if (!row) return;
  const passedSig = KEYS.map((k) => (toEpoch(state.today, row[k]) <= now ? 1 : 0)).join('');
  const sig = `${passedSig}|${prev.k}${prev.date}|${next.k}${next.date}`;
  if (sig === state.cardSig) return;
  state.cardSig = sig;
  KEYS.forEach((k, i) => {
    const c = cards.get(k);
    const isNext = next.k === k;
    const isCurrent = !isNext && prev.k === k && prev.date === state.today;
    c.el.classList.toggle('is-next', isNext);
    c.el.classList.toggle('is-current', isCurrent);
    c.el.classList.toggle('is-passed', !isNext && !isCurrent && passedSig[i] === '1');
    c.badge.textContent = isNext ? (next.date === state.today ? 'Berikutnya' : 'Besok') : isCurrent ? 'Sekarang' : '';
  });
}

/* ---------- langit & orb ---------- */
function updateSky(now) {
  const row = dayRow(state.today);
  if (!row) return;
  const t = (k) => toEpoch(state.today, row[k]);
  const [subuh, terbit, ashar, maghrib, isya] = ['subuh', 'terbit', 'ashar', 'maghrib', 'isya'].map(t);
  const phase = now < subuh ? 'night' : now < terbit ? 'dawn' : now < ashar ? 'day'
    : now < maghrib ? 'afternoon' : now < isya ? 'dusk' : 'night';
  if (document.body.dataset.phase !== phase) document.body.dataset.phase = phase;

  const orb = $('orb');
  let p, sun;
  if (now >= terbit && now < maghrib) { sun = true; p = (now - terbit) / (maghrib - terbit); }
  else {
    sun = false;
    const start = now >= maghrib ? maghrib : maghrib - DAY;
    const end = now >= maghrib ? terbit + DAY : terbit;
    p = (now - start) / (end - start);
  }
  p = Math.min(1, Math.max(0, p));
  orb.classList.toggle('is-sun', sun && phase === 'day');
  orb.classList.toggle('is-moon', !sun);
  orb.style.setProperty('--ox', `${8 + p * 84}%`);
  orb.style.setProperty('--oy', `${72 - Math.sin(Math.PI * p) * 58}%`);
}

/* ---------- tick per detik ---------- */
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function tick() {
  const now = Date.now();
  const cd = cityDate(now);
  $('clockHM').textContent = `${pad(cd.getUTCHours())}:${pad(cd.getUTCMinutes())}`;
  $('clockS').textContent = pad(cd.getUTCSeconds());

  const today = ymdUTC(cd);
  if (today !== state.today) {
    state.today = today;
    onDayChange();
  }

  const list = timeline();
  if (list) {
    const i = list.findIndex((e) => e.at > now);
    if (i <= 0) { state.lastNow = now; return; }
    const next = list[i], prev = list[i - 1];
    const span = next.at - prev.at;
    const frac = Math.min(1, Math.max(0, (now - prev.at) / span));
    const remain = next.at - now;
    const info = PRAYERS[next.k];

    $('nextName').textContent = info.name;
    $('nextArabic').textContent = info.ar;
    const cdText = fmtDuration(remain);
    $('countdown').textContent = cdText;
    $('ringBar').style.strokeDashoffset = String(RING_LEN * (1 - frac));
    $('ringPct').textContent = `${Math.floor(frac * 100)}%`;
    const nd = cityDate(next.at);
    $('nextAt').textContent = `${next.date === state.today ? 'Hari ini' : 'Besok'} pukul ${pad(nd.getUTCHours())}:${pad(nd.getUTCMinutes())} ${TZ_LABEL[state.tz] || ''}`;
    const use = $('nextIcon').firstElementChild;
    if (use.getAttribute('href') !== `#i-${next.k}`) use.setAttribute('href', `#i-${next.k}`);
    document.querySelector('.next-card').classList.toggle('is-imminent', remain <= REMIND_BEFORE);
    document.title = `${cdText} menuju ${info.name} · ${titleCase(state.city.lokasi)}`;

    updateCards(now, prev, next);
    if (cd.getUTCMinutes() !== state.lastMinute) {
      state.lastMinute = cd.getUTCMinutes();
      updateSky(now);
    }
    if (state.lastNow && now - state.lastNow < 5 * 60e3) checkAlerts(list, state.lastNow, now);
  }
  state.lastNow = now;
}

function startClock() {
  const loop = () => { tick(); setTimeout(loop, 1000 - (Date.now() % 1000) + 5); };
  loop();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { state.lastNow = 0; tick(); } });
}

function onDayChange() {
  state.lastMinute = -1;
  renderToday();
  const [y, m] = state.today.split('-').map(Number);
  const id = state.city.id, token = state.loadToken;
  loadMonth(id, y, m).then((mo) => { if (token === state.loadToken) { applyMonthMeta(mo); renderToday(); } })
    .catch((e) => showLoadError(e));
  // Muat bulan berikutnya bila mendekati akhir bulan (untuk Subuh besok).
  const tomorrow = addDays(state.today, 1);
  if (tomorrow.slice(0, 7) !== state.today.slice(0, 7)) {
    const [ny, nm] = tomorrow.split('-').map(Number);
    loadMonth(id, ny, nm).catch(() => {});
  }
  if (!state.view || state.viewAuto) setView(y, m, true);
}

/* ---------- pengingat adzan ---------- */
let audioCtx = null;
function chime() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [659.25, 880, 987.77, 1318.5].forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    const t = t0 + i * 0.32;
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + 1.9);
  });
}

async function systemNotify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag, icon: 'assets/img/icon.svg', badge: 'assets/img/icon.svg' };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch { /* abaikan */ }
}

function checkAlerts(list, from, to) {
  if (!state.notify) return;
  const city = titleCase(state.city.lokasi);
  for (const e of list) {
    const name = PRAYERS[e.k].name;
    if (from < e.at && e.at <= to) {
      chime();
      toast(`Telah masuk waktu ${name} untuk ${city}.`, { timeout: 15000 });
      systemNotify(`Waktu ${name}`, `Telah masuk waktu sholat ${name} untuk ${city}.`, `adzan-${e.k}`);
    } else if (from < e.at - REMIND_BEFORE && e.at - REMIND_BEFORE <= to) {
      toast(`10 menit lagi menuju waktu ${name}.`, { timeout: 8000 });
      systemNotify(`${name} dalam 10 menit`, `Bersiaplah untuk sholat ${name} (${city}).`, `remind-${e.k}`);
    }
  }
}

function renderNotifyBtn() {
  $('btnNotify').setAttribute('aria-pressed', String(state.notify));
  $('btnNotify').title = state.notify ? 'Pengingat aktif — klik untuk mematikan' : 'Aktifkan pengingat waktu sholat';
}

async function toggleNotify() {
  state.notify = !state.notify;
  if (state.notify) {
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* tanpa suara */ }
    if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* abaikan */ }
    }
    const sys = 'Notification' in window && Notification.permission === 'granted';
    toast(sys ? 'Pengingat aktif: notifikasi & suara saat waktu sholat tiba.' : 'Pengingat aktif selama halaman ini terbuka.');
  } else {
    toast('Pengingat dimatikan.');
  }
  store.set('js.notify', state.notify);
  renderNotifyBtn();
}

/* ---------- tabel bulanan ---------- */
function setView(y, m, auto = false) {
  const nowY = cityDate().getUTCFullYear();
  if (m < 1) { y--; m = 12; } else if (m > 12) { y++; m = 1; }
  if (y < nowY - 1 || y > nowY + 1) return;
  state.view = { y, m };
  state.viewAuto = auto;
  $('monthPrev').disabled = y === nowY - 1 && m === 1;
  $('monthNext').disabled = y === nowY + 1 && m === 12;
  renderMonth();
}

function tableState(text, retry) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 9; td.className = 'state'; td.textContent = text;
  if (retry) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'city-pill'; b.textContent = 'Coba lagi';
    b.style.marginLeft = '12px';
    b.addEventListener('click', retry);
    td.append(b);
  }
  tr.append(td);
  $('monthBody').replaceChildren(tr);
}

async function renderMonth() {
  const { y, m } = state.view;
  const id = state.city.id, token = state.loadToken;
  $('monthLabel').textContent = fmtMonth.format(new Date(Date.UTC(y, m - 1, 1)));
  $('monthCity').textContent = `${titleCase(state.city.lokasi)} · Waktu ${TZ_LABEL[state.tz] || ''}`;
  if (!state.months.has(monthKey(id, y, m))) tableState('Memuat jadwal…');
  let mo;
  try { mo = await loadMonth(id, y, m); } catch (e) {
    if (token === state.loadToken) tableState(e.message, () => renderMonth());
    return;
  }
  if (token !== state.loadToken || state.view.y !== y || state.view.m !== m) return;

  const frag = document.createDocumentFragment();
  for (const [date, row] of mo.days) {
    const d = new Date(`${date}T00:00:00Z`);
    const tr = document.createElement('tr');
    if (date === state.today) tr.className = 'is-today';
    if (d.getUTCDay() === 5) tr.classList.add('is-friday');
    const first = document.createElement('td');
    const wrap = document.createElement('span'); wrap.className = 'day';
    const b = document.createElement('b'); b.textContent = String(d.getUTCDate());
    const s = document.createElement('span'); s.textContent = d.getUTCDay() === 5 ? "Jum'at" : fmtWeekday.format(d);
    wrap.append(b, s); first.append(wrap); tr.append(first);
    for (const k of KEYS) {
      const td = document.createElement('td');
      td.textContent = row[k];
      if (AUX.has(k)) td.className = 'aux';
      tr.append(td);
    }
    frag.append(tr);
  }
  $('monthBody').replaceChildren(frag);
  const todayRow = $('monthBody').querySelector('.is-today');
  if (todayRow && state.viewAuto) {
    const wrap = todayRow.closest('.table-wrap');
    wrap.scrollTop = Math.max(0, todayRow.offsetTop - wrap.clientHeight / 3);
  }
}

/* ---------- ganti kota ---------- */
function applyMonthMeta(mo) {
  if (mo.tz && mo.tz !== state.tz) {
    state.tz = mo.tz;
    store.set('js.tz', state.tz);
    state.today = null; // paksa hitung ulang tanggal di zona baru
  }
  state.daerah = mo.daerah || '';
  renderHeader();
}

function showLoadError(e) {
  $('sourceBadge').textContent = 'Offline';
  $('sourceBadge').classList.add('is-offline');
  toast(e.message || 'Gagal memuat jadwal.', { error: true, timeout: 0, action: { label: 'Coba lagi', run: () => setCity(state.city, { force: true }) } });
}

async function setCity(city, { force = false, announce = false } = {}) {
  if (!isValidCity(city)) return;
  const changed = city.id !== state.city.id;
  state.city = { id: city.id, lokasi: city.lokasi };
  store.set('js.city', state.city);
  const recent = store.get('js.recent', []).filter((c) => isValidCity(c) && c.id !== city.id);
  store.set('js.recent', [state.city, ...recent].slice(0, 5));
  if (!changed && !force) return;

  const token = ++state.loadToken;
  state.daerah = '';
  renderHeader();
  $('timeGrid').classList.add('is-loading');
  const cd = cityDate();
  try {
    const mo = await loadMonth(city.id, cd.getUTCFullYear(), cd.getUTCMonth() + 1);
    if (token !== state.loadToken) return;
    $('sourceBadge').textContent = 'Kemenag RI';
    $('sourceBadge').classList.remove('is-offline');
    applyMonthMeta(mo);
    state.today = null;
    state.view = null;
    tick();
    if (announce) toast(`Jadwal ditampilkan untuk ${titleCase(city.lokasi)}.`);
  } catch (e) {
    if (token === state.loadToken) showLoadError(e);
  }
}

/* ---------- dialog pencarian kota ---------- */
const dlg = $('cityDialog'), input = $('cityInput'), listEl = $('cityList');
let results = [], active = -1;

async function ensureCities() {
  if (state.cities) return state.cities;
  const cached = store.get('js.cities', null);
  if (cached && Array.isArray(cached.list) && Date.now() - cached.t < 30 * DAY) {
    state.cities = cached.list.filter(isValidCity);
    return state.cities;
  }
  const list = (await api({ action: 'cities' })).filter(isValidCity);
  state.cities = list;
  store.set('js.cities', { t: Date.now(), list });
  return list;
}

function highlight(el, text, q) {
  const i = q ? fold(text).indexOf(q) : -1;
  if (i < 0) { el.textContent = text; return; }
  const mark = document.createElement('mark');
  mark.textContent = text.slice(i, i + q.length);
  el.append(text.slice(0, i), mark, text.slice(i + q.length));
}

function renderResults() {
  const q = fold(input.value.trim()).replace(/^(kab\.?|kabupaten|kota)\s+/, '');
  listEl.replaceChildren();
  active = -1;
  const all = state.cities || [];
  if (!q) {
    const recent = store.get('js.recent', []).filter(isValidCity);
    results = recent.length ? recent : all.slice(0, 40);
    $('cityHint').textContent = recent.length ? 'Terakhir dipilih' : `${all.length} kabupaten/kota tersedia`;
  } else {
    const scored = [];
    for (const c of all) {
      const name = fold(titleCase(c.lokasi));
      const bare = name.replace(/^(kab\.|kota)\s+/, '');
      const pos = bare.indexOf(q);
      if (pos === -1 && name.indexOf(q) === -1) continue;
      scored.push([pos === 0 ? 0 : bare.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2, name.startsWith('kota') ? 0 : 1, c]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].lokasi.localeCompare(b[2].lokasi));
    results = scored.slice(0, 60).map((s) => s[2]);
    $('cityHint').textContent = results.length ? `${scored.length} hasil` : 'Tidak ditemukan. Coba kata kunci lain.';
  }
  const frag = document.createDocumentFragment();
  results.forEach((c, i) => {
    const li = document.createElement('li');
    li.id = `city-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.index = String(i);
    if (c.id === state.city.id) li.classList.add('is-active-city');
    li.innerHTML = '<svg class="ico"><use href="#i-pin"/></svg><span></span><small></small>';
    const label = titleCase(c.lokasi);
    const isKota = /^kota/i.test(c.lokasi);
    highlight(li.querySelector('span'), label.replace(/^(Kab\.|Kota)\s+/, ''), q);
    li.querySelector('small').textContent = isKota ? 'Kota' : 'Kabupaten';
    frag.append(li);
  });
  listEl.append(frag);
  if (results.length) setActive(0);
}

function setActive(i) {
  const items = listEl.querySelectorAll('[role="option"]');
  if (!items.length) return;
  active = (i + items.length) % items.length;
  items.forEach((el, j) => el.setAttribute('aria-selected', String(j === active)));
  input.setAttribute('aria-activedescendant', items[active].id);
  items[active].scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const c = results[i];
  if (!c) return;
  dlg.close();
  setCity(c, { announce: true });
}

async function openCityDialog() {
  input.value = '';
  dlg.showModal();
  input.focus();
  try {
    await ensureCities();
    renderResults();
  } catch (e) {
    $('cityHint').textContent = e.message;
  }
}

let searchTimer = 0;
input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderResults, 60); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
});
listEl.addEventListener('click', (e) => {
  const li = e.target.closest('[role="option"]');
  if (li) choose(Number(li.dataset.index));
});
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
$('cityClose').addEventListener('click', () => dlg.close());
$('btnCity').addEventListener('click', openCityDialog);

/* ---------- geolokasi ---------- */
async function locate({ silent = false } = {}) {
  if (!('geolocation' in navigator) || !window.isSecureContext) {
    if (!silent) toast('Deteksi lokasi membutuhkan HTTPS dan izin lokasi. Silakan pilih kota manual.', { error: true });
    return;
  }
  const btn = $('btnLocate');
  btn.classList.add('is-busy');
  btn.disabled = true;
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, {
      enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60e3,
    }));
    const c = await api({ action: 'locate', lat: pos.coords.latitude.toFixed(3), lon: pos.coords.longitude.toFixed(3) });
    await setCity(c);
    if (!silent) toast(`Lokasi terdeteksi: ${titleCase(c.lokasi)}`);
  } catch (e) {
    if (!silent) {
      const msg = e && typeof e.code === 'number'
        ? (e.code === 1 ? 'Izin lokasi ditolak. Silakan pilih kota manual.' : 'Lokasi tidak dapat ditentukan.')
        : e.message;
      toast(msg, { error: true, action: { label: 'Pilih kota', run: openCityDialog } });
    }
  } finally {
    btn.classList.remove('is-busy');
    btn.disabled = false;
  }
}

/* ---------- init ---------- */
function init() {
  renderHeader();
  renderNotifyBtn();
  $('btnLocate').addEventListener('click', () => locate());
  $('btnNotify').addEventListener('click', toggleNotify);
  $('monthPrev').addEventListener('click', () => setView(state.view.y, state.view.m - 1));
  $('monthNext').addEventListener('click', () => setView(state.view.y, state.view.m + 1));
  $('btnPrint').addEventListener('click', () => window.print());

  // Tampilkan snapshot tersimpan seketika, lalu segarkan dari server.
  const snap = store.get('js.snap', null);
  if (snap && snap.id === state.city.id && snap.days && /^\d{4}-\d{2}$/.test(snap.month || '')) {
    try { applyMonthMeta(ingestMonth(snap)); } catch { /* snapshot rusak */ }
  }
  const fromSnap = state.months.size > 0;
  startClock(); // memuat bulan berjalan bila belum ada snapshot

  // Snapshot dipakai untuk tampilan instan → revalidasi di latar belakang.
  if (fromSnap) {
    const { id } = state.city, token = state.loadToken;
    const [y, m] = snap.month.split('-').map(Number);
    api({ action: 'schedule', city: id, year: y, month: m }).then((data) => {
      if (token !== state.loadToken) return;
      store.set('js.snap', data);
      applyMonthMeta(ingestMonth(data));
      renderToday(); tick();
      if (state.view) renderMonth();
    }).catch(() => {
      $('sourceBadge').textContent = 'Offline';
      $('sourceBadge').classList.add('is-offline');
    });
  }

  // Buka kunci audio pada interaksi pertama (kebijakan autoplay browser).
  if (state.notify) {
    document.addEventListener('pointerdown', () => {
      try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* tanpa suara */ }
    }, { once: true });
  }

  // Kunjungan pertama: deteksi lokasi otomatis bila izin sudah diberikan sebelumnya.
  if (!savedCity) {
    navigator.permissions?.query({ name: 'geolocation' }).then((p) => {
      if (p.state === 'granted') locate({ silent: true });
      else toast('Ketuk ikon lokasi untuk jadwal sesuai kota Anda.', { timeout: 7000 });
    }).catch(() => {});
  }

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

init();
