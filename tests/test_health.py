import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from tests.conftest import build_db


def test_health():
    from app.core.config import get_settings
    path = Path(get_settings().database_url.replace("sqlite:///", ""))
    conn = sqlite3.connect(path)
    build_db(conn)
    conn.close()

    from app.main import app
    r = TestClient(app).get("/health")
    assert r.status_code == 200 and r.json()["estado"] == "ok"
