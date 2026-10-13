/**
 * Fórmulas y umbrales de los indicadores técnicos de costo.
 * Fuente única de verdad: Manual del Sistema de Costos (MAN-01) §9.1, MPP (MAN-05) PR-FIN-04, PR-FIN-06, PR-FIN-09 y PR-FIN-10.
 * No se inventan indicadores ni umbrales: cada definición cita su fuente.
 */
'use strict';

const CLASES = { BUENO: 'BUENO', NORMAL: 'NORMAL', MALO: 'MALO', SIN_DATOS: 'SIN_DATOS' };

const INDICADORES = {
  ICA: {
    nombre: 'Índice de Conversión Alimenticia',
    formula: 'Kg de alimento consumido por el lote / Kg de carne viva obtenidos',
    unidad: 'kg/kg',
    umbrales: { bueno: '< 2,00', normal: '2,00 – 2,10', malo: '> 2,10' },
    fuente: 'MAN-01 §9.1; MPP PR-FIN-06 §7',
    clasificar: (v) => (v < 2.0 ? CLASES.BUENO : v <= 2.1 ? CLASES.NORMAL : CLASES.MALO),
  },
  ICL: {
    nombre: 'Índice de Costo por Ventas',
    formula: 'Costo de Producción / Ventas Totales Anuales × 100',
    unidad: '%',
    umbrales: { bueno: '< 61 %', normal: '61 % – 63 %', malo: '> 63 %' },
    fuente: 'MAN-01 §9.1; MPP PR-FIN-10 §7',
    clasificar: (v) => (v < 61 ? CLASES.BUENO : v <= 63 ? CLASES.NORMAL : CLASES.MALO),
  },
  PMF: {
    nombre: 'Porcentaje de Mermas en Faenado',
    formula: '(Peso vivo − Peso canal) / Peso vivo × 100',
    unidad: '%',
    umbrales: { bueno: '< 10 %', normal: '10 % – 20 %', malo: '> 20 %' },
    fuente: 'MAN-01 §9.1 (umbrales); MPP PR-FIN-04 (FIN-TRA-05 registra peso vivo, peso canal y merma)',
    clasificar: (v) => (v < 10 ? CLASES.BUENO : v <= 20 ? CLASES.NORMAL : CLASES.MALO),
  },
  RINC: {
    nombre: 'Ratio de Ingresos No Cárnicos',
    formula: '(Venta de Alimento Balanceado + Venta de Gallinaza) / Ventas Totales Anuales × 100',
    unidad: '%',
    // El documento dice "Bueno > 15 %" y "Meta 15 %"; se toma 15 % como meta cumplida (>= 15).
    umbrales: { bueno: '≥ 15 % (meta)', normal: '5 % – 14 %', malo: '< 5 %' },
    fuente: 'MAN-01 §9.1; MPP PR-FIN-09 §7',
    clasificar: (v) => (v >= 15 ? CLASES.BUENO : v >= 5 ? CLASES.NORMAL : CLASES.MALO),
  },
};

const positivo = (n) => Number.isFinite(n) && n > 0;
const redondear = (n, d = 2) => (n == null ? null : Math.round((n + Number.EPSILON) * 10 ** d) / 10 ** d);

const ica = (kgAlimento, kgCarneViva) => (positivo(kgCarneViva) ? kgAlimento / kgCarneViva : null);
const icl = (costoProduccion, ventasTotales) => (positivo(ventasTotales) ? (costoProduccion / ventasTotales) * 100 : null);
const pmf = (pesoVivoKg, pesoCanalKg) => (positivo(pesoVivoKg) ? ((pesoVivoKg - pesoCanalKg) / pesoVivoKg) * 100 : null);
const rinc = (ventaAlimento, ventaGallinaza, ventasTotales) =>
  positivo(ventasTotales) ? ((ventaAlimento + ventaGallinaza) / ventasTotales) * 100 : null;

/** Devuelve { codigo, valor, clasificacion, ... } listo para la API. */
function evaluar(codigo, valor) {
  const def = INDICADORES[codigo];
  const ok = valor != null && Number.isFinite(valor);
  return {
    codigo,
    nombre: def.nombre,
    formula: def.formula,
    umbrales: def.umbrales,
    fuente: def.fuente,
    valor: ok ? redondear(valor, 2) : null,
    clasificacion: ok ? def.clasificar(valor) : CLASES.SIN_DATOS, // se clasifica el valor sin redondear
  };
}

module.exports = { CLASES, INDICADORES, ica, icl, pmf, rinc, evaluar, redondear };
