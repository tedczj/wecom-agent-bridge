# 三层管理 runtime 兼容补丁

本机三层管理层现使用此独立兼容构建，并重新通过 `gpt-6-sol / high` 能力探测；有效窗口 828400。系统安装的业务 Codex 和认证文件未替换。当前证据见 [verification.md](verification.md)，下方构建过程和 medium 探测保留为历史记录。

## 来源和改动

- 上游：[OpenAI Codex `rust-v0.155.1`](https://github.com/openai/codex/tree/be2951ea34f0d295ed0becf97079f92fa5f6950e)，commit `be2951ea34f0d295ed0becf97079f92fa5f6950e`。
- 补丁：[codex-controller-0.155.1.patch](../patches/codex-controller-0.155.1.patch)。保留上游 [Apache-2.0 LICENSE](../patches/LICENSE.codex) 和 [NOTICE](../patches/NOTICE.codex)；本仓库原有 MIT LICENSE 保留。
- 增加默认关闭的 `features.bridge_controller_only`。启用后只注册调用者给出的 dynamic tools，不注册原生 shell、文件、MCP、插件、子 agent 等工具。
- 自动压缩的共同入口在此模式下返回 `BRIDGE_NATIVE_AUTO_COMPACTION_DISABLED`，不执行历史改写。达到原生压缩条件时请求可以失败，宿主不得自动重做业务。
- 每次提交模型请求前，通过现有 warning notification 输出 `BRIDGE_CONTROLLER_POLICY_V1` 诊断，包含本次实际工具集合和 turn ID。诊断不进入 user query。宿主比对当前角色的名称、schema 和 turn，普通日志只保留名称及 schema 哈希。
- 固定版本的 schema codec 会省略 `maxLength` / `minimum` / `maximum`；宿主仍完整验证这些约束，不能宣称模型侧 schema 保留了它们。

该补丁仍使用 Codex app-server stdio 和原有模型认证路径，不替换为其他 API 模型。它是自编译兼容候选，不是未修改的官方发布 binary。

## 构建与证据边界

源码与产物位于忽略的 `runtime/three-layer/`。使用 Rust 1.95.0、两路构建、关闭 debug 信息和 incremental；CLI `--version` 为 `codex-cli 0.155.1`。实际 binary SHA 为 `f2000d274535c5e44527c0aae9981582cb4c5a7dfd14ca2c70ba310392a85f59`。

release tag 的 Cargo.lock 中 152 个 workspace package 版本仍是 `0.0.0`，构建将其规范为 `0.155.1`；逐项核对未改变外部依赖。该生成差异不计入功能补丁。

| 检查 | 实际结果 |
|---|---|
| 新增 core 集成用例 | 2 passed，1783 未选；比对真实 mock HTTP 请求工具集合，并以模拟 usage 验证自动压缩拒绝 |
| core 集成全集 | 补齐测试程序后 1759 passed，26 skipped；第一轮 234 failed 保留，不能删除失败记录 |
| core / features 单元测试 | 2538 passed，含 1 项重试后通过的 shell snapshot flaky；首轮 schema fixture 失败后已重新生成并复测 |
| 完整 Rust workspace | 未通过：V8 sandbox 预编译依赖下载失败，不能算成完整上游回归 PASS |
| CLI 构建与格式化 | CLI build 成功；`just fmt` 成功；初次缺 uv/dotslash 的失败保留 |
| Clippy（core / features，含 tests） | `just fix -p codex-core -p codex-features --locked --offline` 完成；撤销无关上游 unused import 自动修改后，`just clippy` exit 0，仅保留该上游 warning |
| 完整跨平台测试 | 未完成；未宣称 Windows、Linux/Wine 远程执行或 OS 隔离验证 |

V8 v150.4.0 的公开 release 没有所需 macOS `ptrcomp_sandbox` archive，下载 URL 返回 404；没有改为关闭 V8 sandbox。core 回归所需 `codex-code-mode-host` 来自本机已安装的同版本 bundle，复制前后 SHA 均为 `59a702a68f1ef79fceaca644db46b8385ceefbb66035e78b8ade7cdcc21fda55`。它不是本次源码构建产物；没有复制认证。`test_stdio_server` 已从源码构建。

## 真实 M0

`compat-probe/2ca4cbad-db5a-4ead-99f6-ae6aff4e8370` 在此候选上通过实际 `gpt-6-sol / medium` 探测：create/resume、动态回调、实际工具集合、限制模式、图片、取消、进程组退出和 writer busy→idle 均通过。记录了 11 次受限工具集合诊断，仅含 `probe_read`。前两轮 runtime usage 为 696 / 753，有效窗口为 828400。

这证明当前候选的 M0，不替代三层 live 用例、完整上游回归或真实 1M/80% 长测。1M/80% 仍按用户要求暂缓。原装 binary 的旧未通过证明不被改成 PASS；新证明绑定本候选 SHA、配置和模型。

后续三层 live 首轮已进入真实业务，发现现有 exec 适配器把连接重试诊断误判为终态失败。该轮保留 FAIL；适配器修复后新的单次真实探针已成功，完整三层验收仍在进行。

完整 workspace 构建已经以 exit 101 自行失败，未被强制终止。为控制后续磁盘使用，仅删除了本轮 target 中 2052 个 `.rmeta` 编译缓存；保留 CLI、Code Mode sidecar、test_stdio_server，并核对前后 SHA 一致。删除前这些文件合计 allocated 约 2.5 GiB，但即时 `df` 未显示对应空间释放，不将该数字宣称为已释放容量。

随后又删除本轮生成的 2052 个 `.rlib` 静态编译缓存（删除前 allocated 约 5.9 GiB），再次验证三个保留程序 SHA 一致。即时可用空间仍约 3.7 GiB，观察到本机有 Time Machine 本地快照；未删除共享快照，也不声称这些缓存大小等于实际释放空间。新的定向 live 在每个 attempt 前检查 2 GiB 空间下限。之后观察到可用空间恢复到约 13 GiB，才继续执行限定 core/features 的静态检查。

Clippy 与格式化补充证据：`compat-clippy-fix-round2.txt`、`compat-clippy-final.txt`、`compat-fmt-after-clippy.txt`。第一次命令因 cargo 不在 PATH 以 exit 127 结束（`compat-clippy-fix.txt`），加入已有 Rust 工具路径后执行成功。自动修正只涉及上游原有 `core/tests/suite/openai_file_mcp.rs` 的 unused import，已撤销这项无关改动；只读 Clippy 完成并保留 warning，随后 `just fmt` 成功。前后原生源码 diff 字节相同，已发布补丁和原生 binary 的 SHA 均未变。静态检查不补足缺失的完整 workspace / 跨平台测试。

## 业务有效窗口与限定 Git 元数据写入

ModelProfile.contextWindowTokens 表示有效容量。原生 model_context_window 是总窗口；业务适配器现在从经原生 model/list 刷新的 metadata 读取有效比例和支持上限，用整数逆向换算。Sol/Luna 的当前95%及872000总上限得到828400有效容量；不硬编码该比例，不将配置数字冒充观测值。缺失/超限在业务 prompt 前拒绝，metadata阶段受取消和任务超时约束。短请求已验证正确有效容量，不构成1M/80%长测。

原生默认workspace-write保护.git。为满足授权目录内commit/push，hierarchical写执行使用固定的宿主权限profile：全局project roots为read，仅目标cwd为write，目标物理.git为write，.codex/.agents为read，网络按host配置，approval_policy仍never。只对本目录非符号链接的.git目录给予例外，外置gitdir不扩权。原生sandbox局部探针已观察到.git/工作文件可写、邻接目录及保护目录写入EPERM；实际 git-scoped-live 三轮原工作区 commit/local bare push 核心断言通过；后续 git-audited-live 三轮曾通过当时工具的补审；该解析审计工具现已移除，历史结果仅对应原候选，详情见三层实现状态。该证据不构成完整 OS 隔离证明。
