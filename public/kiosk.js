/* eslint-env browser */
'use strict';

/**
 * Kiosk terminal.
 *
 * USB NFC readers behave like keyboards: they "type" the tag UID and usually
 * press Enter. We listen at the document level so the terminal works even if
 * nothing is focused, and fall back to a short idle timeout for readers that
 * never send Enter. Android phones with Web NFC can scan through the same UI.
 */

const params = new URLSearchParams(location.search);
const store = {
  get(key, fallback = '') {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: device settings just won't persist */
    }
  },
};

if (params.get('device')) store.set('kiosk.device', params.get('device'));
if (params.get('key')) store.set('kiosk.deviceKey', params.get('key'));

const DEVICE = store.get('kiosk.device', 'kiosk-1');
const DEVICE_KEY = store.get('kiosk.deviceKey', '');
const IDLE_RESET_MS = 7000;
const WEDGE_IDLE_MS = 250;
const MIN_UID_LENGTH = 4;

let lang = params.get('lang') || 'es';
let t = window.I18N[lang] || window.I18N.es;
let timezone = 'America/Argentina/Buenos_Aires';
let resetTimer = null;

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'),
  icon: $('stage-icon'),
  headline: $('stage-headline'),
  name: $('stage-name'),
  detail: $('stage-detail'),
  hint: $('stage-hint'),
  time: $('clock-time'),
  date: $('clock-date'),
  connDot: $('conn-dot'),
  connText: $('conn-text'),
  devicePill: $('device-pill'),
  onsiteList: $('onsite-list'),
  onsiteCount: $('onsite-count'),
  onsiteTitle: $('onsite-title'),
  wedge: $('wedge'),
};

/* ------------------------------------------------------------------ clock */

function tickClock() {
  const now = new Date();
  el.time.textContent = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'es-AR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  el.date.textContent = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'es-AR', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
}

/* ------------------------------------------------------------------ sound */

let audioCtx = null;
function beep(pattern) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    pattern.forEach(([freq, startMs, durMs], index) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = 0.0001;
      osc.connect(gain).connect(audioCtx.destination);
      const start = audioCtx.currentTime + startMs / 1000;
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + durMs / 1000);
      osc.start(start);
      osc.stop(start + durMs / 1000 + 0.02);
      void index;
    });
  } catch {
    /* audio is a nicety, never a blocker */
  }
}
const SOUNDS = {
  in: [[660, 0, 120], [990, 110, 160]],
  out: [[880, 0, 120], [560, 110, 180]],
  warn: [[520, 0, 200]],
  error: [[220, 0, 260], [180, 200, 320]],
};

/* ------------------------------------------------------------------ stage */

const humanMinutes = (minutes) => {
  const m = Math.max(0, Math.round(minutes || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

const localTime = (iso) =>
  new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'es-AR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

function render({ tone = '', icon = '📶', headline, name = '', detail = '', hint = '', pulse = false }) {
  el.stage.className = `stage${tone ? ` stage--${tone}` : ''}`;
  el.icon.textContent = icon;
  el.icon.classList.toggle('pulse', pulse);
  el.headline.textContent = headline;
  el.name.textContent = name;
  el.name.hidden = !name;
  el.detail.textContent = detail;
  el.hint.textContent = hint;
}

function showIdle() {
  clearTimeout(resetTimer);
  render({
    icon: '📶',
    headline: t.idleHeadline,
    detail: t.idleDetail,
    pulse: true,
    hint: nfcSupported() ? t.nfcScan : '',
  });
}

function scheduleIdle(ms = IDLE_RESET_MS) {
  clearTimeout(resetTimer);
  resetTimer = setTimeout(showIdle, ms);
}

function showResult(data) {
  const worker = data.worker || {};
  switch (data.result) {
    case 'checked_in':
      beep(SOUNDS.in);
      render({
        tone: 'in',
        icon: '✅',
        headline: t.checkedIn,
        name: worker.fullName,
        detail: `${t.startedAt} ${localTime(data.at)}${
          data.minutesToday ? ` · ${t.todayTotal} ${humanMinutes(data.minutesToday)}` : ''
        }`,
      });
      break;
    case 'checked_out':
      beep(SOUNDS.out);
      render({
        tone: 'out',
        icon: '👋',
        headline: t.checkedOut,
        name: worker.fullName,
        detail: `${t.shiftTotal} ${humanMinutes(data.minutesThisShift)} · ${t.todayTotal} ${humanMinutes(
          data.minutesToday
        )}`,
      });
      break;
    case 'duplicate':
      beep(SOUNDS.warn);
      render({
        tone: 'warn',
        icon: '⏳',
        headline: t.duplicate,
        name: worker.fullName,
        detail: `${data.direction === 'in' ? t.checkedIn : t.checkedOut} · ${localTime(data.at)}`,
      });
      break;
    case 'enrolled':
      beep(SOUNDS.in);
      render({ tone: 'in', icon: '🔑', headline: t.enrolled, name: worker.fullName, detail: data.uid });
      break;
    case 'already_enrolled':
      beep(SOUNDS.warn);
      render({ tone: 'warn', icon: '🔑', headline: t.enrolled, name: worker.fullName, detail: data.uid });
      break;
    case 'tag_taken':
      beep(SOUNDS.error);
      render({ tone: 'error', icon: '⛔', headline: t.tagTaken, name: data.takenBy, detail: data.uid });
      break;
    case 'inactive_worker':
      beep(SOUNDS.error);
      render({
        tone: 'error',
        icon: '⛔',
        headline: t.inactiveWorker,
        name: worker.fullName,
        detail: t.inactiveWorkerDetail,
      });
      break;
    case 'unknown_tag':
      beep(SOUNDS.error);
      render({ tone: 'error', icon: '❔', headline: t.unknownTag, detail: t.unknownTagDetail, hint: data.uid });
      break;
    default:
      beep(SOUNDS.error);
      render({ tone: 'error', icon: '⚠️', headline: t.invalidUid, detail: t.tapAgain });
  }
  scheduleIdle();
  refreshStatus();
}

/* ------------------------------------------------------------------- net */

function setConnection(ok) {
  el.connDot.className = `dot ${ok ? 'dot--ok' : 'dot--bad'}`;
  el.connText.textContent = ok ? t.connected : t.disconnected;
}

async function submitScan(uid) {
  render({ icon: '⏱', headline: t.reading, detail: '' });
  try {
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(DEVICE_KEY ? { 'x-device-key': DEVICE_KEY } : {}) },
      body: JSON.stringify({ uid, device: DEVICE }),
    });
    const data = await response.json();
    setConnection(true);
    if (!response.ok) {
      beep(SOUNDS.error);
      render({ tone: 'error', icon: '⚠️', headline: t.invalidUid, detail: data.error || '' });
      scheduleIdle();
      return;
    }
    showResult(data);
  } catch {
    setConnection(false);
    beep(SOUNDS.error);
    render({ tone: 'error', icon: '📡', headline: t.offline, detail: t.offlineDetail });
    scheduleIdle();
  }
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('status');
    const data = await response.json();
    setConnection(true);
    timezone = data.timezone || timezone;
    renderOnSite(data.onSite || []);
    if (data.enrollment?.armed && el.headline.textContent === t.idleHeadline) {
      render({ tone: 'warn', icon: '🔑', headline: t.enrollArmed, detail: '', pulse: true });
    }
  } catch {
    setConnection(false);
  }
}

