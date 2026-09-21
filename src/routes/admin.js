'use strict';

const express = require('express');
const config = require('../config');
const time = require('../time');
const clock = require('../clock');
const dux = require('../dux');
const timesheet = require('../timesheet');
const { getDb } = require('../db');
const { normalizeUid } = require('../uid');

const router = express.Router();

/** Bearer token (or x-admin-token) on every admin route. */
router.use((req, res, next) => {
  if (!config.adminToken) {
    return res.status(503).json({ error: 'admin_token_not_configured' });
  }
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-admin-token');
  if (token !== config.adminToken) return res.status(401).json({ error: 'unauthorized' });
  return next();
});

const bad = (res, error, status = 400) => res.status(status).json({ error });
const trim = (v) => (typeof v === 'string' ? v.trim() : v);

function defaultRange(query) {
  const today = time.businessDay(time.nowIso(), config.timezone, config.dayCutoffHour);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : time.addDays(today, -13);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : today;
  const workerId = query.workerId ? Number(query.workerId) : null;
  return { from, to, workerId: Number.isFinite(workerId) ? workerId : null };
}

router.get('/ping', (req, res) => res.json({ ok: true, serverTime: time.nowIso() }));

/* ---------------------------------------------------------------- workers */

router.get('/workers', (req, res) => {
  const includeInactive = req.query.includeInactive === 'true';
  const rows = getDb()
    .prepare(
      `SELECT w.*, (SELECT COUNT(*) FROM tags t WHERE t.worker_id = w.id AND t.active = 1) AS tag_count,
              EXISTS(SELECT 1 FROM shifts s WHERE s.worker_id = w.id AND s.status = 'open') AS on_site
         FROM workers w
        ${includeInactive ? '' : 'WHERE w.active = 1'}
        ORDER BY w.full_name COLLATE NOCASE`
    )
    .all();
  res.json(rows.map(serializeWorker));
});

function serializeWorker(w) {
  return {
    id: w.id,
    code: w.code,
    fullName: w.full_name,
    documentId: w.document_id,
    role: w.role,
    hourlyRate: w.hourly_rate,
    duxEmployeeId: w.dux_employee_id,
    active: Boolean(w.active),
    tagCount: w.tag_count ?? undefined,
    onSite: Boolean(w.on_site),
  };
}

