# Live runner 状态

`npm run test:live` 已提供参数校验、完整用例目录、M0 前置检查和逐断言报告。LIVE-01/02/03/04/10/22/29 已接入独立只读 fixture、生产 `openService` 和部分硬断言；LIVE-11 已接入临时项目写入与重复委托测试；LIVE-25 接入媒体准备乱序/FIFO/状态响应，LIVE-16 接入真实长任务取消，LIVE-21 接入同目录的两个可信本地会话隔离；LIVE-30 已接入真实 31 轮交互准备与历史查询；LIVE-14 已接入隔离 native 历史损坏及拒绝恢复；LIVE-19 已接入 LocalChannel ACK 丢失与服务重启；LIVE-18 已接入 Recap 服务故障和真实独立重试。**其余场景 adapter 和部分 predicate oracle 尚未完成，不能将此入口称为完整 live 验收。**

```bash
npm run test:live -- --live --config /private/path/config.json --suite core --repeat 3 --out /private/path/evidence
```

可用 `--case LIVE-10` 定向执行单个用例；报告明确 `selectedCases` 和 `fullSuite=false`，不能当作整套通过。每个 attempt 开始前检查至少 2 GiB 可用空间，不足则停止新调用并记录 `LIVE_DISK_RESERVE`。core/fault 固定三次，probe 继续使用 `probe:controller`。large-context 还要求单独 opt-in 与调用/token 预算；weixin 要求独立 opt-in。当前任务按用户指示不运行 1M/80% 长测。

LIVE-11 还要求 `--allow-fixture-writes`。它只配置新建 fixture 为 `workspace-write`，关闭业务网络；真实 Codex 负责创建 `once.txt`。runner 对第一次 `business_execute` 重放同一真实宿主 handler，统计实际管理入口与 Codex backend 调用，不替换模型、runtime 或业务返回值。已用 OFFLINE 三层 double 检查注入、去重及恢复仪表；真实 LIVE-11 已执行一次完整业务写入与重复委托：四项核心断言及披露/宿主重放检查通过，远端写入检查仍缺覆盖；后续两次被 native 隐式项目授权写配置而拦住；显式临时 untrusted 内联表策略已在新 fixture 完成三次，核心及已有全局断言全部通过，共享配置未变；写工具的远端写入 oracle 仍缺覆盖，case 保持 BLOCKED。详细失败与修复记录见实现状态。

报告包含原始 case/assertion ID、预期、状态、前置阻塞原因、代码 SHA、工作树是否有修改、编译候选文件与 package-lock 哈希、配置 hash 和 requested models。每次生成新的 evidence 目录，保留失败记录；缺证据、缺断言、NOT_RUN、BLOCKED 都不能变成 PASS。同一 assertion ID 也不能改换 predicate 或 expected；即使同组有 BLOCKED，个别 PASS 仍必须有证据。runner 核对 PASS 引用的文件非空、在本 attempt 内且非符号链接，并记录 SHA-256。用例 JSON 不作为 JavaScript 或 shell 执行。

每个已运行 adapter 明确返回清理状态；未确认清理时，本次判 FAIL，余下 attempt 记为 `LIVE_PREVIOUS_CLEANUP_UNVERIFIED`，不继续启动模型。

Bridge 披露 oracle 现在要求：管理轮已完成且 native 策略校验成立、全部成功宿主工具返回均有对应的序列化哈希、委托与交互历史投影已通过字段和长度检查。旧记录缺其中任一类证据时仍 BLOCKED，不能仅用“配置要求关闭工具”推断实际模型输入安全。缺审计证据的旧 attempt 保持 BLOCKED。

业务重放 oracle 使用持久化 prompt 准入记录、实际提交哈希和 durable effect 关联；重复准入会记录拒绝并在写 stdin 前失败。证据说明是否实际经过 uncertain 分支，不把普通成功用例称为故障恢复覆盖，也不宣称模型提供方远端 exactly-once。旧 attempt 没有此准入记录时保留 BLOCKED。

