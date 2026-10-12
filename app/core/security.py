"""Hash de contraseñas con scrypt (biblioteca estándar, sin dependencias extra)."""
import base64
import hashlib
import hmac
import os

_N, _R, _P = 2**14, 8, 1


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P)
    return "scrypt${}${}".format(base64.b64encode(salt).decode(), base64.b64encode(dk).decode())


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_b64, dk_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt, expected = base64.b64decode(salt_b64), base64.b64decode(dk_b64)
        dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P)
        return hmac.compare_digest(dk, expected)
    except (ValueError, TypeError):
        return False
