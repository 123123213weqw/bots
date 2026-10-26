#!/usr/bin/env python3
"""Copy the app secret into .env without printing it.

Typing a 32-char secret by hand is the usual way it leaks (shell history,
screen sharing, chat). This reveals it in the console page and writes the file
directly, mode 600.
"""
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import app_url, run, wait_login  # noqa: E402

from bot import load_env  # noqa: E402

ENV = Path(__file__).resolve().parent.parent / ".env"


def main(page) -> int:
    load_env()
    aid = os.environ.get("FEISHU_APP_ID")
    if not aid:
        raise SystemExit("FEISHU_APP_ID missing")
    if not wait_login(page, aid):
        print("login timeout")
        return 2

    page.goto(app_url(aid, "/baseinfo"), wait_until="domcontentloaded")
    page.wait_for_timeout(4000)

    # Two .secret-code blocks exist: [0] is the App ID, [1] is the secret.
    block = page.locator(".secret-code").nth(1)
    block.scroll_into_view_if_needed()
    block.locator("[data-icon='VisibleOutlined']").first.click()
    page.wait_for_timeout(1500)
    secret = block.inner_text().strip()

    if not secret or "∗" in secret or len(secret) < 16:
        print("secret still masked")
        return 3

    lines = []
    if ENV.exists():
        lines = [
            line for line in ENV.read_text().splitlines()
            if line and not line.startswith("FEISHU_APP_ID=")
        ]
    lines.insert(0, f"FEISHU_APP_ID={aid}")
    lines.insert(1, f"FEISHU_APP_SECRET={secret}")
    ENV.write_text("\n".join(lines) + "\n")
    os.chmod(ENV, stat.S_IRUSR | stat.S_IWUSR)
    print(f"wrote {ENV} (mode 600, secret length {len(secret)})")
    return 0


if __name__ == "__main__":
    sys.exit(run(main))
