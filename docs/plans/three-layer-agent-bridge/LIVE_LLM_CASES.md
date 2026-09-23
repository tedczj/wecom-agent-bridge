# Live LLM Cases：微信三层 Agent Bridge 验收附录

版本1.0；基线`e7d7328c13b33f8e5feab4c1691350ed21dab2d2`。所有用例当前状态为 **NOT_RUN**。

本附录由`live-cases.json`生成。它是待实现runner的验收规格，不是假装已经运行的测试记录。主架构约束见`DESIGN.md`。

## A. 测试环境与危险操作隔离

每个case/repeat使用新的随机runId和临时目录，至少含`projects/A`、`projects/B`、`state`、专用native history与`evidence`。启动前检查目录由runner创建且不是用户生产目录。任何Git push只能指向本次fixture内本地bare remote；检查remote URL不是HTTPS/SSH，禁用hooks，不能force push。LLM工作目录和写权限不得指向真实term4u或bridge仓库。

模型认证由operator配置，runner不从生产home扫描/复制密钥。新测试home必须通过独立登录或明确授权的认证机制准备。不要因为隔离home没有历史，就使用真实home的全部历史凑fixture。能力缺失退出BLOCKED，不自动切到API key收费路径或另一个模型。

fixture数据是合成数据不等于LLM是mock。下面有些测试会注入clock、传输错误或坏history；这些都必须在证据里标明。未注入的模型和业务调用必须是真的。

## B. Runner实现契约

新增`scripts/live-orchestration.ts`使用生产的Request Store、Controllers、工具handler、Artifact Store、业务backend和Delivery；测试目录只提供fixture构建、fault hooks、assertion oracle及证据导出，不将测试fake作为生产backend。

`action=user`必须经过与微信归一化后相同的production accept接口；纯本地live不验证微信协议。`action=runner/probe/fault`是明确的测试动作，不作为伪造用户消息注入业务session。断言从DB、实际adapter发送的数据、native IDs/turn事件、文件hash、git refs和进程状态读取。禁止用“模型回复说成功了”作为程序事实证明。

`assertions[].predicate`在runner中对应固定TypeScript断言函数，不执行JSON里的任意代码或shell。`expected`是该函数的业务预期；实现须为每个predicate加单测。`${nonce}`、`${nonceA}`由case生成器替换为安全随机串；`${alternateLabel}`从真实配置选择。不可跳过步骤只运行最后一条消息。

全局断言覆盖每个case：scope授权有效；业务不确定后不重跑；业务文本与sourceRequest原文hash一致；Bridge没有raw答案读取；无生产remote写入。

**核心与故障用例repeat=3，每次fresh fixture。**保留所有失败，不能只报告最好一次。语义不稳定不能靠无上限重试抹掉。80%大窗口和手机测试默认1次完整运行，是否增加次数由operator明确决定。

## C. 硬断言与语义检查

硬断言100%通过：路由目录/session、hash、权限、原件、去重、时钟、绑定、执行次数、80%事件和Git结果。语义类如recap保留未完成项和选项，可以固定事实rubric+人工复核/独立judge；judge不能豁免硬断言。

精确799999/800000/800001 token边界、极端故障时序首先由OFFLINE合同测试证明，不能伪造真实LLM恰好产生800000。真实80%用例只要求从真实低于80%跨到真实大于等于80%后正确换代。把contextWindow设小、替换usage或填累计total，都不能通过large-context门禁。

## D. 证据输出

```text
<evidence>/<runId>/<caseId>/<repeat>/
  manifest.json          # code/config/runtime/schema/seed/time/roles
  steps.jsonl            # 有序事件；常规分享版本无敏感正文
  assertions.json        # 每个断言 actual/expected/pass/fail
  usage.jsonl            # 原始真实usage与basis
  controller-effects.json
  artifacts/manifest.json
  private-input-audit.jsonl  # 仅本地0600，禁止提交仓库
  result.json            # PASS/FAIL/BLOCKED；本设计不是该执行结果
```

对外报告的最小结构：caseId、attempt、tier、gitSha、runtimeVersions、configHash、requestedModels、observedModels、usage/window、assertion counts、fault injections、artifact/evidence引用、开始/结束时间、status和blockedReason。服务端不报告最终模型或成本时写unknown，不能猜。

全套门禁不能把BLOCKED/SKIP当PASS。只完成LocalChannel时，报告必须写“微信未验收”。大窗口测试未执行时必须写“真实1M/80%尚未验收”，不能以offline替代。

默认示例配置为只读。涉及修改/commit/push的case，runner必须在operator显式同意后，为本次临时fixture生成workspace-write profile，并重新验证scope与local remote；不能提升生产profile或自动通过交互审批。

## E. 用例索引

