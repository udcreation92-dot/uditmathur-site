import os
import json
import threading
import requests
from pathlib import Path
from fyers_apiv3 import fyersModel
import state_paths

TOKEN_FILE = state_paths.state_path(".fyers_token.json")


def _proxies() -> dict | None:
    """TrueIP (or any) proxy for Fyers order/API calls, so requests egress from a
    static, Fyers-whitelisted IP instead of the dynamic home IP. Set FYERS_PROXY_URL
    to route; leave blank to go direct. Only Fyers uses this session — Shoonya must
    stay off the proxy (its API host blocks the datacenter IP)."""
    url = os.environ.get("FYERS_PROXY_URL", "").strip()
    return {"http": url, "https": url} if url else None


class FyersClient:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._fyers = None
        return cls._instance

    @property
    def client_id(self):
        return os.environ["FYERS_CLIENT_ID"]

    @property
    def secret_key(self):
        return os.environ["FYERS_SECRET_KEY"]

    @property
    def redirect_uri(self):
        return os.environ["FYERS_REDIRECT_URI"]

    def get_login_url(self) -> str:
        session = fyersModel.SessionModel(
            client_id=self.client_id,
            redirect_uri=self.redirect_uri,
            response_type="code",
            state="trading-app",
            grant_type="authorization_code",
        )
        return session.generate_authcode()

    def _build_model(self, access_token: str) -> "fyersModel.FyersModel":
        """Construct a FyersModel and attach the proxy to its underlying requests.Session
        so all order/quote/position calls egress from the whitelisted IP."""
        model = fyersModel.FyersModel(
            client_id=self.client_id, token=access_token, is_async=False
        )
        proxies = _proxies()
        if proxies and getattr(model, "service", None) is not None:
            sess = getattr(model.service, "session", None)
            if sess is not None:
                sess.proxies.update(proxies)
        return model

    def exchange_auth_code(self, auth_code: str) -> dict:
        session = fyersModel.SessionModel(
            client_id=self.client_id,
            secret_key=self.secret_key,
            redirect_uri=self.redirect_uri,
            response_type="code",
            grant_type="authorization_code",
        )
        session.set_token(auth_code)
        result = session.generate_token()
        if result.get("s") != "ok":
            raise Exception(f"Token generation failed: {result}")

        access_token = result["access_token"]
        TOKEN_FILE.write_text(json.dumps({"access_token": access_token}))
        self._fyers = self._build_model(access_token)
        return result

    def _load_cached_token(self):
        if TOKEN_FILE.exists():
            data = json.loads(TOKEN_FILE.read_text())
            self._fyers = self._build_model(data["access_token"])

    def is_logged_in(self) -> bool:
        if self._fyers is None:
            self._load_cached_token()
        if self._fyers is None:
            return False
        profile = self._fyers.get_profile()
        return profile.get("s") == "ok"

    def get_api(self) -> "fyersModel.FyersModel":
        if self._fyers is None:
            self._load_cached_token()
        if self._fyers is None:
            raise Exception("Not logged in. Call /auth/login-url then /auth/callback first.")
        return self._fyers

    def get_quotes(self, symbols: str):
        return self.get_api().quotes({"symbols": symbols})

    def get_candles(self, symbol: str, resolution: str, range_from: str, range_to: str):
        return self.get_api().history({
            "symbol": symbol,
            "resolution": resolution,
            "date_format": "1",
            "range_from": range_from,
            "range_to": range_to,
            "cont_flag": "1",
        })

    def place_order(self, symbol: str, qty: int, side: int, order_type: int,
                    product_type: str, limit_price: float = 0, stop_price: float = 0):
        return self.get_api().place_order({
            "symbol": symbol,
            "qty": qty,
            "type": order_type,        # 1=Limit, 2=Market, 3=Stop, 4=StopLimit
            "side": side,              # 1=Buy, -1=Sell
            "productType": product_type,  # INTRADAY, CNC, MARGIN
            "limitPrice": limit_price,
            "stopPrice": stop_price,
            "validity": "DAY",
            "disclosedQty": 0,
            "offlineOrder": False,
        })

    def place_basket_order(self, legs: list[dict]):
        """legs: list of dicts (symbol, qty, side, type, productType, limitPrice, stopPrice)"""
        orders = [{
            "symbol": leg["symbol"],
            "qty": leg["qty"],
            "type": leg["type"],
            "side": leg["side"],
            "productType": leg.get("productType", "INTRADAY"),
            "limitPrice": leg.get("limitPrice", 0),
            "stopPrice": leg.get("stopPrice", 0),
            "disclosedQty": 0,
            "validity": "DAY",
            "offlineOrder": False,
        } for leg in legs]
        return self.get_api().place_basket_orders(orders)

    def get_option_chain(self, symbol: str, strike_count: int = 10, timestamp: str = ""):
        return self.get_api().optionchain({
            "symbol": symbol,
            "strikecount": strike_count,
            "timestamp": timestamp,
        })

    def get_depth(self, symbol: str):
        return self.get_api().depth({"symbol": symbol, "ohlcv_flag": 1})

    def get_margin(self, legs: list[dict]) -> dict:
        """
        legs: list of dicts with keys: symbol, qty, side (1=Buy,-1=Sell),
              type (1=Limit,2=Market), productType, limitPrice, stopLoss
        """
        api = self.get_api()
        auth = f"{api.client_id}:{api.token}"
        resp = requests.post(
            "https://api-t1.fyers.in/api/v3/multiorder/margin",
            headers={"Authorization": auth, "Content-Type": "application/json"},
            json={"data": legs},
            timeout=15,
            proxies=_proxies(),
        )
        return resp.json()

    def get_funds(self):
        return self.get_api().funds()

    def get_positions(self):
        return self.get_api().positions()

    def get_order_book(self):
        return self.get_api().orderbook()

    # ---- Order management ----
    def modify_order(self, order_id: str, **fields):
        """fields may include: limitPrice, stopPrice, qty, type"""
        return self.get_api().modify_order({"id": order_id, **fields})

    def cancel_order(self, order_id: str):
        return self.get_api().cancel_order({"id": order_id})

    def exit_positions(self, position_id: str = None):
        data = {"id": position_id} if position_id else {}
        return self.get_api().exit_positions(data)

    def convert_position(self, symbol: str, position_side: int, convert_qty: int,
                         convert_from: str, convert_to: str):
        return self.get_api().convert_position({
            "symbol": symbol,
            "positionSide": position_side,
            "convertQty": convert_qty,
            "convertFrom": convert_from,
            "convertTo": convert_to,
        })

    # ---- Multileg orders ----
    def place_multileg_order(self, legs: list[dict], product_type: str = "INTRADAY", order_type: str = "2L"):
        """legs: list of dicts (symbol, qty, side, type, limitPrice) — 2 or 3 legs, IOC validity"""
        return self.get_api().place_multileg_order({
            "productType": product_type,
            "offlineOrder": False,
            "orderType": order_type,   # "2L" or "3L"
            "validity": "IOC",
            "legs": [{
                "symbol": leg["symbol"],
                "qty": leg["qty"],
                "side": leg["side"],
                "type": leg.get("type", 1),
                "limitPrice": leg.get("limitPrice", 0),
            } for leg in legs],
        })

    # ---- GTT orders ----
    def place_gtt_order(self, symbol: str, side: int, product_type: str, leg1: dict, leg2: dict = None):
        data = {
            "side": side,
            "symbol": symbol,
            "productType": product_type,
            "orderInfo": {"leg1": leg1},
        }
        if leg2:
            data["orderInfo"]["leg2"] = leg2
        return self.get_api().place_gtt_order(data)

    def modify_gtt_order(self, order_id: str, leg1: dict, leg2: dict = None):
        data = {"id": order_id, "orderInfo": {"leg1": leg1}}
        if leg2:
            data["orderInfo"]["leg2"] = leg2
        return self.get_api().modify_gtt_order(data)

    def cancel_gtt_order(self, order_id: str):
        return self.get_api().cancel_gtt_order({"id": order_id})

    def get_gtt_orders(self):
        return self.get_api().gtt_orderbook()

    # ---- Alerts ----
    def create_alert(self, symbol: str, comparison_type: str, condition: str, value, name: str):
        return self.get_api().create_alert({
            "alert-type": 1,
            "name": name,
            "symbol": symbol,
            "comparisonType": comparison_type,
            "condition": condition,
            "value": value,
        })

    def update_alert(self, alert_id: str, symbol: str, comparison_type: str, condition: str, value, name: str):
        return self.get_api().update_alert({
            "alertId": alert_id,
            "alert-type": 1,
            "symbol": symbol,
            "comparisonType": comparison_type,
            "condition": condition,
            "value": value,
            "name": name,
        })

    def delete_alert(self, alert_id: str):
        return self.get_api().delete_alert({"alertId": alert_id})

    def toggle_alert(self, alert_id: str):
        return self.get_api().toggle_alert({"alertId": alert_id})

    def get_alerts(self, archive: int = 0):
        return self.get_api().get_alert({"archive": archive})

    # ---- Reports ----
    def get_tradebook(self):
        return self.get_api().tradebook()

    def get_holdings(self):
        return self.get_api().holdings()

    def get_order_history(self, **params):
        return self.get_api().orderhistory(params)

    def get_ledger_history(self, **params):
        return self.get_api().ledger_history(params)

    def get_realised_profit_history(self, **params):
        return self.get_api().realised_profit_history(params)

    def get_tax_pnl_history(self, **params):
        return self.get_api().tax_pnl_history(params)

    def get_charges_history(self, **params):
        return self.get_api().charges_history(params)

    # ---- Misc ----
    def get_market_status(self):
        return self.get_api().market_status()

    def logout(self):
        result = self.get_api().logout()
        self._fyers = None
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()
        return result


client = FyersClient()