router.post('/workers', (req, res) => {
  const { code, fullName, documentId, role, hourlyRate, duxEmployeeId } = req.body || {};
  if (!trim(fullName)) return bad(res, 'full_name_required');
  const db = getDb();
  const now = time.nowIso();
  const workerCode = trim(code) || `E${String(Date.now()).slice(-6)}`;

  if (db.prepare('SELECT 1 FROM workers WHERE code = ?').get(workerCode)) {
    return bad(res, 'code_already_exists', 409);
  }
  const info = db
    .prepare(
      `INSERT INTO workers (code, full_name, document_id, role, hourly_rate, dux_employee_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      workerCode,
      trim(fullName),
      trim(documentId) || null,
      trim(role) || null,
      hourlyRate === '' || hourlyRate == null ? null : Number(hourlyRate),
      trim(duxEmployeeId) || null,
      now,
      now
    );
  res.status(201).json(serializeWorker(db.prepare('SELECT * FROM workers WHERE id = ?').get(info.lastInsertRowid)));
});

router.patch('/workers/:id', (req, res) => {
  const db = getDb();
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.params.id);
  if (!worker) return bad(res, 'worker_not_found', 404);

  const body = req.body || {};
  const code = trim(body.code) || worker.code;
  const fullName = trim(body.fullName) || worker.full_name;
  const documentId = body.documentId !== undefined ? trim(body.documentId) || null : worker.document_id;
  const role = body.role !== undefined ? trim(body.role) || null : worker.role;
  const hourlyRate =
    body.hourlyRate !== undefined
      ? body.hourlyRate === '' || body.hourlyRate === null
        ? null
        : Number(body.hourlyRate)
      : worker.hourly_rate;
  const duxEmployeeId =
    body.duxEmployeeId !== undefined ? trim(body.duxEmployeeId) || null : worker.dux_employee_id;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : worker.active;

  if (!fullName) return bad(res, 'full_name_required');
  const clash = db.prepare('SELECT 1 FROM workers WHERE code = ? AND id != ?').get(code, worker.id);
  if (clash) return bad(res, 'code_already_exists', 409);

  db.prepare(
    `UPDATE workers
        SET code = ?, full_name = ?, document_id = ?, role = ?, hourly_rate = ?,
            dux_employee_id = ?, active = ?, updated_at = ?
      WHERE id = ?`
  ).run(code, fullName, documentId, role, hourlyRate, duxEmployeeId, active, time.nowIso(), worker.id);

  res.json(serializeWorker(db.prepare('SELECT * FROM workers WHERE id = ?').get(worker.id)));
});

// Deactivate rather than delete: their history has to stay auditable.
router.delete('/workers/:id', (req, res) => {
  const db = getDb();
  const info = db
    .prepare('UPDATE workers SET active = 0, updated_at = ? WHERE id = ?')
    .run(time.nowIso(), req.params.id);
  if (!info.changes) return bad(res, 'worker_not_found', 404);
  res.json({ ok: true, deactivated: Number(req.params.id) });
});

/* ------------------------------------------------------------------- tags */

router.get('/workers/:id/tags', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM tags WHERE worker_id = ? ORDER BY created_at').all(req.params.id);
  res.json(rows.map((t) => ({ id: t.id, uid: t.uid, label: t.label, active: Boolean(t.active) })));
});

// Manual entry, for a UID read off the fob or another terminal.
router.post('/workers/:id/tags', (req, res) => {
  const uid = normalizeUid(req.body?.uid);
  if (!uid) return bad(res, 'uid_required');
  const outcome = clock.enrollTag(getDb(), {
    uid,
    workerId: Number(req.params.id),
    label: trim(req.body?.label) || null,
  });
  const status = outcome.result === 'enrolled' ? 201 : outcome.result === 'tag_taken' ? 409 : 200;
  res.status(status).json(outcome);
});

router.delete('/tags/:id', (req, res) => {
  const info = getDb().prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  if (!info.changes) return bad(res, 'tag_not_found', 404);
  res.json({ ok: true });
});

/* Arm the reader: the next tap at any kiosk binds that fob to this worker. */
router.post('/workers/:id/enroll', (req, res) => {
  const db = getDb();
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.params.id);
  if (!worker) return bad(res, 'worker_not_found', 404);
  res.json(
    clock.armEnrollment(worker.id, {
      label: trim(req.body?.label) || null,
      ttlSeconds: Number(req.body?.ttlSeconds) || 120,
    })
  );
});

router.get('/enroll', (req, res) => res.json(clock.enrollmentState()));
router.delete('/enroll', (req, res) => res.json(clock.cancelEnrollment()));

router.get('/unknown-scans', (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM unknown_scans ORDER BY scanned_at DESC LIMIT 50')
    .all();
  res.json(rows);
});

/* ------------------------------------------------------- shifts & punches */

router.get('/onsite', (req, res) => res.json(clock.onSiteNow(getDb())));

router.get('/timesheet', (req, res) => {
  const range = defaultRange(req.query);
  const shifts = timesheet.listShifts(getDb(), range);
  res.json({ range, shifts, summary: timesheet.summarize(shifts) });
});

// Manual punch, for the worker who forgot their fob.
router.post('/punch', (req, res) => {
  const db = getDb();
  const workerId = Number(req.body?.workerId);
  const direction = req.body?.direction;
  const at = req.body?.at ? new Date(req.body.at).toISOString() : time.nowIso();

  if (!db.prepare('SELECT 1 FROM workers WHERE id = ?').get(workerId)) return bad(res, 'worker_not_found', 404);
  if (!['in', 'out'].includes(direction)) return bad(res, 'direction_must_be_in_or_out');

  const open = clock.openShiftFor(db, workerId);
  if (direction === 'in' && open) return bad(res, 'already_checked_in', 409);
  if (direction === 'out' && !open) return bad(res, 'not_checked_in', 409);

  const punch = clock.insertPunch(db, {
    workerId,
    tagUid: null,
    direction,
    at,
    device: 'admin',
    source: 'manual',
    note: trim(req.body?.note) || null,
  });
  const shift =
    direction === 'in'
      ? clock.startShift(db, { workerId, at, punchId: punch.id })
      : clock.closeShift(db, open, { at, punchId: punch.id });

  res.status(201).json({ punch, shift });
});

// Correct a shift's times; the Dux payload is rebuilt and re-queued.
router.patch('/shifts/:id', (req, res) => {
  const db = getDb();
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return bad(res, 'shift_not_found', 404);

  const startedAt = req.body?.startedAt ? new Date(req.body.startedAt).toISOString() : shift.started_at;
  const endedAt =
    req.body?.endedAt !== undefined
      ? req.body.endedAt
        ? new Date(req.body.endedAt).toISOString()
        : null
      : shift.ended_at;
  if (endedAt && new Date(endedAt) <= new Date(startedAt)) return bad(res, 'end_must_be_after_start');

  const note = req.body?.note !== undefined ? trim(req.body.note) || null : shift.note;
  const { breakMinutes, net } = endedAt
    ? clock.computeShiftMinutes(startedAt, endedAt)
    : { breakMinutes: 0, net: null };

  db.prepare(
    `UPDATE shifts
        SET started_at = ?, ended_at = ?, minutes = ?, break_minutes = ?, status = ?,
            business_day = ?, note = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    startedAt,
    endedAt,
    net,
    breakMinutes,
    endedAt ? 'closed' : 'open',
    time.businessDay(startedAt, config.timezone, config.dayCutoffHour),
    note,
    time.nowIso(),
    shift.id
  );

  if (endedAt) dux.enqueueShift(db, shift.id, { force: true });
  res.json(db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id));
});

