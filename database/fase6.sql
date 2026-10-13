-- =============================================================================
-- fase6.sql — Compras, Kardex Valorado (KV-08, Costo Promedio Ponderado), Expediente de
-- Proveedores RAU y Punto de Reorden (CI-FIN-16).
-- Se aplica DESPUÉS de schema.sql y fase4.sql; es idempotente (IF NOT EXISTS / OR IGNORE).
--
-- Fuentes (documentos de la cooperativa):
--   * MPP PR-FIN-03 (abastecimiento de insumos críticos y cuentas por pagar): registro del ingreso
--     al inventario perpetuo al costo de adquisición (PC-07), cuentas por pagar 2.1.01.01-06,
--     Comprobante de Egreso, aprobación de la GG > Bs 1.000 y tres cotizaciones > Bs 5.000.
--   * PC-07 (Inventarios): sistema perpetuo, Costo Promedio Ponderado (CPP).
--   * MOF 2.2 / PET-RAU-001 / DS 24463: recibo con C.I. y certificado RAU o de no imponibilidad.
--   * CI-FIN-16: stock de seguridad y punto de reorden de insumos críticos.
--   * Manual de Costos MAN-01 §8.1: Dr 6.1.01.01 (por sufijo y lote) / Cr Inventario.
--   * Formulario KV-08 (MAN-06 §22.6).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Expediente de proveedores (PET-RAU-001): sin credenciales no hay compra
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proveedores (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre              TEXT NOT NULL CHECK (length(trim(nombre)) > 0),              -- nombre o razón social
    documento_identidad TEXT NOT NULL CHECK (length(trim(documento_identidad)) > 0), -- C.I. (o NIT)
    tipo_certificado    TEXT NOT NULL CHECK (tipo_certificado IN ('RAU', 'NO_IMPONIBILIDAD')),
    numero_certificado  TEXT NOT NULL CHECK (length(trim(numero_certificado)) > 0),  -- Nº del certificado RAU o de no imponibilidad
    telefono            TEXT,
    observaciones       TEXT,
    activo              INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
    creado_por          INTEGER REFERENCES usuarios(id),
    creado_en           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (documento_identidad)
);

-- -----------------------------------------------------------------------------
-- Catálogo de insumos críticos con saldo al Costo Promedio Ponderado (KV-08)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insumos (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo                TEXT NOT NULL UNIQUE CHECK (length(trim(codigo)) > 0),
    nombre                TEXT NOT NULL CHECK (length(trim(nombre)) > 0),
    categoria             TEXT NOT NULL CHECK (categoria IN ('ALIMENTO', 'MATERIA_PRIMA', 'NUCLEO', 'MEDICAMENTO', 'VACUNA', 'LIMPIEZA', 'CRIANZA', 'OTRO')),
    unidad                TEXT NOT NULL CHECK (unidad IN ('KG', 'QQ', 'LT', 'UND', 'DOSIS')),
    almacen               TEXT,                                                    -- almacén / ubicación (campo KV-08)
    sufijo_id             INTEGER NOT NULL REFERENCES sufijos_costo(id),           -- sufijo del Grupo 6 al consumir
    cuenta_inventario_id  INTEGER NOT NULL REFERENCES cuentas(id),                 -- 1.1.03.xx
    cuenta_proveedor_id   INTEGER NOT NULL REFERENCES cuentas(id),                 -- 2.1.01.xx
    stock_seguridad       NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (stock_seguridad >= 0),   -- CI-FIN-16 (= "stock mínimo" de KV-08)
    punto_reorden         NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (punto_reorden >= 0),     -- CI-FIN-16
    stock_maximo          NUMERIC(14,3) CHECK (stock_maximo IS NULL OR stock_maximo >= 0), -- KV-08
    cantidad_actual       NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (cantidad_actual >= 0),   -- stock físico = saldo del kardex
    valor_actual          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (valor_actual >= 0),
    costo_promedio        NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (costo_promedio >= 0),    -- CPP vigente
    activo                INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
    creado_en             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (punto_reorden >= stock_seguridad)
);

-- -----------------------------------------------------------------------------
-- Compras (entrada por compra de insumos) y su detalle
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compras (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha              DATE NOT NULL,
    proveedor_id       INTEGER NOT NULL REFERENCES proveedores(id),
    documento_tipo     TEXT NOT NULL CHECK (documento_tipo IN ('FACTURA', 'RECIBO')),
    documento_numero   TEXT NOT NULL CHECK (length(trim(documento_numero)) > 0),
    orden_compra       TEXT,                                                -- FIN-EGR-03 (obligatoria > Bs 1.000: aprobación de la GG)
    cotizaciones       INTEGER NOT NULL DEFAULT 0 CHECK (cotizaciones >= 0), -- mínimo 3 si la compra supera Bs 5.000
    condicion          TEXT NOT NULL CHECK (condicion IN ('CONTADO', 'CREDITO')),
    medio_pago         TEXT CHECK (medio_pago IN ('EFECTIVO', 'CHEQUE', 'TRANSFERENCIA', 'DEBITO')),
    fecha_vencimiento  DATE,
    total              NUMERIC(14,2) NOT NULL CHECK (total > 0),
    estado             TEXT NOT NULL CHECK (estado IN ('PAGADA', 'PENDIENTE')),
    asiento_id         INTEGER NOT NULL REFERENCES asientos(id),             -- ingreso al inventario (+ CxP o egreso)
    fecha_pago         DATE,
    medio_pago_final   TEXT CHECK (medio_pago_final IN ('EFECTIVO', 'CHEQUE', 'TRANSFERENCIA', 'DEBITO')),
    asiento_pago_id    INTEGER REFERENCES asientos(id),                      -- Comprobante de Egreso del pago de la CxP
    registrado_por     INTEGER NOT NULL REFERENCES usuarios(id),
    creado_en          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((condicion = 'CONTADO' AND medio_pago IS NOT NULL AND estado = 'PAGADA')
        OR (condicion = 'CREDITO' AND fecha_vencimiento IS NOT NULL AND (estado = 'PENDIENTE' OR (estado = 'PAGADA' AND fecha_pago IS NOT NULL AND medio_pago_final IS NOT NULL))))
);
CREATE INDEX IF NOT EXISTS idx_compras_estado ON compras(estado, fecha_vencimiento);

