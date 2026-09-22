# Local Agent Bridge

把个人微信 ClawBot 的消息交给指定工作目录中的 Codex 或 Pi，再把结果回复到微信。也保留本地 CLI / JSONL 入口。

个人微信通过腾讯 iLink 扫码绑定、HTTPS 长轮询收消息，无需安装 OpenClaw 或开放本地 HTTP 端口。仅接受扫码绑定者的 ClawBot 私聊，不接管普通好友或群聊。企业微信未实现。

## 当前能力

| 输入或操作 | 行为 |
|---|---|
| 微信文字 | 持久化排队，调用 Agent，以文字回复 |
| 微信图片 / 图文 | 从微信 CDN 有界下载、按需 AES 解密，完整校验后原生传给 Agent |
| 微信语音 | 使用微信附带的 `voice_item.text`；没有转写文本时提示改发文字，未接额外 ASR |
| 文件、视频、引用消息 | 明确回复暂不支持，不作为完整任务执行 |
| 连续对话 | 同一微信账号会话延续；`/new` 开始新会话；启用 routing 后按目录/profile 绑定及 24 小时规则续接 |
| 重复消息 | 同一消息 ID 去重，不重复执行已有任务 |
| 本地输入 | 单次 `run` 或持续 stdin JSONL `serve` |

回复目前只包含文字，没有语音合成或图片/文件发送。执行失败、取消和超时都可能已经产生副作用。

## 可选目录路由与历史会话

[完整规则与实施设计](docs/BRIDGE_ROUTING_SESSION_RULES.md)保留 BR-01..BR-22。[config.routing.example.json](config.routing.example.json) 提供多目录配置模板；将私有配置放在所有执行目录之外，填写实际路径后使用原有 `--config` / `start.sh` 入口。旧配置保持单目录，不自动扩大扫描权限；无需重建微信登录。

启用 `routing` 后，首条消息使用默认目录。之后保持当前目录，只有明确切换才改变；24 小时只决定自动续接，不重置目录。目录授权 roots 与执行 profiles 分离；根级 profile 是 operator 对根下新目录的执行授权，可以省略以禁止自动继承。配置变更需重启，已排队任务的 profile 摘要不匹配会失败，不会改派。

| 用户表达 | 行为 |
|---|---|
| `去配音`、`切回微信桥`、`/route video` | 按别名/描述/授权目录定位；纯切换不调用 worker |
| `去配音，先别改，只检查` | 定位后将原文交给该目录的 Agent |
| `参考一下视频项目的实现` | 保持当前目录；并不额外授予参考目录读取权限 |
| `开个新会话`、`/new` | 新建逻辑会话；不取消正在执行的任务 |
| `重新跑一下测试` | 正常任务，按当前会话规则继续 |
| `video 有哪些历史会话`、`/sessions video` | 查询该目录，不切目录；默认显示十条 |
| `/find 关键词`、`下一页` | 搜索授权历史，包括十条以前的记录；或继续查询 |
| `看看第二个`、`继续第二个` | 阅读或选择最近列表快照中的会话；恢复后下一条任务可续接超过 24h 的历史 |
| `当前目录简称微信桥`、`/alias 微信桥` | 保存有版本和来源的 scoped 别名 |
| `先停一下`、`/cancel [taskId]` | 取消本对话任务；停止不确定仍阻塞 |

配置 `routing.interpreter` 后，普通自然语言优先由 Agent 识别意图；程序校验目录/profile、会话归属和执行条件。显式 slash 命令直接处理。模型失败会明确报错，不降级为把原话交给工作 Agent。可复用现有 Codex 登录：

```json
"interpreter": {
  "provider": "codex",
  "model": "gpt-5.6-terra",
  "reasoning": "high",
  "timeoutMs": 90000
}
```