旧 runtime 的实际预检覆盖 core 的 19 个用例 × 3 次：57 个计划 attempt 全部因 M0 未通过而 BLOCKED，**没有执行对应模型场景**。现在独立兼容候选已通过 M0，已接入的场景正在调用真实服务，检查 DB、实际提交 hash、原件与 Git 状态；缺少原生上下文审计或完整安全观测的 predicate 仍返回 BLOCKED。未实现的场景仍返回 `LIVE_SCENARIO_ADAPTER_NOT_IMPLEMENTED`，不会用空操作或 fake 替代。

2026-09-24 重新执行 core 预检，包含 fixture-write opt-in，结果仍为 57/57 BLOCKED。诊断分类修正后，最新原因为 `CONTROLLER_CAPABILITY_INCOMPLETE`：binary/config/model 匹配，但 `capabilityReady`、工具面受限与原生自动压缩禁用未被验证。报告保存 `capabilityGaps` 字段，只含缺项名称，不输出配置正文。已核对 requested model 为 `gpt-6-sol / medium`、window 828400；没有调用这些场景的模型，也没有创建 `once.txt`。

LIVE-29 adapter 的准备步骤会实际建立业务会话，要求被测短答复用该会话；recap 统计限定于被测 answerId，不混入准备步骤。LIVE-04 的“没有复述 nonce”不能证明“不声称知道 nonce”。语义 oracle 仅自动接受明确的简短否定回答，明确肯定判 FAIL，其他表述标 `SEMANTIC_REVIEW_REQUIRED`；原生输入隔离另行核验。

LIVE-03/04 已增加受控原生记录检查：精确定位本对话业务线程，校验 header/revision/完整性，核对各轮 user_message 的原文 hash 与完成顺序；新会话同时检查旧 nonce 是否出现以及 fork/compaction 标记。证据只存哈希与状态，不输出正文。该检查证明本地序列化记录，不宣称提供方内部隔离或 1M 能力。

记录格式同时覆盖 `event_msg/user_message` 与 `response_item/user`。后者可能含环境或自动化上下文，不能单凭 role=user 认定来源；通过原请求 hash 匹配指定输入。修正 oracle 时，只有原文件/答案哈希未变才可生成独立重算报告，原结果保持不变。`03d53b85-45a6-499a-a215-8d343449998b` 的 LIVE-03/04 三轮核心断言经此方式通过，随后无业务工具执行的远端写入审计补齐，独立 `remote-reevaluated-result.json` 中两项用例各三次完整 PASS；原报告不变。

首轮真实三层执行 `compat-live/1c7655d1-56da-4e20-ab42-f127401c0dab` 为 FAIL，暴露 exec 重连诊断被误判为终态错误的问题。新适配器的独立真实探针通过后，使用新 fixture 执行 `compat-live/8b4531e1-27ee-481f-a230-4c3434948299`，该轮也已结束；旧中断工作区不复用。LIVE-01 三次各有 7 个断言通过，但仍有 3 个全局 oracle 未实现，所以 case 仍为 BLOCKED，不能算完整 PASS。LIVE-02 的空管理 final、模型缓存和组合意图问题已修复；新轮次三次核心断言均通过，但该轮全局证据仍不完整。

真实 `gpt-6-sol / medium` 的有限能力探测结果见 [实现状态](THREE_LAYER_IMPLEMENTATION_STATUS.md)。它们不能替代本目录定义的完整三层 live 用例。

远端写入 oracle 当前自动覆盖无业务工具执行及具备完整策略/提示哈希的纯管理查询场景：业务请求要求完整 native 记录无工具/未知项/继承压缩，输入 hash 必须属于该 job 绑定的 native ID；纯管理查询不能伪造业务提交，必须有实际管理策略和原文 wire hash。两者均核对所有被调用管理角色的受限策略及逐返回 wire hash、无摘要模型调用或全部摘要调用具备完整无工具策略/完成/清理证明、完整 jobs 集合和无 remote 的 fixture Git 前后状态。普通 slash 控制命令不在本 oracle 的支持范围内。仅允许一个额外的工具调用子集：严格 AST 识别的 `ALL_TOOLS.filter` 正则元信息筛选加 `text` 输出，且原生 call/output ID 在同一 turn 配对。该类记录保持 `noToolExecution=false`，另记 `metadataOnlyRecords` / `noRemoteActions`；任何命令执行、其他调用、未知记录、缺失调用级证明的 LLM recap 或缺证据时为 `REMOTE_WRITE_AUDIT_INCOMPLETE`，不能仅凭 cwd 或网络配置判 PASS。LIVE-29 的短答历史投影直接读取生产 `listInteractions` 对真实完成答案的输出，不声称额外调用了管理模型。

