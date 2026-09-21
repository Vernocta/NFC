'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT    NOT NULL UNIQUE,
  full_name        TEXT    NOT NULL,
  document_id      TEXT,
  role             TEXT,
  hourly_rate      REAL,
  dux_employee_id  TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT    NOT NULL UNIQUE,
  worker_id   INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  label       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tags_worker ON tags(worker_id);

CREATE TABLE IF NOT EXISTS punches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id    INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  tag_uid      TEXT,
  direction    TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
  punched_at   TEXT    NOT NULL,
  business_day TEXT    NOT NULL,
  device       TEXT,
  source       TEXT    NOT NULL DEFAULT 'nfc',
  note         TEXT,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_punches_worker_day ON punches(worker_id, business_day);
CREATE INDEX IF NOT EXISTS idx_punches_at ON punches(punched_at);

CREATE TABLE IF NOT EXISTS shifts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id     INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  business_day  TEXT    NOT NULL,
  started_at    TEXT    NOT NULL,
  ended_at      TEXT,
  minutes       INTEGER,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'closed', 'auto_closed')),
  in_punch_id   INTEGER REFERENCES punches(id),
  out_punch_id  INTEGER REFERENCES punches(id),
  note          TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shifts_worker_day ON shifts(worker_id, business_day);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);

CREATE TABLE IF NOT EXISTS dux_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id        INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  payload         TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TEXT    NOT NULL,
  sent_at         TEXT,
  dux_ref         TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON dux_outbox(status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_shift ON dux_outbox(shift_id);

CREATE TABLE IF NOT EXISTS unknown_scans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL,
  device     TEXT,
  scanned_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unknown_at ON unknown_scans(scanned_at);
`;

let db;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Point the module at another file (or ':memory:'); used by the tests. */
function openDatabase(filePath) {
  const instance = new Database(filePath);
  instance.pragma('foreign_keys = ON');
  instance.exec(SCHEMA);
  db = instance;
  return instance;
}

function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

module.exports = { getDb, openDatabase, closeDb, SCHEMA };
