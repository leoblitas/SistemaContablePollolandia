'use strict';
/**
 * routes/integracionRoutes.js — registra, en el router propio de server.js (sin Express), las rutas de:
 *   Fase 2  /api/contabilidad/*  (asientos, lotes de 73 días, asignación de costos por sufijo)
 *   Fase 5  /api/reportes/*      (libro mayor, balance de comprobación, estado de resultados, auditoría RAU)
 * Reutiliza tal cual los controladores de Express: se les entrega un `req`/`res` mínimos.
 * Acceso abierto: no hay login; el rol activo (X-Rol) solo decide qué permisos del MOF aplican.
 */
const { adaptar } = require('../lib/compat-db');

module.exports = function integracion({ ruta, db, exigir, HttpError, leerJson }) {
  adaptar(db);
  const contab = require('../controllers/accountingController')(db);
  const repor = require('../controllers/reportController')(db);

  /** Ejecuta un controlador estilo Express y traduce su res.status().json() a la respuesta de server.js */
  const invocar = (controlador, ctx, req, url, params, body) => {
    const query = Object.fromEntries(url.searchParams);
    const fakeReq = { body: body || {}, query, params, ip: req.socket?.remoteAddress, headers: req.headers };
    let status = 200, cuerpo;
    const res = {
      status(n) { status = n; return res; },
      json(o) { cuerpo = o; return res; },
    };
    controlador(fakeReq, res);
    if (status >= 400) throw new HttpError(status, (cuerpo && (cuerpo.error || cuerpo.mensaje)) || `Error ${status}`);
    return cuerpo;
  };

  const GET = (patron, permiso, ctrl) => ruta('GET', patron, (ctx, req, url, p) => {
    exigir(ctx, permiso);
    return invocar(ctrl, ctx, req, url, paramsDe(p), null);
  });
  const POST = (patron, permiso, ctrl) => ruta('POST', patron, async (ctx, req, url, p) => {
    exigir(ctx, permiso);
    const body = await leerJson(req);
    body.creado_por = ctx.usuarioId;            // quien registra es el rol activo (MOF: SoD)
    return invocar(ctrl, ctx, req, url, paramsDe(p), body);
  });
  const paramsDe = (p) => { const v = p[0] === undefined ? undefined : decodeURIComponent(p[0]); return { id: v, lote: v }; };

  // ---- Fase 2: contabilidad y costos por lote ----
  const C = '/api/contabilidad';
  POST(`${C}/asientos`, 'asientos.registrar', contab.registrarAsiento);
  GET(`${C}/asientos`, 'asientos.ver', contab.listarAsientos);
  GET(`${C}/asientos/([^/]+)`, 'asientos.ver', contab.obtenerAsiento);
  POST(`${C}/lotes`, 'lotes.abrir', contab.crearLote);
  GET(`${C}/lotes`, 'lotes.ver', contab.listarLotes);
  POST(`${C}/lotes/([^/]+)/costos`, 'asientos.registrar', contab.asignarCostos);
  GET(`${C}/lotes/([^/]+)/hoja-costos`, 'costos.ver', contab.hojaCostos);
  GET(`${C}/catalogos/sufijos`, 'lotes.ver', contab.catalogoSufijos);
  GET(`${C}/catalogos/cuentas`, 'cuentas.ver', contab.catalogoCuentas);

  // ---- Fase 5: reportes y auditoría fiscal (solo lectura) ----
  const R = '/api/reportes';
  GET(`${R}/catalogos`, 'reportes.ver', repor.catalogos);
  GET(`${R}/libro-mayor`, 'reportes.ver', repor.libroMayor);
  GET(`${R}/balance-comprobacion`, 'reportes.ver', repor.balanceComprobacion);
  GET(`${R}/estado-resultados`, 'reportes.ver', repor.estadoResultados);
  GET(`${R}/auditoria-rau`, 'reportes.ver', repor.auditoriaRau);
};
