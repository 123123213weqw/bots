# How it works

Two layers. Only the first one is code you write; the second has no public API
and is where most of the pain actually lives.

## Layer 1 — runtime

```
Feishu event
   │  im.message.receive_v1
   ▼
WebSocket long connection   (wss://msg-frontier.feishu.cn, SDK handles auth,
   │                         decryption, ping, reconnect)
   ▼
P2ImMessageReceiveV1        (typed, already deserialized)
   │
   ▼
Bot.on_event()              ← dedupe on message_id, hand off to a thread pool
   │
   ▼
Bot.respond()               ← your logic, plain string in / string out
   │
   ▼
client.im.v1.message.create(receive_id_type="chat_id", msg_type="text")
```

That is the whole trick: the SDK's `lark.ws.Client` opens an outbound
connection, so there is no inbound port, no public IP, no TLS certificate, no
`challenge` handshake, no AES decryption of the payload. Compare with the
webhook mode, where you must serve `POST /anything`, answer `url_verification`
within 1 second, decrypt the body when an Encrypt Key is set, and keep an
endpoint reachable from the public internet forever.

### The three constraints that shape the code

1. **3-second budget.** The platform considers an event handled only if your
   handler returns within 3 seconds. Otherwise it retries — 4 times. So
   `on_event()` does nothing but dedupe and `submit()`. All work happens on a
   worker thread. A 4-second LLM call inline will make you reply five times.
2. **Retries mean duplicates.** Deduplicate on `message_id`. Do not use
   `event_id` — the docs are explicit that duplicates can share neither, and
   `message_id` is the stable identity of the message itself.
3. **Clustered delivery, not broadcast.** With several clients of the same app,
   a given event reaches exactly one of them at random. Running two instances
   "for redundancy" does not duplicate work, it silently halves it. Maximum 50
   connections per app.

### Text payload quirks

`message.content` is a **JSON string**, not an object:

```json
{"text": "@_user_1 deploy please"}
```

In group chats the mention becomes a placeholder token `@_user_1`. If you do not
strip it, every command parser sees a bogus prefix. `strip_mentions()` handles
that.

## Layer 2 — app configuration

There is no public "configure my app" API. The deliverables:

| What | Where | Automatable? |
| --- | --- | --- |
| Enable the bot capability | Features → Add Features → Bot | Console only |
| Grant scopes | Permissions & Scopes | Console only, but **batch import** takes JSON |
| Event subscription mode | Events & Callbacks → ✏️ | Console only; requires a live connection to verify |
| Subscribe an event | Events & Callbacks → Add Events | Console only |
| Publish a version | Version Management | Console only, self-built apps skip review |
| Read App Secret | Credentials & Basic Info | Console only |

For a **new** app there is one shortcut worth knowing: the official SDK can
create the app itself, scopes and events pre-filled, through a QR-code flow the
user confirms once:

```python
import lark_oapi as lark

lark.register_app(
    on_qr_code=lambda d: print(d["url"]),
    app_preset={"name": "{user}'s bot"},
    addons={
        "scopes": {"tenant": ["im:message:send_as_bot",
                              "im:message.p2p_msg:readonly"]},
        "events": {"items": {"tenant": ["im.message.receive_v1"]}},
    },
)
```

`addons` is additive only and deliberately cannot carry sensitive settings
(request URLs, Encrypt Key), so it does not cover everything — but it removes
most of the clicking.

For an **existing** app, or for publishing, `console/bootstrap.py` drives the
page with Playwright. It is honest about being brittle: the selectors are tied
to the current console markup, verified 2026-10-26. When the console is
redesigned, these break. That is why every step reads the page back and prints
what it found instead of reporting success blindly.

### Two traps found the hard way

* **The scope picker's checkbox column can be off-viewport.** In a narrow window
  the checkbox sits at a negative x coordinate, so DOM clicks land on nothing
  and the row never selects. The batch-import editor has no such problem —
  hence `add_scopes()` uses Monaco plus real key events, then verifies each
  scope string appears on the page afterwards.
* **The batch editor ships with a sample payload** (`im:message:send_as_bot` +
  `docx:document:readonly`). If you append instead of replacing, you silently
  request permissions you never wanted. `Ctrl/Cmd+A` + `Backspace` first.

### Scope choices

| Scope | Why |
| --- | --- |
| `im:message.p2p_msg:readonly` | read direct messages sent to the bot |
| `im:message.group_at_msg:readonly` | read group messages that @ the bot |
| `im:message:send_as_bot` | reply as the app |

Deliberately not requested: `im:message.group_msg` (all group messages — a
sensitive scope) and `im:chat:readonly` (list groups). Add them only if a
feature needs them; every extra scope is an extra approval and an extra blast
radius.
