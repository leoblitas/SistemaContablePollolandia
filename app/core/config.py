"""Configuración leída de variables de entorno / archivo .env."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"
    app_name: str = "Pollolandia Contable"
    database_url: str = "sqlite:///./data/pollolandia.db"
    secret_key: str = "cambie-esta-clave"


@lru_cache
def get_settings() -> Settings:
    return Settings()
