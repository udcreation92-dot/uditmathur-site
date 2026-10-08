from fastapi import APIRouter
import span_watcher

router = APIRouter(prefix="/span-watch", tags=["span-watch"])


@router.get("/status")
def status():
    return span_watcher.get_status()


@router.post("/check-now")
def check_now():
    return span_watcher.check_now()
