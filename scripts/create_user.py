"""Crea un usuario con un rol del MOF (GG, JF, CA, CV, UT).

Uso:  python scripts/create_user.py --username jperez --nombre "Juan Pérez" --rol JF
La contraseña se solicita por consola (no queda en el historial del shell).
"""
import argparse
import getpass
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.core.config import get_settings  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from scripts.init_db import sqlite_path  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--username", required=True)
    ap.add_argument("--nombre", required=True)
    ap.add_argument("--rol", required=True, choices=["GG", "JF", "CA", "CV", "UT"])
    ap.add_argument("--email")
    args = ap.parse_args()

    pwd = getpass.getpass("Contraseña: ")
    if len(pwd) < 8 or pwd != getpass.getpass("Repita la contraseña: "):
        sys.exit("Las contraseñas no coinciden o tienen menos de 8 caracteres.")

    conn = sqlite3.connect(sqlite_path(get_settings().database_url))
    conn.execute("PRAGMA foreign_keys = ON")
    rol = conn.execute("SELECT id FROM roles WHERE codigo = ?", (args.rol,)).fetchone()
    conn.execute(
        "INSERT INTO usuarios (username, nombre_completo, email, password_hash, rol_id) VALUES (?, ?, ?, ?, ?)",
        (args.username, args.nombre, args.email, hash_password(pwd), rol[0]),
    )
    conn.commit()
    print(f"Usuario '{args.username}' creado con rol {args.rol}.")


if __name__ == "__main__":
    main()
