"""Live TOTP codes for the broker login panels — a convenience so the user can copy the current
2FA code to paste on Zerodha/Shoonya's login page. Secrets live in .env (git-ignored); the raw
seed is never sent to the client, only the current 6-digit code and its remaining validity."""
import os
import time

import pyotp
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/totp", tags=["totp"])

# broker -> (env var holding the base32 seed, account label for the UI)
_SECRETS = {
    "zerodha": ("ZERODHA_TOTP_SECRET", "TJ1191"),
    "shoonya": ("SHOONYA_TOTP_SECRET", "FA24828"),
}
_PERIOD = 30  # standard TOTP step


@router.get("/{broker}")
def get_totp(broker: str):
    """Current TOTP code for a broker + seconds until it rolls over. No seed ever leaves the server."""
    entry = _SECRETS.get(broker.lower())
    if not entry:
        raise HTTPException(404, "Unknown broker")
    secret = (os.environ.get(entry[0]) or "").strip()
    if not secret:
        raise HTTPException(404, f"No TOTP secret configured for {broker}")
    try:
        code = pyotp.TOTP(secret, interval=_PERIOD).now()
    except Exception as e:
        raise HTTPException(500, f"TOTP generation failed: {e}")
    remaining = _PERIOD - int(time.time()) % _PERIOD
    return {"broker": broker.lower(), "account": entry[1], "code": code, "remaining": remaining}
