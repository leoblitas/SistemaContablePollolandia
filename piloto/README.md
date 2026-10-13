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

**Pendiente / supuestos:** la fórmula del PMF quedó confirmada ((peso vivo − peso canal)/peso vivo × 100); no incluye el régimen de crédito desde 2028 (requiere resolución de la GG), la baja de mortalidad anormal a 7.2.01.04, pedidos/preventa ni provisión de incobrables. `SIN_DEMO_FASE4=1` arranca sin datos de ejemplo de la Fase 4.

---

## Fase 6 — Compras, kardex valorado (KV-08), proveedores RAU y formatos imprimibles

| Qué | Dónde |
|---|---|
| Tablas `proveedores`, `insumos`, `compras`, `compra_items`, `kardex_movimientos` (inmutable), `bitacora_consumos`, permisos `inventario.ver`, `compras.registrar`, `inventario.configurar` | `../database/fase6.sql` (se aplica sola al arrancar; idempotente) |
| Lógica: CPP, compras, pagos, consumo en bitácora, semáforo CI-FIN-16, datos de demo | `controllers/inventoryController.js` |
| Datos de los formatos CI-01 / CE-02 / CT-03 y EC-07 | `controllers/formatosController.js` |
| Rutas `/api/inventario/*` y `/api/formatos/*` | `routes/inventoryRoutes.js` |
| Pantalla de compras, kardex, proveedores, consumo y semáforo | `public/kardex.html` |
| Impresión de CI-01, CE-02, CT-03, MA-04, BS-05, KV-08, EC-07 | `public/formatos.js` (usado desde `index.html`, `reports.html`, `operaciones.html`, `kardex.html`) |
| Pruebas | `tests/inventario.test.js` (`npm test`) |

**Rutas:** `GET /api/inventario/insumos|resumen|catalogos|proveedores|compras|consumos` · `GET /api/inventario/kardex/:insumoId?desde=&hasta=` · `POST /api/inventario/insumos` · `POST /api/inventario/insumos/:id/parametros` · `POST /api/inventario/proveedores[/:id]` · `POST /api/inventario/compras` · `POST /api/inventario/compras/:id/pagar` · `POST /api/inventario/lotes/:loteId/bitacora` · `GET /api/formatos/asiento/:id` · `GET /api/formatos/estado-cuenta?tipo=cliente|proveedor&id=`.

**Reglas aplicadas**
- *Costo Promedio Ponderado (PC-07):* cada entrada recalcula `CPP = (valor del saldo + total de la entrada) / (cantidad del saldo + cantidad de la entrada)` (4 decimales); cada salida se valora al CPP vigente.
- *Compra (PR-FIN-03):* Dr 1.1.03.xx Inventario / Cr Caja o Banco (contado) o 2.1.01.xx Proveedores (crédito). El pago posterior genera el comprobante de egreso (Dr 2.1.01.xx / Cr Caja o Banco). Más de Bs 1.000: número de orden de compra aprobada por la GG. Más de Bs 5.000: mínimo 3 cotizaciones.
- *Proveedores RAU (PET-RAU-001, DS 24463):* no se procesa la compra sin nombre o razón social, C.I./NIT y Certificado RAU o de No Imponibilidad con su número.
- *Consumo desde la bitácora (día 1–73):* cada insumo sale del kardex al CPP y se genera un asiento por bitácora: Dr 6.1.01.0x (centro de costo, sufijo del insumo y lote) / Cr 1.1.03.xx. El costo aparece por sufijo en la hoja de costos del lote. Si se carga alimento balanceado en kg, el dato de la bitácora (ICA) se toma del kardex.
- *Semáforo de reorden (CI-FIN-16):* ROJO si el stock físico es menor al stock de seguridad; AMARILLO si está en o bajo el punto de reorden; VERDE si está por encima.

**Supuestos y límites (nada de esto está en los documentos entregados)**
- Los **niveles numéricos** de seguridad y reorden no figuran en CI-FIN-16: son parámetros editables por el Contador y los valores iniciales de la demo son **ilustrativos**.
- Los insumos de la **línea de alimento propio** (maíz, soya, afrecho, núcleo, aceite: sufijos 03–07, centro CC-02) están inactivos hasta 2027, como en el plan de cuentas. Para probarlos antes: variable de entorno `ACTIVAR_LINEA_ALIMENTO=1` (en Render: *Environment*). Aun activados, la matriz centro × sufijo sigue impidiendo cargarlos al lote de engorde CC-01.
- El texto de PET-RAU-001 no fue entregado: los datos obligatorios del vendedor siguen lo pedido en el encargo.
- Contado en efectivo → Caja (1.1.01.01); cheque, transferencia o débito → Banco (1.1.01.03).
- Los proveedores de la demo son ficticios. No hay pantalla de saldos iniciales de inventario.
- **HT-06 (Hoja de Trabajo)** no está implementada.
- El PMF ya no figura como provisional: (peso vivo − peso canal) / peso vivo × 100.
