"""Pruebas de integridad del esquema: partida doble, SoD del MOF y matriz de costos."""
import sqlite3

import pytest


def one(db, sql, *a):
    return db.execute(sql, a).fetchone()[0]


def uid(db, u):
    return one(db, "SELECT id FROM usuarios WHERE username = ?", u)


def cid(db, codigo):
    return one(db, "SELECT id FROM cuentas WHERE codigo = ?", codigo)


def nuevo_asiento(db, numero, tipo="DIARIO", user="jf", fecha="2026-10-12", origen=None):
    cur = db.execute(
        "INSERT INTO asientos (ejercicio_id, numero, fecha, tipo, glosa, creado_por, asiento_origen_id) "
        "VALUES (1, ?, ?, ?, 'prueba', ?, ?)", (numero, fecha, tipo, uid(db, user), origen))
    return cur.lastrowid


def linea(db, asiento, n, cuenta, debe=0, haber=0, cc=None, sufijo=None, lote=None):
    return db.execute(
        "INSERT INTO asiento_detalle (asiento_id, linea, cuenta_id, debe, haber, centro_costo_id, sufijo_id, lote_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (asiento, n, cid(db, cuenta), debe, haber,
         one(db, "SELECT id FROM centros_costo WHERE codigo = ?", cc) if cc else None,
         one(db, "SELECT id FROM sufijos_costo WHERE codigo = ?", sufijo) if sufijo else None,
         lote))


def contabilizar(db, asiento):
    db.execute("UPDATE asientos SET estado='CONTABILIZADO', contabilizado_en=CURRENT_TIMESTAMP WHERE id=?", (asiento,))


@pytest.fixture
def lote(db):
    cur = db.execute(
        "INSERT INTO lotes (codigo, centro_costo_id, ejercicio_id, numero_ciclo, fecha_inicio, fecha_fin_prevista, aves_iniciales) "
        "VALUES ('L-1', (SELECT id FROM centros_costo WHERE codigo='CC-01'), 1, 1, '2026-10-12', '2026-12-23', 3000)")
    return cur.lastrowid


# ------------------------------- seeds ---------------------------------------
def test_seeds_cargados(db):
    assert one(db, "SELECT COUNT(*) FROM cuentas") == 190
    assert {r[0] for r in db.execute("SELECT DISTINCT nivel FROM cuentas")} == {1, 2, 3, 4}
    assert one(db, "SELECT COUNT(*) FROM cuentas WHERE nivel = 4 AND es_imputable = 1") == \
        one(db, "SELECT COUNT(*) FROM cuentas WHERE nivel = 4")
    assert one(db, "SELECT COUNT(*) FROM sufijos_costo") == 28
    assert one(db, "SELECT COUNT(*) FROM centros_costo") == 2
    assert {r[0] for r in db.execute("SELECT codigo FROM roles")} == {"GG", "JF", "CA", "CV", "UT"}


def test_sod_permisos_mof(db):
    def perms(rol):
        return {r[0] for r in db.execute(
            "SELECT p.codigo FROM roles_permisos rp JOIN roles r ON r.id=rp.rol_id "
            "JOIN permisos p ON p.id=rp.permiso_id WHERE r.codigo=?", (rol,))}
    assert "asientos.registrar" not in perms("GG") and "asientos.autorizar" in perms("GG")
    assert "asientos.autorizar" not in perms("JF") and "asientos.registrar" in perms("JF")
    assert "cuentas.modificar" in perms("CA") and "cuentas.modificar" not in perms("JF")
    assert not {p for p in perms("CV") if p.endswith((".registrar", ".autorizar", ".abrir", ".cerrar"))}
    assert perms("UT") == {"lotes.ver", "lotes.bitacora"}


def test_cuenta_jerarquia_invalida(db):
    with pytest.raises(sqlite3.IntegrityError, match="Jerarquía"):
        db.execute("INSERT INTO cuentas (codigo, nombre, nivel, cuenta_padre_id, grupo, naturaleza, es_imputable) "
                   "VALUES ('1.2.99.01', 'x', 4, (SELECT id FROM cuentas WHERE codigo='1.1'), 1, 'DEUDORA', 1)")


# ------------------------------ libro diario ---------------------------------
def test_asiento_descuadrado_se_rechaza(db):
    a = nuevo_asiento(db, 1)
    linea(db, a, 1, "1.1.01.01", debe=100)
    linea(db, a, 2, "5.1.01.01", haber=99.99)
    with pytest.raises(sqlite3.IntegrityError, match="descuadrado"):
        contabilizar(db, a)