此方式要求基础 backend 为 Codex，并使用支持 `--ignore-user-config`、`--ephemeral`、`--output-schema` 的已安装 CLI。路由 Agent 使用独立空目录、只读沙箱和结构化输出；不加载用户 Codex 配置或项目文档，关闭 shell、图片查看、MCP、应用/插件和子 Agent 配置，拒绝任何执行工具事件。登录仍使用原有 Codex home。它负责识别意图、选择候选，宿主执行有界目录/会话读取；这些约束不是完整 OS 隔离证明。

也保留 `provider:"http"`：配置 `endpoint`（HTTPS Chat Completions JSON 接口）、`model`、可选 `reasoning:"high"`、`apiKeyEnv` 和 `timeoutMs`。密钥仅在宿主读取。未配置解释器时才使用内置表达式规则，不声称理解任意口语。无论哪种方式，解释器只接收有界用户上下文和候选目录说明，不接收 worker 全部历史或微信 token。

例如“查询 ocr service 的 GPT session 当前状态”应查询 OCR 历史，不切换当前目录，也不启动工作任务。列表展示活动状态；执行中/不完整会话可以阅读，但不能恢复。原生历史优先使用配置 Codex home 下 `state_5.sqlite` 的 cwd 索引定位 `sessions` rollout，再重新校验文件头；索引不可用/格式不支持时走目录扫描。已知没有 cwd 的旧版文件不作为任何项目的可恢复历史，其他目录的正文不解析。匹配项目按 JSONL 流式读取（256 MiB/文件、8 MiB/帧），单个坏文件保留不完整提示，不能据此自动新建任务。模型/推理配置不一致的历史仍可查看，但不自动恢复。

Pi 原生文件不能证明 `agent_settled`，自动续接时间仍只来自 bridge 验证成功的回复。`history:false` 明确关闭原生发现，仅保留 bridge 会话。schema v2 事务升级为 v3，旧回复时间未知；跨模式排队任务不自动执行。不同账户应使用不同 session root。

`npm run smoke:routing -- --live --config FILE` 仅调用路由 Agent 并只读查询 OCR 历史，不执行工作任务、不发微信消息；默认无 `--live` 拒绝运行。

同一 bridge 全局串行；同用户、同宿主的多个 bridge 对同一真实目录还使用独占锁。执行中断后锁保留，`review --acknowledge-side-effects` 检查进程后清理本实例锁。外部 CLI、其他用户和脱离进程组的副作用不在该锁的保证内。

## 安装与配置

支持 macOS / Linux，Node.js `>=22.16.0 <23` 或 `>=24`。自行安装并登录 Codex CLI，或安装支持 `agent_settled` 的 Pi。

```bash
npm ci
npm run check
cp config.example.json config.local.json
```

编辑 `config.local.json` 的占位路径：

| 字段 | 用途 |
|---|---|
| `transport` | `weixin` 为个人微信；`local` 为本地入口。省略时兼容旧配置，取 `local` |
| `workspace.path` | Agent 工作目录，需存在；Codex 使用时应为 Git 仓库 |
| `agent.command` | `command -v codex` 得到的可执行文件绝对路径，不是 shell 命令 |
| `agent.env.HOME` | Agent 使用的 HOME，与所选登录环境保持一致 |
| `stateRoot` | 私有状态目录，不能位于工作目录内 |
| `codex.home` | 已登录的 Codex 配置/认证/会话目录，不能位于工作目录内 |
| `codex.sandbox` | 默认 `read-only`；需要修改工作区时设为 `workspace-write` |

若准备专用 Codex 目录，登录时使用同一目录：

```bash
mkdir -p /your/agent-home /your/codex-home
CODEX_HOME=/your/codex-home codex login
```

也可以把配置指向已有登录目录。不要提交该目录的配置或凭据。若使用 API key，仅通过本机环境提供，并在 `agent.passEnv` 显式列出支持的变量。Bridge 不加载 `.env`，也不把整个父进程环境传给 Agent。

微信与本地模式必须使用独立 `stateRoot`。旧版 v1 数据库会被拒绝，不自动迁移或重放。工作目录、账号身份及后端会话目录与状态绑定，不能随意更换后继续使用原数据库。

