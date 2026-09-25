# Bridge memory：目标设计与可验证实施方案

> 历史设计记录：旧临时分类/固定回复实现已删除。当前行为以 README.md、DESIGN.md 和 THREE_LAYER_AGENT_BRIDGE.md 为准；本文不作为现行启动或配置说明。


日期：2026-09-22。状态：基于已确认产品规则的推荐方案，待实现；不表示已有功能或已完成测试。

前置契约：[目录、路由与 session 规则](BRIDGE_ROUTING_SESSION_RULES.md)。上游证据：[memory 源码调研](BRIDGE_MEMORY_RESEARCH.md)。现有代码基线 `535915eae17f46ad986e21d3a721ecb58ff1e735`；当前行为仍以 `DESIGN.md` 为准。

## 1. 设计结论

bridge 的 memory 服务于“理解用户称呼的目录、记住少量交互偏好、查回相关历史会话”，不是另一套 coding agent 知识库。

采用：**确定状态 + 小型逐轮上下文 + 结构化目录记忆 + 按需历史检索**。SQLite 保存权威记录及版本，全文/向量索引和 Markdown 导出都是派生物。LLM 提交候选修改，宿主决定 scope、来源、权限、版本和实际写入。

不采用：所有信息都追加到一个 MEMORY.md；每轮按话题自动换目录；用语义相似度选普通续接 session；让后台 agent 自由修改自身系统规则；为第一版引入独立向量服务、图数据库、多阶段 Dream 或额外 supervisor 框架。

### 1.1 不可被 memory 改写的规则

1. 未指定时默认目录，选定后保持，只有明确切换意图才查找/切换。
2. 指定不精确时，bridge 先用记忆和授权范围内搜索自主定位，不能要求用户精确输入 ID。
3. 明确新 session 优先；否则按该目录上次 session 与最近完整回复 24h 规则处理。
4. 显式历史查找支持最近10条、超出10条的搜索和原文精读。
5. 原生 session 所属、工具权限、授权根、profile、模型 endpoint、阻塞状态、取消与不重跑规则由代码/配置决定。

memory 失效只降低召回，不改变以上行为。目录切换无法定位时不能偷偷执行在别的目录。

## 2. 分层、scope 与可信度是三条不同的维度

### 2.1 四层数据与一个派生索引

| 层 | 内容 | 是否由 LLM 改写 | 使用方式 |
|---|---|---|---|
| L0 确定状态（不是语义记忆） | 当前目录、各目录上次 session、lastAgentResponseAt、任务运行/阻塞状态、配置版本 | 否，受控命令与执行事件改变 | 每轮直接读可信状态 |
| L1 当前上下文投影 | 最近对话、明确偏好、当前目录信息、必要的已确认简称、待澄清对象 | 不直接写；由 L0/L2/L3按预算生成 | 每轮刷新，提供给 bridge |
| L2 结构化长期记忆 | 目录简称/缩写、目录用途、稳定用户偏好、纠正后的对应关系 | LLM可提案，宿主验证后持久化 | 先精确查，再检索 |
| L3 事件与历史 | bridge 收到的原话、有效最终回复、投递状态、路由结果、native session目录与有限摘要 | 原事件不由模型改写；摘要单独标记派生 | 搜索命中后按需读取 |
| 派生索引 | alias lookup、FTS、可选 embedding、上下文缓存 | 仅由索引器产生 | 可重建；不是独立事实源 |

L1 不是第二份可写 memory，不能与 L2 双向同步。删索引不等于删记忆；重建索引不能复活已删除记忆。

### 2.2 scope

- `principal`：可信 bot/account + owner 范围内的称呼和交互偏好。
- `directory_catalog`：operator 授权发现范围内的最小目录元信息。只有明确目录选择/查找时才跨候选目录检索。
- `workspace`：项目用途、项目特定称呼与会话摘要；默认限定当前目录，明确查询其他目录时再校验授权。
- `conversation`：待澄清问题、列表快照、最近提到的对象，不自动提升为全局事实。

backend 原生 session 必须再绑定 runtime/profile、账户/session root 和规范化 cwd。相同 Git remote 只是描述线索，不是同一目录或同一授权范围的证明。

### 2.3 来源和事实强度

宿主记录来源类别：`user_message`、`bridge_event`、`directory_metadata`、`worker_output`、`recalled_memory`、`system`。来源由真实工具/消息事件赋予，不能接受模型提交的 `owner=true`。

