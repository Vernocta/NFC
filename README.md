# Reloj NFC — fichaje de entrada y salida

An NFC time clock for task workers. A worker taps their keychain tag on the
reader; the system decides whether that tap is a check-in or a check-out,
stores the shift, and pushes the hours to **Dux software** — with a CSV
export as the fallback path.

```
 keychain tag ──▶ USB reader ──▶ kiosk page ──▶ server ──▶ SQLite
                                                   │
                                                   ├──▶ Dux REST API — one batch every day at 17:00
                                                   └──▶ CSV export (asistencias / horas)
```

- **Kiosk** (`/`) — full-screen terminal for the entrance. One tap toggles
  in/out, big green/orange feedback, audible beep, live "on site now" list.
- **Admin** (`/admin`) — staff and tags, live board, timesheets, CSV export,
  Dux queue, manual corrections.

---

## 1. Requirements

- Node.js 20 or newer.
- Any NFC/RFID reader that behaves as a **keyboard wedge** — it "types" the
  tag UID and presses Enter. That covers the common 125 kHz EM4100 and
  13.56 MHz MIFARE USB readers sold as "USB RFID reader, no driver needed".
- A PC, Raspberry Pi or tablet at the entrance to run the kiosk page.

Nothing has to be installed on the terminal beyond a browser: the reader is
seen as a keyboard, and the page listens for it. Android phones with NFC can
also scan through the same page (Web NFC, requires HTTPS or localhost).

## 2. Quick start

```bash
npm install
cp .env.example .env        # then edit ADMIN_TOKEN at minimum
npm start
```

- Kiosk: <http://localhost:3000/>
- Admin: <http://localhost:3000/admin> (log in with `ADMIN_TOKEN`)

To try it with demo staff and three days of history:

```bash
npm run seed                # demo tags: 04A21B3C, 04B32C4D, 04C43D5E
```

With the kiosk page open you can type a UID and press Enter — that is exactly
what the reader does.

## 3. Enrolling a keychain tag

1. Admin → **Personal** → add the worker (name, legajo, DNI, hourly rate).
2. Press **Alta llavero** on their row. The reader is now armed for 2 minutes.
3. Tap the fob on the reader. It is bound to that worker and the kiosk
   confirms *Llavero asignado*.

A fob that is tapped before it is enrolled shows *Llavero no reconocido* and
is listed under **Panel → Llaveros no reconocidos**, so you can copy the UID
and assign it by hand if you prefer.

Readers disagree on how to spell a UID — `04:A2:1B:3C`, `04A21B3C`, the
byte-reversed `3C1BA204`, or the decimal `77928450`. The server normalizes
the input and looks up every plausible spelling, so a fob enrolled on one
reader keeps working on another.

## 4. How the clock decides in vs. out

There is no IN/OUT button. The tap toggles:

| Situation at the moment of the tap | Result |
| --- | --- |
| No open shift | **Check-in** — a shift is opened |
| An open shift exists | **Check-out** — the shift is closed and its hours computed |
| Same worker tapped < `SCAN_DEBOUNCE_SECONDS` ago | **Ignored** — reader bounce, nothing is written |
| Shift left open longer than `MAX_SHIFT_HOURS` | **Auto-closed** at the limit and flagged for review |

Every tap is written to `punches` as an immutable audit trail. The paired
result lives in `shifts`, which is what payroll and Dux read.

Optional rules, all in `.env`:

- `BREAK_MINUTES` / `BREAK_AFTER_HOURS` — deduct an unpaid break from shifts
  over a given length.
- `ROUND_MINUTES` — round each closed shift (e.g. `15`).
- `DAY_CUTOFF_HOUR` — keep a night shift on the day it started.

## 5. Connecting to Dux software

Every closed shift is written to a local **outbox** table first and uploaded
from there, with exponential backoff and up to `DUX_MAX_ATTEMPTS` retries.
If the network, the key or Dux itself is unavailable, nothing is lost: the
clock keeps working and the queue drains on the next run.

### When it uploads

By default the hours go up **once a day at 17:00**, in the site's timezone:

```bash
DUX_SYNC_MODE=daily         # daily | continuous
DUX_DAILY_TIME=17:00        # local wall-clock time, in TZ_NAME
DUX_CATCH_UP_ON_START=true  # upload on boot if that hour was missed
DUX_RETRY_INTERVAL_SECONDS=900
```

- Shifts **still open at 17:00** are not sent — nobody knows their hours yet.
  They go out in the next day's run, once the worker has checked out.
- If the upload cannot drain the queue (network down, Dux returning errors),
  it retries every `DUX_RETRY_INTERVAL_SECONDS` rather than waiting a whole
  day, and gives up for that round after `DUX_MAX_ATTEMPTS` per shift.
