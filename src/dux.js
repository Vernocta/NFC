'use strict';

const config = require('./config');
const time = require('./time');

/**
 * Dux integration.
 *
 * Every closed shift lands in the `dux_outbox` table first and is pushed from
 * there. That way the clock keeps working when the network, the API key or
 * Dux itself is unavailable: nothing is lost, and the queue drains later.
 * Until DUX_BASE_URL is set, rows simply accumulate as `pending` and can be
 * exported to CSV instead.
 */

const BASE_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** The JSON body sent to Dux for one shift. Keys mirror Dux's Spanish API. */
function buildPayload(db, shiftId) {
  const row = db
    .prepare(
      `SELECT s.*, w.code AS worker_code, w.full_name, w.document_id,
              w.dux_employee_id, w.role, w.hourly_rate
         FROM shifts s
         JOIN workers w ON w.id = s.worker_id
        WHERE s.id = ?`
    )
    .get(shiftId);
  if (!row) throw new Error(`Shift ${shiftId} not found`);
  if (!row.ended_at) throw new Error(`Shift ${shiftId} is still open`);

  const tz = config.timezone;
  return {
    external_id: `shift-${row.id}`,
    origen: 'nfc-timeclock',
    empleado: {
      id: row.dux_employee_id || null,
      codigo: row.worker_code,
      nombre: row.full_name,
      documento: row.document_id || null,
      puesto: row.role || null,
    },
    fecha: row.business_day,
    entrada: time.localStamp(row.started_at, tz),
    salida: time.localStamp(row.ended_at, tz),
    entrada_utc: row.started_at,
    salida_utc: row.ended_at,
    minutos_trabajados: row.minutes,
    horas_trabajadas: time.decimalHours(row.minutes),
    minutos_descanso: row.break_minutes,
    estado: row.status,
    observacion: row.note || null,
    ...config.dux.extraFields,
  };
}

/** Queue a closed shift for Dux. Re-queuing an already sent shift is a no-op. */
function enqueueShift(db, shiftId, { force = false } = {}) {
  const payload = JSON.stringify(buildPayload(db, shiftId));
  const now = time.nowIso();
  const existing = db.prepare('SELECT * FROM dux_outbox WHERE shift_id = ?').get(shiftId);

  if (!existing) {
    db.prepare(
      `INSERT INTO dux_outbox (shift_id, payload, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?, ?)`
    ).run(shiftId, payload, now, now, now);
    return { queued: true };
  }
  if (existing.status === 'sent' && !force) return { queued: false, reason: 'already_sent' };

  db.prepare(
    `UPDATE dux_outbox
        SET payload = ?, status = 'pending', attempts = 0, last_error = NULL,
            next_attempt_at = ?, updated_at = ?
      WHERE id = ?`
  ).run(payload, now, now, existing.id);
  return { queued: true, requeued: true };
}

function targetUrl() {
  const { baseUrl, timesheetPath, authMode, authQueryParam, apiKey } = config.dux;
  const url = new URL(`${baseUrl}${timesheetPath.startsWith('/') ? '' : '/'}${timesheetPath}`);
  if (authMode === 'query' && apiKey) url.searchParams.set(authQueryParam, apiKey);
  return url.toString();
}

function requestHeaders() {
  const { authMode, authHeader, authPrefix, apiKey } = config.dux;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (authMode === 'header' && apiKey) {
    headers[authHeader] = authPrefix ? `${authPrefix} ${apiKey}` : apiKey;
  }
  return headers;
}

/** POST one payload to Dux. Returns { ok, status, body, ref }. */
async function pushPayload(payload, { fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.dux.timeoutMs);
  try {
    const response = await fetchImpl(targetUrl(), {
      method: config.dux.method,
      headers: requestHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const ref = body && typeof body === 'object' ? body.id ?? body.external_id ?? null : null;
    return { ok: response.ok, status: response.status, body, ref: ref ? String(ref) : null };
  } finally {
    clearTimeout(timer);
  }
}

function backoffFrom(attempts) {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

/** Push one queued row and record the outcome. */
async function deliver(db, row, options = {}) {
  const attempts = row.attempts + 1;
  const now = time.nowIso();
  try {
    const result = await pushPayload(JSON.parse(row.payload), options);
    if (result.ok) {
      db.prepare(
        `UPDATE dux_outbox
            SET status = 'sent', attempts = ?, sent_at = ?, dux_ref = ?,
                last_error = NULL, updated_at = ?
          WHERE id = ?`
      ).run(attempts, now, result.ref, now, row.id);
      return { ok: true, id: row.id };
    }
    const snippet = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    throw new Error(`HTTP ${result.status}: ${String(snippet).slice(0, 300)}`);
  } catch (error) {
    const terminal = attempts >= config.dux.maxAttempts;
    db.prepare(
      `UPDATE dux_outbox
          SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ?`
    ).run(
      terminal ? 'failed' : 'pending',
      attempts,
      error.message,
      new Date(Date.now() + backoffFrom(attempts)).toISOString(),
      now,
      row.id
    );
    return { ok: false, id: row.id, error: error.message, terminal };
  }
}

/** Drain the queue: every pending row whose retry time has come. */
async function processOutbox(db, { limit = 25, ...options } = {}) {
  if (!config.dux.configured) return { skipped: 'not_configured', sent: 0, failed: 0 };
  const rows = db
    .prepare(
      `SELECT * FROM dux_outbox
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT ?`
    )
    .all(time.nowIso(), limit);

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await deliver(db, row, options);
    if (result.ok) sent += 1;
    else failed += 1;
  }
  return { sent, failed, processed: rows.length };
}

/** Counts per status plus the oldest error, for the admin dashboard. */
function outboxStatus(db) {
  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM dux_outbox GROUP BY status')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), { pending: 0, sent: 0, failed: 0 });
  const lastError = db
    .prepare(
      `SELECT shift_id, attempts, last_error, updated_at
         FROM dux_outbox
        WHERE last_error IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`
    )
    .get();
  return {
    configured: config.dux.configured,
    endpoint: config.dux.configured ? targetUrl().replace(/(key=)[^&]+/, '$1***') : null,
    syncEnabled: config.dux.syncEnabled,
    counts,
    lastError: lastError || null,
  };
}

/** Reset failed rows so the next sync pass tries them again. */
function retryFailed(db) {
  const now = time.nowIso();
  const info = db
    .prepare(
      `UPDATE dux_outbox
          SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?
        WHERE status = 'failed'`
    )
    .run(now, now);
  return { requeued: info.changes };
}

function startSyncLoop(db, { intervalSeconds = config.dux.syncIntervalSeconds } = {}) {
  if (!config.dux.configured || !config.dux.syncEnabled) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await processOutbox(db);
      if (result.processed) {
        console.log(`[dux] sync: ${result.sent} sent, ${result.failed} failed`);
      }
    } catch (error) {
      console.error('[dux] sync loop error:', error.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, Math.max(5, intervalSeconds) * 1000);
  timer.unref?.();
  tick();
  return timer;
}

module.exports = {
  buildPayload,
  enqueueShift,
  pushPayload,
  deliver,
  processOutbox,
  outboxStatus,
  retryFailed,
  startSyncLoop,
  targetUrl,
};
