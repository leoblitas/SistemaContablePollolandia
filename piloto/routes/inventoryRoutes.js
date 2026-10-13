/**
 * Rutas de la Fase 6: compras, kardex valorado KV-08 (CPP), proveedores RAU, consumo en bitácora y semáforo CI-FIN-16,
 * más los datos de los formatos imprimibles (CI-01, CE-02, CT-03, EC-07).
 * Se registra desde server.js con:  require('./routes/inventoryRoutes')({ ruta, db, all, get, run, tx, exigir, HttpError, leerJson });
 * Todas las rutas usan el rol activo (cabecera X-Rol); no hay autenticación.
 */
'use strict';

module.exports = function registrarRutasInventario(h) {
  const inv = require('../controllers/inventoryController')(h);
  const fmt = require('../controllers/formatosController')(h);
  const { ruta } = h;

  // --- Insumos, semáforo CI-FIN-16 y parámetros -------------------------------------------------
  ruta('GET',  '/api/inventario/insumos',                       inv.listarInsumos);
  ruta('POST', '/api/inventario/insumos',                       inv.crearInsumo);
  ruta('POST', '/api/inventario/insumos/(\\d+)/parametros',     inv.fijarParametros);
  ruta('GET',  '/api/inventario/resumen',                       inv.resumen);
  ruta('GET',  '/api/inventario/catalogos',                     inv.catalogos);

  // --- Kardex valorado KV-08 --------------------------------------------------------------------
  ruta('GET',  '/api/inventario/kardex/(\\d+)',                 inv.kardex);

  // --- Expediente de proveedores RAU ------------------------------------------------------------
  ruta('GET',  '/api/inventario/proveedores',                   inv.listarProveedores);
  ruta('POST', '/api/inventario/proveedores',                   inv.crearProveedor);
  ruta('POST', '/api/inventario/proveedores/(\\d+)',            inv.actualizarProveedor);

  // --- Compras (entrada de insumos) y pago de cuentas por pagar --------------------------------
  ruta('GET',  '/api/inventario/compras',                       inv.listarCompras);
  ruta('POST', '/api/inventario/compras',                       inv.registrarCompra);
  ruta('POST', '/api/inventario/compras/(\\d+)/pagar',          inv.pagarCompra);

  // --- Bitácora del lote con consumo de insumos --------------------------------------------------
  ruta('POST', '/api/inventario/lotes/(\\d+)/bitacora',         inv.registrarBitacora);
  ruta('GET',  '/api/inventario/consumos',                      inv.listarConsumos);

  // --- Formatos imprimibles ---------------------------------------------------------------------
  ruta('GET',  '/api/formatos/asiento/(\\d+)',                  fmt.comprobanteDeAsiento);
  ruta('GET',  '/api/formatos/estado-cuenta',                   fmt.estadoCuenta);

  return { sembrarDemo: inv.sembrarDemo, inv };
};
