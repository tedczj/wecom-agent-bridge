# WeCom ↔ 本地 Code Agent：可执行、可验证的开发设计

版本：设计 v1；日期：2026-09-21。
状态：开发规格，不是已实现或已联调的产品。公开源码已核对；没有连接用户的企业微信租户，也没有运行用户本地的 Pi/Codex。文中的 npm scripts、文件和测试名均是要求开发者新增的交付物，不代表已经存在。

## 1. 最终决策与边界

采用一个 TypeScript/Node 服务：WeCom AI Bot WebSocket → 消息标准化/鉴权 → 受控图片存储 → SQLite 队列/会话 → Pi RPC → SQLite outbox → WeCom 主动消息。

Hermes 只参考协议处理与媒体/ACL/回复路由设计，不 fork 完整 Agent Gateway。底层 WebSocket 使用 WecomTeam 的 `@wecom/aibot-node-sdk`，避免把 Python adapter 的框架依赖一并搬来。Pi 使用用户正在使用的 `earendil-works/pi` 的 `packages/coding-agent` RPC，不引入另一套 Agent Harness。[S1–S6]

首期只实现 Pi。Codex TypeScript SDK 是同一 AgentBackend 接口的第二个实现，OCR 是可关闭的预处理器，都在 MVP 验收后再做。这里的 Pi/Codex 是可替换后端，不假设 Pi 内部调用 Codex。

“300–600 行”仅作为 bridge 编排业务的估算目标，不含协议 SDK、RPC 传输适配、安全媒体处理、测试、mock、部署脚本和第二个后端。不得以行数为由删除鉴权、持久化去重、执行完成判定或取消清理。总手写运行时代码可能达到约 800–1500 行，仍应保持单进程、少依赖；这不是实测行数或工期承诺。

本方案连接的是企业微信 AI Bot 的会话，不承诺能接收普通个人微信联系人/普通微信群消息。企业租户是否开放机器人长连接、成员/群聊可见范围与主动发送能力，必须在 G0 真实验证。不要混用自建应用 XML 回调、群机器人 webhook、微信客服或个人微信登录配置。

### 范围冻结

| MVP 必须 | MVP 不做 |
|---|---|
| 允许名单中的企微单聊；内部群聊按开关启用 | 个人微信登录、外部群兼容承诺 |
| text/image/mixed；一层引用中的 text/image | 语音、视频、任意附件与递归引用 |
| 固定工作目录；一个全局正在执行的 Agent 任务 | 多项目路由、共享工作树多并发、多租户 |
| 接收确认、排队、最终回复、长文本分页 | 逐 token 推送、工具日志刷屏、自动发送生成文件 |
| 持久会话、消息去重、超时/取消、重启恢复 | 自动审批、自动重跑不确定任务、第二层 Agent |
| 原图多模态输入 | 默认 OCR、自动摘要、管理页面、Redis/MQ |

群聊必须明确告知：虽然上下文按发送者隔离，但发到群里的结果对群成员可见。因此默认关闭群聊，先把单聊跑通。

## 2. 源码复用清单与版本固定

| 来源 | 已核对路径 | 复用内容 | 不照搬的部分 |
|---|---|---|---|
| NousResearch/hermes-agent | `plugins/platforms/wecom/adapter.py` | 消息/引用图片解析、ACL、req_id 关联、媒体限制 | 完整 BasePlatformAdapter/Gateway/Agent 依赖 |
| NousResearch/hermes-agent | `tests/gateway/test_wecom.py` | 协议测试的场景与 fixture 组织方式 | 把 Hermes 全套测试依赖带入新项目 |
| WecomTeam/aibot-node-sdk | `src/client.ts`, `src/ws.ts`, `src/message-handler.ts` | 连接、认证、心跳、重连、回执、发送 | 业务队列、会话、执行幂等假设 |
| WecomTeam/aibot-node-sdk | `src/types/message.ts`, `src/crypto.ts`, `src/api.ts` | 真实消息字段、导出的 decryptFile | 直接把无界 arraybuffer 下载作为安全媒体层 |
| earendil-works/pi | `packages/coding-agent/docs/rpc.md` | RPC 命令/事件契约 | 文档中与新完成语义不一致的旧示例 |
| earendil-works/pi | `packages/coding-agent/src/modes/rpc/{rpc-client,rpc-types,jsonl,rpc-mode}.ts` | 请求关联、LF framing、事件、取消/会话逻辑 | 默认环境变量继承、静默吞掉协议破坏 |
| openai/codex | `sdk/typescript/{README.md,src/thread.ts,src/events.ts,src/threadOptions.ts}` | P1 的 thread/session/图片输入适配 | 与 App Server 的 localImage 字段混用 |

当前 Hermes 的实际 WeCom 源码路径是 `plugins/platforms/wecom/adapter.py`，不要按旧路径 `gateway/platforms/wecom.py` 开发。[S1]

公开检索存在缓存，不能把 main 页面当成本地版本保证。G0 交付 `docs/upstream-lock.json`，记录获取日期、来源仓库、固定 commit、package 精确版本、Node/Pi/Codex 版本、配置 profile、协议特性和验证结果。仅版本号不够：用户的 Pi 可能有本地扩展/补丁，必须保留对应 commit 与 diff 摘要。依赖 save-exact 并提交 lockfile，CI 只用 npm ci。复制源码时记录原文件、固定 revision、改动原因，核对该 revision 的 LICENSE 并保留必须的声明。

## 3. 项目目录与依赖

