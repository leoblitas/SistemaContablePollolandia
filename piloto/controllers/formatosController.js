/**
 * Datos para imprimir los formatos del sistema contable (MAN-06 §22):
 *   CI-01 Comprobante de Ingreso · CE-02 Comprobante de Egreso · CT-03 Comprobante de Traspaso · EC-07 Estado de Cuenta.
 * (MA-04, BS-05 y KV-08 se imprimen desde los reportes y el kardex, que ya devuelven su estructura.)
 * Solo lectura. El rol activo ya fue resuelto por server.js.
 */
'use strict';

module.exports = function crearControlador(h) {
  const { all, get, exigir, HttpError } = h;
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const FORMA = { EFECTIVO: 'EFECTIVO', TRANSFERENCIA: 'TRANSFERENCIA', DEPOSITO: 'DEPOSITO', CHEQUE: 'CHEQUE', CHEQUE_NOMINATIVO: 'CHEQUE', QR_ACH: 'TRANSFERENCIA', DEBITO: 'DEBITO' };

  /** Comprobante de un asiento: sugiere CI-01 / CE-02 / CT-03 según el movimiento de Caja y Bancos (1.1.01). */
  function comprobanteDeAsiento(ctx, req, url, [id]) {
    exigir(ctx, 'asientos.ver');
    const a = get(
      `SELECT a.id, a.numero, a.fecha, a.tipo, a.glosa, a.documento_respaldo, a.estado, a.asiento_origen_id,
              uc.nombre_completo AS creado_por, ua.nombre_completo AS autorizado_por, e.codigo AS ejercicio
         FROM asientos a JOIN usuarios uc ON uc.id = a.creado_por LEFT JOIN usuarios ua ON ua.id = a.autorizado_por
         JOIN ejercicios_fiscales e ON e.id = a.ejercicio_id WHERE a.id = ?`, Number(id));
    if (!a) throw new HttpError(404, 'Asiento no encontrado');
    const lineas = all(
      `SELECT d.linea, c.codigo AS cuenta, c.nombre AS cuenta_nombre, d.debe, d.haber, cc.codigo AS centro, s.codigo AS sufijo, l.codigo AS lote
         FROM asiento_detalle d JOIN cuentas c ON c.id = d.cuenta_id LEFT JOIN centros_costo cc ON cc.id = d.centro_costo_id
         LEFT JOIN sufijos_costo s ON s.id = d.sufijo_id LEFT JOIN lotes l ON l.id = d.lote_id WHERE d.asiento_id = ? ORDER BY d.linea`, a.id);
    const movCaja = (dir) => lineas.some((l) => l.cuenta.startsWith('1.1.01.') && l[dir] > 0);
    const sugerido = movCaja('debe') && !movCaja('haber') ? 'CI-01' : movCaja('haber') && !movCaja('debe') ? 'CE-02' : 'CT-03';

    // Tercero (recibí de / pagado a), forma de pago y respaldo, según el documento que originó el asiento
    let tercero = null, forma = null, respaldo = null;
    const venta = get(`SELECT v.*, c.nombre, c.documento FROM ventas v JOIN clientes c ON c.id = v.cliente_id WHERE v.asiento_id = ? OR v.asiento_cobro_id = ?`, a.id, a.id);
    const compra = get(`SELECT c.*, p.nombre, p.documento_identidad FROM compras c JOIN proveedores p ON p.id = c.proveedor_id WHERE c.asiento_id = ? OR c.asiento_pago_id = ?`, a.id, a.id);
    if (venta) {
      tercero = { nombre: venta.nombre, documento: venta.documento || '' };
      forma = venta.asiento_cobro_id === a.id ? venta.medio_cobro : venta.medio_pago;
      respaldo = { tipo: 'OTRO', numero: venta.comprobante, texto: `Nota de entrega / comprobante ${venta.comprobante}` };
    } else if (compra) {
      tercero = { nombre: compra.nombre, documento: compra.documento_identidad };
      forma = compra.asiento_pago_id === a.id ? compra.medio_pago_final : compra.medio_pago;
      respaldo = { tipo: compra.documento_tipo, numero: compra.documento_numero, orden_compra: compra.orden_compra };
    }
    const banco = forma && forma !== 'EFECTIVO' ? get(`SELECT codigo, nombre FROM cuentas WHERE codigo = '1.1.01.03'`) : null;
    const total = r2(lineas.reduce((s, l) => s + l.debe, 0));
    return {
      sugerido, asiento: a, lineas, total, tercero, forma_pago: forma ? (FORMA[forma] || forma) : null,
      banco: banco ? `${banco.codigo} ${banco.nombre}` : null, respaldo,
      tipo_traspaso: ({ APERTURA: 'APERTURA', AJUSTE: 'AJUSTE', CIERRE_CICLO: 'CIERRE', CIERRE_EJERCICIO: 'CIERRE' })[a.tipo] || 'OTRO',
    };
  }

  /** EC-07: movimientos y saldo con un cliente (cuentas por cobrar) o un proveedor (cuentas por pagar). */
  function estadoCuenta(ctx, req, url) {
    const tipo = url.searchParams.get('tipo'), id = Number(url.searchParams.get('id'));
    const desde = url.searchParams.get('desde') || '0000-00-00', hasta = url.searchParams.get('hasta') || '9999-12-31';
    let titular, filas = [];
    if (tipo === 'cliente') {
      exigir(ctx, 'ventas.ver');
      titular = get('SELECT id, nombre, tipo AS sector, documento FROM clientes WHERE id = ?', id);
      if (!titular) throw new HttpError(404, 'Cliente no encontrado');
      for (const v of all(`SELECT * FROM ventas WHERE cliente_id = ? AND condicion = 'CREDITO'`, id)) {
        filas.push({ fecha: v.fecha, tipo_doc: 'NE', n_doc: v.comprobante, detalle: `Venta a crédito (${v.producto.toLowerCase()}, ${v.cantidad} ${v.unidad})`, cargo: v.total, abono: 0 });
        if (v.estado === 'COBRADA') filas.push({ fecha: v.fecha_cobro, tipo_doc: 'CI-01', n_doc: v.comprobante, detalle: `Cobro (${(v.medio_cobro || '').replace('_', ' ')})`, cargo: 0, abono: v.total });
      }
      titular.cuenta = '1.1.02.01 Cuentas por Cobrar';
    } else if (tipo === 'proveedor') {
      exigir(ctx, 'inventario.ver');
      titular = get('SELECT id, nombre, documento_identidad AS documento FROM proveedores WHERE id = ?', id);
      if (!titular) throw new HttpError(404, 'Proveedor no encontrado');
      for (const c of all(`SELECT * FROM compras WHERE proveedor_id = ? AND condicion = 'CREDITO'`, id)) {
        filas.push({ fecha: c.fecha, tipo_doc: c.documento_tipo === 'FACTURA' ? 'FAC' : 'REC', n_doc: c.documento_numero, detalle: 'Compra de insumos a crédito', cargo: 0, abono: c.total });
        if (c.estado === 'PAGADA') filas.push({ fecha: c.fecha_pago, tipo_doc: 'CE-02', n_doc: c.documento_numero, detalle: `Pago (${(c.medio_pago_final || '').toLowerCase()})`, cargo: c.total, abono: 0 });
      }
      titular.cuenta = '2.1.01 Cuentas por Pagar Comerciales';
    } else {
      throw new HttpError(400, 'Indique tipo=cliente o tipo=proveedor');
    }
    filas.sort((x, y) => (x.fecha + x.tipo_doc).localeCompare(y.fecha + y.tipo_doc));
    // Cliente: saldo = cargos − abonos (deudor). Proveedor: saldo = abonos − cargos (acreedor).
    const signo = tipo === 'cliente' ? 1 : -1;
    let saldo = 0;
    for (const f of filas) if (f.fecha < desde) saldo = r2(saldo + signo * (f.cargo - f.abono));
    const saldoAnterior = saldo;
    const movs = filas.filter((f) => f.fecha >= desde && f.fecha <= hasta).map((f) => {
      saldo = r2(saldo + signo * (f.cargo - f.abono));
      return { ...f, saldo };
    });
    return {
      formato: 'EC-07 — Estado de Cuenta', tipo_cuenta: tipo === 'cliente' ? 'Cuentas por cobrar (clientes)' : 'Cuentas por pagar (proveedores)',
      titular, desde: desde === '0000-00-00' ? null : desde, hasta: hasta === '9999-12-31' ? null : hasta, emision: new Date().toISOString().slice(0, 10),
      saldo_anterior: saldoAnterior, movimientos: movs,
      sumas: { cargos: r2(movs.reduce((s, m) => s + m.cargo, 0)), abonos: r2(movs.reduce((s, m) => s + m.abono, 0)) }, saldo_actual: saldo,
    };
  }

  return { comprobanteDeAsiento, estadoCuenta };
};
