'use strict';

// The real Dux base, as published at developers.duxsoftware.com.ar.
process.env.DUX_BASE_URL = 'https://erp.duxsoftware.com.ar/WSERP/rest/services/v2';
process.env.DUX_API_KEY = 'test-token';
process.env.DUX_EMPRESA_ID = '42';

const test = require('node:test');
const assert = require('node:assert/strict');
const dux = require('../src/dux');

test('Dux URLs carry id_empresa, which every company-scoped call needs', () => {
  assert.equal(
    dux.duxUrl('/gastos'),
    'https://erp.duxsoftware.com.ar/WSERP/rest/services/v2/gastos?id_empresa=42'
  );
  assert.equal(
    dux.duxUrl('personal'),
    'https://erp.duxsoftware.com.ar/WSERP/rest/services/v2/personal?id_empresa=42'
  );
  // /empresas is the one call that takes no company.
  assert.equal(
    dux.duxUrl('/empresas', { withEmpresa: false }),
    'https://erp.duxsoftware.com.ar/WSERP/rest/services/v2/empresas'
  );
});

test('a working token reports the companies it can see', async () => {
  let seen;
  const result = await dux.testConnection({
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ datos: [{ id_empresa: 42, razon_social: 'Vernocta SRL', cuit: '30-1234' }] }),
      };
    },
  });

  assert.equal(seen.url, 'https://erp.duxsoftware.com.ar/WSERP/rest/services/v2/empresas');
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.headers.Authorization, 'Bearer test-token');
  assert.equal(result.ok, true);
  assert.deepEqual(result.empresas, [{ id_empresa: 42, razon_social: 'Vernocta SRL', cuit: '30-1234' }]);
});

test('a rejected token says so in words the operator can act on', async () => {
  for (const status of [401, 403]) {
    const result = await dux.testConnection({
      fetchImpl: async () => ({ ok: false, status, text: async () => 'Unauthorized' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /rejected the token/);
  }
});

test('other failures are reported rather than thrown', async () => {
  const http500 = await dux.testConnection({
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  });
  assert.equal(http500.ok, false);
  assert.match(http500.error, /HTTP 500/);

  const offline = await dux.testConnection({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.error, 'ECONNREFUSED');
});

test('a token that sees no company is not reported as a failure', async () => {
  const result = await dux.testConnection({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ datos: [] }) }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.empresas, []);
});