```text
wecom-agent-bridge/
  package.json
  package-lock.json
  tsconfig.json
  config.example.json
  .env.example
  .gitignore
  src/
    main.ts                 # 启停、进程锁、依赖装配
    cli.ts                  # doctor/status/recover；不是公网消息入口
    config.ts               # 严格校验，空 allowlist 拒绝启动
    types.ts                # 稳定的通道/后端接口
    wecom.ts                # 唯一 message 入口、normalize、发送分类
    media.ts                # URL/下载/解密/格式校验/落盘/清理
    bridge.ts               # 准入、队列、命令、运行状态机
    store.ts                # SQLite 事务和 migrations
    reply.ts                # UTF-8 分段、outbox、发送节流
    pi.ts                   # RPC lifecycle/session/final/error/abort
    rpc-jsonl.ts            # 严格 LF 分帧、请求 id、进程错误
    codex.ts                # P1：TS SDK backend
    ocr.ts                  # P1：受限 OCR worker 客户端
  tests/
    unit/
      normalize.test.ts
      media.test.ts
      reply.test.ts
      store.test.ts
      config.test.ts
    contract/
      backend.contract.test.ts
      pi.contract.test.ts
      codex.contract.test.ts   # P1
    e2e/
      bridge.e2e.test.ts
      recovery.e2e.test.ts
    fakes/
      pi.mjs
      wecom.ts
      media-fetch.ts
    fixtures/
      wecom-text.json
      wecom-image.json
      wecom-mixed.json
      wecom-quote.json
      pi-retry-settled.jsonl
      pi-error.jsonl
      pi-ui-request.jsonl
  scripts/
    smoke-wecom.ts
    smoke-pi.ts
    smoke-codex.ts            # P1
  docs/
    DESIGN.md                 # 本文是唯一设计基线
    upstream-lock.json
    verification.md
```

建议依赖：企微 SDK、SQLite 驱动（例如 better-sqlite3）、配置校验库、图片解码库（例如 sharp）。测试用 Vitest，TypeScript 编译检查。版本由 G0 根据本地环境核对并固定。不再增加 Web 框架、数据库服务或消息队列；健康检查先用本地 CLI，需要监控时才补 loopback HTTP。

## 4. 固定接口

先固定接口再写适配器。以下是项目自定义接口，不是上游 SDK 的原生类型。

```ts
export interface ImageRef {
  id: string;
  localPath: string;          // bridge 进程可见
  agentPath?: string;         // 只有路径型后端需要；容器内路径可不同
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  source: "message" | "quote";
}
export interface Route {
  botId: string;
  kind: "single" | "group";
  targetId: string;           // 单聊 userid；群聊 chatid
  senderId: string;
}
export interface NormalizedInput {
  taskId: string;
  messageId: string;
  route: Route;
  receivedAt: number;
  text: string;
  images: ImageRef[];
  workspaceId: string;
  sessionKey: string;
  generation: number;
}
export type SessionRef =
  | { kind: "pi"; sessionId: string; sessionFile: string }
  | { kind: "codex"; threadId: string };
export interface AgentResult {
  outcome: "success" | "failed" | "cancelled" | "interrupted";
  finalText: string;
  errorCode?: string;
  sessionRef?: SessionRef;
}
export interface AgentBackend {
  start(): Promise<void>;
  run(
    input: NormalizedInput,
    session: SessionRef | undefined,
    hooks: {
      persistSession(ref: SessionRef): Promise<void>;
      progress(event: { type: string; tool?: string }): void;
    },
    signal: AbortSignal,
  ): Promise<AgentResult>;
  stop(): Promise<void>;
}
```

`run()` 返回前必须确认该轮已 settled，或受控进程/沙箱已停止。不能把“已经发送 abort”视为“已经停止”。清理无法确认时抛出专用 `BackendStateUnknown`，阻塞工作目录的新任务并等待恢复操作。超时是 bridge 的终态分类，底层仍必须先完成取消/清理。

原始媒体 URL、aeskey、企微 secret 不进入 NormalizedInput。消息监听不能把完整 SDK frame 原样传给 Agent。

## 5. WeCom 消息字段、路由与准入

SDK 的 BaseMessage 使用 `msgid`、`aibotid`、`chattype`、`from.userid`；群聊才保证有 `chatid`。mixed 使用 `mixed.msg_item`。图片是 `image.url` 和可选 `image.aeskey`。这些是 wire 字段，内部变量可转换为 camelCase。[S3]

```json
{
  "cmd": "aibot_msg_callback",
  "headers": { "req_id": "fixture-request-1" },
  "body": {
    "msgid": "fixture-message-1",
    "aibotid": "fixture-bot",
    "chattype": "single",
    "from": { "userid": "fixture-owner" },
    "msgtype": "text",
    "text": { "content": "检查当前项目的测试" }
  }
}
```

这是测试 fixture 的形状，不是发给真实服务器的命令。真实帧必须在 G0 脱敏录制，校验 fixture 与固定 SDK 类型一致。

| 标识 | 用途 | 禁止混用 |
|---|---|---|
| botId + msgid | 持久化入站去重 | 不能用 req_id 代替 |
| headers.req_id | 对这条入站消息做即时回复的关联 | 不能当会话 id；不能存成 lastReqId[chat] |
| taskId | bridge 任务、日志、结果领取 | 不能代替 backend session |
| sessionKey + generation | 本地上下文映射 | 不能跨 sender 共享群上下文 |
| Pi sessionFile / Codex threadId | 原生 Agent 会话 | 不能 resume 最近任意会话 |

处理顺序必须是：校验 schema/机器人身份 → 检查 sender 与 group allowlist → 持久化去重/容量预留 → 控制命令分流或 Agent 输入准备。未授权消息不下载、不调用 Agent，不回显内容；缺少身份字段直接拒绝。群消息要求用户和群同时在名单内；不使用显示名鉴权。

在 connect 之前绑定 message/authenticated/disconnected/error 监听，不能遗漏 error 处理。只注册一个通用 `message` 入口，不同时把 `message.image`/`message.text` 也接到任务入口，否则同一消息可能从两种事件触发两遍。`connected` 不代表可发送，必须等 `authenticated` 才进入 ready。[S2, S4]

全局默认执行并发 1；同一会话等待上限 3，全局等待上限 20，均为本地策略。图片准备与 Agent 队列解耦，但同一会话按 SQLite seq 保序：前面的图片任务尚在 preparing，后面的文字任务不能越过它。后者不能因为“下载慢”提前读取错误的上下文。

纯图片允许单独提交，默认问题为“请分析这张图片”。图片与文字应优先用同条 mixed 消息或一层引用；首期不做跨消息 debounce 合并，不猜测两条消息属于同一个 query。

