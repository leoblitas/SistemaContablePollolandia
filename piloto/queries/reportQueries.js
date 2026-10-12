'use strict';
/**
 * queries/reportQueries.js
 * -----------------------------------------------------------------------------
 * Consultas SQL (SOLO LECTURA) de la Fase 5 — Pollolandia Contable.
 * No crean vistas ni modifican el schema.sql: solo leen sus tablas.
 *
 * Convenciones (las mismas de las vistas v_* de schema.sql, sección 9):
 *   - Solo asientos CONTABILIZADOS y ANULADOS. Un asiento ANULADO se muestra junto a su
 *     contrapartida (tipo ANULACION, CONTABILIZADO) y ambos se compensan.
 *   - Importes en centavos enteros (ROUND(x*100)) para que las sumas sean exactas.
 *   - Parámetros con nombre (@ej, @desde, ...), compatibles con better-sqlite3.
 *
 * Fuentes: MAN-006 §22 (formatos MA-04 y BS-05) y §18.2 (modelo de Estado de Resultados);
 *          PC-08 §D (Estado de Resultados escalonado); PET-RAU-001 §1.4.
 */

const ESTADOS_VISIBLES = `('CONTABILIZADO', 'ANULADO')`;

// ---- Catálogos ----------------------------------------------------------------
const EJERCICIOS = `
  SELECT id, codigo, fecha_inicio, fecha_fin, estado
    FROM ejercicios_fiscales ORDER BY fecha_inicio DESC`;

const CUENTAS_TODOS_LOS_NIVELES = `
  SELECT codigo, nombre, nivel, naturaleza, es_imputable
    FROM cuentas WHERE activa = 1 ORDER BY codigo`;

const LOTES = `
  SELECT l.id, l.codigo, cc.codigo AS centro_costo, l.numero_ciclo, l.fecha_inicio,
         l.fecha_fin_prevista, l.estado
    FROM lotes l JOIN centros_costo cc ON cc.id = l.centro_costo_id
   ORDER BY l.fecha_inicio DESC, l.id DESC`;

// ---- 1a) LIBRO MAYOR (MA-04): filtrable por cuenta de nivel 1 a 4 y rango de fechas --
// @cod = código de la cuenta (1, 1.1, 1.1.03 o 1.1.03.01); @pref = '<código>.%'
// El saldo corrido arranca en la apertura del ejercicio; el servicio lo parte en
// "saldo anterior" (fecha < @desde) y movimientos del período (@desde a @hasta).
const LIBRO_MAYOR = `
  SELECT c.id        AS cuenta_id,
         c.codigo    AS cuenta_codigo,
         c.nombre    AS cuenta_nombre,
         c.naturaleza,
         a.id        AS asiento_id,
         a.numero    AS comprobante,
         a.fecha,
         a.tipo,
         a.estado,
         a.glosa     AS glosa_asiento,
         a.documento_respaldo,
         d.linea,
         d.glosa     AS glosa_linea,
         CAST(ROUND(d.debe  * 100) AS INTEGER) AS debe_c,
         CAST(ROUND(d.haber * 100) AS INTEGER) AS haber_c,
         cc.codigo   AS centro_costo,
         s.codigo    AS sufijo,
         l.codigo    AS lote,
         SUM(CAST(ROUND(d.debe * 100) AS INTEGER) - CAST(ROUND(d.haber * 100) AS INTEGER)) OVER (
             PARTITION BY c.id
             ORDER BY a.fecha, a.numero, d.linea
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS saldo_c
    FROM asiento_detalle d
    JOIN asientos a            ON a.id  = d.asiento_id
    JOIN cuentas  c            ON c.id  = d.cuenta_id
    LEFT JOIN centros_costo cc ON cc.id = d.centro_costo_id
    LEFT JOIN sufijos_costo s  ON s.id  = d.sufijo_id
    LEFT JOIN lotes l          ON l.id  = d.lote_id
   WHERE a.ejercicio_id = @ej
     AND a.estado IN ${ESTADOS_VISIBLES}
     AND a.fecha <= @hasta
     AND (c.codigo = @cod OR c.codigo LIKE @pref)
   ORDER BY c.codigo, a.fecha, a.numero, d.linea`;

