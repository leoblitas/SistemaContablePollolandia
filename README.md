# Pollolandia Contable

Prueba piloto de una aplicación web de gestión contable para la **Cooperativa Agropecuaria Pollolandia R.L.** (Caranavi, Bolivia): producción avícola de ciclos de 73 días, costeo por absorción y control interno según el MOF del área financiera.

> **Estado:** piloto en construcción. Este repositorio contiene la estructura del proyecto, el esquema de base de datos (con las reglas de negocio ya aplicadas en la propia base) y los datos iniciales. La API de negocio se construye sobre ese esquema.

## Qué resuelve

| Necesidad | Cómo se cubre |
|---|---|
| Plan de cuentas oficial de la cooperativa | Plan de 4 niveles, Grupos 1-9 (190 cuentas cargadas). Solo el nivel 4 recibe movimientos. |
| Costeo por lote (MAN-01) | Sistema matricial: **centro de costo** (CC-01 Carne, CC-02 Alimento) × **sufijo** (-01 a -41) × **lote** de 73 días. |
| Partida doble con control interno | Libro diario con asientos inmutables, anulación por contrapartida y cuadre exigido por la base de datos. |
| Segregación de funciones (MOF 3.2) | 5 roles (GG, JF, CA, CV, UT). Quien registra no autoriza; los ajustes y cierres exigen autorización de otro usuario (GG). |
| Trazabilidad para el Consejo de Vigilancia | Bitácora de auditoría y vistas de libro diario, mayor, balance de comprobación y hoja de costos. |

## Arquitectura general

```
 Navegador (HTML + Jinja2 / HTMX)
        │ HTTP
 ┌──────▼───────────────────────────────────────────────┐
 │ app/api/v1      Routers FastAPI (auth, cuentas,       │  ← capa HTTP: valida entrada,
 │                 asientos, lotes, costos, reportes)    │    aplica permisos por rol
 ├───────────────────────────────────────────────────────┤
 │ app/services    Reglas de negocio: partida doble,     │  ← cierre de ciclo, prorrateo MOD,
 │                 costeo, cierre de ciclo, indicadores  │    mortalidad normal/anormal
 ├───────────────────────────────────────────────────────┤
 │ app/repositories  Acceso a datos (SQLAlchemy 2.0)     │
 ├───────────────────────────────────────────────────────┤
 │ SQLite (piloto)  ──migrable──►  PostgreSQL            │  ← database/schema.sql: CHECKs,
 │ database/schema.sql + seeds                           │    triggers y vistas
 └───────────────────────────────────────────────────────┘
```

**Decisiones de diseño**

- **Las reglas críticas viven también en la base de datos.** Asiento descuadrado, línea sobre un centro de costo sin sufijo o lote, sufijo no permitido para el centro, asiento contabilizado modificado, ajuste sin autorización: todo se rechaza con un `CHECK` o *trigger*, sin importar qué cliente escriba. La aplicación agrega permisos y mensajes claros encima.
- **Nada contabilizado se borra ni se edita.** Un error se corrige con un asiento de tipo `ANULACION` que revierte el original.
- **Un rol por usuario.** Evita por diseño que una misma persona acumule funciones incompatibles (MOF 3.3).
- **Dinero en `NUMERIC(14,2)`, moneda base Bolivianos (BOB).** Sin ajuste por inflación (Res. CTNAC N° 03/2020).
- **Python/FastAPI + SQLAlchemy 2.0.** Tipado, documentación OpenAPI automática en `/docs` y aritmética `Decimal` para cifras contables.

## Estructura del proyecto

```
pollolandia-contable/
├── .env.example                 # plantilla de configuración (el .env real NO se versiona)
├── .gitignore
├── README.md
├── requirements.txt
├── app/
│   ├── main.py                  # punto de entrada FastAPI (/health, /docs)
│   ├── core/                    # config.py · database.py · security.py
│   ├── api/v1/                  # routers HTTP
│   ├── services/                # reglas de negocio
│   ├── repositories/            # acceso a datos
│   ├── models/                  # modelos ORM (espejo de schema.sql)
│   ├── schemas/                 # esquemas Pydantic
│   └── web/                     # templates/ y static/ (interfaz)
├── database/
│   ├── schema.sql               # DDL completo: tablas, vistas, triggers
│   └── seeds/
│       ├── 01_roles_permisos.sql
│       ├── 02_plan_cuentas.sql
│       ├── 03_centros_sufijos.sql
│       └── 04_ejercicio_fiscal.sql
├── scripts/
│   ├── init_db.py               # crea la base: schema + seeds
│   └── create_user.py           # crea usuarios con rol MOF
├── tests/                       # pruebas del esquema y de la API
├── data/                        # base SQLite local (ignorada por git)
└── docs/                        # documentación; docs/fuentes/ está ignorada (ver abajo)
```

## Modelo de datos

| Bloque | Tablas |
|---|---|
| Seguridad (MOF) | `roles`, `permisos`, `roles_permisos`, `usuarios` |
| Período | `ejercicios_fiscales` (cierre al 30 de junio) |
| Plan de cuentas | `cuentas` (4 niveles, autorreferencia) |
| Costos (Grupo 6) | `centros_costo`, `sufijos_costo`, `centro_costo_sufijos` (matriz de aplicabilidad) |
| Libro diario | `asientos` (cabecera), `asiento_detalle` (líneas con centro/sufijo/lote opcionales) |
| Producción | `lotes` (ciclo de 73 días), `lote_bitacora` (alimento y mortalidad diarios) |
| Control | `auditoria_log` |
| Vistas | `v_libro_diario`, `v_libro_mayor`, `v_balance_comprobacion`, `v_hoja_costos_lote`, `v_lote_mortalidad` |

