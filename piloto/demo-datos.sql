-- =============================================================================
-- demo-datos.sql — Datos de demostración (solo piloto). Se aplican al crear la base.
-- Pasan por las mismas reglas/triggers de schema.sql, así que son un caso de prueba real.
-- =============================================================================

-- Usuarios de demostración (SIN contraseña real: el piloto no tiene login)
INSERT INTO usuarios (username, nombre_completo, password_hash, rol_id) VALUES
  ('demo_gg', 'Gerente General (demo)',            'SIN-LOGIN-DEMO', (SELECT id FROM roles WHERE codigo = 'GG')),
  ('demo_jf', 'Contador / Jefe de Finanzas (demo)','SIN-LOGIN-DEMO', (SELECT id FROM roles WHERE codigo = 'JF')),
  ('demo_ut', 'Operador de Granja (demo)',         'SIN-LOGIN-DEMO', (SELECT id FROM roles WHERE codigo = 'UT'));

-- Asiento 1: aportes de los socios fundadores
INSERT INTO asientos (ejercicio_id, numero, fecha, tipo, glosa, documento_respaldo, creado_por)
VALUES (1, 1, '2026-07-01', 'DIARIO', 'Aportes iniciales de socios fundadores', 'Acta de constitución', (SELECT id FROM usuarios WHERE username='demo_jf'));
INSERT INTO asiento_detalle (asiento_id, linea, cuenta_id, debe, haber) VALUES
  (1, 1, (SELECT id FROM cuentas WHERE codigo='1.1.01.03'), 150000, 0),
  (1, 2, (SELECT id FROM cuentas WHERE codigo='3.1.01.01'), 0, 150000);
UPDATE asientos SET estado='CONTABILIZADO', contabilizado_en=CURRENT_TIMESTAMP WHERE id=1;

-- Lote 1 de carne de pollo: día 1 = 21-sep-2026, día 73 = 02-dic-2026 (día 21 el 11-oct)
INSERT INTO lotes (codigo, centro_costo_id, ejercicio_id, numero_ciclo, fecha_inicio, fecha_fin_prevista, aves_iniciales, responsable_id)
VALUES ('L-CC01-2026-2027-01', (SELECT id FROM centros_costo WHERE codigo='CC-01'), 1, 1, '2026-09-21', '2026-12-02', 3000,
        (SELECT id FROM usuarios WHERE username='demo_ut'));

-- Asiento 2: compra de pollitos BB (sufijo 01) y alimento (sufijo 02)
INSERT INTO asientos (ejercicio_id, numero, fecha, tipo, glosa, documento_respaldo, creado_por)
VALUES (1, 2, '2026-09-21', 'DIARIO', 'Recepción de 3.000 pollitos BB y alimento de inicio', 'Nota de entrega 0001', (SELECT id FROM usuarios WHERE username='demo_jf'));
INSERT INTO asiento_detalle (asiento_id, linea, cuenta_id, debe, haber, centro_costo_id, sufijo_id, lote_id) VALUES
  (2, 1, (SELECT id FROM cuentas WHERE codigo='6.1.01.01'), 27000, 0, (SELECT id FROM centros_costo WHERE codigo='CC-01'), (SELECT id FROM sufijos_costo WHERE codigo='01'), 1),
  (2, 2, (SELECT id FROM cuentas WHERE codigo='6.1.01.01'), 55500, 0, (SELECT id FROM centros_costo WHERE codigo='CC-01'), (SELECT id FROM sufijos_costo WHERE codigo='02'), 1),
  (2, 3, (SELECT id FROM cuentas WHERE codigo='1.1.01.03'), 0, 82500, NULL, NULL, NULL);
UPDATE asientos SET estado='CONTABILIZADO', contabilizado_en=CURRENT_TIMESTAMP WHERE id=2;

-- Asiento 3: productos veterinarios (sufijo 08)
INSERT INTO asientos (ejercicio_id, numero, fecha, tipo, glosa, documento_respaldo, creado_por)
VALUES (1, 3, '2026-10-05', 'DIARIO', 'Vacunas y antibióticos del lote 1', 'Factura 1204', (SELECT id FROM usuarios WHERE username='demo_jf'));
INSERT INTO asiento_detalle (asiento_id, linea, cuenta_id, debe, haber, centro_costo_id, sufijo_id, lote_id) VALUES
  (3, 1, (SELECT id FROM cuentas WHERE codigo='6.1.01.01'), 5895, 0, (SELECT id FROM centros_costo WHERE codigo='CC-01'), (SELECT id FROM sufijos_costo WHERE codigo='08'), 1),
  (3, 2, (SELECT id FROM cuentas WHERE codigo='1.1.01.03'), 0, 5895, NULL, NULL, NULL);
UPDATE asientos SET estado='CONTABILIZADO', contabilizado_en=CURRENT_TIMESTAMP WHERE id=3;

-- Asiento 4: ajuste PENDIENTE de autorización del Gerente General (MOF 2.2e)
INSERT INTO asientos (ejercicio_id, numero, fecha, tipo, glosa, documento_respaldo, creado_por)
VALUES (1, 4, '2026-10-10', 'AJUSTE', 'Ajuste por consumo de papelería de oficina', 'Planilla de consumo', (SELECT id FROM usuarios WHERE username='demo_jf'));
INSERT INTO asiento_detalle (asiento_id, linea, cuenta_id, debe, haber) VALUES
  (4, 1, (SELECT id FROM cuentas WHERE codigo='7.1.02.01'), 350, 0),
  (4, 2, (SELECT id FROM cuentas WHERE codigo='1.1.01.01'), 0, 350);

-- Bitácora diaria del lote (días 1 a 21): mortalidad acumulada ≈ 1,9 % (normal)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 21)
INSERT INTO lote_bitacora (lote_id, fecha, dia_ciclo, alimento_kg, mortalidad, registrado_por)
SELECT 1, date('2026-09-21', '+' || (i - 1) || ' days'), i, ROUND(15 + i * 9.5, 1),
       CASE WHEN i % 3 = 0 THEN 4 ELSE 2 END, (SELECT id FROM usuarios WHERE username='demo_ut')
FROM n;
