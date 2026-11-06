'use strict';

/*
 * Світло · веб-версія
 *
 * Дані про будинки та сьогоднішній графік беремо з відкритого DTEK-проксі
 * (dtek-shutdowns-checker). Проксі відкриває сторінку ДТЕК у справжньому
 * браузері, тому запит іде через Reader-проксі Jina, який додає CORS.
 * Якщо пошук за адресою недоступний, можна вибрати чергу вручну, і тоді
 * графік береться з публічної копії ДТЕК (outage-data-ua).
 */

const WORKER = 'https://dtek-shutdowns-checker-lookup-20261029.sidoretsyura.workers.dev';
const JINA = 'https://r.jina.ai/http://';
const MIRROR = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv.json';
const TZ = 'Europe/Kyiv';
const REFRESH_MS = 5 * 60 * 1000;
const CACHE_MS = 2 * 60 * 1000;
const ALERT_PREFS = 'svitlo-alerts';
const ADDRESS_KEY = 'svitlo-web-address-v1';
const SCHEDULE_KEY = 'svitlo-web-schedule-v1';
const OFF_MINUTES = [1, 5, 10, 15, 30, 45, 60, 90, 120];
const ON_MINUTES = [1, 5, 10, 15, 20, 30, 45, 60];

const alertCfg = { beforeOff: 60, beforeOn: 15 };
const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  prev: null,
  address: null,
  mirror: null,
  loading: false,
  addressPrompted: false,
  notifyEnabled: localStorage.getItem('svitlo-notify') === '1',
  timers: [],
};

/* --------------------------- дата й час Києва --------------------------- */

const PARTS_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});
const TIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const pad = (n) => String(n).padStart(2, '0');
const naturalCompare = (a, b) => String(a).localeCompare(String(b), 'uk', { numeric: true, sensitivity: 'base' });

function kyivParts(date) {
  const out = {};
  for (const part of PARTS_FMT.formatToParts(date)) out[part.type] = part.value;
  return out;
}

