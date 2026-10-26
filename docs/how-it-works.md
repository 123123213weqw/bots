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
typed event object          (already deserialized: { sender, message })
   │
   ▼
Bot.onEvent()               ← dedupe on message_id, enqueue, return immediately
   │
   ▼
handler(message)            ← your logic, a plain function
   │
   ├── { kind: "text"  }  → message.reply / message.create
   └── { kind: "image" }  → image.create (upload) → message.reply (send)
```

That is the whole trick: the SDK's `WSClient` opens an **outbound** connection,
so there is no inbound port, no public IP, no TLS certificate, no `challenge`
handshake, no AES decryption. Compare with webhook mode, where you must serve
`POST /anything`, answer `url_verification` within 1 second, decrypt when an
Encrypt Key is set, and keep an endpoint reachable forever.

### The three constraints that shape the code

1. **3-second budget.** The platform treats an event as handled only if your
   handler returns within 3 seconds; otherwise it retries, 4 times. So
   `onEvent()` does nothing but dedupe and enqueue — it is synchronous, and
   `tests/bot.test.ts` asserts it returns in under 50 ms even when the handler
   sleeps for a second. A 4-second LLM call inline makes you reply five times.
2. **Retries mean duplicates.** Deduplicate on `message_id`, not `event_id`.
   As a second net, outbound sends carry a `uuid` derived from the same
   `message_id`, so the platform also drops repeats (`uuid` is per-message
   idempotency; each text chunk gets its own).
3. **Clustered delivery, not broadcast.** With several clients of one app, an
   event reaches exactly one of them, chosen at random. Running two instances
   "for redundancy" silently halves your throughput. Max 50 connections/app.

### Payload quirks

`message.content` is a **JSON string**, not an object:

```json
{"text": "@_user_1 deploy please"}
```

In group chats the mention becomes a placeholder token `@_user_1`. If you do not
strip it, every command parser sees a bogus prefix (`stripMentions`).

Non-text messages carry no `text` field at all: an image arrives as
`{"image_key":"img_v3_..."}` and is fetched by `message_id` + `file_key` through
`im.v1.messageResource.get`, not by URL.

## Layer 1b — the media pipeline

Sending an image is two requests, because the message body cannot carry bytes:

```
image.create({ data: { image_type: "message", image: Buffer } })
   → { image_key: "img_v3_..." }
message.create({ data: {
    receive_id, msg_type: "image",
    content: JSON.stringify({ image_key })      // content is a *string*
} })
```

Two things bite here:

* **`im:resource` is a separate scope.** `im:message:send_as_bot` alone gives
  you `99991672 Access denied`, which reads like a messaging problem and is not.
* **The SDK is inconsistent about response envelopes.** `im.v1.image.create`
  resolves to the unwrapped payload (`{image_key}`), while
  `im.v1.message.create` resolves to `{code, msg, data}`. `unwrap()` in
  `src/feishu.ts` normalises both, so an SDK change cannot silently turn into
  `undefined` instead of an error.

Uploads are cached by content hash: sending the same chart twice costs one
upload. Local validation (size, extension) runs before any network call, so a
32 MB PNG fails in microseconds instead of after a 10-second upload.

## Layer 2 — app configuration

There is no public "configure my app" API. The deliverables:

| What | Where | Automatable? |
| --- | --- | --- |
| Enable the bot capability | Features → Add Features → Bot | Console only |
| Grant scopes | Permissions & Scopes | Console only, but **batch import** takes JSON |
| Event subscription mode | Events & Callbacks → ✏️ | Console only; needs a live connection to verify |
| Subscribe an event | Events & Callbacks → Add Events | Console only |
| Publish a version | Version Management | Console only, self-built apps skip review |
| Read App Secret | Credentials & Basic Info | Console only |

For a **new** app there is one shortcut: the official SDK creates the app
itself, scopes and events pre-filled, via a QR flow the user confirms once.

```python
import lark_oapi as lark

lark.register_app(
    on_qr_code=lambda d: print(d["url"]),
    app_preset={"name": "{user}'s bot"},
    addons={
        "scopes": {"tenant": ["im:message:send_as_bot",
                              "im:message.p2p_msg:readonly",
                              "im:resource"]},
        "events": {"items": {"tenant": ["im.message.receive_v1"]}},
    },
)
```

`addons` is additive only and deliberately cannot carry sensitive settings
(request URLs, Encrypt Key), so it does not cover everything — but it removes
most of the clicking.

For an **existing** app, or for publishing, `console/bootstrap.py` drives the
page with Playwright. It is honest about being brittle: the selectors track the
current console markup, verified 2026-10-26. When the console is redesigned they
break. That is why every step reads the page back and prints what it found
instead of reporting success blindly.

### Three traps found the hard way

* **The scope picker's checkbox column can be off-viewport.** In a narrow window
  the checkbox sits at a negative x coordinate, so DOM clicks land on nothing
  and the row never selects. The batch-import editor has no such problem — hence
  `add_scopes()` uses Monaco plus real key events, then verifies each scope
  string appears on the page afterwards.
* **The batch editor ships with a sample payload** (`im:message:send_as_bot` +
  `docx:document:readonly`). If you append instead of replacing, you silently
  request permissions you never wanted. `Ctrl/Cmd+A` + `Backspace` first.
* **The import button moved.** It used to be standalone; it now lives inside a
  "Batch Actions" dropdown. The script tries both, because a silent redesign
  otherwise looks like "permission already granted". The same applies to
  publishing: a draft can be sitting in "Not Requested" state, in which case
  `Create Version` is disabled and you must open the draft and publish *it*.

### Scope choices

| Scope | Why |
| --- | --- |
| `im:message.p2p_msg:readonly` | read direct messages sent to the bot |
| `im:message.group_at_msg:readonly` | read group messages that @ the bot |
| `im:message:send_as_bot` | reply as the app |
| `im:resource` | upload images/files before sending them |

Deliberately not requested: `im:message.group_msg` (all group messages — a
sensitive scope) and `im:chat:readonly` (list groups). Add them only when a
feature needs them; every extra scope is an extra approval and a wider blast
radius.
