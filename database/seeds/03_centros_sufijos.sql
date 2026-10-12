-- =============================================================================
-- 03_centros_sufijos.sql — Centros de costo (CC-01, CC-02), sufijos del Grupo 6 y
-- matriz de aplicabilidad centro x sufijo.
-- Fuente: hoja "Sufijos de Costos" del Plan de Cuentas y Manual del Sistema de Costos
-- (secciones 5, 7 y 8). Sufijos (*) = línea de alimento propio, desde 2027 (activo = 0).
-- Para activar la línea CC-02:
--   UPDATE sufijos_costo SET activo = 1 WHERE vigente_desde IS NOT NULL;
--   UPDATE centros_costo SET activo = 1 WHERE codigo = 'CC-02';
--   UPDATE cuentas SET activa = 1 WHERE vigente_desde IS NOT NULL;
-- =============================================================================

INSERT INTO centros_costo (codigo, nombre, cuenta_id, unidad_medida, descripcion, vigente_desde, activo) VALUES
  ('CC-01', 'Producción de Carne de Pollo', (SELECT id FROM cuentas WHERE codigo = '6.1.01.01'), 'KG', 'Centro de costo principal: ciclo de 73 días, acumula MPD, MOD y CIF por sufijo. Costo unitario Bs/kg.', NULL, 1),
  ('CC-02', 'Producción de Alimento Balanceado', (SELECT id FROM cuentas WHERE codigo = '6.1.01.02'), 'QQ', 'Planta propia de alimento (desde 2027). Consumo propio vía sufijo 11 y excedente para venta. Costo unitario Bs/QQ.', '2027-01-01', 0);