另有语义状态：`explicit`、`observed`、`inferred`。用户直接定义/纠正对应关系可成为 explicit；程序验证了目录存在只是 observed，并不证明用户确实用某简称称呼它。worker 自称“用户说过”仍是 worker_output，不升级为用户原话。消息中的引用/粘贴外部内容不能仅因发送者是 owner 就当成用户认可的指令。

来源证明“来自哪里”，不证明一句话内容必然真实；语义分类仍有模型误判可能。实际执行安全依靠后面的权限与验证，不能依赖 confidence。

## 3. 应记住和不应记住的内容

应记住：用户明确的目录简称/缩写；成功定位时获得的可复用但标记推断的称呼；项目有限用途说明；目录移动/失效观察；用户的稳定回复格式偏好；历史任务的可检索标题和简短摘要。

不写入长期 memory：原始 token/密钥、环境文件内容、完整代码/日志、隐藏推理、每个工具调用、临时路径、无来源的主观猜测、桥接回执/heartbeat、模型检索过的记忆副本，以及“昨天那个”“上一个项目”等依赖当前对话的指代。

代码任务细节继续留在对应 Codex/Pi session。bridge 不默认把所有 backend 的 MEMORY.md、skills、AGENTS.md 或完整 transcripts 合并进自己的常驻上下文。

## 4. 生成机制：明确变更即时写，推断信息增量整理

### 4.1 即时通道

用户说“以后 mvg 就是这个项目”“不是播放器，是翻译配音那个”，bridge 在原有意图理解调用中输出类型化 memory 操作提案。宿主验证真实消息来源、目标目录引用、授权、现有版本和冲突；事务成功后才回复“已记住/已更正”。不需要第二次要求用户使用标准命令。

同一轮“记住这个简称，然后切过去”必须先成功提交或在本轮可靠解析该对应关系，再执行后续目录选择；不能用旧上下文快照。

显式变更失败要说明，不能假装保存；若本次执行目标依赖该未解决变更则暂停派发。与任务无关的普通记忆整理失败不应阻断有效任务。

### 4.2 自动学习通道

bridge 每次完成目录定位、用户纠正、任务终结或必要的对话压缩后，产生小型 memory event。是否有值得提取的增量由事件类型和内容预算筛选，不必每条“继续”再调一个 memory 模型。

例：用户第一次说“那个视频配音的”，工具找到目录并确认项目说明吻合，可以保存为 inferred 候选。此条候选将来帮助查找，但不能因为 agent 自己连续用了它三次就变成用户确认的唯一别名。

候选生成输入仅为：新增的真实用户消息、必要的已送达/投递不明标记的回复、经过脱敏的路由/目录观察、有关的现有记录。不得把检索结果包装成新的用户消息重新提取。

独立证据是不同原始交互事件；同一 event 重放、同一历史片段多次读取、模型自我重复、摘要再摘要都不是新证据。晋升只合并独立来源，不按 recall 次数提高“用户确认”级别。

### 4.3 整理任务的运行方式

第一版使用同进程的有界持久化维护队列，处理明确有新素材的批次；这是目标程序组件，不依赖每天必须执行的 Dream cron。

```text
新增事件 → 记录源范围/版本 → 受限模型生成 patch proposal
       → 校验来源/删除屏障/版本 → SQL短事务提交
       → 推进消费cursor，记录索引dirty → 完成
```

LLM 调用在事务外。消费 cursor 只随成功的提交原子推进；失败保留未消费范围并有限重试。幂等键包含 scope、输入 event 范围/hash、extractor/prompt 版本。无新增证据则不调用模型。

聊天压缩、长期 memory 整理、24h session自动续接判断是三件事。任何一次 compaction 都不能从摘要恢复或改写当前目录/session指针。

## 5. 更新机制：按记录 ID + 版本，不做自由文本覆盖

### 5.1 状态机

```text
candidate → active
    ├→ conflicted
    └→ rejected
active → superseded | stale | forgotten
stale → active（重新验证） | forgotten
```

`candidate` 是未确定称呼，仍可用于候选召回；`active` 的来源可为 explicit/observed，不能混为同等事实。`stale` 表示目录/描述待验证，不等于删除；`forgotten` 是用户遗忘屏障，不能自动变回 active。

### 5.2 覆盖优先级

