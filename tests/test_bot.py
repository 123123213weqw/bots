#!/usr/bin/env python3
"""Offline checks for the parts that are easy to get wrong.

No network, no credentials: run with `python tests/test_bot.py`.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("bot", ROOT / "bot.py")
botmod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(botmod)


def test_dedup_first_sighting():
    d = botmod.Deduper(ttl=60)
    assert d.first_sight("om_1") is True
    assert d.first_sight("om_1") is False
    assert d.first_sight("om_2") is True


def test_dedup_ttl_expiry():
    """A stale id must be accepted again, otherwise the map grows forever."""
    d = botmod.Deduper(ttl=5.0)
    assert d.first_sight("x", now=1000.0) is True
    assert d.first_sight("x", now=1002.0) is False
    assert d.first_sight("x", now=1010.0) is True


def test_dedup_bounded_memory():
    d = botmod.Deduper(ttl=10_000, max_items=3)
    for i in range(50):
        d.first_sight(f"k{i}", now=float(i))
    assert len(d._seen) <= 3, len(d._seen)


def test_mentions_stripped():
    assert botmod.strip_mentions("@_user_1 deploy now") == "deploy now"
    assert botmod.strip_mentions("@_user_12 @_user_3  hi") == "hi"
    assert botmod.strip_mentions("no mention") == "no mention"


def test_chunking():
    assert botmod.Bot._chunks("short") == ["short"]
    parts = botmod.Bot._chunks("a" * 9000)
    assert [len(p) for p in parts] == [4000, 4000, 1000]


def test_text_extraction():
    text = types.SimpleNamespace(message_type="text", content='{"text":"@_user_1 ping"}')
    image = types.SimpleNamespace(message_type="image", content='{"image_key":"img_x"}')
    broken = types.SimpleNamespace(message_type="text", content="not json")
    assert botmod.Bot._text_of(text) == "ping"
    assert botmod.Bot._text_of(image) == ""
    assert botmod.Bot._text_of(broken) == ""


def test_respond_contract():
    bot = botmod.Bot.__new__(botmod.Bot)
    text = types.SimpleNamespace(message_type="text", content='{"text":"ping"}')
    image = types.SimpleNamespace(message_type="image", content="{}")
    assert bot.respond("ping", text) == "收到：ping"
    assert bot.respond("", text) == "在，说点什么？"
    assert "image" in bot.respond("", image)


def test_on_event_replies_once_under_retry():
    """The platform retries up to 4 times; only the first must be processed."""
    bot = botmod.Bot.__new__(botmod.Bot)
    bot._dedup = botmod.Deduper(ttl=60)
    bot._pool = types.SimpleNamespace(submit=lambda fn, *a: fn(*a))

    sent = []
    seen = []
    bot.respond = lambda text, message: seen.append(text) or f"ok:{text}"
    bot.reply = lambda chat_id, text: sent.append((chat_id, text))

    message = types.SimpleNamespace(
        message_id="om_same",
        chat_id="oc_test",
        message_type="text",
        content=json.dumps({"text": "@_user_1 hello"}),
    )
    event = types.SimpleNamespace(event=types.SimpleNamespace(message=message))

    for _ in range(5):  # initial delivery + 4 retries
        bot.on_event(event)

    assert sent == [("oc_test", "ok:hello")], sent
    assert seen == ["hello"], seen


def test_handler_failure_does_not_raise():
    bot = botmod.Bot.__new__(botmod.Bot)
    bot._dedup = botmod.Deduper(ttl=60)
    bot._pool = types.SimpleNamespace(submit=lambda fn, *a: fn(*a))

    def boom(text, message):
        raise RuntimeError("downstream blew up")

    bot.respond = boom
    bot.reply = lambda *a: None
    message = types.SimpleNamespace(
        message_id="om_boom", chat_id="oc", message_type="text",
        content='{"text":"hi"}',
    )
    bot.on_event(types.SimpleNamespace(event=types.SimpleNamespace(message=message)))
    return True


def main() -> int:
    failures = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_"):
            continue
        try:
            fn()
            print(f"ok   {name}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"ERR  {name}: {type(exc).__name__}: {exc}")
    print(f"\n{'all passed' if not failures else f'{failures} failed'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
