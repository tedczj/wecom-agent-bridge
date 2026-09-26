# Local Agent Bridge

把个人微信 ClawBot 的消息交给指定工作目录中的 Codex 或 Pi，再把结果回复到微信。也保留本地 CLI / JSONL 入口。

个人微信通过腾讯 iLink 扫码绑定、HTTPS 长轮询收消息，无需安装 OpenClaw 或开放本地 HTTP 端口。仅接受扫码绑定者的 ClawBot 私聊，不接管普通好友或群聊。企业微信未实现。

## 运行方式

微信和本地 CLI/JSONL 统一经过 Bridge Agent → 目录对应的 Route Session Agent → 按需执行业务 Agent。服务只创建 `HierarchicalBridge`；缺少 `models`、`routing`、`orchestration` 或匹配的运行时能力证明时拒绝启动。旧 Bridge、临时分类器、旧历史扫描器和固定回复链路已删除，`routing.interpreter` 明确报 `ROUTING_INTERPRETER_REMOVED`。

业务兜底和 Bridge 默认 `gpt-6-sol / high`，Route 继承 Bridge，摘要默认复用 Bridge 配置。业务的请求覆盖和显式会话偏好不会改变管理模型。`contextWindowTokens` 必须填写已验证的有效容量；当前本机探测为 828400，不代表真实 1M/80% 长测通过。实际证据见 [verification.md](docs/verification.md)。

查询“看下 term4u 项目里在干啥”先按项目名称或别名定位，把用户原文交给 term4u Route。Route 按需读取 Codex/Pi 原生业务会话正文回答；“这个 session”“LLM 最后说了什么”等追问沿用查询的原生会话，不指微信里的 Bridge/Route 回复。Bridge 数据库持久记录管理会话、已绑定业务会话及外部原生会话的角色，历史摘要和换代交接保留回复来源。查询不启动业务、不刷新业务回复时间，也不要求先完整扫描全部历史。普通工作和连续业务对话才委派业务 Agent。不会拼接历史 query/reply 或复制历史图片到新请求。

## 输入与目录

| 输入或操作 | 行为 |
|---|---|
| 微信文字、图文 | 身份校验、持久化、媒体准备、三层处理、文字回复 |
| 微信语音 | 使用微信附带转写；没有转写则明确提示 |
| 文件、视频、引用消息 | 明确回复暂不支持 |
| 重复消息 ID | 去重，不重复执行或发送已确认结果 |
| 本地输入 | `run` 单次请求或 `serve` 持续 JSONL |

`routing.roots` 是目录授权边界；普通发现限定在 `~/workspace`。先匹配项目名称和别名，再进行有界目录搜索；同一会话的相同搜索保留分页进度。外部绝对路径必须由用户明确提出，未授权路径需通过同会话 `/approve` 授权，授权前不读取目录内容。授权只覆盖该物理目录，不改变沙箱或扩大根权限；配置变化、路径替换、过期或问题未完整送达均拒绝。

可设置 `routing.fallbackWorkspace` 为已登记的 workspace ID，例如将 `temp` 登记到 `~/workspace/temp`（配置需写绝对路径，目录需预先存在，Codex 使用时需为 Git 仓库）。未定位到项目且不属于已有业务连续对话的普通问答、搜索和图片请求交给此目录的业务 Agent。纯图片也从第一条起委派，后续文字复用同一业务会话的原生图片上下文。明确项目、强制目录选择和已有业务续接优先；真实目录歧义、目录授权和指定项目历史查询仍按原规则处理。未配置时保留原来的目录澄清行为。示例见 `config.routing.example.json`。

| 控制命令 | 行为 |
|---|---|
| `/route 目录`、`/alias 简称` | 切换目录或保存当前目录别名 |
| `/sessions [目录]`、`/find 关键词` | 查询原生历史，不启动业务 |
| `/read 序号`、`/more`、`/resume 序号` | 读取、分页或显式选择已验证会话 |
| `/new [目录]` | 准备新业务会话，不取消正在执行的任务 |
| `/status`、`/debug [requestId]` | 查询宿主保存状态，不调用模型或扫描原生历史 |
| `/cancel [requestId]`、`/result requestId [part]` | 取消任务或领取已保存原件 |

