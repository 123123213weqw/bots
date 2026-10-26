# bots

一个飞书 / Lark 机器人，**TypeScript**，用 **WebSocket 长连接**收发消息：不用公网 IP，不用域名，不用证书，不用内网穿透，不用自己处理加密和验签。

除了文本，还有一条完整的**出站媒体管线**：上传拿到 `image_key` → 再发消息。发图片、发文件都是这个套路。

```
飞书事件 ──WS长连接──▶ onEvent() 去重+入队 ──▶ handler() 你的逻辑 ──▶ 回复
                                                        │
                                                        └─ 图片：upload → image_key → send
```

## 快速开始

```bash
git clone https://github.com/<you>/bots.git && cd bots
npm install

cp .env.example .env      # 填 FEISHU_APP_ID / FEISHU_APP_SECRET
npm start                 # Node ≥ 23.6 可直接跑 TS
```

日志出现 `connection ready` 就连上了。在飞书里私聊机器人、或在群里 @ 它。

在聊天里发 **`图`**（或 `图片` / `image` / `pic`），它会回一张图 —— 用来验证媒体管线通没通。

改业务逻辑只动 `src/index.ts` 里的 `handler()`：

```ts
async function handler(message: Incoming): Promise<Reply | null> {
  if (message.text === "ping") return { kind: "text", text: "pong" };
  if (message.text === "图")   return { kind: "image", source: "assets/sample.png" };
  return null;                       // null = 不回复
}
```

## 发图片 / 发文件：两步

平台不接受在消息体里塞二进制，必须先上传拿 key：

| 步骤 | 接口 | 说明 |
| --- | --- | --- |
| 1 | `POST /open-apis/im/v1/images` | `image_type=message`，multipart 上传，返回 `image_key` |
| 2 | `POST /open-apis/im/v1/messages` | `msg_type=image`，`content={"image_key":"..."}` |

```ts
// 一行：内部自动上传 + 缓存 + 发送
await messenger.sendImage(chatId, "assets/sample.png");
await messenger.replyImage(messageId, buffer);          // 回在某条消息的线程里
const key = await messenger.uploadImage("chart.png");   // 只上传，复用 key
```

**必须多开一个权限：`im:resource`**（或 `im:resource:upload`）。它和 `im:message:send_as_bot` 是两回事 —— 只开消息权限上传会报 `99991672`，错误信息完全看不出是权限问题。

限制（`src/feishu.ts` 里在本地就拦掉，不发无效请求）：

| 项 | 值 |
| --- | --- |
| 图片大小 | ≤ 10 MB，0 字节直接拒绝 |
| 图片格式 | JPG / JPEG / PNG / WEBP / GIF / BMP / ICO / TIFF / HEIC（TIFF、HEIC 会被转 JPG） |
| 分辨率 | GIF ≤ 2000×2000，其他 ≤ 12000×12000，头像 ≤ 4096×4096 |
| 文件大小 | ≤ 30 MB |

同一张图重复发送只上传一次（按内容 sha256 缓存，LRU 100 条）。

命令行也能发，方便塞进 CI / cron：

```bash
npm run send -- upload --file assets/sample.png          # 打印 image_key
npm run send -- image --chat oc_xxx --file assets/sample.png
npm run send -- text  --chat oc_xxx "build passed"
```

## 接大模型（DeepSeek）

`.env` 里配上三行就生效，不配则自动退回回显模式（不会启动失败）：