当前明确用户纠正 > 同 scope 既有明确对应 > 已验证观察 > 推断候选。跨 scope 不应用简单全局优先级。例如不同项目可以有同一简称，需保留歧义，而非强迫全局唯一。

“mvg 现在指新项目，不是旧项目”在一个事务中：旧对应 superseded，写新对应，保留最小纠正关系与来源。不是追加第二句互相矛盾的自然语言给模型猜。

一般后台整理只能合并候选、去重、更新派生描述；不能静默删除或替换用户明确的别名与偏好。需要破坏性替换时形成待处理提案；用户在自然对话中明确纠正则可以直接通过即时通道完成，不要求额外审批每一条低风险别名。

### 5.3 目录真实身份

每次执行前重验证真实路径与授权版本。目录记忆关联稳定的宿主 directoryRef，不直接把 LLM 输出字符串当 cwd。文件系统标识可辅助判断移动，但 inode、Git remote、路径前缀都不能单独决定授权或 session身份。

目录不存在时标记 stale 并尝试授权范围内发现；不能擅自把旧路径所有 session 迁到“看起来相似”的新目录。撤权立即阻断目录记录的检索/使用，不等待后台清理。

### 5.4 原子性

宿主使用 `expectedVersion` 执行 CAS。一次操作在短事务内更新 item、来源边、修订、memory revision及维护事件；冲突则重新读取，不使用最后写者覆盖。索引重建可以滞后，但搜索结果必须通过实时 item状态、版本和授权复核。

## 6. 删除机制：遗忘必须能防止再次生成

### 6.1 操作区分

| 用户意图 | 行为 |
|---|---|
| 别再把 mvg 当成旧项目 | 纠正关系、supersede旧映射，不删除项目本身 |
| 忘掉 mvg 这个简称 | 删除对应记忆及派生引用，阻止旧证据自动重建 |
| 不要记这个事情 | 保存受限的source/topic抑制规则；不升级为撤权 |
| 清空 bridge 记忆 | 清理指定 scope 的语义记忆；当前目录/会话状态是否重置另有明确操作 |
| 不许访问这个目录 | 授权控制操作，不是memory删除；普通模型无权自行改配置 |
| 删除某个 agent session | 独立 backend 管理操作；不由 memory_forget 暗含执行 |

自然语言指向明确的单条记忆可以直接处理。范围不明确的大批量清空应给出简短影响说明/必要澄清，避免把“忘掉刚才那个称呼”变成全库删除。

### 6.2 正常遗忘流程

```text
解析意图并确定范围
 → 短事务：标记forgotten、写forget rule、提升scope deletionEpoch
 → 立即从所有召回和上下文投影排除
 → 清理alias/FTS/vector/cache与依赖摘要
 → 取消/拒绝旧epoch的提取与索引写入
 → 返回实际完成范围和未覆盖范围
```

删除屏障先于物理清理。旧索引即使还返回一个 ID，读取层也必须拒绝把已forgotten记录正文给模型。候选整理提交时比较 deletionEpoch，并检查所有来源是否已被禁止；不能被删除前启动的后台任务复活。

相同原始消息不能在下次压缩、native session重新扫描或索引重建时再提取被遗忘事实。source refs、claim key 与最小不可逆/受密钥保护的匹配信息用于抑制；普通审计不得保存被要求遗忘的敏感正文。简单 hash 不保证低熵秘密不可猜，不能当作安全擦除。

多条记忆合并生成的摘要需要来源边。删除涉及其中一条时先撤下整个受影响摘要，再仅用仍允许的证据重建，不能让一个模型自行保证从融合文本中彻底减掉被删内容。

### 6.3 当前上下文也要失效

bridge 推荐每轮从状态/事件/记忆构造有界上下文，而不是把永久 provider conversation 作为事实源。遗忘后递增 context revision，重建受影响的近期消息视图与摘要；如果本轮模型已经看到待删内容，提交遗忘后不要继续以旧上下文作新的路由决定，必要时建立新的内部决策上下文。

这只是 bridge 内部上下文重建，不意味着改变用户当前目录或下游 coding agent session。已经发给外部模型的内容不能靠本地删除撤回，必须如实说明边界。

### 6.4 与原始数据擦除的边界

默认“忘掉这条记忆”意味着未来 bridge 不再自动使用或重学它，不等于删除微信消息、native transcript、备份、远端 provider 日志。显式历史查询可能仍定位到未删除原记录，结果要保持历史身份，不自动重新晋升为当前事实。

