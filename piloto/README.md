# Piloto de demostración (sin autenticación)

Servidor Node.js + SQLite + dashboard Tailwind. **No hay login ni contraseñas**: el rol activo se elige en la barra superior y solo determina qué módulos y botones se muestran, según el MOF-FIN-001. El servidor aplica los mismos permisos (responde 403 si un rol intenta una acción que no le corresponde).

> Solo para demostraciones. No publicar en Internet con datos reales: cualquier persona con acceso puede cambiar de rol.

## Requisitos

- Node.js **22.13 o superior** (usa el SQLite integrado `node:sqlite`; **no hay que ejecutar `npm install`**).
- Conexión a Internet en el navegador (Tailwind se carga desde su CDN).

## Ejecutar

Desde la raíz del repositorio:

```bash
cd piloto
npm start            # o: node --disable-warning=ExperimentalWarning server.js
```

Abra <http://localhost:3000>. En el primer arranque se crea `piloto/data/pollolandia-demo.db` aplicando `database/schema.sql`, los seeds de `database/seeds/` y `piloto/demo-datos.sql` (un lote en el día 21, 3 asientos contabilizados y 1 ajuste pendiente de autorización).

- Otro puerto: `PORT=8080 npm start` (Windows PowerShell: `$env:PORT=8080; npm start`).
- Volver a los datos iniciales: `npm run reset`.

## Qué ve cada rol

| Rol | Módulos | Acciones |
|---|---|---|
| **Gerente General** | Panel, Plan de cuentas, Libro diario, Lotes y costos, Balance | Autoriza ajustes y cierres. No registra asientos. |
| **Contador / Jefe de Finanzas** | Panel, Plan de cuentas, Libro diario, Lotes y costos, Balance | Registra asientos, abre lotes, ve costos. No autoriza. |
| **Operador de Granja** | Panel y Lotes | Registra la bitácora diaria (alimento, mortalidad). No ve datos contables ni costos. |

Prueba sugerida de 2 minutos: como **Contador** registre un asiento de tipo *Ajuste* → cambie a **Gerente General** y autorícelo desde el Panel → cambie a **Operador de Granja** y registre la bitácora del día.

## Archivos

```
piloto/
├── server.js          # servidor HTTP + API REST + conexión directa a SQLite
├── package.json
├── demo-datos.sql     # usuarios demo y datos de ejemplo
└── public/
    └── index.html     # dashboard (Tailwind CSS), selector de rol
```

El servidor lee `../database/schema.sql` y `../database/seeds/`, por lo que la carpeta `database/` debe seguir en la raíz del repositorio.

---

## Fase 4 — Faenado, ventas y KPIs (sin login)

Reglas tomadas **solo** de los documentos de la cooperativa (Manual de Costos MAN-01, Anexo 4 POL-05, Anexos 7 y 8, MPP).

| Qué | Dónde |
|---|---|
| Tablas `lote_faenado`, `clientes`, `ventas`, trigger de crédito POL-05, permisos nuevos | `../database/fase4.sql` (el servidor la aplica sola al arrancar; es idempotente) |
| Fórmulas y umbrales ICA, ICL, PMF, RINC | `lib/kpis.js` (+ `tests/kpis.test.js`, `npm test`) |
| Faenado, cierre de ciclo, ventas, cobranza, datos de demo | `controllers/operationalController.js` |
| Indicadores | `controllers/kpiController.js` |
| Rutas `/api/operaciones/*` y `/api/kpis` | `routes/operationalRoutes.js` |
| Pantallas | `public/operaciones.html`, `public/kpis.html`, `public/app-common.js` |

**Flujo:** Contador (JF) registra el faenado el día 73 → queda un asiento `CIERRE_CICLO` en borrador (Dr 1.1.03.12 / Cr 6.1.01.01 por sufijo) → Gerente General (GG) aprueba: se contabiliza, el lote pasa a CERRADO y se fija el costo unitario Bs/kg de peso canal → el Contador vende (contado, o crédito solo a HORECA a 1 día con compromiso de pago firmado) → cobra los créditos.

**Indicadores** (nombres y umbrales según MAN-01 §9): ICA < 2,00 · ICL (Índice de Costo por Ventas) < 61 % · PMF (Porcentaje de Mermas en Faenado) < 10 % · RINC (Ratio de Ingresos No Cárnicos) ≥ 15 %.

**Pendiente / supuestos:** la fórmula del PMF está en blanco en el Manual (se usa merma/peso vivo, marcada *provisional*); no incluye el régimen de crédito desde 2028 (requiere resolución de la GG), la baja de mortalidad anormal a 7.2.01.04, pedidos/preventa ni provisión de incobrables. `SIN_DEMO_FASE4=1` arranca sin datos de ejemplo de la Fase 4.

---

## Ensamblado v1.0 — mapa de rutas y archivos (Fases 1-5)

| Fase | Rutas API (`X-Rol: GG\|JF\|UT`) | Archivos |
|---|---|---|
| 1 / 3 | `/api/roles`, `/api/yo`, `/api/dashboard`, `/api/cuentas`, `/api/catalogos`, `/api/asientos`, `/api/lotes`, `/api/balance` | `server.js`, `public/index.html` |
| 2 | `/api/contabilidad/asientos`, `/lotes`, `/lotes/:lote/costos`, `/lotes/:lote/hoja-costos`, `/catalogos/*` | `controllers/accountingController.js`, `services/accountingService.js`, `public/accounting/asignar-costos.html` |
| 4 | `/api/operaciones/*`, `/api/kpis` | `controllers/operationalController.js`, `kpiController.js`, `routes/operationalRoutes.js`, `lib/kpis.js`, `public/operaciones.html`, `public/kpis.html` |
| 5 | `/api/reportes/libro-mayor`, `/balance-comprobacion`, `/estado-resultados`, `/auditoria-rau`, `/catalogos` | `controllers/reportController.js`, `services/reportService.js`, `queries/reportQueries.js`, `public/reports.html` |

- `routes/integracionRoutes.js` monta los controladores de las Fases 2 y 5 (escritos para Express + better-sqlite3) en el servidor propio, **sin dependencias**; `lib/compat-db.js` aporta `db.transaction()` y `db.pragma()` sobre `node:sqlite`.
- En las Fases 2 y 5 los permisos del MOF se aplican por rol: registrar asientos/costos y abrir lotes solo el Contador (JF); reportes y auditoría RAU, GG y JF; el Operador (UT) no accede.
- Toda consulta SQL coincide con `database/schema.sql` (verificado ejecutando cada ruta contra la base real; ver `npm test`).