## 6. 图片处理：先落盘，再等待 Agent

官方 SDK 的图片结构注释标明下载 URL 五分钟内有效，因此媒体准备不能等到长任务结束。图片 URL 过期、引用图片无法取得时必须明确要求重发，不能伪装成 Agent 已看图。[S3]

完整处理：

```text
准入成功、原子预留 task
  ├─ 非阻塞发送“已接收 #task，正在准备/排队”
  └─ 马上进行受控下载
        → 限制密文字节数
        → AES 解密（需要时）
        → 格式/尺寸/像素校验
        → 安全文件名 + 原子落盘
        → ImageRef 持久化
        → queued
```

不要 await 一次可能等待数秒的消息回执后才开始下载。也不要先无界下载，再检查图片大小。

### 安全下载要求

仅处理已鉴权 frame 的图片字段，不自动访问用户正文/OCR 中的网址。HTTPS、443、无 userinfo；CDN hostname 采用管理员审核的精确 allowlist。G0 可以记录脱敏 hostname 帮助配置，但不能把任意收到的域名自动加白。首期禁重定向；如确有需要，再逐跳实施同样校验。

DNS 解析后拒绝回环、私网、链路本地、IPv6 ULA 和云元数据地址；实际连接必须使用被校验的地址并保留 TLS hostname 验证，防止“检查一次、连接又重新解析”的绕过。下载器禁用未审查的代理路径。测试通过注入 fake fetch/解析器执行，不通过放宽生产规则连接测试 localhost。

Content-Length 只做早期拒绝，流式累计字节才是硬限制。总超时 20 秒、单图解密后最多 10 MiB、密文额外允许必要 padding、单任务全部图片最多 20 MiB、最多 4 张、像素总量/单图像素上限按配置限制。收到超限数据立刻 abort 并删除 `.part` 文件。

SDK 目前的通用下载实现使用 arraybuffer，不等同于完整的安全下载器；自己的 media 层必须补足上述限制。[S5]

### 解密与文件校验

复用企微 SDK 导出的 `decryptFile`。其实现使用 AES-256-CBC、key 前 16 字节作为 IV，并自行校验 1–32 字节 padding；不要自行改成 Node 默认 16 字节 padding，也不要混用 XML 回调的 EncodingAESKey 算法。缺 key 的图片按固定协议样本/能力测试处理，不能把无法识别的密文强行当 JPEG。[S5]

格式看解密后的真实字节和成功解码结果，而不是 URL 后缀或 HTTP Content-Type。允许 PNG/JPEG/WebP，首期拒绝 SVG、HTML、可执行文件、动画与超像素图片；解码库设置像素预算，避免先解码再检查。需要缩放/重编码时明确保留原图与 derived 关系，不做 OCR 替代原图。

目录权限 0700、文件 0600；文件名由本地 UUID/序号生成，禁止远程文件名参与路径拼接，拒绝 symlink。先 `.part`，校验完成后 atomic rename。

```text
state-root/
  bridge.sqlite
  media/<task-uuid>/input-01.png
  media/<task-uuid>/input-02.jpg
  agent-sessions/              # 与 Agent 安全域/路径映射相容
```

媒体清理以“保留期已过 AND 没有 preparing/queued/running/cancel_requested 引用”为条件，不能让排队任务指向已删除文件。启动时清理未被有效任务引用的旧 `.part`。图片中可能有秘密；不发送到额外第三方 OCR，日志不输出 base64、原始 URL query、aeskey 或全文 OCR。

## 7. Pi RPC 后端：MVP 的完成语义

### 启动与环境

使用管理员配置的绝对可执行路径和 argv，以 `shell:false` 启动；不要把微信文本拼成 shell 命令。典型目标命令如下，路径由 doctor 实测：

```bash
/absolute/path/to/pi --mode rpc --session-dir /controlled/path/pi-sessions
```

保留用户实际使用的 provider/model/profile 和经过审核的 headless 扩展，但不允许后台自动发起独立 Agent 任务的扩展破坏单运行约束。首期远程 slash commands 只允许 bridge 自己的命令，未知 slash 不直接送给 Pi 执行。

启动后通过 `get_state` 检查握手、model、idle、session 功能；不把睡眠 100ms 或进程出现视为 ready。不使用 `--no-session`。同一 Pi 进程只被 bridge 管理，不与本地 TUI 同时读写同一 session 文件。

引用 RpcClient 实现时注意它的默认 child env 是从 process.env 扩展来的；仅传一个干净 options.env 并不能删除已有变量。必须修改 spawn 处使用显式允许的环境集合，并以 fake 子进程测试确认 WECOM_SECRET 不可见。[S7]

### 会话映射

baseKey 使用规范化元组：`[botId, chattype, targetId, senderId, workspaceId, backend]`。由本地代码序列化并 hash，不直接拼接用户字段当路径。单聊上下文独立，群聊按发送者隔离；generation 由 `/new` 增加。

新会话：`new_session` → 检查 success 且 `data.cancelled === false` → `get_state` → 通过 persistSession 保存真实 sessionId/sessionFile → prompt。

已有会话：`switch_session {sessionPath}` → 检查未被取消 → `get_state` 核实加载的是预期会话 → prompt。命令返回 success 不意味着切换成功，扩展可以取消切换。[S6, S8]

某些会话文件可能尚未实际写盘。必须区分“新建但未持久化任何 turn”和“曾执行过、文件却丢失”：前者可新建；后者报 SESSION_MISSING，不偷偷创建空上下文继续。禁止 `--continue` 或“恢复最后一个会话”代替精确映射。

### 图片输入

Pi RPC 的图片字段是原生 base64 image block；落盘是媒体安全与重试管理手段，并不意味着仅在 prompt 填文件路径就能让模型看图。[S6]

```json
{
  "id": "task-example-prompt-1",
  "type": "prompt",
  "message": "分析截图中的错误，先解释原因。",
  "images": [
    { "type": "image", "data": "<读取已验证图片得到的base64>", "mimeType": "image/png" }
  ]
}
```

