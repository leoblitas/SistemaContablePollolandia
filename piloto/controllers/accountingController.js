'use strict';
/**
 * controllers/accountingController.js
 * -----------------------------------------------------------------------------
 * Controladores HTTP del módulo contable demostrativo (Pollolandia Contable).
 * SIN autenticación: no se verifica ningún token, contraseña ni sesión.
 *
 * Uso:  const ctrl = require('./controllers/accountingController')(db);
 * `db` es una conexión better-sqlite3 ya abierta con PRAGMA foreign_keys = ON.
 */
const svc = require('../services/accountingService');

function manejarError(res, err) {
  if (err instanceof svc.AccountingError) {
    return res.status(err.status).json({ ok: false, error: err.message, ...(err.extra ? { detalle: err.extra } : {}) });
  }
  // Errores de CHECK / UNIQUE / FK / triggers del schema.sql (RAISE(ABORT, '...'))
  if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    const status = err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ? 409 : 422;
    return res.status(status).json({ ok: false, error: err.message, origen: 'regla de base de datos' });
  }
  console.error('[accounting]', err);
  return res.status(500).json({ ok: false, error: 'Error interno del módulo contable' });
}

module.exports = function createAccountingController(db) {
  const ctx = (req) => ({ ip: req.ip });
  const wrap = (fn) => (req, res) => {
    try {
      return fn(req, res);
    } catch (err) {
      return manejarError(res, err);
    }
  };

  return {
    // POST /asientos
    registrarAsiento: wrap((req, res) => {
      const asiento = svc.registrarAsiento(db, req.body, ctx(req));
      res.status(201).json({ ok: true, asiento });
    }),
    // GET /asientos
    listarAsientos: wrap((req, res) => res.json({ ok: true, asientos: svc.listarAsientos(db, req.query) })),
    // GET /asientos/:id
    obtenerAsiento: wrap((req, res) => res.json({ ok: true, asiento: svc.obtenerAsiento(db, req.params.id) })),

    // POST /lotes
    crearLote: wrap((req, res) => {
      const r = svc.crearLote(db, req.body, ctx(req));
      res.status(201).json({ ok: true, ...r });
    }),
    // GET /lotes
    listarLotes: wrap((req, res) => res.json({ ok: true, lotes: svc.listarLotes(db, req.query) })),
    // POST /lotes/:lote/costos   (:lote = id numérico o código del lote)
    asignarCostos: wrap((req, res) => {
      const r = svc.asignarCostosALote(db, req.params.lote, req.body, ctx(req));
      res.status(201).json({ ok: true, ...r });
    }),
    // GET /lotes/:lote/hoja-costos
    hojaCostos: wrap((req, res) => res.json({ ok: true, hoja: svc.hojaCostosLote(db, req.params.lote) })),

    // GET /catalogos/sufijos?centro=CC-01
    catalogoSufijos: wrap((req, res) => res.json({ ok: true, sufijos: svc.listarSufijos(db, req.query.centro) })),
    // GET /catalogos/cuentas?q=&grupo=&imputables=1
    catalogoCuentas: wrap((req, res) =>
      res.json({
        ok: true,
        cuentas: svc.listarCuentas(db, {
          q: req.query.q,
          grupo: req.query.grupo,
          imputables: req.query.imputables !== '0',
        }),
      })
    ),
  };
};