“彻底删除相关记录”需要独立 purge 工作流：原事件、提取候选、修订正文、派生索引、上下文缓存、相关源导入缓存与备份分别列状态；不支持删除的 native/provider 范围明确报告。回滚/恢复旧 memory 修订也必须检查当前 forget rule，不能成为恢复已忘内容的旁路。

用户后来明确重新定义同一简称，是新证据，可由显式 re-remember 操作建立新版本；后台重读旧证据不能解除屏障。发现目录仍在磁盘不等于可以从旧对话重建已忘简称。

## 7. 搜索机制：精确称呼优先，语义搜索可选

### 7.1 普通轮次不必检索所有记忆

用户没有目录切换/历史查询意图时，L0确定当前目录和session；只注入少量当前目录信息、最近对话和必要偏好。不能让检索命中另一个项目导致自动切换。

### 7.2 目录定位检索链

```text
用户给出的称呼/片段
 → 当前scope、授权根版本过滤
 → 已确认简称/ID精确匹配（规范化检索键）
 → 目录名/路径组成部分/前缀 + 候选别名 + 项目描述FTS
 → 必要时语义候选（第二阶段才启用embedding）
 → 真实目录验证、必要的候选描述读取
 → 记忆不足则搜索/遍历授权文件系统
 → 能确定则定位；仍无法区分才问
```

简称规范化可采用 NFKC、空白折叠和适当大小写处理，但仅作用于检索键；真实路径、session ID和源字符串不能被随意规范化改写。短称呼精确命中优先，不用 embedding 取代。

中文与短缩写需要专门测试：`unicode61`不是中文语义分词保证；trigram也不能覆盖所有1～2字符query。第一版以独立 alias lookup、目录名分段和授权后小候选集的有界字面子串查找兜底，FTS用于较长描述与历史。实现者可选择分词/字符ngram索引，但必须通过中文回归，而不是只测英文。

过滤必须在授权数据集上进行；不可先从全用户全目录 topK召回再仅在输出时去掉越权项。后续可增加embedding，但索引项同样携带scope、memory version、删除epoch；远程embedding可能发送目录和对话内容，须operator明确启用和可见的隐私说明。

时间只影响候选排序，不能让明确别名自然过期。一次搜索失败要区分 empty / partial / index_unavailable；memory miss必须能继续授权目录搜索。

### 7.3 历史会话检索

`list_sessions`只读目录的native session catalog及可信lastAgentResponseAt，默认10条。`find_sessions`按ID、时间、标题、有限摘要召回；需要时`read_session`再取相关用户/最终assistant消息，不默认读取所有工具或推理。

source adapter负责native格式与授权边界，bridge维护可失效的投影。索引source revision与创建/最后回复时间分别保存；索引更新时间和列表访问时间不能刷新24h。

列表序号绑定一次列表快照，查询cursor绑定scope/query/corpus generation；后续数据改变不得将“第二个”悄悄指向不同会话。普通续接仍走确定lastSessionRef，不走语义top1。

## 8. 最小数据模型

以下是逻辑表/对象，不要求一个对象一个独立数据库。复用现有SQLite，保留WAL/FULL、事务和owner-only文件权限。

| 对象 | 权威内容 |
|---|---|
| conversation_state / workspace_session_binding | L0当前目录、分目录会话、版本；属于路由模块 |
| directory_catalog | directoryRef、授权root引用、真实路径、profile引用、验证与失效状态 |
| bridge_events | 单调seq、真实消息/执行/投递事件引用；正文可复用现有jobs而非重复存两份 |
| session_catalog | 原生session引用、source revision、cwd/profile归属、真实响应时间、派生标题摘要 |
| memory_items | 类型化记忆的当前版本和状态 |
| memory_sources | item/revision→原始event、source片段、父记忆revision的血缘 |
| memory_revisions | 变更版本、操作者/模型版本、理由；敏感正文按保留/清除策略管理 |
| memory_forget_rules | scope、source/claim选择器、epoch、用户操作引用，防复活 |
| memory_jobs | 增量整理/索引任务、幂等键、输入revision、消费cursor、失败状态 |

alias lookup、FTS、embedding及L1是由这些表生成的索引/投影，不再作为可独立写入的真相。

