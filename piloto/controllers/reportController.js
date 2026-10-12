'use strict';
/**
 * controllers/reportController.js
 * -----------------------------------------------------------------------------
 * Controladores HTTP de la FASE 5 — Reportes y Auditoría Fiscal (Pollolandia Contable).
 * Acceso abierto: NO se verifica ningún token, login, contraseña ni sesión.
 * Solo lectura: ningún controlador escribe en la base de datos.
 *
 * Uso:  const ctrl = require('./controllers/reportController')(db);
 * `db` es una conexión better-sqlite3 abierta (la misma que usa el módulo contable).
 */
const svc = require('../services/reportService');

function manejarError(res, err) {
  if (err instanceof svc.ReportError) {
    return res.status(err.status).json({ ok: false, error: err.message });
  }
  console.error('[reportes]', err);
  return res.status(500).json({ ok: false, error: 'Error interno al generar el reporte' });
}

module.exports = function createReportController(db) {
  const wrap = (fn) => (req, res) => {
    try {
      return fn(req, res);
    } catch (err) {
      return manejarError(res, err);
    }
  };

  return {
    catalogos: wrap((req, res) => res.json({ ok: true, ...svc.catalogos(db) })),
    libroMayor: wrap((req, res) => res.json({ ok: true, reporte: svc.libroMayor(db, req.query) })),
    balanceComprobacion: wrap((req, res) => res.json({ ok: true, reporte: svc.balanceComprobacion(db, req.query) })),
    estadoResultados: wrap((req, res) => res.json({ ok: true, reporte: svc.estadoResultados(db, req.query) })),
    auditoriaRau: wrap((req, res) => res.json({ ok: true, reporte: svc.auditoriaRau(db, req.query) })),
  };
};
