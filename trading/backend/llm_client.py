"""Single entry point for structured-JSON LLM calls. Prefers DeepSeek (much cheaper per token
than Gemini and no restrictive free-tier daily caps) when DEEPSEEK_API_KEY is set; otherwise
falls back to the existing Gemini client so the pipeline keeps working with either key.

DeepSeek's API is OpenAI-compatible and has no native responseSchema constraint — instead we
use its JSON output mode plus the schema embedded in the prompt, then parse/validate the reply.
"""
import os
import json
import requests

import gemini_client

DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")


def _deepseek_key() -> str | None:
    return os.environ.get("DEEPSEEK_API_KEY")


def generate_json(prompt: str, schema: dict, timeout: int = 45):
    """Returns parsed JSON matching `schema`, or None on any failure — callers treat AI output
    as best-effort enrichment and must fall back gracefully (and never cache a None)."""
    key = _deepseek_key()
    if not key:
        return gemini_client.generate_json(prompt, schema, timeout=timeout)
    body = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system",
             "content": "You are a precise assistant. Reply ONLY with valid JSON that conforms "
                        "to the JSON Schema the user provides — no prose, no markdown fences."},
            {"role": "user",
             "content": f"{prompt}\n\nRespond ONLY with JSON conforming to this JSON Schema:\n{json.dumps(schema)}"},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
    }
    try:
        resp = requests.post(DEEPSEEK_URL, headers={"Authorization": f"Bearer {key}"},
                             json=body, timeout=timeout)
        resp.raise_for_status()
        return json.loads(resp.json()["choices"][0]["message"]["content"])
    except Exception:
        return None


def chat(messages: list[dict], system: str = None, timeout: int = 45) -> str | None:
    """Plain-text multi-turn chat for the dashboard's ask/assistant box. `messages` is a list of
    {role: 'user'|'assistant', content: str}. Prefers DeepSeek; falls back to Gemini (flattened,
    since Gemini's free tier is day-capped). Returns the reply text, or None on failure."""
    key = _deepseek_key()
    if key:
        msgs = ([{"role": "system", "content": system}] if system else []) + messages
        body = {"model": DEEPSEEK_MODEL, "messages": msgs, "temperature": 0.3}
        try:
            resp = requests.post(DEEPSEEK_URL, headers={"Authorization": f"Bearer {key}"},
                                 json=body, timeout=timeout)
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        except Exception:
            return None
    # Gemini fallback: flatten the turns into one prompt.
    convo = "\n".join(f"{m['role'].capitalize()}: {m['content']}" for m in messages)
    return gemini_client.generate_text(convo, system=system, timeout=timeout)


def is_configured() -> bool:
    return bool(_deepseek_key() or os.environ.get("GEMINI_API_KEY"))