def test_asiento_cuadrado_y_luego_inmutable(db):
    a = nuevo_asiento(db, 1)
    linea(db, a, 1, "1.1.01.01", debe=100)
    linea(db, a, 2, "5.1.01.01", haber=100)
    contabilizar(db, a)
    with pytest.raises(sqlite3.IntegrityError, match="no se puede modificar"):
        db.execute("UPDATE asientos SET glosa='otra' WHERE id=?", (a,))
    with pytest.raises(sqlite3.IntegrityError, match="BORRADOR"):
        linea(db, a, 3, "1.1.01.01", debe=1)
    with pytest.raises(sqlite3.IntegrityError, match="eliminar"):
        db.execute("DELETE FROM asientos WHERE id=?", (a,))


def test_linea_debe_y_haber_a_la_vez_o_en_cero(db):
    a = nuevo_asiento(db, 1)
    with pytest.raises(sqlite3.IntegrityError):
        linea(db, a, 1, "1.1.01.01", debe=10, haber=10)
    with pytest.raises(sqlite3.IntegrityError):
        linea(db, a, 1, "1.1.01.01")


def test_solo_cuentas_imputables_y_activas(db):
    a = nuevo_asiento(db, 1)
    with pytest.raises(sqlite3.IntegrityError, match="imputable"):
        linea(db, a, 1, "1.1.01", debe=10)          # nivel 3
    with pytest.raises(sqlite3.IntegrityError, match="imputable"):
        linea(db, a, 1, "1.1.03.03", debe=10)       # Maíz (*) inactiva hasta 2027


def test_ajuste_requiere_autorizacion_distinta_del_registrador(db):
    a = nuevo_asiento(db, 1, tipo="AJUSTE")
    linea(db, a, 1, "7.1.02.01", debe=50)
    linea(db, a, 2, "1.1.01.01", haber=50)
    with pytest.raises(sqlite3.IntegrityError):      # sin autorizador
        contabilizar(db, a)
    with pytest.raises(sqlite3.IntegrityError):      # autoriza el mismo que registra
        db.execute("UPDATE asientos SET autorizado_por=? WHERE id=?", (uid(db, "jf"), a))
    db.execute("UPDATE asientos SET autorizado_por=?, autorizado_en=CURRENT_TIMESTAMP WHERE id=?", (uid(db, "gg"), a))
    contabilizar(db, a)
    assert one(db, "SELECT estado FROM asientos WHERE id=?", a) == "CONTABILIZADO"


def test_fecha_fuera_del_ejercicio(db):
    with pytest.raises(sqlite3.IntegrityError, match="fuera del ejercicio"):
        nuevo_asiento(db, 1, fecha="2025-01-01")


# ------------------------------ sistema de costos ----------------------------
def test_centro_de_costo_exige_sufijo_y_lote(db, lote):
    a = nuevo_asiento(db, 1)
    with pytest.raises(sqlite3.IntegrityError, match="centro, sufijo y lote"):
        linea(db, a, 1, "6.1.01.01", debe=10)


def test_matriz_centro_sufijo(db, lote):
    a = nuevo_asiento(db, 1)
    # 08 Veterinarios aplica a CC-01
    linea(db, a, 1, "6.1.01.01", debe=5895, cc="CC-01", sufijo="08", lote=lote)
    # 30 es depreciación de galpones: aplica a CC-01
    linea(db, a, 2, "6.1.01.01", debe=1050, cc="CC-01", sufijo="30", lote=lote)
    # 41 (merma de alimento) solo aplica a CC-02
    with pytest.raises(sqlite3.IntegrityError, match="Sufijo no permitido"):
        linea(db, a, 3, "6.1.01.01", debe=10, cc="CC-01", sufijo="41", lote=lote)
    # sufijo de alimento propio (*) inactivo en 2026
    with pytest.raises(sqlite3.IntegrityError, match="Sufijo no permitido"):
        linea(db, a, 3, "6.1.01.01", debe=10, cc="CC-01", sufijo="11", lote=lote)


def test_lote_debe_pertenecer_al_centro(db, lote):
    a = nuevo_asiento(db, 1)
    with pytest.raises(sqlite3.IntegrityError):
        linea(db, a, 1, "6.1.01.02", debe=10, cc="CC-02", sufijo="03", lote=lote)


