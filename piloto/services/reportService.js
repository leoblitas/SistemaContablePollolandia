'use strict';
/**
 * services/reportService.js
 * -----------------------------------------------------------------------------
 * Lógica de la FASE 5 — Reportes y Auditoría Fiscal (Pollolandia Contable).
 *
 *  - Acceso abierto: no hay tokens, logins, contraseñas ni sesiones.
 *  - SOLO LECTURA: no modifica schema.sql ni escribe en ninguna tabla.
 *  - Sin invención: nombres de cuentas y estructura del Estado de Resultados salen del
 *    Plan de Cuentas cargado en la tabla `cuentas` y del modelo MAN-006 §18.2; las reglas
 *    RAU, de PET-RAU-001 (DS 24463 Arts. 4 y 7). No se agrega ningún impuesto ajeno al RAU.
 *  - Requiere una conexión better-sqlite3.
 */
const Q = require('../queries/reportQueries');

class ReportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ReportError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const money = (c) => (c || 0) / 100;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 10000) / 100 : null);

function esFecha(f) {
  if (typeof f !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

function fechaOpcional(valor, nombre) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (!esFecha(valor)) throw new ReportError(`${nombre} debe tener formato YYYY-MM-DD`);
  return valor;
}

function hoyLocal() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

function requerirDb(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('reportService: se requiere una conexión better-sqlite3.');
  }
}

/** Ejercicio indicado (ejercicio_id o ejercicio=código); por defecto el que contiene hoy o el más reciente. */
function resolverEjercicio(db, q = {}) {
  let e;
  if (q.ejercicio_id) e = db.prepare('SELECT * FROM ejercicios_fiscales WHERE id = ?').get(Number(q.ejercicio_id));
  else if (q.ejercicio) e = db.prepare('SELECT * FROM ejercicios_fiscales WHERE codigo = ?').get(String(q.ejercicio));
  else {
    e =
      db.prepare('SELECT * FROM ejercicios_fiscales WHERE ? BETWEEN fecha_inicio AND fecha_fin ORDER BY id LIMIT 1').get(hoyLocal()) ||
      db.prepare('SELECT * FROM ejercicios_fiscales ORDER BY fecha_inicio DESC LIMIT 1').get();
  }
  if (!e) throw new ReportError('No hay un ejercicio fiscal que consultar (tabla ejercicios_fiscales vacía o inexistente)', 404);
  return e;
}

// ---------------------------------------------------------------------------
// Catálogos para los filtros de la vista web
// ---------------------------------------------------------------------------
function catalogos(db) {
  requerirDb(db);
  return {
    ejercicios: db.prepare(Q.EJERCICIOS).all(),
    cuentas: db.prepare(Q.CUENTAS_TODOS_LOS_NIVELES).all(),
    lotes: db.prepare(Q.LOTES).all(),
  };
}