const CUENTA_POR_CODIGO = `SELECT codigo, nombre, nivel, naturaleza FROM cuentas WHERE codigo = ?`;

// ---- 1b) BALANCE DE COMPROBACIÓN DE SUMAS Y SALDOS (BS-05) -----------------------
// @len = largo del código según el nivel (1, 3, 6 o 9) para totalizar por nivel.
// @antes = 1 excluye ajustes y cierre de ejercicio ("antes de los ajustes", MAN-006 §22).
const BALANCE_COMPROBACION = `
  SELECT p.codigo, p.nombre, p.naturaleza,
         CAST(SUM(ROUND(d.debe  * 100)) AS INTEGER) AS debe_c,
         CAST(SUM(ROUND(d.haber * 100)) AS INTEGER) AS haber_c
    FROM asiento_detalle d
    JOIN asientos a ON a.id = d.asiento_id
    JOIN cuentas  c ON c.id = d.cuenta_id
    JOIN cuentas  p ON p.codigo = substr(c.codigo, 1, @len)
   WHERE a.ejercicio_id = @ej
     AND a.estado IN ${ESTADOS_VISIBLES}
     AND a.fecha BETWEEN @desde AND @hasta
     AND (@antes = 0 OR a.tipo NOT IN ('AJUSTE', 'CIERRE_EJERCICIO'))
   GROUP BY p.codigo, p.nombre, p.naturaleza
   ORDER BY p.codigo`;

// ---- 2) ESTADO DE RESULTADOS (MAN-006 §18.2 / PC-08 §D) ---------------------------
// Cuentas de resultado: Grupo 5 (ingresos), 6.1.02 (costo de producción vendida) y
// Grupo 7 (gastos). Se excluye CIERRE_EJERCICIO porque regulariza estas cuentas contra
// 8.1.01.01 y dejaría el estado en cero. @lote filtra por lote de 73 días (lote_id).
const CUENTAS_DE_RESULTADO = `
  SELECT c.codigo, c.nombre, c.nivel, c.naturaleza
    FROM cuentas c
   WHERE c.activa = 1
     AND (c.codigo LIKE '5.%' OR c.codigo LIKE '6.1.02.%' OR c.codigo LIKE '7.%')
   ORDER BY c.codigo`;

const ESTADO_RESULTADOS_MOVIMIENTOS = `
  SELECT c.codigo,
         CAST(SUM(ROUND(d.debe  * 100)) AS INTEGER) AS debe_c,
         CAST(SUM(ROUND(d.haber * 100)) AS INTEGER) AS haber_c
    FROM asiento_detalle d
    JOIN asientos a ON a.id = d.asiento_id
    JOIN cuentas  c ON c.id = d.cuenta_id
   WHERE a.estado IN ${ESTADOS_VISIBLES}
     AND a.tipo <> 'CIERRE_EJERCICIO'
     AND (c.codigo LIKE '5.%' OR c.codigo LIKE '6.1.02.%' OR c.codigo LIKE '7.%')
     AND (@ej    IS NULL OR a.ejercicio_id = @ej)
     AND (@desde IS NULL OR a.fecha >= @desde)
     AND (@hasta IS NULL OR a.fecha <= @hasta)
     AND (@lote  IS NULL OR d.lote_id = @lote)
   GROUP BY c.codigo`;

// Memo informativo del lote: costo acumulado en 6.1.01.0X (aún no pasa a resultados;
// pasa al inventario al cierre y a 6.1.02.0X al vender — MAN-01 §7.1 y PC-08 §B).
const COSTO_EN_PROCESO_LOTE = `
  SELECT ROUND(COALESCE(SUM(monto), 0), 2) AS monto
    FROM v_hoja_costos_lote WHERE lote_id = ?`;

const LOTE_POR_ID_O_CODIGO = `
  SELECT l.id, l.codigo, l.estado, l.fecha_inicio, l.fecha_fin_prevista, l.ejercicio_id,
         cc.codigo AS centro_costo
    FROM lotes l JOIN centros_costo cc ON cc.id = l.centro_costo_id
   WHERE l.id = @id OR l.codigo = @codigo`;