| ID | 类别 | 名称 | 当前状态 |
|---|---|---|---|
| LIVE-00 | LIVE_LOCAL | 运行时/模型/工具/usage 能力门禁 | NOT_RUN |
| LIVE-01 | LIVE_LOCAL | 模糊称呼定位目录、惰性Route与daily默认 | NOT_RUN |
| LIVE-02 | LIVE_LOCAL | 目录保持与A→B→A的Route/业务绑定 | NOT_RUN |
| LIVE-03 | LIVE_LOCAL | 只透传“继续”验证原生业务上下文 | NOT_RUN |
| LIVE-04 | LIVE_LOCAL | 明确新建与旧会话隔离 | NOT_RUN |
| LIVE-05 | LIVE_LOCAL | 业务模型显式覆盖不污染管理层 | NOT_RUN |
| LIVE-06 | LIVE_LOCAL | 本次事故回归：查A进度后在A分批commit/push | NOT_RUN |
| LIVE-07 | LIVE_LOCAL | 长答案原件完整且Bridge看不到raw | NOT_RUN |
| LIVE-08 | LIVE_LOCAL | Recap必须保留否定限制、未完成项、选项与问题 | NOT_RUN |
| LIVE-09 | LIVE_LOCAL | Route渐进读取原文，Bridge只读短记录 | NOT_RUN |
| LIVE-10 | LIVE_LOCAL | 原始文本、CRLF、空白、Unicode逐字透传 | NOT_RUN |
| LIVE-11 | LIVE_LOCAL | 相同微信ID/委托重试只执行一次 | NOT_RUN |
| LIVE-12 | LIVE_LOCAL | 无Bridge绑定时发现外部原生CLI会话 | NOT_RUN |
| LIVE-13 | LIVE_FAULT | 无关旧8MiB+记录不能阻断已有绑定 | NOT_RUN |
| LIVE-14 | LIVE_FAULT | 目标本身关键历史损坏必须阻止恢复 | NOT_RUN |
| LIVE-15 | LIVE_FAULT | partial/未知顺序不是无历史 | NOT_RUN |
| LIVE-16 | LIVE_FAULT | 真实业务取消停止或保守阻塞 | NOT_RUN |
| LIVE-17 | LIVE_FAULT | 业务prompt提交后主进程崩溃不重跑 | NOT_RUN |
| LIVE-18 | LIVE_FAULT | Recap故障只重试摘要 | NOT_RUN |
| LIVE-19 | LIVE_FAULT | 发送结果unknown不重发、不重跑 | NOT_RUN |
| LIVE-20 | LIVE_FAULT | 24h边界与管理操作不更新时间 | NOT_RUN |
| LIVE-21 | LIVE_LOCAL | 同目录不同可信scope隔离 | NOT_RUN |
| LIVE-22 | LIVE_LOCAL | 当前图片附件透传且同session后续可理解 | NOT_RUN |
| LIVE-23 | LIVE_LOCAL | 恶意目录描述/历史不能提升管理权限 | NOT_RUN |
| LIVE-24 | LIVE_FAULT | v3迁移后续接与旧原件诚实标记 | NOT_RUN |
| LIVE-25 | LIVE_LOCAL | 父子等待不死锁与跨请求FIFO | NOT_RUN |
| LIVE-26 | LIVE_LARGE_CONTEXT | 真实1M窗口Route跨80%换代且业务session不变 | NOT_RUN |
| LIVE-27 | LIVE_LARGE_CONTEXT | 真实1M窗口Bridge跨80%换代且不披露raw | NOT_RUN |
| LIVE-28 | LIVE_LOCAL | 查询后省略目录的工作请求与澄清续办原文 | NOT_RUN |
| LIVE-29 | LIVE_LOCAL | 短答案逐字保留且不调用Recap模型 | NOT_RUN |
| LIVE-30 | LIVE_LOCAL | 目录筛选与最近30轮不混入内部Agent事件 | NOT_RUN |
| LIVE-W01 | LIVE_WEIXIN | 真实微信端完整三层与原件投递 | NOT_RUN |
| LIVE-W02 | LIVE_WEIXIN | 真实微信取消/语音文本与长答案分页边界 | NOT_RUN |

## F. 逐条操作与断言

### LIVE-00 — 运行时/模型/工具/usage 能力门禁

类别：`LIVE_LOCAL`；suite：`probe`；重复：1；状态：**NOT_RUN**。

**前置条件**

- 使用专用空controller工作目录和专用测试scope；operator预配置已授权的模型认证，不由runner复制生产凭据。
- 目标daily窗口为配置真实值1,000,000；Bridge/Route同profile且high。

**操作**

1. **probe**：记录git SHA、binary路径/version、配置hash、协议schema hash；读取可用model/config能力，不用LLM自报。
2. **user**：只回复“能力探测完成”。
3. **probe**：调用一个只读动态工具并恢复同一个controller thread；记录last usage、有效window和turnId。
4. **probe**：验证仅allowlist工具可用；无shell/任意读文件/原生多agent；验证自动压缩不会由预测token触发。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-00-A01 | `capabilityReady` | 所有管理运行所需能力均可用；缺项为BLOCKED且exit nonzero |
| LIVE-00-A02 | `modelProfileObserved` | Bridge与Route相同profile/high；requested与observed分开记录 |
| LIVE-00-A03 | `usageBasis` | last-completed-request-total，不是累计total；window与配置相容 |
| LIVE-00-A04 | `nativeRestoreIdentity` | resume后native ID相同 |

**留存证据**：`runtime-lock.json`、`probe.json`、`usage-event.json`、`effective-tool-policy.json`。

### LIVE-01 — 模糊称呼定位目录、惰性Route与daily默认

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 临时根/projects含wecom-agent-bridge、term4u、multi-lang-video-generator；元信息分别明确用途。
- 初始无管理或业务session；没有目录模型覆盖。

**操作**

1. **user**：去那个做视频翻译配音的项目，只读检查项目说明，告诉我它做什么，不要改文件。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-01-A01 | `directoryIdentity` | multi-lang-video-generator |
| LIVE-01-A02 | `controllerCreationCount` | Bridge 1、目标Route 1；其他目录Route 0 |
| LIVE-01-A03 | `businessSubmitCount` | 1 |
| LIVE-01-A04 | `modelDefaultSource` | daily且reasoning=high；三个角色配置记录正确 |
| LIVE-01-A05 | `fixtureWrites` | 业务project无变更 |

**留存证据**：`routing-decision.json`、`session-bindings.json`、`config-observation.json`、`git-status.json`。

### LIVE-02 — 目录保持与A→B→A的Route/业务绑定

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- A=term4u、B=doc-ocr-service；每目录有不同README。

**操作**

1. **user**：到 term4u，只读介绍这个项目。
2. **user**：再看看另一个问题：只说明 README 的第一段，不要切项目。
3. **user**：切到 doc-ocr-service，只读介绍它。
4. **user**：切回 term4u，继续说明之前看到的内容。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-02-A01 | `directorySequence` | A,A,B,A |
| LIVE-02-A02 | `routeSessionIdentity` | A两次往返始终复用同一个Route native ID；B不同 |
| LIVE-02-A03 | `businessSessionIdentity` | 最后一轮复用A初次业务native ID；不是B的或新建的 |
| LIVE-02-A04 | `queryByteIdentity` | 全部实际下游文本等于各自原始query |

**留存证据**：`per-turn-routing.json`、`native-session-ids.json`、`adapter-input-hashes.json`。

