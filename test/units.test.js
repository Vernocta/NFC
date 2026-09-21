'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeUid, uidVariants, reverseBytes } = require('../src/uid');
const time = require('../src/time');
const timesheet = require('../src/timesheet');

const TZ = 'America/Argentina/Buenos_Aires';

test('normalizeUid strips separators, case and decimal padding', () => {
  assert.equal(normalizeUid(' 04:a2:1b:3c '), '04A21B3C');
  assert.equal(normalizeUid('04-A2-1B-3C'), '04A21B3C');
  assert.equal(normalizeUid('0077928450'), '77928450');
  assert.equal(normalizeUid(''), '');
  assert.equal(normalizeUid(null), '');
});

test('uidVariants bridges the spellings different readers emit', () => {
  const fromHex = uidVariants('04A21B3C');
  assert.ok(fromHex.includes('04A21B3C'));
  assert.ok(fromHex.includes(reverseBytes('04A21B3C')));

  // Same fob, read by a decimal reader, still resolves to the hex spelling.
  const decimal = BigInt('0x04A21B3C').toString(10);
  assert.ok(uidVariants(decimal).includes('04A21B3C'));
});

test('businessDay honours the night-shift cutoff', () => {
  // 02:00 local on the 22nd belongs to the 21st when the cutoff is 05:00.
  assert.equal(time.businessDay('2026-09-22T05:00:00Z', TZ, 5), '2026-09-21');
  assert.equal(time.businessDay('2026-09-22T05:00:00Z', TZ, 0), '2026-09-22');
});

test('time helpers convert and format', () => {
  assert.equal(time.localStamp('2026-09-21T12:00:00Z', TZ), '2026-09-21 09:00:00');
  assert.equal(time.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(time.minutesBetween('2026-09-21T08:00:00Z', '2026-09-21T16:30:00Z'), 510);
  assert.equal(time.decimalHours(510), 8.5);
  assert.equal(time.humanMinutes(510), '8h 30m');
  assert.equal(time.roundMinutes(53, 15), 60);
  assert.equal(time.roundMinutes(53, 0), 53);
});

test('summarize totals hours per worker and skips open shifts', () => {
  const shifts = [
    { workerId: 1, workerCode: 'E1', fullName: 'Ana', minutes: 480, businessDay: '2026-09-21', status: 'closed', hourlyRate: 10 },
    { workerId: 1, workerCode: 'E1', fullName: 'Ana', minutes: 240, businessDay: '2026-09-22', status: 'closed', hourlyRate: 10 },
    { workerId: 2, workerCode: 'E2', fullName: 'Beto', minutes: 60, businessDay: '2026-09-22', status: 'open', hourlyRate: 10 },
  ];
  const summary = timesheet.summarize(shifts);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].hours, 12);
  assert.equal(summary[0].days, 2);
  assert.equal(summary[0].amount, 120);
});

test('CSV quotes separators and keeps the Excel BOM', () => {
  const csv = timesheet.toCsv(['a', 'b'], [['plain', 'has,comma'], ['say "hi"', null]]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('"has,comma"'));
  assert.ok(csv.includes('"say ""hi"""'));
});