function renderOnSite(list) {
  el.onsiteTitle.textContent = t.onSite;
  el.onsiteCount.textContent = String(list.length);
  if (!list.length) {
    el.onsiteList.innerHTML = `<span class="muted" style="font-size:13px">${t.nobody}</span>`;
    return;
  }
  el.onsiteList.innerHTML = list
    .map(
      (w) =>
        `<span class="chip">${escapeHtml(w.fullName)}<span>${t.since} ${localTime(w.startedAt)}</span></span>`
    )
    .join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/* ---------------------------------------------------------- reader input */

let buffer = '';
let wedgeTimer = null;

function flushBuffer() {
  const uid = buffer.trim();
  buffer = '';
  clearTimeout(wedgeTimer);
  if (uid.length >= MIN_UID_LENGTH) submitScan(uid);
}

document.addEventListener('keydown', (event) => {
  // Let the operator use the page normally if a real field has the focus.
  const target = event.target;
  if (target && target !== el.wedge && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

  if (event.key === 'Enter') {
    event.preventDefault();
    flushBuffer();
    return;
  }
  if (event.key.length !== 1) return;
  buffer += event.key;
  if (buffer.length > 64) buffer = buffer.slice(-64);
  clearTimeout(wedgeTimer);
  // Readers that never send Enter still get their scan submitted.
  wedgeTimer = setTimeout(flushBuffer, WEDGE_IDLE_MS);
});

// Keep an input focused so tablets don't pop up the on-screen keyboard elsewhere.
const keepFocus = () => el.wedge.focus({ preventScroll: true });
document.addEventListener('click', keepFocus);
window.addEventListener('focus', keepFocus);

/* ------------------------------------------------------------- web nfc */

const nfcSupported = () => 'NDEFReader' in window;

async function startWebNfc() {
  if (!nfcSupported()) return;
  try {
    const reader = new NDEFReader();
    await reader.scan();
    reader.addEventListener('reading', ({ serialNumber }) => {
      if (serialNumber) submitScan(serialNumber);
    });
    el.devicePill.hidden = false;
    el.devicePill.textContent = 'NFC';
  } catch {
    /* permission denied or not a secure context: the wedge path still works */
  }
}
document.addEventListener('click', () => startWebNfc(), { once: true });

/* -------------------------------------------------------------- bootstrap */

async function boot() {
  try {
    const response = await fetch('/api/config');
    if (response.ok) {
      const cfg = await response.json();
      timezone = cfg.timezone || timezone;
      if (!params.get('lang') && cfg.lang) lang = cfg.lang;
      t = window.I18N[lang] || window.I18N.es;
      setConnection(true);
    }
  } catch {
    setConnection(false);
  }
  el.devicePill.hidden = false;
  el.devicePill.textContent = DEVICE;
  showIdle();
  tickClock();
  setInterval(tickClock, 1000);
  refreshStatus();
  setInterval(refreshStatus, 15000);
  keepFocus();
}

boot();