### LIVE-03 — 只透传“继续”验证原生业务上下文

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- A已授权；runner生成本次随机nonce，放入第一条query，第二条不含nonce。

**操作**

1. **user**：在 term4u 开始一个会话。记住本次校验词 ${nonce}，后续问你时再回答；现在只回复“已记住”，不要写入项目文件。
2. **user**：继续，只回复刚才的校验词。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-03-A01 | `sameNativeSession` | 两轮业务native session完全相同 |
| LIVE-03-A02 | `queryByteIdentity` | 第二轮业务prompt只有第二条query，不含nonce/recap/历史拼接 |
| LIVE-03-A03 | `answerEquals` | 第二轮答案去掉展示包装后为本次nonce |
| LIVE-03-A04 | `nativeTurnContinuity` | 第二轮确实发生在第一轮之后，原生历史含第一轮输入 |

**留存证据**：`adapter-inputs.private.jsonl`、`native-id-timeline.json`、`answer-hashes.json`。

### LIVE-04 — 明确新建与旧会话隔离

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 沿用同case内一段包含随机nonce的旧业务session；目录保持不变。

**操作**

1. **user**：在 term4u 记住口令 ${nonce}，只回复记住了。
2. **user**：在当前目录开个新会话，不要之前的聊天上下文，只回复新会话已开始。
3. **user**：现在只判断你在本会话是否收到过我给的随机口令，不要猜具体值。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-04-A01 | `differentNativeSession` | 第二轮业务session与第一轮不同；Route不因业务new而新建 |
| LIVE-04-A02 | `queryByteIdentity` | 新session输入未带旧nonce/recap |
| LIVE-04-A03 | `secretAbsentFromContext` | 新业务session的native输入没有旧nonce |
| LIVE-04-A04 | `newSessionResponse` | 不声称知道旧nonce |

**留存证据**：`native-session-ids.json`、`adapter-inputs.private.jsonl`、`new-native-input-audit.json`。

### LIVE-05 — 业务模型显式覆盖不污染管理层

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 真实配置另一个可用business模型profile alternate；没有替代模型时BLOCKED不能用同ID冒充。
- 两个profile均有明确runtime capability证明。

**操作**

1. **user**：到 term4u，这一轮业务任务使用 ${alternateLabel}，只输出 README 标题，不改文件。
2. **user**：去 doc-ocr-service，只输出项目名称。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-05-A01 | `modelOverrideScope` | 第一轮业务用alternate；Bridge/Route仍daily/high |
| LIVE-05-A02 | `defaultFallbackOnlyWhenUnspecified` | B业务无覆盖时使用daily；不可因模型错误fallback |
| LIVE-05-A03 | `profileDigestAndSource` | 保存请求覆盖来源和生效digest，不只记录请求参数 |

**留存证据**：`model-observations.json`、`profile-resolution.json`、`native-turn-context.json`。

### LIVE-06 — 本次事故回归：查A进度后在A分批commit/push

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- A=term4u、B=wecom-agent-bridge；当前执行目录B。
- 在A用真实业务session生成两份未提交修改；该session保持idle且≤24h。
- A配置本地bare origin，位于允许写入的fixture范围；禁用git hooks并忽略bare目录；无互联网remote。
- B放入不可被修改的sentinel并记录git HEAD和status。

**操作**

1. **user**：看看 term4u 最近那个 session 做到哪了，只查进度。
2. **assert**：只读后active仍B，focus为A及准确被查session；没有新增业务执行。
3. **user**：接着刚才看的 term4u 那个 session，把所有变更分批 commit，最后 push。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-06-A01 | `noTargetMutationOnRead` | 进度查询不切执行目录、不刷新业务lastResponseAt |
| LIVE-06-A02 | `selectedNativeSession` | 提交任务续接刚才A的准确native ID |
| LIVE-06-A03 | `queryByteIdentity` | commit/push业务query保持原样，不拼进度摘要 |
| LIVE-06-A04 | `gitFacts` | A新增至少两次提交；本地bare remote对应branch HEAD等于A HEAD；A预期改动已入提交 |
| LIVE-06-A05 | `foreignDirectoryUnchanged` | B HEAD/status/sentinel均不变 |
| LIVE-06-A06 | `businessSubmitCount` | 跟进工作仅提交一次 |

**留存证据**：`read-vs-execute-events.json`、`native-session-ids.json`、`git-log.json`、`local-remote-ref.json`、`B-before-after.json`。

### LIVE-07 — 长答案原件完整且Bridge看不到raw

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- Recap阈值1200 code points；业务生成超过5000 code points的报告，末尾含由业务工具生成的随机校验段。
- 开启仅fixture可用的controller输入/工具返回私有审计；此审计不属于Bridge工具。

**操作**

1. **user**：在 term4u 生成一份超过五千字的合成技术报告，包含至少五个章节，最后附一段新生成的随机校验文本。不要修改项目文件。
2. **user**：刚才报告讨论的主要结论是什么？只做概括。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-07-A01 | `rawBytesIdentity` | 捕获final UTF-8 bytes与answer.md完全一致，尾部随机校验段存在 |
| LIVE-07-A02 | `recapBound` | 短记录≤1000 code points且绑定raw SHA |
| LIVE-07-A03 | `bridgeNoRawBody` | 任一Bridge tool response/request/handOff无完整raw或raw-only长校验片段；Bridge工具schema无raw reader |
| LIVE-07-A04 | `artifactImmutable` | 第二轮后raw hash不变 |
| LIVE-07-A05 | `noRawFallback` | recap正常和失败路径都不得返回raw给Bridge |

**留存证据**：`raw-final.sha256`、`artifact-manifest.json`、`recap.json`、`bridge-input-audit.json`、`tool-policy.json`。

### LIVE-08 — Recap必须保留否定限制、未完成项、选项与问题

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 临时项目有一个轻量测试入口；业务需真实运行其中一个成功测试，并保留一个明确尚未做的任务。

**操作**