禁止把例子的占位符真实发给模型。fake contract test 比较解码后的 SHA-256，live smoke 在 OCR 关闭时测试原生视觉。

### 生命周期与结果收集

**终止条件是本轮 `agent_settled`，不是 prompt success，也不是 agent_end。** 当前源码的客户端等待 agent_settled；agent_end 之后可能还有自动重试、压缩和续跑。[S6, S7]

```text
检查 idle / 准备会话 / 持久化映射
  → 先安装本轮事件监听和 epoch
  → 再写 prompt
  → success=true：只记 accepted
  → message/tool/retry/compaction：继续收集
  → agent_end：不结算、不释放 worker
  → agent_settled：结合本轮最终消息/错误/取消状态确定结果
```

RPC 响应按 id 匹配；stdout 采用严格 LF JSONL，支持 TCP/pipe 任意 chunk、CRLF、跨 chunk UTF-8 与字符串内 U+2028/U+2029。缓冲区和单帧长度有上限。原始 stdout 不写日志。明确的非 JSON 协议污染应触发受控失败，而不是无声跳过到超时。[S6, S9]

监听在发送前注册，防止极速返回造成漏事件。所有 collector 在 finally 解绑；收到旧进程 epoch 的事件直接丢弃。超时/协议破坏后禁止直接复用可能还在工作的进程，先 abort/停止沙箱，再启动新进程。没有 current-run 标识的异步事件不应通过一个全局“最近任务”变量猜归属。

finalText 只取本轮最后一条有效的 assistant 最终文本，按原生 message_end/message 内容判断。不要把 thinking、工具 stdout、重复的累计 delta、上轮最后回答混进去。仅收到 settled 但最终 stopReason=error/aborted 时不报告成功；重试中的临时错误后来成功则按最终轮状态结算，不能永久锁定为失败。模型拒绝本身是有效回答，不伪造为 transport error。

初期不实现远程审批。对于需要交互的 `extension_ui_request`，返回对应取消/拒绝响应，并把任务标为 NEEDS_LOCAL_INTERACTION；不自动批准，也不能让整个队列无期限卡住。非阻塞 notify/status 类事件可以只记结构化摘要。[S10]

## 8. Codex SDK：P1 的替换后端

Codex TS SDK 包装本地 Codex CLI 并交换结构化事件，不能把它与 app-server 的所有类型混为一套。TS SDK 图片字段是 `local_image`，不是 `localImage`。[S11]

```ts
const thread = savedThreadId
  ? codex.resumeThread(savedThreadId, threadOptions)
  : codex.startThread(threadOptions);

const input = [
  { type: "text" as const, text: normalized.text },
  ...normalized.images.map((img) => ({
    type: "local_image" as const,
    path: img.agentPath ?? img.localPath,
  })),
];
const { events } = await thread.runStreamed(input, { signal });
```

这只是接口用法片段，不能代替完整的异常、持久化与终态处理。收到 `thread.started` 就 await 持久化 thread_id；不要等运行结束才保存。`item.completed` 中最后一个 agent_message 提取最终文本；`turn.completed` 为成功终态，`turn.failed`/`error` 为失败，不重复拼接 item.updated 与 completed 全量文本。[S12, S13]

工作目录固定；首测 `sandboxMode=read-only`，写代码时用受限制的 workspace-write，默认网络禁用。approvalPolicy 不得自动放行；非交互 `never` 不等于授予全部权限，沙箱仍必须限制。需要交互审批时明确交还本地操作。控制 SDK/CLI 的 env 与 auth home，不继承企微 secret。[S11, S14]

容器场景必须验证图片路径对实际 Codex 子进程可见，禁止把 bridge 宿主机路径原样当容器路径。没有本地视觉 smoke 通过，doctor 不得报告 images=true。

## 9. 数据模型、幂等与崩溃恢复

SQLite 是唯一持久化来源。WAL、foreign_keys、busy_timeout；一个运行实例。先实现合理的单实例锁，再启动 WeCom 和 Agent。数据库/目录不得放进 Agent 可任意读写的仓库。

三张业务表即可；命令也用 jobs.kind=command 记录，使重复 `/new` 不会增加两次 generation。

```sql
CREATE TABLE sessions (
  session_key TEXT PRIMARY KEY,
  base_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  backend TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  agent_ref_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('new','ready','tainted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (base_key, generation)
);
CREATE TABLE jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent','command')),
  session_key TEXT REFERENCES sessions(session_key),
  route_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'preparing','queued','running','cancel_requested',
    'succeeded','failed','cancelled','timed_out','interrupted'
  )),
  result_text TEXT,
  error_code TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (bot_id, message_id)
);
CREATE TABLE outbox (
  delivery_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES jobs(task_id),
  purpose TEXT NOT NULL,
  part_no INTEGER NOT NULL,
  target_json TEXT NOT NULL,
  body_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending','sending','sent','unknown','failed'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE (task_id, purpose, part_no)
);
CREATE INDEX jobs_status_seq ON jobs(status, seq);
CREATE INDEX outbox_state_due ON outbox(state, next_attempt_at);
```

`input_json` 只含标准化文本/ImageRef，不存短期 URL/aeskey。图片 preparing 阶段的下载描述只留在进程内存；崩溃后没有完整的 validated manifest 就标 MEDIA_PREPARATION_INTERRUPTED 并要求重发。这是首期有意识的简化，优于保存敏感原始 frame 并猜测 URL 仍有效。文件落盘而 DB 尚未提交时产生的孤儿文件由 GC 清理。

任务状态机：

```text
preparing → queued → running → succeeded / failed
       └──────────────→ cancelled
running → cancel_requested → cancelled / timed_out
running / cancel_requested → interrupted（进程崩溃/清理无法确认）
```

不把执行和发送状态合并：succeeded + outbox.unknown 完全合法，表示已经执行完成，但无法确定微信是否收到。

必须用事务实现：容量检查+消息唯一插入；claim queued→running；任务终态+最终 result_text+全部 final outbox 记录。只有明确仍在 queued 的任务可以安全自动执行。run 状态提交后，即使 prompt 尚未写出便崩溃，也保守视为 interrupted，不自动重跑。

