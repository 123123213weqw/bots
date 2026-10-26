#!/usr/bin/env python3
"""Bring a brand-new Feishu self-built app to "bot can receive and reply".

Steps, in order, each idempotent:

    scopes   open the three IM application scopes
    mode     switch event subscription to the WebSocket long connection
    event    subscribe im.message.receive_v1
    publish  create and publish version 1.0.0

Usage:
    python console/bootstrap.py scopes|mode|event|publish|status

Note: `mode` verifies the long connection against a *live* client, so run
`python bot.py` in another terminal first. `publish` makes the configuration
effective for users immediately (self-built apps are exempt from review).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import app_url, body_text, dismiss_popups, run, wait_login  # noqa: E402

SCOPES = [
    "im:message.p2p_msg:readonly",      # read direct messages to the bot
    "im:message.group_at_msg:readonly",  # read group messages that @ the bot
    "im:message:send_as_bot",            # send as the app
]
EVENT = "im.message.receive_v1"
PAYLOAD = json.dumps({"scopes": {"tenant": SCOPES, "user": []}}, ensure_ascii=False)


def app_id() -> str:
    from bot import load_env
    load_env()
    value = os.environ.get("FEISHU_APP_ID")
    if not value:
        raise SystemExit("FEISHU_APP_ID missing")
    return value


def add_scopes(page, aid: str) -> int:
    page.goto(app_url(aid, "/auth"), wait_until="domcontentloaded")
    page.wait_for_timeout(4000)
    dismiss_popups(page)
    if all(s in body_text(page) for s in SCOPES):
        print("scopes: already present")
        return 0

    page.get_by_role("button", name="Batch import/export scopes").first.click()
    page.wait_for_timeout(2000)

    # The dialog's checkbox column sits outside the narrow side panel, so the
    # batch editor is the only reliable path. Monaco needs real key events.
    editor = page.locator(".monaco-editor").first
    editor.click()
    page.wait_for_timeout(300)
    mod = "Meta" if sys.platform == "darwin" else "Control"
    page.keyboard.press(f"{mod}+a")
    page.keyboard.press("Backspace")
    page.keyboard.insert_text(PAYLOAD)
    page.wait_for_timeout(600)

    page.get_by_role("button", name="Next, Review New Scopes").first.click()
    page.wait_for_timeout(2500)
    review = body_text(page)
    if "Newly added scopes (0)" in review:
        print("scopes: nothing to add")
        return 0
    print("scopes: review ->", review[review.find("Newly added"):][:160].replace("\n", " "))

    page.get_by_role("button", name="Add", exact=True).first.click()
    page.wait_for_timeout(4000)

    page.goto(app_url(aid, "/auth"), wait_until="domcontentloaded")
    page.wait_for_timeout(4000)
    text = body_text(page)
    missing = [s for s in SCOPES if s not in text]
    print("scopes: missing =", missing or "none")
    return 1 if missing else 0


def set_long_connection(page, aid: str) -> int:
    page.goto(app_url(aid, "/event"), wait_until="domcontentloaded")
    page.wait_for_timeout(5000)
    if "persistent connection" in body_text(page):
        print("mode: already long connection")
        return 0

    page.locator("button:has([data-icon='EditOutlined'])").first.click()
    page.wait_for_timeout(2500)
    page.get_by_text("Receive events through persistent connection", exact=False).first.click()
    page.wait_for_timeout(800)
    page.get_by_role("button", name="Verify").first.click()
    page.wait_for_timeout(6000)

    text = body_text(page)
    if "Connected" not in text:
        print("mode: verify failed - is bot.py running?")
        return 1
    page.get_by_role("button", name="Save").first.click()
    page.wait_for_timeout(4000)
    print("mode: saved")
    return 0


def add_event(page, aid: str) -> int:
    page.goto(app_url(aid, "/event"), wait_until="domcontentloaded")
    page.wait_for_timeout(5000)
    if EVENT in body_text(page):
        print("event: already subscribed")
        return 0

    page.get_by_role("button", name="Add Events").first.click()
    page.wait_for_timeout(2500)
    search = page.locator("input[placeholder='Search']").first
    search.click()
    search.fill("receive_v1")
    page.wait_for_timeout(3000)
    page.locator("input[type=checkbox]").first.check(force=True)
    page.wait_for_timeout(800)
    print("event: selected ->", [l for l in body_text(page).split("\n") if "Events selected" in l])

    page.get_by_role("button", name="Add", exact=True).first.click()
    page.wait_for_timeout(4000)
    page.goto(app_url(aid, "/event"), wait_until="domcontentloaded")
    page.wait_for_timeout(5000)
    ok = EVENT in body_text(page)
    print("event: added =", ok)
    return 0 if ok else 1


def publish(page, aid: str) -> int:
    page.goto(app_url(aid, "/version"), wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    if "Pending release" not in body_text(page) and "Create Version" not in body_text(page):
        print("publish: unexpected version page")
        return 1
    if "Pending release" not in body_text(page):
        page.get_by_role("button", name="Create Version").first.click()
        page.wait_for_timeout(3500)
        page.get_by_role("button", name="Save", exact=True).first.click()
        page.wait_for_timeout(5000)

    publish_btn = page.get_by_role("button", name="Publish", exact=True)
    if publish_btn.count() == 0:
        print("publish: no Publish button (already released?)")
        return 0
    publish_btn.first.click()
    page.wait_for_timeout(3000)
    confirm = page.get_by_role("button", name="Publish", exact=True)
    if confirm.count() > 1:
        confirm.last.click()
    elif "Submit the release request?" in body_text(page):
        confirm.first.click()
    page.wait_for_timeout(8000)

    page.goto(app_url(aid), wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    released = "have been published" in body_text(page)
    print("publish: released =", released)
    return 0 if released else 1


def status(page, aid: str) -> int:
    for path, label in (("/auth", "scopes"), ("/event", "events")):
        page.goto(app_url(aid, path), wait_until="domcontentloaded")
        page.wait_for_timeout(4000)
        text = body_text(page)
        present = [s for s in SCOPES if s in text]
        print(f"{label}: {len(present)}/{len(SCOPES)} scopes"
              + (", event ok" if EVENT in text else "")
              + (", long connection" if "persistent connection" in text else ""))
    return 0


STEPS = {
    "scopes": add_scopes,
    "mode": set_long_connection,
    "event": add_event,
    "publish": publish,
    "status": status,
}


def main(page) -> int:
    aid = app_id()
    step = sys.argv[1] if len(sys.argv) > 1 else "status"
    if step not in STEPS:
        raise SystemExit(f"usage: {sys.argv[0]} {'|'.join(STEPS)}")
    if not wait_login(page, aid):
        print("login timeout")
        return 2
    return STEPS[step](page, aid)


if __name__ == "__main__":
    sys.exit(run(main))
