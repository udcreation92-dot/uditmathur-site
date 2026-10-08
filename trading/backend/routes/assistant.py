from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Literal

import llm_client

router = APIRouter(prefix="/assistant", tags=["assistant"])

# The brevity contract the user asked for — short, crisp, to the point.
SYSTEM_PROMPT = (
    "You are a concise assistant embedded in an Indian stock-trading dashboard. Answer in a SHORT, "
    "crisp, to-the-point way — ideally 1-3 sentences, a tight list at most. No preamble, no "
    "filler, no repeating the question. If a question genuinely needs more, give the key answer "
    "first, then a brief note. You have general knowledge but NO access to the user's live "
    "positions or real-time prices — if asked about those, say so briefly. This is not personalised "
    "investment advice."
)

MAX_HISTORY = 12  # cap turns sent to the model to keep latency/cost bounded


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AskRequest(BaseModel):
    messages: List[Message]


@router.post("/ask")
def ask(req: AskRequest):
    msgs = [m for m in req.messages if m.content.strip()][-MAX_HISTORY:]
    if not msgs or msgs[-1].role != "user":
        raise HTTPException(400, "The last message must be a non-empty user message")
    reply = llm_client.chat([m.dict() for m in msgs], system=SYSTEM_PROMPT)
    if not reply:
        raise HTTPException(503, "Assistant unavailable — no LLM key configured or the call failed")
    return {"answer": reply.strip()}
