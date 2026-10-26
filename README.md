# bots

一个飞书 / Lark 机器人，用 **WebSocket 长连接**收发消息：不用公网 IP，不用域名，不用证书，不用内网穿透，不用自己处理加密和验签。

约 200 行，零框架，只依赖官方 SDK。同时包含**把开发者后台配置也脚本化**的部分 —— 那块没有公开 API，是这类项目真正卡住的地方。

```
飞书事件 ──WS长连接──▶ on_event() 去重+入池 ──▶ respond() 你的逻辑 ──▶ 回复
```

## 快速开始

```bash
git clone https://github.com/<you>/bots.git && cd bots
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

cp .env.example .env      # 填 FEISHU_APP_ID / FEISHU_APP_SECRET
.venv/bin/python bot.py
```

日志出现 `connected to wss://msg-frontier.feishu.cn/...` 就连上了。在飞书里私聊机器人、或在群里 @ 它。

改业务逻辑只动一个方法：

```python
def respond(self, text: str, message) -> str | None:
    if text == "ping":
        return "pong"
    return None          # 返回 None 就是不回复
```

## 配置一个全新应用

三条路，从少到多：

**1. 官方一键建应用**（只需要扫码确认一次）

```python
import lark_oapi as lark
lark.register_app(
    on_qr_code=lambda d: print(d["url"]),
    app_preset={"name": "my bot"},
    addons={
        "scopes": {"tenant": ["im:message:send_as_bot",
                              "im:message.p2p_msg:readonly"]},
        "events": {"items": {"tenant": ["im.message.receive_v1"]}},
    },
)
```

**2. 本仓库的脚本**（已有应用，或需要发布版本）

```bash
.venv/bin/pip install playwright && playwright install chrome
.venv/bin/python bot.py &                      # mode 步骤要验证活的连接
.venv/bin/python console/bootstrap.py scopes --headed
.venv/bin/python console/bootstrap.py mode
.venv/bin/python console/bootstrap.py event
.venv/bin/python console/bootstrap.py publish
.venv/bin/python console/bootstrap.py status   # 复核
.venv/bin/python console/read_secret.py        # 写入 .env，不回显
```

**3. 手动点**：`docs/how-it-works.md` 里有逐项清单和两个踩过的坑。

## 目录

```
bot.py                  机器人本体（去重 / 线程池 / 分片发送）
console/bootstrap.py    后台配置：权限、长连接、事件、发布
console/read_secret.py  取 App Secret 写入 .env（mode 600，不回显）
deploy/bot.plist        macOS launchd 常驻
docs/how-it-works.md    原理、约束、后台配置的坑
```

## 三个必须知道的约束

| 约束 | 后果 | 本仓库怎么处理 |
| --- | --- | --- |
| 事件必须 **3 秒内**处理完，否则重推 4 次 | 慢逻辑会让你回复 5 条 | `on_event()` 只去重+`submit()`，业务在池里 |
| 重推 = 重复消息 | 重复回复 / 重复执行 | 按 `message_id` 去重（**不是** `event_id`） |
| 长连接是集群模式，非广播 | 起两个实例不会分担，只会随机各收一半 | 单实例；要扩容请自己做分片，别靠多开 |

另外：每个应用最多 50 个连接；群里 @ 机器人时文本里带 `@_user_1` 占位符，需要剥掉（`strip_mentions()`）。

## 常驻

```bash
# 编辑 deploy/bot.plist 里的两处 REPLACE_ME
cp deploy/bot.plist ~/Library/LaunchAgents/com.example.bots.plist
launchctl load -w ~/Library/LaunchAgents/com.example.bots.plist
```

Linux 用 systemd，同理。

## 安全

- `.env`（mode 600）保存凭据，已在 `.gitignore` 里；**不要**提交。
- `console/read_secret.py` 直接写文件而不打印，避免密钥进 shell history / 聊天记录。
- Secret 泄露就在后台「凭证与基础信息 → 重置」，然后重新跑 `read_secret.py`。
- `.state/profile` 是 Playwright 的登录态（约 100MB），可随时删；删后重新扫码。

## 相关

- 官方 SDK：[larksuite/oapi-sdk-python](https://github.com/larksuite/oapi-sdk-python)
- 官方示例：[oapi-sdk-python-demo](https://github.com/larksuite/oapi-sdk-python-demo)
- 官方 CLI（不写代码直接收发）：[larksuite/cli](https://github.com/larksuite/cli)
- 要现成的多平台 AI 机器人平台：[LangBot](https://github.com/langbot-app/LangBot)

## License

MIT