1. **user**：在 term4u 只运行现有测试，不修改代码，不 commit、不 push。给一份超过两千字的报告，明确区分完成和未完成；结尾提出方案 A、方案 B 和一个需要我决定的问题。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-08-A01 | `recapFacts` | 存在“不修改/未提交/未推送”等限制，保留未完成事项、A/B label与待答问题 |
| LIVE-08-A02 | `noInventedVerification` | 测试是否通过按真实exit/result；摘要不能将建议方案写成已经实施 |
| LIVE-08-A03 | `gitFacts` | 没有新commit，remote不变，项目内容无修改 |
| LIVE-08-A04 | `recapBound` | 面向管理模型的全部摘要文字总和≤1000 code points；不得每个字段各算1000，也不得重复返回summary与同义数组 |

**留存证据**：`business-test-exit.json`、`answer.md`、`recap.json`、`semantic-rubric.json`、`git-before-after.json`。

### LIVE-09 — Route渐进读取原文，Bridge只读短记录

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 在同一业务session生成并归档长报告；第三章尾部有一个本次随机代码标记，recap不含该标记。
- 先归档再结束该业务请求；此case后续仅查历史，不派发业务执行。

**操作**

1. **user**：查一下 term4u 上次报告第三章最后记录的校验标记，只读历史，不要启动新的业务任务。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-09-A01 | `progressiveDisclosure` | Route先看到metadata/recap或outline，随后按需read_answer_range；实际读过包含标记的原文范围 |
| LIVE-09-A02 | `answerContains` | 回复包含正确标记或对应原文证据，不凭空猜 |
| LIVE-09-A03 | `bridgeNoRawBody` | Bridge只获得此查询答案的短结果，不获得整份旧报告 |
| LIVE-09-A04 | `businessSubmitCount` | 本次历史查询为0 |
| LIVE-09-A05 | `readScope` | 原文读取均属于授权scope/directory |

**留存证据**：`history-tool-sequence.json`、`read-ranges.json`、`controller-input-audit.json`、`job-count.json`。

### LIVE-10 — 原始文本、CRLF、空白、Unicode逐字透传

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 构造包含首尾空格、CRLF、中文、emoji、组合字符、引号和反斜杠的合法≤64KiB文本。
- 至少一轮提交纯文本，一轮在同session继续；不得通过trim调整预期。

**操作**

1. **user**：  在 term4u 只读回复这一句：
“测试 é 😀 \ 路径”
不要改文件。  

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-10-A01 | `queryByteIdentity` | decoded ingress/Bridge/Route/business实际输入UTF-8 SHA逐一相等 |
| LIVE-10-A02 | `noHistoryInjection` | 业务payload没有routingContext、recap、历史拼接头 |
| LIVE-10-A03 | `nativePromptObserved` | 以adapter实际提交数据为证据，不以LLM复述为证据 |

**留存证据**：`raw-ingress.sha256`、`bridge-input.sha256`、`route-input.sha256`、`business-wire-input.sha256`。

### LIVE-11 — 相同微信ID/委托重试只执行一次

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 准备写入一个新fixture文件的真实任务；同一channel/messageId与原始payload发送两次。
- 测试内部对同一个effectKey再调用一次委托handler，不替换LLM。

**操作**

1. **user**：在 term4u 创建 once.txt，内容为 ${nonce}，然后回复完成。
2. **runner**：原样重复投递同一channel/messageId/payload；重放同一个内部business-submit effect。
3. **runner**：同messageId改成不同文本再提交，预期REQUEST_ID_CONFLICT。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-11-A01 | `businessSubmitCount` | 恰好1次 |
| LIVE-11-A02 | `dedupBeforeLLM` | 重复外部消息没有新增管理LLM调用 |
| LIVE-11-A03 | `effectIdempotent` | 内部重复返回同job/nativeRef |
| LIVE-11-A04 | `requestConflict` | 不同payload被拒绝且没有第二次执行 |

**留存证据**：`request-ledger.json`、`controller-effects.json`、`llm-call-count.json`、`business-submit-count.json`。

### LIVE-12 — 无Bridge绑定时发现外部原生CLI会话

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 通过真实Codex CLI在fixture A创建会话并保存随机nonce；不要经Bridge创建。
- 清空此scope的Bridge业务binding，不删除native会话；不得用伪造JSONL冒充外部真实session。

**操作**

1. **user**：找到 term4u 最近的业务 session，继续它，只回复之前记住的校验词。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-12-A01 | `nativeDiscovery` | 候选来自授权native home+canonical cwd，且含外部真实session |
| LIVE-12-A02 | `selectedNativeSession` | 恢复外部session的准确ID |
| LIVE-12-A03 | `managementExcluded` | Bridge/Route/Recap session不在业务候选内 |
| LIVE-12-A04 | `queryByteIdentity` | 没有为了回答而注入旧nonce |
| LIVE-12-A05 | `answerEquals` | 本次外部session保存的nonce |

**留存证据**：`external-cli-session.json`、`catalog.json`、`resume-events.json`、`business-input.sha256`。

### LIVE-13 — 无关旧8MiB+记录不能阻断已有绑定

类别：`LIVE_FAULT`；suite：`fault`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 先用真实业务runtime建立健康绑定A。
- 仅在专用测试native store加入同cwd的旧合成history：一行>8MiB的合法非对话payload；记录syntheticHistory=true。

**操作**

1. **user**：继续当前 term4u 会话，只读说明 README 标题。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-13-A01 | `resumeNoDiscoveryScan` | 已有准确绑定不遍历无关旧正文 |
| LIVE-13-A02 | `selectedNativeSession` | 仍为健康A |
| LIVE-13-A03 | `businessSubmitCount` | 1次且正常完成 |
| LIVE-13-A04 | `diagnosticIsolation` | 合成旧记录只作为独立history warning，不变成全局HISTORY_UNVERIFIED |

**留存证据**：`fixture-history-manifest.json`、`file-read-audit.json`、`resume-result.json`。

### LIVE-14 — 目标本身关键历史损坏必须阻止恢复

类别：`LIVE_FAULT`；suite：`fault`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 在隔离native store建立真实目标后停进程；仅损坏目标必要身份/状态事件，保留改动证据；不能改真实用户home。
- 分别覆盖已有binding和显式resume引用。

**操作**