Pi 的本地配置参考 [config.pi.example.json](config.pi.example.json)。Pi 必须已有经过验证的外部隔离，才能把 `agent.isolation` 设为 `external`；更改该字段本身不提供隔离。

若要在已有微信配对上切换 Pi，准备私有的 `config.pi.weixin.local.json`：设置 `transport: "weixin"`、`backend: "pi"`，沿用 `config.local.json` 的 `workspace`、`local.actorId` 和 `stateRoot`，配置实际 Pi 可执行文件或隔离包装器，并使用独立的 `agent.sessionRoot`。这样复用配对、游标和消息去重记录；Pi 与 Codex 的对话上下文分别保存。本地 smoke 仍用独立 stateRoot 的 `config.pi.local.json`。

配置文件各自用途如下；仓库仅发布占位模板，`*.local.json` 由操作者在本机创建并保持私有。

| 文件 | 用途 |
|---|---|
| `config.example.json` | Codex 微信配置模板 |
| `config.pi.example.json` | Pi 本地配置模板，可按上述约定配置微信入口 |
| `config.local.json` | Codex 微信运行配置；默认启动和 `--backend codex` 使用 |
| `config.pi.weixin.local.json` | Pi 微信运行配置；`--backend pi` 使用 |
| `config.cli.local.json` | Codex 本地 CLI / live smoke，使用独立状态目录 |
| `config.pi.local.json` | Pi 本地 CLI / live smoke，使用独立状态目录 |

无需保留切换前的配置副本。`tsconfig.json` 是构建配置，不能作为 Agent 配置传给启动脚本。

## 启动和微信测试

```bash
./start.sh
# 切换现有微信实例到 Pi / 切回 Codex
./start.sh --backend pi
./start.sh --backend codex
# 或指定配置文件
./start.sh /absolute/path/to/config.local.json
./start.sh --backend pi /absolute/path/to/pi-config.json
```

脚本默认读取仓库中的 `config.local.json`；`--backend pi` 默认选择 `config.pi.weixin.local.json`，`--backend codex` 选择 `config.local.json`。显式指定文件时，后端参数必须与文件一致，不会改写配置。缺少或不匹配依赖时运行 `npm ci`，每次启动前构建。

已有实例时，核对实例锁、PID 与启动命令，发送 SIGTERM；15 秒未退出再发送 SIGKILL，等待最多 5 秒，确认退出后再启动。跨配置替换必须显式指定 `--backend`，且状态目录、工作目录、操作者与 transport 一致。其他后端有未完成任务时拒绝切换；不迁移、不重跑任务。按 Ctrl-C 停止。

首次微信启动会显示二维码。用手机微信扫描并确认绑定；如果提示验证码，在终端输入手机显示的数字。看到“微信接收已启动”后，在手机 **ClawBot 私聊**发送：

1. `/help`：验证微信消息接收和回复，不调用模型。
2. `介绍当前工作目录，不要修改文件`：验证 Agent 执行。
3. 图片或语音：分别检查图片理解和微信转写文本是否可用。

微信绑定与 Codex 登录是独立步骤。终端显示已启动只代表进程进入收消息循环；任务执行、回复 ACK 和手机实际显示应分别确认。当前验证结果见 [docs/verification.md](docs/verification.md)。

## 本地 CLI / JSONL

另建配置文件，例如 `config.cli.local.json`，设置 `"transport": "local"` 和独立 `stateRoot`：

```bash
npm run bridge -- run --config config.cli.local.json --session demo --message '介绍当前目录'
npm run bridge -- run --config config.cli.local.json --session demo --message '继续总结'
./start.sh config.cli.local.json
```

持续本地模式在终端输入完整 JSON，每条一行：

```json
{"id":"req-001","session":"demo","text":"介绍当前目录，不要修改文件","images":[]}
```

每个新请求更换 `id`，相同 `session` 延续上下文。`images` 只接受本地绝对路径；微信的远程图片由微信适配器单独处理。本地输入只能来自可信操作者。

