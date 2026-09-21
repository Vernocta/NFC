'use strict';

/**
 * Demo data, so the kiosk and the admin console have something to show
 * before the first real fob is enrolled.  Usage:  npm run seed
 */

const config = require('../src/config');
const time = require('../src/time');
const clock = require('../src/clock');
const { getDb } = require('../src/db');

const db = getDb();

const PEOPLE = [
  { code: 'E001', full_name: 'Ana Gómez', document_id: '30111222', role: 'Oficial', hourly_rate: 4200, uid: '04A21B3C' },
  { code: 'E002', full_name: 'Beto Ruiz', document_id: '28999111', role: 'Ayudante', hourly_rate: 3400, uid: '04B32C4D' },
  { code: 'E003', full_name: 'Carla Díaz', document_id: '33455677', role: 'Oficial especializada', hourly_rate: 4800, uid: '04C43D5E' },
];

const now = time.nowIso();
const insertWorker = db.prepare(
  `INSERT OR IGNORE INTO workers (code, full_name, document_id, role, hourly_rate, active, created_at, updated_at)
   VALUES (@code, @full_name, @document_id, @role, @hourly_rate, 1, @now, @now)`
);
const insertTag = db.prepare('INSERT OR IGNORE INTO tags (uid, worker_id, label, active, created_at) VALUES (?, ?, ?, 1, ?)');

for (const person of PEOPLE) {
  insertWorker.run({ ...person, now });
  const worker = db.prepare('SELECT id FROM workers WHERE code = ?').get(person.code);
  insertTag.run(person.uid, worker.id, 'llavero', now);
}

// Three days of history: 08:00 to 17:00 local, plus one open shift today.
const workers = db.prepare('SELECT * FROM workers ORDER BY id').all();
for (let daysAgo = 3; daysAgo >= 1; daysAgo -= 1) {
  for (const worker of workers) {
    const day = new Date(Date.now() - daysAgo * 86400000);
    const start = new Date(day);
    start.setUTCHours(11, 0, 0, 0); // 08:00 in AR
    const end = new Date(start.getTime() + (8 + Math.random()) * 3600 * 1000);

    const inPunch = clock.insertPunch(db, {
      workerId: worker.id,
      tagUid: null,
      direction: 'in',
      at: start.toISOString(),
      device: 'seed',
      source: 'manual',
    });
    const shift = clock.startShift(db, { workerId: worker.id, at: start.toISOString(), punchId: inPunch.id });
    const outPunch = clock.insertPunch(db, {
      workerId: worker.id,
      tagUid: null,
      direction: 'out',
      at: end.toISOString(),
      device: 'seed',
      source: 'manual',
    });
    clock.closeShift(db, shift, { at: end.toISOString(), punchId: outPunch.id });
  }
}

const first = workers[0];
if (!clock.openShiftFor(db, first.id)) {
  const at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const punch = clock.insertPunch(db, { workerId: first.id, tagUid: null, direction: 'in', at, device: 'seed' });
  clock.startShift(db, { workerId: first.id, at, punchId: punch.id });
}

console.log(`Seeded ${workers.length} workers into ${config.dbPath}`);
console.log('Demo tag UIDs:', PEOPLE.map((p) => p.uid).join(', '));
console.log('Type one of them into the kiosk (or scan a real fob) to try it out.');