每个目录保留独立 Route 会话和业务绑定；原生历史由 `src/history/` 按需读取。未知或不完整历史不能当作空历史自动执行业务。`/debug` 只返回脱敏的请求、执行、摘要、投递元数据，不含原文、路径、凭据或媒体密钥。

## 从新状态启动

只初始化空状态或打开已有 v4 库，不转换旧库、不导入旧绑定。清空旧实例时先停止接收并确认没有运行任务或未决投递，再删除该实例历史库、绑定、查询游标、答案摘要及关联运行产物。保留微信配对和传输接收位置，避免旧消息重收；不删除项目或 `~/.codex` 原生业务会话。Bridge/Route 按新请求懒初始化。

## 安装与配置

支持 macOS / Linux，Node.js `>=22.16.0 <23` 或 `>=24`。自行安装并登录 Codex CLI，或安装支持 `agent_settled` 的 Pi。

```bash
npm ci
npm run check
cp config.example.json config.local.json
```

编辑 `config.local.json` 的占位路径，并配置三层管理运行时：

| 字段 | 用途 |
|---|---|
| `transport` | `weixin` 为个人微信；`local` 为本地入口。省略时取 `local` |
| `workspace.path` | Agent 工作目录，需存在；Codex 使用时应为 Git 仓库 |
| `agent.command` | `command -v codex` 得到的可执行文件绝对路径，不是 shell 命令 |
| `agent.env.HOME` | Agent 使用的 HOME，与所选登录环境保持一致 |
| `stateRoot` | 私有状态目录，不能位于工作目录内 |
| `codex.home` | 已登录的 Codex 配置/认证/会话目录，不能位于工作目录内 |
| `codex.sandbox` | 默认 `read-only`；需要修改工作区时设为 `workspace-write` |
| `codex.networkAccess` | 业务联网开关；`true` 启用原生实时网页搜索，并允许配置的 workspace-write 执行环境联网；Bridge／Route 管理层仍禁用网页搜索 |

管理运行时必须使用通过受限工具/禁止原生压缩探测的 Codex app-server；参考 [运行时兼容说明](docs/THREE_LAYER_RUNTIME_COMPATIBILITY.md)。先执行：

```bash
npm run probe:controller -- --live --config config.local.json --out runtime/controller-probe
# 只有 PASS 时，将输出目录内 runtime-lock.json 放到 orchestration.controllerRuntime.workRoot。
./start.sh config.local.json
```

证明绑定 binary、登录配置、模型、推理级别和窗口；任何变化都需要匹配证明。Pi 只替换业务后端，管理层仍需此运行时。

若准备专用 Codex 目录，登录时使用同一目录：

```bash
mkdir -p /your/agent-home /your/codex-home
CODEX_HOME=/your/codex-home codex login
```

也可以把配置指向已有登录目录。不要提交该目录的配置或凭据。若使用 API key，仅通过本机环境提供，并在 `agent.passEnv` 显式列出支持的变量。Bridge 不加载 `.env`，也不把整个父进程环境传给 Agent。

微信与本地模式必须使用独立 `stateRoot`。旧版 v1/v2 数据库会被拒绝，不自动迁移或重放。工作目录、账号身份及后端会话目录与状态绑定，不能随意更换后继续使用原数据库。

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

脚本默认先查仓库中的 `config.local.json`，不存在时查 `${XDG_CONFIG_HOME:-$HOME/.config}/wecom-agent-bridge/config.local.json`。推荐将私有配置放在后者，避免位于执行目录内。`--backend pi` 以同样顺序查找 `config.pi.weixin.local.json`，`--backend codex` 查找 `config.local.json`。显式指定文件时只使用指定路径，后端参数必须与文件一致，不会改写配置。缺少或不匹配依赖时运行 `npm ci`，每次启动前构建。