LIVE-22 生成固定像素的红圆/蓝方块 PNG，首轮附图、第二轮不附图；核对三层 wire 的图片 hash、原文、native session 和视觉回答。原生图片输入会含包装文字，审计分别保存 text part 与 inline image 的 SHA，不把包装文字当用户原文；外部图片 URL 不被读取或记录。只自动接受明确的颜色/形状描述，其他回答仍需独立语义判定。

每个实际执行的 attempt 另存 `runtime-configuration.json`，要求共享 native 配置 digest 与批次开始相同。发现变化则 `LIVE_SHARED_CONFIG_CHANGED`，当前 case FAIL，停止后续模型调用；不能通过改写旧 M0 证明放行。

`image-forward-live-table-policy/478619cb-fcb4-4668-8d0f-d48147387e47` 的 LIVE-22 三次完整 PASS；`duplicate-live-table-policy/54ef6f83-9835-4a10-bd8f-930bc0faf9f3` 的 LIVE-11 三次仅缺远端写入 oracle，均为 BLOCKED。两者仅代表所记录编译候选和配置，不代表完整 core/fault 套件。

LIVE-25 / LIVE-16 同样要求 `--allow-fixture-writes`，只写新建的测试目录。FIFO 仪表延迟第一条真实媒体准备，先放行第二条准备，随后调用原有实现；不替换图片结果、Controller、模型或业务 backend。固定测试脚本记录 PID/随机 token，runner 用进程信息交叉检查后再发 `/status` 或 `/cancel`。

`fifo-live/e34c2d4b-bfc3-4a8d-8f7a-ce8ef9f03ff1` 三次 FIFO、无死锁、状态响应、原生会话复用均通过；四项已实现全局断言通过，写工具的远端写入 oracle 仍缺覆盖，所以 case BLOCKED。首轮批次使用较早 adapter，具体原始数据在 `media-order.json` / `process-events.json` / `observations.json`；后续版额外输出规范中的 scheduler/slot/status 命名文件，不把旧批次当成已采集这些文件。

`cancel-live/dfed387b-dade-4572-b829-beef8ff6e06c` 三次取消核心断言通过，但均是 `interrupted + blocked` 分支：取消后被观察脚本仍活着。测试最终用仅属于该 fixture 的退出文件停止脚本，并单独确认清理；这不是桥接取消彻底停止所有子进程的证据。旧批次缺中断轮次的披露审计、写工具远端写入审计，case BLOCKED。

生产路径已补充 native 策略诊断的逐请求记录及管理进程关闭确认。中断披露审计要求策略已验证且未被撤销、请求已终结、管理 runtime 已关闭、工具调用全部返回/拒绝且成功返回哈希匹配。缺任何一项不放行；旧批次不能反推新埋点。新的 `cancel-policy-live/3cf30250-50de-47f9-8c07-3554cb820896` 三次已完成：新增中断披露审计全部 PASS，取消四项核心断言、原文、权限和宿主不重放断言也全部 PASS。每次 case 仅因写工具远端写入 oracle 尚未实现而 BLOCKED。

LIVE-21 使用宿主选定的 `fixture-A` / `fixture-B` 本地 route targets，用户文本中的“scope A/B”不提供身份。按 setup 先通过真实三层服务分别建立业务绑定，再发送原始两条 case 文本；B 的历史查询允许只经过管理层。runner 从实际 RoleTools 实例注入 owner/conversationScope/requestId/scope，确认原有 schema 在处理器前拒绝，再原样执行真正调用；没有替换模型或伪造成功结果。原件 reader 用 B 的宿主身份实际尝试读取 A 的 answerRef。证据仅存身份/文本哈希、拒绝码和页面 request IDs。