- If the server was switched off at 17:00, it uploads as soon as it starts
  again. Every run is recorded, so a restart never causes a double run.
- `DUX_SYNC_MODE=continuous` pushes each shift about a minute after
  check-out instead, using `DUX_SYNC_INTERVAL_SECONDS`.

**Admin → Dux** shows the mode, the next run, the last run and a history of
recent uploads, plus a **Subir ahora** button that runs the same batch on
demand.

Optionally, set `DAILY_EXPORT_DIR=./data/exports` to also drop a CSV of the
day beside each upload. The previous day's file is refreshed on every run,
so a check-out at 18:00 still lands in the right file.

```bash
DUX_BASE_URL=https://erp.duxsoftware.com.ar
DUX_API_KEY=your-key
DUX_TIMESHEET_PATH=/api/v1/asistencias
DUX_AUTH_MODE=header          # header | query
DUX_AUTH_HEADER=Authorization
DUX_AUTH_PREFIX=Bearer
DUX_EXTRA_FIELDS={"sucursal":"OBRA-1"}
```

> **Adjust these to your Dux account.** Dux issues the base URL, the key and
> the endpoint path per customer, and the exact attendance endpoint depends on
> which Dux modules you have. The values above are placeholders; the path,
> the auth style and any extra fields are all configuration, so no code has to
> change. Confirm the endpoint with Dux support, put it in `.env`, and use
> **Admin → Horas → Enviar a Dux** on one shift to verify before enabling the
> automatic sync.

The body sent for one shift:

```json
{
  "external_id": "shift-1",
  "origen": "nfc-timeclock",
  "empleado": {
    "id": "DUX-77", "codigo": "E001",
    "nombre": "Ana Gómez", "documento": "30111222", "puesto": "Oficial"
  },
  "fecha": "2026-09-21",
  "entrada": "2026-09-21 08:00:00",
  "salida": "2026-09-21 16:00:00",
  "entrada_utc": "2026-09-21T11:00:00.000Z",
  "salida_utc": "2026-09-21T19:00:00.000Z",
  "minutos_trabajados": 480,
  "horas_trabajadas": 8,
  "minutos_descanso": 0,
  "estado": "closed"
}
```

`external_id` is stable per shift, so Dux can treat a repeated delivery as an
update rather than a duplicate. If Dux expects different field names, edit
`buildPayload()` in `src/dux.js` — that one function is the whole mapping.

Check what would be sent, without sending it:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3000/api/admin/dux/preview/1
```

**Admin → Dux** shows the queue (sent / pending / failed), the last error, a
*Sincronizar ahora* button and *Reintentar fallidos*.

### CSV export

Works whether or not the API is configured — **Admin → Horas**:

- `CSV resumen` — one line per worker: `legajo, empleado, documento,
  dux_empleado_id, dias, turnos, horas, valor_hora, importe`.
- `CSV detalle` — one line per shift: `legajo, empleado, documento,
  dux_empleado_id, fecha, entrada, salida, minutos, horas, minutos_descanso,
  estado, observacion`.

Files are UTF-8 with a BOM so accented names survive Excel. Add
`&delimiter=;` to the URL for a semicolon-separated file if your regional
settings need it.

## 6. Configuration reference

All settings live in `.env` (see `.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens |
| `TZ_NAME` | `America/Argentina/Buenos_Aires` | Timezone for business days and display |
| `DAY_CUTOFF_HOUR` | `0` | Hours before this belong to the previous day |
| `LANG_DEFAULT` | `es` | Kiosk language (`es` / `en`, override with `?lang=en`) |
| `SCAN_DEBOUNCE_SECONDS` | `90` | Ignore a repeat tap within this window |
| `MAX_SHIFT_HOURS` | `14` | Auto-close limit for a forgotten check-out |
| `ROUND_MINUTES` | `0` | Round each closed shift |
| `BREAK_MINUTES` / `BREAK_AFTER_HOURS` | `0` / `6` | Unpaid break deduction |
| `ADMIN_TOKEN` | — | **Required.** Protects every admin route |
| `KIOSK_KEY` | empty | Optional shared secret for kiosk terminals |
| `DUX_SYNC_MODE` | `daily` | `daily` (one batch) or `continuous` |
| `DUX_DAILY_TIME` | `17:00` | Local time of the daily upload |
| `DUX_CATCH_UP_ON_START` | `true` | Upload on boot if the hour was missed |
| `DUX_RETRY_INTERVAL_SECONDS` | `900` | Retry gap when a run cannot drain the queue |
| `DUX_*` | see above | Dux endpoint, auth and retry limits |
| `DAILY_EXPORT_DIR` | empty | Optional CSV copy written at upload time |
| `DB_PATH` | `./data/timeclock.db` | SQLite file |

