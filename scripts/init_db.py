"""Crea la base de datos: aplica database/schema.sql y los seeds (solo SQLite).

Uso:  python scripts/init_db.py [--reset]
"""
import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.core.config import get_settings  # noqa: E402


def sqlite_path(url: str) -> Path:
    prefix = "sqlite:///"
    if not url.startswith(prefix):
        sys.exit("init_db.py solo soporta SQLite. Para PostgreSQL adapte database/schema.sql (ver cabecera).")
    p = Path(url[len(prefix):])
    return p if p.is_absolute() else ROOT / p


def build(conn: sqlite3.Connection) -> None:
    conn.executescript((ROOT / "database" / "schema.sql").read_text(encoding="utf-8"))
    for seed in sorted((ROOT / "database" / "seeds").glob("*.sql")):
        conn.executescript(seed.read_text(encoding="utf-8"))
    conn.commit()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="elimina la base existente antes de crearla")
    args = ap.parse_args()

    path = sqlite_path(get_settings().database_url)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if not args.reset:
            sys.exit(f"{path} ya existe. Use --reset para recrearla (se perderán los datos).")
        path.unlink()
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    build(conn)
    n = conn.execute("SELECT COUNT(*) FROM cuentas").fetchone()[0]
    conn.close()
    print(f"Base creada en {path} ({n} cuentas cargadas).")


if __name__ == "__main__":
    main()
