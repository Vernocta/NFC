'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const time = require('./time');
const clock = require('./clock');
const dux = require('./dux');
const { getDb } = require('./db');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use('/api', require('./routes/kiosk'));
  app.use('/api/admin', require('./routes/admin'));

  app.get('/health', (req, res) =>
    res.json({
      ok: true,
      serverTime: time.nowIso(),
      timezone: config.timezone,
      dux: { configured: config.dux.configured, syncEnabled: config.dux.syncEnabled },
    })
  );

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, req, res, next) => {
    console.error('[error]', error);
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: 'internal_error', message: error.message });
  });

  return app;
}

function start() {
  const db = getDb();

  if (!config.adminToken || config.adminToken === 'change-me-please') {
    console.warn('[warn] ADMIN_TOKEN is unset or still the default — set it before going live.');
  }

  // Sweep forgotten check-outs at boot and hourly after that.
  const sweep = () => {
    const closed = clock.autoCloseStaleShifts(db);
    if (closed.length) console.log(`[clock] auto-closed ${closed.length} forgotten shift(s)`);
  };
  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();

  dux.startSyncLoop(db);

  const server = createApp().listen(config.port, config.host, () => {
    console.log(`NFC time clock listening on http://${config.host}:${config.port}`);
    console.log(`  kiosk  →  http://${config.host}:${config.port}/`);
    console.log(`  admin  →  http://${config.host}:${config.port}/admin`);
    console.log(
      config.dux.configured
        ? `  dux    →  ${dux.targetUrl()}`
        : '  dux    →  not configured (punches queue locally; CSV export available)'
    );
  });

  const shutdown = () => {
    console.log('\nShutting down…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (require.main === module) start();

module.exports = { createApp, start };
