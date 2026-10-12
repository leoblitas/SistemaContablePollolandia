import os
import sqlite3
import tempfile
from pathlib import Path

import pytest

# La API usa una base temporal; debe fijarse antes de importar la app.
_tmp = Path(tempfile.mkdtemp()) / "test_api.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}"

ROOT = Path(__file__).resolve().parents[1]


def build_db(conn: sqlite3.Connection) -> None:
    conn.executescript((ROOT / "database" / "schema.sql").read_text(encoding="utf-8"))
    for seed in sorted((ROOT / "database" / "seeds").glob("*.sql")):
        conn.executescript(seed.read_text(encoding="utf-8"))


@pytest.fixture
def db():
    """Base SQLite en memoria con esquema + seeds, y dos usuarios (JF registra, GG autoriza)."""
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    build_db(conn)
    for username, rol in (("jf", "JF"), ("gg", "GG"), ("ut", "UT")):
        conn.execute(
            "INSERT INTO usuarios (username, nombre_completo, password_hash, rol_id) "
            "VALUES (?, ?, 'x', (SELECT id FROM roles WHERE codigo = ?))",
            (username, username.upper(), rol),
        )
    conn.commit()
    yield conn
    conn.close()
