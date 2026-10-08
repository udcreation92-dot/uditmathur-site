import datetime
import io
import zipfile
from pathlib import Path
import requests

TARGET_DIR = Path(r"C:\Users\udcre\OneDrive\Documents\TradingData\SPAN")

# Order matters: begin-of-day file first, then successive intraday snapshots, then
# end-of-day. NSE publishes these at different times through the trading day.
SESSION_CODES = ["i1", "i2", "i3", "i4", "i5", "s"]

BASE_URL = "https://nsearchives.nseindia.com/archives/nsccl/span/nsccl.{date}.{code}.zip"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Referer": "https://www.nseindia.com/all-reports-derivatives",
}


def _extracted_name(date_str: str, code: str) -> str:
    # NSE's URL uses "i1".."i5" but the .spn file inside the zip is zero-padded ("i01".."i05");
    # "s" (end of day) is not padded. Must match the real extracted name or every hourly
    # check would think the file is missing and re-download/re-extract it forever.
    if code.startswith("i"):
        code = f"i{int(code[1:]):02d}"
    return f"nsccl.{date_str}.{code}.spn"


def _file_date(name: str) -> str | None:
    """"nsccl.20260707.i03.spn" -> "20260707" (also handles the ".s.spn" end-of-day file)."""
    parts = name.split(".")
    if len(parts) >= 3 and parts[0] == "nsccl" and len(parts[1]) == 8 and parts[1].isdigit():
        return parts[1]
    return None


def _prune_older_than(keep_date: str) -> list[dict]:
    """Delete every nsccl .spn file dated before keep_date. Only touches SPAN session files —
    the .pos exports and Results.csv living in the same folder are left alone."""
    removed = []
    for p in TARGET_DIR.glob("nsccl.*.spn"):
        d = _file_date(p.name)
        if d and d < keep_date:
            try:
                p.unlink()
                removed.append({"date": d, "code": "-", "status": "removed", "message": p.name})
            except OSError as e:
                removed.append({"date": d, "code": "-", "status": "error", "message": f"couldn't remove {p.name}: {e}"})
    return removed


def check_and_download(days_back: int = 6) -> list[dict]:
    """Keep only the LATEST trading day's NSE SPAN session files on disk. Starting from today and
    walking back (to cover the case where today's aren't published yet, or today is a holiday/
    weekend), the first date that has any session file — already downloaded or fetched now — is
    taken as the current trading day: its missing session files are downloaded, and every older
    day's .spn is pruned. Returns a list of {date, code, status, message} for this run."""
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    today = datetime.date.today()
    newest_date = None

    for days_ago in range(days_back):
        date_str = (today - datetime.timedelta(days=days_ago)).strftime("%Y%m%d")
        got_any = any((TARGET_DIR / _extracted_name(date_str, code)).exists() for code in SESSION_CODES)

        for code in SESSION_CODES:
            dest = TARGET_DIR / _extracted_name(date_str, code)
            if dest.exists():
                continue  # already have it

            url = BASE_URL.format(date=date_str, code=code)
            try:
                resp = requests.get(url, headers=HEADERS, timeout=30)
            except Exception as e:
                results.append({"date": date_str, "code": code, "status": "error", "message": str(e)})
                continue

            if resp.status_code == 404:
                continue  # not released yet (or non-trading day) — not an error
            if resp.status_code != 200:
                results.append({"date": date_str, "code": code, "status": "error",
                                 "message": f"HTTP {resp.status_code}"})
                continue

            try:
                with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                    zf.extractall(TARGET_DIR)
                got_any = True
                results.append({"date": date_str, "code": code, "status": "downloaded",
                                 "message": dest.name if dest.exists() else "extracted"})
            except zipfile.BadZipFile:
                results.append({"date": date_str, "code": code, "status": "error", "message": "Bad zip file"})

        # First day (newest-first) with any files is the current trading day — don't look at
        # older days, and prune everything before it so only this day's files remain.
        if got_any:
            newest_date = date_str
            break

    if newest_date:
        results.extend(_prune_older_than(newest_date))

    return results


def list_local_files() -> list[str]:
    if not TARGET_DIR.exists():
        return []
    return sorted(p.name for p in TARGET_DIR.glob("nsccl.*.spn"))