function kyivDateKey(date = new Date()) {
  const p = kyivParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function kyivToday() {
  return kyivDateKey(new Date());
}

function tzOffsetMs(date) {
  const p = kyivParts(date);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
}

/** Kyiv wall-clock date + minutes from midnight -> absolute Date. */
function kyivDate(dayISO, minutes) {
  const [y, m, d] = String(dayISO).split('-').map(Number);
  const offsetDays = Math.floor(minutes / 1440);
  const rest = ((minutes % 1440) + 1440) % 1440;
  const base = new Date(Date.UTC(y, m - 1, d + offsetDays, 0, 0, 0));
  const by = base.getUTCFullYear();
  const bm = base.getUTCMonth() + 1;
  const bd = base.getUTCDate();
  const guess = Date.UTC(by, bm - 1, bd, Math.floor(rest / 60), rest % 60, 0);
  let ts = guess - tzOffsetMs(new Date(guess));
  ts = guess - tzOffsetMs(new Date(ts));
  return new Date(ts);
}

function kyivStartOfDay(date = new Date()) {
  return kyivDate(kyivDateKey(date), 0);
}

function fmtTime(date) {
  return TIME_FMT.format(date);
}

function fmtRange(from, to) {
  return `${fmtTime(from)}–${fmtTime(to)}`;
}

function fmtDay(date, now = new Date()) {
  const today = kyivDateKey(now);
  const yesterday = kyivDateKey(new Date(now.getTime() - 86400000));
  const tomorrow = kyivDateKey(new Date(now.getTime() + 86400000));
  const key = kyivDateKey(date);
  if (key === today) return 'Сьогодні';
  if (key === yesterday) return 'Вчора';
  if (key === tomorrow) return 'Завтра';
  const p = kyivParts(date);
  return `${p.day}.${p.month}`;
}

function isMidnight(date) {
  return fmtTime(date) === '00:00';
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} год ${m} хв`;
  if (h) return `${h} год`;
  return `${m} хв`;
}

function fmtCountdown(ms) {
  if (ms == null) return '--:--';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/* ----------------------------- сповіщення ----------------------------- */

function leadLabel(min) {
  if (min <= 0) return 'у момент';
  if (min === 60) return 'за годину';
  if (min % 60 === 0) return `за ${min / 60} год`;
  return `за ${min} хв`;
}

function alertHintText() {
  return `Сповіщення ${leadLabel(alertCfg.beforeOff)} до відключення і ${leadLabel(alertCfg.beforeOn)} до включення`;
}

function alertTitle(min, event) {
  if (event === 'off') {
    if (min <= 0) return 'Відключення почалося';
    if (min === 60) return 'Через годину відключення';
    if (min % 60 === 0) return `Через ${min / 60} год відключення`;
    return `Через ${min} хв відключення`;
  }
  if (min <= 0) return 'Світло має повернутися';
  if (min === 60) return 'Через годину світло повернеться';
  if (min % 60 === 0) return `Через ${min / 60} год світло повернеться`;
  return `Через ${min} хв світло повернеться`;
}

function loadAlertCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALERT_PREFS) || '{}');
    const off = parseInt(raw.beforeOff, 10);
    const on = parseInt(raw.beforeOn, 10);
    if (Number.isFinite(off)) alertCfg.beforeOff = Math.max(1, Math.min(180, off));
    if (Number.isFinite(on)) alertCfg.beforeOn = Math.max(1, Math.min(60, on));
  } catch {}
}

function fillAlertSelects() {
  fillMinuteSelect('beforeOff', OFF_MINUTES, alertCfg.beforeOff);
  fillMinuteSelect('beforeOn', ON_MINUTES, alertCfg.beforeOn);
}

function fillMinuteSelect(id, options, value) {
  const el = $(id);
  if (!el) return;
  const list = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  el.innerHTML = list.map((m) => `<option value="${m}">${m === 0 ? 'у момент' : `${m} хв`}</option>`).join('');
  el.value = String(value);
}

function saveAlertCfg() {
  const off = parseInt(($('beforeOff') || {}).value, 10);
  const on = parseInt(($('beforeOn') || {}).value, 10);
  alertCfg.beforeOff = Number.isFinite(off) ? Math.max(1, Math.min(180, off)) : 60;
  alertCfg.beforeOn = Number.isFinite(on) ? Math.max(1, Math.min(60, on)) : 15;
  try { localStorage.setItem(ALERT_PREFS, JSON.stringify(alertCfg)); } catch {}
  updateNotifyUI();
  if (state.status) scheduleAlerts(state.status);
}

/* ------------------------------- рендер -------------------------------- */

function computeView(status, now = new Date()) {
  const cur = status?.current && new Date(status.current.to) > now ? status.current : null;
  const activeWindow = (status?.windows || []).find(
    (w) => new Date(w.from) <= now && new Date(w.to) > now
  );
  const off = Boolean(cur || activeWindow);
  const restoreAt = cur ? new Date(cur.to) : activeWindow ? new Date(activeWindow.to) : null;
  const next = status?.next ? { from: new Date(status.next.from), to: new Date(status.next.to) } : null;
  return { now, cur, activeWindow, off, restoreAt, next };
}

function render(status) {
  const address = status.address || {};
  $('address').textContent = address.street
    ? `${address.street}${address.house ? `, ${address.house}` : ''}`
    : 'Оберіть адресу';
  $('groupChip').textContent = address.groupName || (address.group ? queueName(address.group) : 'За адресою');

  const v = computeView(status);
  const card = $('statusCard');
  card.classList.remove('is-off', 'is-loading');
  if (v.off) card.classList.add('is-off');

  $('statusTitle').textContent = v.off ? 'Світла немає' : 'Світло є';
  if (v.off) {
    const scheduledOnly = !status.current || status.current.kind === 'За графіком';
    $('statusSub').textContent = v.restoreAt
      ? `Орієнтовно до ${fmtTime(v.restoreAt)}${scheduledOnly ? ' (за графіком)' : ''}`
      : 'Очікуємо дані про включення';
  } else if (v.next) {
    $('statusSub').textContent = `Наступне відключення о ${fmtTime(v.next.from)}`;
  } else {
    $('statusSub').textContent = 'Більше відключень сьогодні не видно';
  }

  renderLiveNote(null);
  renderCountdown();
  renderWindows(status, v);
  renderTimeline(status, v);

  const warning = $('warning');
  if (status.note) {
    warning.textContent = status.note;
    warning.classList.remove('hidden');
  } else if (status.stale) {
    const when = status.updated || (status.fetchedAt ? fmtTime(new Date(status.fetchedAt)) : '—');
    warning.textContent = `Немає свіжих даних від ДТЕК. Показуємо останній відомий графік — ${when}.`;
    warning.classList.remove('hidden');
  } else {
    warning.classList.add('hidden');
  }

  const sources = {
    worker: 'ДТЕК, перевірка за адресою',
    mirror: 'ДТЕК (публічна копія графіка)',
    cache: 'ДТЕК (збережений графік)',
  };
  $('source').textContent = `Джерело: ${sources[status.source] || 'ДТЕК Київські електромережі'}`;

  const checked = status.fetchedAt ? fmtTime(new Date(status.fetchedAt)) : '—';
  $('updated').textContent = status.updated
    ? `Графік ДТЕК: ${status.updated} · перевірено ${checked}`
    : `Оновлено ${checked}`;
}

function renderLiveNote(outage) {
  const note = $('statusNote');
  if (!note) return;
  if (outage && outage.reason) {
    note.textContent = `Причина: ${outage.reason}`;
    note.classList.remove('hidden');
  } else {
    note.textContent = '';
    note.classList.add('hidden');
  }
}

function renderCountdown() {
  const status = state.status;
  if (!status) return;
  const v = computeView(status);
  let target = null;
  let label = '';
  if (v.off && v.restoreAt) {
    target = v.restoreAt;
    label = 'До орієнтовного включення';
  } else if (!v.off && v.next) {
    target = v.next.from;
    label = 'До відключення';
  }
  if (!target) {
    $('countdown').textContent = v.off ? '—' : 'OK';
    $('countdownLabel').textContent = v.off ? 'Чекаємо на інформацію' : 'Світло є';
    return;
  }
  $('countdown').textContent = fmtCountdown(target.getTime() - Date.now());
  $('countdownLabel').textContent = label;
}

function renderWindows(status, v) {
  const root = $('windows');
  const now = new Date();
  const items = [];

  if (v.off && v.restoreAt) {
    items.push({
      from: v.cur ? new Date(v.cur.from) : now,
      to: v.restoreAt,
      now: true,
      live: false,
    });
  }

  for (const w of status.windows || []) {
    const from = new Date(w.from);
    const to = new Date(w.to);
    if (to <= now) continue;
    if (v.off && v.restoreAt && from < v.restoreAt) continue;
    if (items.some((it) => it.from.getTime() === from.getTime())) continue;
    items.push({ from, to, now: false, live: false });
  }

  if (!items.length) {
    root.innerHTML = '<div class="empty">На сьогодні відключень не заплановано</div>';
    return;
  }

  root.innerHTML = items.slice(0, 6).map((it) => {
    const active = it.from <= now && it.to > now;
    const fromLabel = fmtDay(it.from, now);
    const toDate = isMidnight(it.to) ? new Date(it.to.getTime() - 1) : it.to;
    const toLabel = fmtDay(toDate, now);
    const whenLabel = fromLabel === toLabel ? fromLabel : `${fromLabel}–${toLabel}`;
    return `
      <div class="window-row${active ? ' is-now' : ''}">
        <div class="window-when"><b>${whenLabel}</b></div>
        <div class="window-time">${fmtRange(it.from, it.to)}${active ? '<span class="now-badge">зараз</span>' : ''}</div>
        <div class="window-dur">${fmtDuration(it.to - it.from)}</div>
      </div>`;
  }).join('');
}

function renderTimeline(status, v) {
  const root = $('timeline');
  const labels = $('timelineLabels');
  const now = new Date();
  const start = kyivStartOfDay(now);
  const STEP = 30 * 60 * 1000;
  const CELLS = 48;

  const offRanges = [
    ...(status.windows || []).map((w) => [new Date(w.from).getTime(), new Date(w.to).getTime()]),
    ...(v.cur ? [[new Date(v.cur.from).getTime(), new Date(v.cur.to).getTime()]] : []),
  ];

  const cells = [];
  for (let i = 0; i < CELLS; i++) {
    const t = start.getTime() + i * STEP;
    const mid = t + STEP / 2;
    const off = offRanges.some(([a, b]) => mid >= a && mid < b);
    const isNow = now.getTime() >= t && now.getTime() < t + STEP;
    cells.push(`<div class="tl-cell${off ? ' off' : ''}${isNow ? ' now' : ''}"></div>`);
  }
  root.innerHTML = cells.join('');

  const points = [0, 8, 16, 24, 32, 40, 48];
  labels.innerHTML = points.map((i) => {
    if (i === 48) return '<span>24:00</span>';
    return `<span>${fmtTime(new Date(start.getTime() + i * STEP))}</span>`;
  }).join('');
}

function renderNeedAddress() {
  $('address').textContent = 'Оберіть адресу';
  $('groupChip').textContent = '—';
  const card = $('statusCard');
  card.classList.remove('is-off');
  card.classList.add('is-loading');
  $('statusTitle').textContent = 'Оберіть адресу';
  $('statusSub').textContent = 'Вкажи вулицю та будинок, щоб побачити графік ДТЕК';
  renderLiveNote(null);
  $('countdown').textContent = '--:--';
  $('countdownLabel').textContent = '';
  $('windows').innerHTML = '<div class="empty">Спочатку обери адресу</div>';
  $('timeline').innerHTML = '';
  $('timelineLabels').innerHTML = '';
  $('warning').classList.add('hidden');
  $('updated').textContent = 'Адресу не вибрано';
  $('source').textContent = 'Джерело: ДТЕК Київські електромережі';
}

function renderError(err) {
  const card = $('statusCard');
  card.classList.add('is-off', 'is-loading');
  $('statusTitle').textContent = 'Немає даних';
  $('statusSub').textContent = err.message || 'Перевір інтернет';
  $('countdown').textContent = '--:--';
  $('countdownLabel').textContent = 'Перевір інтернет';
  const warning = $('warning');
  warning.textContent = 'Не вдалося отримати графік. Перевір інтернет і спробуй ще раз.';
  warning.classList.remove('hidden');
}

/* ------------------------------- утиліти ------------------------------- */

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function queueName(group) {
  const k = String(group || '').toUpperCase().replace(/\s+/g, '').replace('ГПВ', 'GPV').replace(/^GPV/i, '');
  return `Черга ${k}`;
}

function sameHome(a, b) {
  return normalizeHouse(a) === normalizeHouse(b);
}

function normalizeHouse(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’'`ʼ‘]/g, '')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, '')
    .replace(/\./g, '');
}