```ts
// 示例契约；目标接口，不是已实现代码。
type MemoryKind = 'directory_alias' | 'project_description' | 'user_preference';
type MemoryState = 'candidate' | 'active' | 'conflicted' | 'superseded' | 'stale' | 'forgotten';

interface MemoryItem {
  id: string;
  kind: MemoryKind;
  scopeKey: string;                 // 宿主认证/授权决定
  directoryRef?: string;            // 仅目录相关记录
  payload: Record<string, unknown>; // 实现时按kind使用严格判别schema
  state: MemoryState;
  evidenceClass: 'explicit' | 'observed' | 'inferred';
  version: number;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
}

type MemoryProposal =
  | { op: 'add'; kind: MemoryKind; directoryRef?: string;
      payload: Record<string, unknown>; evidenceRefs: string[] }
  | { op: 'revise'; id: string; expectedVersion: number;
      payload: Record<string, unknown>; evidenceRefs: string[] }
  | { op: 'forget'; id: string; expectedVersion: number;
      userIntentRef: string };
```

proposal没有owner、scope、授权root、trust、backend启动参数或实际sessionFile字段。模型选择的evidenceRefs也必须由宿主检查确实出现在其可见上下文且属于该操作范围；evidenceClass的语义判断不允许模型直接自封为可信。

## 9. 工具与调用方式

保留规则文档的目录/历史工具。新增通用记忆面只需要：

```text
memory_search(query, kind?, directoryRef?)
memory_read(memoryRef)
memory_apply(proposals)                  # 宿主验证，不是任意SQL/文件写入
memory_forget(selector, expectedRevision) # 来自明确用户意图，返回影响报告
```

`remember_directory_alias`可以是`memory_apply`的窄schema门面；不要把同一别名更新实现成两套不同写路径。后台整理器只获得候选/描述提案能力，没有forget或配置写权限。

结果包含引用、版本、来源概述和state；用户可问“你为什么认为mvg是这个目录”“忘掉这个称呼”。展示的是真实来源与修改记录，不要求输出模型内部推理。

检索/写入工具返回实际成功状态。自然语言“记住了”不能当作持久化成功的信号；无权记录、版本冲突、partial search、索引不可用、来源缺失使用不同错误码。

## 10. 上下文预算与运行降级

建议起始预算是可调开发默认值而非效果承诺：L1与长期记忆投影约1500～2000 tokens；一次目录候选最多8条；一次历史列表10条；精读按token/消息数双预算。最近原始对话另设预算，避免只剩摘要而无法理解“刚才那个”。

固定规则放稳定前缀；最新L0与memory revision对应的内容放类型化数据区，每轮验证。记忆发生更正/遗忘时优先更新，不为了命中prefix cache延迟语义正确性。

memory整理失败：记录可重试状态，继续有效任务。索引失败：精确查权威记录或有界目录搜索。授权/真实目录验证失败：停止派发，不降级为无限制搜索。历史发现失败：报告，不伪装成没有session。

## 11. 与现有代码的最小演进

建议模块（新文件名为提案）：

```text
src/routing/directory-registry.ts   授权范围、目录身份、profile解析
src/routing/directory-tools.ts      有界遍历/搜索/describe
src/routing/route-policy.ts         保持目录与24h确定规则
src/memory/types.ts                 严格schema与错误码
src/memory/store.ts                 SQLite CRUD/CAS/血缘/forget屏障
src/memory/search.ts                scope优先的别名/FTS与精读
src/memory/context.ts               L1投影、预算与revision失效
src/memory/maintenance.ts           增量候选整理及索引任务
src/session-catalog.ts              Codex/Pi原生历史适配统一契约
```

`src/bridge.ts`在接收/去重后执行意图理解与确定调度，提交前固定目标；新memory事件复用持久队列语义。`src/store.ts`迁移新增表与metadata version，不删除旧jobs/outbox，不把原单workspace identity pin静默放宽。`src/config.ts`加入严格授权根/profile/memory配置。`src/types.ts`保留AgentBackend执行契约，session catalog能力可独立interface，不强迫执行backend承担记忆CRUD。

多目录迁移必须明确处理现有v2元数据；存在未完成/tainted任务时拒绝危险的profile/身份迁移。只迁移有效历史绑定，不自动重放旧任务。

## 12. 实施顺序与验收门槛

### P0：可用且可纠正的最小闭环

实现规则确定状态、授权directory registry、显式/候选alias CRUD、版本/来源/forget屏障、最近历史列表/查找与原始输入保留。记忆存储放worker不可写处。已有session续接、取消、去重和投递测试不得回归。

