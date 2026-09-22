# 当前验证记录

验证日期：2026-09-22。本文覆盖当前个人微信与本地入口版本；旧阶段的失败日志和报告由 Git 历史保留，不再作为当前说明叠加。

## 当前本地检查

环境：macOS / Darwin arm64、Node v25.1.0、npm 11.6.2。

| 检查 | 结果 | 证据 |
|---|---|---|
| `npm ci --no-audit --no-fund` | exit 0，从当前 lockfile 安装 | [install.txt](evidence/install.txt) |
| `npm run check` | exit 0；类型检查、构建、147 tests；0 failed / cancelled / skipped | [check.txt](evidence/check.txt) |
| `npm run smoke:codex` 不带 `--live` | 预期 exit 1，LIVE_OPT_IN_REQUIRED；未调用模型 | [smoke-opt-in.txt](evidence/smoke-opt-in.txt) |
| `bash -n start.sh` | 通过 | 本地执行 |
| 构建/测试输入校验 | SHA-256 清单 | [source-manifest.sha256](source-manifest.sha256) |

测试日志来自本轮真实执行，已替换本机临时路径和进程 PID；测试结果、数量和耗时保留。默认用例全部使用合成数据和离线协议 doubles。用例范围见 [TEST_MATRIX.md](TEST_MATRIX.md)。

## 本轮目录路由验收

审查基线 `5a5c488`。补全并覆盖更新 BRIDGE_ROUTING_SESSION_RULES.md 的配置、状态事务、原生历史、搜索 continuation、失效和验收关闭条件后实现。

- 147 tests 全部通过，其中 `tests/unit/routing.test.ts` 的 36 个具名用例覆盖 BR-01..BR-22 及额外边界；原始 58 ID 未删除。
- 路由测试含真实 openService 入口及 Codex/Pi 离线子进程、目录切换/重启续接、混合 backend、历史分页、快照恢复、无首答排队、取消、事务回滚和 profile 变化拒绝。
- 本机运行于 Darwin arm64；这是本机离线执行证据，不是全面 macOS 能力、OS 隔离或现场 Agent 验收。
- 本轮初次回归曾发现新锁路径遇到 macOS 临时目录符号链接，以及 legacy FIFO 范围扩大导致的失败；已规范化锁根、保留旧模式的会话内准备顺序，最终全量检查通过。未掩盖失败为通过，也未使用离线依赖替代安装。
- 未调用真实语义解释模型、未读取真实用户会话内容、未重启既有微信服务或改动私人配置。新路由生产使用需配置授权 roots/profiles；语义解释器需要 operator 提供实际 endpoint/model。
- 新增 native parser 仅以源代码格式和合成 JSONL 验证；已装 Codex/Pi 的真实历史版本兼容、口语分类准确性和微信新路由交付仍未验收。

## 此前观察到的真实链路（本轮未重查）

- 安装的 Codex CLI 0.155.1：显式 `--live` smoke exit 0，两轮问答通过，跨进程恢复上下文通过，会话引用一致。该结果来自此前执行，本轮未重复调用真实模型。
- 本机 Pi 源码版本 0.87.0、revision `95fbc04997eaee961eb673fa7923e9220609ebd5`：通过私有包装器启动 RPC，`get_state` 报告配置模型 `openai-codex / gpt-5.6-sol`、空闲状态。配置接入时 `npm run smoke:pi -- --live --config config.pi.local.json` exit 0，真实两轮问答、跨进程上下文恢复和相同会话引用通过；完成判定包含 `agent_settled`。模型名称是运行时配置报告，不是最终服务端模型路由证明。
- 本机 Pi 包装器在 macOS `sandbox-exec` 中运行，仅开放 read/grep/find/ls 工具，关闭扩展自动发现。真实非模型探针确认：工作目录和运行目录外写入被拒绝、微信认证文件读取被拒绝、本地端口监听被拒绝、私有临时目录可写。允许模型网络访问及 Pi 认证刷新/配置锁；这些有限检查不代表完整 OS 隔离、凭据隔离或外部副作用清理。包装器和本机路径保持私有，不属于仓库的可移植部署产物。
- `./start.sh --backend pi` 已停止原 Codex bridge 并启动 Pi 配置的微信接收循环，复用原 stateRoot 和登录，无需重新扫码。上一轮核查的运行实例使用 Pi 微信配置，本轮未查询或重启。
- 微信真实二维码接口返回成功，终端二维码实际渲染。用户已完成手机绑定，凭据复用成功。
- 认证后的 getupdates 响应实际省略 ret 和 errcode。适配器现接受省略或数值零，仍拒绝非零及非法类型；W13/W14 覆盖收消息、Agent 执行、回复 ACK 和游标持久化。
- 上一轮只读 SQLite 汇总显示 **Codex 3 个任务 succeeded、Pi 2 个任务 succeeded，共 5 条 outbox sent**；其中 Codex 1 个、Pi 2 个任务带图片。Pi 已观察到真实微信接收、模型执行及回复发送 ACK，轮询游标已持久化。此处只记录汇总，不包含账号 ID、消息、模型回答、图片、任务 ID 或数据库文件。
- outbox sent 表示 iLink 发送接口返回合法成功响应，不表示用户已经阅读，也不是对图片理解准确性的评价。

## 尚未验收的能力

- 实际语音是否附带转写以及转写质量；没有转写时未配置额外 ASR。
- 图片内容理解的人工准确性验收；目前有字节传输测试与现场带图任务成功记录。
- Pi 的图片理解准确性、真实取消和手机端实际显示尚未验收；已有带图任务成功及发送 ACK 记录，当前本地配置仅开放读取工具。
- 实际 Codex 沙箱强度、代码修改质量、真实模型取消后的所有外部副作用清理、脱离进程组的守护程序。
- 本次提交对应的 Linux/macOS CI 结果须以远端 workflow 为准；本地 macOS 测试不替代远端结果。

## 隐私与范围

本轮公开证据只保留经过路径脱敏的离线测试输出和上述汇总。真实 auth、context、cursor、会话内容、模型输出与本地配置保持在私有运行目录或 Git 忽略文件中。提交内容审查方法和历史边界见 [PRIVACY.md](PRIVACY.md)。
