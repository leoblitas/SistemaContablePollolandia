/**
 * Rutas de la Fase 4: cierre de ciclo / faenado, ventas y cobranza, y KPIs.
 * Se registra desde server.js con:  require('./routes/operationalRoutes')({ ruta, db, all, get, run, tx, exigir, HttpError, leerJson });
 * Todas las rutas usan el rol activo (cabecera X-Rol); no hay autenticación.
 */
'use strict';

module.exports = function registrarRutasOperativas(h) {
  const op = require('../controllers/operationalController')(h);
  const kp = require('../controllers/kpiController')(h);
  const { ruta } = h;

  // --- 1) Cierre de ciclo / faenado -----------------------------------------------------------
  ruta('GET',  '/api/operaciones/lotes-cierre',                  op.lotesParaCierre);
  ruta('GET',  '/api/operaciones/lotes/(\\d+)/cierre',           op.vistaCierre);
  ruta('POST', '/api/operaciones/lotes/(\\d+)/faenado',          op.registrarFaenado);
  ruta('POST', '/api/operaciones/lotes/(\\d+)/faenado/descartar', op.descartarFaenado);
  ruta('POST', '/api/operaciones/lotes/(\\d+)/aprobar-cierre',   op.aprobarCierre);

  // --- 2) Ventas HORECA y al contado ---------------------------------------------------------
  ruta('GET',  '/api/operaciones/clientes',                      op.listarClientes);
  ruta('POST', '/api/operaciones/clientes',                      op.crearCliente);
  ruta('GET',  '/api/operaciones/stock',                         op.stock);
  ruta('GET',  '/api/operaciones/ventas',                        op.listarVentas);
  ruta('POST', '/api/operaciones/ventas',                        op.registrarVenta);
  ruta('POST', '/api/operaciones/ventas/(\\d+)/cobrar',          op.cobrarVenta);

  // --- 3) KPIs técnicos de costo --------------------------------------------------------------
  ruta('GET',  '/api/kpis',                                      kp.kpis);

  return { sembrarDemo: op.sembrarDemo };
};
