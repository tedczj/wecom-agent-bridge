# 当前验证记录

验证日期：2026-09-22。本文覆盖当前个人微信与本地入口版本；旧阶段的失败日志和报告由 Git 历史保留，不再作为当前说明叠加。

## 本次发布前检查

环境：macOS / Darwin arm64、Node v25.1.0、npm 11.6.2。

| 检查 | 结果 | 证据 |
|---|---|---|
| `npm ci --no-audit --no-fund` | exit 0，从当前 lockfile 安装 | [install.txt](evidence/install.txt) |
| `npm run check` | exit 0；类型检查、构建、109 tests；0 failed / cancelled / skipped | [check.txt](evidence/check.txt) |
| `npm run smoke:codex` 不带 `--live` | 预期 exit 1，LIVE_OPT_IN_REQUIRED；未调用模型 | [smoke-opt-in.txt](evidence/smoke-opt-in.txt) |
| `bash -n start.sh` | 通过 | 本地执行 |
| 构建/测试输入校验 | SHA-256 清单 | [source-manifest.sha256](source-manifest.sha256) |

测试日志来自本轮真实执行，已替换本机临时路径和进程 PID；测试结果、数量和耗时保留。默认用例全部使用合成数据和离线协议 doubles。用例范围见 [TEST_MATRIX.md](TEST_MATRIX.md)。

## 已观察到的真实链路

- 安装的 Codex CLI 0.155.1：显式 `--live` smoke exit 0，两轮问答通过，跨进程恢复上下文通过，会话引用一致。该结果来自本会话此前执行，发布前没有再次消费模型额度。
- 微信真实二维码接口返回成功，终端二维码实际渲染。用户已完成手机绑定，凭据复用成功。
- 认证后的 getupdates 响应实际省略 ret 和 errcode。适配器现接受省略或数值零，仍拒绝非零及非法类型；W13/W14 覆盖收消息、Agent 执行、回复 ACK 和游标持久化。
- 本次文档核查时，只读 SQLite 汇总显示 **3 个任务 succeeded、3 条 outbox sent，其中 1 个任务带图片**，轮询游标已持久化。此处只记录汇总，不包含账号 ID、消息、模型回答、图片、任务 ID 或数据库文件。
- outbox sent 表示 iLink 发送接口返回合法成功响应，不表示用户已经阅读，也不是对图片理解准确性的评价。

## 尚未验收的能力

- 实际语音是否附带转写以及转写质量；没有转写时未配置额外 ASR。
- 图片内容理解的人工准确性验收；目前有字节传输测试与现场带图任务成功记录。
- 实际 Codex 沙箱强度、代码修改质量、真实模型取消后的所有外部副作用清理、脱离进程组的守护程序。
- 本次提交对应的 Linux/macOS CI 结果须以远端 workflow 为准；本地 macOS 测试不替代远端结果。

## 隐私与范围

本轮公开证据只保留经过路径脱敏的离线测试输出和上述汇总。真实 auth、context、cursor、会话内容、模型输出与本地配置保持在私有运行目录或 Git 忽略文件中。提交内容审查方法和历史边界见 [PRIVACY.md](PRIVACY.md)。