router.delete('/shifts/:id', (req, res) => {
  const info = getDb().prepare('DELETE FROM shifts WHERE id = ?').run(req.params.id);
  if (!info.changes) return bad(res, 'shift_not_found', 404);
  res.json({ ok: true });
});

/* ----------------------------------------------------------------- export */

function sendCsv(res, filename, body) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

router.get('/export/shifts.csv', (req, res) => {
  const range = defaultRange(req.query);
  const shifts = timesheet.listShifts(getDb(), { ...range, includeOpen: false });
  sendCsv(res, `asistencias_${range.from}_${range.to}.csv`, timesheet.shiftsCsv(shifts, {
    delimiter: req.query.delimiter === ';' ? ';' : ',',
  }));
});

router.get('/export/summary.csv', (req, res) => {
  const range = defaultRange(req.query);
  const shifts = timesheet.listShifts(getDb(), { ...range, includeOpen: false });
  sendCsv(res, `horas_${range.from}_${range.to}.csv`, timesheet.summaryCsv(timesheet.summarize(shifts), {
    delimiter: req.query.delimiter === ';' ? ';' : ',',
  }));
});

/* -------------------------------------------------------------------- dux */

router.get('/dux/status', (req, res) => res.json(dux.outboxStatus(getDb())));

router.post('/dux/sync', async (req, res) => {
  res.json(await dux.processOutbox(getDb(), { limit: Number(req.body?.limit) || 50 }));
});

router.post('/dux/retry', (req, res) => res.json(dux.retryFailed(getDb())));

router.post('/dux/push/:shiftId', async (req, res) => {
  const db = getDb();
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.shiftId);
  if (!shift) return bad(res, 'shift_not_found', 404);
  if (!shift.ended_at) return bad(res, 'shift_still_open', 409);

  dux.enqueueShift(db, shift.id, { force: true });
  if (!config.dux.configured) return res.json({ queued: true, sent: false, reason: 'dux_not_configured' });

  const row = db.prepare('SELECT * FROM dux_outbox WHERE shift_id = ?').get(shift.id);
  res.json(await dux.deliver(db, row));
});

// Preview exactly what would be sent, without sending it.
router.get('/dux/preview/:shiftId', (req, res) => {
  try {
    res.json({ endpoint: config.dux.configured ? dux.targetUrl() : null, payload: dux.buildPayload(getDb(), req.params.shiftId) });
  } catch (error) {
    bad(res, error.message, 404);
  }
});

module.exports = router;
