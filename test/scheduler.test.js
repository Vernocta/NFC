'use strict';

process.env.TZ_NAME = 'America/Argentina/Buenos_Aires';
process.env.DUX_BASE_URL = 'https://erp.example.test';
process.env.DUX_API_KEY = 'secret-key';
process.env.DUX_TIMESHEET_PATH = '/api/v1/asistencias';
process.env.DUX_SYNC_MODE = 'daily';
process.env.DUX_DAILY_TIME = '17:00';
process.env.SCAN_DEBOUNCE_SECONDS = '0';
process.env.DUX_MAX_ATTEMPTS = '2';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const clock = require('../src/clock');
const scheduler = require('../src/scheduler');
const time = require('../src/time');

const TZ = 'America/Argentina/Buenos_Aires';

function dbWithShifts(count = 2) {
  const db = openDatabase(':memory:');
  const now = time.nowIso();
  db.prepare(
    `INSERT INTO workers (code, full_name, active, created_at, updated_at) VALUES ('E001', 'Ana Gómez', 1, ?, ?)`
  ).run(now, now);
  db.prepare("INSERT INTO tags (uid, worker_id, active, created_at) VALUES ('04A21B3C', 1, 1, ?)").run(now);
  clock.cancelEnrollment();

  for (let i = 0; i < count; i += 1) {
    const start = new Date(Date.now() - (i + 1) * 86400000).toISOString();
    const end = new Date(new Date(start).getTime() + 8 * 3600 * 1000).toISOString();
    clock.handleScan(db, { uid: '04A21B3C', at: start });
    clock.handleScan(db, { uid: '04A21B3C', at: end });
  }
  return db;
}

const okFetch = () => async () => ({ ok: true, status: 201, text: async () => '{"id":"DUX-1"}' });

test('the next run is 17:00 local, rolling to tomorrow once it has passed', () => {
  // 16:00 local on the 21st -> later the same day.
  assert.equal(
    scheduler.nextRunAt(new Date('2026-09-21T19:00:00Z')).toISOString(),
    '2026-09-21T20:00:00.000Z'
  );
  // 18:00 local -> tomorrow.
  assert.equal(
    scheduler.nextRunAt(new Date('2026-09-21T21:00:00Z')).toISOString(),
    '2026-09-22T20:00:00.000Z'
  );
  // Exactly at 17:00 local, the next one is tomorrow, not a repeat of now.
  assert.equal(
    scheduler.nextRunAt(new Date('2026-09-21T20:00:00Z')).toISOString(),
    '2026-09-22T20:00:00.000Z'
  );
  assert.equal(time.localTime(scheduler.nextRunAt(), TZ), '17:00');
});

test('a run uploads the whole queue and records what happened', async () => {
  const db = dbWithShifts(2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dux_outbox WHERE status = 'pending'").get().n, 2);

  const result = await scheduler.runUpload(db, { fetchImpl: okFetch() });
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.remaining, 0);
  assert.equal(result.error, null);

  const run = scheduler.lastRun(db);
  assert.equal(run.kind, 'daily');
  assert.equal(run.sent, 2);
  assert.ok(run.finished_at, 'the run is closed out');
});

test('shifts still open at 17:00 are left for the next run', async () => {
  const db = dbWithShifts(1);
  clock.handleScan(db, { uid: '04A21B3C' }); // still on site

  const result = await scheduler.runUpload(db, { fetchImpl: okFetch() });
  assert.equal(result.openShifts, 1);
  assert.equal(result.sent, 1, 'only the closed shift goes out');

  // They check out, and the next run carries that shift.
  clock.handleScan(db, { uid: '04A21B3C', at: new Date(Date.now() + 3600000).toISOString() });
  const nextDay = await scheduler.runUpload(db, { fetchImpl: okFetch() });
  assert.equal(nextDay.sent, 1);
  assert.equal(nextDay.remaining, 0);
});

test('a failing upload leaves the rows queued and records the failure', async () => {
  const db = dbWithShifts(2);
  const failing = async () => ({ ok: false, status: 503, text: async () => 'down' });

  const result = await scheduler.runUpload(db, { fetchImpl: failing });
  assert.equal(result.sent, 0);
  assert.ok(result.failed >= 1);
  assert.equal(result.remaining, 2, 'nothing is lost');
  assert.equal(scheduler.lastRun(db).remaining, 2);
});

test('catch-up detects a scheduled run that never happened', () => {
  const db = dbWithShifts(1);
  const afterFive = new Date('2026-09-21T21:00:00Z'); // 18:00 local
  const beforeFive = new Date('2026-09-21T19:00:00Z'); // 16:00 local

  assert.equal(scheduler.needsCatchUp(db, beforeFive), false, 'not due yet');
  assert.equal(scheduler.needsCatchUp(db, afterFive), true, 'due and never ran');

  // Record a run at 17:05 local that day.
  db.prepare(
    "INSERT INTO sync_runs (kind, business_day, started_at) VALUES ('daily', '2026-09-21', '2026-09-21T20:05:00.000Z')"
  ).run();
  assert.equal(scheduler.needsCatchUp(db, afterFive), false, 'today is covered');

  // The following day it is due again.
  assert.equal(scheduler.needsCatchUp(db, new Date('2026-09-22T21:00:00Z')), true);
});

test('two uploads cannot overlap', async () => {
  const db = dbWithShifts(1);
  let release;
  const slow = () =>
    new Promise((resolve) => {
      release = () => resolve({ ok: true, status: 200, text: async () => '{}' });
    });

  const first = scheduler.runUpload(db, { fetchImpl: slow });
  const second = await scheduler.runUpload(db, { fetchImpl: okFetch() });
  assert.equal(second.skipped, 'already_running');

  release();
  assert.equal((await first).sent, 1);

  // The lock is released again afterwards.
  assert.equal((await scheduler.runUpload(db, { fetchImpl: okFetch() })).skipped, undefined);
});

test('the optional daily CSV is written next to the upload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfc-export-'));
  const original = require('../src/config').dailyExportDir;
  require('../src/config').dailyExportDir = dir;

  try {
    const db = dbWithShifts(1);
    const result = await scheduler.runUpload(db, { fetchImpl: okFetch() });
    assert.ok(result.exportFile, 'the run reports the file it wrote');
    const csv = fs.readFileSync(result.exportFile, 'utf8');
    assert.ok(csv.includes('legajo'));

    // Yesterday is rewritten too, so a late check-out still reaches a file.
    const yesterday = time.addDays(result.businessDay, -1);
    const previous = path.join(dir, `asistencias_${yesterday}.csv`);
    assert.ok(fs.existsSync(previous), 'the previous day is refreshed');
    assert.ok(fs.readFileSync(previous, 'utf8').includes('Ana Gómez'), 'and carries that day\'s shift');
  } finally {
    require('../src/config').dailyExportDir = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scheduler arms a timer without firing immediately', () => {
  const db = dbWithShifts(1);
  const handle = scheduler.startDailyScheduler(db, { fetchImpl: okFetch() });
  try {
    assert.equal(time.localTime(handle.nextRunAt(), TZ), '17:00');
    assert.ok(handle.nextRunAt().getTime() > Date.now());
  } finally {
    handle.stop();
  }
});
