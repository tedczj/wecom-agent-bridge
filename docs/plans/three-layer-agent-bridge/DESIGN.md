# 微信三层 Agent Bridge：完整实施设计

版本：1.0 · 日期：2026-09-23  
目标仓库：`tedczj/wecom-agent-bridge`，施工分支：`dev`  
代码审查基线：`e7d7328c13b33f8e5feab4c1691350ed21dab2d2`  
状态：**待实施的目标设计，不是已完成功能或已通过的 live 验收报告。**

本文件是唯一架构规范；`LIVE_LLM_CASES.md` 是它的验收附录，`live-cases.json` 是同一批用例的机器可读定义。示例配置和新增 npm 命令均需按施工计划实现后才能使用。本文不授权对真实项目自动 commit/push，不重放 handoff 中失败的任务。

## 0. 已冻结的产品规则

| ID | 不得在实现时自行变更的规则 |
|---|---|
| F01 | 三层：Bridge Agent 找目录；每目录一个 Route Agent 管理业务 session；业务 Agent 在所选 session 中实际工作。Route Agent 与之前称呼的 Session Agent 是同一角色。 |
| F02 | daily 是日常/兜底模型配置，目标为 1M 上下文、high reasoning。Bridge 与 Route 使用相同模型配置。模型 ID 由真实运行环境验证，不把显示名称当 API 能力证明。 |
| F03 | Route session 按可信 conversation scope + 规范目录身份独立，首次使用惰性创建，不预启动所有目录进程。 |
| F04 | **上下文换代阈值固定为 80%，不估计下一条输入、工具结果、回答或未来 reasoning token。** |
| F05 | 在安全轮次边界依据已观测 usage 判断；达到 80% 新建管理 session 并交接，不改绑业务 session。Bridge 自身采用同样规则。 |
| F06 | **原始 userQuery 透传。**不摘要、不改写、不补全指代、不添加 `routingContext`、不拼历史答案，不为业务 session 重建上轮上下文。 |
| F07 | 下游工具不接受让模型重写 query 的参数；宿主用绑定的 requestId 读取原始输入再提交。目录、session、模型、附件引用是独立调用参数。 |
| F08 | 当前目录保持；明确/可唯一解析的目录指定才更新执行目标。跨目录只读查询不自动改执行目录。真正有歧义才澄清，不要求用户精确输入路径或 UUID。 |
| F09 | 业务 session：明确新建优先；明确恢复可超 24h；否则该目录已有绑定优先，无绑定才发现原生历史；自动复用依据最近完整有效业务回复，恰好 24h 可复用。 |
| F10 | Route 换代、历史读取、recap、消息投递都不刷新业务最近完整回复时间。 |
| F11 | 每轮最终答案原件原样保存；短答案原样成为短记录；长答案由独立 Recap Service 概括。 |
| F12 | Bridge **模型**不能读取长答案原件；Bridge **程序/投递模块**可以读取并发送。权限在工具和数据投影边界强制执行。 |
| F13 | Route 默认看 query + 短记录，可按需查看目录/章节/原文范围；可按本目录筛选，或查看同一可信对话最近 30 轮交互。 |
| F14 | 业务 session 保留自身原生上下文；不能为了“继续”偷偷注入上游 recap。新 session 缺上下文时，不伪装成续接。 |
| F15 | session 关系、权限、配置、去重、FIFO、运行状态、完成判定、归档与投递由程序负责，LLM 只理解意图并提出受控选择。 |
| F16 | 管理 Agent 不能执行 shell、改代码、任意读文件、修改授权；业务 Agent 只能使用原有明确配置的权限。 |
| F17 | 已执行或可能已执行的业务任务不自动重跑；摘要失败、投递失败、管理 session 换代不能重跑业务。 |
| F18 | 原生历史定位、阅读、恢复校验分离；无关旧历史异常不污染已有精确绑定；候选集合未知不等于无历史。 |

非目标：企微适配、群聊接管、新 HTTP/WebSocket 服务、多机调度、自动跨目录拆任务、跨 backend 上下文迁移、取消后的自动重做、全面替换 Codex/Pi 原生 runtime。首版保留单业务 worker。

## 1. 基线问题与必须修改的现有位置

以下是基线源码事实，来源见文末 R01–R09。

| 现有位置 | 已确认现状 | 目标改变 |
|---|---|---|
| `src/routing/codex-interpreter.ts` | ephemeral 分类器，没有持久管理会话；受控 inspect 工具由宿主解释 | 替换为持久 Bridge/Route ControllerRuntime；legacy 模式迁移期保留但不混用 |
| `src/routing/router.ts` | 一个类同时决定目录、发现、阅读、校验和业务 session；`read` 拼 preview | 分拆 orchestration、registry、native catalog、reader、verifier |
| `src/routing/history.ts` | 查索引后仍读取目录内多份正文；单行 8 MiB 限制先于消息用途识别 | 元数据清单与准确目标的正文读取分离；有界投影和候选级错误 |
| `src/bridge.ts` | `contextTaskIds` 会把历史 query/reply 拼到业务 `input.text` | hierarchical 模式删除这个路径，非空旧字段明确报契约冲突，不静默执行 |
| `src/local.ts` | `.trim()` 改变文本；图片无文字时自动生成提示 | 新模式保存未经 trim 的解码文本；trim 只用于空值/命令识别；媒体纯输入不得伪造用户文字 |
| `src/store.ts` | 路由后才 reserve；`recent()` 读完整 `result_text`；`complete()` 先 boundedResult | 原始 request 在 LLM 前落库去重；Bridge 只查询安全 projection；raw final 在任何显示包装/裁剪之前归档 |
| `src/codex.ts` | 正确保留原生 thread id；执行与清理有严格完成条件 | 保留业务执行协议，增加 final 原件 sink/元数据，不将管理 Agent 硬塞进业务 backend |
| `scripts/smoke-planner.ts` | 有真实模型 opt-in，但含跨 session 自动补入历史图片/文本的用例 | 拆成新 live runner；不保留与 F06/F14 冲突的旧预期，旧验收编号保留并解释替代映射 |

特别注意：新增 Route session 若与业务 session 共用 cwd/source，不区分角色就可能被选成“最近业务 session”。必须建立 role registry，不能靠标题过滤。

## 2. 确定采用的架构

```text
Weixin / Local JSONL
  → 原始 Request Store（接收、输入校验、去重、顺序号）
  → Bridge Controller（持久管理 session）
      → directory tools / alias memory / 安全 interaction projection
      → route_delegate(directoryRef)
          → Route Controller（该目录的持久管理 session）
              → session catalog / exact reader / answer progressive read
              → business_execute(sessionSelection)
                  → 业务 FIFO Worker + 原有 workspace mutex
                  → Codex exec 或 Pi RPC / 原生业务 session
                  → 原始 final sink
                  → Artifact Store + Recap Service
              ← JobResultEnvelope（状态、业务 ref、answerRef、短记录）
      ← 同一个 JobResultEnvelope，永不含长原件
  → Delivery 程序按 answerRef 发送原件；不让 Bridge 模型复述
```

