'use strict';

const express = require('express');
const config = require('../config');
const time = require('../time');
const clock = require('../clock');
const { getDb } = require('../db');

const router = express.Router();

/** Optional shared secret so a random device on the LAN cannot punch for people. */
function requireDeviceKey(req, res, next) {
  if (!config.kioskKey) return next();
  const key = req.get('x-device-key') || req.query.key;
  if (key !== config.kioskKey) return res.status(401).json({ error: 'invalid_device_key' });
  return next();
}

// A tap. `uid` is whatever the reader typed; normalization happens downstream.
router.post('/scan', requireDeviceKey, (req, res) => {
  const { uid, device } = req.body || {};
  if (typeof uid !== 'string' || !uid.trim()) {
    return res.status(400).json({ error: 'uid_required' });
  }
  const outcome = clock.handleScan(getDb(), {
    uid,
    device: typeof device === 'string' ? device.slice(0, 64) : null,
  });
  return res.json({ ...outcome, serverTime: time.nowIso() });
});

// Who is on site, for the kiosk footer.
router.get('/status', (req, res) => {
  const db = getDb();
  res.json({
    serverTime: time.nowIso(),
    timezone: config.timezone,
    businessDay: time.businessDay(time.nowIso(), config.timezone, config.dayCutoffHour),
    onSite: clock.onSiteNow(db),
    enrollment: clock.enrollmentState(),
  });
});

// Settings the kiosk page needs before the first scan.
router.get('/config', (req, res) => {
  res.json({
    timezone: config.timezone,
    lang: config.lang,
    requiresDeviceKey: Boolean(config.kioskKey),
    duxConfigured: config.dux.configured,
  });
});

module.exports = router;
