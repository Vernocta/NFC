/* eslint-env browser */
'use strict';

/** Admin console: staff, tags, timesheets, CSV export and the Dux outbox. */

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'nfc.adminToken';

let token = '';
let workers = [];
let timezone = 'America/Argentina/Buenos_Aires';

try {
  token = localStorage.getItem(TOKEN_KEY) || '';
} catch {
  token = '';
}

/* ------------------------------------------------------------------- api */

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const response = await fetch(`/api/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    logout();
    throw new Error('unauthorized');
  }
  if (raw) return response;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function toast(message, isError = false) {
  const node = document.createElement('div');
  node.className = `toast${isError ? ' toast--error' : ''}`;
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

/* ------------------------------------------------------------- helpers */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const hm = (minutes) => {
  const m = Math.max(0, Math.round(minutes || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

const clockTime = (iso) =>
  iso
    ? new Intl.DateTimeFormat('es-AR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(
        new Date(iso)
      )
    : '—';

const dateTime = (iso) =>
  new Intl.DateTimeFormat('es-AR', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

const STATUS_LABEL = { open: 'Abierto', closed: 'Cerrado', auto_closed: 'Auto-cerrado' };
const RUN_LABEL = { daily: 'Programada', manual: 'Manual', retry: 'Reintento', catch_up: 'Recuperación' };

/** "hoy 17:00" / "mañana 17:00", so the next run reads at a glance. */
function relativeRun(iso) {
  if (!iso) return '—';
  const target = new Date(iso);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(target);
  const today = todayIso();
  const prefix = day === today ? 'hoy' : day === addDays(today, 1) ? 'mañana' : day;
  return `${prefix} ${clockTime(iso)}`;
}
const DUX_LABEL = { sent: 'Enviado', pending: 'Pendiente', failed: 'Error' };

const money = (value) =>
  value == null ? '—' : new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());

function addDays(isoDay, delta) {
  const d = new Date(`${isoDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ auth */

async function login(candidate) {
  token = candidate;
  await api('/ping');
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* session-only login */
  }
  $('login').hidden = true;
  $('app').hidden = false;
  await boot();
}

function logout() {
  token = '';
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing stored */
  }
  $('app').hidden = true;
  $('login').hidden = false;
}

$('login-btn').addEventListener('click', async () => {
  $('login-error').textContent = '';
  try {
    await login($('token').value.trim());
  } catch (error) {
    $('login-error').textContent =
      error.message === 'unauthorized' ? 'Token incorrecto.' : `No se pudo entrar: ${error.message}`;
  }
});
$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('login-btn').click();
});
$('logout').addEventListener('click', logout);

/* ------------------------------------------------------------------ tabs */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('tab--active', x === tab));
    document.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    });
    if (tab.dataset.tab === 'hours') loadTimesheet();
    if (tab.dataset.tab === 'dux') loadDux();
    if (tab.dataset.tab === 'workers') loadWorkers();
  });
});

/* ----------------------------------------------------------------- board */

