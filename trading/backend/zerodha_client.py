import os
import json
import time
import threading
from pathlib import Path
from kiteconnect import KiteConnect
import state_paths

TOKEN_FILE = state_paths.state_path(".zerodha_token.json")
EXPIRY_CACHE_TTL = 6 * 3600

# Optional fixed-IP proxy (e.g. a TrueIP dedicated address) so Zerodha's IP whitelist doesn't
# break when the home ISP's IP drifts. Unlike Shoonya's api.shoonya.com, Zerodha's api.kite.trade
# doesn't block datacenter/proxy IP ranges — verified 2026-07-08 (both api.kite.trade and
# kite.zerodha.com reachable through TrueIP). KiteConnect accepts `proxies` natively, so no
# monkeypatching needed (contrast with shoonya_client.py's approach for the SDK that doesn't).
_ZERODHA_PROXIES = None
_proxy_url = os.environ.get("ZERODHA_PROXY_URL", "").strip()
if _proxy_url:
    _ZERODHA_PROXIES = {"http": _proxy_url, "https": _proxy_url}


def _new_kite(api_key: str) -> KiteConnect:
    return KiteConnect(api_key=api_key, proxies=_ZERODHA_PROXIES)


class ZerodhaClient:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._kite = None
                cls._instance._expiry_cache = {}
                cls._instance._expiry_cache_ts = {}
        return cls._instance

    @property
    def api_key(self):
        return os.environ["ZERODHA_API_KEY"]

    @property
    def api_secret(self):
        return os.environ["ZERODHA_API_SECRET"]

    def get_login_url(self) -> str:
        return _new_kite(self.api_key).login_url()

    def exchange_request_token(self, request_token: str) -> dict:
        kite = _new_kite(self.api_key)
        data = kite.generate_session(request_token, api_secret=self.api_secret)
        access_token = data["access_token"]
        TOKEN_FILE.write_text(json.dumps({"access_token": access_token}))
        kite.set_access_token(access_token)
        self._kite = kite
        return data

    def _load_cached_token(self):
        if TOKEN_FILE.exists():
            data = json.loads(TOKEN_FILE.read_text())
            kite = _new_kite(self.api_key)
            kite.set_access_token(data["access_token"])
            self._kite = kite

    def is_logged_in(self) -> bool:
        if self._kite is None:
            self._load_cached_token()
        if self._kite is None:
            return False
        try:
            self._kite.profile()
            return True
        except Exception:
            return False

    def get_api(self) -> KiteConnect:
        if self._kite is None:
            self._load_cached_token()
        if self._kite is None:
            raise Exception("Not logged in. Call /zerodha/auth/login-url then /zerodha/auth/callback first.")
        return self._kite

    def get_profile(self):
        return self.get_api().profile()

    def get_funds(self):
        return self.get_api().margins()

    def get_positions(self):
        return self.get_api().positions()

    def get_holdings(self):
        return self.get_api().holdings()

    def get_order_book(self):
        return self.get_api().orders()

    def place_order(self, variety: str, exchange: str, tradingsymbol: str, transaction_type: str,
                     quantity: int, product: str, order_type: str, price: float = None,
                     trigger_price: float = None, validity: str = "DAY"):
        return self.get_api().place_order(
            variety=variety,
            exchange=exchange,
            tradingsymbol=tradingsymbol,
            transaction_type=transaction_type,
            quantity=quantity,
            product=product,
            order_type=order_type,
            price=price,
            trigger_price=trigger_price,
            validity=validity,
        )

    def modify_order(self, variety: str, order_id: str, **fields):
        return self.get_api().modify_order(variety=variety, order_id=order_id, **fields)

    def cancel_order(self, variety: str, order_id: str):
        return self.get_api().cancel_order(variety=variety, order_id=order_id)

    def get_trades(self):
        return self.get_api().trades()

    def get_ltp(self, instruments: list[str]) -> dict[str, float]:
        """{"NFO:NIFTY2670725000CE": ltp, ...} for the given "EXCHANGE:TRADINGSYMBOL" keys."""
        data = self.get_api().ltp(instruments)
        return {k: v.get("last_price") for k, v in (data or {}).items()}

    def get_order_margins(self, orders: list[dict]):
        return self.get_api().order_margins(orders)

    def get_basket_margins(self, orders: list[dict]):
        return self.get_api().basket_order_margins(orders)

    def get_expiry_map(self, exchange: str = "NFO") -> dict[str, str]:
        """tradingsymbol -> expiry (YYYY-MM-DD), from Kite's instrument dump for the segment.
        Cached in memory since the full dump is large and expiries don't change intraday."""
        now = time.time()
        if exchange not in self._expiry_cache or now - self._expiry_cache_ts.get(exchange, 0) > EXPIRY_CACHE_TTL:
            rows = self.get_api().instruments(exchange)
            m = {}
            for r in rows:
                exp = r.get("expiry")
                if exp:
                    m[r["tradingsymbol"]] = exp.isoformat() if hasattr(exp, "isoformat") else str(exp)
            self._expiry_cache[exchange] = m
            self._expiry_cache_ts[exchange] = now
        return self._expiry_cache[exchange]

    def get_gtts(self):
        return self.get_api().get_gtts()

    def place_gtt(self, trigger_type: str, tradingsymbol: str, exchange: str,
                   trigger_values: list[float], last_price: float, orders: list[dict]):
        return self.get_api().place_gtt(trigger_type, tradingsymbol, exchange, trigger_values, last_price, orders)

    def modify_gtt(self, trigger_id: int, trigger_type: str, tradingsymbol: str, exchange: str,
                    trigger_values: list[float], last_price: float, orders: list[dict]):
        return self.get_api().modify_gtt(trigger_id, trigger_type, tradingsymbol, exchange, trigger_values, last_price, orders)

    def delete_gtt(self, trigger_id: int):
        return self.get_api().delete_gtt(trigger_id)

    def logout(self):
        api = self.get_api()
        api.invalidate_access_token()
        self._kite = None
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()


client = ZerodhaClient()