| 重启时观察到 | 行为 |
|---|---|
| preparing 且未提交完整 ImageRef | failed，通知重新提交；不猜 URL/附件 |
| queued 且映射/媒体完整、工作目录未阻塞 | 按 seq 重新调度 |
| running / cancel_requested | interrupted；会话 tainted；检查/停止旧 Agent 沙箱，不重跑 |
| succeeded + pending final outbox | 只发结果，绝不调用 Agent |
| outbox sending | unknown，不能假定没发出去 |
| session 曾执行过但文件丢失 | SESSION_MISSING，禁止无提示开启新会话 |

同一工作目录存在未 reviewed 的 interrupted 任务时，启动状态为 blocked，禁止所有新的 Agent 执行，但允许 status/result/cancel。操作者检查受控进程已经停止与 git diff 后，用本地 recover 命令记录 reviewed_at，才解除阻塞。不能自动 git reset 或把 `/new` 当作确认代码未被修改。

## 10. 回复投递：即时确认与最终结果分开

即时确认使用原始帧的 req_id；可以 `replyStream(frame, streamId, receiptText, true)` 一次结束，不做 token streaming。接收确认仅表示任务已持久化/正在准备，并不表示图片已解析或 Agent 已成功。[S2]

最终结果统一走主动 `sendMessage(targetId, {msgtype:'markdown', markdown:{content}})`，单聊 targetId=from.userid，群聊 targetId=chatid。这样长任务不依赖旧回调的回复上下文。SDK 支持该入口，但账号真实权限、时间/数量限制必须在 G0 验证；本设计不宣称无限主动发送。[S2]

每条结果以 `[task-short-id part/total]` 开头。3500 UTF-8 bytes 是 bridge 的保守可配置预算，不是引用官方上限；必须包含前缀、换行与格式化开销。按 Unicode code point 分割，不拆坏 UTF-8；不能按 JS string.length 或简单 substring 截到 4000 字符。正文和源路径不自动附加 Markdown 链接预览。

为了避免刷屏，默认自动发最多 3 段，更多通过 `/result <taskId> <part>` 领取；结果总数与剩余领取命令写清楚。最终文本在 DB 持久化，最大 1 MiB；超过上限明确记录 OUTPUT_TRUNCATED，不能声称保存了完整结果。首期不自动上传任意文件。

发送节流默认每机器人至少间隔 1500ms，是本地政策，不是平台 quota。控制类状态回复可插到 pending 结果分段之间，但不能打乱同一任务分段次序。接收确认失败不导致 Agent 任务被重跑或取消。

### 回执不确定性

| 结果 | outbox 状态 | 自动处理 |
|---|---|---|
| 未连接、明确尚未调用发送 | pending | 等重新 authenticated 后发送 |
| 服务端明确成功 ACK | sent | 不再发 |
| 明确可重试且确认未被接受的错误 | pending | 有限次数退避；错误码白名单 |
| ACK 超时、发送后断线、进程在 sending 时崩溃 | unknown | 不盲目回退另一 API 再发 |
| 明确永久拒绝 | failed | 显示本地错误，保留结果 |

SDK 的 send Promise 不是 exactly-once 保证；某些 ACK 超时参数与普通 HTTP requestTimeout 也不是同一设置。无法证明“未发送”的错误按 unknown 处理，不靠字符串中含 timeout 就断言未投递。[S4]

`/result` 是用户主动领取已有结果，不调用 Agent。原结果即使已经收到，手动领取也可能产生用户预期的重复显示，需保留相同 task 标识。

## 11. 控制命令、取消和本地安全

| 命令 | 定义 |
|---|---|
| `/help` | 显示允许的命令和当前固定工作目录别名 |
| `/status` | 当前会话的 active/queue/最近任务、发送异常；不排在 Agent 后面 |
| `/cancel [taskId]` | 默认本会话 active/最近 queued；指定 ID 必须校验所属会话与发送者 |
| `/new` | 本会话无 pending/running 时 generation+1，不删除历史，不绕过 blocked |
| `/result taskId [part]` | 当前授权会话的已持久化结果；参数严格解析，不接受任意路径 |

控制命令与普通消息共享消息去重；没有 task 所有权的人不能查询/cancel/领取结果。不要创建“群管理员自动读取所有人的后台任务”隐式特权。

运行中 cancel/timeout：先 CAS 到 cancel_requested → 发送 Pi abort / Codex AbortSignal → 等 settled/确认子进程退出。宽限期后停止受控进程组或容器；再超时则 blocked/interrupted。不把 abort 命令 success 当作所有 bash 子孙进程已退出。测试必须有一个会持续写 sentinel 文件的孙进程，取消后验证写入确实停止。仅 kill 主进程 PID 不足以满足验收。

运行成功提交与 cancel 发生竞争时以原子状态转换为准：成功先落库则 cancel 返回“已完成”；cancel 已成功进入状态则保留取消语义，并告知可能已有部分代码改动。

Pi 的 cwd、prompt 中的安全要求、传一个受控文件路径都不是操作系统沙箱。必须复用用户现有的有效执行隔离，或使用受限 OS 用户/容器，且不能挂载 Docker socket、主机 SSH/云凭据与 bridge 状态目录。Node child env 不继承企微 secret；同一个 OS 用户仍可能读到旁边的 .env，因此环境清理只是补充，不是安全边界。先用临时测试仓库，不对真实项目自动开启全权限。

日志仅记录 task_id、脱敏 sender/chat 标识、source msgid 的 hash、workspace 别名、sessionRef 的 hash、状态、耗时、字节数、事件种类、错误码。不要记录 model thinking、正文全文、raw frame、aeskey、图片 URL query、secret、base64。SDK logger 也必须被替换为脱敏/抑制 raw debug 的实现。错误对象可能携带 HTTP 请求配置，不能直接 stringify。

## 12. 配置与本地部署

下面是拟新增的项目配置，不是企微/Pi 原生配置格式。所有数字是本地策略，需通过测试，不是官方额度。

