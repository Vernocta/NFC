'use strict';

const config = require('./config');
const time = require('./time');
const dux = require('./dux');
const { normalizeUid, uidVariants } = require('./uid');

/**
 * The punch engine. One tap of a keychain tag toggles the worker between
 * "on site" and "off site": no separate IN / OUT buttons for the worker to
 * get wrong. Every tap is written to `punches` as an immutable audit trail,
 * while `shifts` holds the paired, billable result.
 */

// Enrolling a new fob: the admin arms this, the next unknown tap claims it.
let pendingEnrollment = null;

function armEnrollment(workerId, { label = null, ttlSeconds = 120 } = {}) {
  pendingEnrollment = {
    workerId,
    label,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
  return enrollmentState();
}

function cancelEnrollment() {
  pendingEnrollment = null;
  return enrollmentState();
}

function enrollmentState() {
  if (pendingEnrollment && pendingEnrollment.expiresAt <= Date.now()) pendingEnrollment = null;
  if (!pendingEnrollment) return { armed: false };
  return {
    armed: true,
    workerId: pendingEnrollment.workerId,
    label: pendingEnrollment.label,
    secondsLeft: Math.max(0, Math.round((pendingEnrollment.expiresAt - Date.now()) / 1000)),
  };
}

function findWorkerByUid(db, rawUid) {
  const variants = uidVariants(rawUid);
  if (!variants.length) return null;
  const placeholders = variants.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT w.*, t.uid AS tag_uid, t.id AS tag_id, t.label AS tag_label
         FROM tags t
         JOIN workers w ON w.id = t.worker_id
        WHERE t.uid IN (${placeholders}) AND t.active = 1
        LIMIT 1`
    )
    .get(...variants);
}

function openShiftFor(db, workerId) {
  return db
    .prepare(
      `SELECT * FROM shifts WHERE worker_id = ? AND status = 'open'
        ORDER BY started_at DESC LIMIT 1`
    )
    .get(workerId);
}

function lastPunchFor(db, workerId) {
  return db
    .prepare('SELECT * FROM punches WHERE worker_id = ? ORDER BY punched_at DESC, id DESC LIMIT 1')
    .get(workerId);
}

function insertPunch(db, { workerId, tagUid, direction, at, device, source = 'nfc', note = null }) {
  const businessDay = time.businessDay(at, config.timezone, config.dayCutoffHour);
  const info = db
    .prepare(
      `INSERT INTO punches (worker_id, tag_uid, direction, punched_at, business_day, device, source, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(workerId, tagUid || null, direction, at, businessDay, device || null, source, note, time.nowIso());
  return db.prepare('SELECT * FROM punches WHERE id = ?').get(info.lastInsertRowid);
}

/** Gross time, the auto-deducted break, and the rounded payable minutes. */
function computeShiftMinutes(startedAt, endedAt) {
  const gross = time.minutesBetween(startedAt, endedAt);
  const breakMinutes =
    config.breakMinutes > 0 && gross >= config.breakAfterHours * 60 ? config.breakMinutes : 0;
  const net = time.roundMinutes(Math.max(0, gross - breakMinutes), config.roundMinutes);
  return { gross, breakMinutes, net };
}

function minutesWorkedOn(db, workerId, businessDay) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(minutes), 0) AS total
         FROM shifts
        WHERE worker_id = ? AND business_day = ? AND status != 'open'`
    )
    .get(workerId, businessDay);
  return row.total || 0;
}

/**
 * Close shifts nobody punched out of. Without this, one forgotten tap would
 * bill a worker for every hour until their next visit.
 */
function autoCloseStaleShifts(db, { at = time.nowIso() } = {}) {
  const cutoff = new Date(new Date(at).getTime() - config.maxShiftHours * 3600 * 1000).toISOString();
  const stale = db.prepare("SELECT * FROM shifts WHERE status = 'open' AND started_at <= ?").all(cutoff);
  const closed = [];

  for (const shift of stale) {
    const endedAt = new Date(
      new Date(shift.started_at).getTime() + config.maxShiftHours * 3600 * 1000
    ).toISOString();
    const punch = insertPunch(db, {
      workerId: shift.worker_id,
      tagUid: null,
      direction: 'out',
      at: endedAt,
      device: 'system',
      source: 'auto',
      note: 'Auto-closed: no check-out registered',
    });
    const { breakMinutes, net } = computeShiftMinutes(shift.started_at, endedAt);
    db.prepare(
      `UPDATE shifts
          SET ended_at = ?, minutes = ?, break_minutes = ?, status = 'auto_closed',
              out_punch_id = ?, note = COALESCE(note, 'Auto-closed: no check-out registered'),
              updated_at = ?
        WHERE id = ?`
    ).run(endedAt, net, breakMinutes, punch.id, time.nowIso(), shift.id);
    dux.enqueueShift(db, shift.id);
    closed.push(db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id));
  }
  return closed;
}

function closeShift(db, shift, { at, punchId }) {
  const { breakMinutes, net } = computeShiftMinutes(shift.started_at, at);
  db.prepare(
    `UPDATE shifts
        SET ended_at = ?, minutes = ?, break_minutes = ?, status = 'closed',
            out_punch_id = ?, updated_at = ?
      WHERE id = ?`
  ).run(at, net, breakMinutes, punchId, time.nowIso(), shift.id);
  const updated = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id);
  dux.enqueueShift(db, shift.id);
  return updated;
}

function startShift(db, { workerId, at, punchId }) {
  const now = time.nowIso();
  const info = db
    .prepare(
      `INSERT INTO shifts (worker_id, business_day, started_at, status, in_punch_id, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?)`
    )
    .run(workerId, time.businessDay(at, config.timezone, config.dayCutoffHour), at, punchId, now, now);
  return db.prepare('SELECT * FROM shifts WHERE id = ?').get(info.lastInsertRowid);
}

function publicWorker(worker) {
  return {
    id: worker.id,
    code: worker.code,
    fullName: worker.full_name,
    role: worker.role || null,
  };
}

/**
 * Handle one tap. Never throws on bad input: the kiosk always gets a result
 * code it can show on screen.
 */
function handleScan(db, { uid, device = null, at = time.nowIso() } = {}) {
  const normalized = normalizeUid(uid);
  if (!normalized) return { result: 'invalid_uid' };

  const enrollment = enrollmentState();
  if (enrollment.armed) {
    return enrollTag(db, { uid: normalized, workerId: enrollment.workerId, label: enrollment.label });
  }

  const worker = findWorkerByUid(db, normalized);
  if (!worker) {
    db.prepare('INSERT INTO unknown_scans (uid, device, scanned_at) VALUES (?, ?, ?)').run(
      normalized,
      device,
      at
    );
    return { result: 'unknown_tag', uid: normalized };
  }
  if (!worker.active) {
    return { result: 'inactive_worker', worker: publicWorker(worker) };
  }

  // Reader bounce / an impatient second tap must not open a phantom shift.
  const last = lastPunchFor(db, worker.id);
  if (last && time.minutesBetween(last.punched_at, at) * 60 < config.scanDebounceSeconds) {
    const open = openShiftFor(db, worker.id);
    return {
      result: 'duplicate',
      worker: publicWorker(worker),
      direction: last.direction,
      at: last.punched_at,
      onSite: Boolean(open),
      minutesToday: minutesWorkedOn(db, worker.id, time.businessDay(at, config.timezone, config.dayCutoffHour)),
    };
  }

  autoCloseStaleShifts(db, { at });

  const open = openShiftFor(db, worker.id);
  const businessDay = time.businessDay(at, config.timezone, config.dayCutoffHour);

  if (open) {
    const punch = insertPunch(db, {
      workerId: worker.id,
      tagUid: worker.tag_uid,
      direction: 'out',
      at,
      device,
    });
    const shift = closeShift(db, open, { at, punchId: punch.id });
    return {
      result: 'checked_out',
      worker: publicWorker(worker),
      at,
      shift: {
        id: shift.id,
        startedAt: shift.started_at,
        endedAt: shift.ended_at,
        minutes: shift.minutes,
        breakMinutes: shift.break_minutes,
      },
      minutesThisShift: shift.minutes,
      minutesToday: minutesWorkedOn(db, worker.id, shift.business_day),
    };
  }

  const punch = insertPunch(db, {
    workerId: worker.id,
    tagUid: worker.tag_uid,
    direction: 'in',
    at,
    device,
  });
  const shift = startShift(db, { workerId: worker.id, at, punchId: punch.id });
  return {
    result: 'checked_in',
    worker: publicWorker(worker),
    at,
    shift: { id: shift.id, startedAt: shift.started_at },
    minutesToday: minutesWorkedOn(db, worker.id, businessDay),
  };
}

/** Bind a scanned fob to a worker (the armed-enrollment path). */
function enrollTag(db, { uid, workerId, label = null }) {
  const normalized = normalizeUid(uid);
  if (!normalized) return { result: 'invalid_uid' };

  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
  if (!worker) {
    cancelEnrollment();
    return { result: 'unknown_worker' };
  }

  const existing = db
    .prepare(
      `SELECT t.*, w.full_name FROM tags t JOIN workers w ON w.id = t.worker_id WHERE t.uid = ?`
    )
    .get(normalized);

  if (existing && existing.worker_id !== workerId) {
    return {
      result: 'tag_taken',
      uid: normalized,
      takenBy: existing.full_name,
      worker: publicWorker(worker),
    };
  }
  if (existing) {
    cancelEnrollment();
    return { result: 'already_enrolled', uid: normalized, worker: publicWorker(worker) };
  }

  db.prepare('INSERT INTO tags (uid, worker_id, label, active, created_at) VALUES (?, ?, ?, 1, ?)').run(
    normalized,
    workerId,
    label,
    time.nowIso()
  );
  cancelEnrollment();
  return { result: 'enrolled', uid: normalized, worker: publicWorker(worker) };
}

/** Who is on site right now, for the kiosk footer and the admin board. */
function onSiteNow(db) {
  return db
    .prepare(
      `SELECT s.id AS shift_id, s.started_at, w.id, w.code, w.full_name, w.role
         FROM shifts s JOIN workers w ON w.id = s.worker_id
        WHERE s.status = 'open'
        ORDER BY s.started_at ASC`
    )
    .all()
    .map((r) => ({
      shiftId: r.shift_id,
      workerId: r.id,
      code: r.code,
      fullName: r.full_name,
      role: r.role,
      startedAt: r.started_at,
      minutesSoFar: time.minutesBetween(r.started_at, time.nowIso()),
    }));
}

module.exports = {
  handleScan,
  enrollTag,
  armEnrollment,
  cancelEnrollment,
  enrollmentState,
  findWorkerByUid,
  openShiftFor,
  autoCloseStaleShifts,
  computeShiftMinutes,
  minutesWorkedOn,
  insertPunch,
  startShift,
  closeShift,
  onSiteNow,
  publicWorker,
};