### P1：自动学习与受控全文搜索

实现增量整理队列、中文/短缩写召回、原生session catalog对账、受影响摘要重建、删除报告、重启/并发/过期cursor测试。没有新证据不调模型；后台不能覆盖显式别名。

### P2：仅在评估证明需要时增强

加入可选embedding、多路召回与rerank，评估语音错字/隐含用途召回收益和隐私成本；仍保留精确别名、scope、删除屏障和文件系统搜索。不默认引入独立向量服务器。

## 13. 测试矩阵（BM）

这些是新增测试要求，未执行；原58个验收ID和BR-01～22全部保留。程序断言与真实模型语义评估分开。

| ID | 测试 | 必须验证 |
|---|---|---|
| BM-01 | 直接定义简称 | 写成功才确认；下轮无需新session即可使用 |
| BM-02 | 同轮定义并切换 | 使用最新记录，不读冻结旧快照 |
| BM-03 | 简称纠正 | 原子supersede，无互相矛盾active值 |
| BM-04 | 两目录同简称 | 不跨scope覆盖；必要时最小澄清 |
| BM-05 | 一次推断定位成功 | 仅候选，不伪造user-confirmed |
| BM-06 | 重放/回忆同一来源100次 | 幂等，无独立证据膨胀 |
| BM-07 | 修改版本竞争 | CAS冲突，已确认别名不丢失 |
| BM-08 | 写入时崩溃 | item/血缘/cursor一起提交或不提交 |
| BM-09 | 增量整理失败 | cursor不前移，有限重试不阻塞回复 |
| BM-10 | 删除与旧提取任务竞争 | deletionEpoch拒绝旧结果复活 |
| BM-11 | 删除与索引重建竞争 | 旧索引项实时过滤，重建不恢复 |
| BM-12 | 删除混合来源摘要 | 摘要先失效，仅允许来源可重建 |
| BM-13 | 回滚到旧修订 | 不绕过当前forget rule |
| BM-14 | 遗忘后重新明确告诉 | 通过新用户证据建立新版本 |
| BM-15 | 旧上下文仍含删条目 | 重建bridge上下文；下游session不被误重置 |
| BM-16 | 忘简称而非删会话 | native transcript未删除且明确报告 |
| BM-17 | 密钥/大量日志输入 | 不存长期memory；诊断无正文泄露 |
| BM-18 | README或worker伪造owner指令 | 来源不升级，不能写配置/改权限 |
| BM-19 | roots撤权但缓存命中 | 在候选检索/真实使用前拒绝 |
| BM-20 | symlink替换/目录移动 | 验证真实目标，不盲迁session |
| BM-21 | 中文1/2字、mvg、大小写、语音错字 | 精确/子串/候选链可回归，保留原话 |
| BM-22 | 未指定切换但检索命中他项目 | 当前目录不变 |
| BM-23 | 查列表/生成摘要 | 不刷新lastAgentResponseAt |
| BM-24 | 最近10条外的旧会话 | 可找到且需显式恢复 |
| BM-25 | 列表更新后“第二个” | 使用原快照身份，不漂移 |
| BM-26 | 搜索scope跨用户/backend | 不泄露片段/数量/结果正文 |
| BM-27 | FTS不可用/扫描预算耗尽 | 明确降级/partial，不伪报不存在 |
| BM-28 | 后台patch改显式别名或规则 | 拒绝或待审，不自动覆盖 |
| BM-29 | 24h过期或新下游会话 | 只影响session，不删除别名与目录状态 |
| BM-30 | 空闲无新证据 | 不重复调用整理模型、不空转重写 |

语义评估集应采用多轮中文口语而非只有精确指令；记录目录正确率、误切率、错误新建/复用率、简称纠正即时生效率、追问频率、检索召回、无依据记忆生成率及成本。初始数据集与目标阈值由实施阶段固化，不能把模型自报confidence当作实际准确率。

## 14. 验证与发布说明

本文完整 memory 生命周期仍为设计。目录路由、24h/session 选择及版本化目录别名子集现已按 BRIDGE_ROUTING_SESSION_RULES.md 实现，离线证据见 verification.md；本文其余摘要、检索、删除、分层和治理模块尚未实现。未运行本 memory 方案的真实模型 benchmark、微信端到端或 OS 隔离验收；不得把本文目标机制当作已实现能力。
