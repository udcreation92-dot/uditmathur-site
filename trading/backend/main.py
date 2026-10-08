import os
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from routes.market import router as market_router
from routes.analysis import router as analysis_router
from routes.orders import router as orders_router
from routes.strategy import router as strategy_router
from routes.gtt import router as gtt_router
from routes.alerts import router as alerts_router
from routes.reports import router as reports_router
from routes.tbill_watch import router as tbill_watch_router
from routes.span_watch import router as span_watch_router
from routes.zerodha import router as zerodha_router
from routes.shoonya import router as shoonya_router
from routes.rss import router as rss_router
from routes.holidays import router as holidays_router
from routes.events import router as events_router
from routes.calendar import router as calendar_router
from routes.news import router as news_router
from routes.assistant import router as assistant_router
from routes.stream import router as stream_router
from routes.totp import router as totp_router
from routes.scalp import router as scalp_router
from routes.autologin import router as autologin_router
from routes.roi_solver import router as roi_solver_router
from routes.strategies import router as strategies_router
from routes.order_exec import router as order_exec_router
from fyers_client import client
import tbill_watcher
import span_watcher
import rss_watcher
import holiday_calendar
import pnl_watcher
import backup_watcher
import event_calendar
import corporate_actions
import auto_exit_watcher
import auto_login
import order_watcher

app = FastAPI(title="Trading API", version="1.0.0")

origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(market_router)
app.include_router(analysis_router)
app.include_router(orders_router)
app.include_router(strategy_router)
app.include_router(gtt_router)
app.include_router(alerts_router)
app.include_router(reports_router)
app.include_router(tbill_watch_router)
app.include_router(span_watch_router)
app.include_router(zerodha_router)
app.include_router(shoonya_router)
app.include_router(rss_router)
app.include_router(holidays_router)
app.include_router(events_router)
app.include_router(calendar_router)
app.include_router(news_router)
app.include_router(assistant_router)
app.include_router(stream_router)
app.include_router(totp_router)
app.include_router(scalp_router)
app.include_router(autologin_router)
app.include_router(roi_solver_router)
app.include_router(strategies_router)
app.include_router(order_exec_router)

@app.on_event("startup")
def _start_tbill_watcher():
    tbill_watcher.ensure_started()

@app.on_event("startup")
def _start_span_watcher():
    span_watcher.ensure_started()

@app.on_event("startup")
def _start_rss_watcher():
    rss_watcher.ensure_started()

@app.on_event("startup")
def _start_telegram_news():
    import telegram_news
    telegram_news.ensure_started()

@app.on_event("startup")
def _start_holiday_watcher():
    holiday_calendar.ensure_started()

@app.on_event("startup")
def _start_auto_login():
    # after holiday_calendar so the trading-day check has the feed; the scheduler waits for 08:30 IST
    auto_login.ensure_started()

@app.on_event("startup")
def _start_order_watcher():
    # continuously reconcile PENDING orders (fill/cancel) + Telegram on transitions, no dashboard needed
    order_watcher.ensure_started()

@app.on_event("startup")
def _start_pnl_watcher():
    pnl_watcher.ensure_started()

@app.on_event("startup")
def _start_backup_watcher():
    backup_watcher.ensure_started()

@app.on_event("startup")
def _start_event_calendar():
    event_calendar.ensure_started()

@app.on_event("startup")
def _start_corporate_actions():
    corporate_actions.ensure_started()

@app.on_event("startup")
def _start_auto_exit_watcher():
    auto_exit_watcher.ensure_started()

@app.on_event("startup")
def _start_scalp_watcher():
    import scalp_watcher
    scalp_watcher.ensure_started()

@app.on_event("startup")
def _start_holding_target_watcher():
    import holding_target_watcher
    holding_target_watcher.ensure_started()

@app.on_event("startup")
def _start_fyers_stream():
    # Opens the live data socket if a Fyers token exists; a no-op (retried on first /stream call)
    # when not logged in yet. Runs in a thread so nothing about the socket can ever block startup.
    import threading
    def _go():
        try:
            import fyers_ws
            fyers_ws.ensure_started()
        except Exception:
            pass
    threading.Thread(target=_go, daemon=True).start()

@app.get("/")
def root():
    return {"status": "ok"}

@app.get("/auth/status")
def auth_status():
    return {"logged_in": client.is_logged_in()}

@app.get("/auth/login-url")
def login_url():
    return {"url": client.get_login_url()}

@app.post("/auth/callback")
def auth_callback(auth_code: str):
    try:
        result = client.exchange_auth_code(auth_code)
        return {"status": "logged in", "access_token": result["access_token"][:20] + "..."}
    except Exception as e:
        raise HTTPException(400, str(e))

FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173/task/trading.html")

@app.get("/auth/fyers/redirect")
def fyers_auth_redirect(auth_code: str = None, code: str = None, s: str = None):
    """Receives Fyers' OAuth redirect directly (browser navigates here, no user action needed),
    exchanges the code server-side, then bounces the browser back to the frontend — replacing
    the old flow where the user had to copy/paste the redirect URL by hand every day."""
    token = auth_code or code
    if not token:
        return RedirectResponse(f"{FRONTEND_URL}?fyers_login=error")
    try:
        client.exchange_auth_code(token)
        return RedirectResponse(f"{FRONTEND_URL}?fyers_login=success")
    except Exception:
        return RedirectResponse(f"{FRONTEND_URL}?fyers_login=error")