三层是三种角色，不是三个必须同时占 CPU 的轮询进程。父层等待子任务时只保持异步等待，不占业务 worker 或 workspace 锁。管理层可以按 actor 串行；业务 worker 独立运行。`/cancel`、`/status`、`/debug` 等程序控制命令不等待管理 LLM。

### 2.1 首版运行路径

**管理层采用新增的 Codex app-server stdio ControllerRuntime，业务层继续使用当前 Codex exec / Pi RPC。**不引入 OpenClaw/Hermes/DeepSeek 全框架依赖，不把宿主程序注册为任意 shell 工具。

采用 app-server 的理由是它提供持久 thread、工具请求回调、运行事件和 usage 事件。这里是明确的实现选择，不声称当前仓库已有该适配器。工具注入和部分历史分页接口仍有实验性/版本差异，必须通过 M0 能力门禁，固定可工作的 installed binary 版本和 schema。[R10–R12]

`ControllerRuntime` 必须实现：`create/resume/run/getUsage/interrupt/close`；`BusinessRuntime` 保留现有 `AgentBackend.run`。两者不能共享 `maxConcurrent=1` 的同一执行槽位。

管理 thread 的配置：专用空工作目录、忽略项目规则/用户自定义工具、关闭 shell/文件修改/图像文件查看/网页/插件/MCP/原生多 agent；只暴露宿主登记的工具。使用经版本能力探测确认的配置入口，不将 `codex exec` 的 CLI 参数直接套到 app-server。仅在事件到达后拒绝 shell 不足以证明未执行；**M0 必须验证生成给模型的工具面已受限**，不满足即禁用 hierarchical 模式，不能靠 prompt 声称隔离成功。

管理历史与业务历史可用独立受控存储，也可在同一登录 home 中靠受控 role registry 隔离；不得自动拷贝用户凭据。首版要求所有本服务创建的管理 thread 在首次 prompt 前登记 role，并在业务候选查询中排除；独立工作目录作为第二层隔离。没有假定 cwd 本身就是 OS 沙箱。

### 2.2 借鉴关系

| 参照 | 本设计采用的边界 | 不照搬 |
|---|---|---|
| OpenClaw | 路由身份与 history 工具分离；列表元数据与正文 enrichment 分离；受限历史视图 | 整套 channel/multi-agent 框架 |
| Hermes Agent | 逻辑聊天会话与原生业务线程分开持久化 | 业务恢复失败后自动另起并继续、崩溃自动续跑策略 |
| DeepSeek Harness | 精确读取、来源/用途分类、日志视图与执行恢复区分 | 它的完整事件格式、运行时和存储引擎 |

## 3. 配置与模型解析

配套 `config.hierarchical.example.json` 是新字段目标样例，M1 实现前旧 parser 应拒绝，不能把“JSON 合法”称为应用配置已经可用。

模型配置单独描述 provider/model/reasoning/context；执行 profile 单独描述 backend、登录 home、沙箱和工具权限。

```text
管理模型：bridge.modelProfile = daily
          route.modelProfile = bridge.modelProfile（首版必须相同）

业务模型：本次明确指定
          > 业务 session 的显式覆盖
          > 目录显式模型
          > daily
```

每个配置值保存 `source=request|session-explicit|directory|daily`。旧的 daily 派生值不能自动升级为 session-explicit。未指定才使用兜底；模型不存在、认证失败、能力不足不能静默换其他模型。业务模型覆盖不得影响管理模型。

daily 配置示例采用仓库现有示例 ID `gpt-5.6-terra`、reasoning `high`、`contextWindowTokens=1000000`。这只是配置目标，不代表本次验证了模型存在、实际服务端路由或 1M 能力。启动/验收分别记录 requested、runtime-observed、provider-observed；不能用模型自己声称的名字代替观察。

修改 backend/model/reasoning/权限/home 后计算 profile digest。首版沿用保守兼容策略：业务完整配置 digest 变化时新建，不把另一个 profile 的历史作为原 session 静默 resume；管理模型配置变化时交接到新管理 generation，原因记为 `config_changed`，不伪称达到 80%。

## 4. 原始输入契约：模型不能重写转发文本

### 4.1 不变对象

```ts
interface OriginalRequest {
  requestId: string;
  channelMessageId: string;
  conversationScope: string;  // 仅 transport/auth 派生
  ingressSeq: number;
  rawQuery: string;          // JSON/平台字段解码后的原文，含换行和首尾空白
  rawQuerySha256: string;    // UTF-8 bytes hash，不做 Unicode normalization
  attachments: readonly ImageRef[];
  receivedAt: number;        // UTC milliseconds
}
```

语音输入的 rawQuery 是渠道已经提供的语音转文字结果；不新增 ASR。媒体引用保留 hash、MIME、身份与受控路径；不把渠道 token/媒体 URL/key 发给 Agent。

命令识别可以使用 `rawQuery.trim()` 的临时副本，但不可覆盖原字段。空文本 + 有图允许作为媒体消息；backend 不支持空文本图像输入时明确拒绝，不伪造“请分析这张图片”。

### 4.2 受控委托

```ts
// 工具 schema 中没有 query/prompt/text/context/history 参数。
route_delegate({ directoryRef, intentKind })
business_execute({ selectionToken })
```

宿主把当前调用的 requestId、scope、controller generation 隐式绑定在工具 handler 中，不信任模型传入的 requestId/scope。handler 从 Request Store 取 rawQuery 传给下一层。用 `additionalProperties:false` 拒绝 `rewrittenQuery` 等附加字段。

普通业务提交必须满足：

```text
hash(Weixin/Local decoded rawQuery)
 = hash(Bridge 当前用户输入文本)
 = hash(Route 当前用户输入文本)
 = hash(业务 adapter 提交文本)
```

静态角色/工具说明属于独立 system/developer 配置；不能把它们拼进 query。既有原生业务 session 的历史不变，上游 recap 不进入其请求。

控制回复续办原请求有两类：目录授权的 `/approve`，以及对明确待澄清目标的“选 term4u / 就是第二个”等纯选择回复。两者都通过 `sourceRequestId` 精确引用**尚未提交业务**的原始工作请求，提交其未改写原文；控制回复单独保存为授权/目标选择证据。hash 对比的源是 `sourceRequestId`，不是“同意/第二个”本身。

续办必须满足同一可信 scope、同一个未执行的待处理请求、未过期的15分钟快照、目标/配置复核，以及当前明确的控制回复；重复回复不能再提交。失败或已执行的旧任务不属于待澄清续办对象，不能借此重放。用户回复同时增加新任务或更改业务限制时，不把两条消息拼成新 prompt；按新的原始工作消息处理，必要时要求完整表达。控制选择只补齐调用参数，不补齐业务文本。

