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