**Roles y permisos clave**

| Rol | Puede | No puede |
|---|---|---|
| **GG** Gerente General | Autorizar ajustes, cierres y anulaciones; aprobar cierre de ciclo; administrar usuarios | Registrar transacciones |
| **JF** Jefe de Finanzas – Contador | Registrar y contabilizar asientos, abrir y cerrar lotes | Autorizar desembolsos o ajustes; modificar el plan de cuentas |
| **CA** Consejo de Administración | Modificar el plan de cuentas | Registrar o autorizar asientos |
| **CV** Consejo de Vigilancia | Consultar todo y registrar verificaciones | Ejecutar, aprobar o registrar |
| **UT** Unidad Técnica | Registrar la bitácora del lote | Acceso contable |

**Supuestos tomados al cargar los datos** (revisarlos con el Contador General):

1. El plan de cuentas fuente repite el código `1.1.03.14`. Se conservó para *Materiales de mantenimiento* y la *Gallinaza* pasó a `1.1.03.15`. El Manual de Costos indica que la gallinaza no genera inventario, por lo que esa cuenta podría eliminarse.
2. Las cuentas y sufijos marcados `(*)` ("a partir de 2027": alimento balanceado propio) se cargan **inactivos** con `vigente_desde = 2027-01-01`, y el centro CC-02 también. Para activarlos, ver las instrucciones al inicio de `03_centros_sufijos.sql`.
3. El ejercicio fiscal inicial es `2026-2027` (1-jul-2026 a 30-jun-2027). Ajustar `04_ejercicio_fiscal.sql` si la cooperativa define otro período.

## Instalación paso a paso

**Requisitos:** Git, Python 3.11 o superior (SQLite ya viene incluido con Python).

1. **Clonar el repositorio**
   ```bash
   git clone <URL_DE_TU_REPOSITORIO>
   cd <carpeta-del-repositorio>
   ```

2. **Crear y activar un entorno virtual**
   ```bash
   python -m venv .venv
   source .venv/bin/activate        # Linux / macOS
   .venv\Scripts\activate           # Windows (PowerShell o CMD)
   ```

3. **Instalar dependencias**
   ```bash
   pip install -r requirements.txt
   ```

4. **Configurar el entorno**
   ```bash
   cp .env.example .env             # Windows: copy .env.example .env
   ```
   Edite `.env` y reemplace `SECRET_KEY` por un valor propio:
   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(48))"
   ```

5. **Crear la base de datos** (aplica `schema.sql` y los seeds; genera `data/pollolandia.db`)
   ```bash
   python scripts/init_db.py
   ```
   Para recrearla desde cero: `python scripts/init_db.py --reset` (borra los datos).

6. **Crear usuarios** (uno por cada rol que vaya a usar el piloto; la contraseña se pide por consola)
   ```bash
   python scripts/create_user.py --username gerente --nombre "Nombre Apellido" --rol GG
   python scripts/create_user.py --username contador --nombre "Nombre Apellido" --rol JF
   ```

7. **Ejecutar la aplicación**
   ```bash
   uvicorn app.main:app --reload
   ```
   Abra <http://127.0.0.1:8000/health> (estado) y <http://127.0.0.1:8000/docs> (documentación interactiva).

8. **Ejecutar las pruebas**
   ```bash
   pytest -q
   ```

## Migración a PostgreSQL

`schema.sql` está escrito en el subconjunto común de SQL. Al migrar:

- `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED BY DEFAULT AS IDENTITY`.
- Banderas `INTEGER 0/1` → `BOOLEAN` (y retirar sus `CHECK ... IN (0, 1)`).
- Reescribir la sección 10 (triggers) como funciones PL/pgSQL; la lógica de cada una está comentada.
- Cambiar `DATABASE_URL` a `postgresql+psycopg://usuario:clave@host:5432/pollolandia` e instalar `psycopg[binary]`.
- Adoptar Alembic para versionar los cambios de esquema.

## Documentación fuente y confidencialidad

El MOF, el Manual del Sistema de Costos y el Plan de Cuentas original tienen nivel de confidencialidad *Uso Interno / Restringido*. Si necesita tenerlos junto al proyecto, colóquelos en `docs/fuentes/`: esa carpeta está en `.gitignore` y no se sube a GitHub.

## Hoja de ruta sugerida

1. Modelos ORM y autenticación (login, sesión, permisos por rol).
2. Registro y contabilización de asientos con flujo de autorización.
3. Apertura de lotes, bitácora y cierre de ciclo (Informe de Costo de Ciclo, FIN-TRA-06).
4. Reportes: libro diario, mayor, balance de comprobación, hoja de costos, ICA/ICL/RINC.
5. Terceros (proveedores, clientes HORECA, socios) y cuentas por cobrar/pagar.
6. Activación de la línea de alimento balanceado (CC-02) en 2027.

## Fase 6 — Compras, kardex valorado y formatos imprimibles

Módulo de compras de insumos, kardex KV-08 a costo promedio ponderado, expediente de proveedores RAU, consumo desde la bitácora del lote con asiento automático del Grupo 6, semáforo de reorden (CI-FIN-16) e impresión de los formatos CI-01, CE-02, CT-03, MA-04, BS-05, KV-08 y EC-07. Detalle, rutas y supuestos: `piloto/README.md` (sección *Fase 6*). Esquema: `database/fase6.sql`. Pantalla: `/kardex.html`.