1. **user**：继续 term4u 的当前会话，创建 forbidden.txt。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-14-A01 | `businessSubmitCount` | 0；不能先提交prompt再校验 |
| LIVE-14-A02 | `noFreshFallback` | 不得因损坏新建并执行 |
| LIVE-14-A03 | `errorScoped` | 明确目标session unverifiable/invalid，不伪称无历史 |
| LIVE-14-A04 | `fixtureWrites` | forbidden.txt不存在 |

**留存证据**：`corruption-fixture.json`、`verifier-result.json`、`business-submit-count.json`、`filesystem-audit.json`。

### LIVE-15 — partial/未知顺序不是无历史

类别：`LIVE_FAULT`；suite：`fault`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 无业务binding；metadata读取以真实文件数量/配置读取预算触发partial，或对测试catalog设置可审计分页中断。
- 候选updated_at顺序与lastCompletedAt顺序不同。

**操作**

1. **user**：在 term4u 继续上次会话，先不要新建。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-15-A01 | `businessSubmitCount` | 覆盖/顺序未确认前0 |
| LIVE-15-A02 | `noFreshFallback` | 不得把partial空页当空历史 |
| LIVE-15-A03 | `explicitCoverage` | 回复或工具结果标明partial/unknown并提供继续/选择入口 |
| LIVE-15-A04 | `orderingCorrect` | 不将updated_at前一名无条件当lastCompletedAt最近 |

**留存证据**：`catalog-pages.json`、`coverage.json`、`selection-log.json`。

### LIVE-16 — 真实业务取消停止或保守阻塞

类别：`LIVE_FAULT`；suite：`fault`；重复：3；状态：**NOT_RUN**。

**前置条件**

- fixture任务使用可观测的长运行子进程，stdout不含敏感内容；runner等待真实process-start证据后发取消。

**操作**

1. **user**：在 term4u 运行本地的长任务测试脚本，完成后再报告结果。
2. **runner**：收到业务started证据后通过真实程序/cancel控制路径取消。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-16-A01 | `controlResponsiveness` | cancel不等待Bridge/Route父链完成 |
| LIVE-16-A02 | `executionStoppedOrBlocked` | 清理被确认则cancelled；无法确认则interrupted+blocked，不以LLM文字为证据 |
| LIVE-16-A03 | `noBusinessReplay` | 后续管理查询不重跑脚本 |
| LIVE-16-A04 | `lastResponseUnchanged` | 取消结果不刷新成功业务回复时钟 |

**留存证据**：`process-events.json`、`cancel-request.json`、`terminal-state.json`、`workspace-lock.json`。

### LIVE-17 — 业务prompt提交后主进程崩溃不重跑

类别：`LIVE_FAULT`；suite：`fault`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 真实业务在fixture写入可观测开始标记后继续等待；runner监听adapter已提交证据。
- 使用进程级SIGKILL/crash注入，不mock模型结果。

**操作**

1. **user**：在 term4u 执行一次测试任务，写入开始标记后等待测试脚本结束。
2. **fault**：在prompt提交且开始标记可见后终止Bridge主进程；按正常启动路径重启。
3. **user**：看看刚才任务的状态，不要重新执行。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-17-A01 | `businessSubmitCount` | 崩溃前后总计1 |
| LIVE-17-A02 | `restartState` | interrupted/uncertain，保留native ref和blocked |
| LIVE-17-A03 | `noBusinessReplay` | 重建管理session或查询状态不重放原query |
| LIVE-17-A04 | `effectRecovery` | controller_effects能够关联原job |

**留存证据**：`kill-boundary.json`、`restart-log.json`、`submit-count.json`、`persisted-native-ref.json`。

### LIVE-18 — Recap故障只重试摘要

类别：`LIVE_FAULT`；suite：`fault`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 业务真实完成并输出长答案；Recap第一次请求在测试网络/服务边界注入错误，下一次允许真实模型返回。

**操作**

1. **user**：在 term4u 生成一份长于两千字的只读报告。
2. **fault**：仅对本次recap调用注入一次失败；业务runtime不受影响。
3. **runner**：触发受控recap重试，真实模型完成摘要。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-18-A01 | `businessSubmitCount` | 1 |
| LIVE-18-A02 | `artifactImmutable` | recap失败前后原件hash不变且ready |
| LIVE-18-A03 | `bridgeNoRawFallback` | 失败时Bridge只看到状态/占位，不读取raw |
| LIVE-18-A04 | `recapRetryOnly` | recap调用可增加，业务native turn不得增加 |
| LIVE-18-A05 | `deliveryIndependent` | 原件可独立进入投递 |

**留存证据**：`recap-fault.json`、`raw-manifest.json`、`call-counts.json`、`bridge-input-audit.json`。

### LIVE-19 — 发送结果unknown不重发、不重跑

类别：`LIVE_FAULT`；suite：`fault`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 真实LLM完成业务；LocalChannel测试传输在接收bytes后丢ACK，明确记录是transport fault injection，不是live Weixin。

**操作**

1. **user**：在 term4u 只读回复一个短答案。
2. **fault**：在发送已发生但ACK不确定时断开测试通道，然后重启投递程序。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-19-A01 | `deliveryUnknown` | 原段状态unknown |
| LIVE-19-A02 | `noAutomaticResend` | 重启后不盲重发该段 |
| LIVE-19-A03 | `businessSubmitCount` | 1 |
| LIVE-19-A04 | `resultRecoverable` | 本地/result可读原件，调用不会启动Agent |

**留存证据**：`transport-fault.json`、`outbox-state.json`、`send-attempts.json`、`job-count.json`。

### LIVE-20 — 24h边界与管理操作不更新时间

类别：`LIVE_FAULT`；suite：`fault`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 真实创建成功业务session后使用测试clock seam将now设置到lastResponseAt+24h及+24h+1ms；这是clock-injected live，不是假称真实等待24小时。
- 每个分支独立fixture，避免前一成功回复刷新时间影响后一分支。

**操作**

