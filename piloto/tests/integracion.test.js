'use strict';
// Prueba de integración: arranca el servidor real (BD temporal) y recorre las rutas de las Fases 2-5.
// Ejecutar: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pollolandia-')), 'test.db');
let srv;

const call = async (rol, metodo, ruta, cuerpo) => {
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: { 'X-Rol': rol, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

before(async () => {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')],
    { env: { ...process.env, PORT, DB_PATH: DB }, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  srv.stdout.on('data', (d) => (salida += d)); srv.stderr.on('data', (d) => (salida += d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/api/roles')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('El servidor no arrancó:\n' + salida);
});
after(() => srv && srv.kill());

test('páginas estáticas del frontend se sirven', async () => {
  for (const p of ['/', '/operaciones.html', '/kpis.html', '/app-common.js', '/reports.html', '/accounting/asignar-costos.html']) {
    const r = await fetch(BASE + p);
    assert.strictEqual(r.status, 200, p);
  }
});

test('rol inválido o ausente se rechaza; los permisos del MOF se aplican', async () => {
  assert.strictEqual((await call('XX', 'GET', '/api/yo')).status, 400);
  assert.strictEqual((await call('UT', 'GET', '/api/reportes/balance-comprobacion')).status, 403);
  assert.strictEqual((await call('GG', 'POST', '/api/contabilidad/asientos', {})).status, 403);
});

test('Fase 1/3: dashboard, cuentas, lotes, balance', async () => {
  for (const u of ['/api/dashboard', '/api/cuentas', '/api/lotes', '/api/balance', '/api/catalogos', '/api/asientos'])
    assert.strictEqual((await call('JF', 'GET', u)).status, 200, u);
});

test('Fase 2: asientos, lote de 73 días y asignación de costos por sufijo', async () => {
  let r = await call('JF', 'POST', '/api/contabilidad/asientos', { fecha: '2026-10-15', glosa: 'x', lineas: [{ cuenta: '1.1.03.01', debe: 100 }, { cuenta: '2.1.01.01', haber: 99 }] });
  assert.strictEqual(r.status, 422);
  r = await call('JF', 'POST', '/api/contabilidad/lotes', { centro_costo: 'CC-01', fecha_inicio: '2026-10-12', aves_iniciales: 2000 });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.lote.duracion_dias, 73);
  const cod = r.json.lote.codigo;
  r = await call('JF', 'POST', `/api/contabilidad/lotes/${cod}/costos`, { fecha: '2026-10-15', items: [{ sufijo: '01', cantidad: 2000, costo_unitario: 9 }] });
  assert.strictEqual(r.status, 200);
  r = await call('JF', 'GET', `/api/contabilidad/lotes/${cod}/hoja-costos`);
  assert.strictEqual(r.json.hoja.sufijos[0].monto, 18000);
});

test('Fase 4: faenado, aprobación GG, venta HORECA y KPIs', async () => {
  let r = await call('JF', 'POST', '/api/operaciones/lotes/1/faenado', { fecha_faenado: '2026-12-02', aves_faenadas: 2944, peso_vivo_kg: 7500, peso_canal_kg: 6900 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call('JF', 'POST', '/api/operaciones/lotes/1/aprobar-cierre')).status, 403);
  assert.strictEqual((await call('GG', 'POST', '/api/operaciones/lotes/1/aprobar-cierre')).status, 200);
  const cli = (await call('JF', 'GET', '/api/operaciones/clientes')).json;
  const horeca = cli.find((c) => c.tipo === 'HORECA'), frial = cli.find((c) => c.tipo === 'FRIAL');
  const base = { fecha: '2026-12-03', producto: 'CARNE', lote_id: 1, cantidad: 10, precio_unitario: 25, comprobante: 'NE-T1' };
  assert.strictEqual((await call('JF', 'POST', '/api/operaciones/ventas', { ...base, cliente_id: frial.id, condicion: 'CREDITO', compromiso_pago_firmado: true })).status, 400);
  assert.strictEqual((await call('JF', 'POST', '/api/operaciones/ventas', { ...base, cliente_id: horeca.id, condicion: 'CREDITO', compromiso_pago_firmado: true })).status, 200);
  r = await call('GG', 'GET', '/api/kpis');
  assert.strictEqual(r.status, 200); assert.ok(r.json.consolidado.icl && r.json.consolidado.rinc);
});

test('Fase 5: reportes y auditoría RAU', async () => {
  for (const u of ['/api/reportes/catalogos', '/api/reportes/libro-mayor?cuenta=1.1.03', '/api/reportes/balance-comprobacion?nivel=4',
    '/api/reportes/estado-resultados', '/api/reportes/auditoria-rau']) {
    const r = await call('GG', 'GET', u);
    assert.strictEqual(r.status, 200, u); assert.strictEqual(r.json.ok, true, u);
  }
});
