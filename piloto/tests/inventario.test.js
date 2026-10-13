'use strict';
// Fase 6: compras, kardex valorado (CPP), proveedores RAU, consumo desde bitácora y semáforo de reorden.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pollolandia6-')), 'test.db');
let srv;
const call = async (rol, metodo, ruta, cuerpo) => {
  const r = await fetch(BASE + ruta, { method: metodo, headers: { 'X-Rol': rol, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
before(async () => {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DB_PATH: DB }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/roles')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('El servidor no arrancó');
});
after(() => srv && srv.kill());

const insumo = async (codigo) => (await call('JF', 'GET', '/api/inventario/insumos')).json.find((i) => i.codigo === codigo);
const prov = { nombre: 'Prov Test', documento_identidad: '99887766 LP', tipo_certificado: 'RAU', numero_certificado: 'RAU-T-1' };
const compra = (extra) => ({ fecha: '2026-10-01', documento_tipo: 'RECIBO', documento_numero: 'T-1', condicion: 'CONTADO', medio_pago: 'EFECTIVO', proveedor: prov, ...extra });

test('páginas y rutas de la Fase 6 se sirven; permisos por rol', async () => {
  for (const p of ['/kardex.html', '/formatos.js']) assert.strictEqual((await fetch(BASE + p)).status, 200, p);
  assert.strictEqual((await call('GG', 'GET', '/api/inventario/insumos')).status, 200);
  assert.strictEqual((await call('UT', 'GET', '/api/inventario/insumos')).status, 200);
  assert.strictEqual((await call('UT', 'POST', '/api/inventario/compras', {})).status, 403);
  assert.strictEqual((await call('GG', 'POST', '/api/inventario/compras', {})).status, 403);
  assert.strictEqual((await call('UT', 'POST', '/api/inventario/insumos', {})).status, 403);
});

test('CPP: el kardex de la demo recalcula el costo promedio ponderado', async () => {
  const alb = await insumo('ALB-01');
  assert.strictEqual(alb.cantidad_actual, 6500);
  assert.strictEqual(alb.valor_actual, 28450);
  assert.strictEqual(alb.costo_promedio, 4.3769);   // (17.200 + 11.250) / 6.500
  const k = (await call('JF', 'GET', `/api/inventario/kardex/${alb.id}`)).json;
  assert.match(k.formato, /KV-08/);
  assert.strictEqual(k.movimientos.length, 2);
  assert.strictEqual(k.movimientos[1].saldo_cantidad, 6500);
});

test('PET-RAU-001: sin credenciales del vendedor no se procesa la compra', async () => {
  const alb = await insumo('ALB-01');
  const items = [{ insumo_id: alb.id, cantidad: 10, costo_unitario: 5 }];
  let r = await call('JF', 'POST', '/api/inventario/compras', compra({ items, proveedor: undefined }));
  assert.strictEqual(r.status, 400);
  for (const falta of ['nombre', 'documento_identidad', 'numero_certificado']) {
    r = await call('JF', 'POST', '/api/inventario/compras', compra({ items, proveedor: { ...prov, [falta]: '' } }));
    assert.strictEqual(r.status, 400, falta);
  }
  r = await call('JF', 'POST', '/api/inventario/compras', compra({ items, proveedor: { ...prov, tipo_certificado: 'OTRO' } }));
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await insumo('ALB-01')).cantidad_actual, 6500);   // nada se registró
});

test('PR-FIN-03: orden de compra > Bs 1.000 y 3 cotizaciones > Bs 5.000', async () => {
  const alb = await insumo('ALB-01');
  const items = [{ insumo_id: alb.id, cantidad: 300, costo_unitario: 5 }];   // 1.500
  let r = await call('JF', 'POST', '/api/inventario/compras', compra({ items }));
  assert.strictEqual(r.status, 400); assert.match(r.json.error, /orden de compra/i);
  const grande = [{ insumo_id: alb.id, cantidad: 1500, costo_unitario: 5 }];   // 7.500
  r = await call('JF', 'POST', '/api/inventario/compras', compra({ items: grande, orden_compra: 'OC-T1', cotizaciones: 2 }));
  assert.strictEqual(r.status, 400); assert.match(r.json.error, /cotizaci/i);
});

test('compra válida: nuevo stock y CPP, asiento balanceado, proveedor reutilizable', async () => {
  const alb = await insumo('ALB-01');
  const r = await call('JF', 'POST', '/api/inventario/compras', compra({ items: [{ insumo_id: alb.id, cantidad: 300, costo_unitario: 5 }], orden_compra: 'OC-T2', cotizaciones: 0 }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.total, 1500);
  assert.strictEqual(r.json.estado, 'PAGADA');
  const despues = await insumo('ALB-01');
  assert.strictEqual(despues.cantidad_actual, 6800);
  assert.strictEqual(despues.valor_actual, 29950);
  assert.strictEqual(despues.costo_promedio, Math.round((29950 / 6800) * 1e4) / 1e4);
  const fmt = (await call('JF', 'GET', `/api/formatos/asiento/${r.json.asiento_id}`)).json;
  assert.strictEqual(fmt.sugerido, 'CE-02');
  assert.strictEqual(fmt.total, 1500);
  const ps = (await call('JF', 'GET', '/api/inventario/proveedores')).json;
  assert.ok(ps.some((p) => p.documento_identidad === prov.documento_identidad));
  // el mismo C.I. no se puede duplicar
  const dup = await call('JF', 'POST', '/api/inventario/proveedores', prov);
  assert.strictEqual(dup.status, 409);
});

test('compra a crédito genera cuenta por pagar y se paga con comprobante de egreso', async () => {
  const med = await insumo('MED-01');
  const r = await call('JF', 'POST', '/api/inventario/compras', { fecha: '2026-10-02', documento_tipo: 'FACTURA', documento_numero: 'F-T9', condicion: 'CREDITO', fecha_vencimiento: '2026-10-30',
    proveedor: { ...prov, documento_identidad: '1112223 SC', nombre: 'Prov Crédito' }, items: [{ insumo_id: med.id, cantidad: 5, costo_unitario: 40 }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.estado, 'PENDIENTE');
  const pago = await call('JF', 'POST', `/api/inventario/compras/${r.json.id}/pagar`, { fecha: '2026-10-20', medio_pago: 'TRANSFERENCIA' });
  assert.strictEqual(pago.status, 200, JSON.stringify(pago.json));
  assert.strictEqual((await call('JF', 'POST', `/api/inventario/compras/${r.json.id}/pagar`, { fecha: '2026-10-21', medio_pago: 'EFECTIVO' })).status, 409);
});

test('CI-FIN-16: semáforo rojo/amarillo/verde según stock físico', async () => {
  const resumen = (await call('GG', 'GET', '/api/inventario/resumen')).json;
  const vac = resumen.alertas.find((a) => a.codigo === 'VAC-01');
  assert.strictEqual(vac.semaforo, 'ROJO');            // 2.800 < seguridad 3.000
  assert.strictEqual((await insumo('ALB-01')).semaforo, 'VERDE');
  const alb = await insumo('ALB-01');
  let r = await call('GG', 'POST', `/api/inventario/insumos/${alb.id}/parametros`, { stock_seguridad: 1 });
  assert.strictEqual(r.status, 403);                    // GG no configura; lo hace Finanzas
  r = await call('JF', 'POST', `/api/inventario/insumos/${alb.id}/parametros`, { stock_seguridad: 9000, punto_reorden: 8000 });
  assert.strictEqual(r.status, 400);                    // reorden < seguridad
  await call('JF', 'POST', `/api/inventario/insumos/${alb.id}/parametros`, { stock_seguridad: 5000, punto_reorden: 7000 });
  assert.strictEqual((await insumo('ALB-01')).semaforo, 'AMARILLO');
  await call('JF', 'POST', `/api/inventario/insumos/${alb.id}/parametros`, { stock_seguridad: 7000, punto_reorden: 9000 });
  assert.strictEqual((await insumo('ALB-01')).semaforo, 'ROJO');
  await call('JF', 'POST', `/api/inventario/insumos/${alb.id}/parametros`, { stock_seguridad: 1500, punto_reorden: 3000 });
});

test('línea de alimento propio (sufijos 03–07) bloqueada hasta 2027', async () => {
  const mai = await insumo('MAI-01');
  assert.strictEqual(mai.disponible, false);
  const r = await call('JF', 'POST', '/api/inventario/compras', compra({ items: [{ insumo_id: mai.id, cantidad: 100, costo_unitario: 3 }] }));
  assert.strictEqual(r.status, 409);
});

test('bitácora con consumo: sale del kardex al CPP, asiento Dr 6.1.01.0x / Cr 1.1.03.xx y va a la hoja de costos del lote', async () => {
  const lotes = (await call('UT', 'GET', '/api/lotes')).json.filter((l) => l.estado === 'ABIERTO');
  assert.ok(lotes.length);
  const lote = lotes[0];
  const alb = await insumo('ALB-01'), med = await insumo('MED-01');
  const antes = (await call('JF', 'GET', `/api/lotes/${lote.id}/costos`)).json.total;
  const fecha = new Date(Date.parse(lote.fecha_inicio) + 70 * 86400000).toISOString().slice(0, 10);   // día 71
  // el alimento declarado debe coincidir con el kardex
  let r = await call('UT', 'POST', `/api/inventario/lotes/${lote.id}/bitacora`, { fecha, alimento_kg: 999, consumos: [{ insumo_id: alb.id, cantidad: 400 }] });
  assert.strictEqual(r.status, 400);
  // más que el stock → rechazado
  r = await call('UT', 'POST', `/api/inventario/lotes/${lote.id}/bitacora`, { fecha, consumos: [{ insumo_id: alb.id, cantidad: 999999 }] });
  assert.ok([400, 409, 422].includes(r.status), String(r.status));
  r = await call('UT', 'POST', `/api/inventario/lotes/${lote.id}/bitacora`, { fecha, mortalidad: 2, consumos: [{ insumo_id: alb.id, cantidad: 400 }, { insumo_id: med.id, cantidad: 2 }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const cpp = alb.costo_promedio;
  const esperado = Math.round((400 * cpp + 2 * med.costo_promedio) * 100) / 100;
  assert.ok(Math.abs(r.json.costo_total_consumo - esperado) <= 0.02, `${r.json.costo_total_consumo} vs ${esperado}`);
  assert.strictEqual(r.json.alimento_kg, 400);
  const asiento = (await call('JF', 'GET', `/api/asientos/${r.json.asiento_id}`)).json;
  const sumaD = asiento.lineas.reduce((s, l) => s + l.debe, 0), sumaH = asiento.lineas.reduce((s, l) => s + l.haber, 0);
  assert.strictEqual(Math.round(sumaD * 100), Math.round(sumaH * 100));
  assert.ok(asiento.lineas.some((l) => l.debe > 0 && l.cuenta.startsWith('6.1.01.01') && l.sufijo === '02'));
  assert.ok(asiento.lineas.some((l) => l.haber > 0 && l.cuenta === '1.1.03.02'));
  const despues = (await call('JF', 'GET', `/api/lotes/${lote.id}/costos`)).json.total;
  assert.ok(Math.abs(despues - antes - r.json.costo_total_consumo) <= 0.01);
  assert.strictEqual((await insumo('ALB-01')).cantidad_actual, alb.cantidad_actual - 400);
  // una sola bitácora por día
  r = await call('UT', 'POST', `/api/inventario/lotes/${lote.id}/bitacora`, { fecha, consumos: [] });
  assert.strictEqual(r.status, 409);
  // el balance de comprobación sigue cuadrado
  const bal = (await call('JF', 'GET', '/api/reportes/balance-comprobacion')).json.reporte;
  assert.strictEqual(bal.verificacion.sumas_debe_igual_haber, true);
});

test('formatos: estado de cuenta EC-07 de proveedor y cliente', async () => {
  const ps = (await call('JF', 'GET', '/api/inventario/proveedores')).json;
  const e = (await call('JF', 'GET', `/api/formatos/estado-cuenta?tipo=proveedor&id=${ps[0].id}`)).json;
  assert.match(e.formato, /EC-07/);
  const cl = (await call('JF', 'GET', '/api/operaciones/clientes')).json;
  assert.strictEqual((await call('JF', 'GET', `/api/formatos/estado-cuenta?tipo=cliente&id=${cl[0].id}`)).status, 200);
  assert.strictEqual((await call('JF', 'GET', '/api/formatos/estado-cuenta?tipo=otro&id=1')).status, 400);
});

test('formatos.js: monto en letras', () => {
  const F = require('../public/formatos.js');
  assert.strictEqual(F.montoEnLetras(17200), 'Son: DIECISIETE MIL DOSCIENTOS 00/100 Bolivianos');
  assert.strictEqual(F.montoEnLetras(1051.5), 'Son: MIL CINCUENTA Y UN 50/100 Bolivianos');
  assert.strictEqual(F.montoEnLetras(2000000), 'Son: DOS MILLONES 00/100 Bolivianos');
});