INSERT INTO sufijos_costo (codigo, nombre, elemento_costo, naturaleza, descripcion, vigente_desde, activo) VALUES
  ('01', 'Costo – Pollitos BB', 'MPD', 'DEUDORA', 'Adquisición y flete de pollitos BB de 1 día para engorde.', NULL, 1),
  ('02', 'Costo – Alimento Balanceado Comprado', 'MPD', 'DEUDORA', 'Alimento balanceado adquirido a terceros para la etapa de crianza.', NULL, 1),
  ('03', 'Costo – Maíz Amarillo', 'MPD', 'DEUDORA', 'Materia prima energética para elaboración propia de alimento (Desde 2027).', '2027-01-01', 0),
  ('04', 'Costo – Torta de Soya', 'MPD', 'DEUDORA', 'Materia prima proteica para la elaboración de alimento propio (Desde 2027).', '2027-01-01', 0),
  ('05', 'Costo – Afrecho de Trigo', 'MPD', 'DEUDORA', 'Materia prima fibrosa para formulación de alimento propio (Desde 2027).', '2027-01-01', 0),
  ('06', 'Costo – Núcleo Vitamínico', 'MPD', 'DEUDORA', 'Aditivo vitamínico-mineral para alimento balanceado propio (Desde 2027).', '2027-01-01', 0),
  ('07', 'Costo – Aceite Vegetal', 'MPD', 'DEUDORA', 'Insumo graso energético para formulación de alimento propio (Desde 2027).', '2027-01-01', 0),
  ('08', 'Costo – Productos Veterinarios', 'MPD', 'DEUDORA', 'Vacunas, antibióticos y fármacos aplicados directamente al lote avícola.', NULL, 1),
  ('09', 'Costo – Insumos Limpieza y desinfección', 'MPD', 'DEUDORA', 'Desinfectantes de galpón y productos de bioseguridad del lote.', NULL, 1),
  ('10', 'Costo – Insumos de Crianza', 'MPD', 'DEUDORA', 'Cama de viruta y materiales consumibles de galpón durante la crianza.', NULL, 1),
  ('11', 'Costo – Alimento Balanceado Producido', 'MPD', 'DEUDORA', 'Transferencia interna de alimento balanceado propio al centro de crianza.', '2027-01-01', 0),
  ('12', 'Costo – Bolsas personalizadas', 'MPD', 'DEUDORA', 'Bolsas de empaque y etiquetado con código QR para pollo faenado.', NULL, 1),
  ('13', 'Costo – Saquillos de Yute', 'MPD', 'DEUDORA', 'Sacos para envasar alimento balanceado excedente para venta (Desde 2027).', '2027-01-01', 0),
  ('20', 'MOD – Salario Operarios', 'MOD', 'DEUDORA', 'Sueldo del operario de granja (Prorrateo 75% Carne / 25% Alimento).', NULL, 1),
  ('21', 'MOD – Aguinaldo Operarios', 'MOD', 'DEUDORA', 'Provisión mensual de aguinaldo de navidad del operario (8.33%).', NULL, 1),
  ('22', 'MOD – Personal Eventual', 'MOD', 'DEUDORA', 'Pago por destajo al personal contratado eventualmente para labores de faenado.', NULL, 1),
  ('38', 'MOD – Aporte Patronal Operarios', 'MOD', 'DEUDORA', 'Cargas sociales patronales del operario de granja (17.21%).', NULL, 1),
  ('39', 'MOD – Indemnización Operarios', 'MOD', 'DEUDORA', 'Provisión mensual de indemnización por tiempo de servicios del operario (8.33%).', NULL, 1),
  ('30', 'CIF – Depreciación Galpones', 'CIF', 'DEUDORA', 'Depreciación mensual de galpones de producción avícola.', NULL, 1),
  ('31', 'CIF – Depreciación Equipos de Producción', 'CIF', 'DEUDORA', 'Depreciación de comederos, bebederos y estufas de calefacción.', NULL, 1),
  ('32', 'CIF – Depreciación Alambrados', 'CIF', 'DEUDORA', 'Depreciación de cerramientos perimetrales y de bioseguridad.', NULL, 1),
  ('33', 'CIF – Depreciación Herramientas', 'CIF', 'DEUDORA', 'Depreciación de herramientas menores asignadas a producción.', NULL, 1),
  ('34', 'CIF – Depreciación Maquinaria Alimento', 'CIF', 'DEUDORA', 'Depreciación de molino, mezcladora y peletizadora de alimento.', '2027-01-01', 0),
  ('35', 'CIF – Depreciación Ambiente Preparación', 'CIF', 'DEUDORA', 'Depreciación de la infraestructura física de la planta de alimento.', '2027-01-01', 0),
  ('36', 'CIF – Mantenimiento e Instalaciones', 'CIF', 'DEUDORA', 'Reparaciones y mantenimiento preventivo/correctivo de instalaciones.', NULL, 1),
  ('37', 'CIF – Energía Eléctrica y Agua Potable', 'CIF', 'DEUDORA', 'Servicios públicos consumidos directamente en granja y planta.', NULL, 1),
  ('40', 'Pérdidas por Mortandad Avícola Normal', 'PERDIDA_ORDINARIA', 'DEUDORA', 'Pérdida absorbida en costo por mortandad avícola ordinaria (≤5% del lote).', NULL, 1),
  ('41', 'Pérdidas por Mermas de Producción Normal', 'PERDIDA_ORDINARIA', 'DEUDORA', 'Pérdida absorbida en costo por mermas normales de alimento (≤5%).', NULL, 1);

-- Matriz CC-01 (Carne): MPD 01,02,08,09,10,11(transferencia desde CC-02),12; MOD 20,21,22,38,39; CIF 30-33,36,37; pérdida normal 40
INSERT INTO centro_costo_sufijos (centro_costo_id, sufijo_id)
SELECT cc.id, s.id FROM centros_costo cc, sufijos_costo s
WHERE cc.codigo = 'CC-01' AND s.codigo IN ('01', '02', '08', '09', '10', '11', '12', '20', '21', '22', '30', '31', '32', '33', '36', '37', '38', '39', '40');

-- Matriz CC-02 (Alimento): MPD 03-07,13(saquillos); MOD 20,21,38,39; CIF 34,35,36,37; pérdida normal 41
INSERT INTO centro_costo_sufijos (centro_costo_id, sufijo_id)
SELECT cc.id, s.id FROM centros_costo cc, sufijos_costo s
WHERE cc.codigo = 'CC-02' AND s.codigo IN ('03', '04', '05', '06', '07', '13', '20', '21', '34', '35', '36', '37', '38', '39', '41');
