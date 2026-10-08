"""Headless Claude (Pro subscription) via the `claude -p` CLI — no API key / no per-token cost.

Used for bulletin extraction and article summarization, which were moved off DeepSeek onto the
subscription. The prompt is fed on STDIN (not argv) so large article text can't hit Windows
command-line length or quoting limits. All calls run on Haiku to stay light on the subscription's
rate limit, which is shared with the 30-min news-digest routine.

Trade-off accepted by the user: a cold `claude -p` start is ~10s, noticeably slower than DeepSeek,
but free. No DeepSeek fallback — a failed Claude call just returns None and the caller degrades."""
import json
import re
import shutil
import subprocess
import threading

MODEL = "haiku"

# Cap how many `claude -p` processes run at once. Each is a heavy Node process; a burst of Telegram
# "Summarize" taps must not spawn a swarm that starves the box (the same concern that bloated the
# process list before). Extra callers block briefly until a slot frees.
_MAX_CONCURRENT = 2
_slots = threading.Semaphore(_MAX_CONCURRENT)


def is_configured() -> bool:
    """True if the Claude CLI is available on PATH (subscription assumed already logged in)."""
    return shutil.which("claude") is not None


def run(prompt: str, system: str | None = None, timeout: int = 120) -> str | None:
    """Run one headless Claude turn and return its text output, or None on any failure.

    `system` is folded into the prompt (portable across CLI versions). The prompt goes on stdin so
    arbitrarily long text is safe. shell=True routes through cmd.exe, which resolves the `claude`
    shim (claude.cmd) from PATH the same way the digest routine's launcher does."""
    if not is_configured():
        return None
    full = f"{system.strip()}\n\n{prompt}" if system else prompt
    with _slots:
        try:
            proc = subprocess.run(
                f"claude -p --model {MODEL}",
                shell=True,
                input=full.encode("utf-8"),
                capture_output=True,
                timeout=timeout,
            )
        except Exception:
            return None
    if proc.returncode != 0:
        return None
    out = (proc.stdout or b"").decode("utf-8", "replace").strip()
    return out or None


def _strip_fences(text: str) -> str:
    """Pull a JSON object out of the model's reply, tolerating ```json fences or stray prose."""
    t = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)\s*```", t, re.DOTALL)
    if m:
        t = m.group(1).strip()
    # Fall back to the outermost {...} span if there's leading/trailing chatter.
    if not t.startswith("{"):
        i, j = t.find("{"), t.rfind("}")
        if i != -1 and j != -1 and j > i:
            t = t[i:j + 1]
    return t


def generate_json(prompt: str, schema: dict, timeout: int = 120):
    """Claude has no server-side schema enforcement like DeepSeek's response_format, so we describe
    the required shape in the prompt and parse defensively. Returns the parsed dict, or None if the
    call fails or the reply isn't valid JSON (callers already treat None as "no result")."""
    keys = list((schema.get("properties") or {}).keys())
    shape = ", ".join(keys) if keys else "the requested fields"
    instruction = (
        "Respond with ONLY a single JSON object (no markdown, no commentary) containing exactly "
        f"these keys: {shape}. Match this JSON Schema:\n{json.dumps(schema)}"
    )
    out = run(f"{prompt}\n\n{instruction}", timeout=timeout)
    if not out:
        return None
    try:
        return json.loads(_strip_fences(out))
    except Exception:
        return None
