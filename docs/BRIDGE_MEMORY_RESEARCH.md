# Bridge memory：上游实现调研

日期：2026-09-22。状态：一手文档与选定源码的静态核查；不是完整仓库审计、集成测试或安全证明。

阅读顺序：[已确认的目录与会话规则](BRIDGE_ROUTING_SESSION_RULES.md) → 本文 → [bridge memory 目标设计](BRIDGE_MEMORY_DESIGN.md)。规则文档是产品行为契约；上游能力不能覆盖该契约。现有实现仍以 `DESIGN.md` 为准。

## 1. 核查范围与版本

| 项目 | 本次固定的源码 revision | 关注部分 |
|---|---|---|
| NousResearch/hermes-agent | `2c65d5aee60d0a4e2eadc34c319ca3daac203667` | 有界常驻记忆、CRUD、并发写、历史搜索 |
| openclaw/openclaw | `f9c524daa03e5febd2bc3fb01c6f3cb7387798bd` | 分层、来源、晋升、更新、遗忘、混合搜索 |
| deepseek-ai/deepseek-harness | `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61` | 原始 session、派生投影与全文索引、查询授权 |
| HKUDS/nanobot | `920efd00b86bec09f634a9b010c4aeeaca550ba6` | Consolidator / Dream、增量游标、可追踪修改 |
| nanocoai/nanoclaw | `7902716b5b930215dbee4f56b8fb5b938d40468d` | 索引与主题文件、渐进加载、agent-group scope |

本次引用的是上述 main/master 快照，不是承诺部署版本已包含这些机制。官网页是 2026-09-22 获取的补充说明，可能继续变化。没有将旧博客介绍、搜索摘要或社区插件介绍当成当前主库已实现能力。

## 2. 对比结论

| 项目 | 生成 | 更新 / 删除 | 搜索 | 分层 |
|---|---|---|---|---|
| Hermes | agent 调用 memory 工具保存；按 profile 持久化 | add / replace / remove / batch；锁内重读、容量限制、漂移检测；后台破坏性整理单独审批 | 核心记忆直接入上下文；历史 session_search 查 SQLite FTS5 | MEMORY.md + USER.md 小核心，历史会话按需 |
| OpenClaw memory-core | 工作笔记、compaction 前 flush、session ingestion；经过来源与候选门槛再整理 | merge / supersede / 去重；版本前像、原子发布；forget 追踪来源并阻止重新摄入 | memory_search 混合检索、memory_get 精读；历史 session 工具另有范围 | 指令、核心、事件、前瞻意图、审阅面分开 |
| DeepSeek Harness 已核查模块 | 原始事件持久化；派生标题、投影与索引 | 根据 source revision 更新投影/索引；原文与索引分离；源删除可触发索引对账 | session / event FTS5，精确读取、关联追踪、分页 | 原始日志、派生投影、派生检索库；不等同于用户长期事实 CRUD |
| nanobot | 历史压缩入 history.jsonl，Dream 增量整理长期文件 | 受限文件工具精细修改；GitStore 记录与恢复版本 | 历史 JSONL 及文件读取/文本搜索；不是所核查模块中的统一向量库 | 活跃消息、压缩历史、长期文件、变更历史 |
| NanoClaw | agent 自行通过普通文件工具维护 memory 树 | 编辑/删除文件；启动 scaffold 只补缺失文件 | 核心索引指向主题，按需读取 | index/core + 链接主题；按 agent group 持久化 |

表中的“删除”有不同含义：删除当前条目、屏蔽未来召回、清理派生索引、删除原始 session、销毁备份不是同一操作。

## 3. Hermes：小型核心记忆 + 按需查历史

### 3.1 实际结构和生命周期

`MEMORY.md` 保存环境、项目和经验，默认上限 2200 字符；`USER.md` 保存用户偏好，默认 1375 字符，均属于 Hermes profile。当前文档和实现采用 session 开始时的 frozen snapshot：本轮写磁盘立即生效，工具结果能看到新状态，但原来的系统提示词快照不在会话中途重建。[H1][H2][H3]

工具提供 `add`、`replace`、`remove` 与 `operations` 批量操作。`old_text` 用于找到唯一条目；`replace` 替换整条记录，不是替换某个字符串片段。当前实现优先整个条目的精确匹配，然后才考虑唯一子串，匹配歧义报错。批处理强调整体成功或不修改。[H2][H3]

内存不足不会静默删除条目，而是返回容量错误，让模型合并/删除后重试。代码还有每轮整理失败次数限制，防止 memory 重试耗尽整轮而不回复用户。[H1][H3]

### 3.2 写入与删除的关键细节

`MemoryStore._mutate` 在独立文件锁内重新读取磁盘，再应用变更。已有文件暂时不可读不能当成空文件；外部编辑造成无法 round-trip 的漂移会拒绝写并提供恢复线索，避免覆盖丢失。锁文件使用权限收紧及可用平台下的 no-follow；最终由原子写函数保存。[H3]