### 4.3 无上下文不做隐式修补

业务 session 正确且仍有上下文时，“继续”“按第二个方案”“提交这些改动”直接透传。管理层只负责选对 session。若用户所指的是 Route 自己新提出、但业务 session 从未见过的选项，不能把 Route 的解释私自灌给业务；应由 Route 处理其控制选择，或提出必要澄清。新 session 无法理解孤立指代时允许业务/Route询问，不自动复制旧历史。

## 5. 身份、Registry 与权限

```text
conversationScope = hash(可信 channel/bot/account + chat + sender)
directoryIdentity = 已验证 canonical path + device/inode identity
controllerKey     = hash(scope + role + directoryIdentity-or-none)
businessBaseKey   = hash(scope + directoryIdentity + backend/home + profileDigest)
```

目录身份复用 `Catalog` 的规范路径与 device/inode 验证；不能用同名、同 remote 或路径字符串猜测同一目录。目录被替换、改名或撤权时重新验证，LLM 记忆不能授权。

Controller registry 存 role、generation、nativeRef、modelProfileDigest、当前状态和 usage。业务 session 继续使用现有 `sessions` 表；新 `business_bindings` 是 hierarchical 模式的唯一绑定源。旧 `routing_state` 的 `binding:*` 迁移后在新模式只读审计，不双向同步两份权威值。

Controller session 的轮换不修改 business binding。Bridge 从同一 registry 读取 Route 已选择的业务 ref，不再维护一个能覆盖它的独立副本。业务原生 ref 一旦获得就持久化，不能等答案生成后才记。

### 5.1 目录定位和对话焦点

Bridge 默认先用已选执行目录。只有目录指定、切换意图或跨目录只读查询才使用别名/受控搜索。候选可合理确定时直接选定；真正歧义才问具体问题。

保存独立的 `activeWorkspace` 与 `queryFocus`：

- `activeWorkspace`：下一个普通工作请求的执行目录；只有经过本次工作目标解析/明确切换后更新。
- `queryFocus`：最近讨论/查询的目录、session 和 interaction 引用；只读操作可以更新它。
- 后续用户工作指令可通过明确的上下文指代指向 queryFocus；这是本次工作指令的目标解析，不是前一次 read 的隐式执行。
- active 与 focus 冲突且当前话语无法唯一判断时，返回明确二选一澄清，不任意执行旧目录，也不永久改绑。

首版沿用已有 15 分钟待澄清/列表快照 TTL。TTL 过期只使临时选择失效，不删除项目和业务 session。

### 5.2 工具权限表

| 工具组 | Bridge | Route | Recap | 业务 |
|---|---|---|---|---|
| 目录别名/受控目录查找 | 可用 | 本目录描述，不自主切目录 | 无 | 原业务权限 |
| 安全 query/recap 交互列表 | 同 scope 可查 | 同 scope 可查，默认本目录 | 无 | 不自动提供 |
| 业务 session 元数据/查找/精确历史 | 只看绑定引用，不读正文 | 可用，受独立授权限制 | 无 | 原生自身上下文 |
| answer outline/range/full 原文 | **禁止** | 按需可用 | 当前摘要任务限定原件 | 不自动提供 |
| route_delegate | 可用 | 禁止 | 禁止 | 禁止 |
| business_execute | 禁止 | 当前请求/本目录一次性授权 | 禁止 | 原 runtime 内执行 |
| 任意 shell/任意 filesystem/读 SQLite | 禁止 | 禁止 | 禁止 | 原业务 profile 决定 |
| 修改授权根/模型 endpoint/blocked 状态 | 禁止 | 禁止 | 禁止 | 禁止由模型改变 |

读历史的权限不等于恢复执行权限。跨目录交互查询不是任意读其他账号目录的许可。

## 6. 80% 管理上下文换代

### 6.1 精确判定规则

```ts
function reached80(usedTokens: bigint, contextWindowTokens: bigint): boolean {
  if (usedTokens < 0n || contextWindowTokens <= 0n) throw new Error('INVALID_USAGE');
  return 5n * usedTokens >= 4n * contextWindowTokens;
}
```

用整数交叉比较，避免百分比显示四舍五入。对于 1,000,000：799,999 不换，800,000 换，800,001 换。没有输入/输出预测、buffer tokens、提早至 75% 等隐藏规则。

```ts
interface ContextUsageSnapshot {
  controllerId: string;
  nativeRef: unknown;
  turnId: string;
  usedTokens: number;
  contextWindowTokens: number;
  origin: 'runtime';
  basis: 'last-completed-request-total';
  observedAt: number;
  validForGeneration: number;
}
```

Codex 适配器从 `thread/tokenUsage/updated` 的 **last** 用量获取最近模型请求的 token 计量；不使用累计 **total**，不重复加 cached/reasoning 子计数。首版映射 `last.totalTokens`，并在 M0 核对安装版本语义与最后完成的 turn。它表示 runtime 报告的当前轮上下文计量，不声称逐字精算压缩后的所有可见历史。[R11]

只在该管理轮完成、所有工具回调完成、usage 与 generation/turn 对得上时保存。native auto-compaction 可能使旧 usage 失效：管理 profile 必须禁用预估式自动压缩/自动任务重试；不能禁用或无法观测其影响的版本不通过能力门禁。业务 runtime 的自身压缩另属业务 session，不由本设计的管理 80% 规则改写。

**缺 usage 不当成 0、不用累计 token/字符数估计。**刚创建且从未发送 prompt 的 session 可执行首次 bootstrap 请求；完成后没有可信 usage 时标记 `usage_unknown`，已有业务结果照常归档投递，但管理 session 不准继续静默复用。先获取 runtime 元数据，仍不可得则明确阻塞管理续轮。重启读取持久化 usage 前必须核对 generation 和已提交 turn；不能拿另一个线程的旧值复用。

配置的 1M 必须由能力探测确认与 runtime 实际有效容量相容。发现不一致应报 `CONTEXT_WINDOW_MISMATCH`，由 operator 修正配置，不能偷偷把窗口调小让测试容易过，也不能填大分母延迟换代。

### 6.2 检查时机与不可预测边界

在完成一轮后置 `rotate_pending`，下一轮输入提交前执行换代；启动/恢复时也检查上次有效 sample。不打断正在执行的业务任务，不在一次未完成工具协议中随意重建父会话。

低于 80% 的 session 可能因为新的巨大输入而直接超窗口。这是“不预测未来 token”约定接受的边界：报告 overflow，不提前压缩，不自动换会话后重放可能已执行的业务；输出是否已产生按 runtime 证据决定。

### 6.3 换代算法

