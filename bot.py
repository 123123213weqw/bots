#!/usr/bin/env python3
"""Feishu / Lark bot over a WebSocket long connection.

Design constraints that shape this file (see docs/how-it-works.md):

* The platform redelivers an event unless it is handled within 3 seconds, up to
  4 times. The handler therefore must not do slow work inline.
* Redelivery means the same message can arrive twice. Deduplicate on
  ``message_id`` (not ``event_id``).
* Long connections are clustered: with several clients of one app only a random
  single client receives a given event. Do not rely on broadcast.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import lark_oapi as lark
from lark_oapi.api.im.v1 import (
    CreateMessageRequest,
    CreateMessageRequestBody,
    P2ImMessageReceiveV1,
)

HERE = Path(__file__).resolve().parent
MAX_CHARS = 4000
MENTION = re.compile(r"@_user_\d+\s*")

log = logging.getLogger("bots")


def load_env(path: Path = HERE / ".env") -> None:
    """Populate os.environ from a KEY=VALUE file without overriding real env."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


class Deduper:
    """Remember recently seen ids; return True only on the first sighting."""

    def __init__(self, ttl: float = 900.0, max_items: int = 20_000) -> None:
        self._ttl = ttl
        self._max = max_items
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def first_sight(self, key: str, now: float | None = None) -> bool:
        stamp = time.monotonic() if now is None else now
        with self._lock:
            previous = self._seen.get(key)
            # An entry older than the TTL is stale: the retry window is long
            # past, and treating it as a duplicate forever would leak memory.
            if previous is not None and stamp - previous <= self._ttl:
                return False
            self._seen[key] = stamp
            self._prune(stamp)
            return True

    def _prune(self, now: float) -> None:
        if len(self._seen) > self._max:
            self._seen.clear()
            return
        stale = [k for k, t in self._seen.items() if now - t > self._ttl]
        for key in stale:
            del self._seen[key]


def strip_mentions(text: str) -> str:
    """Group messages arrive as '@_user_1 hello'; drop the placeholders."""
    return MENTION.sub("", text).strip()


class Bot:
    def __init__(self, app_id: str, app_secret: str) -> None:
        self._client = (
            lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
        )
        self._dedup = Deduper()
        # Small pool: replies are I/O bound and the handler thread must return
        # immediately so the platform does not consider the event unfinished.
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="reply")

    # ---- sending -----------------------------------------------------------
    @staticmethod
    def _chunks(text: str) -> list[str]:
        if len(text) <= MAX_CHARS:
            return [text]
        return [text[i:i + MAX_CHARS] for i in range(0, len(text), MAX_CHARS)]

    def reply(self, chat_id: str, text: str) -> bool:
        ok = True
        for chunk in self._chunks(text):
            body = (
                CreateMessageRequestBody.builder()
                .receive_id(chat_id)
                .msg_type("text")
                .content(json.dumps({"text": chunk}, ensure_ascii=False))
                .build()
            )
            request = (
                CreateMessageRequest.builder()
                .receive_id_type("chat_id")
                .request_body(body)
                .build()
            )
            response = self._client.im.v1.message.create(request)
            if response.code != 0:
                ok = False
                log.error("send failed chat=%s code=%s msg=%s",
                          chat_id, response.code, response.msg)
        return ok

    # ---- receiving ---------------------------------------------------------
    def on_event(self, data: P2ImMessageReceiveV1) -> None:
        """Called on the SDK event loop. Must return fast."""
        message = data.event.message
        if not self._dedup.first_sight(message.message_id):
            log.info("duplicate ignored id=%s", message.message_id)
            return
        self._pool.submit(self._handle, message)

    def _handle(self, message) -> None:
        try:
            text = self._text_of(message)
            log.info("recv chat=%s type=%s text=%r",
                     message.chat_id, message.message_type, text[:120])
            answer = self.respond(text, message)
            if answer:
                self.reply(message.chat_id, answer)
        except Exception:  # one bad message must not kill the worker
            log.exception("handler crashed chat=%s", message.chat_id)

    @staticmethod
    def _text_of(message) -> str:
        if message.message_type != "text":
            return ""
        try:
            return strip_mentions(json.loads(message.content).get("text", ""))
        except (TypeError, ValueError):
            return ""

    # ---- your logic --------------------------------------------------------
    def respond(self, text: str, message) -> str | None:
        """Replace this. Return None to stay silent."""
        if message.message_type != "text":
            return f"暂时只处理文本消息（收到 {message.message_type}）。"
        if not text:
            return "在，说点什么？"
        return f"收到：{text}"


def build(app_id: str, app_secret: str) -> tuple[Bot, lark.EventDispatcherHandler]:
    bot = Bot(app_id, app_secret)
    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(bot.on_event)
        .build()
    )
    return bot, handler


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    load_env()
    app_id = os.environ.get("FEISHU_APP_ID")
    app_secret = os.environ.get("FEISHU_APP_SECRET")
    if not (app_id and app_secret):
        raise SystemExit("FEISHU_APP_ID / FEISHU_APP_SECRET missing (see .env.example)")

    _, handler = build(app_id, app_secret)
    log.info("connecting app_id=%s", app_id)
    lark.ws.Client(
        app_id,
        app_secret,
        event_handler=handler,
        log_level=lark.LogLevel.INFO,
    ).start()  # blocks until stopped


if __name__ == "__main__":
    main()
