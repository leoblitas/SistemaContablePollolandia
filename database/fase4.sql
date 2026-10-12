-- =============================================================================
-- fase4.sql — Fase 4: Cierre de ciclo / faenado, ventas (HORECA y contado) y cobranza.
-- Se aplica DESPUÉS de schema.sql y es idempotente (IF NOT EXISTS / OR IGNORE): el servidor
-- la ejecuta en cada arranque, por lo que también actualiza bases creadas en la Fase 1.
--
-- Fuentes:
--   * MPP (MAN-05) PR-FIN-04 pasos 5-6 y PR-FIN-06 (faenado, FIN-TRA-05/06/07, cierre día 73)
--   * Anexo 7 (Ciclo de Transformación): conciliación de aves y umbral de mortalidad 5 %
--   * MPP PR-FIN-08, PR-FIN-09 y POL-05 (Manual de Políticas): crédito HORECA y venta al contado
--   * Manual del Sistema de Costos (MAN-01) §8.1: asientos de cierre y de venta
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Faenado del lote (FIN-TRA-05 Registro de Faenado + FIN-TRA-06 Informe de Costo de Ciclo)
-- Un registro por lote. Queda PENDIENTE_APROBACION hasta que la Gerencia General
-- aprueba el cierre; recién entonces se contabiliza el asiento y el lote pasa a CERRADO.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lote_faenado (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id                INTEGER NOT NULL UNIQUE REFERENCES lotes(id),
    fecha_faenado          DATE    NOT NULL,                               -- día 73 del ciclo
    aves_ingresadas        INTEGER NOT NULL CHECK (aves_ingresadas > 0),
    mortalidad_normal      INTEGER NOT NULL CHECK (mortalidad_normal  >= 0),   -- hasta 5 % de las aves iniciales
    mortalidad_anormal     INTEGER NOT NULL CHECK (mortalidad_anormal >= 0),   -- exceso sobre el 5 %
    aves_faenadas          INTEGER NOT NULL CHECK (aves_faenadas >= 0),
    peso_vivo_kg           NUMERIC(12,2) NOT NULL CHECK (peso_vivo_kg  > 0),   -- kg de carne viva obtenidos
    peso_canal_kg          NUMERIC(12,2) NOT NULL CHECK (peso_canal_kg > 0),   -- kg de producto terminado
    merma_kg               NUMERIC(12,2) NOT NULL CHECK (merma_kg >= 0),       -- peso vivo - peso canal
    alimento_consumido_kg  NUMERIC(12,2) NOT NULL CHECK (alimento_consumido_kg >= 0),   -- suma de la bitácora
    informe_veterinario    TEXT,                                           -- obligatorio si hay mortalidad anormal
    costo_total            NUMERIC(14,2) NOT NULL CHECK (costo_total > 0), -- saldo de 6.1.01.01 transferido
    estado                 TEXT NOT NULL DEFAULT 'PENDIENTE_APROBACION' CHECK (estado IN ('PENDIENTE_APROBACION', 'APROBADO')),
    asiento_cierre_id      INTEGER NOT NULL REFERENCES asientos(id),
    registrado_por         INTEGER NOT NULL REFERENCES usuarios(id),
    registrado_en          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    aprobado_por           INTEGER REFERENCES usuarios(id),
    aprobado_en            TIMESTAMP,
    -- FIN-TRA-06: Aves ingresadas = Mortalidad normal + Mortalidad anormal + Aves faenadas
    CHECK (aves_ingresadas = mortalidad_normal + mortalidad_anormal + aves_faenadas),
    CHECK (peso_canal_kg <= peso_vivo_kg),
    CHECK (ABS(merma_kg - (peso_vivo_kg - peso_canal_kg)) < 0.005),
    -- Anexo 7: toda mortalidad anormal exige informe veterinario
    CHECK (mortalidad_anormal = 0 OR (informe_veterinario IS NOT NULL AND length(trim(informe_veterinario)) > 0)),
    CHECK (estado = 'PENDIENTE_APROBACION' OR (aprobado_por IS NOT NULL AND aprobado_en IS NOT NULL)),
    CHECK (aprobado_por IS NULL OR aprobado_por <> registrado_por)       -- quien registra no aprueba (MOF 3.2)
);

-- -----------------------------------------------------------------------------
-- Clientes (PR-FIN-08 / PR-FIN-09): HORECA es el único sector con crédito (POL-05)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre     TEXT NOT NULL,
    tipo       TEXT NOT NULL CHECK (tipo IN ('HORECA', 'FRIAL', 'MERCADO_POPULAR', 'CONSUMIDOR', 'AGRICULTOR')),
    documento  TEXT,
    activo     INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
    creado_en  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- Ventas (carne, gallinaza; alimento excedente desde 2027)