// ---------------------------------------------------------------------------
// 1a) LIBRO MAYOR — formato MA-04 (MAN-006 §22.1)
// ---------------------------------------------------------------------------
function libroMayor(db, q = {}) {
  requerirDb(db);
  const cod = String(q.cuenta ?? '').trim();
  if (!/^\d(\.\d{1,2}){0,3}$/.test(cod)) {
    throw new ReportError('cuenta es obligatoria: código de nivel 1 a 4 (ej. 1, 1.1, 1.1.03 o 1.1.03.01)');
  }
  const cuenta = db.prepare(Q.CUENTA_POR_CODIGO).get(cod);
  if (!cuenta) throw new ReportError(`La cuenta ${cod} no existe en el Plan de Cuentas`, 404);

  const ej = resolverEjercicio(db, q);
  const desde = fechaOpcional(q.desde, 'desde') || ej.fecha_inicio;
  const hasta = fechaOpcional(q.hasta, 'hasta') || ej.fecha_fin;
  if (desde > hasta) throw new ReportError('desde no puede ser posterior a hasta');

  const filas = db.prepare(Q.LIBRO_MAYOR).all({ ej: ej.id, hasta, cod, pref: `${cod}.%` });

  const porCuenta = new Map();
  for (const f of filas) {
    if (!porCuenta.has(f.cuenta_codigo)) {
      porCuenta.set(f.cuenta_codigo, {
        codigo: f.cuenta_codigo, nombre: f.cuenta_nombre, naturaleza: f.naturaleza,
        previos: [], periodo: [],
      });
    }
    (f.fecha < desde ? porCuenta.get(f.cuenta_codigo).previos : porCuenta.get(f.cuenta_codigo).periodo).push(f);
  }

  const LIMITE = 5000;
  let truncado = false;
  let totalDebe = 0;
  let totalHaber = 0;
  const cuentas = [...porCuenta.values()].map((c) => {
    const saldoAnterior = c.previos.length ? c.previos[c.previos.length - 1].saldo_c : 0;
    const sumaDebe = c.periodo.reduce((a, f) => a + f.debe_c, 0);
    const sumaHaber = c.periodo.reduce((a, f) => a + f.haber_c, 0);
    totalDebe += sumaDebe;
    totalHaber += sumaHaber;
    const da = (s) => (s > 0 ? 'D' : s < 0 ? 'A' : '');
    let movimientos = c.periodo.map((f) => ({
      fecha: f.fecha,
      comprobante: f.comprobante,
      asiento_id: f.asiento_id,
      tipo: f.tipo,
      estado: f.estado,
      auxiliar: [f.centro_costo, f.sufijo, f.lote].filter(Boolean).join(' · ') || null,
      glosa: f.glosa_linea || f.glosa_asiento,
      doc_ref: f.documento_respaldo,
      debe: money(f.debe_c),
      haber: money(f.haber_c),
      saldo: money(Math.abs(f.saldo_c)),
      da: da(f.saldo_c),
    }));
    if (movimientos.length > LIMITE) { movimientos = movimientos.slice(0, LIMITE); truncado = true; }
    const saldoFinal = saldoAnterior + sumaDebe - sumaHaber;
    return {
      codigo: c.codigo, nombre: c.nombre, naturaleza: c.naturaleza,
      saldo_anterior: money(Math.abs(saldoAnterior)), saldo_anterior_da: da(saldoAnterior),
      movimientos,
      suma_debe: money(sumaDebe), suma_haber: money(sumaHaber),
      saldo_final: money(Math.abs(saldoFinal)), saldo_final_da: da(saldoFinal),
    };
  });

  return {
    formato: 'MA-04 — Registro de Mayor Analítico de Cuenta (MAN-006 §22.1)',
    filtro: { cuenta: cuenta.codigo, nombre: cuenta.nombre, nivel: cuenta.nivel, desde, hasta, ejercicio: ej.codigo },
    cuentas,
    totales: { suma_debe: money(totalDebe), suma_haber: money(totalHaber) },
    truncado,
    nota: 'Incluye asientos CONTABILIZADOS y ANULADOS (estos últimos junto a su contrapartida de anulación). Saldo corrido desde la apertura del ejercicio.',
  };
}

// ---------------------------------------------------------------------------
// 1b) BALANCE DE COMPROBACIÓN DE SUMAS Y SALDOS — formato BS-05 (MAN-006 §22.3)
// ---------------------------------------------------------------------------
const LARGO_POR_NIVEL = { 1: 1, 2: 3, 3: 6, 4: 9 };

function balanceComprobacion(db, q = {}) {
  requerirDb(db);
  const nivel = q.nivel ? Number(q.nivel) : 4;
  if (!LARGO_POR_NIVEL[nivel]) throw new ReportError('nivel debe ser 1, 2, 3 o 4');
  const ej = resolverEjercicio(db, q);
  const desde = fechaOpcional(q.desde, 'desde') || ej.fecha_inicio;
  const hasta = fechaOpcional(q.hasta, 'hasta') || ej.fecha_fin;
  if (desde > hasta) throw new ReportError('desde no puede ser posterior a hasta');
  const antes = ['1', 'true', 'si', 'sí'].includes(String(q.antes_de_ajustes ?? '').toLowerCase()) ? 1 : 0;

  const filas = db.prepare(Q.BALANCE_COMPROBACION).all({ ej: ej.id, desde, hasta, len: LARGO_POR_NIVEL[nivel], antes });

  let sD = 0, sH = 0, dD = 0, dA = 0;
  const cuentas = filas.map((f, i) => {
    const neto = f.debe_c - f.haber_c;
    const deudor = neto > 0 ? neto : 0;
    const acreedor = neto < 0 ? -neto : 0;
    sD += f.debe_c; sH += f.haber_c; dD += deudor; dA += acreedor;
    return {
      n: i + 1, codigo: f.codigo, nombre: f.nombre,
      debe: money(f.debe_c), haber: money(f.haber_c), deudor: money(deudor), acreedor: money(acreedor),
    };
  });

  return {
    formato: 'BS-05 — Balance de Comprobación de Sumas y Saldos (MAN-006 §22.3)',
    filtro: { ejercicio: ej.codigo, desde, hasta, nivel, antes_de_ajustes: !!antes },
    cuentas,
    totales: { debe: money(sD), haber: money(sH), deudor: money(dD), acreedor: money(dA) },
    verificacion: {
      sumas_debe_igual_haber: sD === sH,
      saldos_deudores_igual_acreedores: dD === dA,
      diferencia_sumas: money(Math.abs(sD - sH)),
      diferencia_saldos: money(Math.abs(dD - dA)),
    },
  };
}

