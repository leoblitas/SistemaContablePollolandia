/* formatos.js — impresión de los formatos controlados del Modelo de Formatos del Sistema Contable (MAN-06 §22):
   CI-01, CE-02, CT-03 (comprobantes), MA-04 (mayor), BS-05 (balance de comprobación), KV-08 (kardex valorado), EC-07 (estado de cuenta).
   Cada función Formatos.html*(datos) devuelve el documento HTML completo (probable en pruebas); Formatos.imprimir(html)
   lo abre en un marco oculto y llama a la impresión del navegador. HT-06 (Hoja de Trabajo) no está implementado. */
(function (root) {
  'use strict';
  var UN = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE',
    'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIÚN', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO',
    'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
  var DEC = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  var CEN = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

  function menorMil(n) {
    if (n === 0) return '';
    if (n === 100) return 'CIEN';
    var c = Math.floor(n / 100), r = n % 100, s = CEN[c];
    if (r === 0) return s;
    var resto = r < 30 ? UN[r] : DEC[Math.floor(r / 10)] + (r % 10 ? ' Y ' + UN[r % 10] : '');
    return (s ? s + ' ' : '') + resto;
  }
  function enteroALetras(n) {
    if (n === 0) return 'CERO';
    var partes = [], millones = Math.floor(n / 1000000), miles = Math.floor((n % 1000000) / 1000), unidades = n % 1000;
    if (millones) partes.push(millones === 1 ? 'UN MILLÓN' : enteroALetras(millones).replace(/UN$/, 'UN') + ' MILLONES');
    if (miles) partes.push(miles === 1 ? 'MIL' : menorMil(miles).replace(/UNO$/, 'UN').replace(/ UN$/, ' UN') + ' MIL');
    if (unidades) partes.push(menorMil(unidades));
    return partes.join(' ').replace('VEINTIÚN MIL', 'VEINTIÚN MIL');
  }
  /** 17200.5 → "Son: DIECISIETE MIL DOSCIENTOS 50/100 Bolivianos" */
  function montoEnLetras(monto) {
    var c = Math.round(Math.abs(Number(monto) || 0) * 100), ent = Math.floor(c / 100), cen = c % 100;
    return 'Son: ' + enteroALetras(ent) + ' ' + (cen < 10 ? '0' : '') + cen + '/100 Bolivianos';
  }

  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var nf = new Intl.NumberFormat('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var nf4 = new Intl.NumberFormat('es-BO', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  var nf3 = new Intl.NumberFormat('es-BO', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  var m2 = function (n) { return n === null || n === undefined || n === '' ? '' : nf.format(Number(n)); };
  var m2z = function (n) { return Number(n) ? nf.format(Number(n)) : ''; };
  var fechaDMA = function (f) { return f ? String(f).slice(0, 10).split('-').reverse().join(' / ') : 'DD / MM / AAAA'; };
  var box = function (marcado, txt) { return '<span class="chk">' + (marcado ? '☒' : '☐') + '</span> ' + esc(txt); };

  var CSS = '@page{size:A4 portrait;margin:12mm}body{font:11px/1.35 Arial,Helvetica,sans-serif;color:#000;margin:0}' +
    '.land{} h1,h2,h3{margin:0}.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px}' +
    '.cab{text-align:center;flex:1}.cab b{font-size:13px;display:block}.cab span{font-size:10px}.cab h2{font-size:14px;margin-top:6px;letter-spacing:.5px}' +
    '.cod{font-size:10px;text-align:right;min-width:110px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:3px 18px;margin:6px 0}' +
    '.f{border-bottom:1px solid #000;padding:2px 0;min-height:15px}.f i{font-style:normal;font-weight:700;margin-right:4px}' +
    'table{width:100%;border-collapse:collapse;margin:6px 0}th,td{border:1px solid #000;padding:2px 4px;font-size:10px}th{background:#eee}' +
    'td.n,th.n{text-align:right;white-space:nowrap}tr.s td{font-weight:700;background:#f3f3f3}.firmas{display:flex;gap:18px;margin-top:46px}' +
    '.firmas div{flex:1;border-top:1px solid #000;text-align:center;padding-top:3px;font-size:10px}.firmas small{display:block;font-weight:700}' +
    '.son{margin:6px 0;font-weight:700}.pie{margin-top:14px;font-size:9px;text-align:center;color:#444}.chk{font-family:"Segoe UI Symbol",Arial}' +
    '.sep{margin:4px 0}';
  var CSS_LAND = '@page{size:A4 landscape;margin:10mm}';

  function marco(titulo, cuerpo, apaisado) {
    return '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>' + esc(titulo) + '</title><style>' + CSS + (apaisado ? CSS_LAND : '') +
      '</style></head><body>' + cuerpo + '</body></html>';
  }
  function cabecera(titulo, codigo, copias) {
    return '<div class="top"><div style="min-width:110px"></div><div class="cab"><b>COOPERATIVA AGROPECUARIA POLLOLANDIA R.L.</b><span>Registro contable · La Paz, Bolivia</span>' +
      '<h2>' + esc(titulo) + '</h2></div><div class="cod"><b>Formulario ' + esc(codigo) + '</b><br>' + (copias || '') + '</div></div>';
  }
  function firmas(lista) {
    return '<div class="firmas">' + lista.map(function (f) { return '<div><small>' + esc(f[0]) + '</small>' + esc(f[1] || '') + '</div>'; }).join('') + '</div>';
  }
  var PIE = '<div class="pie">Cooperativa Agropecuaria Pollolandia R.L. · Familia de formatos contables</div>';

  /* ---------- Comprobantes diarios: tipo = 'CI-01' | 'CE-02' | 'CT-03'. datos = respuesta de /api/formatos/asiento/:id ---------- */
  function htmlComprobante(d, tipo) {
    tipo = tipo || d.sugerido;
    var a = d.asiento, t = d.tercero || {}, fp = d.forma_pago || '', r = d.respaldo || {};
    var N = String(a.numero);
    var filas = d.lineas.map(function (l) {
      return '<tr><td>' + esc(l.cuenta) + '</td><td>' + esc(l.cuenta_nombre) + (l.centro ? ' <small>[' + esc(l.centro) + (l.sufijo ? ' · suf. ' + esc(l.sufijo) : '') + (l.lote ? ' · ' + esc(l.lote) : '') + ']</small>' : '') +
        '</td><td class="n"></td><td class="n">' + m2z(l.debe) + '</td><td class="n">' + m2z(l.haber) + '</td></tr>';
    }).join('');
    var tabla = '<table><thead><tr><th>CÓDIGO</th><th>DENOMINACIÓN</th><th class="n">PARCIAL</th><th class="n">DEBE</th><th class="n">HABER</th></tr></thead><tbody>' + filas +
      '<tr class="s"><td colspan="3" style="text-align:right">TOTALES Bs.</td><td class="n">' + m2(d.total) + '</td><td class="n">' + m2(d.total) + '</td></tr></tbody></table>';
    var moneda = '<div class="f"><i>Moneda:</i> ' + box(true, 'Bolivianos (Bs.)') + ' &nbsp; ' + box(false, 'Dólares ($us.)') + '</div>';
    var estado = a.estado && a.estado !== 'CONTABILIZADO' ? '<p class="sep"><b>Estado del asiento:</b> ' + esc(a.estado) + '</p>' : '';
    var glosa = '<div class="f"><i>Por concepto de / Glosa:</i> ' + esc(a.glosa) + '</div>' + estado;
    var son = '<div class="son">' + esc(montoEnLetras(d.total)) + '</div>';
    var respaldoLinea = function (extra) {
      var rt = (r.tipo || '').toUpperCase(), doc = a.documento_respaldo || '';
      return '<div class="f"><i>Documentos de respaldo:</i> ' + box(rt === 'FACTURA', 'Factura N° ' + (rt === 'FACTURA' ? r.numero : '______')) + ' &nbsp; ' +
        box(rt === 'RECIBO', 'Recibo N° ' + (rt === 'RECIBO' ? r.numero : '______')) + ' &nbsp; ' + extra +
        (r.orden_compra ? ' &nbsp; ' + box(true, 'Orden de compra ' + r.orden_compra) : '') +
        (!rt && doc ? ' &nbsp; ' + box(true, 'Otro: ' + doc) : '') + '</div>';
    };
    var cab, cuerpo;
    if (tipo === 'CI-01') {
      cab = cabecera('COMPROBANTE DE INGRESO', 'CI-01', 'Original: Contabilidad<br>Copia: Tesorería');
      cuerpo = '<div class="grid"><div class="f"><i>Comprobante Ingreso N°</i> ' + N + '</div><div class="f"><i>Lugar:</i> La Paz &nbsp; <i>Fecha:</i> ' + fechaDMA(a.fecha) + '</div>' +
        '<div class="f"><i>Recibí de:</i> ' + esc(t.nombre || '') + '</div><div class="f"><i>T/C:</i></div>' +
        '<div class="f"><i>CI / NIT:</i> ' + esc(t.documento || '') + '</div>' + moneda + '</div>' +
        '<div class="f"><i>Forma de ingreso:</i> ' + ['EFECTIVO', 'CHEQUE', 'DEPOSITO', 'TRANSFERENCIA'].map(function (x) { return box(fp === x, x.charAt(0) + x.slice(1).toLowerCase()); }).join(' &nbsp; ') +
        ' &nbsp; <i>Banco / N° de cuenta:</i> ' + esc(d.banco || '') + '</div>' + glosa + tabla + son +
        respaldoLinea(box(false, 'Boleta de depósito')) +
        firmas([['Preparado por:', 'AUXILIAR CONTABLE'], ['Revisado por:', 'CONTADOR'], ['Aprobado por:', 'GERENTE FINANCIERO'], ['Entregué conforme:', 'DEPOSITANTE · C.I.']]);
    } else if (tipo === 'CE-02') {
      cab = cabecera('COMPROBANTE DE EGRESO', 'CE-02', 'Original: Contabilidad<br>Copia: Tesorería');
      cuerpo = '<div class="grid"><div class="f"><i>Comprobante Egreso N°</i> ' + N + '</div><div class="f"><i>Lugar:</i> La Paz &nbsp; <i>Fecha:</i> ' + fechaDMA(a.fecha) + '</div>' +
        '<div class="f"><i>Pagado a:</i> ' + esc(t.nombre || '') + '</div><div class="f"><i>T/C:</i></div>' +
        '<div class="f"><i>CI / NIT:</i> ' + esc(t.documento || '') + '</div>' + moneda + '</div>' +
        '<div class="f"><i>Forma de pago:</i> ' + [['EFECTIVO', 'Efectivo'], ['CHEQUE', 'Cheque N° ______'], ['TRANSFERENCIA', 'Transferencia'], ['DEBITO', 'Débito']].map(function (x) { return box(fp === x[0], x[1]); }).join(' &nbsp; ') +
        ' &nbsp; <i>Banco / N° de cuenta:</i> ' + esc(d.banco || '') + '</div>' + glosa + tabla + son +
        respaldoLinea(box(false, 'Planilla') + ' &nbsp; ' + box(false, 'Contrato')) +
        firmas([['Preparado por:', 'AUXILIAR CONTABLE'], ['Revisado por:', 'CONTADOR'], ['Aprobado por:', 'GERENTE FINANCIERO'], ['Recibí conforme:', 'BENEFICIARIO · C.I.']]);
    } else {
      var tt = d.tipo_traspaso || 'OTRO';
      var tipos = [['APERTURA', 'Apertura'], ['AJUSTE', 'Ajuste'], ['DEPRECIACION', 'Depreciación / Amortización'], ['RECLASIFICACION', 'Reclasificación'], ['REGULARIZACION', 'Regularización'], ['CIERRE', 'Cierre'], ['OTRO', 'Otro']];
      var cc = d.lineas.filter(function (l) { return l.centro; }).map(function (l) { return l.centro; }).filter(function (v, i, s) { return s.indexOf(v) === i; }).join(', ');
      cab = cabecera('COMPROBANTE DE TRASPASO', 'CT-03', 'Original: Contabilidad');
      cuerpo = '<div class="grid"><div class="f"><i>Comprobante Traspaso N°</i> ' + N + '</div><div class="f"><i>Lugar:</i> La Paz &nbsp; <i>Fecha:</i> ' + fechaDMA(a.fecha) + '</div></div>' +
        '<div class="f"><i>Tipo de traspaso:</i> ' + tipos.map(function (x) { return box(tt === x[0], x[1]); }).join(' &nbsp; ') + '</div>' +
        '<div class="grid"><div class="f"><i>Documento de origen:</i> ' + esc(a.documento_respaldo || '') + '</div><div class="f"><i>T/C:</i></div>' + moneda +
        '<div class="f"><i>Galpón / Centro de costo:</i> ' + esc(cc) + '</div></div>' + glosa + tabla + son +
        '<div class="f"><i>Documentos de respaldo:</i> ' + box(false, 'Planilla de depreciación') + ' &nbsp; ' + box(false, 'Informe de inventario') + ' &nbsp; ' + box(false, 'Acta') + ' &nbsp; ' + box(!!a.documento_respaldo, 'Otro: ' + (a.documento_respaldo || '____________')) + '</div>' +
        firmas([['Preparado por:', 'AUXILIAR CONTABLE'], ['Revisado por:', 'CONTADOR'], ['Aprobado por:', 'GERENTE FINANCIERO']]);
    }
    return marco(tipo + ' N° ' + N, cab + cuerpo + PIE);
  }

  /* ---------- MA-04: datos = reporte de /api/reportes/libro-mayor (reporte.cuentas[i]); una hoja por cuenta ---------- */
  function htmlMayor(rep) {
    var f = rep.filtro || {};
    var hojas = rep.cuentas.map(function (c, i) {
      var filas = c.movimientos.map(function (m) {
        return '<tr><td>' + esc(m.fecha) + '</td><td>' + esc(m.comprobante) + '</td><td>' + esc(m.tipo + (m.estado === 'ANULADO' ? ' (anulado)' : '')) + '</td><td>' + esc(m.auxiliar || '') + '</td><td>' + esc(m.glosa || '') +
          '</td><td>' + esc(m.doc_ref || '') + '</td><td class="n">' + m2z(m.debe) + '</td><td class="n">' + m2z(m.haber) + '</td><td class="n">' + m2(m.saldo) + '</td><td>' + esc(m.da) + '</td></tr>';
      }).join('');
      return '<div style="' + (i ? 'page-break-before:always' : '') + '">' + cabecera('REGISTRO DE MAYOR ANALÍTICO DE CUENTA', 'MA-04', 'Hoja N° ' + (i + 1) + ' de ' + rep.cuentas.length) +
        '<div class="grid"><div class="f"><i>Código de cuenta:</i> ' + esc(c.codigo) + '</div><div class="f"><i>Gestión:</i> ' + esc(f.ejercicio || '') + ' (' + esc(f.desde) + ' al ' + esc(f.hasta) + ')</div>' +
        '<div class="f"><i>Denominación:</i> ' + esc(c.nombre) + '</div><div class="f"><i>Saldo anterior Bs.:</i> ' + m2(c.saldo_anterior) + ' ' + esc(c.saldo_anterior_da || '') + '</div>' +
        '<div class="f"><i>Naturaleza:</i> ' + box(c.naturaleza === 'DEUDORA', 'Deudora') + ' ' + box(c.naturaleza === 'ACREEDORA', 'Acreedora') + '</div><div class="f"><i>Moneda:</i> ' + box(true, 'Bs.') + ' ' + box(false, '$us.') + '</div></div>' +
        '<table><thead><tr><th>Fecha</th><th>N° Comp.</th><th>Tipo</th><th>Cód. Auxiliar</th><th>GLOSA / DETALLE</th><th>Doc. Ref.</th><th class="n">DEBE</th><th class="n">HABER</th><th class="n">SALDO</th><th>D/A</th></tr></thead><tbody>' +
        '<tr class="s"><td colspan="8">SALDO ANTERIOR / TRASLADO</td><td class="n">' + m2(c.saldo_anterior) + '</td><td>' + esc(c.saldo_anterior_da || '') + '</td></tr>' + filas +
        '<tr class="s"><td colspan="6">SUMAS DEL PERÍODO Y SALDO FINAL Bs.</td><td class="n">' + m2(c.suma_debe) + '</td><td class="n">' + m2(c.suma_haber) + '</td><td class="n">' + m2(c.saldo_final) + '</td><td>' + esc(c.saldo_final_da || '') + '</td></tr></tbody></table>' +
        firmas([['Elaborado por:', 'Auxiliar Contable'], ['Revisado por:', 'CONTADOR'], ['Aprobado por:', 'GERENTE FINANCIERO']]) + '</div>';
    }).join('') || '<p>Sin movimientos.</p>';
    return marco('MA-04 ' + (f.cuenta || ''), hojas + PIE, true);
  }

  /* ---------- BS-05: datos = reporte de /api/reportes/balance-comprobacion ---------- */
  function htmlBalance(rep) {
    var f = rep.filtro || {}, t = rep.totales, v = rep.verificacion;
    var filas = rep.cuentas.map(function (c) {
      return '<tr><td>' + esc(c.n) + '</td><td>' + esc(c.codigo) + '</td><td>' + esc(c.nombre) + '</td><td class="n">' + m2z(c.debe) + '</td><td class="n">' + m2z(c.haber) + '</td><td class="n">' + m2z(c.deudor) + '</td><td class="n">' + m2z(c.acreedor) + '</td></tr>';
    }).join('');
    var dif = Math.max(v.diferencia_sumas || 0, v.diferencia_saldos || 0);
    var cuerpo = cabecera('BALANCE DE COMPROBACIÓN DE SUMAS Y SALDOS', 'BS-05', 'Hoja N° 1 de 1') +
      '<p style="text-align:center;margin:2px 0"><b>DEL ' + esc(fechaDMA(f.desde)) + ' AL ' + esc(fechaDMA(f.hasta)) + '</b><br>(Expresado en Bolivianos)' + (f.antes_de_ajustes ? ' · antes de ajustes' : '') + '</p>' +
      '<table><thead><tr><th rowspan="2">N°</th><th rowspan="2">CÓDIGO</th><th rowspan="2">DENOMINACIÓN DE LA CUENTA</th><th colspan="2">SUMAS</th><th colspan="2">SALDOS</th></tr>' +
      '<tr><th class="n">DEBE</th><th class="n">HABER</th><th class="n">DEUDOR</th><th class="n">ACREEDOR</th></tr></thead><tbody>' + filas +
      '<tr class="s"><td colspan="3" style="text-align:right">SUMAS IGUALES Bs.</td><td class="n">' + m2(t.debe) + '</td><td class="n">' + m2(t.haber) + '</td><td class="n">' + m2(t.deudor) + '</td><td class="n">' + m2(t.acreedor) + '</td></tr></tbody></table>' +
      '<p><b>Verificación:</b> ' + box(v.sumas_debe_igual_haber, 'Sumas Debe = Sumas Haber') + ' &nbsp; ' + box(v.saldos_deudores_igual_acreedores, 'Saldos Deudores = Saldos Acreedores') + ' &nbsp; Diferencia Bs.: ' + m2(dif) + '</p>' +
      firmas([['Elaborado por:', 'AUXILIAR CONTABLE'], ['Revisado por:', 'CONTADOR'], ['Aprobado por:', 'GERENTE FINANCIERO']]);
    return marco('BS-05 ' + (f.ejercicio || ''), cuerpo + PIE);
  }

  /* ---------- KV-08: datos = respuesta de /api/inventario/kardex/:id ---------- */
  function htmlKardex(k) {
    var i = k.insumo, sa = k.saldo_anterior, s = k.sumas || {};
    var filas = k.movimientos.map(function (m) {
      var ent = m.tipo === 'ENTRADA_COMPRA', sal = m.tipo === 'SALIDA_CONSUMO';
      return '<tr><td>' + esc(m.fecha) + '</td><td>' + esc(m.documento || '') + '</td><td>' + esc(m.detalle || '') + '</td>' +
        '<td class="n">' + (ent ? nf3.format(m.cantidad) : '') + '</td><td class="n">' + (ent ? nf4.format(m.costo_unitario) : '') + '</td><td class="n">' + (ent ? m2(m.total) : '') + '</td>' +
        '<td class="n">' + (sal ? nf3.format(m.cantidad) : '') + '</td><td class="n">' + (sal ? nf4.format(m.costo_unitario) : '') + '</td><td class="n">' + (sal ? m2(m.total) : '') + '</td>' +
        '<td class="n">' + nf3.format(m.saldo_cantidad) + '</td><td class="n">' + nf4.format(m.saldo_costo_unit) + '</td><td class="n">' + m2(m.saldo_total) + '</td></tr>';
    }).join('');
    var cuerpo = cabecera('KARDEX DE INVENTARIOS VALORADO', 'KV-08', 'Hoja N° 1 de 1') +
      '<div class="grid" style="grid-template-columns:1fr 1fr 1fr 1fr"><div class="f"><i>Producto:</i> ' + esc(i.nombre) + '</div><div class="f"><i>Código:</i> ' + esc(i.codigo) + '</div>' +
      '<div class="f"><i>Unidad de medida:</i> ' + esc(i.unidad) + '</div><div class="f"><i>Almacén / Ubicación:</i> ' + esc(i.almacen || '') + '</div>' +
      '<div class="f"><i>Método de valuación:</i> ' + esc(k.metodo_valuacion || 'Costo Promedio Ponderado') + '</div><div class="f"><i>Stock mínimo:</i> ' + nf3.format(i.stock_minimo) + '</div>' +
      '<div class="f"><i>Stock máximo:</i> ' + (i.stock_maximo == null ? '' : nf3.format(i.stock_maximo)) + '</div><div class="f"><i>Cuenta:</i> ' + esc(i.cuenta_inventario) + '</div></div>' +
      '<table><thead><tr><th rowspan="2">FECHA</th><th rowspan="2">N° DOC.</th><th rowspan="2">DETALLE / CONCEPTO</th><th colspan="3">ENTRADAS</th><th colspan="3">SALIDAS</th><th colspan="3">SALDO</th></tr>' +
      '<tr><th class="n">Cant.</th><th class="n">P. Unit. Bs.</th><th class="n">Total Bs.</th><th class="n">Cant.</th><th class="n">P. Unit. Bs.</th><th class="n">Total Bs.</th><th class="n">Cant.</th><th class="n">Costo Unit. Bs.</th><th class="n">Total Bs.</th></tr></thead><tbody>' +
      '<tr class="s"><td colspan="3">SALDO INICIAL</td><td colspan="6"></td><td class="n">' + nf3.format(sa.cantidad) + '</td><td class="n">' + nf4.format(sa.costo_unitario) + '</td><td class="n">' + m2(sa.total) + '</td></tr>' + filas +
      '<tr class="s"><td colspan="3">SUMAS / TRASLADO A HOJA N° ______</td><td class="n">' + nf3.format(s.entradas_cantidad || 0) + '</td><td></td><td class="n">' + m2(s.entradas_total) + '</td><td class="n">' + nf3.format(s.salidas_cantidad || 0) + '</td><td></td><td class="n">' + m2(s.salidas_total) + '</td><td class="n">' + nf3.format(i.cantidad_actual) + '</td><td class="n">' + nf4.format(i.costo_promedio) + '</td><td class="n">' + m2(i.valor_actual) + '</td></tr></tbody></table>' +
      firmas([['Responsable de almacén:', 'ALMACENERO'], ['Revisado por:', 'CONTADOR'], ['Aprobado por:', 'JEFE DE PRODUCCIÓN / GERENTE']]);
    return marco('KV-08 ' + i.codigo, cuerpo + '<div class="pie">Caranavi, Los Yungas | Bolivia | Basado en ISO 9001:2015 | RAU</div>', true);
  }

  /* ---------- EC-07: datos = respuesta de /api/formatos/estado-cuenta ---------- */
  function htmlEstadoCuenta(e) {
    var filas = e.movimientos.map(function (m) {
      return '<tr><td>' + esc(m.fecha) + '</td><td>' + esc(m.tipo_doc || '') + '</td><td>' + esc(m.n_doc || '') + '</td><td>' + esc(m.detalle || '') + '</td><td class="n">' + m2z(m.cargo) + '</td><td class="n">' + m2z(m.abono) + '</td><td class="n">' + m2(m.saldo) + '</td></tr>';
    }).join('');
    var cuerpo = cabecera('ESTADO DE CUENTA', 'EC-07', 'Hoja N° 1 de 1') +
      '<div class="grid"><div class="f"><i>Tipo de cuenta:</i> ' + esc(e.tipo_cuenta) + '</div><div class="f"><i>Titular:</i> ' + esc(e.titular.nombre) + ' · CI/NIT ' + esc(e.titular.documento || '') + '</div>' +
      '<div class="f"><i>Código de cuenta:</i> ' + esc(e.titular.cuenta || '') + '</div><div class="f"><i>Moneda:</i> ' + box(true, 'Bs.') + ' ' + box(false, '$us.') + '</div>' +
      '<div class="f"><i>Período:</i> Del ' + fechaDMA(e.desde).replace('DD / MM / AAAA', '____ / ____ / ______') + ' Al ' + fechaDMA(e.hasta).replace('DD / MM / AAAA', '____ / ____ / ______') + '</div><div class="f"><i>Fecha de emisión:</i> ' + fechaDMA(e.emision) + '</div></div>' +
      '<table><thead><tr><th>FECHA</th><th>TIPO DOC.</th><th>N° DOC.</th><th>DETALLE / CONCEPTO</th><th class="n">CARGOS (DEBE)</th><th class="n">ABONOS (HABER)</th><th class="n">SALDO Bs.</th></tr></thead><tbody>' +
      '<tr class="s"><td colspan="6">SALDO ANTERIOR</td><td class="n">' + m2(e.saldo_anterior) + '</td></tr>' + filas +
      '<tr class="s"><td colspan="4">SUMAS Y SALDO ACTUAL Bs.</td><td class="n">' + m2(e.sumas.cargos) + '</td><td class="n">' + m2(e.sumas.abonos) + '</td><td class="n">' + m2(e.saldo_actual) + '</td></tr></tbody></table>' +
      '<div class="f"><i>Observaciones:</i></div>' +
      firmas([['Emitido por:', 'Auxiliar Contable'], ['Revisado por:', 'CONTADOR'], ['Conforme (titular de la cuenta):', 'NOMBRE · C.I. · FECHA']]);
    return marco('EC-07 ' + e.titular.nombre, cuerpo + PIE);
  }

  /* ---------- Impresión: marco oculto + window.print() ---------- */
  function imprimir(html) {
    var fr = document.createElement('iframe');
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(fr);
    var doc = fr.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    root.__ultimoFormato = html;     // permite revisar lo impreso (pruebas)
    setTimeout(function () {
      try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) { /* sin impresora */ }
      setTimeout(function () { fr.remove(); }, 60000);
    }, 150);
  }
  /** Obtiene los datos del servidor (con el rol activo) y abre la impresión. getJson(ruta) → Promise<objeto>. */
  function comprobante(getJson, asientoId, tipo) {
    return getJson('/api/formatos/asiento/' + asientoId).then(function (d) { imprimir(htmlComprobante(d, tipo)); return d; });
  }

  root.Formatos = { montoEnLetras: montoEnLetras, htmlComprobante: htmlComprobante, htmlMayor: htmlMayor, htmlBalance: htmlBalance,
    htmlKardex: htmlKardex, htmlEstadoCuenta: htmlEstadoCuenta, imprimir: imprimir, comprobante: comprobante };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Formatos;
})(typeof window !== 'undefined' ? window : globalThis);