`start` 入口现在启动常驻管理进程及桥接子进程。已有实例时，核对实例锁、PID、父子关系与启动命令，再停止匹配的子进程和管理进程；保留有界 SIGTERM / SIGKILL 处理，管理操作进行中拒绝外部并发重启。跨配置替换必须显式指定 `--backend`，且状态目录、工作目录、操作者与 transport 一致。其他后端有未完成任务时拒绝切换；不迁移、不重跑任务。按 Ctrl-C 停止。

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

每个 stateRoot 只有一个 Agent worker。同用户同宿主的实例使用物理目录互斥锁；外部 CLI 和脱离进程组的副作用不在锁的保证内。

## 状态、取消与恢复

微信私聊可直接发送以下命令；本地模式则放在 `text` 或 `--message` 中：

```text
/help
/status
/new
/cancel [taskId]
/result taskId [part]
/approve
/update
/restart
```

### 微信确认、更新与重启

- `/approve`：确认本对话上一条待授权的目录请求，或确认 `/update`、`/restart`。不接受参数、不批准任意 shell、不改变 Codex 沙箱权限。
- `/update`：显示桥接安装目录和更新步骤；下一条 `/approve` 后，等待已接收工作完成，固定执行 `git pull --ff-only origin dev`、`npm ci --no-audit --no-fund`、`npm run check`，通过后替换桥接子进程。只允许 `dev`；跟踪文件有本地改动或不能快进时失败，不 stash/reset、不覆盖冲突的未跟踪文件。
- `/restart`：同样先询问、下一条 `/approve` 确认，等待已接收工作完成后重启桥接子进程。管理进程保持存活，恢复后通过原对话的 outbox 反馈结果。

管理确认仅接受同一已验证对话的下一条 `/approve`；问题全部送达、15 分钟内且管理进程身份未变化才生效。其他回复取消待确认操作；`/status`、`/cancel`、`/help`、`/result` 仍可处理。确认后拒绝新工作，`/status` 可查看阶段。首次回执只是已接收，最终回执才报告成功或失败；未知投递不自动重发，可用 `/result` 获取该管理任务的最终结果。

这些管理命令需要 `./start.sh` 或 `node dist/src/cli.js start --config FILE` 的管理进程入口；单次 `run` 和直接 `serve` 不启动管理进程。安装目录仍需宿主账号具备写入/Git/npm 权限，微信批准不会突破操作系统只读限制。

更新暂存旧的 `dist`、`node_modules`；安装、检查或新子进程启动失败时恢复这些运行产物，不回滚 Git 源码或重放 Agent 任务。异常中断保留状态/备份，下次启动只报告失败，不自动重做更新。稳定管理进程继续负责同一次运行中的生命周期；正常完整停止/启动会加载它的最新实现。当前实现按 macOS/Linux 进程语义验证。

`npm run smoke:maintenance -- --live` 使用临时仓库、本地 Git 远端和独立状态，实际运行 npm 安装与完整检查、进程替换和本地回执；不发送微信，也不调用模型。

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

组合路由的真实验证：`npm run smoke:planner -- --live --codex /absolute/path/to/codex --home /absolute/path/to/codex-home`。使用隔离的临时项目/状态与合成红色图片，复用登录；验证三类中文请求、未配置目录、terra/high、新会话图片交接和原生 turn metadata。只运行本地只读任务，不发送微信消息；临时状态和原生测试会话保留用于核查。测试仅显式传入当前代理环境，不继承整个父环境。

- [设计和行为约定](docs/DESIGN.md)
- [实现选择及协议来源](docs/IMPLEMENTATION.md)
- [测试映射](docs/TEST_MATRIX.md)
- [当前验证记录](docs/verification.md)
- [隐私与提交边界](docs/PRIVACY.md)
