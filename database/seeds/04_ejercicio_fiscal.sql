-- =============================================================================
-- 04_ejercicio_fiscal.sql — Ejercicio fiscal inicial del piloto.
-- Supuesto: cierre al 30 de junio (cuenta 8.1.01.01) y arranque en el ejercicio vigente
-- al emitirse el MOF (octubre 2026). Ajustar las fechas si la cooperativa define otro período.
-- =============================================================================
INSERT INTO ejercicios_fiscales (codigo, fecha_inicio, fecha_fin, estado)
VALUES ('2026-2027', '2026-07-01', '2027-06-30', 'ABIERTO');