// ---- 3) AUDITORÍA FISCAL RAU (PET-RAU-001 §1.4 / DS 24463 Art. 7) ----------------
// Todas las líneas de ingreso (Grupo 5, crédito) con sus textos; la búsqueda de los
// rótulos prohibidos se hace en el servicio (sin acentos ni mayúsculas).
const INGRESOS_PARA_AUDITORIA = `
  SELECT a.id AS asiento_id, a.numero, a.fecha, a.tipo, a.estado,
         a.glosa AS glosa_asiento, a.documento_respaldo,
         d.linea, d.glosa AS glosa_linea,
         c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre,
         CAST(ROUND(d.haber * 100) AS INTEGER) AS monto_c,
         l.codigo AS lote
    FROM asiento_detalle d
    JOIN asientos a   ON a.id = d.asiento_id
    JOIN cuentas  c   ON c.id = d.cuenta_id
    LEFT JOIN lotes l ON l.id = d.lote_id
   WHERE c.grupo = 5 AND d.haber > 0
     AND (@ej    IS NULL OR a.ejercicio_id = @ej)
     AND (@desde IS NULL OR a.fecha >= @desde)
     AND (@hasta IS NULL OR a.fecha <= @hasta)
   ORDER BY a.fecha, a.numero, d.linea`;

const CUENTAS_INGRESO_PLAN = `
  SELECT codigo, nombre, descripcion FROM cuentas WHERE grupo = 5 AND activa = 1 ORDER BY codigo`;

// I-1 Autoconsumo de alimento = qq consumo propio / qq producidos (lotes del Centro CC-02)
const INDICADOR_I1 = `
  SELECT COALESCE(SUM(l.qq_producidos), 0)     AS qq_producidos,
         COALESCE(SUM(l.qq_consumo_propio), 0) AS qq_consumo_propio,
         COALESCE(SUM(l.qq_excedente), 0)      AS qq_excedente,
         COUNT(*)                              AS lotes
    FROM lotes l JOIN centros_costo cc ON cc.id = l.centro_costo_id
   WHERE cc.codigo = 'CC-02' AND l.estado = 'CERRADO' AND l.qq_producidos > 0
     AND (@ej IS NULL OR l.ejercicio_id = @ej)`;

// I-2 Ventas de alimento / ingresos operativos (5.1.02.01 sobre cuenta 5.1)
const INDICADOR_I2 = `
  SELECT
    CAST(COALESCE(SUM(CASE WHEN c.codigo = '5.1.02.01'
            THEN ROUND(d.haber * 100) - ROUND(d.debe * 100) END), 0) AS INTEGER) AS alimento_c,
    CAST(COALESCE(SUM(ROUND(d.haber * 100) - ROUND(d.debe * 100)), 0) AS INTEGER) AS operativos_c
    FROM asiento_detalle d
    JOIN asientos a ON a.id = d.asiento_id
    JOIN cuentas  c ON c.id = d.cuenta_id
   WHERE a.estado IN ${ESTADOS_VISIBLES} AND a.tipo <> 'CIERRE_EJERCICIO'
     AND c.codigo LIKE '5.1.%'
     AND (@ej    IS NULL OR a.ejercicio_id = @ej)
     AND (@desde IS NULL OR a.fecha >= @desde)
     AND (@hasta IS NULL OR a.fecha <= @hasta)`;

module.exports = {
  EJERCICIOS,
  CUENTAS_TODOS_LOS_NIVELES,
  LOTES,
  LIBRO_MAYOR,
  CUENTA_POR_CODIGO,
  BALANCE_COMPROBACION,
  CUENTAS_DE_RESULTADO,
  ESTADO_RESULTADOS_MOVIMIENTOS,
  COSTO_EN_PROCESO_LOTE,
  LOTE_POR_ID_O_CODIGO,
  INGRESOS_PARA_AUDITORIA,
  CUENTAS_INGRESO_PLAN,
  INDICADOR_I1,
  INDICADOR_I2,
};
