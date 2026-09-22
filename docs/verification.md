# 当前验证记录

验证日期：2026-09-22。本文覆盖当前个人微信与本地入口版本；旧阶段的失败日志和报告由 Git 历史保留，不再作为当前说明叠加。

## 当前本地检查

环境：macOS / Darwin arm64、Node v25.1.0、npm 11.6.2。

| 检查 | 结果 | 证据 |
|---|---|---|
| `npm ci --no-audit --no-fund` | exit 0，从当前 lockfile 安装 | [install.txt](evidence/install.txt) |
| `npm run check` | exit 0；类型检查、构建、159 tests；0 failed / cancelled / skipped | [check.txt](evidence/check.txt) |
| `npm run smoke:routing` 不带 `--live` | exit 1，LIVE_OPT_IN_REQUIRED；未调用模型 | [routing-opt-in.txt](evidence/routing-opt-in.txt) |
| `npm run smoke:routing -- --live --config FILE` | exit 0；真实分类与只读历史，未调用 worker/发送微信 | [routing-live.txt](evidence/routing-live.txt) |
| `bash -n start.sh` | 通过 | 本地执行 |
| 构建/测试输入校验 | SHA-256 清单 | [source-manifest.sha256](source-manifest.sha256) |

测试日志来自本轮真实执行，已替换本机临时路径和进程 PID；测试结果、数量和耗时保留。默认用例全部使用合成数据和离线协议 doubles。用例范围见 [TEST_MATRIX.md](TEST_MATRIX.md)。

## 本轮目录路由验收

修复基线 `ef9c0f9`。现场失败任务在路由阶段报 HISTORY_FORMAT，尚未启动 worker：全库扫描遇到一份已知旧版无 cwd 的 Codex header；规则解析也未把自然语言 session 进度请求识别为历史查询。

- 159 tests 全部通过，其中 `tests/unit/routing.test.ts` 的 48 个用例覆盖原 BR-01..BR-22 及 H01–H07、I01–I05；原始 58 ID 未删除。
- 修复包含 native SQLite cwd 定位、先验证 header scope 再解析正文、流式读取大历史、活动历史可读不可恢复、坏文件的不完整提示，以及 Agent 优先分类、固定 CLI 参数、工具事件拒绝、模型失败不转 worker、关闭时取消分类器。
- 本轮最初回归暴露旧测试对 HISTORY_FORMAT 的断言需更新为 HISTORY_UNVERIFIED，以及配置解析器无法二次接受默认空 description；已修正并通过最终全量检查。依赖从 lockfile 安装，未使用离线替代依赖。
- 本机运行于 Darwin arm64；离线 doubles 仍不代表全面 macOS 能力、OS 隔离或真实工作 Agent 验收。

## 本轮真实路由 Agent 与 native history 验证

- 已安装 Codex CLI 0.155.1，使用原有登录、独立路由 cwd、read-only、ephemeral、忽略用户配置及规则、固定 JSON schema。没有新增 API key，也没有把认证内容复制到仓库。
- 私有配置指定 provider=codex、model=gpt-5.6-terra、reasoning=high；模型名与 reasoning 是请求配置，不是最终服务端路由证明。
- 显式 --live 验证了现场问题表达，以及公开 smoke 中的等价合成查询。两次均通过完整 exec thread/turn/final/exit/cleanup 条件，并被验证为 OCR 历史查询而非执行/切目录。
- 修复后的只读 native parser 从实际 Codex 索引定位并读取 OCR 项目 **7 个会话，1 个活动会话，0 个解析问题，1 页完成**。记录只公开数量和状态，不公开原文、标题、预览、session ID 或路径。
- 验证过程未调用下游 worker、未发送微信消息，未重放已失败任务。其他三个工作目录的模型 profile 保持既有配置；修复后微信端实际展示仍需以用户消息结果为准。
- 该有限样本不证明普遍语义准确率、全部 native 格式或外部副作用隔离。真实源码/已安装格式与此次读取已验证；完整新版微信问答交付没有冒称通过。

## 此前观察到的真实链路（本轮未重查）

- 安装的 Codex CLI 0.155.1：显式 `--live` smoke exit 0，两轮问答通过，跨进程恢复上下文通过，会话引用一致。该工作 Agent 两轮 smoke 来自此前执行；本轮真实调用仅验证路由 Agent。
- 本机 Pi 源码版本 0.87.0、revision `95fbc04997eaee961eb673fa7923e9220609ebd5`：通过私有包装器启动 RPC，`get_state` 报告配置模型 `openai-codex / gpt-5.6-sol`、空闲状态。配置接入时 `npm run smoke:pi -- --live --config config.pi.local.json` exit 0，真实两轮问答、跨进程上下文恢复和相同会话引用通过；完成判定包含 `agent_settled`。模型名称是运行时配置报告，不是最终服务端模型路由证明。
- 本机 Pi 包装器在 macOS `sandbox-exec` 中运行，仅开放 read/grep/find/ls 工具，关闭扩展自动发现。真实非模型探针确认：工作目录和运行目录外写入被拒绝、微信认证文件读取被拒绝、本地端口监听被拒绝、私有临时目录可写。允许模型网络访问及 Pi 认证刷新/配置锁；这些有限检查不代表完整 OS 隔离、凭据隔离或外部副作用清理。包装器和本机路径保持私有，不属于仓库的可移植部署产物。
- `./start.sh --backend pi` 已停止原 Codex bridge 并启动 Pi 配置的微信接收循环，复用原 stateRoot 和登录，无需重新扫码。这是历史记录；当前实例在后续操作中已切到 Codex。本次修复按用户要求在推送后重启，启动结果需以现场检查为准。
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
