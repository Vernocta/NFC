'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const time = require('./time');
const dux = require('./dux');
const timesheet = require('./timesheet');

/**
 * Daily upload.
 *
 * In `daily` mode nothing is pushed as it happens: closed shifts sit in the
 * outbox until the scheduled run (17:00 by default, in the site's timezone),
 * which drains the whole queue in one batch. Shifts still open at that hour
 * simply go out in the next day's run, once somebody has checked out of them.
 *
 * Every run is recorded in `sync_runs`, which is what lets the server catch
 * up after being switched off at the scheduled time, and what the admin
 * console shows as the upload history.
 */

const dailyTime = () => time.parseClockTime(config.dux.dailyTime);

/** The instant of the next scheduled upload. */
function nextRunAt(from = new Date()) {
  return time.nextOccurrence(from, dailyTime(), config.timezone);
}

/** Today's scheduled instant, whether or not it has passed. */
function todaysRunAt(from = new Date()) {
  const { hour, minute } = dailyTime();
  return time.zonedTimeToUtc(time.localDate(from, config.timezone), hour, minute, config.timezone);
}

function lastRun(db, kinds = null) {
  const filter = kinds ? `WHERE kind IN (${kinds.map(() => '?').join(', ')})` : '';
  return db.prepare(`SELECT * FROM sync_runs ${filter} ORDER BY started_at DESC LIMIT 1`).get(...(kinds || []));
}

function recentRuns(db, limit = 10) {
  return db.prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?').all(limit);
}

function writeDayCsv(dir, db, businessDay) {
  const file = path.join(dir, `asistencias_${businessDay}.csv`);
  const shifts = timesheet.listShifts(db, { from: businessDay, to: businessDay, includeOpen: false });
  fs.writeFileSync(file, timesheet.shiftsCsv(shifts), 'utf8');
  return file;
}

/**
 * Write the day's shift detail next to the upload, when DAILY_EXPORT_DIR is set.
 *
 * The previous day is rewritten as well: at 17:00 people are still on site, so
 * a check-out at 18:00 lands in the database after that day's file was first
 * written. Refreshing it on the next run is what makes each file complete.
 * Returns the path of the current day's file.
 */
function writeDailyExport(db, businessDay) {
  if (!config.dailyExportDir) return null;
  const dir = path.resolve(__dirname, '..', config.dailyExportDir);
  fs.mkdirSync(dir, { recursive: true });
  writeDayCsv(dir, db, time.addDays(businessDay, -1));
  return writeDayCsv(dir, db, businessDay);
}

/**
 * Push everything the outbox is holding and record the result.
 * Safe to call at any time — that is what the "Subir ahora" button does.
 */
let uploadInFlight = false;

async function runUpload(db, { kind = 'daily', ...options } = {}) {
  // The scheduled run and the admin button share this lock.
  if (uploadInFlight) return { skipped: 'already_running', sent: 0, failed: 0 };
  uploadInFlight = true;

  try {
    const startedAt = time.nowIso();
    const businessDay = time.businessDay(startedAt, config.timezone, config.dayCutoffHour);
    const openShifts = db.prepare("SELECT COUNT(*) AS n FROM shifts WHERE status = 'open'").get().n;

    const runId = db
      .prepare('INSERT INTO sync_runs (kind, business_day, started_at, open_shifts) VALUES (?, ?, ?, ?)')
      .run(kind, businessDay, startedAt, openShifts).lastInsertRowid;

    let sent = 0;
    let failed = 0;
    let error = null;
    let exportFile = null;

    try {
      // Drain in passes: a large backlog needs more than one page of rows.
      for (let pass = 0; pass < 20; pass += 1) {
        const result = await dux.processOutbox(db, { limit: 50, ...options });
        if (result.skipped) {
          error = 'dux_not_configured';
          break;
        }
        sent += result.sent;
        failed += result.failed;
        if (!result.processed || result.failed) break;
      }
      exportFile = writeDailyExport(db, businessDay);
    } catch (caught) {
      error = caught.message;
    }

    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM dux_outbox WHERE status IN ('pending', 'failed')")
      .get().n;

    db.prepare(
      `UPDATE sync_runs
          SET finished_at = ?, sent = ?, failed = ?, remaining = ?, export_file = ?, error = ?
        WHERE id = ?`
    ).run(time.nowIso(), sent, failed, remaining, exportFile, error, runId);

    return { id: runId, kind, businessDay, sent, failed, remaining, openShifts, exportFile, error };
  } finally {
    uploadInFlight = false;
  }
}

/** True when today's run is already behind us and nothing ran for it. */
function needsCatchUp(db, now = new Date()) {
  if (todaysRunAt(now).getTime() > now.getTime()) return false;
  const previous = lastRun(db, ['daily', 'catch_up']);
  if (!previous) return true;
  return new Date(previous.started_at).getTime() < todaysRunAt(now).getTime();
}

/**
 * Arm the daily upload. Returns a handle so the server can stop it and the
 * admin API can report when the next run is due.
 */
function startDailyScheduler(db, { onRun = null, ...options } = {}) {
  let dailyTimer = null;
  let retryTimer = null;
  let stopped = false;
  let running = false;

  const execute = async (kind) => {
    if (running || stopped) return null;
    running = true;
    try {
      const result = await runUpload(db, { kind, ...options });
      if (result.skipped) return result;
      const detail = result.error ? `error: ${result.error}` : `${result.sent} sent, ${result.failed} failed`;
      console.log(`[sync] ${kind} upload — ${detail}, ${result.remaining} still queued`);
      onRun?.(result);
      armRetry(result);
      return result;
    } catch (error) {
      console.error('[sync] upload failed:', error.message);
      return null;
    } finally {
      running = false;
      armDaily();
    }
  };

  // A run that could not drain the queue is retried before tomorrow, so a
  // network blip at 17:00 does not hold the hours back for a whole day.
  const armRetry = (result) => {
    clearTimeout(retryTimer);
    if (stopped || !result || result.error === 'dux_not_configured' || !result.remaining) return;
    retryTimer = setTimeout(() => execute('retry'), Math.max(60, config.dux.retryIntervalSeconds) * 1000);
    retryTimer.unref?.();
  };

  const armDaily = () => {
    clearTimeout(dailyTimer);
    if (stopped) return;
    const delay = Math.max(1000, nextRunAt().getTime() - Date.now());
    dailyTimer = setTimeout(() => execute('daily'), delay);
    dailyTimer.unref?.();
  };

  armDaily();

  if (config.dux.catchUpOnStart && config.dux.configured && needsCatchUp(db)) {
    console.log("[sync] today's upload had not run yet — catching up now");
    setTimeout(() => execute('catch_up'), 2000).unref?.();
  }

  return {
    nextRunAt: () => nextRunAt(),
    runNow: (kind = 'manual') => execute(kind),
    stop: () => {
      stopped = true;
      clearTimeout(dailyTimer);
      clearTimeout(retryTimer);
    },
  };
}

module.exports = {
  nextRunAt,
  todaysRunAt,
  runUpload,
  needsCatchUp,
  lastRun,
  recentRuns,
  startDailyScheduler,
  writeDailyExport,
};