async function loadBoard() {
  const [onSite, dux, sheet] = await Promise.all([
    api('/onsite'),
    api('/dux/status'),
    api(`/timesheet?from=${todayIso()}&to=${todayIso()}`),
  ]);

  $('stat-onsite').textContent = onSite.length;
  $('stat-pending').textContent = dux.counts.pending + dux.counts.failed;
  $('stat-next').textContent =
    dux.schedule?.mode === 'daily'
      ? `Próxima subida: ${relativeRun(dux.schedule.nextRunAt)}`
      : 'Subida continua';
  $('stat-hours').textContent = sheet.summary.reduce((sum, s) => sum + s.hours, 0).toFixed(2);

  $('onsite-body').innerHTML = onSite.length
    ? onSite
        .map(
          (w) => `<tr>
            <td><strong>${esc(w.fullName)}</strong>${w.role ? `<div class="muted" style="font-size:12px">${esc(w.role)}</div>` : ''}</td>
            <td>${clockTime(w.startedAt)}</td>
            <td class="num">${hm(w.minutesSoFar)}</td>
            <td class="num"><button class="btn--ghost btn--sm" data-checkout="${w.workerId}">Marcar salida</button></td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="empty">Nadie fichado.</td></tr>';

  const unknown = await api('/unknown-scans');
  $('unknown-body').innerHTML = unknown.length
    ? unknown
        .map(
          (u) => `<tr>
            <td><code>${esc(u.uid)}</code></td>
            <td class="muted">${esc(u.device || '—')}</td>
            <td class="muted">${dateTime(u.scanned_at)}</td>
            <td class="num"><button class="btn--ghost btn--sm" data-copy="${esc(u.uid)}">Copiar UID</button></td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="empty">Sin lecturas desconocidas.</td></tr>';
}

document.addEventListener('click', async (event) => {
  const checkout = event.target.closest('[data-checkout]');
  if (checkout) {
    try {
      await api('/punch', { method: 'POST', body: { workerId: Number(checkout.dataset.checkout), direction: 'out' } });
      toast('Salida registrada.');
      loadBoard();
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }

  const copy = event.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy);
    toast(`UID copiado: ${copy.dataset.copy}`);
  }
});

/* --------------------------------------------------------------- workers */

