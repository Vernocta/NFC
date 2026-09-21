'use strict';

const PART_FORMATTERS = new Map();

function formatter(timezone) {
  let f = PART_FORMATTERS.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PART_FORMATTERS.set(timezone, f);
  }
  return f;
}

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`Invalid date: ${value}`);
  return d;
}

/** Local calendar/clock parts of an instant in the configured timezone. */
function localParts(value, timezone) {
  const parts = {};
  for (const p of formatter(timezone).formatToParts(toDate(value))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // Intl returns "24" for midnight in some ICU builds.
  if (parts.hour === '24') parts.hour = '00';
  return parts;
}

/** "YYYY-MM-DD" local date. */
function localDate(value, timezone) {
  const p = localParts(value, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "HH:MM" local wall clock. */
function localTime(value, timezone) {
  const p = localParts(value, timezone);
  return `${p.hour}:${p.minute}`;
}

/** "YYYY-MM-DD HH:MM:SS" local, the shape Dux imports expect. */
function localStamp(value, timezone) {
  const p = localParts(value, timezone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * The business day an instant belongs to. With a cutoff hour > 0, anything
 * earlier than that local hour is booked to the previous day, so a night
 * shift that ends at 03:00 stays on the day it started.
 */
function businessDay(value, timezone, cutoffHour = 0) {
  const p = localParts(value, timezone);
  const day = `${p.year}-${p.month}-${p.day}`;
  if (!cutoffHour || Number(p.hour) >= cutoffHour) return day;
  return addDays(day, -1);
}

/** Shift a "YYYY-MM-DD" string by whole days. */
function addDays(isoDay, delta) {
  const d = new Date(`${isoDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

/** How far the zone is ahead of UTC at this instant, in milliseconds. */
function zoneOffsetMs(value, timezone) {
  const p = localParts(value, timezone);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );
  return asUtc - Math.floor(toDate(value).getTime() / 1000) * 1000;
}

/**
 * The instant at which a wall-clock time occurs in a timezone.
 * The offset is re-read at the candidate instant so the result stays correct
 * across a daylight-saving change.
 */
function zonedTimeToUtc(isoDay, hour, minute, timezone) {
  const wallAsUtc = Date.UTC(
    Number(isoDay.slice(0, 4)),
    Number(isoDay.slice(5, 7)) - 1,
    Number(isoDay.slice(8, 10)),
    hour,
    minute,
    0
  );
  let instant = new Date(wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timezone));
  const refined = zoneOffsetMs(instant, timezone);
  const candidate = new Date(wallAsUtc - refined);
  if (candidate.getTime() !== instant.getTime()) instant = candidate;
  return instant;
}

/** "17:00" -> { hour: 17, minute: 0 }. Falls back to 17:00 on garbage input. */
function parseClockTime(value, fallback = '17:00') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim()) || /^(\d{1,2}):(\d{2})$/.exec(fallback);
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return { hour, minute };
}

/** The next occurrence of a local wall-clock time, strictly after `from`. */
function nextOccurrence(from, { hour, minute }, timezone) {
  const today = localDate(from, timezone);
  const todayRun = zonedTimeToUtc(today, hour, minute, timezone);
  if (todayRun.getTime() > toDate(from).getTime()) return todayRun;
  return zonedTimeToUtc(addDays(today, 1), hour, minute, timezone);
}

function minutesBetween(startIso, endIso) {
  return Math.max(0, Math.round((toDate(endIso) - toDate(startIso)) / 60000));
}

/** Round to the nearest `step` minutes (0 disables rounding). */
function roundMinutes(minutes, step) {
  if (!step || step <= 0) return minutes;
  return Math.round(minutes / step) * step;
}

/** Human "7h 45m" from a minute count. */
function humanMinutes(minutes) {
  const m = Math.max(0, Math.round(minutes || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Decimal hours with 2 decimals, the unit payroll systems total on. */
function decimalHours(minutes) {
  return Math.round(((minutes || 0) / 60) * 100) / 100;
}

module.exports = {
  localParts,
  zoneOffsetMs,
  zonedTimeToUtc,
  parseClockTime,
  nextOccurrence,
  localDate,
  localTime,
  localStamp,
  businessDay,
  addDays,
  nowIso,
  minutesBetween,
  roundMinutes,
  humanMinutes,
  decimalHours,
};
