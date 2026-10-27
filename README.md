# bots

![ci](https://github.com/123123213weqw/bots/actions/workflows/ci.yml/badge.svg)

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

### 自检

```bash
npm run doctor        # 一条命令查完：飞书凭据 / token / 模型 key 是否真的可用
```

输出示例（不打印任何密钥）：

```
ok    feishu env           app_id present, secret 32 chars
ok    feishu credentials   token ok (42 chars, 2904s)
ok    deepseek key         deepseek-chat replied in 689ms
```

密钥轮换、额度耗尽、项目被停用时，bot **不会崩**，只会降级（回显模式或"模型暂时不可用"）——所有健康检查都还是绿的。所以怀疑"它今天怎么变笨了"时先跑这个；退出码非 0 也可用来卡部署。

**密钥安全**（代码层面保证，不是靠自觉）：

- key 只从环境变量读，从不打印、不写日志、不进错误信息；provider 若在报错里回显 key，`redact()` 会先抹掉。
- 请求体也从不落日志——用户提问可能同样敏感。
- `.env` 在 `.gitignore` 里，`deploy.sh` **默认保留服务器上的 `.env`**，不会用本地文件覆盖（只有 `PUSH_ENV=1` 才覆盖）；否则每次部署都会悄悄删掉服务器上的 key。
- 没有 key 时不会崩，只是回显——所以"看起来在跑"不等于"模型接上了"，启动日志会明确打印 `llm=deepseek-chat` 或 `llm=none (echo mode)`。
- 和别的服务共用一个 key 时要记住：**对方轮换 key，你这边会静默降级**。`npm run doctor` 就是为这种情况准备的。

### 换 key（不回显）

```bash
ssh host
cd ~/bots && ./deploy/set-key.sh     # 粘贴新 key 后 Ctrl-D
```

输入不回显、不进 `~/.bash_history`、不出现在 `ps` 里（这三处都是 `echo KEY >> .env` 的典型泄漏点）；写入是原子的，失败不会留下半个 `.env`；写完自动跑 `doctor` 验证，而不是把 key 打印出来让你肉眼核对。

### 共用 key vs 独立 key

| 场景 | 影响 |
|---|---|
| 教学项目改自己的 `.env` / 删文件 | bot **无影响**（值已独立复制） |
| 教学项目在控制台**重置 key** | bot **同时断**，因为作废的是这个值本身，存在哪都没用 |

想彻底解耦，只有在 DeepSeek 控制台给 bot 单独签一个 key（同账号可有多个，额度共用、吊销互不影响），然后用上面的 `set-key.sh` 换上。

## 对话状态机

`src/machine.ts` 是一个约 200 行的显式状态机，`src/flows.ts` 放具体流程。

现在有一个真实流程：**查仓库**（两步）

```
用户: 查仓库
 bot: 请发送仓库名，格式 owner/repo（例如 vllm-project/vllm）。
用户: vllm-project/vllm
 bot: vllm-project/vllm
      A high-throughput and memory-efficient inference and serving engine for LLMs
      95626★ · Python · Apache-2.0 · 更新于 2026-10-26
      https://github.com/vllm-project/vllm
```

为什么值得用状态机：这一步**一条消息做不到**，而让模型"猜"仓库 star 数正是要避免的编造。走状态机还顺带省掉两次模型调用。

### 为什么不用"多轮 prompt 里塞指令"

| | 状态机 | prompt 里塞指令 |
|---|---|---|
| 确定性 | 转移由代码决定 | 模型可能不按格式走 |
| 成本 | 0 token | 每轮都要带完整指令 |
| 可测 | 纯函数，97 个用例 | 只能靠实际对话试 |
| 超时 | 显式 TTL | 无法表达 |

需要模型做**判断**的地方仍交给模型；需要**流程**的地方用状态机。

### 专门为"别把聊天关起来"做的三件事

会话状态机最典型的故障是：用户发了一句「查仓库」然后走开，之后所有消息都只回「请发送 owner/repo」。所以：

1. **每个状态都有 TTL**（默认 5 分钟，本流程 3 分钟）。超时自动丢弃，且新的触发词立刻可用。
2. **随时可取消**：`取消` / `退出` / `算了` / `/cancel`。`重置` 命令同时清上下文和流程。
3. **未匹配不等于卡死**：流程内收到不合格式的内容，回一句提示**但仍留在流程里**（不转给模型，否则模型会无视刚问过的问题）；取消或超时后立即恢复正常对话。

### 加一个新流程

只需要写一个 `MachineDef`，不需要改 handler：

```ts
const def: MachineDef = {
  initial: "idle",
  defaultTtlMs: 3 * 60_000,
  cancel: /^(取消|\/cancel)$/i,
  onUnmatched: "请……，或发「取消」退出。",
  states: {
    idle: {},
    await_x: { prompt: "请发送 X。" },   // 进入该状态时的提示
  },
  transitions: [
    { from: "*", match: /^开始X$/i, to: "await_x" },              // 入口
    {
      from: ["await_x"],
      match: /^(.+)$/,
      to: "idle",                                                 // 回到空闲
      capture: { key: "x", group: 1 },                            // 存槽位
      action: async (ctx) => `处理 ${ctx.data["x"]} 的结果`,       // 副作用
    },
  ],
};
```

`action` 的返回值会替换 `reply`，所以网络请求、查库、写文件都放这里。

### 一个假话 bug

接流程时用真实数据验证，`cupy/cupy` 返回了「没找到」——但那个仓库明明存在。原因是本机断网导致 fetch 失败，而代码把所有失败都映射成 404。

**「查不到」和「没查到」是两句话。** 现在只有真正的 404 才说「没找到」，传输错误说「网络出问题，稍后再试」，并有测试钉住这个区别。

## AI Infra 日报（每 6 小时）

每 6 小时推一条「GitHub 上 AI 推理基础设施」的推荐到飞书群，每天 4 轮、每轮 3 个。

```bash
npm run digest                 # 推送到 DIGEST_CHAT_ID
npm run digest -- --dry-run    # 只打印，不发
npm run digest -- --reset-seen # 清空已推荐记录（测试用）
```

为什么它不是那种"LLM 凭记忆列项目"的日报：

| 做法 | 结果 |
|---|---|
| 数据 | 全部现查 GitHub Search API，元数据永远是真的 |
| 描述 | **直接引用仓库自己的 description，不改写**——所以不会出现编造的项目 |
| 排序 | 新项目按 star/天，生态按 star + 近期提交，都是可复算的指标 |
| 去重 | `.state/digest-seen.json` 记住已推的，**按 21 天到期**而不是按条数 |

过滤做了三层，全部是看了真实输出才补的：

1. **topic 搜索很脏**：`gitleaks`（密钥扫描器）被标了 `topic:llm-inference`，所以相关性不看 topic，看 description。
2. **裸的 `llm` 不能用**：它让微调工具 LlamaFactory 混进了"推理服务"栏目。微调 / 数据集 / awesome-list 一律判为 off-topic。
3. **裸的 `gpu` / `cuda` 也不能用**：`cupy/cupy`（"NumPy & SciPy for GPU"）就是靠 `topic:cuda` 混进来的。必须提到推理、serving、kernel 或模型内部结构才算。

### 为什么 6 小时一轮要改两个数

每天 4 轮 × 每轮 5 个 = 20 个，两天就把候选池抽干，之后只能推不相关的东西。所以：

- 每轮 **2 新 + 1 生态 = 3 个**
- `seen` 改成**按天过期（21 天）**，不再按条数封顶——条数上限和"每天跑 4 次"根本不匹配

查询之间还会间隔 2 秒（未配置 `GITHUB_TOKEN` 时），否则 8 个查询连着发必触发 403，日报会静默变薄。

输出示例（真实数据）：

```
AI Infra / 推理 日报 · 10/26

新项目（近半年创建，按 star 增速）
1. deepseek-ai/DeepInfer
   DeepInfer: High-performance, large-scale inference framework for DeepSeek models
   22.9k★ · Python · Apache-2.0 · +2219.0★/天
   https://github.com/deepseek-ai/DeepInfer
...
数据来自 GitHub Search API，描述为仓库原文，未做改写。
```

`license 不明确` 会显式标出（GitHub 的 `NOASSERTION` 和没有 license 都算）——真要部署一个东西时，这是能用的事实。

配置：

```
DIGEST_CHAT_ID=oc_xxxxxxxxxxxx        # 推送到哪个群
GITHUB_TOKEN=ghp_xxx                  # 强烈建议：配额从 10 次/分升到 30 次/分
```

不配 `GITHUB_TOKEN` 也能跑，但每轮 8 个查询会撞上未认证的 10 次/分限制，表现为部分查询被跳过、日报变薄。代码会按 `Retry-After` 退避重试，单条失败不会让整条日报变空——但**配了 token 才是稳定的**。

> **权限提醒**：搜索公开仓库只需要一个**零 scope** 的 token。`gh auth token` 导出的现有 token 往往带着 `repo`、`admin:org` 甚至 `delete_repo`，把它放到服务器上等于把删库和组织管理权限交给那台机器。理想做法是在 GitHub 单独创建一个 **Fine-grained token，不勾任何权限**（或 classic PAT 只勾 `public_repo`），只用于读搜索。

定时：`deploy/digest.timer` 在 **00:00 / 06:00 / 12:00 / 18:00**（CST），`Persistent=true` 让关机错过的那个时段在开机后补跑一次，`RandomDelaySec=900` 避免和其他定时器同秒。

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
  machine.ts   对话状态机（TTL / 取消 / 槽位）
  flows.ts     具体流程（查仓库）+ RepoFetcher 接口
  github.ts    GitHub 仓库查询（404 与网络失败分开）
  digest.ts    每日 AI Infra 日报（GitHub API → 飞书群）
  doctor.ts    凭据自检（飞书 token + 模型可用性，不打印密钥）
  cli.ts       命令行发送（cron / CI 通知）
  config.ts    .env 读取
tests/         node:test，97 个用例，全部离线
console/       开发者后台自动化（Python + Playwright）
deploy/        systemd units (bot + digest timer) + deploy.sh + set-key.sh + launchd
assets/        示例图片
```

## CI

`.github/workflows/ci.yml`，push / PR 自动跑：

| job | 做什么 | 为什么 |
|---|---|---|
| `test (22|24)` | 类型检查 + 97 个用例 + 构建 + 校验 `dist/` 布局 | tsconfig 的 `rootDir` 曾被改错，只在运行时才炸；现在构建期就拦住 |
| `no-secrets` | 扫已跟踪文件和**全部 git 历史**里的 key 形态 | 密钥进了公开分支，后续 commit 是撤不回来的 |
| `smoke-node20` | 用 Node 20 逐个 import 编译产物 | 生产机上 Node 20 还跑着别的服务，产物必须仍能被它加载 |

两个 job 是踩出来的产物：

- **`smoke-node20` 上线第一次就抓到了真 bug**：`doctor.ts` 和 `cli.ts` 在**被 import 时就会执行** `main()`（发网络请求 / `process.exit`）。和之前 `digest.ts` 同类，但那两个我漏了。现在三个入口统一用 `util.ts` 的 `isEntryPoint()` 守卫，并有测试断言“import 无副作用”。
- **`no-secrets` 第一版误报**：把 `.env.example` 里的占位符 `cli_xxxxxxxxxxxxxxxx` 当成真凭据。现在会排除占位符，且**只打印文件名、不打印命中内容**。

## 开发

```bash
npm test          # node --test，97 个用例，不需要网络和凭据（Node >= 22.6）
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