1. 对 controllerKey single-flight，阻止并发创建两个 active generation。
2. 读取 L0 权威状态：目录、profile、业务绑定、pending request、blocked、列表快照引用。
3. 从安全 interaction projection 生成交接材料；Bridge 不读取 raw answer。
4. 交接描述不能覆盖 L0 字段；程序把 L0 与 narrative 分字段保存，并附 source IDs 和 hash。
5. 创建新 native 管理 thread，登记 role 和新 generation；不复制旧业务 transcript，不 fork 全部管理历史。
6. 初始化成功后，短 SQL 事务把旧 current 改 retired，新 current 改 ready。失败时旧关系不丢失；下一次安全重试建管理会话，不启动业务。
7. 将本轮原始 query 只提交给新 current generation 一次。

交接摘要作为新管理 session 的独立管理说明/受控上下文，不是业务 query。旧 generation 保留审计，不能接收新工具授权；迟到回调按 fencing generation 拒绝。初始化后若自己就达到 80%，视为 `HANDOFF_OVERSIZED`，不能循环创建新会话。

## 7. Route Agent 与业务 session 选择

选择协议通过工具给 LLM有限、可验证的选择，不让它发明 native UUID。

```text
resolve_business_options() → 可用绑定、原生候选、配置、动作 token
select_business_session(optionToken) → 选择结果/校验错误
business_execute(selectionToken) → 本请求的业务 job 或既有 job
```

宿主验证 optionToken 的 scope、目录、profile、候选 generation、过期时间和选择依据。业务执行前再次验证目录 identity、权限、profile digest 和原生 ref。

| 情形 | 规定行为 |
|---|---|
| 用户明确新建 | 在同一目录新建业务 generation，绕过 native 历史发现；不绕过 blocked/tainted |
| 明确恢复某个历史 | 精确定位并校验该 session；可超过 24h，不因别的历史坏而失败 |
| 已有本目录绑定，任务 busy/新建未首次响应 | 沿用该绑定排队，不由于 lastResponseAt 为空反复新建 |
| 已有 idle 绑定且 0≤age≤24h | 精确校验并 resume，其他本地新会话不抢走绑定 |
| 已有绑定明确过期 | 新建；不扫描 native 找一个不同的“更新会话”替换既有选择 |
| 无绑定 | 查询授权 backend/home/cwd 范围的业务 session 元数据；原生 CLI 创建的会话也要能发现 |
| 候选不存在且发现覆盖已确认 | 新建 |
| 发现失败、partial、候选次序无法确定 | 明确阻塞/请用户选择，不伪装成空集合自动新建 |
| 恢复在 prompt 之前确证 missing | 可以新建并说明，记录 `missing-before-prompt`；不存在与权限/格式/超时必须区分 |
| 发生在 prompt 提交后的错误 | 不自动重试、不自动换新 session 继续任务 |
| 未知/未来 lastResponseAt | 不猜时间，不自动复用；只在独立恢复校验允许时提供显式选择 |

Pi 原生 assistant 记录不自动证明 `agent_settled`。未知原生状态不能被 LLM 的判断“看起来完成”覆盖。显式读取可以返回有限内容，执行资格由 backend-specific verifier 决定。

### 7.1 查进度不等于启动业务

Route 可以通过只读 history reader + 状态服务回答进度，归档自己的查询答案，并生成短记录。`producerRole=route`、`interactionKind=history_query`。它不修改业务 lastResponseAt，不把“计划去做”当成已经在运行。

`businessSessionRef` 指向被查询对象，`executedBusinessSessionRef` 在未执行时为空。Bridge 可以记住查询 focus，但不会因此更新业务 last binding。

## 8. Native History：本次故障的直接修复

### 8.1 三个不同服务

```ts
interface NativeCatalog {
  listMetadata(scope: NativeScope, cursor?: string): Promise<CandidatePage>;
  locateExact(scope: NativeScope, ref: SessionRef): Promise<CandidateMetadata>;
}
interface NativeReader {
  readWindow(scope: NativeScope, ref: SessionRef, cursor?: string): Promise<HistoryPage>;
}
interface ResumeVerifier {
  verify(scope: NativeScope, ref: SessionRef, profileDigest: string): Promise<ResumeCheck>;
}
```

优先用经过 probe 的 native metadata/read API。Codex app-server 有 `thread/read` 的不恢复读取语义，不能为了查询去调用 `thread/resume`；列表默认行为可能带修复扫描，能用索引限定参数时必须显式使用，具体字段按固定版本 schema 验证。[R12]

可用 API 缺失时，保留 read-only SQLite 索引和受控 JSONL reader 的适配路径，但索引只用于定位，不读取整个目录正文。`locateExact(ref)` 查准确一条记录，再验证 header/cwd/owner，而不是 `scan(workspace).find(id)`。

### 8.2 完整性结构

```ts
interface CandidatePage {
  entries: CandidateMetadata[];
  nextCursor?: string;
  discoveryCoverage: 'complete' | 'partial' | 'unknown';
  orderBasis: 'last-completed-response' | 'updated-at' | 'created-at' | 'unknown';
  diagnostics: Diagnostic[];
}
interface HistoryPage {
  messages: HistoryMessage[];
  nextCursor?: string;
  contentTruncated: boolean;
  omittedKinds: string[];
  observedThrough?: string;
}
```

`updated_at` 排序不是最近完整回复时间排序。无绑定时不能只取 updated_at 前 3/10 个，然后声称找到了“最近完整回复的 session”。索引器应保存可验证的 `lastCompletedAt` 和覆盖状态；无法证明候选顺序时继续元数据发现或让用户精确选，不全局扫描大正文来“证明所有历史健康”。

元数据索引可异步增量更新，按文件 identity/revision/offset 缓存，不在每条工作请求中同步全量建库。索引错误不污染已经精确绑定的独立目标；候选自身缺关键证据仍不执行。

### 8.3 超大记录与阅读投影

有界 streaming JSON tokenizer 分离结构、必要状态字段和可省略正文值；不能只看前 4KiB 猜 type，JSON key 顺序不能成为假设。分别限制总读取 bytes、单正文保留 chars、嵌套深度、事件数、deadline 和 abort。

对于巨大工具/图片值，reader 可在验证结构后省略载荷，仅保留 provenance；对于影响 cwd/owner/turn 状态的必要事件，不得盲跳。识别不了则 `candidate_unverified`，不是“历史不存在”。不简单提高 8MiB 上限或 catch 后返回 fresh session。

保持路径 containment、symlink/O_NOFOLLOW、文件身份复核、所有权隔离。完成校验和执行之间再次检查 revision；外部 CLI 写入或文件替换时重新验证/拒绝。文件 stat 不能独立证明没有活跃 writer。

