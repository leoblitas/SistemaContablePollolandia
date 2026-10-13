/**
 * Controlador de inventarios — Fase 6.
 *   1) Kardex valorado KV-08 con Costo Promedio Ponderado (PC-07) y catálogo de insumos críticos
 *   2) Compras de insumos (PR-FIN-03) con expediente de proveedores RAU (PET-RAU-001, DS 24463)
 *   3) Consumo de insumos desde la bitácora del lote (día 1 a 73): salida al CPP vigente y asiento
 *      Dr 6.1.01.0x (sufijo + lote) / Cr 1.1.03.xx (MAN-01 §8.1)
 *   4) Semáforo de stock de seguridad y punto de reorden (CI-FIN-16)
 *
 * Sin autenticación: el rol activo ya fue resuelto por server.js (ctx). Los permisos siguen el MOF.
 * Las reglas contables están además respaldadas por CHECK/triggers de database/schema.sql y fase6.sql.
 */
'use strict';

const CAJA = '1.1.01.01';       // Caja – Efectivo en Moneda Nacional
const BANCO = '1.1.01.03';      // Banco – Cuenta Corriente Moneda Nacional
const MEDIOS_EGRESO = ['EFECTIVO', 'CHEQUE', 'TRANSFERENCIA', 'DEBITO'];   // formato CE-02: forma de pago
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
// PR-FIN-03 §4: toda solicitud que supere Bs 1.000 requiere aprobación firmada de la GG (orden de compra FIN-EGR-03);
// las compras mayores a Bs 5.000 requieren cotización de un mínimo de tres proveedores aprobados.
const LIMITE_APROBACION_GG = 1000;
const LIMITE_COTIZACIONES = 5000;
const MIN_COTIZACIONES = 3;
// Cuenta de inventario y de proveedor propuestas para cada sufijo MPD (Plan de Cuentas, grupos 1.1.03 y 2.1.01).
const CUENTAS_POR_SUFIJO = {
  '02': ['1.1.03.02', '2.1.01.02'], '03': ['1.1.03.03', '2.1.01.03'], '04': ['1.1.03.04', '2.1.01.03'],
  '05': ['1.1.03.05', '2.1.01.03'], '06': ['1.1.03.06', '2.1.01.03'], '07': ['1.1.03.07', '2.1.01.03'],
  '08': ['1.1.03.08', '2.1.01.04'], '09': ['1.1.03.09', '2.1.01.05'], '10': ['1.1.03.10', '2.1.01.05'],
  '12': ['1.1.03.11', '2.1.01.06'],
};
const CATEGORIAS = ['ALIMENTO', 'MATERIA_PRIMA', 'NUCLEO', 'MEDICAMENTO', 'VACUNA', 'LIMPIEZA', 'CRIANZA', 'OTRO'];
const UNIDADES = ['KG', 'QQ', 'LT', 'UND', 'DOSIS'];