```json
{
  "backend": "pi",
  "workspace": { "id": "default", "path": "/absolute/path/to/smoke-repo" },
  "stateRoot": "/absolute/path/to/private-bridge-state",
  "wecom": {
    "allowedUsers": ["REPLACE_WITH_REAL_USER_ID"],
    "allowedGroups": [],
    "enableGroups": false,
    "mediaAllowedHosts": []
  },
  "queue": { "maxActive": 1, "maxPendingPerSession": 3, "maxPendingGlobal": 20 },
  "media": {
    "maxImages": 4,
    "maxImageBytes": 10485760,
    "maxTotalBytes": 20971520,
    "maxPixels": 20000000,
    "downloadTimeoutMs": 20000,
    "retentionHours": 24
  },
  "agent": {
    "command": "/absolute/path/to/pi",
    "args": ["--mode", "rpc", "--session-dir", "/absolute/path/to/pi-sessions"],
    "startupTimeoutMs": 30000,
    "taskTimeoutMs": 900000,
    "cancelGraceMs": 5000,
    "killGraceMs": 2000
  },
  "reply": { "chunkBytes": 3500, "minIntervalMs": 1500, "maxAutoParts": 3 },
  "ocr": { "mode": "off" }
}
```

secret 通过 Keychain/受控 env 文件或部署 secret 注入，仅在 bridge 进程可见。配置空用户名单/占位符/相对工作目录/非法路径时启动失败；图片开启而 mediaAllowedHosts 未审核时，doctor 必须报告 images-not-ready，而不是悄悄允许所有域名。

建议开发期间前台运行，成功后再放到 launchd/systemd 或现有受控容器。一个 bot 只交给一个活动 bridge；不要同时启动 Hermes 和新 bridge 争抢该 bot。服务端指明被新连接替代时应进入 connection-conflict，不循环抢连。[S4]

## 13. 开发阶段、文件级任务和验收门槛

顺序固定。上一阶段 gate 未通过，不用真实模型调试下一阶段；先用 fake 完成确定性测试。tests 默认不联网、不耗模型额度，live scripts 必须显式选择。

### G0：协议能力与本地版本预检

新增 `scripts/smoke-wecom.ts`、`scripts/smoke-pi.ts`、`docs/upstream-lock.json`、`docs/verification.md`。

企微脚本只做 authenticated、接收 allowlist 消息、原路 echo、主动发送、图片受控保存，不启动 Agent。真实操作记录：单聊；可选内部群；text/image/mixed/quote；至少延后 6 分钟的主动发送；断网恢复；机器人被第二连接替代。6 分钟是测试用例，不是平台时限声明。还要按计划支持的最长实际任务延迟复测；6 分钟通过并不能证明 15 分钟或更久都有效。

Pi 脚本验证真实可执行路径、get_state、new_session、switch_session、agent_settled、图片、abort 和实际 profile。若用户的 Pi 缺少 agent_settled，不自动降级到 agent_end，先升级/固定对应版本，或另行提交经过 contract test 的版本适配层。

通过条件：真实账号能收、能回复、能在延后测试中主动发；模型原生图片能力确认；版本与 profile 记录完整。任一关键能力缺失即停止对应路线，不先假设再开发。

### G1：消息/图片/接口（无真实 Agent）

新增 `types.ts`, `config.ts`, `wecom.ts`, `media.ts` 和 normalize/media/config tests。把真实脱敏 frame 固化 fixture，但 secret/key/有效 URL 不能提交。

通过条件：N01–N08、M01–M10 全通过；同一消息只有一个入口；未授权下载次数与 Agent 调用次数都为零；文件校验失败不给 Agent 一个“空图片成功”请求。

### G2：Pi RPC contract（fake 子进程优先）

新增 `rpc-jsonl.ts`, `pi.ts`, `tests/fakes/pi.mjs`, contract tests。fake 通过命令参数选择脚本，不靠读取生产凭据；可记录 stdin 与脱敏 env 到测试临时目录。

通过条件：P01–P12、通用 B01–B06 全通过；特别是 prompt accepted → agent_end(willRetry) → continued message → agent_settled，只完成一次，结果是最终成功文本。提交一次仅测试环境的假后端端到端演示后，再启用真实模型。

### G3：持久化、队列、回复闭环

新增 `store.ts`, `bridge.ts`, `reply.ts`, `main.ts`, `cli.ts` 和 e2e/recovery tests。这里是约 300–600 行核心编排的目标，不在模块内重新实现企微协议或 Agent 循环。

通过条件：Q01–Q08、D01–D08、R01–R06 全通过。强制进程退出的恢复测试必须真正跨进程重启并使用同一临时 SQLite，不仅模拟抛异常。

### G4：真实端到端 MVP

只针对一个允许用户、一个临时 git 仓库、Pi 后端。

场景 A：微信文字要求新增一个测试函数、运行测试；最终回复包含变更摘要和测试结果，真实文件与测试结果对应。不得仅依据 Agent 的自述判通过。

场景 B：OCR 关闭，发送不在 prompt/文件名中泄漏答案的随机视觉标记/截图；检查原图 bytes 的 hash 与 Pi 输入一致，并人工确认模型的识别结果。模型识别正确性有随机性，图片字节契约和视觉能力 smoke 分开记录。

场景 C：让 fake/受控测试工具持续工作超过 6 分钟，同时发另一张图片与后续文字；图片在进入 Agent 队列前已保存，后续文字不越序，结果到达正确会话。不要为“拖时间”让模型空耗 token。

场景 D：上下文 nonce 延续、/new 隔离、重启后正确 session 恢复；两位测试用户不串上下文。使用临时仓库检查共享文件本身不包含 nonce，避免把共享工作区读取误认成会话泄漏。

场景 E：/cancel 后持续写文件的受控孙进程停止；/status 在长任务时仍响应。确认取消/超时可能已有部分修改。

通过条件：人工观察 + 结构化日志 + SQLite 状态 + 实际代码/文件证据一致；verification.md 标明未覆盖项，不写“全部通过”掩盖跳过的群聊或视觉测试。

### G5：可选 Codex 与 OCR

