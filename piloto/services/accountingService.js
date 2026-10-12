'use strict';
/**
 * services/accountingService.js
 * -----------------------------------------------------------------------------
 * Lógica contable y de costos — Pollolandia Contable (módulo demostrativo).
 *
 * - Sin autenticación: no hay tokens, contraseñas ni sesiones (condición del proyecto).
 * - Trabaja SOLO con las tablas de schema.sql (Fase 1); no modifica la base de datos.
 * - Pensado para better-sqlite3 (API síncrona: prepare().get/all/run y db.transaction).
 *
 * Fuentes de las reglas (documentos del proyecto):
 *   - Manual del Sistema de Costos MAN-01 (SGC-MAN-ADM-001 v1.0): §3 (sufijos), §5-§7
 *     (elementos del costo), §8.1-§8.2 (movimientos contables), PC-04 (ciclo de 73 días).
 *   - Plan de Cuentas Contable (4 niveles) y hoja "Sufijos de Costos".
 *   - schema.sql: triggers 10.3-10.8 (ejercicio abierto, cuadre, matriz centro x sufijo, lote ABIERTO).
 */

class AccountingError extends Error {
  constructor(message, status = 422, extra = undefined) {
    super(message);
    this.name = 'AccountingError';
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// Contrapartida (crédito) por defecto de cada sufijo — MAN-01 §8.1 y §8.2.
// Los sufijos 01-13 salen de inventarios (MPD). Para MOD y CIF el Manual no fija la
// contrapartida, por eso se proponen cuentas del Plan de Cuentas y SIEMPRE pueden
// reemplazarse enviando `cuenta_contrapartida` en el ítem.
// Los sufijos 40 y 41 (pérdidas normales, MAN-01 §8.3) NO llevan contrapartida por
// defecto: se reclasifican contra los sufijos ya acumulados del mismo centro.
// ---------------------------------------------------------------------------
const CONTRAPARTIDA_DEFECTO = Object.freeze({
  // MPD — §8.1 paso 1 y §8.2 pasos 1, 3 y 4
  '01': '1.1.03.01', // Inventario – Pollitos BB
  '02': '1.1.03.02', // Inventario – Alimento Balanceado Comprado
  '03': '1.1.03.03', // Inventario – Maíz Amarillo
  '04': '1.1.03.04', // Inventario – Torta de Soya
  '05': '1.1.03.05', // Inventario – Afrecho de Trigo
  '06': '1.1.03.06', // Inventario – Núcleo Vitamínico
  '07': '1.1.03.07', // Inventario – Aceite Vegetal
  '08': '1.1.03.08', // Inventario – Productos Veterinarios
  '09': '1.1.03.09', // Inventario – Limpieza y Desinfección
  '10': '1.1.03.10', // Inventario – Insumos de Crianza
  '11': '1.1.03.13', // Inventario – Prod. Terminados: Alimento Balanceado (consumo propio)
  '12': '1.1.03.11', // Inventario – Insumos de Embalaje (bolsas)
  '13': '1.1.03.11', // Inventario – Insumos de Embalaje (saquillos de yute)
  // MOD — propuesta (Plan de Cuentas, Grupo 2)
  '20': '2.1.02.01', // Sueldos y Salarios por Pagar
  '21': '2.1.02.02', // Aguinaldo por Pagar
  '22': '2.1.02.04', // Personal Eventual por Pagar
  '38': '2.1.02.03', // Aportes Patronales por Pagar
  '39': '2.2.01.01', // Provisión para Indemnización
  // CIF — propuesta (Plan de Cuentas, 4.1.02 depreciaciones acumuladas y 2.1.01.06)
  '30': '4.1.02.01', // Deprec. Acumulada – Galpones
  '31': '4.1.02.05', // Deprec. Acumulada – Equipos de Producción Avícola
  '32': '4.1.02.02', // Deprec. Acumulada – Alambrados y Cercados
  '33': '4.1.02.06', // Deprec. Acumulada – Herramientas de Producción
  '34': '4.1.02.04', // Deprec. Acumulada – Maquinaria Alimento
  '35': '4.1.02.03', // Deprec. Acumulada – Ambiente de Preparación
  '36': '2.1.01.06', // Proveedores – Servicios y Otros (mantenimiento)
  '37': '2.1.01.06', // Proveedores – Servicios y Otros (energía y agua)
});

const TIPOS_ASIENTO = ['APERTURA', 'DIARIO', 'AJUSTE', 'CIERRE_CICLO', 'CIERRE_EJERCICIO', 'ANULACION'];
const DURACION_CICLO_DIAS = 73; // schema.sql: lotes.duracion_dias = 73 (PC-04)

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Convierte un importe a centavos enteros (evita errores de coma flotante). */
function toCents(valor, campo) {
  if (valor === null || valor === undefined || valor === '') return 0;
  let s = String(valor).trim();
  if (!s.includes('.')) s = s.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new AccountingError(
      `${campo}: importe inválido "${valor}" (número >= 0 con máximo 2 decimales)`,
      400
    );
  }
  const [ent, dec = ''] = s.split('.');
  return parseInt(ent, 10) * 100 + parseInt((dec + '00').slice(0, 2), 10);
}
const fromCents = (c) => c / 100;

function esFecha(f) {
  if (typeof f !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

function sumarDias(fechaISO, dias) {
  const [y, m, d] = fechaISO.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}

function hoyLocal() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

/** Acepta '02', '2' o '6.1.01.01-02' y devuelve '02'. */
function normalizarSufijo(s) {
  const m = String(s ?? '').trim().match(/(\d{1,2})$/);
  if (!m) throw new AccountingError(`Sufijo inválido: "${s}"`, 400);
  return m[1].padStart(2, '0');
}

function requerirDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new Error('accountingService: se requiere una conexión better-sqlite3 (prepare/transaction).');
  }
}

/**
 * Sin autenticación no hay "usuario actual", pero asientos.creado_por es NOT NULL.
 * Orden: id explícito del body → ACCOUNTING_DEFAULT_USER_ID → primer usuario activo
 * (se prefiere el rol JF = Jefe de Finanzas, quien registra según el MOF).
 */
function resolverUsuario(db, idExplicito) {
  const candidato = idExplicito ?? process.env.ACCOUNTING_DEFAULT_USER_ID;
  if (candidato !== undefined && candidato !== null && candidato !== '') {
    const u = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(Number(candidato));
    if (!u) throw new AccountingError(`El usuario ${candidato} no existe en la tabla usuarios`, 422);
    return u.id;
  }
  const u =
    db
      .prepare(
        `SELECT u.id FROM usuarios u JOIN roles r ON r.id = u.rol_id
         WHERE u.activo = 1 ORDER BY (r.codigo = 'JF') DESC, u.id LIMIT 1`
      )
      .get() || null;
  if (!u) {
    throw new AccountingError(
      'No hay ningún usuario activo en la tabla usuarios. asientos.creado_por es obligatorio: ' +
        'cargue al menos un usuario de demostración o defina ACCOUNTING_DEFAULT_USER_ID.',
      422
    );
  }
  return u.id;
}

function resolverEjercicio(db, fecha, ejercicioId) {
  if (ejercicioId !== undefined && ejercicioId !== null && ejercicioId !== '') {
    const e = db.prepare('SELECT id FROM ejercicios_fiscales WHERE id = ?').get(Number(ejercicioId));
    if (!e) throw new AccountingError(`El ejercicio fiscal ${ejercicioId} no existe`, 422);
    return e.id;
  }
  const e = db
    .prepare('SELECT id FROM ejercicios_fiscales WHERE ? BETWEEN fecha_inicio AND fecha_fin ORDER BY id LIMIT 1')
    .get(fecha);
  if (!e) throw new AccountingError(`No existe un ejercicio fiscal que contenga la fecha ${fecha}`, 422);
  return e.id;
}

function auditar(db, { usuarioId, accion, entidad, entidadId, detalle, ip }) {
  db.prepare(
    `INSERT INTO auditoria_log (usuario_id, accion, entidad, entidad_id, detalle, ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(usuarioId ?? null, accion, entidad, entidadId ?? null, detalle ? JSON.stringify(detalle) : null, ip ?? null);
}

// ---------------------------------------------------------------------------
// 1) REGISTRO DE ASIENTOS CONTABLES — única regla propia: Debe = Haber
// ---------------------------------------------------------------------------

/**
 * Registra un asiento (partida doble).
 *
 * payload = {
 *   fecha: 'YYYY-MM-DD', glosa: '...', tipo?: 'DIARIO', documento_respaldo?: '...',
 *   ejercicio_id?, creado_por?, autorizado_por?, asiento_origen_id?, contabilizar?: true,
 *   lineas: [{ cuenta: '1.1.03.01' | cuenta_id, debe?, haber?, glosa?,
 *              centro_costo?: 'CC-01' | centro_costo_id, sufijo?: '01' | sufijo_id,
 *              lote?: 'L-...' | lote_id, moneda?, monto_origen?, tipo_cambio? }]
 * }
 *
 * Validación propia: suma(Debe) = suma(Haber) y > 0, comparadas en centavos enteros.
 * Las demás reglas (cuenta imputable, ejercicio ABIERTO, matriz centro x sufijo, lote
 * ABIERTO, SoD) las aplican los CHECK y triggers del schema; sus mensajes se devuelven tal cual.
 */
function registrarAsiento(db, payload, ctx = {}) {
  requerirDb(db);
  const p = payload || {};

  if (!esFecha(p.fecha)) throw new AccountingError('fecha es obligatoria con formato YYYY-MM-DD', 400);
  if (!p.glosa || !String(p.glosa).trim()) throw new AccountingError('glosa es obligatoria', 400);
  const tipo = p.tipo || 'DIARIO';
  if (!TIPOS_ASIENTO.includes(tipo)) {
    throw new AccountingError(`tipo inválido. Valores: ${TIPOS_ASIENTO.join(', ')}`, 400);
  }
  if (!Array.isArray(p.lineas) || p.lineas.length === 0) {
    throw new AccountingError('lineas debe ser un arreglo con al menos una línea', 400);
  }

  // --- Montos en centavos y validación de forma de cada línea ---
  const montos = p.lineas.map((l, i) => {
    const debe = toCents(l.debe, `lineas[${i}].debe`);
    const haber = toCents(l.haber, `lineas[${i}].haber`);
    if ((debe > 0) === (haber > 0)) {
      throw new AccountingError(`Línea ${i + 1}: debe informar Debe o Haber (uno solo, mayor a cero)`, 400);
    }
    return { debe, haber };
  });

  // --- ÚNICA validación contable propia: Debe = Haber ---
  const totalDebe = montos.reduce((a, m) => a + m.debe, 0);
  const totalHaber = montos.reduce((a, m) => a + m.haber, 0);
  if (totalDebe !== totalHaber) {
    throw new AccountingError(
      `Asiento descuadrado: Debe ${fromCents(totalDebe).toFixed(2)} ≠ Haber ${fromCents(totalHaber).toFixed(2)}`,
      422,
      {
        total_debe: fromCents(totalDebe),
        total_haber: fromCents(totalHaber),
        diferencia: fromCents(Math.abs(totalDebe - totalHaber)),
      }
    );
  }

  const tx = db.transaction(() => {
    const creadoPor = resolverUsuario(db, p.creado_por);
    const ejercicioId = resolverEjercicio(db, p.fecha, p.ejercicio_id);
    const numero =
      db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM asientos WHERE ejercicio_id = ?').get(ejercicioId).n;

    const asientoId = Number(
      db
        .prepare(
          `INSERT INTO asientos
             (ejercicio_id, numero, fecha, tipo, glosa, documento_respaldo, estado,
              asiento_origen_id, creado_por)
           VALUES (?, ?, ?, ?, ?, ?, 'BORRADOR', ?, ?)`
        )
        .run(ejercicioId, numero, p.fecha, tipo, String(p.glosa).trim(), p.documento_respaldo ?? null,
             p.asiento_origen_id ?? null, creadoPor).lastInsertRowid
    );

    const qCuenta = db.prepare('SELECT id FROM cuentas WHERE codigo = ?');
    const qCentro = db.prepare('SELECT id FROM centros_costo WHERE codigo = ?');
    const qSufijo = db.prepare('SELECT id FROM sufijos_costo WHERE codigo = ?');
    const qLote = db.prepare('SELECT id FROM lotes WHERE codigo = ?');
    const insDet = db.prepare(
      `INSERT INTO asiento_detalle
         (asiento_id, linea, cuenta_id, glosa, debe, haber, moneda, monto_origen, tipo_cambio,
          centro_costo_id, sufijo_id, lote_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    p.lineas.forEach((l, i) => {
      const n = i + 1;
      let cuentaId = l.cuenta_id;
      if (cuentaId === undefined || cuentaId === null) {
        const c = qCuenta.get(String(l.cuenta ?? l.cuenta_codigo ?? ''));
        if (!c) throw new AccountingError(`Línea ${n}: la cuenta "${l.cuenta ?? l.cuenta_codigo}" no existe`, 422);
        cuentaId = c.id;
      }

      let centroId = l.centro_costo_id ?? null;
      if (centroId === null && l.centro_costo) {
        const c = qCentro.get(String(l.centro_costo));
        if (!c) throw new AccountingError(`Línea ${n}: el centro de costo "${l.centro_costo}" no existe`, 422);
        centroId = c.id;
      }
      let sufijoId = l.sufijo_id ?? null;
      if (sufijoId === null && l.sufijo !== undefined && l.sufijo !== null && l.sufijo !== '') {
        const s = qSufijo.get(normalizarSufijo(l.sufijo));
        if (!s) throw new AccountingError(`Línea ${n}: el sufijo "${l.sufijo}" no existe`, 422);
        sufijoId = s.id;
      }
      let loteId = l.lote_id ?? null;
      if (loteId === null && l.lote) {
        const lo = qLote.get(String(l.lote));
        if (!lo) throw new AccountingError(`Línea ${n}: el lote "${l.lote}" no existe`, 422);
        loteId = lo.id;
      }

      insDet.run(
        asientoId, n, cuentaId, l.glosa ?? null,
        fromCents(montos[i].debe), fromCents(montos[i].haber),
        l.moneda || 'BOB', l.monto_origen ?? null, l.tipo_cambio ?? 1,
        centroId, sufijoId, loteId
      );
    });

    if (p.contabilizar !== false) {
      // El trigger trg_asientos_cuadre vuelve a verificar mínimo 2 líneas y Debe = Haber.
      db.prepare(
        `UPDATE asientos
            SET estado = 'CONTABILIZADO',
                contabilizado_en = CURRENT_TIMESTAMP,
                autorizado_por = ?,
                autorizado_en = CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END
          WHERE id = ?`
      ).run(p.autorizado_por ?? null, p.autorizado_por ?? null, asientoId);
    }

    auditar(db, {
      usuarioId: creadoPor,
      accion: p.contabilizar !== false ? 'CONTABILIZAR' : 'CREAR',
      entidad: 'asientos',
      entidadId: asientoId,
      detalle: { numero, tipo, fecha: p.fecha, total: fromCents(totalDebe), lineas: p.lineas.length },
      ip: ctx.ip,
    });
    return asientoId;
  });

  return obtenerAsiento(db, tx());
}

function obtenerAsiento(db, id) {
  requerirDb(db);
  const cab = db
    .prepare(
      `SELECT a.*, e.codigo AS ejercicio
         FROM asientos a JOIN ejercicios_fiscales e ON e.id = a.ejercicio_id WHERE a.id = ?`
    )
    .get(Number(id));
  if (!cab) throw new AccountingError(`El asiento ${id} no existe`, 404);
  const detalle = db
    .prepare(
      `SELECT d.linea, c.codigo AS cuenta, c.nombre AS cuenta_nombre, d.glosa, d.debe, d.haber,
              cc.codigo AS centro_costo, s.codigo AS sufijo, l.codigo AS lote
         FROM asiento_detalle d
         JOIN cuentas c ON c.id = d.cuenta_id
         LEFT JOIN centros_costo cc ON cc.id = d.centro_costo_id
         LEFT JOIN sufijos_costo s ON s.id = d.sufijo_id
         LEFT JOIN lotes l ON l.id = d.lote_id
        WHERE d.asiento_id = ? ORDER BY d.linea`
    )
    .all(cab.id);
  const totalDebe = detalle.reduce((a, d) => a + Math.round(Number(d.debe) * 100), 0);
  const totalHaber = detalle.reduce((a, d) => a + Math.round(Number(d.haber) * 100), 0);
  return { ...cab, detalle, total_debe: fromCents(totalDebe), total_haber: fromCents(totalHaber) };
}

function listarAsientos(db, { ejercicio_id, estado, tipo, limit = 50, offset = 0 } = {}) {
  requerirDb(db);
  const where = [];
  const args = [];
  if (ejercicio_id) { where.push('a.ejercicio_id = ?'); args.push(Number(ejercicio_id)); }
  if (estado) { where.push('a.estado = ?'); args.push(String(estado).toUpperCase()); }
  if (tipo) { where.push('a.tipo = ?'); args.push(String(tipo).toUpperCase()); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  return db
    .prepare(
      `SELECT a.id, a.numero, a.fecha, a.tipo, a.glosa, a.estado, a.documento_respaldo,
              ROUND(COALESCE((SELECT SUM(debe) FROM asiento_detalle WHERE asiento_id = a.id), 0), 2) AS total
         FROM asientos a ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.fecha DESC, a.numero DESC LIMIT ? OFFSET ?`
    )
    .all(...args, lim, off);
}

// ---------------------------------------------------------------------------
// 2) LOTES DE PRODUCCIÓN (ciclo de 73 días) Y ASIGNACIÓN DE COSTOS (Grupo 6)
// ---------------------------------------------------------------------------

function buscarLote(db, ref) {
  const sql = `SELECT l.*, cc.codigo AS centro_costo, cc.cuenta_id AS cc_cuenta_id,
                      c.codigo AS cc_cuenta_codigo, cc.unidad_medida
                 FROM lotes l
                 JOIN centros_costo cc ON cc.id = l.centro_costo_id
                 JOIN cuentas c ON c.id = cc.cuenta_id`;
  const lote = /^\d+$/.test(String(ref))
    ? db.prepare(`${sql} WHERE l.id = ?`).get(Number(ref))
    : db.prepare(`${sql} WHERE l.codigo = ?`).get(String(ref));
  if (!lote) throw new AccountingError(`El lote "${ref}" no existe`, 404);
  return lote;
}

/**
 * Abre un lote de 73 días. Día 1 = fecha_inicio (recepción de pollitos BB);
 * día 73 = fecha_inicio + 72 (faenado/cierre), coherente con trg_bitacora_validar.
 */
function crearLote(db, payload, ctx = {}) {
  requerirDb(db);
  const p = payload || {};
  if (!esFecha(p.fecha_inicio)) throw new AccountingError('fecha_inicio es obligatoria (YYYY-MM-DD)', 400);

  const tx = db.transaction(() => {
    const centro = p.centro_costo_id
      ? db.prepare('SELECT * FROM centros_costo WHERE id = ?').get(Number(p.centro_costo_id))
      : db.prepare('SELECT * FROM centros_costo WHERE codigo = ?').get(String(p.centro_costo || 'CC-01'));
    if (!centro) throw new AccountingError('El centro de costo indicado no existe (use CC-01 o CC-02)', 422);

    const ejercicioId = resolverEjercicio(db, p.fecha_inicio, p.ejercicio_id);
    const ejercicio = db.prepare('SELECT codigo FROM ejercicios_fiscales WHERE id = ?').get(ejercicioId);
    const numeroCiclo =
      p.numero_ciclo ??
      db
        .prepare('SELECT COALESCE(MAX(numero_ciclo), 0) + 1 AS n FROM lotes WHERE centro_costo_id = ? AND ejercicio_id = ?')
        .get(centro.id, ejercicioId).n;
    const codigo =
      p.codigo || `L-${centro.codigo.replace('-', '')}-${ejercicio.codigo}-${String(numeroCiclo).padStart(2, '0')}`;
    const fechaFin = sumarDias(p.fecha_inicio, DURACION_CICLO_DIAS - 1);

    const id = Number(
      db
        .prepare(
          `INSERT INTO lotes
             (codigo, centro_costo_id, ejercicio_id, numero_ciclo, fecha_inicio, duracion_dias,
              fecha_fin_prevista, aves_iniciales, responsable_id, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(codigo, centro.id, ejercicioId, numeroCiclo, p.fecha_inicio, DURACION_CICLO_DIAS, fechaFin,
             p.aves_iniciales ?? null, p.responsable_id ?? null, p.observaciones ?? null).lastInsertRowid
    );
    auditar(db, {
      usuarioId: p.responsable_id ?? null, accion: 'CREAR', entidad: 'lotes', entidadId: id,
      detalle: { codigo, centro_costo: centro.codigo, fecha_inicio: p.fecha_inicio, fecha_fin_prevista: fechaFin },
      ip: ctx.ip,
    });
    return { id, numeroCiclo };
  });

  const { id, numeroCiclo } = tx();
  const lote = buscarLote(db, id);
  const advertencias = [];
  if (numeroCiclo > 5) advertencias.push('MAN-01 §1.2 prevé 5 ciclos anuales; este es el ciclo ' + numeroCiclo);
  return { lote, advertencias };
}

function listarLotes(db, { estado, centro_costo } = {}) {
  requerirDb(db);
  const where = [];
  const args = [];
  if (estado) { where.push('l.estado = ?'); args.push(String(estado).toUpperCase()); }
  if (centro_costo) { where.push('cc.codigo = ?'); args.push(String(centro_costo)); }
  return db
    .prepare(
      `SELECT l.id, l.codigo, cc.codigo AS centro_costo, l.numero_ciclo, l.fecha_inicio,
              l.fecha_fin_prevista, l.estado, l.aves_iniciales
         FROM lotes l JOIN centros_costo cc ON cc.id = l.centro_costo_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY l.fecha_inicio DESC, l.id DESC`
    )
    .all(...args);
}

/**
 * Asigna costos a un lote: genera UN asiento contabilizado.
 *   Debe  6.1.01.0X (cuenta del centro de costo) — una línea por ítem, con centro + sufijo + lote.
 *   Haber contrapartida (inventario / pasivo / depreciación) — agrupada por cuenta.
 *
 * payload = {
 *   fecha?: 'YYYY-MM-DD' (por defecto hoy), glosa?, documento_respaldo?, creado_por?,
 *   items: [{ sufijo: '01', monto?: 27000, cantidad?: 3000, costo_unitario?: 9,
 *             detalle?: '...', cuenta_contrapartida?: '2.1.01.01' }]
 * }
 * Ej. MAN-01 §5.1: pollitos BB 3.000 × Bs 9,00 = Bs 27.000 → sufijo 01 → 6.1.01.01-01.
 */
function asignarCostosALote(db, loteRef, payload, ctx = {}) {
  requerirDb(db);
  const p = payload || {};
  const lote = buscarLote(db, loteRef);
  if (lote.estado !== 'ABIERTO') {
    throw new AccountingError(`El lote ${lote.codigo} está ${lote.estado}: solo un lote ABIERTO acumula costos`, 422);
  }
  if (!Array.isArray(p.items) || p.items.length === 0) {
    throw new AccountingError('items debe ser un arreglo con al menos un costo a asignar', 400);
  }
  const fecha = p.fecha || hoyLocal();
  if (!esFecha(fecha)) throw new AccountingError('fecha inválida (YYYY-MM-DD)', 400);

  const qSufijo = db.prepare('SELECT id, codigo, nombre, elemento_costo FROM sufijos_costo WHERE codigo = ?');
  const lineasDebe = [];
  const haberPorCuenta = new Map(); // cuenta -> centavos
  const resumen = { total: 0, por_elemento: {} };
  let totalCents = 0;

  p.items.forEach((it, i) => {
    const n = i + 1;
    const cod = normalizarSufijo(it.sufijo);
    const suf = qSufijo.get(cod);
    if (!suf) throw new AccountingError(`Ítem ${n}: el sufijo ${cod} no existe`, 422);

    let cents;
    if (it.monto !== undefined && it.monto !== null && it.monto !== '') {
      cents = toCents(it.monto, `items[${i}].monto`);
    } else if (it.cantidad !== undefined && it.costo_unitario !== undefined) {
      const cant = Number(String(it.cantidad).replace(',', '.'));
      const cu = Number(String(it.costo_unitario).replace(',', '.'));
      if (!Number.isFinite(cant) || !Number.isFinite(cu) || cant <= 0 || cu <= 0) {
        throw new AccountingError(`Ítem ${n}: cantidad y costo_unitario deben ser números positivos`, 400);
      }
      cents = Math.round(cant * cu * 100);
    } else {
      throw new AccountingError(`Ítem ${n}: informe "monto" o bien "cantidad" y "costo_unitario"`, 400);
    }
    if (cents <= 0) throw new AccountingError(`Ítem ${n}: el monto debe ser mayor a cero`, 400);

    const contra = it.cuenta_contrapartida || CONTRAPARTIDA_DEFECTO[cod];
    if (!contra) {
      throw new AccountingError(
        `Ítem ${n}: el sufijo ${cod} (${suf.nombre}) no tiene contrapartida por defecto; ` +
          'informe "cuenta_contrapartida" (MAN-01 §8.3: los sufijos 40/41 se reclasifican contra los sufijos acumulados).',
        422
      );
    }

    const detalleTxt = it.detalle
      ? `${suf.nombre} — ${it.detalle}`
      : it.cantidad && it.costo_unitario
      ? `${suf.nombre} (${it.cantidad} × ${it.costo_unitario})`
      : suf.nombre;
    lineasDebe.push({
      cuenta: lote.cc_cuenta_codigo,
      debe: fromCents(cents).toFixed(2),
      glosa: detalleTxt,
      centro_costo_id: lote.centro_costo_id,
      sufijo_id: suf.id,
      lote_id: lote.id,
    });
    haberPorCuenta.set(contra, (haberPorCuenta.get(contra) || 0) + cents);
    totalCents += cents;
    resumen.por_elemento[suf.elemento_costo] = (resumen.por_elemento[suf.elemento_costo] || 0) + cents;
  });

  const lineasHaber = [...haberPorCuenta.entries()].map(([cuenta, cents]) => ({
    cuenta,
    haber: fromCents(cents).toFixed(2),
    glosa: `Contrapartida costos lote ${lote.codigo}`,
  }));

  const asiento = registrarAsiento(
    db,
    {
      fecha,
      tipo: 'DIARIO',
      glosa: p.glosa || `Asignación de costos al lote ${lote.codigo} (${lote.centro_costo})`,
      documento_respaldo: p.documento_respaldo ?? null,
      creado_por: p.creado_por,
      lineas: [...lineasDebe, ...lineasHaber],
    },
    ctx
  );

  const advertencias = [];
  if (fecha < lote.fecha_inicio || fecha > lote.fecha_fin_prevista) {
    advertencias.push(
      `La fecha ${fecha} está fuera del ciclo del lote (${lote.fecha_inicio} a ${lote.fecha_fin_prevista}, 73 días).`
    );
  }

  resumen.total = fromCents(totalCents);
  Object.keys(resumen.por_elemento).forEach((k) => (resumen.por_elemento[k] = fromCents(resumen.por_elemento[k])));
  return { asiento, resumen, advertencias };
}

/** Hoja de costos del lote (insumo del Informe de Costo de Ciclo FIN-TRA-06, MAN-01 §7 y §9.3). */
function hojaCostosLote(db, loteRef) {
  requerirDb(db);
  const lote = buscarLote(db, loteRef);
  const filas = db
    .prepare('SELECT sufijo, sufijo_nombre, elemento_costo, monto FROM v_hoja_costos_lote WHERE lote_id = ? ORDER BY sufijo')
    .all(lote.id);
  const porElemento = {};
  let total = 0;
  filas.forEach((f) => {
    const c = Math.round(Number(f.monto) * 100);
    porElemento[f.elemento_costo] = (porElemento[f.elemento_costo] || 0) + c;
    total += c;
  });
  Object.keys(porElemento).forEach((k) => (porElemento[k] = fromCents(porElemento[k])));
  const prod = lote.unidad_medida === 'KG' ? lote.kg_producidos : lote.qq_producidos;
  return {
    lote: { id: lote.id, codigo: lote.codigo, centro_costo: lote.centro_costo, estado: lote.estado,
            fecha_inicio: lote.fecha_inicio, fecha_fin_prevista: lote.fecha_fin_prevista },
    sufijos: filas,
    por_elemento: porElemento,
    costo_total: fromCents(total),
    unidad_medida: lote.unidad_medida,
    produccion: prod ?? null,
    costo_unitario_provisional: prod > 0 ? Math.round((fromCents(total) / prod) * 10000) / 10000 : null,
  };
}

// ---------------------------------------------------------------------------
// Catálogos para el formulario
// ---------------------------------------------------------------------------

function listarSufijos(db, centroCodigo) {
  requerirDb(db);
  const base = `SELECT s.codigo, s.nombre, s.elemento_costo FROM sufijos_costo s`;
  const filas = centroCodigo
    ? db
        .prepare(
          `${base} JOIN centro_costo_sufijos m ON m.sufijo_id = s.id
             JOIN centros_costo cc ON cc.id = m.centro_costo_id
            WHERE cc.codigo = ? AND s.activo = 1 ORDER BY s.codigo`
        )
        .all(String(centroCodigo))
    : db.prepare(`${base} WHERE s.activo = 1 ORDER BY s.codigo`).all();
  return filas.map((s) => ({ ...s, contrapartida_defecto: CONTRAPARTIDA_DEFECTO[s.codigo] || null }));
}

function listarCuentas(db, { q, grupo, imputables = true } = {}) {
  requerirDb(db);
  const where = ['activa = 1'];
  const args = [];
  if (imputables) where.push('es_imputable = 1');
  if (grupo) { where.push('grupo = ?'); args.push(Number(grupo)); }
  if (q) { where.push('(codigo LIKE ? OR nombre LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  return db.prepare(`SELECT codigo, nombre, naturaleza FROM cuentas WHERE ${where.join(' AND ')} ORDER BY codigo`).all(...args);
}

module.exports = {
  AccountingError,
  CONTRAPARTIDA_DEFECTO,
  registrarAsiento,
  obtenerAsiento,
  listarAsientos,
  crearLote,
  listarLotes,
  asignarCostosALote,
  hojaCostosLote,
  listarSufijos,
  listarCuentas,
};