async function loadWorkers() {
  workers = await api(`/workers?includeInactive=${$('show-inactive').checked}`);

  $('workers-body').innerHTML = workers.length
    ? workers
        .map(
          (w) => `<tr>
            <td>
              <strong>${esc(w.fullName)}</strong>
              ${w.onSite ? '<span class="badge badge--in" style="margin-left:6px">en obra</span>' : ''}
              <div class="muted" style="font-size:12px">${esc(w.role || '')}${w.documentId ? ` · ${esc(w.documentId)}` : ''}</div>
            </td>
            <td>${esc(w.code)}</td>
            <td>${w.tagCount}</td>
            <td>${w.active ? '<span class="badge">activo</span>' : '<span class="badge badge--failed">inactivo</span>'}</td>
            <td class="num" style="white-space:nowrap">
              <button class="btn--ghost btn--sm" data-enroll="${w.id}">Alta llavero</button>
              <button class="btn--ghost btn--sm" data-tags="${w.id}">Llaveros</button>
              ${w.active ? `<button class="btn--danger btn--sm" data-deactivate="${w.id}">Baja</button>` : ''}
            </td>
          </tr>
          <tr hidden data-tagrow="${w.id}"><td colspan="5" class="muted" style="background:var(--panel-2)"></td></tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="empty">Todavía no hay personal cargado.</td></tr>';

  const options = `<option value="">Todos</option>${workers
    .map((w) => `<option value="${w.id}">${esc(w.fullName)}</option>`)
    .join('')}`;
  $('f-worker').innerHTML = options;
  $('m-worker').innerHTML = workers.map((w) => `<option value="${w.id}">${esc(w.fullName)}</option>`).join('');
}

$('show-inactive').addEventListener('change', loadWorkers);

$('w-create').addEventListener('click', async () => {
  const payload = {
    fullName: $('w-name').value.trim(),
    code: $('w-code').value.trim(),
    documentId: $('w-doc').value.trim(),
    role: $('w-role').value.trim(),
    hourlyRate: $('w-rate').value,
    duxEmployeeId: $('w-dux').value.trim(),
  };
  if (!payload.fullName) return toast('Falta el nombre.', true);
  try {
    await api('/workers', { method: 'POST', body: payload });
    ['w-name', 'w-code', 'w-doc', 'w-role', 'w-rate', 'w-dux'].forEach((id) => {
      $(id).value = '';
    });
    toast('Empleado agregado.');
    loadWorkers();
  } catch (error) {
    toast(error.message === 'code_already_exists' ? 'Ese legajo ya existe.' : error.message, true);
  }
});

document.addEventListener('click', async (event) => {
  const enroll = event.target.closest('[data-enroll]');
  if (enroll) {
    try {
      await api(`/workers/${enroll.dataset.enroll}/enroll`, { method: 'POST', body: { ttlSeconds: 120 } });
      toast('Modo alta activado: acercá el llavero al lector (2 min).');
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }

  const deactivate = event.target.closest('[data-deactivate]');
  if (deactivate) {
    if (!confirm('¿Dar de baja a este empleado? Su historial se conserva.')) return;
    await api(`/workers/${deactivate.dataset.deactivate}`, { method: 'DELETE' });
    toast('Empleado dado de baja.');
    loadWorkers();
    return;
  }

  const tags = event.target.closest('[data-tags]');
  if (tags) {
    const row = document.querySelector(`[data-tagrow="${tags.dataset.tags}"]`);
    row.hidden = !row.hidden;
    if (!row.hidden) await renderTags(tags.dataset.tags, row.firstElementChild);
    return;
  }

  const delTag = event.target.closest('[data-deltag]');
  if (delTag) {
    await api(`/tags/${delTag.dataset.deltag}`, { method: 'DELETE' });
    toast('Llavero eliminado.');
    await renderTags(delTag.dataset.worker, delTag.closest('td'));
    return;
  }

  const addTag = event.target.closest('[data-addtag]');
  if (addTag) {
    const cell = addTag.closest('td');
    const uid = cell.querySelector('input').value.trim();
    if (!uid) return toast('Ingresá el UID.', true);
    try {
      const result = await api(`/workers/${addTag.dataset.addtag}/tags`, { method: 'POST', body: { uid } });
      toast(result.result === 'enrolled' ? 'Llavero asignado.' : `Resultado: ${result.result}`, result.result !== 'enrolled');
      await renderTags(addTag.dataset.addtag, cell);
      loadWorkers();
    } catch (error) {
      toast(error.message, true);
    }
  }
});

async function renderTags(workerId, cell) {
  const list = await api(`/workers/${workerId}/tags`);
  cell.innerHTML = `
    <div style="padding:6px 0">
      ${
        list.length
          ? list
              .map(
                (t) =>
                  `<div class="row" style="gap:8px;align-items:center;margin-bottom:6px">
                     <code>${esc(t.uid)}</code>
                     <span class="muted" style="font-size:12px">${esc(t.label || '')}</span>
                     <button class="btn--danger btn--sm" data-deltag="${t.id}" data-worker="${workerId}">Quitar</button>
                   </div>`
              )
              .join('')
          : '<div class="muted" style="font-size:13px;margin-bottom:8px">Sin llaveros asignados.</div>'
      }
      <div class="row" style="gap:8px">
        <input placeholder="UID del llavero" style="max-width:240px" />
        <button class="btn--ghost btn--sm" data-addtag="${workerId}">Agregar UID</button>
      </div>
    </div>`;
}

/* -------------------------------------------------------------- timesheet */

function currentRange() {
  return { from: $('f-from').value, to: $('f-to').value, workerId: $('f-worker').value };
}

function rangeQuery() {
  const { from, to, workerId } = currentRange();
  const query = new URLSearchParams({ from, to });
  if (workerId) query.set('workerId', workerId);
  return query.toString();
}

async function loadTimesheet() {
  if (!$('f-from').value) {
    $('f-to').value = todayIso();
    $('f-from').value = addDays(todayIso(), -13);
  }
  const data = await api(`/timesheet?${rangeQuery()}`);
  timezone = timezone || 'UTC';

  $('summary-body').innerHTML = data.summary.length
    ? data.summary
        .map(
          (s) => `<tr>
            <td><strong>${esc(s.fullName)}</strong><div class="muted" style="font-size:12px">${esc(s.workerCode)}</div></td>
            <td class="num">${s.days}</td>
            <td class="num">${s.shifts}</td>
            <td class="num"><strong>${s.hours.toFixed(2)}</strong></td>
            <td class="num">${money(s.amount)}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="empty">Sin turnos en el período.</td></tr>';

  $('shifts-body').innerHTML = data.shifts.length
    ? data.shifts
        .map(
          (s) => `<tr>
            <td>${esc(s.businessDay)}</td>
            <td>${esc(s.fullName)}</td>
            <td>${esc(s.startLocal)}</td>
            <td>${s.endLocal ? esc(s.endLocal) : '<span class="muted">en curso</span>'}</td>
            <td class="num">${s.status === 'open' ? `<span class="muted">${hm(s.minutes)}</span>` : s.hours.toFixed(2)}</td>
            <td><span class="badge badge--${s.status === 'auto_closed' ? 'auto' : s.status}">${STATUS_LABEL[s.status]}</span></td>
            <td>${s.duxStatus ? `<span class="badge badge--${s.duxStatus}" title="${esc(s.duxError || '')}">${DUX_LABEL[s.duxStatus]}</span>` : '—'}</td>
            <td class="num">${s.status !== 'open' ? `<button class="btn--ghost btn--sm" data-push="${s.id}">Enviar a Dux</button>` : ''}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="8" class="empty">Sin turnos en el período.</td></tr>';
}

$('f-apply').addEventListener('click', loadTimesheet);

document.addEventListener('click', async (event) => {
  const push = event.target.closest('[data-push]');
  if (!push) return;
  try {
    const result = await api(`/dux/push/${push.dataset.push}`, { method: 'POST' });
    toast(result.ok ? 'Enviado a Dux.' : result.reason === 'dux_not_configured' ? 'Dux no configurado: queda en cola.' : `Error: ${result.error}`, !result.ok);
    loadTimesheet();
  } catch (error) {
    toast(error.message, true);
  }
});

// CSV downloads need the token, so fetch as a blob rather than using a link.
async function download(path, filename) {
  const response = await api(path, { raw: true });
  if (!response.ok) return toast('No se pudo generar el CSV.', true);
  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

$('dl-summary').addEventListener('click', () => {
  const { from, to } = currentRange();
  download(`/export/summary.csv?${rangeQuery()}`, `horas_${from}_${to}.csv`);
});
$('dl-shifts').addEventListener('click', () => {
  const { from, to } = currentRange();
  download(`/export/shifts.csv?${rangeQuery()}`, `asistencias_${from}_${to}.csv`);
});

/* -------------------------------------------------------------------- dux */

async function loadDux() {
  const status = await api('/dux/status');
  renderSchedule(status.schedule);
  $('dux-status').innerHTML = `
    <div class="grid">
      <div><label>Estado</label>${
        status.configured
          ? '<span class="badge badge--sent">Configurado</span>'
          : '<span class="badge badge--pending">Sin configurar</span>'
      }</div>
      <div><label>Endpoint</label><code style="font-size:12px">${esc(status.endpoint || 'DUX_BASE_URL vacío')}</code></div>
      <div><label>Sincronización</label>${status.syncEnabled ? 'automática' : 'manual'}</div>
      <div><label>Enviados</label><strong>${status.counts.sent}</strong></div>
      <div><label>Pendientes</label><strong>${status.counts.pending}</strong></div>
      <div><label>Fallidos</label><strong>${status.counts.failed}</strong></div>
    </div>
    ${
      status.lastError
        ? `<p class="muted" style="font-size:13px;margin-bottom:0">Último error (turno #${status.lastError.shift_id}, intento ${status.lastError.attempts}): ${esc(status.lastError.last_error)}</p>`
        : ''
    }
    ${
      status.configured
        ? ''
        : '<p class="muted" style="font-size:13px;margin-bottom:0">Los fichajes se guardan igual y quedan en cola. Cargá DUX_BASE_URL y DUX_API_KEY en el archivo .env y reiniciá el servicio para empezar a enviarlos.</p>'
    }`;
}

function renderSchedule(schedule) {
  if (!schedule) return;
  const daily = schedule.mode === 'daily';
  const last = schedule.lastRun;

  $('dux-schedule').innerHTML = `
    <div class="grid">
      <div><label>Modo</label>${
        daily
          ? `<strong>Una vez por día a las ${esc(schedule.dailyTime)}</strong>`
          : `<strong>Continua (cada ${schedule.intervalSeconds}s)</strong>`
      }</div>
      <div><label>Zona horaria</label>${esc(schedule.timezone)}</div>
      <div><label>Próxima subida</label><strong>${daily ? relativeRun(schedule.nextRunAt) : 'continua'}</strong></div>
      <div><label>Última subida</label>${
        last ? `${dateTime(last.started_at)} · ${last.sent} enviados` : '<span class="muted">todavía ninguna</span>'
      }</div>
      ${schedule.exportDir ? `<div><label>Copia CSV</label><code style="font-size:12px">${esc(schedule.exportDir)}</code></div>` : ''}
    </div>
    ${
      daily
        ? '<p class="muted" style="font-size:13px;margin-bottom:0">Los turnos que sigan abiertos a esa hora viajan en la subida del día siguiente, una vez que la persona marque la salida.</p>'
        : ''
    }`;

  $('runs-body').innerHTML = (schedule.history || []).length
    ? schedule.history
        .map(
          (run) => `<tr>
            <td>${dateTime(run.started_at)}</td>
            <td><span class="badge">${RUN_LABEL[run.kind] || esc(run.kind)}</span></td>
            <td class="num">${run.sent}</td>
            <td class="num">${run.failed}</td>
            <td class="num">${run.remaining}</td>
            <td>${
              run.error
                ? `<span class="badge badge--failed" title="${esc(run.error)}">${
                    run.error === 'dux_not_configured' ? 'Dux sin configurar' : 'Error'
                  }</span>`
                : '<span class="badge badge--sent">OK</span>'
            }</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="empty">Sin subidas registradas todavía.</td></tr>';
}

$('dux-run').addEventListener('click', async () => {
  $('dux-run').disabled = true;
  try {
    const result = await api('/sync/run', { method: 'POST' });
    if (result.skipped) toast('Ya hay una subida en curso.', true);
    else if (result.error === 'dux_not_configured') toast('Dux no está configurado: los turnos siguen en cola.', true);
    else toast(`Subida lista: ${result.sent} enviados, ${result.remaining} en cola.`);
    loadDux();
  } catch (error) {
    toast(error.message, true);
  } finally {
    $('dux-run').disabled = false;
  }
});

$('dux-sync').addEventListener('click', async () => {
  const result = await api('/dux/sync', { method: 'POST' });
  toast(result.skipped ? 'Dux no está configurado.' : `Enviados ${result.sent}, con error ${result.failed}.`, Boolean(result.skipped));
  loadDux();
});

$('dux-retry').addEventListener('click', async () => {
  const result = await api('/dux/retry', { method: 'POST' });
  toast(`${result.requeued} turno(s) vuelven a la cola.`);
  loadDux();
});

$('m-save').addEventListener('click', async () => {
  const at = $('m-at').value;
  try {
    await api('/punch', {
      method: 'POST',
      body: {
        workerId: Number($('m-worker').value),
        direction: $('m-dir').value,
        at: at ? new Date(at).toISOString() : undefined,
        note: 'Carga manual',
      },
    });
    toast('Fichaje registrado.');
    loadBoard();
  } catch (error) {
    const messages = { already_checked_in: 'Ya tiene una entrada abierta.', not_checked_in: 'No tiene una entrada abierta.' };
    toast(messages[error.message] || error.message, true);
  }
});

/* -------------------------------------------------------------- bootstrap */

async function boot() {
  try {
    const health = await (await fetch('/health')).json();
    timezone = health.timezone || timezone;
  } catch {
    /* keep the default timezone */
  }
  $('f-to').value = todayIso();
  $('f-from').value = addDays(todayIso(), -13);
  await loadWorkers();
  await loadBoard();
  setInterval(() => {
    if (!document.querySelector('[data-panel="board"]').hidden) loadBoard();
  }, 20000);
}

if (token) {
  login(token).catch(() => logout());
} else {
  logout();
}
