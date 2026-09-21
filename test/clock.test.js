'use strict';

// Config is read once at require time, so the test settings go first.
process.env.TZ_NAME = 'America/Argentina/Buenos_Aires';
process.env.SCAN_DEBOUNCE_SECONDS = '60';
process.env.MAX_SHIFT_HOURS = '10';
process.env.BREAK_MINUTES = '30';
process.env.BREAK_AFTER_HOURS = '6';
process.env.DUX_BASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const clock = require('../src/clock');
const time = require('../src/time');

function freshDb() {
  const db = openDatabase(':memory:');
  const now = time.nowIso();
  db.prepare(
    `INSERT INTO workers (code, full_name, document_id, active, created_at, updated_at)
     VALUES ('E001', 'Ana Gómez', '30111222', 1, ?, ?)`
  ).run(now, now);
  db.prepare("INSERT INTO tags (uid, worker_id, active, created_at) VALUES ('04A21B3C', 1, 1, ?)").run(now);
  clock.cancelEnrollment();
  return db;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

test('a tag toggles the worker between checked in and checked out', () => {
  const db = freshDb();

  const inScan = clock.handleScan(db, { uid: '04A21B3C', at: hoursAgo(4) });
  assert.equal(inScan.result, 'checked_in');
  assert.equal(inScan.worker.fullName, 'Ana Gómez');
  assert.ok(clock.openShiftFor(db, 1));

  const outScan = clock.handleScan(db, { uid: '04A21B3C', at: hoursAgo(0) });
  assert.equal(outScan.result, 'checked_out');
  assert.equal(outScan.shift.minutes, 240);
  assert.equal(clock.openShiftFor(db, 1), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM punches').get().n, 2);
});

test('a tag read in another format still finds its owner', () => {
  const db = freshDb();
  const decimal = BigInt('0x04A21B3C').toString(10);
  assert.equal(clock.handleScan(db, { uid: decimal }).result, 'checked_in');
});

test('a second tap within the debounce window is ignored', () => {
  const db = freshDb();
  assert.equal(clock.handleScan(db, { uid: '04A21B3C' }).result, 'checked_in');

  const repeat = clock.handleScan(db, { uid: '04:a2:1b:3c' });
  assert.equal(repeat.result, 'duplicate');
  assert.equal(repeat.direction, 'in');
  // The phantom check-out must not have been written.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM punches').get().n, 1);
  assert.ok(clock.openShiftFor(db, 1));
});

test('an unpaid break is deducted once the shift is long enough', () => {
  const db = freshDb();
  clock.handleScan(db, { uid: '04A21B3C', at: hoursAgo(9) });
  const out = clock.handleScan(db, { uid: '04A21B3C' });
  // 9h gross minus the 30 minute break.
  assert.equal(out.shift.minutes, 510);
  assert.equal(out.shift.breakMinutes, 30);
});

test('a forgotten check-out is auto-closed at the shift limit', () => {
  const db = freshDb();
  clock.handleScan(db, { uid: '04A21B3C', at: hoursAgo(30) });

  const next = clock.handleScan(db, { uid: '04A21B3C' });
  assert.equal(next.result, 'checked_in', 'the new tap starts a fresh shift');

  const shifts = db.prepare('SELECT * FROM shifts ORDER BY id').all();
  assert.equal(shifts.length, 2);
  assert.equal(shifts[0].status, 'auto_closed');
  assert.equal(shifts[0].minutes, 10 * 60 - 30, 'capped at MAX_SHIFT_HOURS, less the break');
  assert.equal(shifts[1].status, 'open');
});

test('an unknown tag is logged instead of punching', () => {
  const db = freshDb();
  const result = clock.handleScan(db, { uid: 'DEADBEEF', device: 'kiosk-1' });
  assert.equal(result.result, 'unknown_tag');
  assert.equal(result.uid, 'DEADBEEF');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unknown_scans').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM punches').get().n, 0);
});

test('an inactive worker cannot punch', () => {
  const db = freshDb();
  db.prepare('UPDATE workers SET active = 0 WHERE id = 1').run();
  assert.equal(clock.handleScan(db, { uid: '04A21B3C' }).result, 'inactive_worker');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM punches').get().n, 0);
});

test('an armed enrollment claims the next tap instead of punching', () => {
  const db = freshDb();
  const now = time.nowIso();
  db.prepare(
    "INSERT INTO workers (code, full_name, active, created_at, updated_at) VALUES ('E002', 'Beto Ruiz', 1, ?, ?)"
  ).run(now, now);

  clock.armEnrollment(2, { label: 'llavero azul' });
  const enrolled = clock.handleScan(db, { uid: 'AABBCCDD' });
  assert.equal(enrolled.result, 'enrolled');
  assert.equal(enrolled.worker.fullName, 'Beto Ruiz');
  assert.equal(clock.enrollmentState().armed, false, 'enrollment disarms after one tap');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM punches').get().n, 0);

  // The fob now works as a normal tag.
  assert.equal(clock.handleScan(db, { uid: 'AABBCCDD' }).result, 'checked_in');
});

test('enrolling a fob that belongs to somebody else is refused', () => {
  const db = freshDb();
  const now = time.nowIso();
  db.prepare(
    "INSERT INTO workers (code, full_name, active, created_at, updated_at) VALUES ('E002', 'Beto Ruiz', 1, ?, ?)"
  ).run(now, now);

  clock.armEnrollment(2);
  const result = clock.handleScan(db, { uid: '04A21B3C' });
  assert.equal(result.result, 'tag_taken');
  assert.equal(result.takenBy, 'Ana Gómez');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tags').get().n, 1);
});

test('onSiteNow lists open shifts only', () => {
  const db = freshDb();
  assert.equal(clock.onSiteNow(db).length, 0);
  clock.handleScan(db, { uid: '04A21B3C', at: hoursAgo(2) });
  const onSite = clock.onSiteNow(db);
  assert.equal(onSite.length, 1);
  assert.equal(onSite[0].fullName, 'Ana Gómez');
  assert.ok(onSite[0].minutesSoFar >= 119);
});