`codex.ts` 复用 B01–B06 contract、Q/D/R 通用 e2e，然后做独立 live smoke。不能因 Pi 跑通就宣布 Codex 跑通。

OCR 仅在原生视觉 MVP 已通过后接入。新增固定可执行命令的 Python worker，使用 PaddleOCR 或 RapidOCR，结构化输出 blocks/text、设置独立超时/字节上限。mode=off 不加载 OCR 依赖；augment 时 OCR 失败不影响原图；text-only 明确告知视觉信息损失。OCR 内容作为不可信引用，不允许改写 system prompt 或自动触发 shell。

## 14. 测试用例目录（必须落成测试，不只写在文档）

| ID | 输入/故障注入 | 必须断言 |
|---|---|---|
| N01 | 合法单聊文本 | sender/target/sessionKey 正确 |
| N02 | 同时触发 SDK generic/specific 事件 | bridge 只消费 generic；只入队一次 |
| N03 | 未授权 sender 或未授权 group | 下载=0，prompt=0，敏感回显=0 |
| N04 | 缺 msgid、sender、机器人 id 不匹配 | 拒绝，结构化错误码，不造临时身份 |
| N05 | mixed 多段文本与多图 | 保序、图片顺序一致、最多四图 |
| N06 | 一层 quote text/image | 标记 quote 来源，不当系统指令 |
| N07 | 同群两个发送者/单聊与群聊 | sessionKey 不同，路由不可跨域 |
| N08 | 未知 msgtype/未知 slash command | 明确不支持，不误当可执行命令 |
| M01 | 合法明文/加密图片 fixture | 明文 hash 与期望相等 |
| M02 | padding 16/32 边界及错误 key | 正确解密/确定失败，绝不传密文 |
| M03 | Content-Length 缺失/谎报/超限 | 累计超限即断流，清理 .part |
| M04 | 私网/元数据/IPv6/重定向/DNS 切换 | 不能访问禁用目标 |
| M05 | HTML/SVG/EXE 改名 png | 拒绝，Agent 未收到附件 |
| M06 | 超像素/损坏/动画图片 | 解码预算生效、无无界内存 |
| M07 | 下载超时/临时 URL 过期 | MEDIA_* 错误，提示重新发送 |
| M08 | 远程 ../ 文件名、symlink | 不能越出 mediaRoot |
| M09 | queued/running 文件超过 TTL | 未终结任务附件不删除 |
| M10 | 前任务长跑、后消息含图 | 图先保存，不等 Agent 空闲 |
| P01 | stdout 在 UTF-8/JSON/换行任意处分片 | 完整解析，无乱码 |
| P02 | JSON 字符串包含 U+2028/U+2029，CRLF | 不误切记录 |
| P03 | prompt success 后延迟输出 | 不提前 success/释放 worker |
| P04 | agent_end + 自动重试 + agent_settled | 等真正 settled；最终成功不被早期错误覆盖 |
| P05 | agent_settled 前最终 stopReason error | failed，不输出上轮答案 |
| P06 | new/switch 返回 cancelled=true | 不发送 prompt，不串会话 |
| P07 | prompt 返回 success=false | 本轮失败，collector 解绑，不能用旧 final |
| P08 | 子进程 exit、EPIPE、非法/超大 JSONL | 有界失败、请求 Promise 全部结束 |
| P09 | 新进程后旧 epoch 到达 | 不影响新任务状态 |
| P10 | extension UI select/confirm/input | 不自动同意、不死等，明确需本地交互 |
| P11 | WECOM_SECRET 填入 bridge env | fake Agent env 不含该 secret |
| P12 | 会话文件丢失、未写盘新会话 | 区分两种场景，不静默丢历史 |
| B01 | 后端收到 validated 图片 | hash 一致；Pi 用 native images；Codex 用 local_image |
| B02 | 同一会话两轮 | 会话 ref 被复用 |
| B03 | /new 后新轮 | session ref 改变，旧上下文不混入 |
| B04 | empty final/模型拒绝/工具失败 | 明确结果类别，不伪造成功摘要 |
| B05 | cancel/timeout，孙进程写 sentinel | 工作停止或 blocked；不能仅结束 Promise |
| B06 | persistSession 失败 | 不继续无映射执行；失败/清理一致 |
| Q01 | 同一 msgid 并发重复 10 次，再重启重放 | Agent 总执行次数=1 |
| Q02 | 第一个任务阻塞，提交后续任务 | active 最大=1 |
| Q03 | 前图 preparing，后文 ready | 同会话严格按 seq，不越序 |
| Q04 | 达到每会话/全局队列上限 | 新任务不启动媒体下载或 Agent |
| Q05 | 同消息重复 /new | generation 只增加一次 |
| Q06 | 非所属会话执行 /cancel /result | 不可操作/领取 |
| Q07 | 成功提交与取消竞态 | 一个终态，一组 final outbox |
| Q08 | /status 在长任务中 | 控制处理不等待 Agent；本地处理目标 <1s |
| D01 | 多中文/emoji/组合字符长结果 | 每段含前缀仍≤chunkBytes，连接后正文不丢失 |
| D02 | 旧 req_id 已不可回复，最终任务完成 | 用主动 sendMessage，target 正确 |
| D03 | 发送前断线 | pending，重连后只发结果，不跑 Agent |
| D04 | 服务器接收但不返回 ACK | unknown，不盲目 fallback/retry |
| D05 | 明确成功 ACK | sent，不重复发送 |
| D06 | 永久发送拒绝/可重试错误 | 分类正确，有限重试、无风暴 |
| D07 | 超过 maxAutoParts | 告知分页，/result 不启动 Agent |
| D08 | SDK 抛错带 token/aeskey/raw request | 日志里不出现 secrets |
| R01 | preparing 阶段强杀重启 | 失败可重发，孤儿文件清理 |
| R02 | queued 阶段强杀重启 | 输入完整时安全继续 |
| R03 | 已修改代码的 running 阶段强杀 | interrupted/tainted/blocked，不重跑 |
| R04 | result+outbox 事务中强杀 | 原子性成立，无“成功但没结果”的半状态 |
| R05 | succeeded+pending 强杀重启 | 只投递，不重复执行 |
| R06 | sending 阶段强杀重启 | unknown；人工领取既有结果 |

