/**
 * Controlador de KPIs técnicos de costo (MAN-01 §9.1): ICA, ICL, PMF y RINC.
 * Las fórmulas y umbrales viven en lib/kpis.js con su fuente documental.
 */
'use strict';

const { INDICADORES, ica, icl, pmf, rinc, evaluar, redondear } = require('../lib/kpis');

module.exports = function crearControlador(h) {
  const { all, get, exigir, HttpError } = h;

  const hoy = () => new Date().toISOString().slice(0, 10);

  function kpis(ctx, req, url) {
    exigir(ctx, 'kpis.ver');
    const ej = get(`SELECT id, codigo, fecha_inicio, fecha_fin FROM ejercicios_fiscales WHERE estado = 'ABIERTO' ORDER BY id DESC`);
    if (!ej) throw new HttpError(409, 'No hay un ejercicio fiscal abierto');
    const pedido = url.searchParams.get('hasta');
    if (pedido && !/^\d{4}-\d{2}-\d{2}$/.test(pedido)) throw new HttpError(400, 'Parámetro "hasta" inválido (AAAA-MM-DD)');
    const hasta = pedido || (hoy() >= ej.fecha_inicio && hoy() <= ej.fecha_fin ? hoy() : ej.fecha_fin);

    // --- ICL y RINC: acumulado del ejercicio ("Ventas Totales Anuales") -------------------------------------------
    // Solo asientos contabilizados (los anulados se compensan con su contra-asiento) y sin el cierre del ejercicio.
    const s = get(
      `SELECT
         COALESCE(SUM(CASE WHEN c.codigo = '5.1.01.01' THEN d.haber - d.debe END), 0) AS ventas_carne,
         COALESCE(SUM(CASE WHEN c.codigo = '5.1.02.01' THEN d.haber - d.debe END), 0) AS ventas_alimento,
         COALESCE(SUM(CASE WHEN c.codigo = '5.2.01.04' THEN d.haber - d.debe END), 0) AS ventas_gallinaza,
         COALESCE(SUM(CASE WHEN c.codigo IN ('6.1.02.01', '6.1.02.02') THEN d.debe - d.haber END), 0) AS costo_produccion
       FROM asiento_detalle d
       JOIN asientos a ON a.id = d.asiento_id
       JOIN cuentas c  ON c.id = d.cuenta_id
       WHERE a.estado IN ('CONTABILIZADO', 'ANULADO') AND a.tipo <> 'CIERRE_EJERCICIO'
         AND a.ejercicio_id = ? AND a.fecha <= ?`, ej.id, hasta);
    const ventasTotales = s.ventas_carne + s.ventas_alimento + s.ventas_gallinaza;

    // --- ICA y PMF: por lote con cierre aprobado ------------------------------------------------------------------
    const lotes = all(
      `SELECT l.id, l.codigo, f.fecha_faenado, f.peso_vivo_kg, f.peso_canal_kg, f.merma_kg, f.alimento_consumido_kg,
              l.costo_unitario, f.aves_faenadas
       FROM lote_faenado f JOIN lotes l ON l.id = f.lote_id
       WHERE f.estado = 'APROBADO' ORDER BY f.fecha_faenado DESC, l.id DESC`)
      .map((l) => ({
        lote: l.codigo, fecha_faenado: l.fecha_faenado, aves_faenadas: l.aves_faenadas,
        alimento_consumido_kg: l.alimento_consumido_kg, peso_vivo_kg: l.peso_vivo_kg, peso_canal_kg: l.peso_canal_kg,
        costo_unitario_bs_kg: l.costo_unitario,
        ica: evaluar('ICA', ica(l.alimento_consumido_kg, l.peso_vivo_kg)),
        pmf: evaluar('PMF', pmf(l.peso_vivo_kg, l.peso_canal_kg)),
      }));
    const pendientes = all(
      `SELECT l.codigo FROM lote_faenado f JOIN lotes l ON l.id = f.lote_id WHERE f.estado = 'PENDIENTE_APROBACION'`).map((x) => x.codigo);

    return {
      ejercicio: ej.codigo,
      periodo: { desde: ej.fecha_inicio, hasta },
      consolidado: {
        icl: evaluar('ICL', icl(s.costo_produccion, ventasTotales)),
        rinc: evaluar('RINC', rinc(s.ventas_alimento, s.ventas_gallinaza, ventasTotales)),
        componentes: {
          costo_produccion: redondear(s.costo_produccion),
          ventas_carne: redondear(s.ventas_carne),
          ventas_alimento: redondear(s.ventas_alimento),
          ventas_gallinaza: redondear(s.ventas_gallinaza),
          ventas_totales: redondear(ventasTotales),
        },
      },
      lotes,
      lotes_pendientes_de_aprobacion: pendientes,
      definiciones: Object.fromEntries(Object.entries(INDICADORES).map(([k, d]) => [k, {
        nombre: d.nombre, formula: d.formula, umbrales: d.umbrales, fuente: d.fuente, provisional: !!d.provisional,
      }])),
      notas: [
        'Costo de Producción (ICL) = Costo de Ventas acumulado del ejercicio (cuentas 6.1.02.01 y 6.1.02.02), como en la tabla 9.2 del Manual de Costos.',
        'Ventas Totales = ventas de carne (5.1.01.01) + alimento excedente (5.1.02.01) + gallinaza (5.2.01.04); el mismo denominador se usa en RINC.',
        'PMF: el Manual de Costos deja la fórmula en blanco; se calcula con los datos de FIN-TRA-05 (peso vivo, peso canal, merma) y debe ser confirmada por la Unidad de Finanzas.',
        'RINC: el documento indica "Bueno > 15 %" y "Meta 15 %"; aquí 15 % se considera meta cumplida. El tramo 14 %–15 % no está definido y se muestra como Normal.',
      ],
    };
  }

  return { kpis };
};
