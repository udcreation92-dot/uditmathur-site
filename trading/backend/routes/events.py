from fastapi import APIRouter
from pydantic import BaseModel
import events_db

router = APIRouter(prefix="/events", tags=["events"])


@router.get("/unseen")
def unseen():
    return events_db.get_unseen()


class MarkSeenRequest(BaseModel):
    ids: list[int]


@router.post("/mark-seen")
def mark_seen(req: MarkSeenRequest):
    events_db.mark_seen(req.ids)
    return {"status": "ok"}


@router.get("/recent")
def recent(limit: int = 50):
    return events_db.recent(limit)