CREATE TABLE IF NOT EXISTS compra_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    compra_id       INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
    insumo_id       INTEGER NOT NULL REFERENCES insumos(id),
    cantidad        NUMERIC(14,3) NOT NULL CHECK (cantidad > 0),
    costo_unitario  NUMERIC(14,4) NOT NULL CHECK (costo_unitario > 0),     -- costo de adquisición (PC-07)
    total           NUMERIC(14,2) NOT NULL CHECK (total > 0)
);

-- -----------------------------------------------------------------------------
-- Kardex valorado (KV-08): una fila por movimiento, con el saldo resultante (CPP)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kardex_movimientos (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    insumo_id          INTEGER NOT NULL REFERENCES insumos(id),
    fecha              DATE NOT NULL,
    tipo               TEXT NOT NULL CHECK (tipo IN ('SALDO_INICIAL', 'ENTRADA_COMPRA', 'SALIDA_CONSUMO')),
    documento          TEXT,                                                -- Nº DOC. del formulario
    detalle            TEXT,                                                -- DETALLE / CONCEPTO
    cantidad           NUMERIC(14,3) NOT NULL CHECK (cantidad > 0),
    costo_unitario     NUMERIC(14,4) NOT NULL CHECK (costo_unitario >= 0),  -- P. Unit. Bs (entrada) o CPP vigente (salida)
    total              NUMERIC(14,2) NOT NULL CHECK (total >= 0),
    saldo_cantidad     NUMERIC(14,3) NOT NULL CHECK (saldo_cantidad >= 0),
    saldo_costo_unit   NUMERIC(14,4) NOT NULL CHECK (saldo_costo_unit >= 0),
    saldo_total        NUMERIC(14,2) NOT NULL CHECK (saldo_total >= 0),
    compra_id          INTEGER REFERENCES compras(id),
    lote_id            INTEGER REFERENCES lotes(id),
    bitacora_id        INTEGER REFERENCES lote_bitacora(id),
    asiento_id         INTEGER REFERENCES asientos(id),
    registrado_por     INTEGER REFERENCES usuarios(id),
    creado_en          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kardex_insumo ON kardex_movimientos(insumo_id, id);

-- El kardex es un registro histórico: no se edita ni se borra (se corrige con un movimiento contrario).
CREATE TRIGGER IF NOT EXISTS trg_kardex_no_update BEFORE UPDATE ON kardex_movimientos
BEGIN SELECT RAISE(ABORT, 'El kardex no se modifica: registre un movimiento de corrección'); END;
CREATE TRIGGER IF NOT EXISTS trg_kardex_no_delete BEFORE DELETE ON kardex_movimientos
BEGIN SELECT RAISE(ABORT, 'El kardex no se borra: registre un movimiento de corrección'); END;

-- -----------------------------------------------------------------------------
-- Consumo de insumos en la bitácora diaria del lote (día 1 a 73)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bitacora_consumos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bitacora_id     INTEGER NOT NULL REFERENCES lote_bitacora(id),
    insumo_id       INTEGER NOT NULL REFERENCES insumos(id),
    cantidad        NUMERIC(14,3) NOT NULL CHECK (cantidad > 0),
    costo_unitario  NUMERIC(14,4) NOT NULL CHECK (costo_unitario >= 0),   -- CPP vigente al consumir
    total           NUMERIC(14,2) NOT NULL CHECK (total >= 0),
    kardex_id       INTEGER NOT NULL REFERENCES kardex_movimientos(id),
    asiento_id      INTEGER REFERENCES asientos(id)                        -- Dr 6.1.01.0x (sufijo, lote) / Cr 1.1.03.xx
);
CREATE INDEX IF NOT EXISTS idx_bitcons_bitacora ON bitacora_consumos(bitacora_id);

-- -----------------------------------------------------------------------------
-- Permisos nuevos
-- -----------------------------------------------------------------------------
INSERT OR IGNORE INTO permisos (codigo, modulo, descripcion) VALUES
  ('inventario.ver',        'inventario', 'Consultar kardex valorado, insumos, semáforo de reorden y proveedores'),
  ('compras.registrar',     'inventario', 'Registrar compras de insumos, proveedores RAU y pago de cuentas por pagar'),
  ('inventario.configurar', 'inventario', 'Crear insumos y fijar stock de seguridad y punto de reorden (CI-FIN-16)');

INSERT OR IGNORE INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id FROM roles r, permisos p
WHERE (r.codigo IN ('GG', 'JF', 'CA', 'CV', 'UT') AND p.codigo = 'inventario.ver')
   OR (r.codigo = 'JF' AND p.codigo IN ('compras.registrar', 'inventario.configurar'));