初版 `scope-live/0fcca454-576e-4c10-b4f8-68308762fd9b` 三次因 adapter 错把 B 历史查询要求为业务任务而 FAIL；实际 A 业务和 B 管理查询均成功，缺的是 setup 的双业务绑定。修正后的 `scope-bound-live/49c2afdd-7997-4576-8e28-019fec327181` 三轮所有断言完整 PASS。旧失败保留。

LIVE-30 每个 attempt 通过真实三层服务交替完成 A/B 两个目录的 31 次短业务请求，逐轮核对真实答案编号，再执行冻结的两条历史查询。只有跨 scope 负例为明确标记的合成宿主记录；它在 31 轮之后插入并关联 A 目录，确保漏掉 scope 条件时会出现在最新页，而不是被页长掩盖。仪表只观察真实 `list_interactions` 的参数、返回 ID/顺序/目录与哈希，返回值原样交给模型；分页探针另外调用生产 `listInteractions`，不会冒充额外模型调用。

`interaction-live/ed48f84a-1b1b-4c65-a160-bc9e6bda32c1` 已启动三次计划 attempt；前两次执行完成并通过独立重算，第三次真实查询失败，整项三轮验收未完成。每次业务完成后写 `setup-progress.json` 和进度事件；每个准备步骤检查 2 GiB 空间和 native 配置 digest。当前运行的早版 `model-invocations.json` 不含 recap 汇总，后续版增加了按 source/state 的计数；前两次已在来源与时间明确的 `history-reevaluation.json` 中另行补采 recap 计数。

runner 的 manifest 记录自身 PID。SIGINT/SIGTERM 会请求当前服务关闭，并通过 case 的 finally 保存清理结果；后续 attempt 标为 `LIVE_STOP_REQUESTED`，不再启动模型。关闭确认与 detached 子进程退出保持区分，未确认清理仍阻止后续执行。

LIVE-14 需要 `--allow-fixture-writes`，每轮在隔离的业务 native home 建立真实会话，健康验证后仅追加测试 cwd 错误；使用原生协调锁避免并发 writer。管理 home 保持已验证配置。三轮的 binding / explicit-resume 两分支核心断言均 PASS；补审后的全局断言只剩远端写入尚缺，case 仍 BLOCKED。

LIVE-30 的目录筛选可以使用真实收到的前一页，不强制模型重复调工具；验收同时比对来源页和最终答案中的唯一 Rnn 编号集合，混入其他项目、缺号或重复不能 PASS。原报告与独立重算报告保留，重算记录原结果/页面/答案/新 oracle 的哈希和采集时间。旧轮前两次已据此 PASS；第三次请求 limit=70/35，被有效的 30 上限拒绝，因此保留真实 FAIL，不进行重算放行。

LIVE-19 `delivery-live/0313d90e-b67a-45e5-8ac0-e3a2fab5eee0` 三次完整 PASS。真实业务完成后，测试 Writable 先接收并记录真实 LocalChannel frame，再通过 callback 返回 ACK 丢失；断开的通道不能再次发送。关闭并重新打开同一 SQLite 状态的服务，原段保持 unknown/attempts=1；显式 `/result` 是新的控制投递，正文与原段相同，业务及管理模型调用数未增加。这是本地传输故障注入和服务实例重启，不是微信投递或 OS 进程崩溃验证。

历史第三轮失败揭示模型可见 schema 缺失数值 bounds 后的可用性问题。`list_interactions` 描述已明确一行是一轮完成的用户问答、limit=1..30、分页方式；Bridge 的全对话查询直接用 conversation scope。协议现在只把安全错误码反馈给模型，参数问题为 CONTROLLER_TOOL_ARGUMENTS，不输出内部异常文本。管理 instructions/tools 的 fingerprint 变化会按 config_changed 换代，保持业务 binding；去掉了会在持久 Route 中变旧的 Host intent 文本，当前 intent 仍由宿主每请求检查。

新 `interaction-limit-live/5c73377b-4e6d-4c69-ab36-078ec98b1efd` 三轮全新 31 次真实交互准备和查询已完成，并通过三次独立重算；旧第三轮不当作通过，新轮次不重用或重放旧业务请求。

默认离线测试的 launcher 构建已隔离到临时应用副本，防止并行测试复制正在被 tsc 改写的共享 dist；真实 launcher/进程生命周期仍执行，不靠降低测试并发或跳过构建掩盖竞争。