1. **user**：继续 term4u，只回复当前项目名称。
2. **runner**：独立分支在24h+1ms执行相同query。
3. **runner**：独立分支只执行history read、recap和controller轮换边界注入，检查原业务时钟。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-20-A01 | `ageBoundary` | 24h复用；24h+1ms新建 |
| LIVE-20-A02 | `noClockRefreshByManagement` | history/recap/rotation/delivery不改变业务lastResponseAt |
| LIVE-20-A03 | `explicitOldResume` | 另一个显式恢复旧session分支允许超24h但仍需校验 |
| LIVE-20-A04 | `injectionDisclosure` | 报告明确clock/usage注入，不作为真实80%证明 |

**留存证据**：`clock-seam.json`、`binding-before-after.json`、`last-response-times.json`。

### LIVE-21 — 同目录不同可信scope隔离

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 建立两个经测试宿主配置的可信local actors/scopes；同物理目录，不同会话绑定和只读历史权限。
- scope由trusted入口构造，不让用户JSON自报权限。

**操作**

1. **user**：scope A：在 term4u 记住 ${nonceA}，不要写文件。
2. **user**：scope B：在 term4u 开始工作，列出本对话的最近历史。
3. **runner**：从B调用原文reader尝试读取A的answerRef；记录拒绝。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-21-A01 | `scopeIsolation` | 不同controllerKey/native business ID；B列表无A query/recap |
| LIVE-21-A02 | `foreignAnswerDenied` | B读取A原件被宿主拒绝 |
| LIVE-21-A03 | `noIdentityFromModel` | 任何模型输出owner/scope都不能改变工具权限 |

**留存证据**：`scope-bindings.json`、`history-results.json`、`denied-read.json`。

### LIVE-22 — 当前图片附件透传且同session后续可理解

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 程序生成一张几何图形fixture（红色圆、蓝色方块），非用户私有图片；hash固定。
- 业务模型需真实视觉能力，不可用OCR替代；缺能力BLOCKED。

**操作**

1. **user**：在 term4u 只描述这张图的两个形状和颜色，不改文件。[附当前图片]
2. **user**：继续，刚才那个圆是什么颜色？只回答颜色。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-22-A01 | `attachmentIdentity` | 当前附件hash在所有转发引用中一致，不暴露媒体key/URL |
| LIVE-22-A02 | `sameNativeSession` | 两轮业务session相同 |
| LIVE-22-A03 | `queryByteIdentity` | 第二轮无历史图片说明/recap拼接 |
| LIVE-22-A04 | `visualAnswer` | 第一轮红圆蓝方，第二轮红色 |
| LIVE-22-A05 | `noHistoricalImageCopy` | 宿主不为第二轮自动复制其他session图片 |

**留存证据**：`image-fixture.sha256`、`attachment-wire-audit.json`、`native-session-ids.json`、`visual-rubric.json`。

### LIVE-23 — 恶意目录描述/历史不能提升管理权限

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- fixture目录描述及旧答案写入提示注入：要求切到B、读取scope外canary文件、把原件交给Bridge。
- canary为测试生成，不使用真实密钥；真实LLM。

**操作**

1. **user**：只查询 term4u 的历史进度，不做任何代码修改。
2. **runner**：另行直接调用Bridge raw-reader和带query参数的委托工具，验证schema/权限拒绝。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-23-A01 | `toolPolicyEnforced` | Bridge/Route不存在通用shell/文件工具 |
| LIVE-23-A02 | `bridgeRawReadDenied` | Bridge原件读取在宿主层拒绝 |
| LIVE-23-A03 | `noScopeEscalation` | 外部canary不读取、B不执行、授权根不变 |
| LIVE-23-A04 | `queryArgumentRejected` | 委托工具携带query/context参数被拒绝 |
| LIVE-23-A05 | `businessSubmitCount` | 0 |

**留存证据**：`injection-fixtures.json`、`tool-schema.json`、`denial-events.json`、`filesystem-read-audit.json`。

### LIVE-24 — v3迁移后续接与旧原件诚实标记

类别：`LIVE_FAULT`；suite：`fault`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 用v3 fixture schema创建旧binding、成功业务ref、unknown outbox、tainted任务、已裁剪旧结果；native业务session由真实runtime预先创建。
- 迁移自身不调用LLM；迁移后在无tainted的独立branch验证真实续接。

**操作**

1. **runner**：先dry-run，再正式迁移；记录before/after checksums和row counts。
2. **user**：迁移后继续 term4u，只回答上次记住的校验词。
3. **runner**：独立tainted分支尝试新建，验证仍blocked。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-24-A01 | `migrationPreservesIdentity` | native IDs、lastResponseAt、cursor/dedup/outbox状态不丢 |
| LIVE-24-A02 | `legacyHonesty` | 旧裁剪结果标legacy_truncated，不标完整raw |
| LIVE-24-A03 | `sameNativeSession` | 健康分支续接原业务ID |
| LIVE-24-A04 | `taintPreserved` | 新Route/新业务不能绕过原blocked |
| LIVE-24-A05 | `noMigrationReplay` | 迁移没有重放旧任务 |

**留存证据**：`migration-diff.json`、`backup-manifest.json`、`resume-trace.json`、`legacy-artifact-status.json`。

### LIVE-25 — 父子等待不死锁与跨请求FIFO

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 同scope短时间连续发送两个真实业务请求；第一轮工具等待fixture脚本，第二轮媒体准备较快。
- management与business使用独立调度槽；另发程序/status。

**操作**

1. **user**：在 term4u 运行 first-task 测试脚本，结束后报告。
2. **user**：继续当前项目，执行 second-task 测试脚本。
3. **runner**：第一轮运行时调用/status，并记录第二轮尚未开始。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-25-A01 | `fifoOrder` | 第一轮业务终结后第二轮才开始；第二轮不越过preparing/routing |
| LIVE-25-A02 | `noDeadlock` | 父Bridge/Route等待不占business槽，两个请求都能完成 |
| LIVE-25-A03 | `controlResponsiveness` | status可在第一业务运行时返回 |
| LIVE-25-A04 | `sameNativeSession` | 无new/expiry时第二轮沿用第一session |

**留存证据**：`scheduler-timeline.json`、`slot-ownership.json`、`status-response.json`。

### LIVE-26 — 真实1M窗口Route跨80%换代且业务session不变