本地处理耗时目标不包含企微网络投递时延，也不是已测量 SLA。涉及模型输出的 live smoke 必须与确定性的传输契约测试分离。

## 15. 要新增的 scripts 与执行方式

下面是开发完成后应支持的命令契约，不是目前已有的成品 CLI。首次 scaffold 就把这些 scripts 写入 package.json；live 不作为默认 test 的一部分。

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test:unit": "vitest run tests/unit",
    "test:contract": "vitest run tests/contract",
    "test:e2e": "vitest run tests/e2e",
    "check": "npm run typecheck && npm run test:unit && npm run test:contract && npm run test:e2e",
    "bridge": "tsx src/cli.ts",
    "dev": "tsx src/main.ts",
    "smoke:wecom": "tsx scripts/smoke-wecom.ts",
    "smoke:pi": "tsx scripts/smoke-pi.ts",
    "smoke:codex": "tsx scripts/smoke-codex.ts"
  }
}
```

```bash
# 工程初始化、scripts 实现后：
npm ci
npm run check
npm run bridge -- doctor --config ./config.local.json --json
npm run smoke:wecom -- --config ./config.local.json --delay-seconds 360
npm run smoke:pi -- --config ./config.local.json
npm run dev -- --config ./config.local.json

# 只查询状态/已有结果，不触发 Agent：
npm run bridge -- status --config ./config.local.json

# 人工核查进程与 git diff 后，明确解除工作目录阻塞；禁止自动重跑：
npm run bridge -- recover --config ./config.local.json --ack-workspace default
```

doctor 返回结构化项：configValid/storeWritable/singleInstance/wecomAuthenticated/piRpcReady/sessionRestore/imagesNative/workspaceIsolation/workspaceBlocked。未真实测过的项是 unverified，不准默认 true；exit code 0 仅代表所要求的 readiness 检查全部通过。doctor 不应与正在运行的 bridge 建立第二条同 bot WebSocket：运行中读取本地状态；standalone live mode 必须先持有实例锁并确认 bridge 停止。

每个开发提交更新 `docs/verification.md`：版本、变更文件、测试 ID、命令、真实退出码、关键日志、跳过项与原因。CI fake 全绿不代表真实账号/模型能力验证完成。

## 16. OCR 的可选契约

```ts
interface OcrResult {
  text: string;
  blocks: Array<{ text: string; confidence?: number; box?: number[] }>;
  engine: "rapidocr" | "paddleocr";
  version: string;
  truncated: boolean;
}
```

mode=off 完全不加载 worker；augment 把 OCR 明确放入“图片提取的不可信参考文本”段落，同时仍发送原图；text-only 必须明确告知只获得文字，不把图表/空间信息识别能力混为 OCR 能力。调用通过固定 executable+argv 或 stdin JSON，shell:false；并发 1、超时、输出上限、禁止访问任意用户给出的文件路径。

不能在一次 Agent 执行已经发生工具副作用后，因视觉调用报错而自动换 OCR 后端重新执行同一任务。能力选择在提交 Agent 前完成；运行后失败由用户决定下一步。

## 17. 完成定义与给开发 Agent 的执行要求

MVP 完成需要 G0–G4 全部通过：真实企微文本/图片进来；图片字节实际进入 Pi 多模态输入；真实代码操作结果正确回复；会话不串；重复消息不重复运行；取消清理可验证；崩溃不自动重跑；最终投递未知不被伪装成执行失败；敏感凭据不进入 Agent 安全域；版本与 live 证据完整。

不要同时实现两后端、OCR、管理页与逐 token 输出。先做企微 echo → fake Agent 闭环 → Pi 文本 → Pi 图片 → 取消/恢复；最后才 Codex/OCR。

给开发 Agent 的直接任务：

> 按本文唯一设计基线新建 wecom-agent-bridge。先实现 G0 预检脚本和固定版本记录，再按 G1/G2/G3/G4 分阶段提交。每个阶段先补对应 test IDs，再写实现，提交命令、退出码和脱敏证据。默认单用户、固定临时仓库、Pi RPC、OCR off、无公网 HTTP、无自动审批。不要搬入 Hermes Agent runtime，不要修改用户既有 Agent Loop，不要用 agent_end 结算，不要继承 WECOM_SECRET，不要把投递失败变成重新执行任务。缺少真实账号权限/凭据时只完成 fake tests 并把 live 标成 unverified，不写已验证。

## 18. 上游来源定位

以下 URL 均是源码/官方维护文档入口；开发时必须替换 main 为 G0 锁定的 revision 来记录基线。没有在本文宣称这些 URL 对应用户本地已安装版本。

```text
[S1] https://raw.githubusercontent.com/NousResearch/hermes-agent/main/plugins/platforms/wecom/adapter.py
     https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tests/gateway/test_wecom.py
[S2] https://raw.githubusercontent.com/WecomTeam/aibot-node-sdk/main/src/client.ts
[S3] https://raw.githubusercontent.com/WecomTeam/aibot-node-sdk/main/src/types/message.ts
[S4] https://raw.githubusercontent.com/WecomTeam/aibot-node-sdk/main/src/ws.ts
     https://raw.githubusercontent.com/WecomTeam/aibot-node-sdk/main/src/message-handler.ts
[S5] https://raw.githubusercontent.com/WecomTeam/aibot-node-sdk/main/src/crypto.ts
     https://raw.githubusercontent.com/WecomTeam/aibot-node-sdk/main/src/api.ts
     https://raw.githubusercontent.com/WecomTeam/aibot-node-sdk/main/src/index.ts
[S6] https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[S7] https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/rpc/rpc-client.ts
[S8] https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/rpc/rpc-types.ts
[S9] https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/rpc/jsonl.ts
[S10] https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/rpc/rpc-mode.ts
[S11] https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md
[S12] https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/events.ts
[S13] https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/thread.ts
[S14] https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/threadOptions.ts
      https://developers.openai.com/codex/sdk
```
