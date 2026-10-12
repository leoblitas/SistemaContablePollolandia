-- =============================================================================
-- 01_roles_permisos.sql — Roles del MOF-FIN-001 y matriz de permisos (SoD, MOF 3.2)
--   GG  Gerente General (autoriza; NO registra transacciones)
--   JF  Jefe de Finanzas y Comercialización – Contador General (registra y costea; NO autoriza ni firma desembolsos)
--   CA  Consejo de Administración (aprueba plan de cuentas, políticas y presupuesto)
--   CV  Consejo de Vigilancia (verifica; NO ejecuta, aprueba ni registra)
--   UT  Unidad Técnica (provee bitácora productiva; NO registra contabilidad ni autoriza pagos)
-- =============================================================================

INSERT INTO roles (codigo, nombre, descripcion, referencia_mof) VALUES
  ('GG', 'Gerente General',
   'Dirección financiera: autoriza asientos de ajuste y cierre, bajas y desembolsos. No registra transacciones.', 'MOF 2.1'),
  ('JF', 'Jefe de Finanzas y Comercialización – Contador General',
   'Registra asientos, costea lotes, prepara cierres y EEFF. No autoriza desembolsos ni modifica el plan de cuentas.', 'MOF 2.2'),
  ('CA', 'Consejo de Administración',
   'Aprueba políticas contables, presupuesto y cualquier modificación del plan de cuentas.', 'MOF 2.3'),
  ('CV', 'Consejo de Vigilancia',
   'Fiscaliza de forma independiente (arqueos, conciliaciones, inventarios, indicadores). Solo lectura y verificación.', 'MOF 2.3'),
  ('UT', 'Unidad Técnica',
   'Registra la bitácora diaria del lote (alimento, mortalidad, novedades sanitarias). Sin acceso contable.', 'MOF 2.3');

INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('cuentas.ver',            'plan_cuentas', 'Consultar el plan de cuentas'),
  ('cuentas.modificar',      'plan_cuentas', 'Crear o modificar cuentas y sufijos (aprobación del CA)'),
  ('asientos.ver',           'libro_diario', 'Consultar libro diario, mayor y balance de comprobación'),
  ('asientos.registrar',     'libro_diario', 'Crear asientos ordinarios y contabilizarlos'),
  ('asientos.autorizar',     'libro_diario', 'Autorizar asientos de ajuste, cierre de ciclo, cierre de ejercicio y anulación'),
  ('asientos.anular',        'libro_diario', 'Solicitar la anulación de un asiento contabilizado'),
  ('lotes.ver',              'lotes',        'Consultar lotes y bitácora'),
  ('lotes.abrir',            'lotes',        'Abrir un lote / ciclo de 73 días'),
  ('lotes.bitacora',         'lotes',        'Registrar la bitácora diaria del lote'),
  ('lotes.cerrar',           'lotes',        'Preparar el cierre del ciclo y el Informe de Costo de Ciclo'),
  ('lotes.aprobar_cierre',   'lotes',        'Aprobar el cierre del ciclo y las bajas por mortalidad anormal'),
  ('costos.ver',             'costos',       'Consultar hojas de costos e indicadores (ICA, ICL, RINC)'),
  ('reportes.ver',           'reportes',     'Consultar reportes y estados financieros'),
  ('auditoria.ver',          'auditoria',    'Consultar la bitácora de auditoría'),
  ('auditoria.verificar',    'auditoria',    'Registrar verificaciones del Consejo de Vigilancia'),
  ('usuarios.administrar',   'seguridad',    'Crear y desactivar usuarios');

-- Gerente General: lectura total + autorización. NO tiene asientos.registrar.
INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id FROM roles r, permisos p
WHERE r.codigo = 'GG' AND p.codigo IN
  ('cuentas.ver','asientos.ver','asientos.autorizar','lotes.ver','lotes.aprobar_cierre',
   'costos.ver','reportes.ver','auditoria.ver','usuarios.administrar');

-- Jefe de Finanzas: registra. NO tiene asientos.autorizar ni cuentas.modificar.
INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id FROM roles r, permisos p
WHERE r.codigo = 'JF' AND p.codigo IN
  ('cuentas.ver','asientos.ver','asientos.registrar','asientos.anular','lotes.ver','lotes.abrir',
   'lotes.cerrar','costos.ver','reportes.ver');

-- Consejo de Administración
INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id FROM roles r, permisos p
WHERE r.codigo = 'CA' AND p.codigo IN
  ('cuentas.ver','cuentas.modificar','asientos.ver','lotes.ver','costos.ver','reportes.ver');

-- Consejo de Vigilancia: solo lectura + verificación
INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id FROM roles r, permisos p
WHERE r.codigo = 'CV' AND p.codigo IN
  ('cuentas.ver','asientos.ver','lotes.ver','costos.ver','reportes.ver','auditoria.ver','auditoria.verificar');

-- Unidad Técnica: solo bitácora y consulta de lotes
INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id FROM roles r, permisos p
WHERE r.codigo = 'UT' AND p.codigo IN ('lotes.ver','lotes.bitacora');