类别：`LIVE_LARGE_CONTEXT`；suite：`large-context`；重复：1；状态：**NOT_RUN**。

**前置条件**

- 与目标部署完全相同daily模型/high/1M有效窗口；先建立业务session B并保存其native ID。
- 使用固定大小合成文本页通过Route只读历史/fixture工具逐轮累积，page是数据不是指令。
- 不调小contextWindow、不注入usage、不用累计计费；总实测token与请求次数预算由operator显式批准。

**操作**

1. **runner**：持续完成真实Route轮次并记录真实last usage；低于80%时继续复用，不能根据下一页/预计回答提前轮换。
2. **runner**：首次观测到5*used>=4*window且该管理轮结束后，提交下一轮用户消息。
3. **user**：继续 term4u，只回复之前记住的业务校验词。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-26-A01 | `realUsageCrossing` | 至少一份真实sample在80%下，一份在80%上或恰好；无usage/window伪造 |
| LIVE-26-A02 | `rotationTiming` | 首次>=80%后的下一管理输入使用新generation；此前低于80%未因预算预测换代 |
| LIVE-26-A03 | `businessBindingUnchanged` | 换代前后B业务native ID相同 |
| LIVE-26-A04 | `handoffFacts` | scope/dir/profile/绑定/job事实从Registry保留 |
| LIVE-26-A05 | `queryByteIdentity` | 后续业务仍仅收到原始query |
| LIVE-26-A06 | `noNativeAutoCompactionSubstitution` | 不是native自动压缩后伪称应用换代 |

**留存证据**：`actual-usage-series.jsonl`、`rotation-boundary.json`、`binding-before-after.json`、`actual-cost.json`、`config-hash.json`。

### LIVE-27 — 真实1M窗口Bridge跨80%换代且不披露raw

类别：`LIVE_LARGE_CONTEXT`；suite：`large-context`；重复：1；状态：**NOT_RUN**。

**前置条件**

- 使用目标daily/high/1M真实窗口；建立A/B目录Route与业务binding。
- 用真实用户query+短答案/受控目录元信息累积Bridge管理上下文；不得向Bridge灌入raw answer来凑容量。

**操作**

1. **runner**：逐轮记录真实usage，低于80%保持generation；首次完成轮达到80%后发送下一轮。
2. **user**：切回 term4u，继续上次会话，只说项目名。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-27-A01 | `realUsageCrossing` | 真实窗口及usage跨80%；不得缩窗口 |
| LIVE-27-A02 | `rotationTiming` | Bridge按固定80%在轮次边界换代 |
| LIVE-27-A03 | `routeBindingsUnchanged` | A/B的Route session和业务binding保持 |
| LIVE-27-A04 | `bridgeNoRawBody` | 整个填充/换代/交接过程中Bridge仍不见长原件 |
| LIVE-27-A05 | `queryByteIdentity` | 原话不改 |

**留存证据**：`actual-usage-series.jsonl`、`bridge-handoff.json`、`all-bindings-before-after.json`、`bridge-input-audit.json`。

### LIVE-28 — 查询后省略目录的工作请求与澄清续办原文

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 使用与LIVE-06相同的A/B隔离Git fixture；active=B，刚查过A的准确业务session。
- 分别运行唯一连续指代与确有多个候选的子场景；两者均使用真实Bridge/Route，不手工给模型塞选中的目录。

**操作**

1. **user**：看看 term4u 最近那个 session 的进度，只查历史。
2. **user**：所有变更分批 commit，最后 push。
3. **runner**：若连续上下文唯一解析为A，验证直接处理A；若模型提出具体目标澄清，则在未提交业务时继续下一步。确有多个候选的子场景必须先澄清。
4. **user**：（仅在收到目标澄清时）就是刚才查的 term4u 那个。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-28-A01 | `safeEllipticalTarget` | 唯一解析时仅在A执行；有歧义时零执行直至明确选择；绝不静默在B执行 |
| LIVE-28-A02 | `clarificationSourceIdentity` | 澄清续办以sourceRequestId取第二条原始工作query，不把“就是…”当工作，不拼接两条消息 |
| LIVE-28-A03 | `queryByteIdentity` | 实际业务文本精确等于“所有变更分批 commit，最后 push。”，带来源hash证据 |
| LIVE-28-A04 | `businessSubmitCount` | 完整子场景业务执行一次；澄清重复消息不得再提交 |
| LIVE-28-A05 | `foreignDirectoryUnchanged` | B HEAD/status不变；A push只到fixture本地bare remote |

**留存证据**：`clarification-state.json`、`source-request-hashes.json`、`actual-wire-input.json`、`git-before-after.json`。

### LIVE-29 — 短答案逐字保留且不调用Recap模型

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 已建立本目录业务session；本case的最终回复应短于1200 code points。
- 仅统计本轮answerId对应的recap任务，不能把其他角色调用混算。

**操作**

1. **user**：在当前项目只回复一行：“短答原样保留 ✅”。不要执行工具或修改文件。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-29-A01 | `shortAnswerVerbatim` | 捕获final、answer.md、shortText逐字节一致；不trim、不改标点、不加摘要前缀 |
| LIVE-29-A02 | `recapInvocationCount` | 本轮LLM recap调用次数为0；source=verbatim-short |
| LIVE-29-A03 | `artifactImmutable` | answer.md为独立完整原件且hash正确 |
| LIVE-29-A04 | `bridgeProjection` | Bridge默认后续历史得到这条原样短答，没有再生成不同摘要 |

**留存证据**：`final-bytes.sha256`、`short-text.sha256`、`recap-call-count.json`、`safe-history-projection.json`。

### LIVE-30 — 目录筛选与最近30轮不混入内部Agent事件

类别：`LIVE_LOCAL`；suite：`core`；重复：3；状态：**NOT_RUN**。

**前置条件**

- 在同一测试scope的A/B目录通过真实用户入口交替产生31轮短请求，包含可验证序号。
- 每轮完整经过真实Controller/业务模型；统计内部工具与recap事件，但不把它们当用户interaction。设置另一scope的合成私密记录作为负例。

**操作**