LIVE-18 在真实业务输出超过 2000 字符并归档后，对第一次 CodexRecapModel 服务调用注入一次明确错误；随后通过捕获的原 RecapService 实例显式重试，调用真正的摘要模型。记录业务/摘要调用数、原件前后哈希、失败时 Bridge 实际受限返回、原件在失败期间的已投递首段。`recap-live/c6baa29e-ed1d-4657-852a-524ada59e54e` 三次核心及已有全局断言均通过；case 仅因远端写入 oracle 未覆盖而 BLOCKED，不称为完整验收。

历史答案审计支持合法表格：同一行在编号、提问、回答栏重复同一个 Rnn 不算重复交互，但重复行或行内错配仍拒绝。无工具的管理完成轮只有在逐轮 native 策略存在、身份匹配且未撤销时才能完成披露审计；完成标记本身不能代替策略证据。`interaction-limit-live` 第一轮原 FAIL/BLOCKED 保留，独立 `history-reevaluated-result.json` 为 PASS；后两轮现也完成执行并独立重算 PASS。

LIVE-13 / LIVE-15 已接入独立 native home，使用短期访问凭据且排除真实 refresh token，结束清理。LIVE-13 的旧巨行记录及 LIVE-15 的 metadata 均明确标 syntheticHistory；真实 Controller 和需要的业务调用仍使用 gpt-6-sol / medium。LIVE-13 审计宿主 NativeReader 的目标选择，不等同于 OS 全进程文件监控。

partial 空页不能授权新建或执行一个非默认候选。SessionOptions 提供 coverage/order/nextCursor，模型可继续读页或要求用户明确选择；“选目录”不会由模型文字变成“恢复了业务会话”。旧 LIVE-15 第 2 次错误回执保留 FAIL，新 partial-selection-live 三次核心通过；加上纯管理远端写入审计后的新 partial-complete-live 三次全部 PASS。

LIVE-12 的外部 setup 直接调用真实 CodexBackend CLI，完全绕过 Bridge ingress/store，记录 native ref、输入/nonce 哈希与 finish evidence；Bridge 初始 job/binding 均为零。恢复后的原文 hash 必须精确匹配原 case 请求，nonce 只能来自所选 native 会话的已有上下文。工具数字/字符串边界现在自动写入描述，弥补原生 schema codec 省略 bounds，宿主仍严格拒绝越界。

LIVE-20 使用业务时钟 seam，四个分支分别准备真实成功 session。24h边界、过期、显式恢复、管理读/投递/缓存recap/控制器换代分别取证。只注入管理 registry 的 rotate_pending 状态，原 usage 不改；报告显式列出 clockInjected、rotationStateInjected、usageInjected=false、real24hWait=false、real80Verified=false。此测试不代替用户暂缓的 1M/80% 测试。

LIVE-23 使用合成目录描述和 system 历史原件承载提示注入，真实 Bridge/Route 接收正常历史查询。直接对实际 RoleTools 实例探测 shell、Bridge raw reader、额外 query/context 字段，原始模型调用及工具结果保持不变。scope 外 canary 为本次随机生成，仅保存 hash；受限原生策略、宿主 NativeReader/ArtifactStore 路径和返回内容分别记录，不宣称 OS 全局文件追踪。初版 fixture 的历史目录标识错误已修复，原三次失败保留；新 `injection-bound-live/94e6e948-b7b5-404e-94b5-e4d1aab03175` 三轮全部断言 PASS，限于该候选和宿主审计范围。

LIVE-07/09 共用 long-answer-case：业务工具输出需提供报告校验段的来源，归档至少五千 code points；LIVE-09 的标记不得已在 Recap 中出现，后续纯历史查询必须实际读取对应 answerRef 范围且不新增业务执行。实际工具/capture 观察只保存 hash、范围和布尔匹配。当前长答案测试处于普通窗口，非真实1M/80%用例。LIVE-07 首轮核心通过但远端审计未齐；LIVE-09 首轮因标记已进入 Recap 而 FAIL，摘要提示修正后的新轮第 1/3 次核心通过，第 2 次 Bridge 未把缺失细节委托 Route，保留 FAIL。现已补该委托提示，`long-history-route-live/92015f4b-d926-4b78-992d-8a3c373186c7` 三轮核心及已有全局断言通过，仅远端写入审计 BLOCKED。