// ---------------------------------------------------------------------------
// 2) ESTADO DE RESULTADOS — modelo MAN-006 §18.2 / PC-08 §D (escalonado)
//    consolidado (por ejercicio y rango de fechas) o por lote de 73 días
// ---------------------------------------------------------------------------
function estadoResultados(db, q = {}) {
  requerirDb(db);
  let lote = null;
  if (q.lote !== undefined && q.lote !== null && q.lote !== '' && q.lote !== 'consolidado') {
    lote = db.prepare(Q.LOTE_POR_ID_O_CODIGO).get({ id: /^\d+$/.test(String(q.lote)) ? Number(q.lote) : -1, codigo: String(q.lote) });
    if (!lote) throw new ReportError(`El lote "${q.lote}" no existe`, 404);
  }

  // Consolidado: ejercicio + fechas (por defecto el ejercicio completo).
  // Por lote: todas las líneas imputadas al lote, salvo que se pidan fechas explícitas.
  let ej = null;
  let desde = fechaOpcional(q.desde, 'desde');
  let hasta = fechaOpcional(q.hasta, 'hasta');
  if (!lote) {
    ej = resolverEjercicio(db, q);
    desde = desde || ej.fecha_inicio;
    hasta = hasta || ej.fecha_fin;
  }
  if (desde && hasta && desde > hasta) throw new ReportError('desde no puede ser posterior a hasta');

  const cuentasPlan = db.prepare(Q.CUENTAS_DE_RESULTADO).all();
  const movs = new Map(
    db.prepare(Q.ESTADO_RESULTADOS_MOVIMIENTOS)
      .all({ ej: ej ? ej.id : null, desde, hasta, lote: lote ? lote.id : null })
      .map((m) => [m.codigo, m])
  );

  const nombreNivel3 = new Map(cuentasPlan.filter((c) => c.nivel === 3).map((c) => [c.codigo, c.nombre]));
  const hojas = cuentasPlan.filter((c) => c.nivel === 4);
  const saldoIngreso = (c) => { const m = movs.get(c) || { debe_c: 0, haber_c: 0 }; return m.haber_c - m.debe_c; };
  const saldoGasto = (c) => { const m = movs.get(c) || { debe_c: 0, haber_c: 0 }; return m.debe_c - m.haber_c; };

  const filas = [];
  const titulo = (texto, nivel = 0) => filas.push({ tipo: 'titulo', texto, sangria: nivel });
  const cuentaFila = (c, monto, sangria = 2) => filas.push({ tipo: 'cuenta', codigo: c.codigo, texto: c.nombre, monto: money(monto), sangria });
  const total = (texto, monto, destacado = false) => filas.push({ tipo: destacado ? 'resultado' : 'subtotal', texto, monto: money(monto), sangria: 0 });

  // INGRESOS OPERATIVOS (5.1): ventas menos devoluciones (reguladora deudora 5.1.03)
  titulo('INGRESOS'); titulo('Ingresos operativos', 1);
  let ingresosOp = 0;
  hojas.filter((c) => c.codigo.startsWith('5.1.01.') || c.codigo.startsWith('5.1.02.')).forEach((c) => {
    const m = saldoIngreso(c.codigo); ingresosOp += m; cuentaFila(c, m);
  });
  hojas.filter((c) => c.codigo.startsWith('5.1.03.')).forEach((c) => {
    const m = -saldoGasto(c.codigo); ingresosOp += m; cuentaFila(c, m); // se muestra restando
  });
  total('Ingresos operativos totales', ingresosOp);

  // COSTO DE PRODUCCIÓN VENDIDA (6.1.02)
  titulo('Menos:'); titulo('COSTO DE PRODUCCIÓN VENDIDA'); titulo('Costo de ventas', 1);
  let costoVentas = 0;
  hojas.filter((c) => c.codigo.startsWith('6.1.02.')).forEach((c) => {
    const m = saldoGasto(c.codigo); costoVentas += m; cuentaFila(c, m);
  });
  total('Costo de ventas total', costoVentas);
  const utilidadBruta = ingresosOp - costoVentas;
  total('UTILIDAD BRUTA EN VENTAS', utilidadBruta, true);

  // GASTOS DE OPERACIÓN (7.1.01 a 7.1.05)
  titulo('Menos:'); titulo('GASTOS DE OPERACIÓN');
  let gastosOp = 0;
  [...new Set(hojas.filter((c) => c.codigo.startsWith('7.1.')).map((c) => c.codigo.slice(0, 6)))].forEach((g) => {
    titulo(nombreNivel3.get(g) || g, 1);
    hojas.filter((c) => c.codigo.startsWith(`${g}.`)).forEach((c) => {
      const m = saldoGasto(c.codigo); gastosOp += m; cuentaFila(c, m);
    });
  });
  total('Total gastos de operación', gastosOp);

  // GASTOS NO OPERATIVOS (7.2) — el modelo 18.2 los ubica antes del EBIT
  titulo('GASTOS NO OPERATIVOS');
  let gastosNoOp = 0;
  hojas.filter((c) => c.codigo.startsWith('7.2.')).forEach((c) => {
    const m = saldoGasto(c.codigo); gastosNoOp += m; cuentaFila(c, m);
  });
  total('Total gastos no operativos', gastosNoOp);

  const ebit = utilidadBruta - gastosOp - gastosNoOp;
  total('EXCEDENTE OPERATIVO (EBIT) / DÉFICIT OPERATIVO', ebit, true);

  // OTROS INGRESOS (5.2)
  titulo('Más:'); titulo('OTROS INGRESOS');
  let otros = 0;
  hojas.filter((c) => c.codigo.startsWith('5.2.')).forEach((c) => {
    const m = saldoIngreso(c.codigo); otros += m; cuentaFila(c, m);
  });
  total('Total otros ingresos', otros);

  const neto = ebit + otros;
  total('EXCEDENTE / DÉFICIT NETO DEL EJERCICIO', neto, true);

  const r = {
    formato: 'Estado de Resultados (Ganancias y Pérdidas) — MAN-006 §18.2 · PC-08 §D',
    vista: lote ? 'LOTE' : 'CONSOLIDADO',
    periodo: { ejercicio: ej ? ej.codigo : null, desde, hasta },
    lote: lote ? { id: lote.id, codigo: lote.codigo, centro_costo: lote.centro_costo, estado: lote.estado,
                   fecha_inicio: lote.fecha_inicio, fecha_fin_prevista: lote.fecha_fin_prevista } : null,
    filas,
    resumen: {
      ingresos_operativos: money(ingresosOp), costo_ventas: money(costoVentas), utilidad_bruta: money(utilidadBruta),
      gastos_operacion: money(gastosOp), gastos_no_operativos: money(gastosNoOp), ebit: money(ebit),
      otros_ingresos: money(otros), excedente_neto: money(neto),
    },
    notas: [
      'Excluye los asientos de CIERRE_EJERCICIO (regularizan los resultados contra 8.1.01.01).',
      'Incluye asientos CONTABILIZADOS y ANULADOS (estos se compensan con su asiento de anulación).',
    ],
  };
  if (lote) {
    r.memo_costo_en_proceso = {
      monto: db.prepare(Q.COSTO_EN_PROCESO_LOTE).get(lote.id).monto,
      texto: 'Costo acumulado del lote en el centro de costo 6.1.01.0X (activo transitorio). No es parte del resultado hasta que se vende: cierra al inventario (1.1.03.12/13) y pasa a 6.1.02.0X con la venta (MAN-01 §7.1; PC-08 §B).',
    };
    r.notas.push('La vista por lote incluye solo las líneas imputadas al lote (lote_id) en cuentas de ingresos, costo de ventas y gastos.');
  }
  return r;
}

