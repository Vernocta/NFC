'use strict';

process.env.TZ_NAME = 'America/Argentina/Buenos_Aires';
process.env.DUX_BASE_URL = 'https://erp.example.test';
process.env.DUX_API_KEY = 'secret-key';
process.env.DUX_TIMESHEET_PATH = '/api/v1/asistencias';
process.env.DUX_MAX_ATTEMPTS = '2';
process.env.DUX_EXTRA_FIELDS = '{"sucursal":"OBRA-1"}';
process.env.SCAN_DEBOUNCE_SECONDS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const clock = require('../src/clock');
const dux = require('../src/dux');
const time = require('../src/time');

function dbWithClosedShift() {
  const db = openDatabase(':memory:');
  const now = time.nowIso();
  db.prepare(
    `INSERT INTO workers (code, full_name, document_id, dux_employee_id, active, created_at, updated_at)
     VALUES ('E001', 'Ana Gómez', '30111222', 'DUX-77', 1, ?, ?)`
  ).run(now, now);
  db.prepare("INSERT INTO tags (uid, worker_id, active, created_at) VALUES ('04A21B3C', 1, 1, ?)").run(now);
  clock.cancelEnrollment();

  clock.handleScan(db, { uid: '04A21B3C', at: '2026-09-21T11:00:00Z' });
  clock.handleScan(db, { uid: '04A21B3C', at: '2026-09-21T19:00:00Z' });
  return db;
}

const okFetch = (body = { id: 'DUX-9001' }) => async () => ({
  ok: true,
  status: 201,
  text: async () => JSON.stringify(body),
});

test('the payload carries local times, hours and the worker identifiers', () => {
  const db = dbWithClosedShift();
  const payload = dux.buildPayload(db, 1);

  assert.equal(payload.external_id, 'shift-1');
  assert.equal(payload.empleado.codigo, 'E001');
  assert.equal(payload.empleado.id, 'DUX-77');
  assert.equal(payload.empleado.documento, '30111222');
  assert.equal(payload.fecha, '2026-09-21');
  assert.equal(payload.entrada, '2026-09-21 08:00:00');
  assert.equal(payload.salida, '2026-09-21 16:00:00');
  assert.equal(payload.horas_trabajadas, 8);
  assert.equal(payload.sucursal, 'OBRA-1', 'DUX_EXTRA_FIELDS is merged in');
});

test('an open shift is never queued', () => {
  const db = openDatabase(':memory:');
  const now = time.nowIso();
  db.prepare("INSERT INTO workers (code, full_name, active, created_at, updated_at) VALUES ('E9', 'X', 1, ?, ?)").run(now, now);
  db.prepare(
    `INSERT INTO shifts (worker_id, business_day, started_at, status, created_at, updated_at)
     VALUES (1, '2026-09-21', '2026-09-21T11:00:00Z', 'open', ?, ?)`
  ).run(now, now);
  assert.throws(() => dux.buildPayload(db, 1), /still open/);
});

test('closing a shift queues it automatically', () => {
  const db = dbWithClosedShift();
  const row = db.prepare('SELECT * FROM dux_outbox WHERE shift_id = 1').get();
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);
});

test('a successful push marks the row sent and stores the Dux reference', async () => {
  const db = dbWithClosedShift();
  const result = await dux.processOutbox(db, { fetchImpl: okFetch() });

  assert.deepEqual({ sent: result.sent, failed: result.failed }, { sent: 1, failed: 0 });
  const row = db.prepare('SELECT * FROM dux_outbox WHERE shift_id = 1').get();
  assert.equal(row.status, 'sent');
  assert.equal(row.dux_ref, 'DUX-9001');
  assert.ok(row.sent_at);
});

test('the API key and endpoint are built from configuration', async () => {
  const db = dbWithClosedShift();
  let seen;
  await dux.processOutbox(db, {
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  assert.equal(seen.url, 'https://erp.example.test/api/v1/asistencias');
  assert.equal(seen.options.headers.Authorization, 'Bearer secret-key');
  assert.equal(JSON.parse(seen.options.body).external_id, 'shift-1');
});

test('a failing endpoint backs off, then gives up after DUX_MAX_ATTEMPTS', async () => {
  const db = dbWithClosedShift();
  const failing = async () => ({ ok: false, status: 500, text: async () => 'boom' });

  await dux.processOutbox(db, { fetchImpl: failing });
  let row = db.prepare('SELECT * FROM dux_outbox WHERE shift_id = 1').get();
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /HTTP 500/);
  assert.ok(new Date(row.next_attempt_at) > new Date(), 'retry is scheduled in the future');

  // The backoff means a second pass right away does nothing.
  assert.equal((await dux.processOutbox(db, { fetchImpl: failing })).processed, 0);

  await dux.deliver(db, row, { fetchImpl: failing });
  row = db.prepare('SELECT * FROM dux_outbox WHERE shift_id = 1').get();
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
});

test('failed rows can be sent back to the queue and then succeed', async () => {
  const db = dbWithClosedShift();
  const failing = async () => ({ ok: false, status: 400, text: async () => 'bad' });
  const row = db.prepare('SELECT * FROM dux_outbox WHERE shift_id = 1').get();
  await dux.deliver(db, row, { fetchImpl: failing });
  await dux.deliver(db, db.prepare('SELECT * FROM dux_outbox WHERE shift_id = 1').get(), { fetchImpl: failing });
  assert.equal(db.prepare('SELECT status FROM dux_outbox WHERE shift_id = 1').get().status, 'failed');

  assert.equal(dux.retryFailed(db).requeued, 1);
  await dux.processOutbox(db, { fetchImpl: okFetch() });
  assert.equal(db.prepare('SELECT status FROM dux_outbox WHERE shift_id = 1').get().status, 'sent');
});

test('re-queuing an already sent shift needs force', async () => {
  const db = dbWithClosedShift();
  await dux.processOutbox(db, { fetchImpl: okFetch() });

  assert.equal(dux.enqueueShift(db, 1).queued, false);
  assert.equal(dux.enqueueShift(db, 1, { force: true }).queued, true);
  assert.equal(db.prepare('SELECT status FROM dux_outbox WHERE shift_id = 1').get().status, 'pending');
});

test('outboxStatus reports counts and masks nothing it should not', () => {
  const db = dbWithClosedShift();
  const status = dux.outboxStatus(db);
  assert.equal(status.configured, true);
  assert.equal(status.counts.pending, 1);
  assert.equal(status.endpoint, 'https://erp.example.test/api/v1/asistencias');
});