构建后，程序调用可以直接使用 `node dist/src/cli.js serve --config config.cli.local.json`。stdout 为 JSONL；日志及构建提示写 stderr。stdin 关闭时等待已接收任务处理完毕再退出。本地 stdout 写入成功只表示流接受数据，不代表下游业务已持久化。

每个 stateRoot 只有一个 Agent worker。多个实例间没有工作目录级互斥，不应同时操作同一个工作目录。

## 状态、取消与恢复

微信私聊可直接发送以下命令；本地模式则放在 `text` 或 `--message` 中：

```text
/help
/status
/new
/cancel [taskId]
/result taskId [part]
```

本地只读查询不会启动 Agent：

```bash
npm run bridge -- status --config config.local.json
npm run bridge -- result --config config.local.json --task FULL_TASK_UUID
```

无法确认执行已停止时，任务进入 `interrupted`，工作区阻塞、会话标记为 tainted。重启和 `/new` 都不能绕过它。先停止 bridge，检查进程、工作区差异和外部副作用，再执行：

```bash
npm run bridge -- review --config config.local.json --acknowledge-side-effects
./start.sh
```

随后在微信发送 `/new`。本地模式使用相应本地配置。`review` 不重跑、不删除结果、不执行 `git reset`。已进入 `unknown` 的发送不会自动重发，可使用 `/result` 手工领取保存的结果。

## 常见错误

| 错误码 | 处理 |
|---|---|
| `WEIXIN_AUTH_EXPIRED` | 停止 bridge，把 `stateRoot/weixin-auth.json` 移到私有备份位置，再启动扫码；账号身份变化需使用新 stateRoot |
| `WEIXIN_API_REJECTED` | 查看日志中的数值 `apiRet` / `apiErrcode`；省略成功返回码是合法响应，不是失败 |
| `WEIXIN_API_PROTOCOL` | 响应字段格式不符合已实现协议，检查版本和网络链路 |
| `WEIXIN_VERIFY_REQUIRES_TERMINAL` | 首次绑定时在交互终端启动并输入手机验证码 |
| `STATE_TRANSPORT_MISMATCH` / `WEIXIN_ACCOUNT_MISMATCH` | 配置与已有状态不匹配，使用对应配置或新状态目录 |
| `RESTART_PROCESS_MISMATCH` | 实例锁指向的进程不符合当前启动命令；脚本拒绝终止它，需人工核对 |
| `START_BACKEND_MISMATCH` | `--backend` 与所选配置的 `backend` 不一致，修正参数或配置 |
| `BACKEND_SWITCH_BUSY` | 其他后端有未完成任务；先使用原配置处理任务，再切换 |
| `AGENT_PROCESS_REVIEW_REQUIRED` / `WORKSPACE_BLOCKED` | 按上述检查和 review 流程处理，不自动清除执行不确定性 |

退出码：`0` 正常完成，`1` 接收或执行失败，`2` 单次任务非终态/执行不确定/输出未确认，`130` 收到终止信号。持续模式每条任务的结果以 SQLite 和回复为准。

## 验证与资料

```bash
npm run check
# 以下显式调用真实模型，需要已登录的 local 配置
npm run smoke:codex -- --live --config config.cli.local.json
npm run smoke:codex -- --live --config config.cli.local.json --image /absolute/path/to/image.png
npm run smoke:pi -- --live --config config.pi.local.json
```

默认测试离线、无模型调用。真实 smoke 检查两轮问答和跨进程会话；图片 smoke 只证明传输完成，需要人工验证理解结果。只读模式、cwd 和进程组退出都不是完整 OS 隔离或外部副作用清理证明。

- [设计和行为约定](docs/DESIGN.md)
- [实现选择及协议来源](docs/IMPLEMENTATION.md)
- [测试映射](docs/TEST_MATRIX.md)
- [当前验证记录](docs/verification.md)
- [隐私与提交边界](docs/PRIVACY.md)
