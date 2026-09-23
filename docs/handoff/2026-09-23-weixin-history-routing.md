# 微信历史读取与后续工作路由：交接

## 下一轮目标

继续排查并修复：微信查询 term4u 最新 session 进度后，后续“所有变更分批 commit，最后 push”在路由阶段被 `HISTORY_UNVERIFIED` 阻断，以及历史阅读直接返回自动续跑指令、缺少进度摘要的问题。本轮用户最后要求只把问题记录下来；没有执行或重放截图里的提交任务。

## 工作状态与已有产物

- 当前分支 `dev`。诊断功能提交 `085eb65e56d592d52b6a85f9cd2f8d40f9f9c362` 已 push 到 `origin/dev`：[提交](https://github.com/tedczj/wecom-agent-bridge/commit/085eb65e56d592d52b6a85f9cd2f8d40f9f9c362)。此提交提供诊断，尚未修复历史解析或路由交互。
- 命令用法、升级方式及边界见 [README](../../README.md) 的“微信远程诊断”；实现见 [debug.ts](../../src/debug.ts)、[history.ts](../../src/routing/history.ts)、[router.ts](../../src/routing/router.ts)、[bridge.ts](../../src/bridge.ts)。不在此重复实现。
- 安装、216 项检查及离线/真实验证边界见 [verification.md](../verification.md)；新增用例映射见 [TEST_MATRIX.md](../TEST_MATRIX.md)。设计、实现与隐私说明分别见 [DESIGN.md](../DESIGN.md)、[IMPLEMENTATION.md](../IMPLEMENTATION.md)、[PRIVACY.md](../PRIVACY.md)。
- 当前还有用户既有未跟踪文件 `docs/Routing Layer Architecture for wecom-agent-bridge.md`，本轮未修改、未提交。勿误纳入后续提交。

## 现场访问边界

截图来自远端，用户明确说远端无法连接。本地数据库没有命中截图任务，不能代表远端状态。后续通过用户在微信 ClawBot 执行 `/debug` 后粘贴报告取证；不要继续拿本地运行数据库推断远端故障。

用户已返回新版报告，`startupCheckout` 与上述提交一致。这仅证明报告所述启动时 checkout SHA，不证明构建产物、完整更新流程或模型服务端路由。没有远端 SSH 信息，也没有代发微信消息的通道。

## 新增现场证据（用户提供，未独立登录核验）

两次观察时间分别为 **2026-09-23T01:44:27.108Z** 和 **2026-09-23T01:45:19.287Z**；Node 24.15.0、backend codex。两次当前扫描结果相同：

| 范围 | 结果 |
|---|---|
| 当前工作目录 | 逻辑 ID `dir_2a270a575a25cb2bec56`，路径指纹 `35e86f706f771bd1`；实际路径未知 |
| 最近查询目录 | `term4u`，路径指纹 `e4e41d8aa5414628` |
| 当前目录历史 | native-index；partial=false；entries=3；HISTORY_FRAME_LIMIT=1 |
| 错误文件 | 指纹 `77f9c0684f3d7233`；两次均为 HISTORY_FRAME_LIMIT；无文件名或正文 |
| term4u 历史 | native-index；partial=true；entries=1；issues 为空。仅部分扫描，不等于全部历史正常 |

两个旧任务：

| 任务前缀 | 时间（UTC） | 持久化结果 |
|---|---|---|
| `3e9b5843` | 2026-09-23T00:35:47.016Z | 历史进度查询；kind=command，status=succeeded，started=false，reservedWorkspace=term4u，selection=control；2 段投递标记 sent |
| `b948fe8e` | 2026-09-23T00:37:47.422Z | 提交/推送请求；kind=command，status=failed，error=HISTORY_UNVERIFIED，started=false，reservedWorkspace=wecom-agent-bridge；1 段投递标记 sent |

两者均无 `routingAtRequest` 快照，因为发生在旧版本。不要把当前扫描当成当时快照；`sent` 也不是下游用户阅读证明。

原截图还显示：进度回复直接拼接多条 `assistant:` 历史，夹带英文 `No-progress check` 自动续跑指令。截图本身不存入仓库。

## 已确认与推断

已确认：

- 提交/推送请求没有启动工作 Agent；失败发生在路由阶段，不是 Git 操作失败。
- 当前执行目录与最近查询目录不同。查看/阅读历史不会切换目录或自动恢复会话，用户容易把“刚看过的 session”理解为后续任务目标。
- 当前目录存在稳定可复现的 HISTORY_FRAME_LIMIT。该版本限制单条 JSONL 记录为 8 MiB；限制在识别记录是否需要用于历史展示之前生效。
- 历史阅读使用消息预览直接拼接；没有进度总结层，对消息用途/自动注入内容的过滤不足。

高可信但尚未证实的因果链：后续无明确目录的提交请求仍落向原目录，扫描该目录历史时遇到超大记录，从而触发 HISTORY_UNVERIFIED。旧任务没有当时的目标/扫描快照，因此不能断言就是现在这个文件触发。

不得推断：

- `reservedWorkspace=wecom-agent-bridge` 是失败任务的兜底存储工作区，不能证明实际尝试扫描了它。
- 超大帧不等于损坏；可能含工具输出或图片数据，但未读到原记录，具体类型未知。
- partial=true 且 issues 为空不表示 term4u 历史无问题。

## 后续建议（尚未实施）

1. 审查超大 JSONL 记录处理：在有界内存/读取预算内区分无需展示的工具或图片记录与影响完成、所有权、会话状态的必要记录。不要简单提高上限、吞掉全部错误或把不完整历史当空历史后自动执行。
2. 必要时增强脱敏 debug：返回超限发生阶段、字节数量等结构化信息；仅在能安全验证时报告记录类型。不索取整份 rollout，不回传 token、媒体 URL/key 或正文。考虑只读诊断分页，以完成 term4u 当前 partial 扫描。
3. 改进历史阅读：区分实际用户消息、assistant commentary/final 和自动注入指令，给出清晰进度及当前执行目录；不要把旧会话中的计划说成正在运行的现场事实。
4. 后续任务指向刚查询项目时，明确解析目标或提出具体澄清。保留“只读查询不切目录”的契约，不以查看历史为由自动恢复/执行其他会话。
5. 新增合成回归：超大非对话帧、必要事件缺失/损坏、未完整扫描、查询另一项目后跟进工作、提示内容过滤。保留历史完整性、所有权、去重、FIFO、中断禁止自动重跑及未知送达规则。
6. 按 [AGENTS.md](../../AGENTS.md) 在 dev 工作，执行 npm ci / npm run check，更新权威文档与证据。之后若发布新版，用户可在微信 `/update` → 下一条 `/approve` → 等最终回执 → `/debug`；不要代发或重放旧的 commit/push 请求。

## Suggested skills

- `handoff`：需要续写交接时调用 Skill 工具；入口为本次用户提供的 handoff skill。
- 本问题核心为本仓库 TypeScript 路由/历史解析，不强制依赖额外技能。
- `openai-docs`：若后续需要核查 Codex 官方事件格式/产品行为，调用该技能；先查本地实现或来源，再按技能要求查官方资料。
- 不默认调用 `connect-env` 或 `file-helper-log-debugger`：本次不是已知 Blueberry 环境事故，且远端不可连接。只有用户后续提供匹配环境和访问条件时再考虑。