消息保留 `nativeEventId, role, source, purpose, timestamp, text`。目的至少为 `user-input|assistant-final|assistant-commentary|automation|tool|unknown`。不要回放隐藏 reasoning。旧自动注入内容无法可靠分类时标 unknown，不从一句 `No-progress check` 的正则升级出确定来源。

## 9. 答案原件、Recap、投递和渐进式披露

### 9.1 谁写 answer.md

业务 runtime 的 final 输出是答案原件来源，**宿主 adapter 负责最终兜底归档**；可以给业务 Agent 独立的静态产物约定，但不往 userQuery 追加“请写文件”。只读任务也能由宿主保存答案。

业务 Agent 另行创建的报告/文件属于交付 artifact，不一定等于 final reply。final 原件与业务交付文档各自保存 hash 和 producer，不用报告替换 final。模型忘记写 `answer.md` 不应导致业务结果丢失。

原件定义：adapter 接收到的最终 assistant 可见文本 UTF-8 bytes，不包括推理、工具输出、Bridge 的“执行环境”前缀和分段编号。不做 trim、换行归一化、二次排版或 Markdown 修补。

### 9.2 文件布局

```text
<stateRoot>/artifacts/<requestId>/<answerId>/
  answer.md.part         # 写入中，不能由 history/delivery 读取
  answer.md              # 不可变原件
  manifest.json          # id/role/session/hash/bytes/finish evidence
  recap.v1.json          # 可替代重算，必须绑定原件 hash
```

不放进用户项目 git 工作树；目录 0700，文件 0600。工具使用 opaque answerRef，不接受模型提交绝对路径。原件索引在 DB；manifest 是可恢复副本，不另起一份权威任务状态。

`maxOriginalBytes` 是存储资源上限，不是静默裁剪阈值。超过资源上限保留可诊断 draft 并报 `ARTIFACT_LIMIT`，不得宣称“完整保存”。默认值在样例配置中可调，按磁盘预算执行。

### 9.3 完成与提交顺序

```text
final 输出捕获 → 有序写入 draft
runtime 确认完成/退出/cleanup
→ fsync 文件 → rename final → fsync 父目录
→ SQL短事务：artifact ready + 原件 hash + 业务终态 + lastResponseAt
→ 创建 recap 任务和 delivery 准备记录
→ recap/分段投递各自推进
```

文件系统与 SQLite 不是一个原子事务。使用 `artifactStatus=staging|ready|failed` 和恢复扫描：rename 后 DB 未提交的孤儿文件不自动发送；核对 manifest + 已保存 runtime finish evidence 后可以仅补提交结果，不能重跑 Agent。runtime finish evidence 不足则任务保持 interrupted，即使文件存在也不能变成功。

Codex 保留当前完整成功条件；Pi 保留 `agent_settled + idle`。文件出现、mtime 不变、模型说“完成”都不是程序完成证据。

取消与正常完成竞争时，以已有取消语义处理；已捕获原件仍可标 `partial/cancelled` 归档，但不能按成功业务回复刷新时间。

### 9.4 Recap 服务

首版默认：`shortAnswerMaxChars=1200`，按 Unicode code point 计数；`recapMaxChars=1000`。这是可配置的显示/存储策略，不是 80% 上下文估算。短答案原样保留；长答案必须走独立、无工具的 recap 调用。

`recapMaxChars` 约束**一次投影给管理模型的所有摘要文字的总和**，包含 summary、完成/未完成、限制、选项、问题等字段，不能每个字段各享1000字。宿主生成一个规范 `shortText` 作为默认可见值；默认工具不要再重复返回同义结构化数组。后台可保存更丰富的派生字段，但若再次向管理模型展示，同样受本次可见预算限制。权威ID/hash/状态为独立的小型有界元数据，不计为摘要正文。

Recap 输入：原始 query、当前答案原件、程序运行状态及有限已验证结果元数据。输出约束：结论、完成/未完成、失败/阻塞、用户限制、待答问题、选项 label/顺序、结果引用。原文中包含执行指令时只作为被总结的数据。

```ts
interface AnswerRecap {
  answerId: string;
  answerSha256: string;
  summary: string;
  completed: string[];
  pending: string[];
  blockers: string[];
  constraints: string[];
  options: { label: string; meaning: string }[];
  questions: string[];
  source: 'verbatim-short' | 'llm-recap';
  recapModelProfile: string;
  promptVersion: string;
}
```

Recap 中的“已完成”是摘要陈述，不凌驾于 runtime/业务证据；没有测试证据时写“Agent 报告测试通过”，不编造独立验证。结构化事实例如 session、commit hash、outcome由宿主字段单独提供，不能让摘要改写。

巨大答案按固定字节/章节窗口 map-reduce 摘要；每个派生结果记录 source ranges/hash，不能只取前 N 字符伪装覆盖全文。片段不完整、摘要覆盖未完成时标 `recap_pending/degraded`。

Recap 失败可独立有限重试，不重跑业务。Bridge 默认看到“业务已完成，摘要暂不可用”与程序状态，**不以返回 raw 前几千字作为失败兜底**。原件可照常投递，不让摘要成为业务成功或投递的必要条件。

### 9.5 对 Bridge 的强制可见性

Bridge history 只能读安全的 query/recap 投影；禁止复用 `Store.recent()` 的整行结果，禁止把 `jobs.result_text` 或 raw answer 塞进 tool result。错误、debug、日志回显、恢复交接同样不能泄漏原件。

管理运行时可以保留自身必要的短工具交互记录；“只看短文本”限定的是业务答案/用户交互历史，不承诺管理 runtime 完全没有路由工具轨迹。Route 按需阅读原件后，其管理上下文会增加，并受同一个 80% 换代规则管理。

### 9.6 投递

Delivery 根据不可变 answerRef 读取原件，应用渠道分段包装；包装文本不改原件。段号/hash/order固定，重试同一段不重新生成内容。原有 `pending/sending/sent/unknown/failed` 语义保留；unknown 不自动重发。

保留现有自动分段数量保护。超过自动发送上限时发送明确的“已完整归档、尚有 N 段未自动发送”说明，`/result` 可读取其余分段，状态记为 partial，不宣称完整送达。原件完整性与渠道单次展示限制是两件事；不得以渠道上限裁剪原件。

### 9.7 历史工具

```text
list_interactions(scope=directory|conversation, limit=30, cursor?)
search_interactions(query, directoryRef?, cursor?)
read_answer_outline(answerRef)
read_answer_range(answerRef, start, limit)
list_business_sessions(directoryRef, limit=10, cursor?)
read_business_session(sessionRef, window, cursor?)
```

最近 30 指用户交互轮次，不是内部 Agent 调用次数。每次用户请求只有一个 outward interaction；Bridge、Route、Recap 内部轮次不能污染列表。默认分页含 query、短记录、时间、目录、producer、相关业务 ref、执行/投递状态、answerRef。全文读取带明确范围和 continuation，默认不可见，最大每页 16KiB UTF-8 文本（边界按 code point 调整）。