`_background_delete_gate` 对无人值守 review 中的 replace/remove 提案采用暂存审批，而不是直接破坏性执行。一般写审批还有单独开关和不同失败语义，不能把某个 gate 概括成整个系统都 fail-closed。[H2]

### 3.3 对 bridge 的迁移判断

采用：核心记忆小而有界、历史分开搜索、失败不无限重试、提交成功才说“记住了”、写时重读/版本检查。

不照搬：自由文本子串定位、以 session 边界作为唯一核心刷新时机。bridge 的对话可能长时间持续，用户纠正简称必须在当前处理流程和下一轮立即生效。也不以 threat-pattern 正则扫描代替来源、工具权限和 OS 隔离。

## 4. OpenClaw：值得借鉴的是晋升与遗忘治理

### 4.1 分层和生成

官方 memory architecture 区分 human-owned instructions、curated core、episodic notes/transcripts、prospective intents 和 review surfaces。日常笔记与 compaction 前 flush 先形成事件层素材，再经过来源与其他确定门槛、受限模型整理进入长期核心。当前设计支持长会话逐轮刷新符合条件且有预算的核心，不必等用户重新开会话。[O1]

来源不是由正文声明：存储层维护 origin class、session kind、时间及 supersession 等信息。召回的旧记忆不能重新算作新证据；定时任务、heartbeat、子 agent 等来源与普通用户交互区分。官方也明确其污点传播依赖工具声明，local file 等覆盖仍有边界，不能声称根治 prompt injection。[O1]

### 4.2 更新

选定源码 `short-term-promotion-apply.ts` 可以看到来源资格检查、daily-file quarantine、候选内容指纹、真实 source 文件指纹、工作区锁和带预算的输出构造；写入/冲突处理与 consolidation 分离。文档进一步描述 hash 检查、原子替换、前像与审阅记录。[O1][O2]

注意：Markdown 文件和可能不遵守同一锁的外部编辑器之间仍有竞争边界。本 bridge 可以用已有 SQLite 事务和 expected_version 做更明确的内部写一致性，不必照搬多文件原子性难题。

### 4.3 删除与重新摄入

`memory forget` 使用 session→entry 来源关系清理可追踪派生物，并记录已遗忘 source session，防止下次 backfill / ingestion 重新产生。同一记录合并了多个来源时，删除某个来源可能移除整条混合记录；它不试图用模型从一句融合文本中精确减掉某个人的贡献。[O3]

该功能不是全域擦除：原始 transcripts、无血缘的手工/旧记录、外部副本等有明确剩余范围。失败可能部分清理，报告与重试很重要；来源证据要保留到依赖清理完成。[O3]

### 4.4 搜索

官方 memory-search 文档区分语义与词法召回，并包含 filename/path 线索；还可用时间、多样性等排序。检索范围和生命周期仍独立于向量相似度。精读工具及 session 工具有不同的数据边界，不能用一个任意文件读取接口绕过 session 授权。[O4]

对 bridge：借鉴来源、候选/正式记忆、增量合并、禁止自我强化、遗忘后阻断再生成；不引入完整 Light/REM/Deep 调度、前瞻任务系统或额外 recall 子 agent。已确认别名不应仅因为少用而衰减失效。

## 5. DeepSeek Harness：持久历史与派生索引的工程边界

### 5.1 已核查的核心能力

session group 明确分出持久化、投影、标题、遥测等模块。标题可以有确定性 fallback 与可选 LLM provider；这些都不是“把所有历史变成用户长期记忆”。[D1]

`session-query-sqlite` 的 FTS 数据库是独立、可重建的 derived index，不能指向 canonical session 数据库。每次稳定观察比较 source revision，处理新增、变更、删除；live 状态可覆盖持久化底表。reconciliation 使用序列化状态机与事务，错误不提交半成品。[D2]

搜索分页 cursor 绑定请求和相关 corpus generation，数据变化导致过期报错，而不是默默让“下一页”变成别的记录。query 文本按字面 phrase 处理，metadata 过滤在排名前进行。默认 `unicode61` 是 token/phrase，不是任意子串；另有 filterEvents 的文本扫描路径。[D2]

### 5.2 查询授权

底层 `ctx.sessionQuery` 是可信上下文内服务，不负责通用调用方授权。模型工具层注册 `session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_event_read`，描述与 operations 层负责 workspace 可见性边界。不能直接把底层数据库接口开放给微信用户。[D2][D3]

### 5.3 边界结论

本次没有把社区介绍中的 agent-memory / Memory Body 等插件算成 DeepSeek Harness 核心已有的长期记忆 CRUD。部分相关插件仓库未能读取，因此没有以其实现作为推荐依据。已核实且推荐迁移的是：原始历史与索引分离、事件/source revision、精读追踪、过期 cursor、工具层授权。

## 6. nanobot：把压缩历史和长期事实整理拆开