// ---------------------------------------------------------------------------
// 3) AUDITORÍA Y BLINDAJE FISCAL RAU — PET-RAU-001 §1.1, §1.4 y §4.1 / POL-07
// ---------------------------------------------------------------------------
const normalizar = (t) =>
  String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Rótulos que revelan un servicio a terceros. Los dos primeros son los pedidos para este módulo;
 * los otros dos son los ejemplos que PET-RAU-001 §1.4 da para el mismo riesgo
 * («maquila, faenado por encargo, alquiler de planta o silos»). Para quitarlos, borre su línea.
 */
const ROTULOS_PROHIBIDOS = [
  { termino: 'Maquila', regex: /\bmaquil\w*/, fuente: 'PET-RAU-001 §1.2 y §1.4' },
  { termino: 'Servicios a Terceros', regex: /\bservicios?\s+(a|para)\s+(los\s+)?terceros?\b/, fuente: 'DS 24463 Art. 7; PET-RAU-001 §1.4' },
  { termino: 'Faenado por encargo', regex: /\bfaenado\s+por\s+encargo\b/, fuente: 'PET-RAU-001 §1.4' },
  { termino: 'Alquiler de planta o silos', regex: /\balquileres?\s+de\s+(la\s+)?(planta|silos?)\b/, fuente: 'PET-RAU-001 §1.4' },
];