def test_ciclo_completo_73_dias_y_hoja_de_costos(db, lote):
    # Compra de pollitos BB (sufijo 01) y alimento (02) al centro de costo del lote
    a1 = nuevo_asiento(db, 1)
    linea(db, a1, 1, "6.1.01.01", debe=27000, cc="CC-01", sufijo="01", lote=lote)
    linea(db, a1, 2, "6.1.01.01", debe=55500, cc="CC-01", sufijo="02", lote=lote)
    linea(db, a1, 3, "1.1.01.03", haber=82500)
    contabilizar(db, a1)

    # Cierre del ciclo (día 73): 1.1.03.12 contra 6.1.01.01 por sufijo; requiere autorización de la GG
    a2 = nuevo_asiento(db, 2, tipo="CIERRE_CICLO", fecha="2026-12-23")
    linea(db, a2, 1, "1.1.03.12", debe=82500)
    linea(db, a2, 2, "6.1.01.01", haber=27000, cc="CC-01", sufijo="01", lote=lote)
    linea(db, a2, 3, "6.1.01.01", haber=55500, cc="CC-01", sufijo="02", lote=lote)
    with pytest.raises(sqlite3.IntegrityError):
        contabilizar(db, a2)
    db.execute("UPDATE asientos SET autorizado_por=?, autorizado_en=CURRENT_TIMESTAMP WHERE id=?", (uid(db, "gg"), a2))
    contabilizar(db, a2)

    # El lote no cierra sin los datos de cierre; con ellos, sí
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE lotes SET estado='CERRADO' WHERE id=?", (lote,))
    db.execute("UPDATE lotes SET estado='CERRADO', fecha_cierre='2026-12-23', costo_total=82500, "
               "kg_producidos=7800, costo_unitario=82500/7800.0, asiento_cierre_id=? WHERE id=?", (a2, lote))
    with pytest.raises(sqlite3.IntegrityError, match="CERRADO"):
        db.execute("UPDATE lotes SET observaciones='x' WHERE id=?", (lote,))

    # El centro de costo queda en saldo cero
    assert one(db, "SELECT ROUND(SUM(debe - haber), 2) FROM v_libro_diario WHERE cuenta_codigo='6.1.01.01'") == 0
    # Hoja de costos por sufijo (acumulado = debe - haber, neto cero tras el cierre)
    hoja = {r[0]: r[1] for r in db.execute("SELECT sufijo, monto FROM v_hoja_costos_lote WHERE lote_id=?", (lote,))}
    assert hoja == {"01": 0, "02": 0}
    # Lote cerrado: no admite más costos
    a3 = nuevo_asiento(db, 3)
    with pytest.raises(sqlite3.IntegrityError, match="ABIERTO"):
        linea(db, a3, 1, "6.1.01.01", debe=1, cc="CC-01", sufijo="01", lote=lote)


def test_hoja_de_costos_antes_del_cierre(db, lote):
    a = nuevo_asiento(db, 1)
    linea(db, a, 1, "6.1.01.01", debe=27000, cc="CC-01", sufijo="01", lote=lote)
    linea(db, a, 2, "1.1.01.03", haber=27000)
    contabilizar(db, a)
    row = db.execute("SELECT sufijo, elemento_costo, monto FROM v_hoja_costos_lote WHERE lote_id=?", (lote,)).fetchone()
    assert row == ("01", "MPD", 27000)


def test_anulacion_deja_traza(db):
    a = nuevo_asiento(db, 1)
    linea(db, a, 1, "1.1.01.01", debe=100)
    linea(db, a, 2, "5.1.01.01", haber=100)
    contabilizar(db, a)
    n = nuevo_asiento(db, 2, tipo="ANULACION", origen=a)
    linea(db, n, 1, "1.1.01.01", haber=100)
    linea(db, n, 2, "5.1.01.01", debe=100)
    db.execute("UPDATE asientos SET autorizado_por=?, autorizado_en=CURRENT_TIMESTAMP WHERE id=?", (uid(db, "gg"), n))
    contabilizar(db, n)
    db.execute("UPDATE asientos SET estado='ANULADO' WHERE id=?", (a,))
    saldo = one(db, "SELECT saldo_deudor + saldo_acreedor FROM v_balance_comprobacion WHERE cuenta_codigo='1.1.01.01'")
    assert saldo == 0


# ------------------------------ bitácora y mortalidad ------------------------
def test_bitacora_dia_ciclo_coherente_y_mortalidad(db, lote):
    ut = uid(db, "ut")
    db.execute("INSERT INTO lote_bitacora (lote_id, fecha, dia_ciclo, mortalidad, registrado_por) VALUES (?, '2026-10-12', 1, 100, ?)", (lote, ut))
    with pytest.raises(sqlite3.IntegrityError, match="dia_ciclo"):
        db.execute("INSERT INTO lote_bitacora (lote_id, fecha, dia_ciclo, mortalidad, registrado_por) VALUES (?, '2026-10-14', 2, 0, ?)", (lote, ut))
    db.execute("INSERT INTO lote_bitacora (lote_id, fecha, dia_ciclo, mortalidad, registrado_por) VALUES (?, '2026-10-13', 2, 60, ?)", (lote, ut))
    pct, clase, exceso = db.execute("SELECT pct_mortalidad, clasificacion, aves_exceso_sobre_5pct FROM v_lote_mortalidad").fetchone()
    assert (pct, clase, exceso) == (5.33, "ANORMAL", 10)        # 160 muertas de 3.000: tolerancia 150


def test_ciclo_es_de_73_dias(db):
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO lotes (codigo, centro_costo_id, ejercicio_id, numero_ciclo, fecha_inicio, duracion_dias, fecha_fin_prevista) "
                   "VALUES ('L-X', 1, 1, 9, '2026-10-12', 60, '2026-12-10')")
