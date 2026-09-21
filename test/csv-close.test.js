'use strict';

// No DUX_TIMESHEET_PATH: the CSV-only setup, which is the default.
process.env.TZ_NAME = 'America/Argentina/Buenos_Aires';
process.env.DUX_BASE_URL = '';
process.env.DUX_TIMESHEET_PATH = '';
process.env.SCAN_DEBOUNCE_SECONDS = '0';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { openDatabase } = require('../src/db');
const clock = require('../src/clock');
const scheduler = require('../src/scheduler');
const time = require('../src/time');

let exportDir;

test.beforeEach(() => {
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfc-csv-'));
  config.dailyExportDir = exportDir;
});
test.afterEach(() => fs.rmSync(exportDir, { recursive: true, force: true }));

function dbWithShift(hoursAgo = 26) {
  const db = openDatabase(':memory:');
  const now = time.nowIso();
  db.prepare(
    `INSERT INTO workers (code, full_name, hourly_rate, active, created_at, updated_at)
     VALUES ('E001', 'Ana Gómez', 4200, 1, ?, ?)`
  ).run(now, now);
  db.prepare("INSERT INTO tags (uid, worker_id, active, created_at) VALUES ('04A21B3C', 1, 1, ?)").run(now);
  clock.cancelEnrollment();

  const start = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
  const end = new Date(new Date(start).getTime() + 8 * 3600 * 1000).toISOString();
  clock.handleScan(db, { uid: '04A21B3C', at: start });
  clock.handleScan(db, { uid: '04A21B3C', at: end });
  return db;
}

test('with no push target the close is a success, not an error', async () => {
  const db = dbWithShift();
  const result = await scheduler.runUpload(db);

  assert.equal(result.error, null, 'a CSV-only setup is a valid setup');
  assert.equal(result.pushes, false);
  assert.equal(result.sent, 0);

  const run = scheduler.lastRun(db);
  assert.equal(run.error, null);
  assert.ok(run.export_file, 'the run records the file it produced');
});

test('the close writes the month summary, today and yesterday', async () => {
  const db = dbWithShift();
  const result = await scheduler.runUpload(db);

  const written = fs.readdirSync(exportDir).sort();
  assert.equal(written.length, 3);
  assert.ok(written.some((f) => /^resumen_\d{4}-\d{2}\.csv$/.test(f)));
  assert.equal(written.filter((f) => f.startsWith('asistencias_')).length, 2);

  // The monthly summary is the primary artefact, so it is the one recorded.
  assert.match(path.basename(result.exportFile), /^resumen_/);
});

test('the month summary totals the hours and the amount to pay', async () => {
  const db = dbWithShift();
  const result = await scheduler.runUpload(db);
  const csv = fs.readFileSync(result.exportFile, 'utf8');

  const [header, row] = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(header, 'legajo,empleado,documento,dux_empleado_id,dias,turnos,horas,valor_hora,importe');

  const cells = row.split(',');
  assert.equal(cells[0], 'E001');
  assert.equal(cells[1], 'Ana Gómez');
  assert.equal(cells[6], '8.00', 'hours worked');
  assert.equal(cells[8], '33600', '8h at 4200/h');
});

test('a later check-out still reaches the files on the next close', async () => {
  const db = dbWithShift();
  await scheduler.runUpload(db);

  // Somebody checks out after the 17:00 close.
  const yesterday = time.addDays(time.businessDay(time.nowIso(), config.timezone, 0), -1);
  const late = `${yesterday}T23:00:00.000Z`;
  clock.handleScan(db, { uid: '04A21B3C', at: `${yesterday}T20:00:00.000Z` });
  clock.handleScan(db, { uid: '04A21B3C', at: late });

  const second = await scheduler.runUpload(db);
  const summary = fs.readFileSync(second.exportFile, 'utf8');
  const hours = Number(summary.trim().split('\r\n')[1].split(',')[6]);
  assert.ok(hours > 8, `the late shift is included (got ${hours}h)`);
});

test('turning the export dir off leaves the close harmless', async () => {
  config.dailyExportDir = '';
  const db = dbWithShift();
  const result = await scheduler.runUpload(db);
  assert.equal(result.error, null);
  assert.equal(result.exportFile, null);
  assert.deepEqual(result.exportFiles, []);
});
