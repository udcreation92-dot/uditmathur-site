from fastapi import APIRouter
import holiday_calendar

router = APIRouter(prefix="/holidays", tags=["holidays"])


@router.get("/status")
def status():
    return holiday_calendar.get_status()


@router.post("/check-now")
def check_now():
    return holiday_calendar.check_now()


@router.get("/all")
def all_holidays():
    return holiday_calendar.get_all()


@router.get("/upcoming")
def upcoming(days: int = 10):
    return holiday_calendar.get_upcoming(days=days)
