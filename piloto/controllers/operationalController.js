/**
 * Controlador operativo — Fase 4.
 *   1) Cierre de ciclo / faenado en el día 73      (MPP PR-FIN-04 pasos 5-6, PR-FIN-06; Anexo 7)
 *   2) Ventas al contado y crédito HORECA          (MPP PR-FIN-08, PR-FIN-09; POL-05)
 *
 * Sin autenticación: el rol activo ya fue resuelto por server.js (ctx). Los permisos siguen el MOF.
 * Todas las reglas están además respaldadas por CHECK/triggers en database/schema.sql y fase4.sql.
 */
'use strict';

const CUENTAS = {
  INVENTARIO_CARNE: '1.1.03.12',   // Inventario – Productos Terminados: Carne de Pollo
  CENTRO_CARNE: '6.1.01.01',       // Centro de costo – Producción de Carne de Pollo (CC-01)
  CAJA: '1.1.01.01',               // Caja – Efectivo en Moneda Nacional
  BANCO: '1.1.01.03',              // Banco – Cuenta Corriente Moneda Nacional
  CXC: '1.1.02.01',                // Cuentas por Cobrar
  VENTA_CARNE: '5.1.01.01',        // Ventas – Carne de pollo
  VENTA_GALLINAZA: '5.2.01.04',    // Ventas – Gallinaza / Abono Orgánico
  COSTO_VENTA_CARNE: '6.1.02.01',  // Costo de Ventas – Carne de Pollo
};
// POL-05 Art. 1 y PR-FIN-09: efectivo, transferencia, depósito, cheque nominativo y QR/ACH. No se aceptan cheques diferidos.
const MEDIOS_PAGO = ['EFECTIVO', 'TRANSFERENCIA', 'DEPOSITO', 'CHEQUE_NOMINATIVO', 'QR_ACH'];
const UMBRAL_PERDIDA_NORMAL = 0.05;            // Anexo 7: mortalidad normal ≤ 5 % de las aves iniciales
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function crearControlador(h) {
  const { all, get, run, tx, exigir, HttpError, leerJson } = h;

  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const num = (v, campo) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new HttpError(400, `${campo}: valor numérico inválido`);
    return n;
  };
  const hoy = () => new Date().toISOString().slice(0, 10);

  function cuentaId(codigo) {
    const c = get('SELECT id FROM cuentas WHERE codigo = ?', codigo);
    if (!c) throw new HttpError(500, `Falta la cuenta ${codigo} en el plan de cuentas`);
    return c.id;
  }
  const cuentaDeCobro = (medio) => cuentaId(medio === 'EFECTIVO' ? CUENTAS.CAJA : CUENTAS.BANCO);

  function ejercicioAbierto() {
    const e = get(`SELECT id, codigo, fecha_inicio, fecha_fin FROM ejercicios_fiscales WHERE estado = 'ABIERTO' ORDER BY id DESC`);
    if (!e) throw new HttpError(409, 'No hay un ejercicio fiscal abierto');
    return e;
  }
  const siguienteNumero = (ejId) =>
    get('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM asientos WHERE ejercicio_id = ?', ejId).n;

  function crearAsiento({ fecha, tipo, glosa, documento, usuarioId, lineas, contabilizar }) {
    const ej = ejercicioAbierto();
    const numero = siguienteNumero(ej.id);
    const { lastInsertRowid: id } = run(
      `INSERT INTO asientos (ejercicio_id, numero, fecha, tipo, glosa, documento_respaldo, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ej.id, numero, fecha, tipo, glosa, documento || null, usuarioId);
    lineas.forEach((l, i) => run(
      `INSERT INTO asiento_detalle (asiento_id, linea, cuenta_id, debe, haber, centro_costo_id, sufijo_id, lote_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, i + 1, l.cuenta_id, r2(l.debe || 0), r2(l.haber || 0), l.centro_id || null, l.sufijo_id || null, l.lote_id || null));
    if (contabilizar) run(`UPDATE asientos SET estado = 'CONTABILIZADO', contabilizado_en = CURRENT_TIMESTAMP WHERE id = ?`, id);
    return { id, numero };
  }

  // ===========================================================================================
  // 1) CIERRE DE CICLO / FAENADO
  // ===========================================================================================

  /** Foto del lote para el formulario FIN-TRA-05/06: mortalidad, alimento, costos por sufijo y conciliación de aves. */
  function resumenLote(loteId) {
    const lote = get(
      `SELECT l.*, cc.codigo AS centro, cc.id AS centro_id FROM lotes l JOIN centros_costo cc ON cc.id = l.centro_costo_id WHERE l.id = ?`, loteId);
    if (!lote) throw new HttpError(404, 'Lote no encontrado');
    const bit = get(
      `SELECT COALESCE(SUM(mortalidad), 0) AS muertas, COALESCE(SUM(alimento_kg), 0) AS alimento_kg, COUNT(*) AS dias_registrados, MAX(dia_ciclo) AS ultimo_dia
       FROM lote_bitacora WHERE lote_id = ?`, loteId);
    const iniciales = lote.aves_iniciales || 0;
    const maxNormal = Math.floor(iniciales * UMBRAL_PERDIDA_NORMAL);
    const normal = Math.min(bit.muertas, maxNormal);
    const costos = all(
      `SELECT sufijo, sufijo_nombre, elemento_costo, monto FROM v_hoja_costos_lote WHERE lote_id = ? ORDER BY sufijo`, loteId)
      .map((c) => ({ ...c, monto: r2(c.monto) }));
    const faenado = get('SELECT * FROM lote_faenado WHERE lote_id = ?', loteId);
    return {
      lote: {
        id: lote.id, codigo: lote.codigo, centro: lote.centro, estado: lote.estado, numero_ciclo: lote.numero_ciclo,
        fecha_inicio: lote.fecha_inicio, fecha_dia_73: lote.fecha_fin_prevista, aves_iniciales: iniciales,
        costo_total: lote.costo_total, costo_unitario: lote.costo_unitario, kg_producidos: lote.kg_producidos,
      },
      mortalidad: {
        acumulada: bit.muertas,
        pct: iniciales ? r2((100 * bit.muertas) / iniciales) : null,
        normal, anormal: bit.muertas - normal,
        clasificacion: bit.muertas - normal > 0 ? 'ANORMAL' : 'NORMAL',
        tolerancia_5pct: maxNormal,
      },
      alimento_consumido_kg: r2(bit.alimento_kg),
      bitacora: { dias_registrados: bit.dias_registrados, ultimo_dia: bit.ultimo_dia },
      aves_vivas_esperadas: iniciales - bit.muertas,
      costos,
      costo_total_acumulado: r2(costos.reduce((s, c) => s + c.monto, 0)),
      faenado: faenado || null,
    };
  }

  function vistaCierre(ctx, req, url, [id]) {
    exigir(ctx, 'costos.ver');
    return resumenLote(Number(id));
  }

  /** Lotes ABIERTOS y lotes con faenado pendiente de aprobación (para los selectores). */
  function lotesParaCierre(ctx) {
    exigir(ctx, 'lotes.ver');
    return all(
      `SELECT l.id, l.codigo, l.estado, l.fecha_inicio, l.fecha_fin_prevista AS fecha_dia_73, l.aves_iniciales,
              f.estado AS estado_faenado
       FROM lotes l LEFT JOIN lote_faenado f ON f.lote_id = l.id
       WHERE l.estado = 'ABIERTO' ORDER BY l.id DESC`);
  }

  /** Paso 5-6 de PR-FIN-04 y paso 6 de PR-FIN-06: registra el faenado y PREPARA el asiento de cierre (queda en borrador hasta la GG). */
  function faenadoCore(ctx, loteId, b) {
    exigir(ctx, 'lotes.cerrar');
    const res = resumenLote(loteId);
    const lote = res.lote;

    if (lote.estado !== 'ABIERTO') throw new HttpError(409, 'El lote no está ABIERTO');
    if (res.faenado) throw new HttpError(409, 'Este lote ya tiene un faenado registrado. Descártelo para volver a registrarlo.');
    if (!FECHA.test(b.fecha_faenado || '')) throw new HttpError(400, 'Fecha de faenado inválida (AAAA-MM-DD)');
    if (b.fecha_faenado !== lote.fecha_dia_73) {
      throw new HttpError(400, `El faenado y el corte de costos se registran el día 73 del ciclo (${lote.fecha_dia_73}). Fecha ingresada: ${b.fecha_faenado}.`);
    }

    const aves = num(b.aves_faenadas, 'Aves faenadas');
    const pesoVivo = r2(num(b.peso_vivo_kg, 'Peso vivo (kg)'));
    const pesoCanal = r2(num(b.peso_canal_kg, 'Peso canal (kg)'));
    if (!Number.isInteger(aves) || aves < 0) throw new HttpError(400, 'Aves faenadas: entero mayor o igual a cero');
    if (pesoVivo <= 0 || pesoCanal <= 0) throw new HttpError(400, 'Los pesos deben ser mayores a cero');
    if (pesoCanal > pesoVivo) throw new HttpError(400, 'El peso canal no puede superar el peso vivo');

    // FIN-TRA-06: Aves ingresadas = Mortalidad normal + Mortalidad anormal + Aves faenadas
    const m = res.mortalidad;
    if (lote.aves_iniciales !== m.normal + m.anormal + aves) {
      throw new HttpError(400,
        `Conciliación de aves (FIN-TRA-06): ingresadas ${lote.aves_iniciales} ≠ mortalidad ${m.acumulada} + faenadas ${aves}. ` +
        `Verifique el conteo físico y la bitácora diaria (se esperan ${res.aves_vivas_esperadas} aves faenadas).`);
    }
    const informe = (b.informe_veterinario || '').trim();
    if (m.anormal > 0 && !informe) {
      throw new HttpError(400, `La mortalidad acumulada (${m.pct} %) supera el 5 %: la baja anormal exige informe veterinario (Anexo 7).`);
    }

    const total = r2(res.costo_total_acumulado);
    if (!(total > 0)) throw new HttpError(409, 'El centro de costo del lote no tiene costos acumulados que transferir');

    return tx(() => {
      const centroId = get('SELECT id FROM centros_costo WHERE codigo = ?', lote.centro).id;
      // Asiento de cierre (MAN-01 §8.1): Débito 1.1.03.12 / Crédito 6.1.01.01 por el total acumulado, sufijo por sufijo,
      // para que cada sufijo del lote quede en saldo cero.
      const lineas = [{ cuenta_id: cuentaId(CUENTAS.INVENTARIO_CARNE), debe: total, centro_id: centroId, lote_id: loteId }];
      for (const c of res.costos) {
        if (c.monto === 0) continue;
        const sufijoId = get('SELECT id FROM sufijos_costo WHERE codigo = ?', c.sufijo).id;
        lineas.push({
          cuenta_id: cuentaId(CUENTAS.CENTRO_CARNE), centro_id: centroId, sufijo_id: sufijoId, lote_id: loteId,
          haber: c.monto > 0 ? c.monto : 0, debe: c.monto < 0 ? -c.monto : 0,
        });
      }
      const asiento = crearAsiento({
        fecha: b.fecha_faenado, tipo: 'CIERRE_CICLO', usuarioId: ctx.usuarioId, lineas, contabilizar: false,
        glosa: `Cierre del ciclo ${lote.codigo}: transferencia del centro de costos 6.1.01.01 a Inventario de Carne de Pollo`,
        documento: 'FIN-TRA-05 / FIN-TRA-06',
      });
      run(
        `INSERT INTO lote_faenado (lote_id, fecha_faenado, aves_ingresadas, mortalidad_normal, mortalidad_anormal, aves_faenadas,
           peso_vivo_kg, peso_canal_kg, merma_kg, alimento_consumido_kg, informe_veterinario, costo_total, asiento_cierre_id, registrado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        loteId, b.fecha_faenado, lote.aves_iniciales, m.normal, m.anormal, aves, pesoVivo, pesoCanal, r2(pesoVivo - pesoCanal),
        res.alimento_consumido_kg, informe || null, total, asiento.id, ctx.usuarioId);
      return {
        mensaje: 'Faenado registrado. El cierre queda pendiente de aprobación de la Gerencia General.',
        asiento_numero: asiento.numero, asiento_id: asiento.id, costo_total: total,
        advertencia: m.anormal > 0
          ? 'Mortalidad anormal: la baja a gasto no operativo (7.2.01.04, FICHA-FIN-05) no forma parte de esta fase; regístrela antes de que la Gerencia General apruebe el cierre.'
          : null,
      };
    });
  }

  const registrarFaenado = async (ctx, req, url, [id]) => faenadoCore(ctx, Number(id), await leerJson(req));

  function descartarFaenado(ctx, req, url, [id]) {
    exigir(ctx, 'lotes.cerrar');
    const f = get('SELECT id, estado, asiento_cierre_id FROM lote_faenado WHERE lote_id = ?', Number(id));
    if (!f) throw new HttpError(404, 'El lote no tiene faenado registrado');
    if (f.estado !== 'PENDIENTE_APROBACION') throw new HttpError(409, 'Un faenado aprobado no se puede descartar');
    tx(() => {
      run('DELETE FROM lote_faenado WHERE id = ?', f.id);
      run('DELETE FROM asiento_detalle WHERE asiento_id = ?', f.asiento_cierre_id);   // el asiento sigue en BORRADOR: sus líneas se pueden borrar
      run('DELETE FROM asientos WHERE id = ?', f.asiento_cierre_id);
    });
    return { mensaje: 'Faenado descartado; el lote sigue abierto.' };
  }

  /** Visto Bueno de Cierre de Ciclo (PR-FIN-06 paso 5): la GG autoriza el asiento, se contabiliza y el lote queda CERRADO. */
  function aprobarCierre(ctx, req, url, [id]) {
    exigir(ctx, 'lotes.aprobar_cierre');
    const loteId = Number(id);
    const f = get('SELECT * FROM lote_faenado WHERE lote_id = ?', loteId);
    if (!f) throw new HttpError(404, 'El lote no tiene faenado registrado');
    if (f.estado !== 'PENDIENTE_APROBACION') throw new HttpError(409, 'El cierre ya fue aprobado');
    const vigente = resumenLote(loteId);
    if (r2(vigente.costo_total_acumulado) !== r2(f.costo_total)) {
      throw new HttpError(409, `Los costos del lote cambiaron después de preparar el cierre (${vigente.costo_total_acumulado} ≠ ${f.costo_total}). Descarte y vuelva a registrar el faenado.`);
    }
    const costoUnitario = Math.round((f.costo_total / f.peso_canal_kg) * 10000) / 10000;   // FIN-TRA-07: Bs por kg de producto terminado
    const anterior = get(
      `SELECT codigo, costo_unitario FROM lotes WHERE centro_costo_id = (SELECT centro_costo_id FROM lotes WHERE id = ?)
         AND estado = 'CERRADO' AND id <> ? ORDER BY fecha_cierre DESC, id DESC LIMIT 1`, loteId, loteId);

    tx(() => {
      run(`UPDATE asientos SET autorizado_por = ?, autorizado_en = CURRENT_TIMESTAMP, estado = 'CONTABILIZADO', contabilizado_en = CURRENT_TIMESTAMP WHERE id = ?`,
        ctx.usuarioId, f.asiento_cierre_id);
      run(`UPDATE lote_faenado SET estado = 'APROBADO', aprobado_por = ?, aprobado_en = CURRENT_TIMESTAMP WHERE id = ?`, ctx.usuarioId, f.id);
      run(`UPDATE lotes SET estado = 'CERRADO', fecha_cierre = ?, aves_faenadas = ?, kg_producidos = ?, costo_total = ?, costo_unitario = ?, asiento_cierre_id = ? WHERE id = ?`,
        f.fecha_faenado, f.aves_faenadas, f.peso_canal_kg, f.costo_total, costoUnitario, f.asiento_cierre_id, loteId);
    });
    return {
      mensaje: 'Cierre de ciclo aprobado: el costo pasó a Inventario de Carne de Pollo y el centro de costos quedó en cero.',
      costo_total: f.costo_total, kg_producto_terminado: f.peso_canal_kg, costo_unitario_bs_kg: costoUnitario,
      ciclo_anterior: anterior ? { lote: anterior.codigo, costo_unitario_bs_kg: anterior.costo_unitario } : null,
      variacion_pct: anterior && anterior.costo_unitario ? r2(((costoUnitario - anterior.costo_unitario) / anterior.costo_unitario) * 100) : null,
    };
  }

  // ===========================================================================================
  // 2) VENTAS HORECA Y AL CONTADO
  // ===========================================================================================

  function listarClientes(ctx) {
    exigir(ctx, 'ventas.ver');
    return all('SELECT id, nombre, tipo, documento FROM clientes WHERE activo = 1 ORDER BY nombre');
  }

  async function crearCliente(ctx, req) {
    exigir(ctx, 'ventas.registrar');
    const b = await leerJson(req);
    const nombre = String(b.nombre || '').trim();
    if (!nombre) throw new HttpError(400, 'El nombre del cliente es obligatorio');
    if (!['HORECA', 'FRIAL', 'MERCADO_POPULAR', 'CONSUMIDOR', 'AGRICULTOR'].includes(b.tipo)) throw new HttpError(400, 'Tipo de cliente inválido');
    const { lastInsertRowid } = run('INSERT INTO clientes (nombre, tipo, documento) VALUES (?, ?, ?)', nombre, b.tipo, b.documento || null);
    return { id: lastInsertRowid };
  }

  /** Stock de carne por lote cerrado: kg producto terminado − kg vendidos. */
  function stockCarne() {
    return all(
      `SELECT l.id AS lote_id, l.codigo, l.costo_unitario, f.peso_canal_kg,
              ROUND(f.peso_canal_kg - COALESCE((SELECT SUM(v.cantidad) FROM ventas v WHERE v.lote_id = l.id AND v.producto = 'CARNE'), 0), 2) AS kg_disponibles
       FROM lotes l JOIN lote_faenado f ON f.lote_id = l.id
       WHERE l.estado = 'CERRADO' AND f.estado = 'APROBADO' ORDER BY l.id DESC`);
  }
  function stock(ctx) {
    exigir(ctx, 'ventas.ver');
    return stockCarne();
  }

  function listarVentas(ctx) {
    exigir(ctx, 'ventas.ver');
    const hoyIso = hoy();
    return all(
      `SELECT v.id, v.fecha, c.nombre AS cliente, c.tipo AS cliente_tipo, v.producto, l.codigo AS lote, v.cantidad, v.unidad,
              v.precio_unitario, v.total, v.costo_venta, v.condicion, v.plazo_dias, v.fecha_vencimiento, v.medio_pago,
              v.comprobante, v.estado, v.fecha_cobro, a.numero AS asiento_numero, v.asiento_id, v.asiento_cobro_id
       FROM ventas v JOIN clientes c ON c.id = v.cliente_id LEFT JOIN lotes l ON l.id = v.lote_id JOIN asientos a ON a.id = v.asiento_id
       ORDER BY v.fecha DESC, v.id DESC`)
      .map((v) => ({ ...v, vencida: v.estado === 'PENDIENTE' && v.fecha_vencimiento < hoyIso }));
  }

  /** PR-FIN-08 / PR-FIN-09 / POL-05. Genera el asiento de ingreso (+ cuenta por cobrar o caja/banco) y el costo de ventas. */
  function ventaCore(ctx, b) {
    exigir(ctx, 'ventas.registrar');

    if (!FECHA.test(b.fecha || '')) throw new HttpError(400, 'Fecha inválida (AAAA-MM-DD)');
    const cliente = get('SELECT id, nombre, tipo FROM clientes WHERE id = ? AND activo = 1', Number(b.cliente_id));
    if (!cliente) throw new HttpError(400, 'Seleccione un cliente');
    if (!['CARNE', 'GALLINAZA', 'ALIMENTO'].includes(b.producto)) throw new HttpError(400, 'Producto inválido');
    if (b.producto === 'ALIMENTO') throw new HttpError(400, 'La venta de alimento balanceado excedente está disponible desde 2027 (Plan de Cuentas 5.1.02.01).');
    const cantidad = r2(num(b.cantidad, 'Cantidad'));
    const precio = num(b.precio_unitario, 'Precio unitario');
    if (cantidad <= 0 || precio <= 0) throw new HttpError(400, 'Cantidad y precio deben ser mayores a cero');
    const unidad = b.producto === 'CARNE' ? 'KG' : (['KG', 'QQ'].includes(b.unidad) ? b.unidad : 'KG');
    const comprobante = String(b.comprobante || '').trim();
    // POL-05 Art. 1: prohibido entregar sin constancia documentada; no se da de alta el ingreso sin comprobante.
    if (!comprobante) throw new HttpError(400, 'POL-05: no se registra la venta sin comprobante (nota de entrega o comprobante de pago).');

    const condicion = b.condicion === 'CREDITO' ? 'CREDITO' : 'CONTADO';
    let plazo = 0, vencimiento = null, medio = null;
    if (condicion === 'CREDITO') {
      if (cliente.tipo !== 'HORECA') throw new HttpError(400, 'POL-05 Art. 1: solo los clientes del sector HORECA pueden comprar a crédito; los demás compran al contado.');
      if (b.fecha >= '2028-01-01') throw new HttpError(400, 'POL-05 Art. 2: el crédito desde 2028 requiere resolución escrita de la Gerencia General (no incluido en esta fase).');
      if (!b.compromiso_pago_firmado) throw new HttpError(400, 'POL-05 Art. 1: el crédito HORECA exige comprobante de entrega y compromiso de pago firmado por el comprador.');
      plazo = 1;   // 2026-2027: máximo 1 día calendario desde la entrega
      vencimiento = get(`SELECT date(?, '+1 day') AS d`, b.fecha).d;
    } else {
      medio = b.medio_pago;
      if (!MEDIOS_PAGO.includes(medio)) throw new HttpError(400, 'Venta al contado: indique el medio de pago (efectivo, transferencia, depósito, cheque nominativo o QR/ACH). No se aceptan cheques diferidos.');
    }

    const total = r2(cantidad * precio);
    return tx(() => {
      let costo = 0, loteId = null, centroId = null;
      const lineas = [];
      const debito = condicion === 'CREDITO' ? cuentaId(CUENTAS.CXC) : cuentaDeCobro(medio);

      if (b.producto === 'CARNE') {
        loteId = Number(b.lote_id);
        const s = stockCarne().find((x) => x.lote_id === loteId);
        if (!s) throw new HttpError(400, 'Seleccione un lote con carne en inventario (cierre aprobado).');
        if (cantidad > s.kg_disponibles) throw new HttpError(400, `Stock insuficiente: el lote ${s.codigo} tiene ${s.kg_disponibles} kg disponibles.`);
        centroId = get('SELECT centro_costo_id AS id FROM lotes WHERE id = ?', loteId).id;
        costo = r2(cantidad * s.costo_unitario);                        // costo del lote × kg vendidos
        lineas.push({ cuenta_id: debito, debe: total });
        lineas.push({ cuenta_id: cuentaId(CUENTAS.VENTA_CARNE), haber: total });
        lineas.push({ cuenta_id: cuentaId(CUENTAS.COSTO_VENTA_CARNE), debe: costo, centro_id: centroId, lote_id: loteId });
        lineas.push({ cuenta_id: cuentaId(CUENTAS.INVENTARIO_CARNE), haber: costo, centro_id: centroId, lote_id: loteId });
      } else {
        // Gallinaza: ingreso no operativo sin costo de producción imputado (MAN-01 §6.1)
        lineas.push({ cuenta_id: debito, debe: total });
        lineas.push({ cuenta_id: cuentaId(CUENTAS.VENTA_GALLINAZA), haber: total });
      }

      const asiento = crearAsiento({
        fecha: b.fecha, tipo: 'DIARIO', usuarioId: ctx.usuarioId, lineas, contabilizar: true,
        glosa: `Venta de ${b.producto === 'CARNE' ? 'carne de pollo' : 'gallinaza'} a ${cliente.nombre} (${condicion === 'CREDITO' ? 'crédito 1 día' : 'contado'})`,
        documento: comprobante,
      });
      const { lastInsertRowid } = run(
        `INSERT INTO ventas (fecha, cliente_id, producto, lote_id, cantidad, unidad, precio_unitario, total, costo_venta, condicion, plazo_dias,
           fecha_vencimiento, medio_pago, comprobante, compromiso_pago_firmado, estado, asiento_id, registrado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        b.fecha, cliente.id, b.producto, loteId, cantidad, unidad, precio, total, costo, condicion, plazo, vencimiento, medio, comprobante,
        condicion === 'CREDITO' ? 1 : 0, condicion === 'CREDITO' ? 'PENDIENTE' : 'COBRADA', asiento.id, ctx.usuarioId);
      return {
        id: lastInsertRowid, total, costo_venta: costo, asiento_numero: asiento.numero,
        estado: condicion === 'CREDITO' ? 'PENDIENTE' : 'COBRADA', fecha_vencimiento: vencimiento,
      };
    });
  }

  const registrarVenta = async (ctx, req) => ventaCore(ctx, await leerJson(req));

  /** Cobranza de una venta HORECA a crédito: Débito Caja/Banco / Crédito Cuentas por Cobrar. */
  function cobroCore(ctx, ventaId, b) {
    exigir(ctx, 'ventas.registrar');
    const v = get('SELECT * FROM ventas WHERE id = ?', Number(ventaId));
    if (!v) throw new HttpError(404, 'Venta no encontrada');
    if (v.estado !== 'PENDIENTE') throw new HttpError(409, 'La venta ya fue cobrada');
    const fecha = b.fecha || hoy();
    if (!FECHA.test(fecha)) throw new HttpError(400, 'Fecha inválida (AAAA-MM-DD)');
    if (fecha < v.fecha) throw new HttpError(400, 'La fecha de cobro no puede ser anterior a la venta');
    if (!MEDIOS_PAGO.includes(b.medio_cobro)) throw new HttpError(400, 'Medio de cobro inválido. No se aceptan cheques diferidos.');
    return tx(() => {
      const asiento = crearAsiento({
        fecha, tipo: 'DIARIO', usuarioId: ctx.usuarioId, contabilizar: true, documento: b.comprobante_ingreso || null,
        glosa: `Cobro de venta N° ${v.id} (${v.comprobante})`,
        lineas: [{ cuenta_id: cuentaDeCobro(b.medio_cobro), debe: v.total }, { cuenta_id: cuentaId(CUENTAS.CXC), haber: v.total }],
      });
      run(`UPDATE ventas SET estado = 'COBRADA', fecha_cobro = ?, medio_cobro = ?, asiento_cobro_id = ? WHERE id = ?`, fecha, b.medio_cobro, asiento.id, v.id);
      return { mensaje: 'Cobro registrado', asiento_numero: asiento.numero, cobrada_con_retraso: fecha > v.fecha_vencimiento };
    });
  }

  const cobrarVenta = async (ctx, req, url, [id]) => cobroCore(ctx, Number(id), await leerJson(req));

  // ===========================================================================================
  // Datos de demostración de la Fase 4 (solo si la base es la de demo y aún no hay clientes)
  // ===========================================================================================
  function sembrarDemo() {
    if (get('SELECT COUNT(*) AS n FROM clientes').n > 0) return;
    const jf = get(`SELECT id FROM usuarios WHERE username = 'demo_jf'`);
    const gg = get(`SELECT id FROM usuarios WHERE username = 'demo_gg'`);
    const ut = get(`SELECT id FROM usuarios WHERE username = 'demo_ut'`);
    if (!jf || !gg || !ut) return;
    const ctxJF = { usuarioId: jf.id, permisos: new Set(['lotes.cerrar', 'ventas.registrar']) };
    const ctxGG = { usuarioId: gg.id, permisos: new Set(['lotes.aprobar_cierre']) };

    tx(() => {
      for (const [nombre, tipo] of [['Hotel Yungas Palace', 'HORECA'], ['Restaurante El Fogón', 'HORECA'], ['Frial Caranavi Centro', 'FRIAL'],
        ['Mercado Popular de Caranavi', 'MERCADO_POPULAR'], ['Agricultores de la zona', 'AGRICULTOR']]) {
        run('INSERT INTO clientes (nombre, tipo) VALUES (?, ?)', nombre, tipo);
      }
      // Aporte adicional para financiar el segundo lote de la demo
      crearAsiento({
        fecha: '2026-07-02', tipo: 'DIARIO', usuarioId: jf.id, contabilizar: true, glosa: 'Aportes adicionales de socios', documento: 'Acta de asamblea',
        lineas: [{ cuenta_id: cuentaId(CUENTAS.BANCO), debe: 150000 }, { cuenta_id: cuentaId('3.1.01.05'), haber: 150000 }],
      });
      // Lote de ejemplo ya faenado: costos del Manual de Costos §5 (ciclo de 3.000 aves, 2026), registrados por sufijo.
      const centro = get(`SELECT id FROM centros_costo WHERE codigo = 'CC-01'`).id;
      const ej = ejercicioAbierto();
      const ciclo = get('SELECT COALESCE(MAX(numero_ciclo), 0) + 1 AS n FROM lotes WHERE centro_costo_id = ? AND ejercicio_id = ?', centro, ej.id).n;
      const { lastInsertRowid: loteId } = run(
        `INSERT INTO lotes (codigo, centro_costo_id, ejercicio_id, numero_ciclo, fecha_inicio, fecha_fin_prevista, aves_iniciales, responsable_id)
         VALUES (?, ?, ?, ?, '2026-07-03', date('2026-07-03', '+72 days'), 3000, ?)`,
        `L-CC01-${ej.codigo}-${String(ciclo).padStart(2, '0')}`, centro, ej.id, ciclo, ut.id);
      run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 73)
           INSERT INTO lote_bitacora (lote_id, fecha, dia_ciclo, alimento_kg, mortalidad, registrado_por)
           SELECT ?, date('2026-07-03', '+' || (i - 1) || ' days'), i, 201.4, CASE WHEN i <= 17 THEN 2 ELSE 1 END, ? FROM n`, loteId, ut.id);
      const costos = [['01', 27000], ['02', 55500], ['08', 5895], ['09', 780], ['10', 2910], ['12', 4800],
        ['20', 7920], ['21', 660], ['22', 4500], ['38', 1363.03], ['39', 660],
        ['30', 1050], ['31', 986.25], ['32', 300], ['33', 162], ['36', 1500], ['37', 300]];
      const lineas = costos.map(([s, monto]) => ({ cuenta_id: cuentaId(CUENTAS.CENTRO_CARNE), debe: monto, centro_id: centro, lote_id: loteId,
        sufijo_id: get('SELECT id FROM sufijos_costo WHERE codigo = ?', s).id }));
      lineas.push({ cuenta_id: cuentaId(CUENTAS.BANCO), haber: r2(costos.reduce((t, c) => t + c[1], 0)) });
      crearAsiento({ fecha: '2026-07-10', tipo: 'DIARIO', usuarioId: jf.id, contabilizar: true, lineas, documento: 'Hoja de costos MAN-01 §5',
        glosa: 'Costos acumulados del ciclo (referencia del Manual de Costos, 3.000 aves)' });
    });
    // Faenado y cierre por los mismos controladores que usa la interfaz
    const lote = get(`SELECT id, fecha_fin_prevista FROM lotes WHERE estado = 'ABIERTO' AND aves_iniciales = 3000 AND fecha_inicio = '2026-07-03'`);
    faenadoCore(ctxJF, lote.id, { fecha_faenado: lote.fecha_fin_prevista, aves_faenadas: 2910, peso_vivo_kg: 7566, peso_canal_kg: 6960 });
    aprobarCierre(ctxGG, null, null, [lote.id]);
    // Ventas de ejemplo: contado, crédito HORECA de 1 día (una pendiente) y gallinaza
    const cli = (n) => get('SELECT id FROM clientes WHERE nombre = ?', n).id;
    const venta = (o) => ventaCore(ctxJF, { condicion: 'CONTADO', medio_pago: 'EFECTIVO', ...o });
    venta({ fecha: '2026-09-14', cliente_id: cli('Mercado Popular de Caranavi'), producto: 'CARNE', lote_id: lote.id, cantidad: 2400, precio_unitario: 26, comprobante: 'NE-0001' });
    venta({ fecha: '2026-09-14', cliente_id: cli('Frial Caranavi Centro'), producto: 'CARNE', lote_id: lote.id, cantidad: 2100, precio_unitario: 26, medio_pago: 'TRANSFERENCIA', comprobante: 'NE-0002' });
    const v3 = venta({ fecha: '2026-09-14', cliente_id: cli('Hotel Yungas Palace'), producto: 'CARNE', lote_id: lote.id, cantidad: 1500, precio_unitario: 26, condicion: 'CREDITO', compromiso_pago_firmado: true, comprobante: 'NE-0003' });
    venta({ fecha: '2026-09-15', cliente_id: cli('Agricultores de la zona'), producto: 'GALLINAZA', cantidad: 7500, unidad: 'KG', precio_unitario: 1, medio_pago: 'EFECTIVO', comprobante: 'CP-0001' });
    // Un crédito HORECA ya vencido y sin cobrar: permite ver el aviso de cuentas vencidas
    venta({ fecha: '2026-09-16', cliente_id: cli('Restaurante El Fogón'), producto: 'CARNE', lote_id: lote.id, cantidad: 500, precio_unitario: 26, condicion: 'CREDITO', compromiso_pago_firmado: true, comprobante: 'NE-0004' });
    // El crédito del hotel sí se cobra al día siguiente
    cobroCore(ctxJF, v3.id, { fecha: '2026-09-15', medio_cobro: 'TRANSFERENCIA' });
  }

  return {
    vistaCierre, lotesParaCierre, registrarFaenado, descartarFaenado, aprobarCierre,
    listarClientes, crearCliente, stock, listarVentas, registrarVenta, cobrarVenta, sembrarDemo,
  };
};
