"""Punto de entrada FastAPI."""
from fastapi import Depends, FastAPI
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import __version__
from app.core.config import get_settings
from app.core.database import get_db

settings = get_settings()
app = FastAPI(title=settings.app_name, version=__version__)


@app.get("/health", tags=["sistema"])
def health(db: Session = Depends(get_db)):
    """Verifica que la API y la base de datos respondan."""
    db.execute(text("SELECT 1"))
    return {"estado": "ok", "app": settings.app_name, "version": __version__}