当前版本不是仅有 MEMORY.md/HISTORY.md 的旧简化形态。Consolidator 将较老对话生成 archive/checkpoint，`history.jsonl` 使用增量 cursor；Dream 读取未处理部分和已有长期文件，定向修改 `SOUL.md`、`USER.md`、`memory/MEMORY.md`，通过 GitStore 查看和恢复变化。[B1][B2]

代码里 `build_dream_prompt` 无新增历史时不运行；`compact_history` 不丢弃尚未被 Dream 消费的条目；`build_dream_tools` 只注册受限读取、编辑、patch 和写入能力；`dream_run_completed` 检查实际正常终态。这些比“一到定时器就重写整个记忆文件”更适合参考。[B2]

一个容易误读的范围：这里持久 memory 属于 configured agent workspace。WebUI 切换正在工作的代码项目，不会把 agent 的 USER/MEMORY 目录搬到代码项目里。[B1]

对 bridge：采用增量消费游标、无新证据不整理、受限 writer、可追踪修订；但不允许 bridge 整理器改写自身规则/人格文件。用 SQLite 修订表而非必须在运行时记忆目录启 Git；删除后不应仍宣称 Git 历史也被擦除。

## 7. NanoClaw：小索引 + 大主题库

其 memory 子系统是 agent-group 级 Markdown 树，容器中位于 `/workspace/agent/memory`。`index.md` 包含核心和索引，`system/definition.md` 说明记忆行为；其他主题通过链接按需读。scaffold 只创建缺失项，不覆盖已有记忆。[N1]

`renderMemorySection` 在 agent 容器内读取两份核心文件，每份 16000 字符预算，并给出截断提示；宿主 composer 不读取 agent 可写 memory。startup/clear/compaction 的新上下文 hook 会加载；resume 原上下文不重复注入。错记通过普通文件编辑/删除修正，OKF 元信息是约定而非强制数据库 schema。[N1][N2]

对 bridge：采用“索引小、详细内容按需展开”和 scope 与 worker 隔离。不要直接让拥有跨目录路由权的 bridge 从 worker 可改的核心文件加载控制指令；也不要把普通文件删除描述为跨历史、缓存、备份的完整遗忘。

## 8. 最终取舍

采用组合而非整库接入：

- Hermes：小核心 + 按需会话搜索，受控写入与失败预算。
- OpenClaw：来源、晋升、纠正替代、遗忘防复活。
- DeepSeek Harness：原始历史 / 状态 / 派生索引分开，强制工具 scope。
- nanobot：增量整理、游标、版本与受限写者。
- NanoClaw：目录索引与主题明细分层，避免全部塞进 prompt。

bridge 第一期不需要通用知识图谱、独立向量数据库、自动编写 skills 或多阶段 Dream。它需要可靠记住“用户怎么称呼目录”和少量历史定位线索；代码细节继续由对应 Codex/Pi session 维护。

## 9. 一手来源与具体入口

以下源码链接固定到本次 revision，文档站链接标注为在线文档。

[H1]: https://github.com/NousResearch/hermes-agent/blob/2c65d5aee60d0a4e2eadc34c319ca3daac203667/website/docs/user-guide/features/memory.md
[H2]: https://github.com/NousResearch/hermes-agent/blob/2c65d5aee60d0a4e2eadc34c319ca3daac203667/tools/memory_tool.py
[H3]: https://github.com/NousResearch/hermes-agent/blob/2c65d5aee60d0a4e2eadc34c319ca3daac203667/tools/memory_tool_store.py
[O1]: https://github.com/openclaw/openclaw/blob/f9c524daa03e5febd2bc3fb01c6f3cb7387798bd/docs/concepts/memory-architecture.md
[O2]: https://github.com/openclaw/openclaw/blob/f9c524daa03e5febd2bc3fb01c6f3cb7387798bd/extensions/memory-core/src/short-term-promotion-apply.ts
[O3]: https://github.com/openclaw/openclaw/blob/f9c524daa03e5febd2bc3fb01c6f3cb7387798bd/docs/concepts/memory-provenance.md
[O4]: https://docs.openclaw.ai/concepts/memory-search
[D1]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/session/README.md
[D2]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/session-query/session-query-sqlite/README.md
[D3]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/session-query/tool-session-query/src/index.ts
[B1]: https://github.com/HKUDS/nanobot/blob/920efd00b86bec09f634a9b010c4aeeaca550ba6/docs/memory.md
[B2]: https://github.com/HKUDS/nanobot/blob/920efd00b86bec09f634a9b010c4aeeaca550ba6/nanobot/agent/memory.py
[N1]: https://github.com/nanocoai/nanoclaw/blob/7902716b5b930215dbee4f56b8fb5b938d40468d/docs/memory.md
[N2]: https://github.com/nanocoai/nanoclaw/blob/7902716b5b930215dbee4f56b8fb5b938d40468d/container/agent-runner/src/memory/context.ts

后续要复制源码时仍须检查对应 LICENSE、依赖和目标版本；本文没有复制或引入上游运行时。
