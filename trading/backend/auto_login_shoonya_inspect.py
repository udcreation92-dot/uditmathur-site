"""
DRAFT / discovery helper — dumps the field structure of Shoonya's OAuth login page so we can
write accurate Playwright selectors for the real auto-login. Runs ON THE BOX (home IP) because
api.shoonya.com blocks datacenter IPs and the page is a JS SPA that only renders from a real,
whitelisted browser. Enters NO credentials — it just loads the page and prints its inputs/buttons.

Prereqs:  pip install playwright  &&  python -m playwright install chromium
Run:      python auto_login_shoonya_inspect.py
Then paste the printed JSON back so the full Shoonya login script can be authored.
"""
import json
import requests
from playwright.sync_api import sync_playwright

DUMP_JS = """els => els.map(e => ({
  tag: e.tagName, type: e.type || '', id: e.id || '', name: e.name || '',
  placeholder: e.placeholder || '', ariaLabel: e.getAttribute('aria-label') || '',
  text: (e.innerText || e.value || '').slice(0, 40)
}))"""


def main():
    url = requests.get("http://localhost:8000/shoonya/auth/login-url", timeout=10).json()["url"]
    print(f"OAuth URL: {url}")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(url, wait_until="networkidle", timeout=45000)
        page.wait_for_timeout(2500)  # let the SPA finish rendering
        fields = page.eval_on_selector_all("input, button, select, a[role=button]", DUMP_JS)
        labels = page.eval_on_selector_all("label", "els => els.map(e => (e.innerText||'').slice(0,40))")
        print(json.dumps({
            "final_url": page.url,
            "title": page.title(),
            "body_len": page.evaluate("document.body.innerHTML.length"),
            "field_count": len(fields),
            "fields": fields,
            "labels": labels,
        }, indent=1))
        browser.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"INSPECT FAILED: {e}")