搜索默认 query/recap FTS，不默认把所有 raw 正文建到 Bridge 可检索索引。Route 要查原文时使用独立受权工具，其命中片段不能被 Bridge 工具复用。source 种类、已删除原件、retention 和跨 scope访问都必须明确返回。

## 10. 数据模型与事务

保留 `jobs/sessions/outbox` 的业务职责，新增表如下。配套 SQL 是设计 DDL，可用于空的 v3 测试库验证；不是直接对生产库执行的脚本。

| 表 | 作用与关键约束 |
|---|---|
| `orchestration_requests` | LLM 前接收的 root 请求；`UNIQUE(channel_id,message_id)`；原文、hash、seq、phase、jobId、immutable route snapshot |
| `controller_sessions` | Bridge/Route 的每个 generation；role/nativeRef/model digest/usage；每个 logicalKey 仅一个 current |
| `business_bindings` | scope+directory+profile → 现有 sessions.session_key；version CAS；hierarchical 唯一绑定源 |
| `controller_effects` | request+stage+effectKey 唯一；工具重试只返回已记录结果，特别是业务提交 |
| `answer_artifacts` | 原件地址/hash/bytes/producer/finish evidence/状态；不能由模型直接更新 |
| `answer_recaps` | 按原件 hash + prompt/config版本记录派生摘要；不覆盖原件 |
| `interaction_records` | root outward query/recap projection；一请求一条；按 scope/directory/ingressSeq 分页 |
| `native_session_catalog` | 原生元数据加速层；source revision、role、lastCompletedAt、coverage、验证状态；可重建 |

L0 当前目录、focus、pending clarification、目录别名沿用 `routing_state` 的 typed namespace；它们不是自然语言 memory。现有 memory 设计中别名来源/version/tombstone等原则继续保留，不另造一套 MEMORY.md。

### 10.1 接收与业务 job 的分离

当前 Store.reserve 依赖预先选定业务 session。新接收层先生成 requestId并落 `orchestration_requests`，**不为了占号而假绑默认业务目录**。LLM 选择完成后，通过 `reserveWithRequest()` 为同一个 outward request 创建一个业务/command job，保留原来的 `(channel_id,message_id)` 唯一约束。requestId 可直接成为 job.task_id；实现要允许显式传入已校验 UUID。

管理调用不建成 `kind=agent` 的业务 job，因此不会占据单业务 worker。root 请求的 ingressSeq是新模式 FIFO依据；不能因为某个目录的路由更快就越过前面未准备好的业务请求。

### 10.2 幂等和外部副作用

`controller_effects` 的键由宿主构造，例如 `(requestId, route, business-submit)`，不使用 LLM 每次生成的新随机幂等键。一个 root 首版最多提交一个业务 job；要求同时修改多个目录则澄清拆分，不擅自多派发。

写下 `submitting` 之后调用外部 runtime，返回/确认后记录 `submitted/nativeTurnRef`。宕机发生于调用与回执之间时状态为 uncertain；没有 native 幂等保障就不能再次发送 prompt。数据库唯一键只能防止重复入队，不能被宣传为远端工具 exactly-once。

## 11. 状态机、调度与恢复

```text
root：accepted → media_preparing → bridge_planning → route_planning
                     → awaiting_business → result_processing → completed
                     → failed / cancelled / interrupted

业务 job：维持当前 preparing/queued/running/... 终态语义
artifact：staging → ready | failed
recap：pending → ready | failed
delivery：pending → sending → sent | unknown | failed
```

只读路由响应跳过 business。澄清作为一次 completed control interaction，并写下一次待选状态，不保留占用 FIFO 的永不结束任务。

| 故障点 | 恢复行为 |
|---|---|
| 接收已落库，尚未有模型/业务副作用 | 恢复待路由请求；不丢 message 去重 |
| Controller 正在纯阅读/选择，未提交业务 | 对账 tool effect，可安全继续控制逻辑；不自动执行未经确认的新选择 |
| 已创建业务 job，Controller 崩溃 | 查询原 job，返回其状态；不重新创建业务 job |
| prompt 是否已提交未知 | 标 interrupted/uncertain，阻止自动重发 |
| 业务已完成，原件待归档 | 根据已保存 final/finish evidence补归档；证据不足则不伪造完成 |
| 原件 ready，recap 失败 | 重试 recap，业务执行次数不变 |
| 投递 sending 时重启 | unknown，维持不盲重发 |
| Controller 达80%且有已提交业务 | 可等管理轮安全终结再换代；业务 ref与job不变 |
| 目录/profile在排队后变化 | 分发校验失败，不偷偷改到新目录或兜底profile |
| 旧 controller迟到回调 | 按generation/effect fencing拒绝，不覆盖新绑定 |

`/cancel` 能取消根请求：未派发时取消管理规划；已派发则取消对应业务 job并等待原 backend清理。管理Agent的“已取消”回复不算取消证据。

首版保持全局单业务 worker和保守的全局 blocked审查。管理父链等待时不得持有workspace锁、SQLite事务或唯一业务槽位。`accept()` 必须尽快完成持久接收；不能把整个LLM父子链放进现有`intake` Promise串行等待，使后来的 `/cancel` 进不来。

## 12. 可观测性与证据

常规日志只记ID/hash/状态/数量/error code，不记用户全文、原件、凭据、工具大正文或推理。live 合成fixture可开启私有 trace，0600且不提交仓库。

必须存在的事件：

```text
request.accepted / request.duplicate
controller.created / controller.resumed / controller.usage_observed
controller.rotate_requested / controller.rotated / controller.usage_unknown
directory.selected / directory.clarification
business.session_selected / business.prompt_submitted / business.completed
answer.raw_committed / answer.recap_ready / answer.recap_failed
history.metadata_read / history.answer_range_read / history.access_denied
delivery.part_sent / delivery.unknown
```

每次 prompt 提交记录 request/sourceRequest/nativeRef/profileHash/textHash/attachmentHashes；测试可核对实际adapter wire输入，而非只核对调用者想传的值。每次读取记录主体role和answerRef/range；控制层schema必须能自动检查Bridge没有raw读取工具。

关键不变量指标：`wrong_directory_execution=0`、`duplicate_business_submit=0`、`bridge_raw_answer_exposure=0`、`query_rewrite=0`、`business_replay_after_uncertain=0`、`binding_change_on_controller_rotation=0`。零指标仅是期望，不表示本次已测得。

## 13. 文件级开发计划

所有新增路径是施工目标。不要在还没实现时把它们写成已有能力。

