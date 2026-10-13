/**
 * Pollolandia Contable — servidor del piloto de demostración.
 *
 * SIN autenticación: el rol activo llega en la cabecera "X-Rol" (GG | JF | UT) y se usa
 * únicamente para aplicar los permisos del MOF definidos en database/seeds/01_roles_permisos.sql.
 * No hay contraseñas ni sesiones. NO publicar en Internet con datos reales.
 *
 * Sin dependencias: usa node:http y node:sqlite (Node.js >= 22.13).
 * Uso:  node --disable-warning=ExperimentalWarning server.js [--reset]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'pollolandia-demo.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Roles visibles en el selector (la base también define CA y CV, no se ofrecen en la demo)
const ROLES_DEMO = [
  { codigo: 'GG', etiqueta: 'Gerente General', usuario: 'demo_gg' },
  { codigo: 'JF', etiqueta: 'Contador / Jefe de Finanzas', usuario: 'demo_jf' },
  { codigo: 'UT', etiqueta: 'Operador de Granja', usuario: 'demo_ut' },
];

// ----------------------------------------------------------------------------- base de datos
function abrirBase() {
  if (process.argv.includes('--reset') && fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const nueva = !fs.existsSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  if (nueva) {
    const leer = (p) => fs.readFileSync(p, 'utf8');
    db.exec(leer(path.join(ROOT, 'database', 'schema.sql')));
    const seeds = path.join(ROOT, 'database', 'seeds');
    for (const f of fs.readdirSync(seeds).filter((x) => x.endsWith('.sql')).sort()) db.exec(leer(path.join(seeds, f)));
    db.exec(leer(path.join(__dirname, 'demo-datos.sql')));
    console.log(`Base de demostración creada en ${DB_PATH}`);
  }
  const fase4 = path.join(ROOT, 'database', 'fase4.sql');          // Fase 4 (idempotente)
  if (fs.existsSync(fase4)) db.exec(fs.readFileSync(fase4, 'utf8'));
  const fase6 = path.join(ROOT, 'database', 'fase6.sql');           // Fase 6: compras, kardex, proveedores RAU (idempotente)
  if (fs.existsSync(fase6)) db.exec(fs.readFileSync(fase6, 'utf8'));
  // Opcional (demo): habilita la línea de alimento propio CC-02 antes de 2027 (ver comentario de database/seeds/03_centros_sufijos.sql)
  if (process.env.ACTIVAR_LINEA_ALIMENTO === '1') {
    db.exec(`UPDATE sufijos_costo SET activo = 1 WHERE vigente_desde IS NOT NULL;
             UPDATE centros_costo SET activo = 1 WHERE codigo = 'CC-02';
             UPDATE cuentas SET activa = 1 WHERE vigente_desde IS NOT NULL;`);
  }
  return db;
}
const db = abrirBase();
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const tx = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

// ----------------------------------------------------------------------------- utilidades HTTP
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function enviarJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function leerJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) { reject(new HttpError(413, 'Cuerpo demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new HttpError(400, 'JSON inválido')); } });
    req.on('error', reject);
  });
}
const dinero = (v, campo) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${campo}: importe inválido`);
  return Math.round(n * 100) / 100;
};

// ----------------------------------------------------------------------------- "rol activo" (sin login)
function contexto(req) {
  const codigo = String(req.headers['x-rol'] || '').toUpperCase();
  const rol = ROLES_DEMO.find((r) => r.codigo === codigo);
  if (!rol) throw new HttpError(400, 'Rol activo no válido. Use GG, JF o UT en la cabecera X-Rol.');
  const permisos = all(
    `SELECT p.codigo FROM roles_permisos rp JOIN roles r ON r.id = rp.rol_id
     JOIN permisos p ON p.id = rp.permiso_id WHERE r.codigo = ?`, rol.codigo).map((x) => x.codigo);
  const usuario = get('SELECT id FROM usuarios WHERE username = ?', rol.usuario);
  return { rol, permisos: new Set(permisos), usuarioId: usuario.id };
}
const exigir = (ctx, permiso) => {
  if (!ctx.permisos.has(permiso)) throw new HttpError(403, `El rol ${ctx.rol.etiqueta} no tiene permiso para esta acción (${permiso}), según el MOF.`);
};

// ----------------------------------------------------------------------------- rutas API
const rutas = [];
const ruta = (metodo, patron, manejador) => rutas.push({ metodo, re: new RegExp(`^${patron}$`), manejador });

ruta('GET', '/api/roles', () => ROLES_DEMO.map(({ codigo, etiqueta }) => ({ codigo, etiqueta })));

ruta('GET', '/api/yo', (ctx) => ({ rol: ctx.rol.codigo, etiqueta: ctx.rol.etiqueta, permisos: [...ctx.permisos].sort() }));

ruta('GET', '/api/dashboard', (ctx) => {
  const r = {};
  if (ctx.permisos.has('asientos.ver')) {
    r.asientos = Object.fromEntries(all('SELECT estado, COUNT(*) n FROM asientos GROUP BY estado').map((x) => [x.estado, x.n]));
    r.pendientes_autorizacion = all(
      `SELECT id, numero, fecha, tipo, glosa FROM asientos WHERE estado = 'BORRADOR' AND tipo <> 'DIARIO' ORDER BY id`);
  }
  if (ctx.permisos.has('cuentas.ver')) r.cuentas = get('SELECT COUNT(*) n FROM cuentas WHERE nivel = 4 AND activa = 1').n;
  if (ctx.permisos.has('lotes.ver')) {
    r.lotes = all(
      `SELECT l.id, l.codigo, l.estado, l.fecha_inicio, l.fecha_fin_prevista, l.aves_iniciales,
              m.mortalidad_acumulada, m.pct_mortalidad, m.clasificacion,
              (SELECT MAX(dia_ciclo) FROM lote_bitacora WHERE lote_id = l.id) AS dia_actual
       FROM lotes l JOIN v_lote_mortalidad m ON m.lote_id = l.id ORDER BY l.id DESC`);
  }
  if (ctx.permisos.has('costos.ver')) {
    r.costo_acumulado = get(
      `SELECT ROUND(COALESCE(SUM(monto), 0), 2) total FROM v_hoja_costos_lote h JOIN lotes l ON l.id = h.lote_id WHERE l.estado = 'ABIERTO'`).total;
  }
  return r;
});

ruta('GET', '/api/cuentas', (ctx, req, url) => {
  exigir(ctx, 'cuentas.ver');
  const q = (url.searchParams.get('q') || '').trim();
  const nivel = Number(url.searchParams.get('nivel')) || 0;
  const filtros = []; const params = [];
  if (q) { filtros.push('(codigo LIKE ? OR nombre LIKE ?)'); params.push(`${q}%`, `%${q}%`); }
  if (nivel) { filtros.push('nivel = ?'); params.push(nivel); }
  return all(
    `SELECT codigo, nombre, nivel, naturaleza, es_imputable, es_centro_costo, activa, vigente_desde
     FROM cuentas ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''} ORDER BY codigo`, ...params);
});

ruta('GET', '/api/catalogos', (ctx) => {
  const r = {
    ejercicio: get(`SELECT id, codigo, fecha_inicio, fecha_fin FROM ejercicios_fiscales WHERE estado = 'ABIERTO' ORDER BY id DESC`),
    centros: all('SELECT id, codigo, nombre, unidad_medida, activo FROM centros_costo ORDER BY codigo'),
    lotes_abiertos: all(`SELECT l.id, l.codigo, cc.codigo AS centro FROM lotes l JOIN centros_costo cc ON cc.id = l.centro_costo_id WHERE l.estado = 'ABIERTO'`),
  };
  if (ctx.permisos.has('cuentas.ver')) {
    r.cuentas = all(
      `SELECT c.codigo, c.nombre, c.es_centro_costo, cc.codigo AS centro
       FROM cuentas c LEFT JOIN centros_costo cc ON cc.cuenta_id = c.id
       WHERE c.es_imputable = 1 AND c.activa = 1 ORDER BY c.codigo`);
    r.sufijos = all(
      `SELECT cc.codigo AS centro, s.codigo, s.nombre, s.elemento_costo
       FROM centro_costo_sufijos m JOIN centros_costo cc ON cc.id = m.centro_costo_id
       JOIN sufijos_costo s ON s.id = m.sufijo_id WHERE s.activo = 1 ORDER BY s.codigo`);
  }
  return r;
});

ruta('GET', '/api/asientos', (ctx, req, url) => {
  exigir(ctx, 'asientos.ver');
  const estado = url.searchParams.get('estado');
  return all(
    `SELECT a.id, a.numero, a.fecha, a.tipo, a.glosa, a.estado, a.documento_respaldo,
            ROUND(SUM(d.debe), 2) AS total, uc.nombre_completo AS creado_por, ua.nombre_completo AS autorizado_por
     FROM asientos a JOIN asiento_detalle d ON d.asiento_id = a.id
     JOIN usuarios uc ON uc.id = a.creado_por LEFT JOIN usuarios ua ON ua.id = a.autorizado_por
     ${estado ? 'WHERE a.estado = ?' : ''} GROUP BY a.id ORDER BY a.numero DESC`, ...(estado ? [estado] : []));
});

ruta('GET', '/api/asientos/(\\d+)', (ctx, req, url, [id]) => {
  exigir(ctx, 'asientos.ver');
  const a = get('SELECT * FROM asientos WHERE id = ?', Number(id));
  if (!a) throw new HttpError(404, 'Asiento no encontrado');
  a.lineas = all(
    `SELECT d.linea, c.codigo AS cuenta, c.nombre AS cuenta_nombre, d.debe, d.haber, cc.codigo AS centro, s.codigo AS sufijo, l.codigo AS lote
     FROM asiento_detalle d JOIN cuentas c ON c.id = d.cuenta_id
     LEFT JOIN centros_costo cc ON cc.id = d.centro_costo_id LEFT JOIN sufijos_costo s ON s.id = d.sufijo_id
     LEFT JOIN lotes l ON l.id = d.lote_id WHERE d.asiento_id = ? ORDER BY d.linea`, a.id);
  return a;
});

// Registrar asiento (Contador). DIARIO se contabiliza al instante; AJUSTE queda pendiente de la GG.
ruta('POST', '/api/asientos', async (ctx, req) => {
  exigir(ctx, 'asientos.registrar');
  const b = await leerJson(req);
  if (!['DIARIO', 'AJUSTE'].includes(b.tipo)) throw new HttpError(400, 'Tipo de asiento no permitido en la demo');
  if (!b.glosa || !String(b.glosa).trim()) throw new HttpError(400, 'La glosa es obligatoria');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha || '')) throw new HttpError(400, 'Fecha inválida (AAAA-MM-DD)');
  if (!Array.isArray(b.lineas) || b.lineas.length < 2) throw new HttpError(400, 'El asiento necesita al menos dos líneas');
  const ej = get(`SELECT id FROM ejercicios_fiscales WHERE estado = 'ABIERTO' ORDER BY id DESC`);
  return tx(() => {
    const numero = (get('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM asientos WHERE ejercicio_id = ?', ej.id)).n;
    const { lastInsertRowid: id } = run(
      `INSERT INTO asientos (ejercicio_id, numero, fecha, tipo, glosa, documento_respaldo, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ej.id, numero, b.fecha, b.tipo, String(b.glosa).trim(), b.documento_respaldo || null, ctx.usuarioId);
    b.lineas.forEach((l, i) => {
      const cuenta = get('SELECT id FROM cuentas WHERE codigo = ?', String(l.cuenta));
      if (!cuenta) throw new HttpError(400, `Línea ${i + 1}: cuenta ${l.cuenta} no existe`);
      const centro = l.centro ? get('SELECT id FROM centros_costo WHERE codigo = ?', String(l.centro)) : null;
      const sufijo = l.sufijo ? get('SELECT id FROM sufijos_costo WHERE codigo = ?', String(l.sufijo)) : null;
      run(`INSERT INTO asiento_detalle (asiento_id, linea, cuenta_id, debe, haber, centro_costo_id, sufijo_id, lote_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, i + 1, cuenta.id, dinero(l.debe || 0, `Línea ${i + 1} debe`), dinero(l.haber || 0, `Línea ${i + 1} haber`),
        centro ? centro.id : null, sufijo ? sufijo.id : null, l.lote_id ? Number(l.lote_id) : null);
    });
    if (b.tipo === 'DIARIO') run(`UPDATE asientos SET estado = 'CONTABILIZADO', contabilizado_en = CURRENT_TIMESTAMP WHERE id = ?`, id);
    return { id, numero, estado: b.tipo === 'DIARIO' ? 'CONTABILIZADO' : 'BORRADOR' };
  });
});

// Autorizar (Gerente General): ajustes y cierres requieren su autorización (MOF 2.2e)
ruta('POST', '/api/asientos/(\\d+)/autorizar', (ctx, req, url, [id]) => {
  exigir(ctx, 'asientos.autorizar');
  const a = get('SELECT estado FROM asientos WHERE id = ?', Number(id));
  if (!a) throw new HttpError(404, 'Asiento no encontrado');
  if (a.estado !== 'BORRADOR') throw new HttpError(409, 'Solo se pueden autorizar asientos en BORRADOR');
  tx(() => run(
    `UPDATE asientos SET autorizado_por = ?, autorizado_en = CURRENT_TIMESTAMP, estado = 'CONTABILIZADO', contabilizado_en = CURRENT_TIMESTAMP WHERE id = ?`,
    ctx.usuarioId, Number(id)));
  return { id: Number(id), estado: 'CONTABILIZADO' };
});

ruta('GET', '/api/balance', (ctx) => {
  exigir(ctx, 'reportes.ver');
  return all(`SELECT cuenta_codigo, cuenta_nombre, suma_debe, suma_haber, saldo_deudor, saldo_acreedor FROM v_balance_comprobacion ORDER BY cuenta_codigo`);
});

ruta('GET', '/api/lotes', (ctx) => {
  exigir(ctx, 'lotes.ver');
  return all(
    `SELECT l.id, l.codigo, cc.codigo AS centro, l.numero_ciclo, l.fecha_inicio, l.fecha_fin_prevista, l.estado, l.aves_iniciales,
            m.mortalidad_acumulada, m.pct_mortalidad, m.clasificacion,
            (SELECT MAX(dia_ciclo) FROM lote_bitacora WHERE lote_id = l.id) AS dia_actual
     FROM lotes l JOIN centros_costo cc ON cc.id = l.centro_costo_id JOIN v_lote_mortalidad m ON m.lote_id = l.id ORDER BY l.id DESC`);
});

ruta('POST', '/api/lotes', async (ctx, req) => {
  exigir(ctx, 'lotes.abrir');
  const b = await leerJson(req);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_inicio || '')) throw new HttpError(400, 'Fecha de inicio inválida (AAAA-MM-DD)');
  const aves = Number(b.aves_iniciales);
  if (!Number.isInteger(aves) || aves <= 0) throw new HttpError(400, 'Aves iniciales: número entero mayor a cero');
  const centro = get('SELECT id, codigo FROM centros_costo WHERE codigo = ?', String(b.centro || 'CC-01'));
  if (!centro) throw new HttpError(400, 'Centro de costo inexistente');
  const ej = get(`SELECT id, codigo FROM ejercicios_fiscales WHERE estado = 'ABIERTO' ORDER BY id DESC`);
  const ciclo = get('SELECT COALESCE(MAX(numero_ciclo), 0) + 1 AS n FROM lotes WHERE centro_costo_id = ? AND ejercicio_id = ?', centro.id, ej.id).n;
  const codigo = `L-${centro.codigo.replace('-', '')}-${ej.codigo}-${String(ciclo).padStart(2, '0')}`;
  const { lastInsertRowid: id } = run(
    `INSERT INTO lotes (codigo, centro_costo_id, ejercicio_id, numero_ciclo, fecha_inicio, fecha_fin_prevista, aves_iniciales, responsable_id)
     VALUES (?, ?, ?, ?, ?, date(?, '+72 days'), ?, ?)`,
    codigo, centro.id, ej.id, ciclo, b.fecha_inicio, b.fecha_inicio, aves, ctx.usuarioId);
  return { id, codigo };
});

ruta('GET', '/api/lotes/(\\d+)/bitacora', (ctx, req, url, [id]) => {
  exigir(ctx, 'lotes.ver');
  return all(
    `SELECT b.dia_ciclo, b.fecha, b.alimento_kg, b.mortalidad, b.novedad_sanitaria, u.nombre_completo AS registrado_por
     FROM lote_bitacora b JOIN usuarios u ON u.id = b.registrado_por WHERE b.lote_id = ? ORDER BY b.dia_ciclo DESC`, Number(id));
});

// Bitácora diaria (Operador de Granja)
ruta('POST', '/api/lotes/(\\d+)/bitacora', async (ctx, req, url, [id]) => {
  exigir(ctx, 'lotes.bitacora');
  const b = await leerJson(req);
  const fecha = b.fecha || new Date().toISOString().slice(0, 10);
  const morta = Number(b.mortalidad ?? 0);
  const alimento = Number(b.alimento_kg ?? 0);
  if (!Number.isInteger(morta) || morta < 0) throw new HttpError(400, 'Mortalidad: entero mayor o igual a cero');
  if (!Number.isFinite(alimento) || alimento < 0) throw new HttpError(400, 'Alimento: valor inválido');
  const lote = get('SELECT fecha_inicio FROM lotes WHERE id = ?', Number(id));
  if (!lote) throw new HttpError(404, 'Lote no encontrado');
  const dia = get(`SELECT CAST(julianday(?) - julianday(?) AS INTEGER) + 1 AS d`, fecha, lote.fecha_inicio).d;
  run(`INSERT INTO lote_bitacora (lote_id, fecha, dia_ciclo, alimento_kg, mortalidad, novedad_sanitaria, registrado_por) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    Number(id), fecha, dia, alimento, morta, b.novedad_sanitaria || null, ctx.usuarioId);
  return { dia_ciclo: dia };
});

ruta('GET', '/api/lotes/(\\d+)/costos', (ctx, req, url, [id]) => {
  exigir(ctx, 'costos.ver');
  const filas = all(`SELECT sufijo, sufijo_nombre, elemento_costo, monto FROM v_hoja_costos_lote WHERE lote_id = ? ORDER BY sufijo`, Number(id));
  const por_elemento = {};
  for (const f of filas) por_elemento[f.elemento_costo] = Math.round(((por_elemento[f.elemento_costo] || 0) + f.monto) * 100) / 100;
  const total = Math.round(Object.values(por_elemento).reduce((s, v) => s + v, 0) * 100) / 100;
  return { filas, por_elemento, total };
});

// ----------------------------------------------------------------------------- Fase 4
const fase4 = require('./routes/operationalRoutes')({ ruta, db, all, get, run, tx, exigir, HttpError, leerJson });
// Fases 2 y 5 (contabilidad y costos por lote; reportes y auditoría RAU): módulos externos montados sin Express
require('./routes/integracionRoutes')({ ruta, db, exigir, HttpError, leerJson });
const fase6r = require('./routes/inventoryRoutes')({ ruta, db, all, get, run, tx, exigir, HttpError, leerJson });
if (!process.env.SIN_DEMO_FASE4) { fase4.sembrarDemo(); fase6r.sembrarDemo(); }   // datos de ejemplo de la demo (una sola vez)

// ----------------------------------------------------------------------------- servidor
function servirEstatico(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const archivo = path.resolve(PUBLIC_DIR, rel);
  if (!archivo.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(archivo) || !fs.statSync(archivo).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(archivo)] || 'application/octet-stream' });
  fs.createReadStream(archivo).pipe(res);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return servirEstatico(req, res, url);
  try {
    for (const r of rutas) {
      const m = r.metodo === req.method && url.pathname.match(r.re);
      if (!m) continue;
      const ctx = url.pathname === '/api/roles' ? null : contexto(req);
      return enviarJson(res, 200, await r.manejador(ctx, req, url, m.slice(1)));
    }
    throw new HttpError(404, 'Ruta no encontrada');
  } catch (e) {
    if (e instanceof HttpError) return enviarJson(res, e.status, { error: e.message });
    // errores de CHECK / triggers de schema.sql: son reglas de negocio, se muestran tal cual
    let msg = String(e.message || e);
    if (/UNIQUE constraint failed: lote_bitacora/.test(msg)) msg = 'Ya existe un registro de bitácora para ese día del ciclo.';
    else if (/UNIQUE constraint failed: asientos/.test(msg)) msg = 'Número de asiento duplicado; intente nuevamente.';
    const esRegla = /constraint|inválid|descuadrado|asiento|sufijo|lote|cuenta|bitácora|ejercicio|fecha|ciclo/i.test(msg);
    if (!esRegla) console.error(e);
    return enviarJson(res, esRegla ? 400 : 500, { error: esRegla ? msg : 'Error interno del servidor' });
  }
});

servidor.listen(PORT, () => {
  console.log(`Pollolandia Contable (DEMO sin login) en http://localhost:${PORT}`);
});
