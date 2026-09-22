# Local Agent Bridge

这个仓库现为**本地 CLI / JSONL → Codex 或 Pi → 本地结果**。默认后端是 Codex；Pi RPC 保留为可选后端。仓库 URL 暂未重命名。

企业微信 SDK、WebSocket、账号配置、网络图片下载/解密和企微 smoke 脚本已删除。没有 HTTP 服务、微信接入、OCR、管理页或自动远程审批。使用本地图片，不需要企业微信测试条件。

## 安装与首次运行

支持 macOS / Linux；Node.js 22.16+（不含 23）或 24+。需要自行安装并配置真实 Codex CLI，或者支持 `agent_settled` 的 Pi。当前测试环境为 Linux / Node 22.16，**离线协议测试不等于真实模型验收**，见 `docs/verification.md`。

```bash
npm ci
npm run check
cp config.example.json config.local.json
```

编辑 `config.local.json` 中所有 `/absolute/path/...` 占位路径：

- `workspace.path`：允许 Agent 操作的临时 Git 仓库；先不要使用重要项目。
- `agent.command`：`command -v codex` 得到的绝对路径；不是一段 shell 命令。
- `agent.env.HOME`：事先创建的专用 Agent HOME。
- `stateRoot`：新的持久化目录，不能在工作仓库里。
- `codex.home`：专用 Codex 配置/认证/会话目录，不能在工作仓库里。

不要复用旧版状态数据库。v1 数据库会被明确拒绝，原文件不迁移、不删除、不重放。

Codex 登录需要使用与配置一致的专用 `CODEX_HOME`。例如在本机完成登录：

```bash
mkdir -p /your/dedicated-agent-home /your/dedicated-codex-home
CODEX_HOME=/your/dedicated-codex-home codex login
```

若使用 API key，只在本机环境中设置，并在 `agent.passEnv` 显式列出 `CODEX_API_KEY`；不要把密钥写进配置或提交到 Git。Bridge 不自动加载 `.env`，也不把整个父进程环境传给 Agent。登录方式和模型选择须与本机 Codex 的实际版本一致。

```bash
# 默认 read-only，无需企业微信
npm run bridge -- run --config config.local.json --message '介绍这个仓库，不要修改文件'

# 同一会话的后续请求会恢复同一个 Codex thread
npm run bridge -- run --config config.local.json --session default --message '继续上一轮分析'

# 图片会复制到受控目录并校验；不是仅把路径拼进提示词
npm run bridge -- run --config config.local.json --message '解释图片内容' --image /absolute/path/to/image.png

# 从 stdin 读取较长提示词
printf '检查测试覆盖情况，不要改代码' | npm run bridge -- run --config config.local.json --stdin
```

确需改代码时，把 `codex.sandbox` 从 `read-only` 改成 `workspace-write`。默认工具网络访问关闭，固定使用 `approval_policy="never"`，不自动批准越过沙箱的操作。不支持 `danger-full-access`、`--yolo`、`--last` 或任意 Codex 参数透传。模型请求本身仍需要模型服务连接；`networkAccess=false` 是工具沙箱的网络设置，不是“离线模型”。

`HOME`、`CODEX_HOME`、已安装扩展/MCP/规则和外部包装程序属于本机信任域；路径参数和 cwd 不是完整的 OS 安全隔离。Pi 必须已有经过操作者验证的外部隔离，才可将配置的 `agent.isolation` 改为 `external`。不要仅修改该字段就当作完成隔离。

## 稳定的本地接口

完成一次构建后，程序间调用优先直接使用 Node，避免 npm 的额外日志：

```bash
npm run build
printf '%s\n' '{"id":"req-001","session":"project-a","text":"介绍这个仓库","images":[]}' \
  | node dist/src/cli.js serve --config config.local.json
```

`serve` 接收严格 UTF-8 JSONL，每条记录必须以换行结束。字段只有 `id`、`session`、`text`、`images`；`id` 必填，`text` 可为空但必须提供至少一张图片。图片必须是本地绝对路径，URL 不受支持。来源身份固定为配置里的 `local.actorId`，不能从消息伪造。该入口只面向受信任的本机操作者，不是公网鉴权协议。

stdout 是 JSONL，包含 `receipt`、`accepted`、`result` 和单次运行的 `status`。诊断代码输出 stderr，不输出原始 SDK 错误、工具 stdout、模型思考或凭据。`result` 含 `taskId`、`session`、`text`。stdout 写入回调成功只代表本地流接受了数据，不证明下游业务已经持久化。

相同 `id` 和相同输入会返回原任务，不重复执行；重复 ID 携带不同文本、路径或会话会返回 `REQUEST_ID_CONFLICT`。图片内容替换后需要使用新请求 ID。各本地会话、后端和工作目录之间隔离上下文，全局最多执行一个 Agent 任务。

## 控制命令与恢复

下面的文本可通过 `run --message` 或持续打开的 `serve` 输入发送：

```text
/help
/status
/new
/cancel [taskId]
/result taskId [part]
```

`/new` 创建新的会话代次但保留旧结果；不能绕过正在执行的任务或 interrupted 阻塞。`/cancel` 可在持续运行的 `serve` 中提交；单次 `run` 用 Ctrl-C 取消。不能另开第二个 CLI 抢占同一个 stateRoot；实例锁会拒绝它。

```bash
# 只读查询，不启动任何 Agent
npm run bridge -- status --config config.local.json
npm run bridge -- result --config config.local.json --task FULL_TASK_UUID
```

取消、超时和失败都可能已经修改文件。Codex 被强制终止时保守记录为 `interrupted`，即使进程组已退出，也不把它当作“没有副作用”。这会阻塞后续任务，防止自动重跑。操作者先检查进程、工作区 `git diff` 和外部副作用，再执行：

```bash
npm run bridge -- review --config config.local.json --acknowledge-side-effects
npm run bridge -- run --config config.local.json --message '/new'
```

`review` 不重跑任务、不删除会话、不自动 `git reset`。它不会把 tainted 会话恢复为可信，必须通过 `/new` 另起会话。若旧进程组还活着，会继续拒绝解除阻塞；脱离进程组的守护进程不能仅靠这个检查证明已消失，仍需人工检查或外部隔离。

退出码：`0` 成功；`1` 参数/接收/任务失败；`2` 执行不确定、非终态或结果未确认输出；`130` 收到终止信号。`serve` 的逐任务成败以输出/SQLite 为准，正常 EOF 只表示输入流处理完毕。

## Pi 和真实模型 smoke

Pi 使用 `config.pi.example.json`，独立 `agent.sessionRoot`，由适配器管理 `--mode rpc` 和会话参数。当前 Pi 后端会等待 `agent_settled`，不会把 prompt ACK 或 `agent_end` 当作任务完成。

```bash
# 需要真实 Agent 登录；会消费模型额度，必须显式 --live
npm run smoke:codex -- --live --config config.local.json
npm run smoke:codex -- --live --config config.local.json --image /absolute/path/to/image.png
npm run smoke:pi -- --live --config config.pi.local.json
```

smoke 验证跨进程会话标识和两轮 nonce 问答。带图测试只报告“传输完成，需人工确认看图内容”，不会把模型输出了文字当作视觉正确。它不证明代码写入隔离或真实模型取消清理已经验收。

完整设计见 `docs/DESIGN.md`，实现选择见 `docs/IMPLEMENTATION.md`，原 58 个测试 ID 的迁移说明见 `docs/TEST_MATRIX.md`，本次真实执行证据见 `docs/verification.md`。