| 模块 | 新建/修改文件 | 明确工作 |
|---|---|---|
| 配置 | `src/config.ts`、`src/routing/config.ts`、`src/orchestration/config.ts` | model profiles、hierarchical开关、严格80%常量、能力门禁、配置digest |
| 原文接收 | `src/local.ts`、`src/weixin.ts`、`src/bridge.ts` | rawQuery保存，原始请求先落库，命令快速通道，拒绝历史prompt注入 |
| Registry | `src/orchestration/registry.ts`、`src/store.ts`、`src/migrations/v4.ts` | controller角色/代际、business binding、request与job关联、CAS |
| 控制runtime | `src/controllers/runtime.ts`、`src/controllers/codex-app-server.ts`、`src/controllers/protocol.ts` | stdio JSON-RPC、native持久thread、tool callbacks、usage、取消、受限工具面 |
| 管理Agent | `src/controllers/bridge-agent.ts`、`route-agent.ts`、`prompts/*.ts` | 冻结角色说明、类型化动作、目录与session分工 |
| 换代 | `src/controllers/rotation.ts`、`handoff.ts` | 整数80%判定、安全轮次边界、L0交接、迟到fencing |
| 工具 | `src/orchestration/tools.ts`、`dispatch.ts` | 隐式request/scope绑定，无query参数，effect幂等，单次业务派发 |
| 原生历史 | `src/history/catalog.ts`、`reader.ts`、`verifier.ts`、`codex.ts`、`pi.ts`、`jsonl-projection.ts` | 元数据与准确目标分离，单会话限流、role/source分类 |
| 原件 | `src/answers/artifact-store.ts`、`src/codex.ts`、`src/pi.ts` | 在裁剪/包装前捕获final，原子发布，fs/sql恢复 |
| 短记录 | `src/answers/recap.ts`、`projection.ts`、`history-tools.ts` | 短文原样、长文独立概括、原文渐进读取、Bridge防泄漏 |
| 调度投递 | `src/bridge.ts`、`src/reply.ts`、`src/main.ts`、`src/debug.ts` | 管理/业务bulkhead、按root FIFO、原件投递、阶段分离 |
| 验收 | `scripts/probe-controller.ts`、`scripts/live-orchestration.ts`、`tests/live/*` | 实际模型与runtime证据、fixture、机器断言、故障注入、微信人工证据 |
| 文档 | `docs/DESIGN.md`、`BRIDGE_ROUTING_SESSION_RULES.md`、`BRIDGE_MEMORY_DESIGN.md`、`IMPLEMENTATION.md`、`TEST_MATRIX.md`、`verification.md`、`PRIVACY.md`、`README.md` | 替换冲突条款；保留旧验收编号映射；实施和证据状态不得混写 |

## 14. 分阶段实施与验收门禁

### M0 — 运行能力探测（必须先完成）

实现 opt-in `probe:controller`，读取实际binary版本并生成/保存可用协议schema hash。验证create/resume、限定工具回调、真实usage、1M/high配置、管理内建工具禁用、native自动压缩行为、媒体及取消。一个不满足就报告具体缺口，不偷换API模型/运行时。冻结`runtime-lock.json`和compatible policy说明。尚未触碰真实业务目录。

完成条件：LIVE-00通过；必要能力缺失记录BLOCKED，后续可继续离线开发但不得宣称全链路可上线。

### M1 — 原始请求/配置/迁移

实现v3→v4 additive migration、root接收去重、rawQuery hash、model config source、role registry。删除新模式的`contextTaskIds`拼接及自动历史附件复制。保留旧模式只用于只读回退/迁移检查。

完成条件：raw Unicode/CRLF/空白一致；duplicate与冲突ID测试；v3迁移旧记录不被伪称raw verified；业务暂未接入时所有新模式工作请求明确不可用。

### M2 — Artifact/Recap/History Projection

先在现有业务执行后接上final归档；Store.complete改成支持artifact-backed路径，老字段仅用于兼容显示。实现recap结构、来源、版本、失败独立重试、Bridge安全projection、Route范围读取。

完成条件：原件hash等于捕获final；崩溃边界恢复；安全projection没有raw。此阶段先运行独立Recap真实模型组件用例；LIVE-07/08/09/29/30的完整三层验收依赖M4/M5接通后执行，不把组件通过当全链路通过。

### M3 — ControllerRuntime与80%轮换

实现持久Bridge/Route管理session，严格工具面，usage判定和L0 handoff。先用真实runtime小轮次验证create/resume，再做边界离线/故障注入；真实1M阈值长测留到M7门禁，但不能用mock结果替代。

完成条件：Controller不进入业务worker；generation CAS/usage_unknown/迟到回调测试；LIVE-01/02基本闭环。

### M4 — 三层委托与任务状态

接通目录定位→Route→业务；源query由宿主读取；一次request最多一个业务派发；嵌套等待不持有业务锁；控制命令独立快路径。正常结果按answerRef直接投递，不让Bridge重写答案。

完成条件：LIVE-03/04/05/06/10/11/28通过；补跑M2中的完整链路用例；实际wire hash与session ID均有记录。

### M5 — Native History修复与规则迁移

拆catalog/reader/verifier；精确绑定不全目录扫描；无绑定支持外部CLI历史，覆盖/排序不明不自动新建；重写旧history查询返回的preview逻辑。保留授权、24h、blocked、所有权和部分扫描语义。

完成条件：LIVE-12/13/14/15以及相关offline大帧/坏事件/并发写测试通过。

### M6 — 可靠性与旧规则对齐

完成取消、崩溃、摘要失败、unknown投递、迁移和媒体。修改旧`smoke-planner`里隐式跨session补上下文的预期并保留旧测试ID说明；禁止为了通过旧测试重新注入历史。

完成条件：LIVE-16至LIVE-25对应门禁通过；`npm run check`全绿；保留原58项验收ID及新增映射。

### M7 — 全 live、真实80%、微信验收

按案例附录跑fresh fixture重复3次；运行与生产相同1M profile的管理80%测试；用真实手机消息验证路由→业务→原件投递。生成带版本/配置/原始结果链接的报告，区分模型通过与微信送达。

完成条件：强制能力case无BLOCKED/SKIP；关键不变量零违反；LIVE-26/LIVE-27真实80%测试与LIVE-W01/W02已验收。若Pi业务路径也要发布则Pi lane必须实测，否则显式标该路径尚未上线验证。

### M8 — 发布与文档收敛

停止接收新业务，排空queued，确认无running/cancel_requested/unknown effect；备份SQLite时使用SQLite一致性备份方式并配套artifact目录，不能只复制打开的主db丢WAL。执行迁移dry-run/正式迁移，开启hierarchical，运行短live回归，再由owner微信验收。

把本文冻结规则合入唯一权威设计，当前行为和目标状态同步更新；历史报告只作为证据引用，不再提出冲突行为。不要修改main，不force push，不提交runtime/config/auth/model输出。

## 15. 测试分层与“live”的定义