## 7. HTTP API

Kiosk (no auth, or `X-Device-Key` when `KIOSK_KEY` is set):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/scan` | `{ uid, device }` → the punch result |
| `GET` | `/api/status` | Who is on site, server time, enrollment state |
| `GET` | `/api/config` | Timezone and language for the kiosk page |
| `GET` | `/health` | Liveness probe |

Admin — every route needs `Authorization: Bearer $ADMIN_TOKEN`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/admin/workers` | List / create staff |
| `PATCH/DELETE` | `/api/admin/workers/:id` | Edit / deactivate (history is kept) |
| `GET/POST` | `/api/admin/workers/:id/tags` | List / add a tag by UID |
| `POST` | `/api/admin/workers/:id/enroll` | Arm the reader for the next tap |
| `DELETE` | `/api/admin/tags/:id` | Remove a tag |
| `GET` | `/api/admin/onsite` | Open shifts |
| `GET` | `/api/admin/timesheet?from&to&workerId` | Shifts plus per-worker totals |
| `POST` | `/api/admin/punch` | Manual punch (forgotten fob) |
| `PATCH/DELETE` | `/api/admin/shifts/:id` | Correct or remove a shift |
| `GET` | `/api/admin/export/shifts.csv` | Detail CSV |
| `GET` | `/api/admin/export/summary.csv` | Summary CSV |
| `GET` | `/api/admin/dux/status` | Queue counters, last error and the schedule |
| `GET` | `/api/admin/sync/schedule` | Next run, last run, recent upload history |
| `POST` | `/api/admin/sync/run` | Run the daily batch now |
| `POST` | `/api/admin/dux/sync` | Drain the queue now |
| `POST` | `/api/admin/dux/retry` | Re-queue failed rows |
| `POST` | `/api/admin/dux/push/:shiftId` | Push one shift immediately |
| `GET` | `/api/admin/dux/preview/:shiftId` | Show the payload without sending |

Scan results: `checked_in`, `checked_out`, `duplicate`, `unknown_tag`,
`inactive_worker`, `enrolled`, `already_enrolled`, `tag_taken`, `invalid_uid`.

## 8. Running it on site

```bash
sudo cp deploy/nfc-timeclock.service /etc/systemd/system/
sudo systemctl enable --now nfc-timeclock
```

`deploy/kiosk-autostart.md` covers starting the browser full-screen on a
Raspberry Pi, Windows or an Android tablet, and naming each terminal with
`?device=entrada-1`.

Notes for a real installation:

- Put a real value in `ADMIN_TOKEN`; the server warns on boot if you did not.
- The daily upload runs inside the server process, so the machine has to be
  on at 17:00. systemd keeps it running across reboots, and
  `DUX_CATCH_UP_ON_START` covers a machine that was off at that hour.
- Everything lives in one SQLite file — back up `data/timeclock.db`
  (`sqlite3 data/timeclock.db ".backup backup.db"`).
- The server binds to the LAN. Do not expose it to the internet directly; if
  you need remote access, put it behind a reverse proxy with TLS.
- Set `KIOSK_KEY` if untrusted devices share the network.

## 9. Project layout

```
src/
  server.js      Express app, static hosting, background sweeps
  config.js      .env loading and defaults
  db.js          SQLite schema (workers, tags, punches, shifts, dux_outbox)
  clock.js       The punch engine: toggle, debounce, auto-close, enrollment
  dux.js         Dux payload, outbox, retry/backoff
  scheduler.js   The daily upload: when it runs, catch-up, run history
  timesheet.js   Range queries, per-worker totals, CSV builders
  time.js        Timezone, business days, rounding
  uid.js         Tag UID normalization across reader formats
  routes/        kiosk.js (public) and admin.js (token-protected)
public/          Kiosk and admin pages (no build step, no framework)
test/            node:test suites
deploy/          systemd unit and kiosk autostart notes
```

## 10. Tests

```bash
npm test
```

41 tests covering UID normalization across reader formats, business-day and
rounding maths, the full punch lifecycle (toggle, debounce, break deduction,
auto-close, enrollment conflicts), the Dux payload, its retry/backoff and
give-up behaviour, the daily upload (next-run time across midnight, open
shifts deferred to the next run, catch-up detection, overlap locking, the
CSV copy), and the HTTP API end to end including auth and CSV export.

## 11. Ideas for later

Deliberately left out to keep this simple; each is a small addition:

- Photo of the worker on the kiosk confirmation.
- Per-job/cost-centre tagging (a second tap on a job tag) for job costing.
- Scheduled shifts with late-arrival and overtime flags.
- Pulling the staff list from Dux instead of typing it in.
