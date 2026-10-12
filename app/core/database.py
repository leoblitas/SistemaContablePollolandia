"""Motor SQLAlchemy y sesión. En SQLite activa claves foráneas en cada conexión."""
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from app.core.config import get_settings

_url = get_settings().database_url
_connect_args = {"check_same_thread": False} if _url.startswith("sqlite") else {}

engine: Engine = create_engine(_url, connect_args=_connect_args, future=True)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_connection, _record):
    if _url.startswith("sqlite"):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys = ON")  # sin esto SQLite ignora las FK
        cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def get_db():
    """Dependencia FastAPI: una sesión por petición."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