function looseHouse(value) {
  return normalizeHouse(value).replace(/[^0-9a-zа-яіїєґё]/g, '');
}

function isHouseSentinel(value) {
  return value === '-' || value === '-1';
}

function houseLabel(value) {
  return isHouseSentinel(value) ? 'Уся вулиця' : value;
}

function houseScore(query, candidate) {
  const raw = String(query || '').trim();
  if (!raw) return 1;
  const qn = normalizeHouse(raw);
  const cn = normalizeHouse(candidate);
  const ql = looseHouse(raw);
  const cl = looseHouse(candidate);
  if ((qn && qn === cn) || (ql && ql === cl)) return 1000;
  if (ql && cl.startsWith(ql)) return 820 - Math.min(180, cl.length - ql.length);
  if (qn && cn.startsWith(qn)) return 780 - Math.min(160, cn.length - qn.length);
  if (qn && cn.includes(qn)) return 600;
  if (ql && cl.includes(ql)) return 560;
  if (houseLabel(candidate).toLowerCase().includes(raw.toLowerCase())) return 500;
  return 0;
}

function houseMatches(value) {
  const raw = String(value || '').trim();
  if (!raw) return addr.houses.slice(0, 60);
  return addr.houses
    .map((house) => ({ house, score: houseScore(raw, house) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || naturalCompare(a.house, b.house))
    .slice(0, 60)
    .map((item) => item.house);
}

function findHouseKey(value) {
  const wanted = normalizeHouse(value);
  if (!wanted) return '';
  const keys = addr.houses;
  if (wanted === normalizeHouse('Уся вулиця')) return keys.find(isHouseSentinel) || '';
  const exact = keys.find((k) => normalizeHouse(k) === wanted);
  if (exact) return exact;
  const loose = looseHouse(value);
  if (!loose) return '';
  const similar = keys.filter((k) => looseHouse(k) === loose);
  return similar.length === 1 ? similar[0] : '';
}

/* ---------------------------- адреса: вулиці --------------------------- */

const STREET_TYPE_WORD =
  '(?:вулиця|вулиц|вул|проспект|просп|провулок|пров|бульвар|бул|набережна|наб|площа|пл|майдан|шосе|дорога|проїзд|тупик|узвіз|узвоз|лінія|просека|просіка|алея|парк|сквер|улица|улиц|ул|переулок|пер|бульвар|набережная|площадь|шоссе|проезд|тупик|спуск|аллея|линия)';
const STREET_TYPE_RE = new RegExp('^' + STREET_TYPE_WORD + '\\s+', 'i');
const STREET_TYPE_END_RE = new RegExp('\\s+' + STREET_TYPE_WORD + '$', 'i');
const HONORIFIC_RE = /^(?:имени|им)\s+/i;

function normalizeStreet(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’'`ʼ‘]/g, '')
    .replace(/[–—−]/g, '-')
    .replace(/[№]/g, ' ')
    .replace(/[.,;:()]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\/+/g, ' ')
    .replace(/ґ/g, 'г')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function streetCore(value) {
  let core = normalizeStreet(value);
  let previous;
  do {
    previous = core;
    core = core.replace(STREET_TYPE_RE, '').replace(STREET_TYPE_END_RE, '').replace(HONORIFIC_RE, '');
  } while (core !== previous);
  return core;
}

function embeddedHouse(value) {
  const match = String(value || '').trim().match(/(?:^|[\s,])(\d+[0-9a-zа-яіїєґё\/-]*)(?=\s*(?:,|\(|$))/i);
  return match ? match[1] : '';
}

function splitAddressQuery(value) {
  const raw = String(value || '').trim();
  if (!raw) return { street: '', house: '' };
  if (addr.streetKeys && addr.streetKeys.has(normalizeStreet(raw))) return { street: raw, house: '' };
  const match = raw.match(/^(.*\S)\s+(\d+[0-9a-zа-яіїєґё\/-]*)(\s*\(.*\))?$/i);
  if (!match) return { street: raw, house: '' };
  const street = match[1].trim();
  if (street.length < 2) return { street: raw, house: '' };
  return { street, house: match[2] };
}

function streetScore(query, candidate) {
  const parsed = splitAddressQuery(query);
  const baseQuery = parsed.house ? parsed.street : query;
  const qn = normalizeStreet(baseQuery);
  const cn = normalizeStreet(candidate);
  if (!qn || !cn) return 0;

  let score = 0;
  if (qn === cn) score = 1000;
  else {
    const qc = streetCore(baseQuery);
    const cc = streetCore(candidate);
    if (qc && cc === qc) score = 950;
    else if (qc && cc.startsWith(qc)) score = 820;
    else if (qc && cc.includes(qc)) score = 650;
    else if (cn.includes(qn)) score = 560;
    else {
      const words = new Set(cc.split(' ').filter(Boolean));
      const cWords = cc.split(' ').filter(Boolean);
      const qWords = qc.split(' ').filter(Boolean);
      if (qWords.length && qWords.every((word) => words.has(word))) score = 520;
      else if (qWords.length && qWords.every((word) => cWords.some((c) => c.startsWith(word) || word.startsWith(c)))) score = 470;
    }
  }
  if (!score) return 0;

  if (parsed.house) {
    const candidateHouse = embeddedHouse(candidate);
    if (candidateHouse && normalizeHouse(candidateHouse) === normalizeHouse(parsed.house)) score += 420;
    else if (candidateHouse) score -= 70;
    else score += 30;
  }

  const qc = streetCore(baseQuery);
  const cc = streetCore(candidate);
  if (!parsed.house && qc && !/\d/.test(qc) && /\d/.test(cc.replace(qc, ''))) score -= 90;
  if (/(?:^|\s)(?:р\s+н|район|смт|с\s+т)(?:\s|$)/.test(cn)) score -= 40;
  if (qc) score -= Math.min(40, Math.max(0, cc.length - qc.length) * 0.3);
  return score;
}

function exactStreet(value) {
  const wanted = normalizeStreet(value);
  if (!wanted) return '';
  const hits = addr.streets.filter((x) => normalizeStreet(x) === wanted);
  return hits.length === 1 ? hits[0] : '';
}

function uniqueStreet(value) {
  if (!addr.streets.length) return '';
  const query = String(value || '').trim();
  if (!query) return '';
  const exact = exactStreet(query);
  if (exact) return exact;
  const matches = addr.streets
    .map((street) => ({ street, score: streetScore(query, street) }))
    .filter((item) => item.score > 0);
  return matches.length === 1 ? matches[0].street : '';
}

function resolveStreet(value) {
  const typed = String(value || '').trim();
  if (!typed) return '';
  if (!addr.streets.length) return typed;
  return uniqueStreet(typed) || typed;
}

function streetMatches(value) {
  const query = String(value || '').trim();
  if (!query) return addr.streets.slice(0, 40);
  return addr.streets
    .map((street) => ({ street, score: streetScore(query, street) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || naturalCompare(a.street, b.street))
    .slice(0, 40)
    .map((item) => item.street);
}

function streetLabel(value) {
  const text = String(value || '');
  const house = embeddedHouse(text);
  if (!house) return text;
  const at = text.toLowerCase().indexOf(house.toLowerCase());
  let base = at >= 0 ? text.slice(0, at) + text.slice(at + house.length) : text;
  base = base.replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim().replace(/,$/, '').trim();
  return `${base} · буд. ${house}`;
}

/* ---------------------------- мережа ДТЕК ----------------------------- */

function workerUrl(path, params = {}) {
  const url = new URL(path, WORKER);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, value);
  }
  return url.toString();
}

async function jinaJson(url, timeout = 35000) {
  const bust = `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
  const proxied = JINA + bust.replace(/^https?:\/\//, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(proxied, {
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { 'X-Return-Format': 'text' },
    });
    if (!res.ok) throw new Error(`Сервіс ДТЕК недоступний (${res.status})`);
    const text = await res.text();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Не вдалося прочитати відповідь ДТЕК');
    let data;
    try { data = JSON.parse(text.slice(start, end + 1)); }
    catch { throw new Error('ДТЕК повернув некоректну відповідь'); }
    if (data && data.error) throw new Error(data.error);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('ДТЕК не відповів вчасно');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const housesCache = new Map();
const scheduleCache = new Map();

async function fetchHouses(street) {
  const key = normalizeStreet(street);
  const hit = housesCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.houses;
  const data = await jinaJson(workerUrl('/api/houses', { street }));
  if (!Array.isArray(data.houses)) throw new Error('ДТЕК не повернув список будинків');
  const houses = [...new Set(data.houses.map((x) => String(x || '').trim()).filter(Boolean))].sort(naturalCompare);
  housesCache.set(key, { at: Date.now(), houses });
  return houses;
}

async function fetchSchedule(street, house, { force = false } = {}) {
  const key = `${normalizeStreet(street)}|${normalizeHouse(house)}`;
  const hit = scheduleCache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await jinaJson(workerUrl('/api/schedule', { street, house }));
  if (!Array.isArray(data.days)) throw new Error('ДТЕК не повернув графік для цієї адреси');
  scheduleCache.set(key, { at: Date.now(), data });
  return data;
}

function saveAddressStorage(address) {
  try { localStorage.setItem(ADDRESS_KEY, JSON.stringify(address)); } catch {}
}

function loadAddressStorage() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ADDRESS_KEY) || 'null');
    if (parsed && parsed.street && parsed.house) return parsed;
  } catch {}
  return null;
}

function saveScheduleStorage(data, address) {
  try {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify({ at: Date.now(), address, data }));
  } catch {}
}

function loadScheduleStorage() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCHEDULE_KEY) || 'null');
    if (parsed && parsed.data && parsed.address) return parsed;
  } catch {}
  return null;
}

/* --------------------------- публічна копія ---------------------------- */

async function loadMirror() {
  try {
    const res = await fetch(MIRROR, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Помилка ${res.status}`);
    const data = await res.json();
    if (!data || !data.fact || !data.fact.data) throw new Error('Немає даних');
    state.mirror = data;
    if (!$('addressGroupSelect').classList.contains('hidden')) {
      renderQueueOptions(mirrorGroups(), addr.group);
    }
    return true;
  } catch {
    return Boolean(state.mirror);
  }
}

function mirrorToday() {
  const data = state.mirror && state.mirror.fact && state.mirror.fact.data;
  if (!data) return null;
  const today = kyivToday();
  for (const [epoch, dayData] of Object.entries(data)) {
    const day = kyivDateKey(new Date(Number(epoch) * 1000));
    if (day === today) return { date: day, data: dayData };
  }
  return null;
}

function mirrorDay() {
  const today = mirrorToday();
  if (today) return today;
  const data = state.mirror && state.mirror.fact && state.mirror.fact.data;
  if (!data) return null;
  let fallback = null;
  for (const [epoch, dayData] of Object.entries(data)) {
    const day = kyivDateKey(new Date(Number(epoch) * 1000));
    if (!fallback || day < fallback.date) fallback = { date: day, data: dayData };
  }
  return fallback;
}

function mirrorGroups() {
  const day = mirrorDay();
  if (!day || !day.data) return [];
  return Object.keys(day.data).filter((key) => day.data[key] && typeof day.data[key] === 'object').sort(naturalCompare);
}

function segmentStates(value) {
  switch (value) {
    case 'yes': return ['on', 'on'];
    case 'no': return ['off', 'off'];
    case 'first': return ['off', 'on'];
    case 'second': return ['on', 'off'];
    case 'mfirst': return ['unknown', 'on'];
    case 'msecond': return ['on', 'unknown'];
    case 'maybe': return ['unknown', 'unknown'];
    default: return null;
  }
}

function mirrorStates(group) {
  const day = mirrorToday();
  if (!day || !day.data || !day.data[group]) return null;
  const row = day.data[group];
  const out = [];
  for (let hour = 1; hour <= 24; hour++) {
    const parts = segmentStates(row[String(hour)]);
    if (!parts) return null;
    out.push(...parts);
  }
  return out;
}

function workerStates(day) {
  const out = Array(48).fill('on');
  for (const slot of day && Array.isArray(day.slots) ? day.slots : []) {
    const start = Math.max(0, Math.min(48, Math.floor(Number(slot.start) / 30)));
    const end = Math.max(0, Math.min(48, Math.ceil(Number(slot.end) / 30)));
    for (let i = start; i < end; i++) out[i] = slot.state || 'unknown';
  }
  return out;
}

function inferGroup(states) {
  if (!states || states.length !== 48) return '';
  const groups = mirrorGroups();
  const hits = [];
  for (const group of groups) {
    const candidate = mirrorStates(group);
    if (!candidate || candidate.length !== states.length) continue;
    if (candidate.every((v, i) => v === states[i])) hits.push(group);
  }
  return hits.length === 1 ? hits[0] : '';
}

function statesToWindows(states, dayISO) {
  const windows = [];
  let start = null;
  for (let i = 0; i < states.length; i++) {
    if (states[i] === 'off' && start == null) start = i * 30;
    if (states[i] !== 'off' && start != null) {
      windows.push({ from: kyivDate(dayISO, start).toISOString(), to: kyivDate(dayISO, i * 30).toISOString() });
      start = null;
    }
  }
  if (start != null) {
    windows.push({ from: kyivDate(dayISO, start).toISOString(), to: kyivDate(dayISO, 1440).toISOString() });
  }
  return windows;
}

function finalizeStatus(status) {
  const now = new Date();
  status.windows = (status.windows || []).sort((a, b) => new Date(a.from) - new Date(b.from));
  const active = status.windows.find((w) => new Date(w.from) <= now && new Date(w.to) > now);
  const next = status.windows.find((w) => new Date(w.from) > now);
  status.current = active ? { from: active.from, to: active.to, kind: 'За графіком' } : null;
  status.next = next ? { from: next.from, to: next.to } : null;
  return status;
}

function statusFromWorker(data, address) {
  const today = kyivToday();
  const day = (data.days || []).find((item) => item.date === today);
  const baseAddress = {
    street: data.street || address.street,
    house: data.house || address.house,
    group: '',
    groupName: 'За адресою',
  };
  if (!day) {
    return finalizeStatus({
      ok: true,
      address: baseAddress,
      windows: [],
      updated: data.updatedAt,
      fetchedAt: data.fetchedAt,
      source: 'worker',
      stale: false,
      note: 'ДТЕК ще не опублікував графік на сьогодні. Спробуй оновити пізніше.',
    });
  }
  const states = workerStates(day);
  let group = inferGroup(states);
  if (!group && address.group && mirrorStates(address.group)) group = address.group;
  const addressOut = {
    ...baseAddress,
    group,
    groupName: group ? queueName(group) : 'За адресою',
  };
  return finalizeStatus({
    ok: true,
    address: addressOut,
    windows: statesToWindows(states, today),
    updated: data.updatedAt,
    fetchedAt: data.fetchedAt,
    source: 'worker',
    stale: false,
  });
}

function statusFromMirror(group, address) {
  const day = mirrorToday();
  if (!day) throw new Error('У публічній копії немає графіка на сьогодні');
  const states = mirrorStates(group);
  if (!states) throw new Error('Для цієї черги немає графіка на сьогодні');
  const updated = state.mirror && state.mirror.fact ? state.mirror.fact.update : '';
  return finalizeStatus({
    ok: true,
    address: {
      street: address.street,
      house: address.house,
      group,
      groupName: queueName(group),
    },
    windows: statesToWindows(states, day.date),
    updated,
    fetchedAt: new Date().toISOString(),
    source: 'mirror',
    stale: false,
  });
}

/* ------------------------------ модалка -------------------------------- */

const addr = {
  streets: [],
  streetKeys: new Set(),
  houses: [],
  street: '',
  house: '',
  group: '',
  schedule: null,
  lastStreet: '',
  pendingHouse: '',
  lookupSeq: 0,
  scheduleSeq: 0,
  manual: false,
};

function addressStatus(text) {
  const el = $('addressStatus');
  if (el) el.textContent = text;
}

function hideSuggest(id) {
  const box = $(id);
  if (!box) return;
  box.innerHTML = '';
  box.classList.add('hidden');
}

function renderSuggest(id, values, labelFn) {
  const box = $(id);
  if (!box) return;
  if (!values || !values.length) {
    hideSuggest(id);
    return;
  }
  box.innerHTML = values.slice(0, 40).map((v) => {
    const label = labelFn ? labelFn(v) : v;
    return `<button type="button" class="suggest-item" role="option" data-value="${escHtml(v)}">${escHtml(label)}</button>`;
  }).join('');
  box.classList.remove('hidden');
}

function bindSuggest(id, onPick) {
  const box = $(id);
  if (!box) return;
  box.addEventListener('mousedown', (e) => {
    if (e.target.closest('.suggest-item')) e.preventDefault();
  });
  box.addEventListener('click', (e) => {
    const item = e.target.closest('.suggest-item');
    if (!item) return;
    onPick(item.getAttribute('data-value') || '');
    hideSuggest(id);
  });
}

function setGroupLabel(text) {
  const el = $('addressGroup');
  if (el) el.textContent = text || 'визначається автоматично';
}

function setSaveEnabled(on) {
  const btn = $('addressSave');
  if (btn) btn.disabled = !on;
}

function showQueue(show) {
  const select = $('addressGroupSelect');
  if (!select) return;
  select.classList.toggle('hidden', !show);
}

function renderQueueOptions(groups, selected = '') {
  const select = $('addressGroupSelect');
  if (!select) return;
  const list = Array.isArray(groups) ? groups : [];
  select.innerHTML = list.length
    ? '<option value="">— обери чергу —</option>' + list
      .map((group) => `<option value="${escHtml(group)}">${escHtml(queueName(group))}</option>`)
      .join('')
    : '<option value="">— черги ще завантажуються —</option>';
  select.value = list.includes(selected) ? selected : '';
}

function resetHouseSelection() {
  addr.houses = [];
  addr.house = '';
  addr.schedule = null;
  addr.group = '';
  const house = $('addressHouse');
  if (house) {
    house.value = '';
    house.disabled = true;
    house.placeholder = 'Спочатку вибери вулицю';
  }
  hideSuggest('houseSuggest');
  hideSuggest('streetSuggest');
  showQueue(false);
  setGroupLabel('визначається автоматично');
  setSaveEnabled(false);
}

function openAddress() {
  addr.street = '';
  addr.house = '';
  addr.group = '';
  addr.schedule = null;
  addr.lastStreet = '';
  addr.pendingHouse = '';
  addr.lookupSeq++;
  addr.scheduleSeq++;
  hideSuggest('streetSuggest');
  hideSuggest('houseSuggest');
  $('addressModal').classList.remove('hidden');
  $('addressStreet').disabled = false;
  $('addressStreet').value = '';
  $('addressHouse').value = '';
  $('addressHouse').disabled = true;
  $('addressHouse').placeholder = 'Спочатку вибери вулицю';
  renderQueueOptions(mirrorGroups(), '');
  showQueue(false);
  setGroupLabel('визначається автоматично');
  setSaveEnabled(false);
  addressStatus('Почни вводити вулицю — підказки з’являться автоматично');
  renderSuggest('streetSuggest', addr.streets.slice(0, 40), streetLabel);

  if (state.address) {
    $('addressStreet').value = state.address.street || '';
    $('addressHouse').value = state.address.house || '';
    addr.group = state.address.group || '';
    addr.pendingHouse = state.address.house || '';
    if (state.address.street) lookupStreet(state.address.street, { keepHouse: true });
  } else {
    setTimeout(() => $('addressStreet').focus(), 80);
  }
}

function closeAddress() {
  addr.lookupSeq++;
  addr.scheduleSeq++;
  hideSuggest('streetSuggest');
  hideSuggest('houseSuggest');
  $('addressModal').classList.add('hidden');
}

/* --------------------------- пошук адреси ------------------------------ */

async function lookupStreet(raw, { keepHouse = false, pending = '' } = {}) {
  const parsed = splitAddressQuery(raw);
  if (!parsed.house && pending) parsed.house = pending;
  if (parsed.house) addr.pendingHouse = parsed.house;
  const wanted = parsed.street || raw;
  const street = resolveStreet(wanted);
  if (!street || street.length < 2) return;

  if (street === addr.street && addr.houses.length) {
    if (addr.pendingHouse) {
      const key = findHouseKey(addr.pendingHouse);
      if (key) {
        addr.pendingHouse = '';
        selectHouse(key, true);
        return;
      }
    }
    if (!parsed.house) return;
  }

  const seq = ++addr.lookupSeq;
  const preservedGroup = keepHouse ? addr.group : '';
  addr.street = street;
  addr.lastStreet = street;
  addr.house = '';
  addr.group = '';
  addr.schedule = null;
  addr.manual = false;
  addr.pendingHouse = parsed.house || (keepHouse ? addr.pendingHouse : '');
  resetHouseSelection();
  addr.group = preservedGroup;
  if (preservedGroup) setGroupLabel(queueName(preservedGroup));
  $('addressStreet').value = street;
  $('addressHouse').disabled = true;
  $('addressHouse').placeholder = 'Завантажуємо будинки…';
  setGroupLabel('визначається автоматично');
  setSaveEnabled(false);
  showQueue(false);
  addressStatus('Шукаємо будинки в ДТЕК…');

  try {
    const houses = await fetchHouses(street);
    if (seq !== addr.lookupSeq) return;
    addr.houses = houses;
    if (!houses.length) {
      $('addressHouse').disabled = true;
      $('addressHouse').placeholder = 'Немає будинків';
      addressStatus('Для цієї вулиці ДТЕК не вказав будинків');
      return;
    }
    $('addressHouse').disabled = false;
    $('addressHouse').placeholder = 'Почни вводити номер будинку';
    addressStatus(`Знайдено будинків: ${houses.length}. Введи або обери номер.`);

    if (addr.pendingHouse) {
      const key = findHouseKey(addr.pendingHouse);
      if (key) {
        addr.pendingHouse = '';
        selectHouse(key, true);
        return;
      }
      renderSuggest('houseSuggest', houseMatches(addr.pendingHouse), houseLabel);
      addr.house = addr.pendingHouse;
      addressStatus(`Будинку ${addr.pendingHouse} немає в списку. Обери з підказок.`);
      return;
    }

    if (houses.length === 1) {
      selectHouse(houses[0], true);
      return;
    }
  } catch (err) {
    if (seq !== addr.lookupSeq) return;
    addr.houses = [];
    addr.manual = true;
    $('addressHouse').disabled = false;
    $('addressHouse').placeholder = 'Введи номер будинку';
    showQueue(true);
    renderQueueOptions(mirrorGroups(), addr.group);
    setGroupLabel('Обери чергу вручну');
    addressStatus('Список будинків не завантажився. Введи номер вручну й обери чергу — покажемо публічну копію графіка.');
    updateSaveState();
  }
}

function selectHouse(value, canonicalize) {
  const key = findHouseKey(value);
  const house = key || String(value || '').trim();
  if (!house) return;
  addr.house = house;
  addr.manual = !key && !addr.houses.length;
  if (canonicalize) $('addressHouse').value = houseLabel(house);
  else $('addressHouse').value = house;
  hideSuggest('houseSuggest');
  updateSaveState();
  fetchAddressSchedule();
}

async function fetchAddressSchedule() {
  const street = addr.street;
  const house = addr.house;
  if (!street || !house || addr.manual) return;

  const seq = ++addr.scheduleSeq;
  setSaveEnabled(false);
  setGroupLabel('Перевіряємо адресу…');
  addressStatus('Отримуємо графік ДТЕК для цієї адреси…');

  try {
    const data = await fetchSchedule(street, house, { force: true });
    if (seq !== addr.scheduleSeq) return;
    addr.schedule = data;
    const status = statusFromWorker(data, { street, house, group: addr.group });
    addr.group = status.address.group || '';
    if (addr.group) {
      setGroupLabel(`${queueName(addr.group)} · визначено`);
      showQueue(false);
    } else {
      setGroupLabel('Черга за адресою');
      showQueue(false);
    }
    setSaveEnabled(true);
    addressStatus(status.windows.length
      ? 'Графік на сьогодні отримано. Збережи адресу.'
      : 'ДТЕК не показав відключень на сьогодні. Збережи адресу.');
  } catch (err) {
    if (seq !== addr.scheduleSeq) return;
    addr.schedule = null;
    showQueue(true);
    renderQueueOptions(mirrorGroups(), addr.group);
    setGroupLabel(addr.group ? queueName(addr.group) : 'Обери чергу вручну');
    addressStatus('Пошук за адресою не відповів. Обери чергу вручну — покажемо публічну копію графіка ДТЕК.');
    updateSaveState();
  }
}

function updateSaveState() {
  const hasAddress = Boolean(addr.street && addr.house);
  const hasData = Boolean(addr.schedule || addr.group);
  setSaveEnabled(hasAddress && hasData);
}

function onStreetInput() {
  const raw = $('addressStreet').value.trim();
  renderSuggest('streetSuggest', streetMatches(raw), streetLabel);
  const parsed = splitAddressQuery(raw);
  const wanted = parsed.house ? parsed.street : raw;
  const sameStreet = Boolean(addr.street) && normalizeStreet(wanted) === normalizeStreet(addr.street);

  // Typing a house number after a resolved street must not throw away the
  // already loaded house list. Only a different street resets everything.
  if (!sameStreet && raw !== addr.lastStreet) {
    addr.house = '';
    addr.schedule = null;
    addr.group = '';
    addr.houses = [];
    $('addressHouse').value = '';
    $('addressHouse').disabled = true;
    $('addressHouse').placeholder = 'Спочатку вибери вулицю';
    hideSuggest('houseSuggest');
    showQueue(false);
    setGroupLabel('визначається автоматично');
    setSaveEnabled(false);
  } else if (sameStreet) {
    addr.house = '';
    addr.schedule = null;
    addr.group = '';
    $('addressHouse').value = '';
    $('addressHouse').disabled = !(addr.houses.length || addr.manual);
    $('addressHouse').placeholder = addr.houses.length || addr.manual
      ? 'Почни вводити номер будинку'
      : 'Завантажуємо будинки…';
    hideSuggest('houseSuggest');
    showQueue(false);
    setGroupLabel('визначається автоматично');
    setSaveEnabled(false);
  }

  addr.pendingHouse = parsed.house;
  if (!raw) {
    addressStatus('Почни вводити вулицю — підказки з’являться автоматично');
    return;
  }
  if (raw.length < 2) return;
  const exact = exactStreet(wanted);
  if (exact && !addr.schedule) {
    lookupStreet(raw);
  }
}

function onStreetFocus() {
  if (!addr.streets.length) return;
  const raw = $('addressStreet').value.trim();
  renderSuggest('streetSuggest', raw ? streetMatches(raw) : addr.streets.slice(0, 40), streetLabel);
}

function onStreetBlur() {
  setTimeout(() => {
    hideSuggest('streetSuggest');
    const raw = $('addressStreet').value.trim();
    if (raw.length < 2) return;
    const parsed = splitAddressQuery(raw);
    const wanted = parsed.house ? parsed.street : raw;
    if (parsed.house) addr.pendingHouse = parsed.house;
    const resolved = uniqueStreet(wanted);
    if (resolved) {
      if ($('addressStreet').value !== resolved) $('addressStreet').value = resolved;
      lookupStreet(raw);
      return;
    }
    const matches = addr.streets.length ? streetMatches(wanted) : [];
    if (matches.length === 1) {
      $('addressStreet').value = matches[0];
      lookupStreet(raw);
    } else if (matches.length > 1) {
      renderSuggest('streetSuggest', matches, streetLabel);
      addressStatus(parsed.house
        ? `Уточни вулицю для будинку ${parsed.house} — обери потрібний варіант`
        : 'Уточни вулицю — обери потрібний варіант зі списку');
    } else {
      lookupStreet(wanted);
    }
  }, 250);
}

function pickStreet(value) {
  const typedHouse = splitAddressQuery($('addressStreet').value).house;
  const chosenHouse = embeddedHouse(value);
  addr.pendingHouse = chosenHouse ? '' : typedHouse;
  $('addressStreet').value = value;
  addr.lastStreet = '';
  addr.schedule = null;
  hideSuggest('streetSuggest');
  lookupStreet(value, { pending: addr.pendingHouse });
  $('addressStreet').blur();
}

function onHouseInput() {
  const raw = $('addressHouse').value.trim();
  addr.house = raw;
  if (addr.houses.length) {
    renderSuggest('houseSuggest', houseMatches(raw), houseLabel);
  }
  updateSaveState();
}

function onHouseFocus() {
  if (addr.houses.length) {
    renderSuggest('houseSuggest', houseMatches($('addressHouse').value.trim()), houseLabel);
  }
}

function onHouseBlur() {
  setTimeout(() => {
    hideSuggest('houseSuggest');
    const raw = $('addressHouse').value.trim();
    if (!raw) return;
    const key = findHouseKey(raw);
    if (key) {
      selectHouse(key, true);
      return;
    }
    if (addr.houses.length) {
      const matches = houseMatches(raw);
      if (matches.length === 1) {
        selectHouse(matches[0], true);
        return;
      }
      if (matches.length > 1) {
        renderSuggest('houseSuggest', matches, houseLabel);
        addressStatus('Уточни номер будинку — обери з підказок');
      } else {
        // Sometimes DTEK does not list a house under this street (or uses a
        // different spelling). Do not trap the user: let them keep the typed
        // house and pick the queue manually.
        addr.manual = true;
        addr.schedule = null;
        addr.group = '';
        showQueue(true);
        renderQueueOptions(mirrorGroups(), '');
        setGroupLabel('Обери чергу вручну');
        addressStatus('Цього будинку немає в списку ДТЕК. Обери чергу вручну — графік буде з публічної копії.');
      }
    }
    addr.house = raw;
    updateSaveState();
  }, 250);
}

function pickHouse(value) {
  selectHouse(value, true);
  $('addressHouse').blur();
}

function onGroupChange() {
  const select = $('addressGroupSelect');
  if (!select) return;
  addr.group = select.value || '';
  addr.schedule = null;
  if (addr.group) {
    setGroupLabel(`${queueName(addr.group)} · вибрано вручну`);
    addressStatus('Буде використано публічну копію графіка ДТЕК для цієї черги.');
  } else {
    setGroupLabel('Обери чергу вручну');
  }
  updateSaveState();
}

function saveAddress() {
  const street = addr.street || resolveStreet($('addressStreet').value);
  const house = addr.house || $('addressHouse').value.trim();
  if (!street || !house) {
    addressStatus('Обери вулицю та будинок зі списку');
    return;
  }
  if (!addr.schedule && !addr.group) {
    showQueue(true);
    renderQueueOptions(mirrorGroups(), addr.group);
    addressStatus('Черга ще не визначена — обери її в списку нижче');
    return;
  }

  const address = {
    street,
    house,
    group: addr.group || '',
    groupName: addr.group ? queueName(addr.group) : 'За адресою',
    mode: addr.schedule ? 'address' : 'group',
  };

  let status;
  try {
    if (addr.schedule) status = statusFromWorker(addr.schedule, address);
    else status = statusFromMirror(addr.group, address);
  } catch (err) {
    addressStatus(err.message || 'Не вдалося побудувати графік');
    return;
  }

  state.address = address;
  state.status = status;
  state.prev = null;
  saveAddressStorage(address);
  if (addr.schedule) saveScheduleStorage(addr.schedule, address);
  render(status);
  scheduleAlerts(status);
  closeAddress();
}

/* ------------------------------ оновлення ------------------------------ */

async function refresh({ manual = false } = {}) {
  if (!state.address || state.loading) return;
  const btn = $('refreshBtn');
  state.loading = true;
  if (manual) btn.classList.add('is-busy');
  btn.disabled = true;

  try {
    if (state.address.mode === 'group') {
      await loadMirror();
      const before = state.status;
      state.prev = before ? computeView(before) : null;
      const status = statusFromMirror(state.address.group, state.address);
      state.status = status;
      render(status);
      detectTransition();
      scheduleAlerts(status);
      return;
    }
    const data = await fetchSchedule(state.address.street, state.address.house, { force: manual });
    const before = state.status;
    state.prev = before ? computeView(before) : null;
    const status = statusFromWorker(data, state.address);
    state.status = status;
    saveScheduleStorage(data, state.address);
    render(status);
    detectTransition();
    scheduleAlerts(status);
  } catch (err) {
    const note = 'Немає свіжих даних від ДТЕК. Показуємо останній відомий графік.';
    if (state.status) {
      state.status.stale = true;
      state.status.note = note;
      render(state.status);
    } else if (state.address.group && state.mirror) {
      try {
        const status = statusFromMirror(state.address.group, state.address);
        status.stale = true;
        status.note = note;
        state.status = status;
        render(status);
      } catch {
        renderError(err);
      }
    } else {
      const cached = loadScheduleStorage();
      if (cached && normalizeStreet(cached.address.street) === normalizeStreet(state.address.street)
          && normalizeHouse(cached.address.house) === normalizeHouse(state.address.house)) {
        const status = statusFromWorker(cached.data, state.address);
        status.stale = true;
        status.source = 'cache';
        status.note = note;
        state.status = status;
        render(status);
      } else {
        renderError(err);
      }
    }
  } finally {
    state.loading = false;
    if (manual) btn.classList.remove('is-busy');
    btn.disabled = false;
  }
}

/* ----------------------------- сповіщення ------------------------------ */

function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = {
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: tag || `svitlo-${Date.now()}`,
    renotify: true,
  };
  if (navigator.serviceWorker) {
    navigator.serviceWorker.getRegistration()
      .then((reg) => reg ? reg.showNotification(title, options) : new Notification(title, options))
      .catch(() => { try { new Notification(title, options); } catch {} });
  } else {
    try { new Notification(title, options); } catch {}
  }
}

function clearTimers() {
  state.timers.forEach(clearTimeout);
  state.timers = [];
}

function scheduleAlerts(status) {
  clearTimers();
  if (!state.notifyEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;

  const now = Date.now();
  const horizon = now + 24 * 60 * 60 * 1000;
  const events = [];
  const seen = new Set();

  const push = (at, title, body, key) => {
    if (at <= now + 5000 || at > horizon || seen.has(key)) return;
    seen.add(key);
    events.push({ at, title, body, key });
  };

  for (const w of status.windows || []) {
    const from = new Date(w.from);
    const to = new Date(w.to);
    const range = fmtRange(from, to);
    push(from.getTime() - alertCfg.beforeOff * 60000, alertTitle(alertCfg.beforeOff, 'off'), `${range}. Підготуйся.`, `start-${from.getTime()}-${alertCfg.beforeOff}`);
    push(to.getTime() - alertCfg.beforeOn * 60000, alertTitle(alertCfg.beforeOn, 'on'), `Орієнтовно о ${fmtTime(to)}.`, `end-${to.getTime()}-${alertCfg.beforeOn}`);
  }

  if (status.current) {
    const to = new Date(status.current.to);
    push(to.getTime() - alertCfg.beforeOn * 60000, alertTitle(alertCfg.beforeOn, 'on'), `Орієнтовно о ${fmtTime(to)}.`, `end-${to.getTime()}-${alertCfg.beforeOn}`);
  }

  for (const ev of events) {
    const id = setTimeout(() => notify(ev.title, ev.body, ev.key), ev.at - now);
    state.timers.push(id);
  }
}

function detectTransition() {
  if (!state.prev || !state.status || !state.notifyEnabled) return;
  const beforeOff = state.prev.off;
  const afterOff = computeView(state.status).off;
  if (beforeOff && !afterOff) notify('Світло з’явилося', 'За графіком відключення завершилося.', 'power-on');
  else if (!beforeOff && afterOff) notify('Світло зникло', 'Почалося відключення.', 'power-off');
}

function updateNotifyUI() {
  const btn = $('notifyBtn');
  const hint = $('notifyHint');
  const test = $('testBtn');
  if (!btn || !hint || !test) return;

  if (!('Notification' in window)) {
    btn.disabled = true;
    btn.textContent = 'Сповіщення недоступні';
    hint.textContent = 'Браузер не підтримує Notification API';
    return;
  }

  if (state.notifyEnabled && Notification.permission === 'granted') {
    btn.textContent = 'Сповіщення увімкнено';
    btn.classList.add('is-on');
    hint.textContent = alertHintText();
    test.classList.remove('hidden');
  } else {
    btn.textContent = 'Увімкнути сповіщення';
    btn.classList.remove('is-on');
    hint.textContent = alertHintText();
    test.classList.add('hidden');
  }
}

async function enableNotifications() {
  if (!('Notification' in window)) return;
  if (state.notifyEnabled && Notification.permission === 'granted') {
    state.notifyEnabled = false;
    localStorage.setItem('svitlo-notify', '0');
    clearTimers();
    updateNotifyUI();
    return;
  }
  let permission = Notification.permission;
  if (permission !== 'granted') permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    $('notifyHint').textContent = 'Дозвіл не надано — сповіщення не працюватимуть';
    return;
  }
  state.notifyEnabled = true;
  localStorage.setItem('svitlo-notify', '1');
  updateNotifyUI();
  if (state.status) scheduleAlerts(state.status);
  notify('Сповіщення увімкнено', 'Попередимо заздалегідь до відключення.', 'welcome');
}

/* -------------------------------- старт -------------------------------- */

function bind() {
  $('refreshBtn').addEventListener('click', () => refresh({ manual: true }));
  $('notifyBtn').addEventListener('click', enableNotifications);
  $('beforeOff').addEventListener('change', saveAlertCfg);
  $('beforeOn').addEventListener('change', saveAlertCfg);
  $('addressBtn').addEventListener('click', openAddress);
  $('addressClose').addEventListener('click', closeAddress);
  $('addressCancel').addEventListener('click', closeAddress);
  $('addressStreet').addEventListener('input', onStreetInput);
  $('addressStreet').addEventListener('focus', onStreetFocus);
  $('addressStreet').addEventListener('blur', onStreetBlur);
  $('addressGroupSelect').addEventListener('change', onGroupChange);
  $('addressHouse').addEventListener('input', onHouseInput);
  $('addressHouse').addEventListener('focus', onHouseFocus);
  $('addressHouse').addEventListener('blur', onHouseBlur);
  $('addressSave').addEventListener('click', saveAddress);
  bindSuggest('streetSuggest', pickStreet);
  bindSuggest('houseSuggest', pickHouse);
  $('testBtn').addEventListener('click', () => {
    notify('Перевірка', 'Сповіщення працюють.', `test-${Date.now()}`);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateNotifyUI();
      refresh();
    }
  });
  window.addEventListener('online', () => refresh());
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

function init() {
  addr.streets = Array.isArray(window.SVITLO_STREETS)
    ? [...new Set(window.SVITLO_STREETS.map((s) => String(s || '').trim()).filter(Boolean))].sort(naturalCompare)
    : [];
  addr.streetKeys = new Set(addr.streets.map(normalizeStreet));

  bind();
  registerSW();
  loadAlertCfg();
  fillAlertSelects();
  updateNotifyUI();
  loadMirror();

  const saved = loadAddressStorage();
  const cached = loadScheduleStorage();
  if (saved) {
    state.address = saved;
    if (saved.mode !== 'group' && cached
      && normalizeStreet(cached.address.street) === normalizeStreet(saved.street)
      && normalizeHouse(cached.address.house) === normalizeHouse(saved.house)) {
      try {
        state.status = statusFromWorker(cached.data, saved);
        if (Date.now() - cached.at > 30 * 60 * 1000) {
          state.status.stale = true;
          state.status.note = 'Показано збережений графік. Перевіряємо свіжі дані ДТЕК…';
        }
        render(state.status);
      } catch {}
    } else {
      renderNeedAddress();
      $('statusTitle').textContent = 'Завантаження…';
      $('statusSub').textContent = 'Отримуємо графік ДТЕК для збереженої адреси';
    }
    refresh();
  } else {
    renderNeedAddress();
    setTimeout(openAddress, 250);
  }

  setInterval(renderCountdown, 1000);
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, REFRESH_MS);
}

init();