额外 search-live 三次真实管理模型搜索均 PASS，证据 `search-live/7b29a9fc-fd0c-4581-bfcb-85c04e3a1bd0`；合成 system 历史包含同目录、另一目录、另一 scope 和仅原件含词的负例，实际搜索/回答及零业务执行均核对。该额外检查不改冻结 LIVE-ID 矩阵。

LIVE-24 用真实 CLI 建立 v3 业务 native ref，再运行实际 SQLite backup、dry-run 和 apply；保存核心行集校验和及快照 SHA。健康分支准确续接，另一分支用明示合成 v3 interrupted 状态验证新建不能绕过 blocked。迁移前后调用计数、原 ID/clock/dedup/unknown outbox/合成游标及旧裁剪标记分别核对。只验证 LocalChannel 和合成状态，不声明真实微信游标迁移或真实崩溃复现。`migration-live/650eb070-d1a6-42cd-b164-c7ebd26dcdb9` 三轮核心及已有全局断言 PASS，均只剩远端写入审计 BLOCKED。

LIVE-17 必须 --allow-fixture-writes：fork 真实 Bridge 主进程，配置只经 IPC；实际业务写入由固定脚本生成的开始标记且宿主已记录 prompt 准入后，对 Bridge 主进程发 SIGKILL。runner 另行释放受控脚本并检查已记录的 PID/进程组退出，不能把这一步说成产品自动停止了所有子进程。随后正常 openService 对死亡资源归档和任务对账；不调用 review、不授权重放，检查原 native ref、uncertain effect、blocked 及一次提交。`crash-live/8cfe67b9-dc59-405a-9784-852c0e7f0dcf` 三轮四个核心断言通过，原文/权限/不重放断言通过，已记录进程清理确认；原报告崩溃披露与远端写入审计缺失，整体 BLOCKED。随后依据已保存的进程归档、kill-boundary、原 native 策略和未发送回调进行只读独立重算，三轮披露 PASS，仅远端写入仍 BLOCKED；不伪造回合完成，也不修改原数据库/报告。

LIVE-08 的业务测试退出证据来自原生 CommandExecution，要求实际固定测试命令、fixture cwd、完成状态/exit0和测试 callback 输出标记同时匹配；脚本/package hash及 Git HEAD/status必须未变。语义初筛保留约束、未完成事项、有序选项及待答问题；词法匹配本身不代替运行事实或完整语义复核。`recap-semantics-live/5cbc7178-7658-4b65-8674-9e95f8eda1d2` 三轮核心通过，仅远端写入审计 BLOCKED；逐轮另有 Codex 语义复核及源 hash，非独立人工验收。

LIVE-28 的 unique/ambiguous 分支分别建立完整独立 fixture。歧义分支两个目录均有真实业务未提交改动，以真实用户层说明建立双候选上下文，然后发送冻结的省略目录工作句；必须先出现宿主持久化澄清且零业务提交，再发送冻结选择回复并重复相同消息 ID。原业务文本必须精确等于省略目录工作句，不能使用选择回复或拼接文本。两分支都要求实际 A 提交并推送到本地 bare、B 不变。`elliptical-live/cc622b2d-68f0-47d2-8fc0-acb276e28c72` 三轮两子场景核心通过，仅远端写入审计 BLOCKED。

远端写入审计支持有限原生命令和 add-file patch：闭合 JS/shell 语法、每轮 native 权限策略、命令/cwd/终态 mirror 和 call/output 都需匹配；未知程序和语法仍 BLOCKED。Git 还必须通过实际有效配置、物理 fixture/local bare、前后快照检查，patch 必须匹配最终文件哈希；宿主控制命令必须无模型调用并有 system 完成原件。命令执行与 noToolExecution 分开统计，非零退出不算执行成功。LIVE-13 的旧三轮独立重算全部 PASS，原报告保留；LIVE-06/28 adapter 现接完整前后快照及上述审计，新批次运行结果以实现状态为准。该审计不覆盖任意 shell 或全系统副作用。
