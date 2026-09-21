'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = path.resolve(__dirname, '..', '.env');

// Load .env without pulling in a dependency. process.loadEnvFile exists on
// modern Node; the manual parse keeps older runtimes working.
function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(ENV_FILE);
    return;
  }
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!m) continue;
    let value = (m[2] || '').trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile();

const str = (key, fallback = '') => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : String(v);
};
const num = (key, fallback) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
};
const bool = (key, fallback) => {
  const v = str(key, '').toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};
const json = (key, fallback) => {
  try {
    const parsed = JSON.parse(str(key, ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 3000),
  host: str('HOST', '0.0.0.0'),

  timezone: str('TZ_NAME', 'America/Argentina/Buenos_Aires'),
  dayCutoffHour: num('DAY_CUTOFF_HOUR', 0),
  lang: str('LANG_DEFAULT', 'es'),

  scanDebounceSeconds: num('SCAN_DEBOUNCE_SECONDS', 90),
  maxShiftHours: num('MAX_SHIFT_HOURS', 14),
  roundMinutes: num('ROUND_MINUTES', 0),
  breakMinutes: num('BREAK_MINUTES', 0),
  breakAfterHours: num('BREAK_AFTER_HOURS', 6),

  adminToken: str('ADMIN_TOKEN', ''),
  kioskKey: str('KIOSK_KEY', ''),

  dbPath: path.resolve(__dirname, '..', str('DB_PATH', './data/timeclock.db')),

  dux: {
    baseUrl: str('DUX_BASE_URL', '').replace(/\/+$/, ''),
    apiKey: str('DUX_API_KEY', ''),
    authMode: str('DUX_AUTH_MODE', 'header'),
    authHeader: str('DUX_AUTH_HEADER', 'Authorization'),
    authPrefix: str('DUX_AUTH_PREFIX', 'Bearer'),
    authQueryParam: str('DUX_AUTH_QUERY_PARAM', 'key'),
    timesheetPath: str('DUX_TIMESHEET_PATH', '/api/v1/asistencias'),
    method: str('DUX_HTTP_METHOD', 'POST').toUpperCase(),
    extraFields: json('DUX_EXTRA_FIELDS', {}),
    syncEnabled: bool('DUX_SYNC_ENABLED', true),
    // 'daily'      -> one batch at DUX_DAILY_TIME
    // 'continuous' -> push each shift a minute or so after check-out
    syncMode: str('DUX_SYNC_MODE', 'daily').toLowerCase() === 'continuous' ? 'continuous' : 'daily',
    dailyTime: str('DUX_DAILY_TIME', '17:00'),
    catchUpOnStart: bool('DUX_CATCH_UP_ON_START', true),
    retryIntervalSeconds: num('DUX_RETRY_INTERVAL_SECONDS', 900),
    syncIntervalSeconds: num('DUX_SYNC_INTERVAL_SECONDS', 60),
    maxAttempts: num('DUX_MAX_ATTEMPTS', 8),
    timeoutMs: num('DUX_TIMEOUT_MS', 15000),
  },

  // Optional: drop a CSV of the day next to each scheduled upload.
  dailyExportDir: str('DAILY_EXPORT_DIR', ''),
};

config.dux.configured = Boolean(config.dux.baseUrl);

module.exports = config;
