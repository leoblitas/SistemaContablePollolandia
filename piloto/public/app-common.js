/* app-common.js — cabecera, selector de Rol Activo y utilidades compartidas por
   operaciones.html y kpis.html. Sin autenticación (demo): el rol viaja en la cabecera X-Rol. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bs = (n) => Number(n || 0).toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n, d = 2) => Number(n || 0).toLocaleString('es-BO', { minimumFractionDigits: d, maximumFractionDigits: d });
const hoy = () => new Date().toISOString().slice(0, 10);

const estado = { rol: null, permisos: new Set() };
const can = (p) => estado.permisos.has(p);

const TH = 'text-left font-medium text-stone-500 bg-stone-50 px-4 py-2.5';
const TD = 'px-4 py-2.5 border-t border-stone-100';
const BTN = 'rounded-lg px-3 py-1.5 text-sm font-medium';
const BTN_P = `${BTN} bg-brand-500 hover:bg-brand-600 text-white`;
const BTN_S = `${BTN} border border-stone-300 hover:bg-stone-100`;
const INPUT = 'border border-stone-300 rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-brand-500';
const chip = (txt, color) => `<span class="inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${color}">${esc(txt)}</span>`;
const CLASIF = { BUENO: 'bg-emerald-100 text-emerald-800', NORMAL: 'bg-amber-100 text-amber-800', MALO: 'bg-red-100 text-red-800' };

async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, {
    ...opciones,
    headers: { 'X-Rol': estado.rol, ...(opciones.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
  return datos;
}
const post = (ruta, cuerpo = {}) => api(ruta, { method: 'POST', body: JSON.stringify(cuerpo) });

function aviso(texto, error = false) {
  const t = $('#toast');
  t.textContent = texto;
  t.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 z-50 max-w-lg rounded-xl px-4 py-3 text-sm shadow-lg ' +
    (error ? 'bg-red-600 text-white' : 'bg-stone-900 text-white');
  t.hidden = false;
  clearTimeout(aviso._t);
  aviso._t = setTimeout(() => (t.hidden = true), error ? 7000 : 3500);
}
const intentar = (fn) => async (...a) => { try { await fn(...a); } catch (e) { aviso(e.message, true); } };

/* Cabecera común: pagina = 'inicio' | 'operaciones' | 'kardex' | 'kpis' | ... */
function pintarCabecera(pagina) {
  const enlace = (href, txt, clave, perm) =>
    `<a href="${href}" ${perm ? `data-perm="${perm}"` : ''} class="px-4 py-2.5 border-b-2 whitespace-nowrap ${pagina === clave ? 'border-brand-500 text-brand-700 font-medium' : 'border-transparent text-stone-500 hover:text-stone-800'}">${txt}</a>`;
  $('#cabecera').innerHTML = `
  <header class="bg-white border-b border-stone-200 sticky top-0 z-30">
    <div class="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-3 mr-auto">
        <div class="w-9 h-9 rounded-lg bg-brand-500 text-white grid place-items-center font-bold">P</div>
        <div>
          <h1 class="font-semibold leading-tight">Pollolandia Contable</h1>
          <p class="text-xs text-stone-500 leading-tight">Cooperativa Agropecuaria Pollolandia R.L.</p>
        </div>
        <span class="ml-2 text-xs font-medium bg-amber-100 text-amber-800 rounded-full px-2.5 py-1">DEMO · sin autenticación</span>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <span class="text-stone-600">Cambiar Rol Activo</span>
        <select id="selRol" class="border border-stone-300 rounded-lg bg-white px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand-500"></select>
      </label>
    </div>
    <nav class="max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto text-sm">
      ${enlace('index.html', 'Contabilidad', 'inicio')}
      ${enlace('operaciones.html', 'Faenado y ventas', 'operaciones', 'ventas.ver')}
      ${enlace('kardex.html', 'Compras y kardex', 'kardex', 'inventario.ver')}
      ${enlace('kpis.html', 'Indicadores (KPIs)', 'kpis', 'kpis.ver')}
      ${enlace('accounting/asignar-costos.html', 'Asignar costos', 'costos', 'costos.ver')}
      ${enlace('reports.html', 'Reportes y auditoría', 'reportes', 'reportes.ver')}
      ${enlace('instructivo.html', 'Instructivo', 'instructivo')}
    </nav>
  </header>
  <div id="toast" hidden class="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 max-w-lg rounded-xl px-4 py-3 text-sm shadow-lg"></div>`;
}

/* Arranque: carga roles, resuelve el rol activo (?rol= o el último usado) y avisa a la página. */
async function iniciarPagina(pagina, alCambiarRol) {
  pintarCabecera(pagina);
  const roles = await (await fetch('/api/roles')).json();
  $('#selRol').innerHTML = roles.map((r) => `<option value="${r.codigo}">${esc(r.etiqueta)}</option>`).join('');
  const aplicar = async (codigo) => {
    estado.rol = codigo;
    try { localStorage.setItem('rolActivo', codigo); } catch {}
    const yo = await api('/api/yo');
    estado.permisos = new Set(yo.permisos);
    $$('[data-perm]').forEach((el) => (el.hidden = !can(el.dataset.perm)));
    await alCambiarRol(yo);
  };
  $('#selRol').onchange = (e) => aplicar(e.target.value).catch((x) => aviso(x.message, true));
  let inicial = new URLSearchParams(location.search).get('rol');
  try { inicial ||= localStorage.getItem('rolActivo'); } catch {}
  if (!roles.some((r) => r.codigo === inicial)) inicial = roles[0].codigo;
  $('#selRol').value = inicial;
  await aplicar(inicial);
}