- **OFFLINE**：fake runtime、时钟/usage注入、合成JSONL；验证程序不变量，不能称为真实LLM测试。
- **LIVE_LOCAL**：真实管理模型 + 真实业务runtime + 合成隔离项目 + LocalChannel；能够验证模型理解/执行，不证明微信送达。
- **LIVE_FAULT**：真实LLM/runtime，测试环境注入真实故障/合成坏历史/可控clock；报告明确注入项，不能称自然事故复现。
- **LIVE_LARGE_CONTEXT**：真实配置窗口、真实usage越过80%；不调小窗口，不伪造用量。通常昂贵，必须另行opt-in，记录实测token与成本可得性。
- **LIVE_WEIXIN**：真实owner手机/iLink/真实模型/业务sandbox及收到的消息证据；`outbox.sent`仅证明服务ACK，不等于用户阅读。

每个live case至少记录：git SHA、binary/version、schema hash、OS、config hash、requested/observed model/reasoning/window、scope、输入hash、native session/turn、artifact hash、tool trace、断言结果、费用/usage（未报告时写unknown）。`NOT_RUN/BLOCKED/SKIP`均不是PASS。LLM judge仅辅助检查摘要语义，不能裁决权限、去重、hash、session身份、文件或Git事实。

## 16. 开发与验收命令

当前仓库已经支持：

```bash
npm ci
npm run check
```

下列脚本由M0/M7新增，未实现前不可当作现有命令使用：

```bash
npm run probe:controller -- --live --config "$LIVE_CONFIG" --out "$EVIDENCE/probe"
npm run test:live -- --live --config "$LIVE_CONFIG" --suite core --repeat 3 --out "$EVIDENCE/core"
npm run test:live -- --live --config "$LIVE_CONFIG" --suite fault --repeat 3 --out "$EVIDENCE/fault"
npm run test:live -- --live --live-large-context --config "$LIVE_CONFIG" --suite large-context --repeat 1 --out "$EVIDENCE/large"
npm run test:live -- --live --live-weixin --config "$LIVE_CONFIG" --suite weixin --out "$EVIDENCE/weixin"
```

`package.json`新增：`probe:controller = npm run build --silent && node dist/scripts/probe-controller.js`；`test:live = npm run build --silent && node dist/scripts/live-orchestration.js`。`npm run check`永远不自动调用付费模型，不把live文件加入当前默认`node --test` glob。

runner未传`--live`直接拒绝，不悄悄用fake替代。缺认证/模型/窗口能力应exit nonzero并报告BLOCKED。large-context须额外显式许可和最大调用/实测token花费预算；达到预算退出BLOCKED，不无限重复直到成功。普通核心repeat用独立fixture/seed，保留第一次失败，不能选择性删除失败记录。

## 17. 数据迁移与回退

v3→v4必须additive：保留jobs/sessions/outbox和所有native refs、last_response_at、blocked/tainted证据。现有对话绑定导入business_bindings；管理session惰性建立。旧结果可逐条在维护阶段归档，但已被boundedResult裁剪的旧文本只能记`legacy_truncated/unknown`，不能声称恢复了原件。

旧输入可能已trim或历史拼接；有originalText则保留其来源，没有就标`legacy_normalized`。保留旧hash版本用于旧messageId重复检测，不让迁移改变已处理消息的去重语义。新原文hash只适用于新请求。

迁移不跑LLM、不重放任务、不更新24h时钟。backfill可分批且幂等，读取旧大result时不走Bridge模型。升级失败停止服务并保留新旧证据；旧binary不得直接打开v4继续写。回退要用停机备份和已处理message/cursor对账，不能恢复旧cursor导致重做已执行任务。升级后已有新执行时，不允许仅恢复旧DB掩盖这些副作用。

## 18. 最终验收定义

完成不是“能收到一条回复”，而是：目录和session正确；原始query没有改变；原件hash一致；Bridge没有读到长原文；Route可渐进读；80%真实生效且业务绑定不变；模型配置按来源生效；历史异常隔离；取消/重启/摘要/投递失败不重复业务；所有安全不变量由代码、DB和runtime证据确认。

本次交付仅为设计及验收规格。未运行目标仓库的npm检查、未调用用户live模型、未连接微信、未修改仓库或提交分支。配套bundle自检只验证规格文件结构，不是产品验收。

## 来源与审查定位

R01 目标仓库基线：`tedczj/wecom-agent-bridge@e7d7328c13b33f8e5feab4c1691350ed21dab2d2`；`AGENTS.md`、`package.json`。  
R02 同基线 `docs/DESIGN.md`、`docs/BRIDGE_ROUTING_SESSION_RULES.md`：现有业务完成、24h、scope、FIFO与控制读取契约。  
R03 同基线 `src/routing/router.ts`、`src/routing/history.ts`：全目录扫描、preview及恢复验证。  
R04 同基线 `src/bridge.ts`：`acceptOrdered/execute`、`contextTaskIds`拼接、控制命令。  
R05 同基线 `src/store.ts`：`reserve/recent/claim/complete`、schema v3。  
R06 同基线 `src/local.ts`：trim与媒体默认文本。  
R07 同基线 `src/codex.ts`、`src/types.ts`：原生ID、prompt提交与完成条件。  
R08 同基线 `scripts/smoke-planner.ts`、`config.routing.example.json`：现有live入口和示例模型。  
R09 同基线 `docs/BRIDGE_MEMORY_DESIGN.md`：确定状态、别名、来源与派生投影。  
R10 OpenAI app-server官方文档（查阅日2026-09-23）：`https://developers.openai.com/codex/app-server/`（当前重定向至ChatGPT Learn）。动态工具/部分分页为实验性能力，installed binary必须另验。  
R11 `openai/codex@30fc6864cc1318121eca1843c217fe00ce1212f1`，`codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsage.ts`：last/total/window字段；这是上游源码快照，不代表本机installed版本。  
R12 `openai/codex`，`codex-rs/app-server/README.md`：精确read、分页、状态和工具协议；主分支页面为可变来源，实施时应锁installed schema。  
R13 `NousResearch/hermes-agent@40f29e280cc7d64ebf518b672596fdbe37a4fbe6`：`gateway/session.py`、`agent/codex_runtime.py`、`tests/agent/test_codex_app_server_thread_resume.py`。  
R14 `deepseek-ai/deepseek-harness@00102833dfaee1da9f48a3a8eae9d34005a75218`：`packages/session-query/session-query/src/{types,index}.ts`、`packages/goal/goal/src/domain.ts`。  
R15 OpenClaw查阅快照：`src/agents/tools/sessions-history-tool.ts` blob `ec49512c0eaa199264d331f538450c6f9038fd67`、`sessions-list-tool.ts` blob `c3f42329b1b04cf332037ec0f865606eac3b8bdd`；借鉴只读工具/受限投影，不宣称复制其完整运行模型。