module.exports = function crearControlador(h) {
  const { all, get, run, tx, exigir, HttpError, leerJson } = h;

  const r = (n, d) => { const f = 10 ** d; return Math.round((Number(n) + Number.EPSILON) * f) / f; };
  const r2 = (n) => r(n, 2), r3 = (n) => r(n, 3), r4 = (n) => r(n, 4);
  const hoy = () => new Date().toISOString().slice(0, 10);
  const num = (v, campo) => {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw new HttpError(400, `${campo}: valor numérico inválido`);
    return n;
  };
  const texto = (v) => (v === undefined || v === null ? '' : String(v).trim());

  function cuentaPorCodigo(codigo) {
    const c = get('SELECT id, codigo, nombre, activa, es_imputable FROM cuentas WHERE codigo = ?', codigo);
    if (!c) throw new HttpError(400, `La cuenta ${codigo} no existe en el plan de cuentas`);
    return c;
  }
  function ejercicioAbierto() {
    const e = get(`SELECT id, codigo, fecha_inicio, fecha_fin FROM ejercicios_fiscales WHERE estado = 'ABIERTO' ORDER BY id DESC`);
    if (!e) throw new HttpError(409, 'No hay un ejercicio fiscal abierto');
    return e;
  }
  function fechaValida(f, campo = 'Fecha') {
    if (!FECHA.test(f || '')) throw new HttpError(400, `${campo} inválida (AAAA-MM-DD)`);
    const e = ejercicioAbierto();
    if (f < e.fecha_inicio || f > e.fecha_fin) throw new HttpError(400, `${campo} fuera del ejercicio fiscal ${e.codigo} (${e.fecha_inicio} a ${e.fecha_fin})`);
    return f;
  }
  function crearAsiento({ fecha, glosa, documento, usuarioId, lineas }) {
    const ej = ejercicioAbierto();
    const numero = get('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM asientos WHERE ejercicio_id = ?', ej.id).n;
    const { lastInsertRowid: id } = run(
      `INSERT INTO asientos (ejercicio_id, numero, fecha, tipo, glosa, documento_respaldo, creado_por) VALUES (?, ?, ?, 'DIARIO', ?, ?, ?)`,
      ej.id, numero, fecha, glosa, documento || null, usuarioId);
    lineas.forEach((l, i) => run(
      `INSERT INTO asiento_detalle (asiento_id, linea, cuenta_id, debe, haber, centro_costo_id, sufijo_id, lote_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, i + 1, l.cuenta_id, r2(l.debe || 0), r2(l.haber || 0), l.centro_id || null, l.sufijo_id || null, l.lote_id || null));
    run(`UPDATE asientos SET estado = 'CONTABILIZADO', contabilizado_en = CURRENT_TIMESTAMP WHERE id = ?`, id);
    return { id, numero };
  }

  // ===========================================================================================
  // Semáforo CI-FIN-16
  // ===========================================================================================
  /**
   *  ROJO      stock físico < stock de seguridad
   *  AMARILLO  stock de seguridad ≤ stock físico ≤ punto de reorden
   *  VERDE     stock físico > punto de reorden
   *  SIN_PARAMETROS  el insumo aún no tiene stock de seguridad ni punto de reorden fijados
   *  NO_DISPONIBLE   insumo de la línea de alimento propio (desde 2027) todavía no activada
   */
  function semaforo(i) {
    if (!i.disponible) return { color: 'NO_DISPONIBLE', mensaje: 'Disponible desde 2027 (línea de alimento propio CC-02, aún no activada)' };
    if (!(i.stock_seguridad > 0) && !(i.punto_reorden > 0)) return { color: 'SIN_PARAMETROS', mensaje: 'Fije el stock de seguridad y el punto de reorden (CI-FIN-16)' };
    if (i.cantidad_actual < i.stock_seguridad) {
      return { color: 'ROJO', mensaje: `Bajo el stock de seguridad (${i.stock_seguridad} ${i.unidad}): déficit; la Gerencia General puede autorizar compra de emergencia (PR-FIN-03, CI-FIN-16)` };
    }
    if (i.cantidad_actual <= i.punto_reorden) {
      return { color: 'AMARILLO', mensaje: `En o bajo el punto de reorden (${i.punto_reorden} ${i.unidad}): incluir en la orden de compra del lunes (PR-FIN-03)` };
    }
    return { color: 'VERDE', mensaje: 'Stock por encima del punto de reorden' };
  }

  const SQL_INSUMO = `
    SELECT i.*, s.codigo AS sufijo, s.nombre AS sufijo_nombre, s.activo AS sufijo_activo,
           ci.codigo AS cuenta_inventario, ci.nombre AS cuenta_inventario_nombre, ci.activa AS cuenta_activa,
           cp.codigo AS cuenta_proveedor
      FROM insumos i
      JOIN sufijos_costo s ON s.id = i.sufijo_id
      JOIN cuentas ci ON ci.id = i.cuenta_inventario_id
      JOIN cuentas cp ON cp.id = i.cuenta_proveedor_id`;

  function enriquecer(i) {
    const out = { ...i, disponible: !!(i.activo && i.sufijo_activo && i.cuenta_activa) };
    out.valor_actual = r2(i.valor_actual);
    const s = semaforo(out);
    return { ...out, semaforo: s.color, semaforo_mensaje: s.mensaje };
  }
  function insumoPorId(id) {
    const i = get(`${SQL_INSUMO} WHERE i.id = ?`, Number(id));
    if (!i) throw new HttpError(404, 'Insumo no encontrado');
    return enriquecer(i);
  }

  // ===========================================================================================
  // Movimientos del kardex al Costo Promedio Ponderado (PC-07)
  // ===========================================================================================
  /** Entrada: nuevo CPP = (valor del saldo + valor de la entrada) / (cantidad del saldo + cantidad de la entrada). */
  function kardexEntrada(insumoId, m) {
    const i = get('SELECT id, cantidad_actual, valor_actual FROM insumos WHERE id = ?', insumoId);
    const cantidad = r3(m.cantidad);
    const total = r2(cantidad * m.costo_unitario);
    const nuevaCant = r3(i.cantidad_actual + cantidad);
    const nuevoValor = r2(i.valor_actual + total);
    const cpp = r4(nuevoValor / nuevaCant);
    run('UPDATE insumos SET cantidad_actual = ?, valor_actual = ?, costo_promedio = ? WHERE id = ?', nuevaCant, nuevoValor, cpp, insumoId);
    const { lastInsertRowid: id } = run(
      `INSERT INTO kardex_movimientos (insumo_id, fecha, tipo, documento, detalle, cantidad, costo_unitario, total, saldo_cantidad, saldo_costo_unit, saldo_total,
         compra_id, asiento_id, registrado_por) VALUES (?, ?, 'ENTRADA_COMPRA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      insumoId, m.fecha, m.documento || null, m.detalle || null, cantidad, m.costo_unitario, total, nuevaCant, cpp, nuevoValor,
      m.compra_id || null, m.asiento_id || null, m.usuarioId);
    return { id, total, saldo_cantidad: nuevaCant, cpp };
  }
  /** Salida: se valora al CPP vigente; el CPP no cambia con las salidas. */
  function kardexSalida(insumoId, m) {
    const i = get('SELECT id, nombre, unidad, cantidad_actual, valor_actual, costo_promedio FROM insumos WHERE id = ?', insumoId);
    const cantidad = r3(m.cantidad);
    if (cantidad > i.cantidad_actual) {
      throw new HttpError(400, `Stock insuficiente de ${i.nombre}: hay ${i.cantidad_actual} ${i.unidad} y se pidieron ${cantidad}`);
    }
    const cu = i.costo_promedio;
    const total = cantidad === i.cantidad_actual ? r2(i.valor_actual) : r2(cantidad * cu);   // al vaciar el saldo no quedan centavos
    const nuevaCant = r3(i.cantidad_actual - cantidad);
    const nuevoValor = nuevaCant === 0 ? 0 : r2(Math.max(0, i.valor_actual - total));
    run('UPDATE insumos SET cantidad_actual = ?, valor_actual = ? WHERE id = ?', nuevaCant, nuevoValor, insumoId);
    // La fila del kardex se inserta cuando ya existe el asiento (el kardex es inmutable: no se actualiza después).
    const registrar = (asientoId) => run(
      `INSERT INTO kardex_movimientos (insumo_id, fecha, tipo, documento, detalle, cantidad, costo_unitario, total, saldo_cantidad, saldo_costo_unit, saldo_total,
         lote_id, bitacora_id, asiento_id, registrado_por) VALUES (?, ?, 'SALIDA_CONSUMO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      insumoId, m.fecha, m.documento || null, m.detalle || null, cantidad, cu, total, nuevaCant, cu, nuevoValor,
      m.lote_id || null, m.bitacora_id || null, asientoId || null, m.usuarioId).lastInsertRowid;
    return { total, costo_unitario: cu, saldo_cantidad: nuevaCant, registrar };
  }

  // ===========================================================================================
  // Catálogo de insumos
  // ===========================================================================================
  function listarInsumos(ctx) {
    exigir(ctx, 'inventario.ver');
    return all(`${SQL_INSUMO} ORDER BY i.categoria, i.nombre`).map(enriquecer);
  }
  function resumen(ctx) {
    exigir(ctx, 'inventario.ver');
    const lista = all(`${SQL_INSUMO}`).map(enriquecer);
    const cuenta = (c) => lista.filter((i) => i.semaforo === c).length;
    return {
      rojo: cuenta('ROJO'), amarillo: cuenta('AMARILLO'), verde: cuenta('VERDE'),
      sin_parametros: cuenta('SIN_PARAMETROS'), no_disponible: cuenta('NO_DISPONIBLE'),
      valor_inventario: r2(lista.reduce((s, i) => s + i.valor_actual, 0)),
      alertas: lista.filter((i) => i.semaforo === 'ROJO' || i.semaforo === 'AMARILLO')
        .map((i) => ({ id: i.id, codigo: i.codigo, nombre: i.nombre, unidad: i.unidad, cantidad_actual: i.cantidad_actual, semaforo: i.semaforo, mensaje: i.semaforo_mensaje })),
    };
  }
  function catalogos(ctx) {
    exigir(ctx, 'inventario.ver');
    return {
      categorias: CATEGORIAS, unidades: UNIDADES, medios_egreso: MEDIOS_EGRESO,
      limites: { aprobacion_gg: LIMITE_APROBACION_GG, cotizaciones: LIMITE_COTIZACIONES, min_cotizaciones: MIN_COTIZACIONES },
      sufijos: all(`SELECT codigo, nombre, activo FROM sufijos_costo WHERE elemento_costo = 'MPD' ORDER BY codigo`)
        .map((s) => ({ ...s, cuentas_propuestas: CUENTAS_POR_SUFIJO[s.codigo] || null })),
      cuentas_inventario: all(`SELECT codigo, nombre, activa FROM cuentas WHERE codigo LIKE '1.1.03.__' AND es_imputable = 1 ORDER BY codigo`),
      cuentas_proveedor: all(`SELECT codigo, nombre, activa FROM cuentas WHERE codigo LIKE '2.1.01.__' AND es_imputable = 1 ORDER BY codigo`),
      lotes_abiertos: all(`SELECT l.id, l.codigo, cc.codigo AS centro, l.fecha_inicio, l.fecha_fin_prevista FROM lotes l JOIN centros_costo cc ON cc.id = l.centro_costo_id WHERE l.estado = 'ABIERTO' ORDER BY l.id DESC`),
    };
  }

  async function crearInsumo(ctx, req) {
    exigir(ctx, 'inventario.configurar');
    const b = await leerJson(req);
    const codigo = texto(b.codigo).toUpperCase(), nombre = texto(b.nombre);
    if (!codigo || !nombre) throw new HttpError(400, 'Código y nombre del insumo son obligatorios');
    if (!CATEGORIAS.includes(b.categoria)) throw new HttpError(400, 'Categoría inválida');
    if (!UNIDADES.includes(b.unidad)) throw new HttpError(400, 'Unidad de medida inválida');
    const suf = get('SELECT id, codigo, elemento_costo FROM sufijos_costo WHERE codigo = ?', texto(b.sufijo));
    if (!suf || suf.elemento_costo !== 'MPD') throw new HttpError(400, 'Elija un sufijo MPD del Grupo 6 (materia prima y materiales directos)');
    const prop = CUENTAS_POR_SUFIJO[suf.codigo] || [];
    const ci = cuentaPorCodigo(texto(b.cuenta_inventario) || prop[0] || '');
    const cp = cuentaPorCodigo(texto(b.cuenta_proveedor) || prop[1] || '');
    if (!ci.codigo.startsWith('1.1.03.')) throw new HttpError(400, 'La cuenta de inventario debe ser del subgrupo 1.1.03');
    if (!cp.codigo.startsWith('2.1.01.')) throw new HttpError(400, 'La cuenta de proveedores debe ser del subgrupo 2.1.01');
    const seg = b.stock_seguridad === undefined || b.stock_seguridad === '' ? 0 : num(b.stock_seguridad, 'Stock de seguridad');
    const pdr = b.punto_reorden === undefined || b.punto_reorden === '' ? seg : num(b.punto_reorden, 'Punto de reorden');
    const max = b.stock_maximo === undefined || b.stock_maximo === '' || b.stock_maximo === null ? null : num(b.stock_maximo, 'Stock máximo');
    if (seg < 0 || pdr < seg) throw new HttpError(400, 'El punto de reorden no puede ser menor al stock de seguridad');
    if (get('SELECT 1 FROM insumos WHERE codigo = ?', codigo)) throw new HttpError(409, `Ya existe un insumo con el código ${codigo}`);
    const { lastInsertRowid: id } = run(
      `INSERT INTO insumos (codigo, nombre, categoria, unidad, almacen, sufijo_id, cuenta_inventario_id, cuenta_proveedor_id, stock_seguridad, punto_reorden, stock_maximo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      codigo, nombre, b.categoria, b.unidad, texto(b.almacen) || null, suf.id, ci.id, cp.id, seg, pdr, max);
    return insumoPorId(id);
  }

  /** CI-FIN-16: stock de seguridad y punto de reorden por insumo. */
  async function fijarParametros(ctx, req, url, [id]) {
    exigir(ctx, 'inventario.configurar');
    const b = await leerJson(req);
    const i = insumoPorId(id);
    const seg = b.stock_seguridad === undefined ? i.stock_seguridad : num(b.stock_seguridad, 'Stock de seguridad');
    const pdr = b.punto_reorden === undefined ? i.punto_reorden : num(b.punto_reorden, 'Punto de reorden');
    const max = b.stock_maximo === undefined ? i.stock_maximo : (b.stock_maximo === null || b.stock_maximo === '' ? null : num(b.stock_maximo, 'Stock máximo'));
    if (seg < 0 || pdr < 0) throw new HttpError(400, 'Los niveles de stock no pueden ser negativos');
    if (pdr < seg) throw new HttpError(400, 'El punto de reorden no puede ser menor al stock de seguridad');
    if (max !== null && max < pdr) throw new HttpError(400, 'El stock máximo no puede ser menor al punto de reorden');
    run('UPDATE insumos SET stock_seguridad = ?, punto_reorden = ?, stock_maximo = ?, almacen = ? WHERE id = ?',
      seg, pdr, max, b.almacen === undefined ? i.almacen : (texto(b.almacen) || null), i.id);
    return insumoPorId(i.id);
  }

  // ===========================================================================================
  // Kardex valorado KV-08
  // ===========================================================================================
  function kardex(ctx, req, url, [id]) {
    exigir(ctx, 'inventario.ver');
    const i = insumoPorId(id);
    const desde = url.searchParams.get('desde'), hasta = url.searchParams.get('hasta');
    const movs = all(
      `SELECT k.id, k.fecha, k.tipo, k.documento, k.detalle, k.cantidad, k.costo_unitario, k.total, k.saldo_cantidad, k.saldo_costo_unit, k.saldo_total,
              k.asiento_id, a.numero AS asiento_numero, l.codigo AS lote
         FROM kardex_movimientos k LEFT JOIN asientos a ON a.id = k.asiento_id LEFT JOIN lotes l ON l.id = k.lote_id
        WHERE k.insumo_id = ? ORDER BY k.id`, i.id);
    const dentro = movs.filter((m) => (!desde || m.fecha >= desde) && (!hasta || m.fecha <= hasta));
    const previos = movs.filter((m) => desde && m.fecha < desde);
    const ant = previos.length ? previos[previos.length - 1] : null;
    const sumas = (tipo) => r2(dentro.filter((m) => m.tipo === tipo).reduce((s, m) => s + m.total, 0));
    const cant = (tipo) => r3(dentro.filter((m) => m.tipo === tipo).reduce((s, m) => s + m.cantidad, 0));
    return {
      formato: 'KV-08 — Kardex de Inventarios Valorado (MAN-06 §22.6)',
      metodo_valuacion: 'Costo Promedio Ponderado (PC-07)',
      insumo: {
        id: i.id, codigo: i.codigo, nombre: i.nombre, unidad: i.unidad, almacen: i.almacen, stock_minimo: i.stock_seguridad,
        stock_maximo: i.stock_maximo, punto_reorden: i.punto_reorden, cuenta_inventario: i.cuenta_inventario, sufijo: i.sufijo,
        semaforo: i.semaforo, cantidad_actual: i.cantidad_actual, costo_promedio: i.costo_promedio, valor_actual: i.valor_actual,
      },
      saldo_anterior: ant ? { cantidad: ant.saldo_cantidad, costo_unitario: ant.saldo_costo_unit, total: ant.saldo_total } : { cantidad: 0, costo_unitario: 0, total: 0 },
      movimientos: dentro,
      sumas: { entradas_cantidad: cant('ENTRADA_COMPRA'), entradas_total: sumas('ENTRADA_COMPRA'), salidas_cantidad: cant('SALIDA_CONSUMO'), salidas_total: sumas('SALIDA_CONSUMO') },
    };
  }

  // ===========================================================================================
  // Expediente de proveedores RAU (PET-RAU-001)
  // ===========================================================================================
  function validarCredenciales(p) {
    const nombre = texto(p.nombre), doc = texto(p.documento_identidad), tipo = texto(p.tipo_certificado).toUpperCase(), num_ = texto(p.numero_certificado);
    if (!nombre) throw new HttpError(400, 'Proveedor: el nombre o razón social es obligatorio (PET-RAU-001)');
    if (!doc) throw new HttpError(400, 'Proveedor: la C.I. (o NIT) es obligatoria (PET-RAU-001)');
    if (!['RAU', 'NO_IMPONIBILIDAD'].includes(tipo)) throw new HttpError(400, 'Proveedor: indique si presenta Certificado RAU o Certificado de No Imponibilidad');
    if (!num_) throw new HttpError(400, `Proveedor: falta el número del ${tipo === 'RAU' ? 'Certificado RAU' : 'Certificado de No Imponibilidad'}`);
    return { nombre, documento_identidad: doc, tipo_certificado: tipo, numero_certificado: num_, telefono: texto(p.telefono) || null, observaciones: texto(p.observaciones) || null };
  }
  function listarProveedores(ctx) {
    exigir(ctx, 'inventario.ver');
    return all(
      `SELECT p.id, p.nombre, p.documento_identidad, p.tipo_certificado, p.numero_certificado, p.telefono, p.observaciones, p.activo,
              COUNT(c.id) AS compras, COALESCE(SUM(c.total), 0) AS total_comprado,
              COALESCE(SUM(CASE WHEN c.estado = 'PENDIENTE' THEN c.total ELSE 0 END), 0) AS por_pagar
         FROM proveedores p LEFT JOIN compras c ON c.proveedor_id = p.id GROUP BY p.id ORDER BY p.nombre`)
      .map((p) => ({ ...p, total_comprado: r2(p.total_comprado), por_pagar: r2(p.por_pagar) }));
  }
  function proveedorCore(ctx, b) {
    exigir(ctx, 'compras.registrar');
    const d = validarCredenciales(b);
    if (get('SELECT 1 FROM proveedores WHERE documento_identidad = ?', d.documento_identidad)) {
      throw new HttpError(409, `Ya existe un proveedor con la C.I./NIT ${d.documento_identidad}`);
    }
    const { lastInsertRowid: id } = run(
      `INSERT INTO proveedores (nombre, documento_identidad, tipo_certificado, numero_certificado, telefono, observaciones, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      d.nombre, d.documento_identidad, d.tipo_certificado, d.numero_certificado, d.telefono, d.observaciones, ctx.usuarioId);
    return get('SELECT * FROM proveedores WHERE id = ?', id);
  }
  const crearProveedor = async (ctx, req) => proveedorCore(ctx, await leerJson(req));
  async function actualizarProveedor(ctx, req, url, [id]) {
    exigir(ctx, 'compras.registrar');
    const p = get('SELECT * FROM proveedores WHERE id = ?', Number(id));
    if (!p) throw new HttpError(404, 'Proveedor no encontrado');
    const d = validarCredenciales({ ...p, ...(await leerJson(req)) });
    run('UPDATE proveedores SET nombre = ?, documento_identidad = ?, tipo_certificado = ?, numero_certificado = ?, telefono = ?, observaciones = ? WHERE id = ?',
      d.nombre, d.documento_identidad, d.tipo_certificado, d.numero_certificado, d.telefono, d.observaciones, p.id);
    return get('SELECT * FROM proveedores WHERE id = ?', p.id);
  }

  // ===========================================================================================
  // Compras (entrada de insumos)  — PR-FIN-03 pasos 5 y 8
  // ===========================================================================================
  function listarCompras(ctx) {
    exigir(ctx, 'inventario.ver');
    const hoyS = hoy();
    return all(
      `SELECT c.id, c.fecha, p.nombre AS proveedor, p.documento_identidad, p.tipo_certificado, p.numero_certificado, c.documento_tipo, c.documento_numero,
              c.orden_compra, c.cotizaciones, c.condicion, c.medio_pago, c.fecha_vencimiento, c.total, c.estado, c.fecha_pago,
              a.numero AS asiento_numero, ap.numero AS asiento_pago_numero, c.asiento_id, c.asiento_pago_id
         FROM compras c JOIN proveedores p ON p.id = c.proveedor_id JOIN asientos a ON a.id = c.asiento_id LEFT JOIN asientos ap ON ap.id = c.asiento_pago_id
        ORDER BY c.fecha DESC, c.id DESC`)
      .map((c) => ({
        ...c,
        vencida: c.estado === 'PENDIENTE' && c.fecha_vencimiento < hoyS,
        items: all(`SELECT i.nombre, i.unidad, ci.cantidad, ci.costo_unitario, ci.total FROM compra_items ci JOIN insumos i ON i.id = ci.insumo_id WHERE ci.compra_id = ? ORDER BY ci.id`, c.id),
      }));
  }

  /** Registra la compra: credenciales del vendedor → asiento (Dr Inventario / Cr Caja-Banco o CxP) → entradas al kardex con nuevo CPP. */
  function compraCore(ctx, b) {
    exigir(ctx, 'compras.registrar');
    const fecha = fechaValida(b.fecha, 'Fecha de la compra');

    // 1) Credenciales del vendedor: obligatorias antes de procesar el comprobante (PET-RAU-001)
    let prov;
    if (b.proveedor_id) {
      prov = get('SELECT * FROM proveedores WHERE id = ? AND activo = 1', Number(b.proveedor_id));
      if (!prov) throw new HttpError(400, 'Proveedor inexistente o inactivo');
    } else if (b.proveedor) {
      prov = proveedorCore(ctx, b.proveedor);
    } else {
      throw new HttpError(400, 'Seleccione un proveedor o registre sus credenciales (nombre, C.I., certificado RAU o de no imponibilidad)');
    }
    validarCredenciales(prov);   // revisa también los proveedores ya existentes

    // 2) Respaldo documental
    const docTipo = texto(b.documento_tipo).toUpperCase();
    if (!['FACTURA', 'RECIBO'].includes(docTipo)) throw new HttpError(400, 'Indique el documento de respaldo: factura o recibo');
    const docNum = texto(b.documento_numero);
    if (!docNum) throw new HttpError(400, `Falta el número de ${docTipo === 'FACTURA' ? 'la factura' : 'el recibo'}`);

    // 3) Ítems
    if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, 'Agregue al menos un insumo a la compra');
    const items = b.items.map((it, n) => {
      const ins = get(`${SQL_INSUMO} WHERE i.id = ?`, Number(it.insumo_id));
      if (!ins) throw new HttpError(400, `Ítem ${n + 1}: insumo inexistente`);
      const e = enriquecer(ins);
      if (!e.disponible) throw new HttpError(409, `${e.nombre}: ${e.semaforo_mensaje}.`);
      const cantidad = r3(num(it.cantidad, `Ítem ${n + 1}: cantidad`));
      const cu = r4(num(it.costo_unitario, `Ítem ${n + 1}: costo unitario`));
      if (cantidad <= 0 || cu <= 0) throw new HttpError(400, `Ítem ${n + 1}: cantidad y costo unitario deben ser mayores a cero`);
      return { ins: e, cantidad, cu, total: r2(cantidad * cu) };
    });
    const total = r2(items.reduce((s, i) => s + i.total, 0));

    // 4) Controles de PR-FIN-03 §4
    const oc = texto(b.orden_compra) || null;
    const cot = Number.isInteger(Number(b.cotizaciones)) ? Number(b.cotizaciones) : 0;
    if (total > LIMITE_APROBACION_GG && !oc) {
      throw new HttpError(400, `Toda compra mayor a Bs ${LIMITE_APROBACION_GG} requiere la orden de compra aprobada por la Gerencia General (FIN-EGR-03): indique su número`);
    }
    if (total > LIMITE_COTIZACIONES && cot < MIN_COTIZACIONES) {
      throw new HttpError(400, `Las compras mayores a Bs ${LIMITE_COTIZACIONES} requieren cotización de al menos ${MIN_COTIZACIONES} proveedores aprobados`);
    }

    // 5) Condición de pago
    const condicion = texto(b.condicion).toUpperCase();
    if (!['CONTADO', 'CREDITO'].includes(condicion)) throw new HttpError(400, 'Condición de pago inválida (contado o crédito pactado)');
    let medio = null, venc = null;
    if (condicion === 'CONTADO') {
      medio = texto(b.medio_pago).toUpperCase();
      if (!MEDIOS_EGRESO.includes(medio)) throw new HttpError(400, `Forma de pago inválida. Use: ${MEDIOS_EGRESO.join(', ')}`);
    } else {
      venc = b.fecha_vencimiento;
      if (!FECHA.test(venc || '')) throw new HttpError(400, 'La compra a crédito exige la fecha de vencimiento pactada con el proveedor');
      if (venc < fecha) throw new HttpError(400, 'El vencimiento no puede ser anterior a la fecha de la compra');
    }

    // 6) Asiento: Dr Inventario (1.1.03.xx) / Cr Caja-Banco (contado) o Proveedores 2.1.01.xx (crédito)
    const lineas = items.map((i) => ({ cuenta_id: i.ins.cuenta_inventario_id, debe: i.total }));
    if (condicion === 'CONTADO') {
      lineas.push({ cuenta_id: cuentaPorCodigo(medio === 'EFECTIVO' ? CAJA : BANCO).id, haber: total });
    } else {
      const porCuenta = new Map();
      for (const i of items) porCuenta.set(i.ins.cuenta_proveedor_id, r2((porCuenta.get(i.ins.cuenta_proveedor_id) || 0) + i.total));
      for (const [cid, monto] of porCuenta) lineas.push({ cuenta_id: cid, haber: monto });
    }
    const asiento = crearAsiento({
      fecha, usuarioId: ctx.usuarioId, lineas,
      glosa: `Compra de insumos a ${prov.nombre} (${docTipo} ${docNum})${condicion === 'CREDITO' ? ' — a crédito' : ''}`,
      documento: `${docTipo} ${docNum}`,
    });

    const { lastInsertRowid: compraId } = run(
      `INSERT INTO compras (fecha, proveedor_id, documento_tipo, documento_numero, orden_compra, cotizaciones, condicion, medio_pago, fecha_vencimiento,
         total, estado, asiento_id, registrado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fecha, prov.id, docTipo, docNum, oc, cot, condicion, medio, venc, total, condicion === 'CONTADO' ? 'PAGADA' : 'PENDIENTE', asiento.id, ctx.usuarioId);

    // 7) Entradas al kardex con recálculo del CPP
    const movimientos = items.map((i) => {
      run('INSERT INTO compra_items (compra_id, insumo_id, cantidad, costo_unitario, total) VALUES (?, ?, ?, ?, ?)', compraId, i.ins.id, i.cantidad, i.cu, i.total);
      const k = kardexEntrada(i.ins.id, {
        fecha, cantidad: i.cantidad, costo_unitario: i.cu, documento: `${docTipo} ${docNum}`,
        detalle: `Compra a ${prov.nombre}`, compra_id: compraId, asiento_id: asiento.id, usuarioId: ctx.usuarioId,
      });
      return { insumo: i.ins.nombre, unidad: i.ins.unidad, cantidad: i.cantidad, costo_compra: i.cu, nuevo_stock: k.saldo_cantidad, nuevo_cpp: k.cpp };
    });
    return {
      id: compraId, total, asiento_id: asiento.id, asiento_numero: asiento.numero,
      estado: condicion === 'CONTADO' ? 'PAGADA' : 'PENDIENTE', comprobante: condicion === 'CONTADO' ? 'CE-02' : null,
      proveedor: prov.nombre, movimientos,
    };
  }
  async function registrarCompraHttp(ctx, req) {
    const b = await leerJson(req);
    return tx(() => compraCore(ctx, b));
  }

  /** Pago de la cuenta por pagar: Dr Proveedores 2.1.01.xx / Cr Caja-Banco — Comprobante de Egreso CE-02 (PR-FIN-03 paso 8). */
  function pagoCore(ctx, compraId, b) {
    exigir(ctx, 'compras.registrar');
    const c = get('SELECT c.*, p.nombre AS proveedor FROM compras c JOIN proveedores p ON p.id = c.proveedor_id WHERE c.id = ?', compraId);
    if (!c) throw new HttpError(404, 'Compra no encontrada');
    if (c.estado === 'PAGADA') throw new HttpError(409, 'La compra ya está pagada');
    const fecha = fechaValida(b.fecha || hoy(), 'Fecha de pago');
    if (fecha < c.fecha) throw new HttpError(400, 'El pago no puede ser anterior a la compra');
    const medio = texto(b.medio_pago).toUpperCase();
    if (!MEDIOS_EGRESO.includes(medio)) throw new HttpError(400, `Forma de pago inválida. Use: ${MEDIOS_EGRESO.join(', ')}`);
    const porCuenta = all(
      `SELECT i.cuenta_proveedor_id AS cuenta_id, SUM(ci.total) AS monto FROM compra_items ci JOIN insumos i ON i.id = ci.insumo_id WHERE ci.compra_id = ? GROUP BY i.cuenta_proveedor_id`, c.id);
    const lineas = porCuenta.map((x) => ({ cuenta_id: x.cuenta_id, debe: r2(x.monto) }));
    lineas.push({ cuenta_id: cuentaPorCodigo(medio === 'EFECTIVO' ? CAJA : BANCO).id, haber: c.total });
    const asiento = crearAsiento({
      fecha, usuarioId: ctx.usuarioId, lineas,
      glosa: `Pago a ${c.proveedor} (${c.documento_tipo} ${c.documento_numero})`, documento: `${c.documento_tipo} ${c.documento_numero}`,
    });
    run(`UPDATE compras SET estado = 'PAGADA', fecha_pago = ?, medio_pago_final = ?, asiento_pago_id = ? WHERE id = ?`, fecha, medio, asiento.id, c.id);
    return { mensaje: 'Pago registrado', asiento_numero: asiento.numero, asiento_id: asiento.id, pagada_con_retraso: fecha > c.fecha_vencimiento };
  }
  async function pagarCompra(ctx, req, url, [id]) {
    const b = await leerJson(req);
    return tx(() => pagoCore(ctx, Number(id), b));
  }

  // ===========================================================================================
  // Consumo de insumos desde la bitácora diaria del lote (día 1 a 73)
  // ===========================================================================================
  /**
   * Registra la bitácora del día y descuenta los insumos del kardex al CPP vigente. Genera un asiento por bitácora:
   *   Dr 6.1.01.0x (centro de costo, sufijo del insumo, lote)  /  Cr 1.1.03.xx (inventario del insumo)
   * Una línea de débito por insumo, para que el costo quede por sufijo en la hoja de costos del lote (MAN-01 §8.1).
   */
  function bitacoraCore(ctx, loteId, b) {
    exigir(ctx, 'lotes.bitacora');
    const lote = get(
      `SELECT l.id, l.codigo, l.estado, l.fecha_inicio, l.centro_costo_id, cc.cuenta_id AS centro_cuenta_id, cc.codigo AS centro
         FROM lotes l JOIN centros_costo cc ON cc.id = l.centro_costo_id WHERE l.id = ?`, loteId);
    if (!lote) throw new HttpError(404, 'Lote no encontrado');
    if (lote.estado !== 'ABIERTO') throw new HttpError(409, 'El lote no está ABIERTO: no admite nuevos registros de bitácora');
    const fecha = fechaValida(b.fecha || hoy(), 'Fecha de la bitácora');
    const dia = get(`SELECT CAST(julianday(?) - julianday(?) AS INTEGER) + 1 AS d`, fecha, lote.fecha_inicio).d;
    if (dia < 1 || dia > 73) throw new HttpError(400, `La fecha corresponde al día ${dia} del ciclo; la bitácora cubre del día 1 al 73`);
    if (get('SELECT 1 FROM lote_bitacora WHERE lote_id = ? AND dia_ciclo = ?', loteId, dia)) {
      throw new HttpError(409, `Ya existe un registro de bitácora para el día ${dia} de este lote`);
    }
    const morta = b.mortalidad === undefined || b.mortalidad === '' ? 0 : Number(b.mortalidad);
    if (!Number.isInteger(morta) || morta < 0) throw new HttpError(400, 'Mortalidad: entero mayor o igual a cero');
    let alimento = b.alimento_kg === undefined || b.alimento_kg === '' ? 0 : num(b.alimento_kg, 'Alimento (kg)');
    if (alimento < 0) throw new HttpError(400, 'Alimento: valor inválido');

    const consumos = Array.isArray(b.consumos) ? b.consumos.filter((c) => c && (c.insumo_id || c.cantidad)) : [];
    // Validación previa de cada consumo (insumo disponible, sufijo permitido en el centro del lote)
    const prep = consumos.map((c, n) => {
      const ins = get(`${SQL_INSUMO} WHERE i.id = ?`, Number(c.insumo_id));
      if (!ins) throw new HttpError(400, `Consumo ${n + 1}: seleccione un insumo`);
      const e = enriquecer(ins);
      if (!e.disponible) throw new HttpError(409, `${e.nombre}: ${e.semaforo_mensaje}`);
      const cantidad = r3(num(c.cantidad, `Consumo ${n + 1}: cantidad`));
      if (cantidad <= 0) throw new HttpError(400, `Consumo ${n + 1}: la cantidad debe ser mayor a cero`);
      const permitido = get(
        `SELECT 1 FROM centro_costo_sufijos m JOIN sufijos_costo s ON s.id = m.sufijo_id WHERE m.centro_costo_id = ? AND m.sufijo_id = ? AND s.activo = 1`,
        lote.centro_costo_id, e.sufijo_id);
      if (!permitido) throw new HttpError(400, `${e.nombre} (sufijo ${e.sufijo}) no se puede cargar al centro ${lote.centro}: la matriz centro × sufijo del Manual de Costos no lo permite`);
      return { ins: e, cantidad };
    });
    // El alimento balanceado consumido (kg) sale del kardex; debe coincidir con el dato de la bitácora (alimenta el ICA)
    const alimentoKardex = r2(prep.filter((p) => p.ins.categoria === 'ALIMENTO' && p.ins.unidad === 'KG').reduce((s, p) => s + p.cantidad, 0));
    if (alimentoKardex > 0) {
      if (alimento > 0 && Math.abs(alimento - alimentoKardex) > 0.005) {
        throw new HttpError(400, `El alimento de la bitácora (${alimento} kg) no coincide con el consumo del kardex (${alimentoKardex} kg)`);
      }
      alimento = alimentoKardex;
    }

    const { lastInsertRowid: bitId } = run(
      `INSERT INTO lote_bitacora (lote_id, fecha, dia_ciclo, alimento_kg, mortalidad, novedad_sanitaria, registrado_por) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      loteId, fecha, dia, alimento, morta, texto(b.novedad_sanitaria) || null, ctx.usuarioId);

    let asiento = null;
    const detalle = [];
    if (prep.length) {
      // Salidas del kardex al CPP vigente (en orden: si un insumo se repite, la segunda salida ve el saldo ya descontado)
      const salidas = prep.map((p) => {
        const k = kardexSalida(p.ins.id, {
          fecha, cantidad: p.cantidad, documento: `BIT ${lote.codigo} D${dia}`, detalle: `Consumo lote ${lote.codigo}, día ${dia}`,
          lote_id: loteId, bitacora_id: bitId, usuarioId: ctx.usuarioId,
        });
        return { p, k };
      });
      const lineas = [];
      for (const { p, k } of salidas) {
        if (k.total > 0) lineas.push({ cuenta_id: lote.centro_cuenta_id, centro_id: lote.centro_costo_id, sufijo_id: p.ins.sufijo_id, lote_id: loteId, debe: k.total });
      }
      for (const { p, k } of salidas) if (k.total > 0) lineas.push({ cuenta_id: p.ins.cuenta_inventario_id, haber: k.total });
      if (lineas.length) {
        asiento = crearAsiento({
          fecha, usuarioId: ctx.usuarioId, lineas,
          glosa: `Consumo de insumos del lote ${lote.codigo} — día ${dia} del ciclo (CPP)`, documento: `BIT ${lote.codigo} D${dia}`,
        });
      }
      for (const { p, k } of salidas) {
        const kardexId = k.registrar(asiento ? asiento.id : null);
        detalle.push({ insumo: p.ins.nombre, unidad: p.ins.unidad, sufijo: p.ins.sufijo, cantidad: p.cantidad, costo_unitario: k.costo_unitario, total: k.total, stock_restante: k.saldo_cantidad });
        run(`INSERT INTO bitacora_consumos (bitacora_id, insumo_id, cantidad, costo_unitario, total, kardex_id, asiento_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          bitId, p.ins.id, p.cantidad, k.costo_unitario, k.total, kardexId, asiento ? asiento.id : null);
      }
    }
    const costoTotal = r2(detalle.reduce((s, d) => s + d.total, 0));
    return {
      dia_ciclo: dia, bitacora_id: bitId, alimento_kg: alimento,
      asiento_numero: asiento ? asiento.numero : null, asiento_id: asiento ? asiento.id : null,
      costo_total_consumo: costoTotal, consumos: detalle,
      alertas: detalle.length ? alertasDeInsumos(prep.map((p) => p.ins.id)) : [],
    };
  }
  function alertasDeInsumos(ids) {
    return [...new Set(ids)].map((id) => insumoPorId(id)).filter((i) => i.semaforo === 'ROJO' || i.semaforo === 'AMARILLO')
      .map((i) => ({ insumo: i.nombre, semaforo: i.semaforo, stock: i.cantidad_actual, unidad: i.unidad, mensaje: i.semaforo_mensaje }));
  }
  async function registrarBitacora(ctx, req, url, [id]) {
    const b = await leerJson(req);
    return tx(() => bitacoraCore(ctx, Number(id), b));
  }
  function listarConsumos(ctx, req, url) {
    exigir(ctx, 'inventario.ver');
    const lote = url.searchParams.get('lote_id');
    return all(
      `SELECT bc.id, b.fecha, b.dia_ciclo, l.codigo AS lote, i.nombre AS insumo, i.unidad, s.codigo AS sufijo, bc.cantidad, bc.costo_unitario, bc.total, a.numero AS asiento_numero, bc.asiento_id
         FROM bitacora_consumos bc JOIN lote_bitacora b ON b.id = bc.bitacora_id JOIN lotes l ON l.id = b.lote_id
         JOIN insumos i ON i.id = bc.insumo_id JOIN sufijos_costo s ON s.id = i.sufijo_id LEFT JOIN asientos a ON a.id = bc.asiento_id
        ${lote ? 'WHERE b.lote_id = ?' : ''} ORDER BY b.fecha DESC, bc.id DESC LIMIT 200`, ...(lote ? [Number(lote)] : []));
  }

  // ===========================================================================================
  // Datos de demostración (ilustrativos; los niveles de reorden NO provienen de CI-FIN-16)
  // ===========================================================================================
  function sembrarDemo() {
    if (get('SELECT COUNT(*) AS n FROM insumos').n > 0) return;
    const jf = get(`SELECT id FROM usuarios WHERE username = 'demo_jf'`);
    if (!jf) return;
    const ctxJF = { usuarioId: jf.id, permisos: new Set(['compras.registrar', 'inventario.configurar']) };
    const sufId = (c) => get('SELECT id FROM sufijos_costo WHERE codigo = ?', c).id;
    const ins = (codigo, nombre, categoria, unidad, almacen, sufijo, seg, pdr, max) => {
      const [ci, cp] = CUENTAS_POR_SUFIJO[sufijo];
      run(`INSERT INTO insumos (codigo, nombre, categoria, unidad, almacen, sufijo_id, cuenta_inventario_id, cuenta_proveedor_id, stock_seguridad, punto_reorden, stock_maximo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        codigo, nombre, categoria, unidad, almacen, sufId(sufijo), cuentaPorCodigo(ci).id, cuentaPorCodigo(cp).id, seg, pdr, max);
    };
    tx(() => {
      ins('ALB-01', 'Alimento balanceado (comprado)', 'ALIMENTO', 'KG', 'Almacén seco', '02', 1500, 3000, 12000);
      ins('MAI-01', 'Maíz amarillo', 'MATERIA_PRIMA', 'KG', 'Silo 1', '03', 2000, 4000, 15000);
      ins('SOY-01', 'Torta de soya', 'MATERIA_PRIMA', 'KG', 'Silo 2', '04', 1000, 2000, 8000);
      ins('AFR-01', 'Afrecho de trigo', 'MATERIA_PRIMA', 'KG', 'Almacén seco', '05', 500, 1000, 4000);
      ins('NUC-01', 'Núcleo vitamínico', 'NUCLEO', 'KG', 'Almacén seco', '06', 100, 200, 800);
      ins('MED-01', 'Medicamentos veterinarios (frascos)', 'MEDICAMENTO', 'UND', 'Botiquín', '08', 10, 20, 60);
      ins('VAC-01', 'Vacunas (dosis)', 'VACUNA', 'DOSIS', 'Refrigerador', '08', 3000, 4500, 9000);
      const prov = (nombre, doc, tipo, cert, tel) => proveedorCore(ctxJF, { nombre, documento_identidad: doc, tipo_certificado: tipo, numero_certificado: cert, telefono: tel });
      const p1 = prov('Agropecuaria Los Yungas (DEMO)', '1234567 LP', 'RAU', 'RAU-DEMO-0001', '70000001');
      const p2 = prov('Veterinaria Caranavi (DEMO)', '7654321 LP', 'NO_IMPONIBILIDAD', 'CNI-DEMO-0002', '70000002');
      const id = (cod) => get('SELECT id FROM insumos WHERE codigo = ?', cod).id;
      compraCore(ctxJF, { fecha: '2026-09-01', proveedor_id: p1.id, documento_tipo: 'RECIBO', documento_numero: 'R-0101', orden_compra: 'OC-0001', cotizaciones: 3,
        condicion: 'CREDITO', fecha_vencimiento: '2026-09-30', items: [{ insumo_id: id('ALB-01'), cantidad: 4000, costo_unitario: 4.3 }] });
      compraCore(ctxJF, { fecha: '2026-09-15', proveedor_id: p1.id, documento_tipo: 'RECIBO', documento_numero: 'R-0102', orden_compra: 'OC-0002', cotizaciones: 3,
        condicion: 'CONTADO', medio_pago: 'TRANSFERENCIA', items: [{ insumo_id: id('ALB-01'), cantidad: 2500, costo_unitario: 4.5 }] });
      compraCore(ctxJF, { fecha: '2026-09-10', proveedor_id: p2.id, documento_tipo: 'FACTURA', documento_numero: 'F-5501', orden_compra: 'OC-0003',
        condicion: 'CONTADO', medio_pago: 'TRANSFERENCIA', items: [{ insumo_id: id('MED-01'), cantidad: 15, costo_unitario: 38 }, { insumo_id: id('VAC-01'), cantidad: 2800, costo_unitario: 0.35 }] });
    });
  }

  return {
    listarInsumos, resumen, catalogos, crearInsumo, fijarParametros, kardex,
    listarProveedores, crearProveedor, actualizarProveedor,
    listarCompras, registrarCompra: registrarCompraHttp, pagarCompra,
    registrarBitacora, listarConsumos, sembrarDemo,
    // expuestos para pruebas
    _semaforo: semaforo, _bitacoraCore: bitacoraCore, _compraCore: compraCore,
  };
};
