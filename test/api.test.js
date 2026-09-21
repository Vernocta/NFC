'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nfc-test-')), 'test.db');
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_TOKEN = 'test-token';
process.env.TZ_NAME = 'America/Argentina/Buenos_Aires';
process.env.SCAN_DEBOUNCE_SECONDS = '0';
process.env.DUX_BASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/server');
const { closeDb } = require('../src/db');

let base;
let server;

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  closeDb();
  fs.rmSync(path.dirname(DB_FILE), { recursive: true, force: true });
});

const admin = (path, { method = 'GET', body } = {}) =>
  fetch(`${base}/api/admin${path}`, {
    method,
    headers: { Authorization: 'Bearer test-token', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const scan = (uid, device = 'kiosk-test') =>
  fetch(`${base}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, device }),
  });

test('admin routes reject a missing or wrong token', async () => {
  assert.equal((await fetch(`${base}/api/admin/workers`)).status, 401);
  const wrong = await fetch(`${base}/api/admin/workers`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
  assert.equal((await admin('/ping')).status, 200);
});

test('the kiosk endpoint validates its input', async () => {
  const response = await fetch(`${base}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'uid_required');
});

test('full round trip: create worker, enroll a fob, punch in and out, export', async () => {
  const created = await (
    await admin('/workers', {
      method: 'POST',
      body: { fullName: 'Ana Gómez', code: 'E001', documentId: '30111222', hourlyRate: 1500 },
    })
  ).json();
  assert.equal(created.code, 'E001');

  // A tap before the fob is known is logged, not punched.
  assert.equal((await (await scan('04A21B3C')).json()).result, 'unknown_tag');

  await admin(`/workers/${created.id}/enroll`, { method: 'POST', body: { ttlSeconds: 60 } });
  assert.equal((await (await scan('04A21B3C')).json()).result, 'enrolled');

  const checkIn = await (await scan('04A21B3C')).json();
  assert.equal(checkIn.result, 'checked_in');

  const onSite = await (await admin('/onsite')).json();
  assert.equal(onSite.length, 1);
  assert.equal(onSite[0].fullName, 'Ana Gómez');

  const checkOut = await (await scan('04A21B3C')).json();
  assert.equal(checkOut.result, 'checked_out');
  assert.equal((await (await admin('/onsite')).json()).length, 0);

  const sheet = await (await admin('/timesheet')).json();
  assert.equal(sheet.shifts.length, 1);
  assert.equal(sheet.summary[0].fullName, 'Ana Gómez');

  const csv = await admin('/export/shifts.csv');
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  const text = await csv.text();
  assert.ok(text.includes('Ana Gómez'));
  assert.ok(text.includes('legajo'));

  // Dux is unconfigured here, so the shift stays queued for later.
  const duxStatus = await (await admin('/dux/status')).json();
  assert.equal(duxStatus.configured, false);
  assert.equal(duxStatus.counts.pending, 1);
});

test('a duplicate code is refused', async () => {
  const response = await admin('/workers', { method: 'POST', body: { fullName: 'Otro', code: 'E001' } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'code_already_exists');
});

test('manual punches respect the open/closed state', async () => {
  const worker = await (await admin('/workers', { method: 'POST', body: { fullName: 'Beto Ruiz' } })).json();

  const tooEarly = await admin('/punch', { method: 'POST', body: { workerId: worker.id, direction: 'out' } });
  assert.equal(tooEarly.status, 409);
  assert.equal((await tooEarly.json()).error, 'not_checked_in');

  assert.equal((await admin('/punch', { method: 'POST', body: { workerId: worker.id, direction: 'in' } })).status, 201);
  const twice = await admin('/punch', { method: 'POST', body: { workerId: worker.id, direction: 'in' } });
  assert.equal((await twice.json()).error, 'already_checked_in');
  assert.equal((await admin('/punch', { method: 'POST', body: { workerId: worker.id, direction: 'out' } })).status, 201);
});

test('editing a shift recomputes its hours and re-queues it for Dux', async () => {
  const sheet = await (await admin('/timesheet')).json();
  const shift = sheet.shifts.find((s) => s.status === 'closed');

  const updated = await (
    await admin(`/shifts/${shift.id}`, {
      method: 'PATCH',
      body: { startedAt: '2026-09-21T11:00:00Z', endedAt: '2026-09-21T19:00:00Z', note: 'Corrección' },
    })
  ).json();
  assert.equal(updated.minutes, 480);
  assert.equal(updated.business_day, '2026-09-21');
  assert.equal(updated.note, 'Corrección');

  const preview = await (await admin(`/dux/preview/${shift.id}`)).json();
  assert.equal(preview.payload.horas_trabajadas, 8);
  assert.equal(preview.payload.entrada, '2026-09-21 08:00:00');
});

test('deactivating a worker hides them but keeps their history', async () => {
  const worker = await (await admin('/workers', { method: 'POST', body: { fullName: 'Temporal' } })).json();
  await admin(`/workers/${worker.id}`, { method: 'DELETE' });

  const active = await (await admin('/workers')).json();
  assert.ok(!active.some((w) => w.id === worker.id));
  const all = await (await admin('/workers?includeInactive=true')).json();
  assert.ok(all.some((w) => w.id === worker.id && w.active === false));
});

test('unknown routes answer with JSON, not HTML', async () => {
  const response = await fetch(`${base}/api/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not_found');
});
