import asyncio
import json
import time
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException

import auth_db
import update_malware_db

router = APIRouter()

STATUS_PATH = Path("data/malware_hashes/update_status.json")
HASHES_PATH = Path("data/malware_hashes/known_hashes.csv")
MIN_INTERVAL_SECONDS = 3600
_lock = asyncio.Lock()


def _read_status() -> dict:
    try:
        return json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _count_entries() -> int:
    try:
        with HASHES_PATH.open("r", encoding="utf-8") as f:
            return max(sum(1 for _ in f) - 1, 0)
    except Exception:
        return 0


def _run_update() -> dict:
    raw = update_malware_db.fetch_recent_csv()
    entries = update_malware_db.parse_malwarebazaar_csv(raw)
    stats = update_malware_db.update_known_hashes(entries)
    stats["parsed"] = len(entries)
    return stats


def _require_admin(token):
    if not token:
        raise HTTPException(status_code=401, detail="Wymagane logowanie.")
    user = auth_db.get_user_by_session(token)
    if user is None:
        raise HTTPException(status_code=401, detail="Sesja nieprawidlowa lub wygasla.")
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Brak uprawnien - wymagana rola administratora.")
    return user


@router.get("/updates/status")
async def updates_status():
    st = _read_status()
    st["entries"] = _count_entries()
    return st


@router.post("/updates/refresh")
async def updates_refresh(x_session_token: str | None = Header(default=None)):
    _require_admin(x_session_token)
    if _lock.locked():
        raise HTTPException(status_code=409, detail="Aktualizacja juz trwa")
    async with _lock:
        last = _read_status().get("last_success_ts", 0)
        wait = MIN_INTERVAL_SECONDS - (time.time() - last)
        if wait > 0:
            raise HTTPException(
                status_code=429,
                detail=f"Zbyt wczesnie - kolejna aktualizacja za {int(wait // 60) + 1} min",
            )
        try:
            stats = await asyncio.to_thread(_run_update)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Aktualizacja nieudana: {e}")
        status = {
            "last_success_ts": time.time(),
            "last_success_utc": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()),
            "source": "MalwareBazaar (abuse.ch)",
            **stats,
        }
        STATUS_PATH.write_text(json.dumps(status), encoding="utf-8")
        return status
