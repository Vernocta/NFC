'use strict';

const config = require('./config');
const time = require('./time');

/** Shifts in a date range, newest first, optionally for one worker. */
function listShifts(db, { from, to, workerId = null, includeOpen = true } = {}) {
  const clauses = ['s.business_day BETWEEN ? AND ?'];
  const params = [from, to];
  if (workerId) {
    clauses.push('s.worker_id = ?');
    params.push(workerId);
  }
  if (!includeOpen) clauses.push("s.status != 'open'");

  return db
    .prepare(
      `SELECT s.*, w.code AS worker_code, w.full_name, w.document_id, w.role, w.hourly_rate,
              w.dux_employee_id, o.status AS dux_status, o.last_error AS dux_error
         FROM shifts s
         JOIN workers w ON w.id = s.worker_id
         LEFT JOIN dux_outbox o ON o.shift_id = s.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY s.business_day DESC, s.started_at DESC`
    )
    .all(...params)
    .map(decorate);
}

function decorate(row) {
  const tz = config.timezone;
  const minutes = row.minutes ?? (row.status === 'open' ? time.minutesBetween(row.started_at, time.nowIso()) : 0);
  return {
    id: row.id,
    workerId: row.worker_id,
    workerCode: row.worker_code,
    fullName: row.full_name,
    documentId: row.document_id,
    role: row.role,
    hourlyRate: row.hourly_rate,
    duxEmployeeId: row.dux_employee_id,
    businessDay: row.business_day,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    startLocal: time.localTime(row.started_at, tz),
    endLocal: row.ended_at ? time.localTime(row.ended_at, tz) : null,
    minutes,
    hours: time.decimalHours(minutes),
    breakMinutes: row.break_minutes,
    status: row.status,
    note: row.note,
    duxStatus: row.dux_status || (row.status === 'open' ? null : 'pending'),
    duxError: row.dux_error || null,
  };
}

/** One line per worker for the range: days worked, hours, and pay if a rate is set. */
function summarize(shifts) {
  const byWorker = new Map();
  for (const shift of shifts) {
    if (shift.status === 'open') continue;
    let entry = byWorker.get(shift.workerId);
    if (!entry) {
      entry = {
        workerId: shift.workerId,
        workerCode: shift.workerCode,
        fullName: shift.fullName,
        documentId: shift.documentId,
        duxEmployeeId: shift.duxEmployeeId,
        hourlyRate: shift.hourlyRate,
        shifts: 0,
        days: new Set(),
        minutes: 0,
      };
      byWorker.set(shift.workerId, entry);
    }
    entry.shifts += 1;
    entry.days.add(shift.businessDay);
    entry.minutes += shift.minutes;
  }

  return [...byWorker.values()]
    .map((e) => ({
      workerId: e.workerId,
      workerCode: e.workerCode,
      fullName: e.fullName,
      documentId: e.documentId,
      duxEmployeeId: e.duxEmployeeId,
      shifts: e.shifts,
      days: e.days.size,
      minutes: e.minutes,
      hours: time.decimalHours(e.minutes),
      hourlyRate: e.hourlyRate,
      amount: e.hourlyRate ? Math.round(time.decimalHours(e.minutes) * e.hourlyRate * 100) / 100 : null,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

const escapeCell = (value) => {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(headers, rows, { delimiter = ',' } = {}) {
  const lines = [headers.map(escapeCell).join(delimiter)];
  for (const row of rows) lines.push(row.map(escapeCell).join(delimiter));
  // BOM keeps accented names readable when the file is opened in Excel.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Shift-level export: the file to hand to Dux when pushing via API is not an option. */
function shiftsCsv(shifts, options = {}) {
  const headers = [
    'legajo',
    'empleado',
    'documento',
    'dux_empleado_id',
    'fecha',
    'entrada',
    'salida',
    'minutos',
    'horas',
    'minutos_descanso',
    'estado',
    'observacion',
  ];
  const rows = shifts.map((s) => [
    s.workerCode,
    s.fullName,
    s.documentId,
    s.duxEmployeeId,
    s.businessDay,
    s.startLocal,
    s.endLocal,
    s.minutes,
    s.hours.toFixed(2),
    s.breakMinutes,
    s.status,
    s.note,
  ]);
  return toCsv(headers, rows, options);
}

/** Worker-level totals, the shape payroll usually wants. */
function summaryCsv(summary, options = {}) {
  const headers = [
    'legajo',
    'empleado',
    'documento',
    'dux_empleado_id',
    'dias',
    'turnos',
    'horas',
    'valor_hora',
    'importe',
  ];
  const rows = summary.map((s) => [
    s.workerCode,
    s.fullName,
    s.documentId,
    s.duxEmployeeId,
    s.days,
    s.shifts,
    s.hours.toFixed(2),
    s.hourlyRate ?? '',
    s.amount ?? '',
  ]);
  return toCsv(headers, rows, options);
}

module.exports = { listShifts, summarize, shiftsCsv, summaryCsv, toCsv };
