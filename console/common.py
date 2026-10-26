"""Shared helpers for driving the Feishu developer console with Playwright.

The console has no public API for app configuration, so the only way to script
"open these scopes / subscribe this event / publish a version" is to drive the
page. These helpers keep that honest: every step reads the page back and
verifies the result instead of assuming a click worked.
"""
from __future__ import annotations

import time
from pathlib import Path

from playwright.sync_api import BrowserContext, Page, sync_playwright

APP_ID_ENV = "FEISHU_APP_ID"
BASE = "https://open.feishu.cn/app"
ROOT = Path(__file__).resolve().parent.parent
PROFILE = ROOT / ".state" / "profile"


def launch(p, headless: bool = True) -> tuple[BrowserContext, Page]:
    ctx = p.chromium.launch_persistent_context(
        str(PROFILE),
        headless=headless,
        channel="chrome",
        viewport={"width": 1440, "height": 900},
        args=["--no-first-run", "--no-default-browser-check"],
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    return ctx, page


def app_url(app_id: str, path: str = "") -> str:
    return f"{BASE}/{app_id}{path}"


def wait_login(page: Page, app_id: str, timeout: float = 300.0) -> bool:
    """Navigate to the app and wait for the scan-to-login wall to disappear."""
    page.goto(app_url(app_id, "/auth"), wait_until="domcontentloaded")
    deadline = time.time() + timeout
    announced = False
    while time.time() < deadline:
        if "accounts.feishu.cn" not in page.url and f"/app/{app_id}" in page.url:
            return True
        if not announced:
            print("Scan the QR code in the opened browser to sign in.", flush=True)
            announced = True
        page.wait_for_timeout(2000)
    return False


def dismiss_popups(page: Page) -> None:
    for name in ("Got It", "OK"):
        buttons = page.get_by_role("button", name=name)
        for i in range(buttons.count()):
            try:
                buttons.nth(i).click(timeout=1200)
            except Exception:
                pass
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)


def body_text(page: Page) -> str:
    return page.inner_text("body")


def run(main) -> int:
    """Boilerplate: launch, hand over (context, page), always close."""
    import sys

    with sync_playwright() as p:
        ctx, page = launch(p, headless="--headed" not in sys.argv)
        try:
            return main(page) or 0
        finally:
            ctx.close()