```
DEEPSEEK_API_KEY=<你的 key>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

因为是 OpenAI 兼容接口，换任何同协议的供应商（`.../v1`、中转、本地 vLLM）只改 `BASE_URL` + `MODEL` 即可。

行为：

| 输入 | 反应 |
|---|---|
| `ping` | 直接回 `pong`，不调模型 |
| `图` / `图片` / `image` / `pic` | 回示例图片，不调模型 |
| `清空` / `重置` / `reset` | 真的清空该会话上下文 |
| 其它文本 | 带上下文调用模型 |

上下文是**每群/每人独立、有上限**的（默认 6 条消息、最多 200 个会话），进程重启即忘记——故意不做持久化，避免把群聊历史落盘。

**密钥安全**（代码层面保证，不是靠自觉）：

- key 只从环境变量读，从不打印、不写日志、不进错误信息；provider 若在报错里回显 key，`redact()` 会先抹掉。
- 请求体也从不落日志——用户提问可能同样敏感。
- `.env` 在 `.gitignore` 里，`deploy.sh` **默认保留服务器上的 `.env`**，不会用本地文件覆盖（只有 `PUSH_ENV=1` 才覆盖）；否则每次部署都会悄悄删掉服务器上的 key。
- 没有 key 时不会崩，只是回显——所以“看起来在跑”不等于“模型接上了”，启动日志会明确打印 `llm=deepseek-chat` 或 `llm=none (echo mode)`。

## 三个必须知道的约束

| 约束 | 后果 | 本仓库怎么处理 |
| --- | --- | --- |
| 事件必须 **3 秒内**处理完，否则重推 4 次 | 慢逻辑会让你回复 5 条 | `onEvent` 只去重 + 入队，返回是同步的（有测试卡 <50ms） |
| 重推 = 重复消息 | 重复回复 / 重复执行 | 按 `message_id` 去重；发送时再带一个由它派生的 `uuid`，让平台侧也去重 |
| 长连接是集群模式，非广播 | 起两个实例不会分担，只会随机各收一半 | 单实例；扩容请自己做分片 |

另外：每个应用最多 50 个连接；群里 @ 机器人时文本带 `@_user_1` 占位符，会剥掉（`stripMentions`）；`message.content` 是 **JSON 字符串**不是对象。

## 配置一个全新应用

三条路，从少到多：

**1. 官方一键建应用**（扫码确认一次，SCopes/事件都预填）

```python
import lark_oapi as lark
lark.register_app(
    on_qr_code=lambda d: print(d["url"]),
    app_preset={"name": "my bot"},
    addons={
        "scopes": {"tenant": [
            "im:message:send_as_bot",
            "im:message.p2p_msg:readonly",
            "im:resource",                 # 发图片必需
        ]},
        "events": {"items": {"tenant": ["im.message.receive_v1"]}},
    },
)
```

**2. 本仓库的脚本**（已有应用，或需要发布版本）

```bash
python3 -m venv .venv && .venv/bin/pip install playwright && .venv/bin/playwright install chrome
npm start &                                        # mode 步骤要验证活的连接
.venv/bin/python console/bootstrap.py scopes
.venv/bin/python console/bootstrap.py mode
.venv/bin/python console/bootstrap.py event
.venv/bin/python console/bootstrap.py publish
.venv/bin/python console/bootstrap.py status        # 复核
.venv/bin/python console/read_secret.py             # 写入 .env，不回显
```

> 配置脚本仍是 Python + Playwright：控制台没有公开 API，只能驱动页面。
> 见 `docs/how-it-works.md`，里面有逐项清单和三个踩过的坑。

**3. 手动点**：`docs/how-it-works.md` 第二层。

## 目录

```
src/
  index.ts     入口：长连接 + 你的 handler
  bot.ts       事件 → handler → 回复（去重、并发队列、reply/send 两种模式）
  feishu.ts    出站管线：文本分片、图片上传+缓存、文件、下载入站图片
  util.ts      Deduper / Queue / LruCache / chunk / stripMentions
  llm.ts       DeepSeek 客户端（含 redact，保证 key 不外泄）
  handler.ts   业务逻辑：命令 + 模型调用 + 上下文（可注入假模型测试）
  history.ts   每会话短上下文，有上限
  cli.ts       命令行发送（cron / CI 通知）
  config.ts    .env 读取
