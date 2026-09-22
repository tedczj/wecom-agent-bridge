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
| 连续对话 | 同一微信账号会话延续；`/new` 开始新会话 |
| 重复消息 | 同一消息 ID 去重，不重复执行已有任务 |
| 本地输入 | 单次 `run` 或持续 stdin JSONL `serve` |

回复目前只包含文字，没有语音合成或图片/文件发送。执行失败、取消和超时都可能已经产生副作用。

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

## 启动和微信测试

```bash
./start.sh
# 或指定配置文件
./start.sh /absolute/path/to/config.local.json
```

脚本默认读取仓库中的 `config.local.json`，缺少或不匹配依赖时运行 `npm ci`，每次启动前构建。同一配置已有实例时，核对实例锁、PID 与启动命令，发送 SIGTERM；15 秒未退出再发送 SIGKILL，等待最多 5 秒，确认退出后再启动。按 Ctrl-C 停止。

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