-- Cada venta genera su asiento contable (asiento_id) y, si es a crédito, otro al cobrarla.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ventas (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha                    DATE NOT NULL,
    cliente_id               INTEGER NOT NULL REFERENCES clientes(id),
    producto                 TEXT NOT NULL CHECK (producto IN ('CARNE', 'GALLINAZA', 'ALIMENTO')),
    lote_id                  INTEGER REFERENCES lotes(id),                -- obligatorio para CARNE
    cantidad                 NUMERIC(12,2) NOT NULL CHECK (cantidad > 0),
    unidad                   TEXT NOT NULL DEFAULT 'KG' CHECK (unidad IN ('KG', 'QQ')),
    precio_unitario          NUMERIC(12,4) NOT NULL CHECK (precio_unitario > 0),
    total                    NUMERIC(14,2) NOT NULL CHECK (total > 0),
    costo_venta              NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (costo_venta >= 0),
    condicion                TEXT NOT NULL CHECK (condicion IN ('CONTADO', 'CREDITO')),
    plazo_dias               INTEGER NOT NULL DEFAULT 0 CHECK (plazo_dias BETWEEN 0 AND 7),
    fecha_vencimiento        DATE,
    medio_pago               TEXT CHECK (medio_pago IN ('EFECTIVO', 'TRANSFERENCIA', 'DEPOSITO', 'CHEQUE_NOMINATIVO', 'QR_ACH')),
    comprobante              TEXT NOT NULL CHECK (length(trim(comprobante)) > 0),   -- nota de entrega / comprobante de pago
    compromiso_pago_firmado  INTEGER NOT NULL DEFAULT 0 CHECK (compromiso_pago_firmado IN (0, 1)),
    estado                   TEXT NOT NULL CHECK (estado IN ('COBRADA', 'PENDIENTE')),
    asiento_id               INTEGER NOT NULL REFERENCES asientos(id),
    registrado_por           INTEGER NOT NULL REFERENCES usuarios(id),
    creado_en                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_cobro              DATE,
    medio_cobro              TEXT CHECK (medio_cobro IN ('EFECTIVO', 'TRANSFERENCIA', 'DEPOSITO', 'CHEQUE_NOMINATIVO', 'QR_ACH')),
    asiento_cobro_id         INTEGER REFERENCES asientos(id),
    -- Contado: se cobra en el acto con un medio de pago. Crédito: queda pendiente con vencimiento.
    CHECK ((condicion = 'CONTADO' AND plazo_dias = 0 AND medio_pago IS NOT NULL AND estado = 'COBRADA')
        OR (condicion = 'CREDITO' AND plazo_dias >= 1 AND medio_pago IS NULL AND fecha_vencimiento IS NOT NULL AND estado = 'PENDIENTE')
        OR (condicion = 'CREDITO' AND estado = 'COBRADA' AND fecha_cobro IS NOT NULL AND medio_cobro IS NOT NULL)),
    CHECK (producto <> 'CARNE' OR lote_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ventas_estado ON ventas(estado, fecha_vencimiento);
CREATE INDEX IF NOT EXISTS idx_ventas_lote   ON ventas(lote_id);

-- POL-05: reglas de crédito que no puede saltarse ningún cliente de la base de datos.
CREATE TRIGGER IF NOT EXISTS trg_ventas_politica_credito
BEFORE INSERT ON ventas
WHEN NEW.condicion = 'CREDITO'
BEGIN
    SELECT RAISE(ABORT, 'POL-05: solo los clientes del sector HORECA pueden comprar a crédito; el resto compra al contado')
    WHERE NOT EXISTS (SELECT 1 FROM clientes WHERE id = NEW.cliente_id AND tipo = 'HORECA');

    SELECT RAISE(ABORT, 'POL-05 Art. 2: el crédito a partir de 2028 requiere resolución escrita de la Gerencia General (no incluido en esta fase)')
    WHERE NEW.fecha >= '2028-01-01';

    SELECT RAISE(ABORT, 'POL-05 Art. 1: el crédito HORECA en 2026-2027 es de máximo 1 día calendario desde la entrega')
    WHERE NEW.plazo_dias <> 1;

    SELECT RAISE(ABORT, 'POL-05 Art. 1: el crédito exige comprobante de entrega y compromiso de pago firmado por el comprador')
    WHERE NEW.compromiso_pago_firmado <> 1;
END;

-- -----------------------------------------------------------------------------
-- Permisos nuevos (los de faenado reutilizan lotes.cerrar y lotes.aprobar_cierre de la Fase 1)
-- -----------------------------------------------------------------------------
INSERT OR IGNORE INTO permisos (codigo, modulo, descripcion) VALUES
  ('ventas.ver',       'ventas', 'Consultar ventas, clientes y cuentas por cobrar'),
  ('ventas.registrar', 'ventas', 'Registrar ventas al contado o a crédito HORECA y su cobranza'),
  ('kpis.ver',         'costos', 'Consultar los indicadores ICA, ICL, PMF y RINC');

INSERT OR IGNORE INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id FROM roles r, permisos p
WHERE (r.codigo IN ('GG', 'JF', 'CA', 'CV') AND p.codigo IN ('ventas.ver', 'kpis.ver'))
   OR (r.codigo = 'JF' AND p.codigo = 'ventas.registrar');