tests/         node:test，50 个用例，全部离线
console/       开发者后台自动化（Python + Playwright）
deploy/        systemd unit + deploy.sh + macOS launchd
assets/        示例图片
```

## 开发

```bash
npm test          # node --test，50 个用例，不需要网络和凭据（Node >= 22.6）
npm run build     # tsc 输出到 dist/（给 Node < 23.6 用）
npx tsc -p tsconfig.test.json   # 连测试一起类型检查
```

测试覆盖的是容易写错的地方：重推 5 次只回 1 条、TTL/容量边界、代理对不被切断、上传只发生一次、错误码转成异常、handler 抛异常不影响后续消息、**provider 在报错里回显 key 时被 redact**、`重置` 真的清了上下文、无 key 时退回回显而不是崩溃。

## 部署

**能跑在任何能出网的地方** —— 长连接是主动向外建 WebSocket，所以不需要公网 IP、端口映射、域名或证书。装在 GPU 服务器、内网机器、笔记本上都一样。

Node 版本决定跑法：

| Node | 跑法 |
| --- | --- |
| >= 23.6 | `node src/index.ts` 直接跑 TS |
| 22.6 - 23.5 | `node --experimental-strip-types src/index.ts` |
| 20 - 22.5 | `npm run build && node dist/index.js`（生产建议一律用这条） |

`npm test` 直接跑 `.ts`，需要 Node >= 22.6；Node 20 上跑不了测试，只能跑编译产物。
`deploy.sh` 生产路径一律用 `dist/`，所以 Node 20 也能正常服务，只是本地开发受限。

### Linux / systemd（推荐）

```bash
./deploy/deploy.sh user@host        # 同步 + 装依赖 + 编译 + 装 unit + 重启

# 宿主机 Node 太老、又不想动系统 Node 时，指定一个独立解释器：
NODE_BIN=/opt/node-v24.22.1/bin/node ./deploy/deploy.sh user@host
```

前提：目标机已执行 `loginctl enable-linger <user>`，否则登出后用户级服务会被回收。

**不要动 `/usr/local/bin/node`** —— 共享机器上往往还有别的服务（宝塔面板、其它 Node 项目）挂在上面。`deploy.sh` 只把 `~/bots/.node` 这个软链接指向你选的解释器，`bot.service` 用 `%h/bots/.node`，所以换版本就是 `ln -sfn`，一个命令、互不影响。独立装一份 Node：

```bash
V=v24.22.1
curl -fsSLO https://npmmirror.com/mirrors/node/$V/node-$V-linux-x64.tar.xz
curl -fsSL  https://npmmirror.com/mirrors/node/$V/SHASUMS256.txt | grep "$V-linux-x64.tar.xz" | sha256sum -c
sudo mkdir -p /opt && sudo tar -xJf node-$V-linux-x64.tar.xz -C /opt \
  && sudo mv /opt/node-$V-linux-x64 /opt/node-$V
```

手工等价步骤：

```bash
rsync -az --exclude node_modules --exclude .env ./ user@host:~/bots/
ssh user@host 'cd ~/bots && npm ci && npx tsc -p tsconfig.json'
scp .env user@host:~/bots/.env && ssh user@host 'chmod 600 ~/bots/.env'
ssh user@host 'mkdir -p ~/.config/systemd/user && \
  cp ~/bots/deploy/bot.service ~/.config/systemd/user/feishu-bot.service && \
  systemctl --user daemon-reload && systemctl --user enable --now feishu-bot.service'
```

日志：`journalctl --user -u feishu-bot -f`

### macOS / launchd

```bash
# 编辑 deploy/bot.plist 里的两处 REPLACE_ME
cp deploy/bot.plist ~/Library/LaunchAgents/com.example.bots.plist
launchctl load -w ~/Library/LaunchAgents/com.example.bots.plist
```

### 只能有一个实例

长连接是**集群模式**推送：同一应用有多个客户端时，每条事件随机投给其中一个。两个实例不会分担负载，只会各收到一半，而且两边日志都显示"连接正常"，极难排查。换机器时先停旧的再起新的。

## 安全


- `.env`（mode 600）保存凭据，已在 `.gitignore` 里；**不要**提交。
- `console/read_secret.py` 直接写文件而不打印，避免密钥进 shell history / 聊天记录。
- Secret 泄露就在后台「凭证与基础信息 → 重置」，然后重新跑 `read_secret.py`。
- `.state/profile` 是 Playwright 登录态（约 100MB），可随时删；删后重新扫码。

## 相关

- 官方 SDK：[larksuite/oapi-sdk-nodejs](https://github.com/larksuite/oapi-sdk-nodejs) · [oapi-sdk-python](https://github.com/larksuite/oapi-sdk-python)
- 官方示例：[oapi-sdk-python-demo](https://github.com/larksuite/oapi-sdk-python-demo)
- 官方 CLI（不写代码直接收发）：[larksuite/cli](https://github.com/larksuite/cli)
- 要现成的多平台 AI 机器人平台：[LangBot](https://github.com/langbot-app/LangBot)

## License

MIT