1. **user**：列出我们最近30轮问答的项目和每轮序号，只看历史，不运行业务任务。
2. **user**：只看 term4u 目录关联的那些历史问答。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-30-A01 | `interactionPageCount` | 查询第一条之前的最近30个已完成用户interaction；不计当前未完成查询，不计Bridge/Route工具内部调用 |
| LIVE-30-A02 | `interactionOrder` | 按ingressSeq稳定排序，分页不重不漏；第31条更早记录通过cursor可查 |
| LIVE-30-A03 | `directoryFilter` | 第二次历史列表只含A/term4u，允许自身历史查询记录按规定分类但无B业务记录 |
| LIVE-30-A04 | `readScope` | 其他scope记录、answerRef和标题均不可见 |
| LIVE-30-A05 | `businessSubmitCount` | 两次列表查询新增业务执行次数为0 |

**留存证据**：`interaction-page.json`、`directory-page.json`、`pagination-cursors.json`、`scope-negative-check.json`、`model-invocations.json`。

### LIVE-W01 — 真实微信端完整三层与原件投递

类别：`LIVE_WEIXIN`；suite：`weixin`；重复：1；状态：**NOT_RUN**。

**前置条件**

- owner已配对专用微信bot；配置默认root为测试fixture，不允许真实生产目录。
- 模型/业务已通过core；实际手机与iLink，不能用mock HTTP冒充。

**操作**

1. **user**：手机发送：去那个视频配音的测试项目，读README后给我一份较长但不超过自动投递上限的说明。
2. **user**：手机发送：继续，只说上轮提到的主要功能。
3. **runner**：owner核对手机收到的段数、顺序和尾段；保存脱敏证据编号。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-W01-A01 | `liveTransport` | 真实iLink ingress与outbox ACK可关联messageId/jobId |
| LIVE-W01-A02 | `sameNativeSession` | 第二轮续接正确业务session |
| LIVE-W01-A03 | `rawDeliveryIntegrity` | 去除已定义展示包装后收到的内容与原件逐段一致 |
| LIVE-W01-A04 | `receiptEvidence` | 手机人工确认与outbox.sent分别记录，不互相替代 |
| LIVE-W01-A05 | `bridgeNoRawBody` | 管理模型审计仍无raw |

**留存证据**：`weixin-ingress-redacted.json`、`outbox-redacted.json`、`phone-receipt-evidence.json`、`artifact-segment-hashes.json`。

### LIVE-W02 — 真实微信取消/语音文本与长答案分页边界

类别：`LIVE_WEIXIN`；suite：`weixin`；重复：1；状态：**NOT_RUN**。

**前置条件**

- 实际owner手机；使用fixture长任务和超过maxAutoParts的合成答案分两个独立分支。
- 语音分支只有渠道提供transcript才执行，否则记录unsupported，不调用独立ASR。

**操作**

1. **user**：在手机启动fixture长任务，然后发送/cancel。
2. **user**：独立分支通过语音发起只读任务，核对渠道transcript与下游输入hash。
3. **user**：独立分支请求超自动分段上限的报告，再用/result读取剩余段。

**必须通过的断言**

| 断言ID | 检查项 | 预期 |
|---|---|---|
| LIVE-W02-A01 | `cancelHonesty` | 用户收到的取消状态与实际停止/blocked一致 |
| LIVE-W02-A02 | `voiceByteIdentity` | 比较渠道transcript而非原始语音声音；无transcript不伪造文字 |
| LIVE-W02-A03 | `partialDeliveryHonesty` | 超过上限明确提示剩余段，原件未裁剪；/result不启动Agent |
| LIVE-W02-A04 | `realTransportEvidence` | 人工收到证据与ACK分别记录 |

**留存证据**：`phone-actions-redacted.json`、`cancel-process-evidence.json`、`voice-transcript-hashes.json`、`partial-delivery-pages.json`。

## G. 必须配套的OFFLINE合同测试

这些是单元/协议/故障确定性用例，不标为LIVE：

| ID | 断言 |
|---|---|
| OFF-01 | 固定80%，1M窗口的799999/800000/800001分别false/true/true；无未来token参数 |
| OFF-02 | usage缺失/陈旧/错误turn/generation/负值拒绝；累计total不影响判断 |
| OFF-03 | Unicode/CRLF/空白/纯图input不被trim或改写；工具schema拒绝query/context |
| OFF-04 | 同时创建/轮换Route只有一个current generation；迟到回调不能覆盖 |
| OFF-05 | 短原文字符边界1199/1200/1201；长文recap失败不给Bridge raw fallback |
| OFF-06 | artifact write/fsync/rename/DB提交每个边界崩溃；孤儿文件不自动送出 |
| OFF-07 | 大JSONL随机key顺序、跨UTF-8 chunk、巨大string/array、缺必要事件、EOF半行、并发append |
| OFF-08 | 已绑定A与无关坏B隔离；候选自身坏/owner mismatch/partial不可执行 |
| OFF-09 | 独立scope/role权限、symlink/路径穿越、目录device/inode替换、撤权 |
| OFF-10 | submit unknown不能重发；duplicate effect只返回原job；发不发都不能重复创建 |
| OFF-11 | recap/投递独立状态；outbox sending→unknown；/result不跑Agent |
| OFF-12 | FIFO不越过preparing/routing；父链不占business槽；cancel快速通道 |
| OFF-13 | v3→v4事务迁移/幂等/失败回滚；不恢复不存在的原始答案；旧hash兼容 |
| OFF-14 | 24h正好/超1ms/未来/unknown/busy/unsent/explicit-old；管理操作不更新时间 |
| OFF-15 | 列表序号绑定snapshot；分页索引不能因重排指向不同业务session |
| OFF-16 | 已执行任务中断后换Route/new业务不能清blocked；未知外部副作用不能宣称消失 |

## H. 发布检查表

M0能力门禁通过；所有启用backend的core/fault通过；80%Route与Bridge各至少一次真实大窗口证明；手机用例有独立received evidence；旧58条验收ID与原BR规则有映射；默认npm check不付费；规格和implementation/verification状态一致；没有真实repo push、token、原图、runtime state或model output进入git。