function buscarRotulos(campos) {
  const coincidencias = [];
  for (const [campo, texto] of Object.entries(campos)) {
    const n = normalizar(texto);
    if (!n) continue;
    for (const r of ROTULOS_PROHIBIDOS) {
      if (r.regex.test(n)) coincidencias.push({ termino: r.termino, campo, texto: String(texto), fuente: r.fuente });
    }
  }
  return coincidencias;
}

// Semáforos de PET-RAU-001 §1.4 y §5 (umbrales internos de alerta, no límites legales)
const semaforoI1 = (v) => (v === null ? 'SIN_DATOS' : v >= 65 ? 'VERDE' : v >= 60 ? 'AMARILLO' : 'ROJO');
const semaforoI2 = (v) => (v === null ? 'SIN_DATOS' : v <= 15 ? 'VERDE' : v <= 20 ? 'AMARILLO' : 'ROJO');

function auditoriaRau(db, q = {}) {
  requerirDb(db);
  const ej = resolverEjercicio(db, q);
  const desde = fechaOpcional(q.desde, 'desde') || ej.fecha_inicio;
  const hasta = fechaOpcional(q.hasta, 'hasta') || ej.fecha_fin;
  if (desde > hasta) throw new ReportError('desde no puede ser posterior a hasta');
  const params = { ej: ej.id, desde, hasta };

  // Control 1 — rótulos prohibidos en ingresos (Grupo 5, crédito)
  const lineas = db.prepare(Q.INGRESOS_PARA_AUDITORIA).all(params);
  const hallazgos = [];
  for (const l of lineas) {
    const coincidencias = buscarRotulos({
      'nombre de la cuenta': l.cuenta_nombre,
      'glosa de la línea': l.glosa_linea,
      'glosa del asiento': l.glosa_asiento,
      'documento de respaldo': l.documento_respaldo,
    });
    if (!coincidencias.length) continue;
    hallazgos.push({
      severidad: l.estado === 'ANULADO' ? 'INFORMATIVO' : 'ROJO',
      asiento_id: l.asiento_id, comprobante: l.numero, fecha: l.fecha, tipo: l.tipo, estado: l.estado,
      cuenta: `${l.cuenta_codigo} — ${l.cuenta_nombre}`, lote: l.lote, monto: money(l.monto_c), coincidencias,
    });
  }
  const rojos = hallazgos.filter((h) => h.severidad === 'ROJO');
  const montoRojo = rojos.reduce((a, h) => a + Math.round(h.monto * 100), 0);

  // Cuentas de ingreso del plan con un rótulo prohibido (aun sin movimiento)
  const cuentasConRotulo = db.prepare(Q.CUENTAS_INGRESO_PLAN).all()
    .map((c) => ({ codigo: c.codigo, nombre: c.nombre, coincidencias: buscarRotulos({ nombre: c.nombre, descripcion: c.descripcion }) }))
    .filter((c) => c.coincidencias.length);

  // Indicadores I-1 e I-2 (PET-RAU-001 §1.3 y §1.4)
  const i1 = db.prepare(Q.INDICADOR_I1).get({ ej: ej.id });
  const v1 = i1.qq_producidos > 0 ? pct(i1.qq_consumo_propio, i1.qq_producidos) : null;
  const i2 = db.prepare(Q.INDICADOR_I2).get(params);
  const v2 = i2.operativos_c > 0 ? pct(i2.alimento_c, i2.operativos_c) : null;
  const indicadores = [
    {
      codigo: 'I-1', nombre: 'Autoconsumo de alimento', formula: 'qq consumo propio / qq producidos × 100 (lotes CC-02 cerrados)',
      valor: v1, unidad: '%', semaforo: semaforoI1(v1), meta: '≥ 65 % (amarillo 60–65 %; rojo < 60 %)',
      detalle: { qq_producidos: i1.qq_producidos, qq_consumo_propio: i1.qq_consumo_propio, qq_excedente: i1.qq_excedente, lotes: i1.lotes },
      fuente: 'PET-RAU-001 §1.3 (R1) y §1.4',
    },
    {
      codigo: 'I-2', nombre: 'Ventas de alimento / ingresos operativos', formula: 'cuenta 5.1.02.01 / cuenta 5.1 (neta de devoluciones) × 100',
      valor: v2, unidad: '%', semaforo: semaforoI2(v2), meta: '≤ 15 % (amarillo 15–20 %; rojo > 20 %)',
      detalle: { ventas_alimento: money(i2.alimento_c), ingresos_operativos: money(i2.operativos_c) },
      fuente: 'PET-RAU-001 §1.4 y §5',
    },
  ];

  const hayRojoIndicador = indicadores.some((i) => i.semaforo === 'ROJO');
  const hayAmarillo = indicadores.some((i) => i.semaforo === 'AMARILLO');
  const alertaRoja = rojos.length > 0;

  return {
    modulo: 'Panel de Auditoría y Blindaje Fiscal RAU — PET-RAU-001 / POL-07',
    periodo: { ejercicio: ej.codigo, desde, hasta },
    alerta_roja: alertaRoja,
    estado_general: alertaRoja || hayRojoIndicador ? 'ROJO' : hayAmarillo ? 'AMARILLO' : 'VERDE',
    mensaje: alertaRoja
      ? `ALERTA RAU: se detectaron ${rojos.length} registro(s) de ingreso etiquetado(s) como «Servicios a Terceros» o «Maquila» ` +
        `por Bs ${money(montoRojo).toFixed(2)}. El DS 24463, Art. 7, excluye del RAU a la cooperativa agropecuaria que preste servicios a ` +
        'terceros en plantas, mataderos, molinos u otra explotación; la exclusión implica pasar al régimen general (Art. 9). ' +
        'Según PET-RAU-001 §1.4 es alerta roja ante cualquier caso: reportar a la Gerencia General en 24 horas y al Consejo de Administración en 5 días hábiles.'
      : 'Sin ingresos etiquetados como «Servicios a Terceros» o «Maquila» en el período: se mantiene la exclusividad de uso propio (PET-RAU-001 §1.2).',
    control_servicios_a_terceros: {
      regla: 'Cero servicios a terceros (maquila, faenado por encargo, alquiler de planta o silos) — meta 0 casos',
      terminos_vigilados: ROTULOS_PROHIBIDOS.map((r) => ({ termino: r.termino, fuente: r.fuente })),
      lineas_de_ingreso_revisadas: lineas.length,
      hallazgos,
      cuentas_con_rotulo_en_el_plan: cuentasConRotulo,
    },
    indicadores,
    no_evaluables: [
      'Superficie usada vs. declarada en el SIN (ha) — no existe en schema.sql',
      'Presentación del Formulario 701 y cuota por hectárea — no existe en schema.sql',
      'Compras con respaldo / acreditación RAU del vendedor — no existe en schema.sql',
      'Compradores no socios y padrón de socios — no existe en schema.sql',
      'Merma de alimento (sufijo 41) sobre producción — se evalúa en el Informe de Costo de Ciclo',
    ],
    base_normativa: [
      'DS 24463 Art. 4 — pertenecen al RAU las cooperativas agrícolas o pecuarias.',
      'DS 24463 Art. 7 — excluidas las cooperativas agropecuarias que presten servicios a terceros en plantas de beneficio, mataderos, ceba intensiva, molinos, silos, almacenes, frigoríficos u otra explotación industrial, comercial o de servicios.',
      'DS 24463 Art. 9 — los sujetos excluidos pasan al régimen general.',
      'PET-RAU-001 §1.4 — umbrales internos de alerta (no son límites legales).',
    ],
  };
}

module.exports = {
  ReportError,
  ROTULOS_PROHIBIDOS,
  catalogos,
  libroMayor,
  balanceComprobacion,
  estadoResultados,
  auditoriaRau,
};
