# 三层 Bridge 实现进度与证据

本文件记录三层实现的阶段提交及实际证据；完整发布验收尚未完成。冻结设计包保持原始字节和校验和。

## 本次执行约定

- 施工分支 `dev`。2026-09-24 按用户最新要求先提交并推送当前阶段，保留未通过和未执行项目。
- 本次 live 目标按用户要求为 `gpt-6-sol / medium`，覆盖设计包示例中的 `high`；不自动换模型。
- 用户于 2026-09-23 明确暂缓真实 1M/80% 长测，先埋点，运行一段时间后评估。因此 LIVE-26/27 是 **DEFERRED_BY_OPERATOR**，不是 PASS；窗口配置不会为方便测试而缩小。
- 微信手机参与的 LIVE-W01/W02 留待自动测试完成之后，当前 **NOT_RUN**。
- 管理 runtime 的 `gpt-6-sol / medium` usage 报告有效窗口 **828400**。普通 live 的私有配置已按此实测值设置；1M 示例与实测不符，未宣称 1M 能力，也未用缩小的测试窗口模拟跨 80%。

## 本阶段提交状态（2026-09-24）

本次提交包含已实现的三层编排、原件/摘要分离、历史查询、迁移、恢复、用量埋点和测试工具；不宣称整套 live 验收通过。当前没有后台 live 测试运行。

- 提交前 npm ci 成功，npm run check 422/422 通过；详情见 docs/verification.md。
- LIVE-01/02 最新各三轮在管理模型初始化阶段触发 CONTROLLER_TURN_TIMEOUT（90 秒），未进入业务执行；原因尚未确定。失败记录保留，未认定为环境故障。
- LIVE-07 的历史概括误触发业务已修复：会话选项返回宿主 delegationIntent，Bridge/Route 明确归档答案查询规则。long-history-intent-live 三轮功能断言通过，scoped-effects-reevaluated-result-v6.json 三轮完整 PASS。
- LIVE-08/11/18 的 v3 补审、LIVE-14 的 corruption-effects-reevaluated-result-v7.json、LIVE-25 的 scoped-effects-reevaluated-result-v8.json、LIVE-28 的 v5 补审各三轮 PASS；各自原报告、原数据和审计代码快照保留在私有 runtime 中。结果仅对应其记录的候选和证据。
- LIVE-16/17 的远端写入审计尚未完成；LIVE-24 已加入迁移基线核对代码和离线测试，完整 live 审计尚未完成。未完成项不标 PASS。
- LIVE-26/27（真实 1M/80%）按用户要求暂缓，日志埋点保留；LIVE-W01/W02 手机验收未运行。生产部署和生产迁移未切换。

设计 live 文档第 17、23 行要求断言 oracle、证据导出，以及无生产远端写入等全局断言。JS/Shell/Python 的闭合语法解析是本实现选择的测试手段，设计没有强制要求这套解析工具；这些模块仅用于测试，不能作为生产后端或通用 OS 隔离证明。

## 当前模块与边界

| 阶段 | 已加入工作树 | 尚未完成 |
|---|---|---|
| M0 | 独立兼容候选通过真实 6 Sol/medium create/resume、动态回调、实际工具集合诊断、禁用压缩模式、runtime usage、图片、取消和 writer busy→idle；失败探测保留 | 原已安装 binary 仍无成功证明；1M/80% 长测暂缓；完整上游 workspace 回归未通过，生产未切换 |
| M1 | 原文接收、严格配置、原文 hash/去重；v4 additive 迁移与旧来源标记；SQLite backup API、artifact/media 副本、dry-run/apply 命令；验证并导入绑定、目录、别名/tombstone | 生产迁移及真实 v3→v4 live 续接验收 |
| M2 | final capture、原件和 recap 已接 worker/Delivery；系统控制回复归档并记入交互；业务失败/取消/中断另存 system 通知，不把业务草稿标成功；`/result` 原件片段不经短文捷径泄露给 Bridge；独立无工具 recap；恢复保留完成时间 | 真实 recap 语义验收、完整故障矩阵 |
| M3 | 管理生命周期接线、进程 ownership marker、原生最后 turn 校验、L0 handoff、generation CAS、80% 日志；接收恢复与结果补提交；Bridge/Route 按 root 共享已配置工具调用预算 | 全链路恢复故障注入；完整三层 live 验收 |
| M4 | 主链路、原文/当前图片、单次派发/FIFO、A-B-A、澄清源文；目录批准与 scope 别名；请求/会话模型覆盖、逐字段来源、业务窗口参数传递及原生观测；持久历史 ref；new/sessions/find/read/resume/more 控制命令；脱敏 debug task；update/restart 的明确批准、排空与最终原件归档/幂等恢复 | 完整故障/三轮 live runner |
| M5 | catalog/reader/verifier 已接选择和查询；Codex 索引精确定位核对 header、header fallback、Pi 分支阅读；已验证完成时间按 file revision 缓存，完整且全部已验证的候选页按完成时间排序；支持本机 0.155.1 的 settings/UI mirror/world_state/usage 记录 | 后台增量索引/跨页完整覆盖排序、Pi readiness 与 live lane、更多真实业务历史格式验收 |
| M6–M8 | 正在完善；LIVE-01/02/03/04/05/06/07/08/09/10/11/12/13/14/15/16/17/18/19/20/21/22/23/24/25/28/29/30 adapter 已接入；报告锁定 assertion/predicate/expected，核对证据文件及哈希；清理未确认会阻止后续场景；工具哈希审计；旧 58 ID 保留并补离线映射；权威文档区分默认模式和三层施工状态 | 剩余命令/控制/故障路径的远端写入 oracle、完整故障恢复、最终发布检查与发布 |

`openService` 已接 `HierarchicalBridge`，生产 factory 要求匹配模型、binary SHA、native config/policy digest 的完整 `runtime-lock.json`；缺失、不完整或不匹配均拒绝启动，不回退到 legacy 执行。probe 现可为实际具备两项限制能力的独立候选产生 PASS 证明；原已安装 binary 的旧失败证明没有被修改。运行时每轮还必须提供匹配当前角色工具集合的 native 诊断。空新库可初始化 v4；非空旧库要求显式迁移。现有生产服务和部署配置未切换。

项目规则仍关闭并检查来源。仅允许声明登录 home 中固定、非符号链接的个人 `AGENTS.md` / `AGENTS.override.md`；其他项目/自定义来源拒绝。此前把个人全局指令也一律拒绝的检查已修正；允许个人指令不是工具隔离的证据，后者仍须独立通过 M0。

## 已执行证据

2026-09-23–24，macOS arm64、Codex CLI `0.155.1`：

- `npm ci` 成功；npm 报告 1 项 high dependency vulnerability，未进行与任务无关的自动升级。
- 基线 `npm run check`：216/216 OFFLINE 测试通过。
- 此前全量 `npm run check`：421/421 OFFLINE 测试通过，无 skipped/deselected，日志 `refusal-fifo-final-check.txt`。提交前当前版本检查见本文件的本阶段记录和 docs/verification.md。本轮新增原生 add-file 内容/路径哈希、完整 code-mode 调用提取、受限 shell AST、命令/原生 mirror 配对、fixture Git 配置与本地 remote、宿主控制完成证据回归。首轮 412 passed / 1 failed 为新测试夹具漏传 sessionKey，修复后完整通过；原 `scoped-git-final-check.txt` 失败日志保留。新增崩溃进程归档/未发送回调证明、语义初筛及真实测试命令输出观察回归。新增死亡资源恢复、活动进程拒绝、恢复中断/符号链接及并发恢复回归。新增中文/短词全文搜索、范围与分页、索引状态同步和旧结果完整性标记回归。新增原件捕获/工具返回仪表、原生工具输出校验词来源、Recap 调用/策略/清理及拒绝缺失证据的回归。新增真实工具实例的注入拒绝探针，确认拒绝发生在 handler 调用之前。新增纯本地工具元信息表达式的严格语法与配对原生记录检查；首轮新增两项因 JS AST flag 比较错误失败，修复后全量通过，保留 `metadata-query-check.txt` 原失败。新增完整单候选的准确验证与所有工具 bounds 文本化回归。新增 partial 空页、非默认候选拒绝及宿主目录回执回归。新增 Recap 有限重试账本和无工具管理轮审计回归。新增安全工具错误码和管理策略变更换代回归；非空业务绑定保护另有 `policy-binding-check.txt` 定向通过。新增隔离认证、受控历史损坏与恢复拒绝后禁止同请求新建回退的回归。新增真实历史工具观察仪表和停止准入检查。新增身份注入仪表和纯管理查询的远端写入审计回归。新增媒体乱序仪表、native 策略审计与中断披露/关闭证据回归。此前 345 项检查曾因新增策略 hash 导致旧绑定迁移失败而为 344 passed / 1 failed（`project-trust-wiring-check.txt`）；现已补充显式迁移的策略映射和实际 profile 变更拒绝测试。新增无工具执行审计、管理工具/摘要/fixture 关联、图片包装哈希、视觉 fixture 和候选代码哈希检查。包含两种原生用户记录格式、原生输入顺序/完成哈希、旧校验词检测、fork/compaction 标记、部分记录拒绝，以及明确否认/肯定/待语义审查的区分；不构成全套设计验收。
- 此前同批全量为 325 passed / 1 failed，CLI01 报 interrupted；单独 CLI 六项和后续完整 326 项通过，原失败保留，未把未确认原因直接归为环境问题。
- 本轮第一次全量回归为 298 passed / 1 failed：新测试在服务启动后修改目录配置，被既有 `PROFILE_CHANGED` 守卫拒绝。修正夹具为启动前配置，再验证窗口变化导致新业务会话；后续全量先 300/300、加入失败通知测试后 304/304 通过。该失败不是 live 模型结果。
- `git diff --check` 通过；冻结设计包 `SHA256SUMS` 全部通过；无 `--live` 的 probe 返回 `LIVE_OPT_IN_REQUIRED`，未启动模型。
- 新增测试全部为 OFFLINE，包含协议 double、文件/SQLite 与合成输入，不证明真实 Agent、微信投递或 OS 隔离。
- 实际已调用 `gpt-6-sol / medium`。`2efd24bf-ddc9-4fc0-8a0c-cef000bcffff` 首次取得 2752 tokens / 828400 window，因私有配置仍为 1M，报 `CONTEXT_WINDOW_MISMATCH`。
- `25da8da7-ef1b-469b-abe8-8eeb193ea516`：按实际窗口运行，同线程 resume 和只读动态工具回调成功，两次完整 usage 为 2752、2815；真实原生历史读取也验证 idle、model/reasoning 和已完成时间。总体仍 BLOCKED。
- `a4dda829-e0d7-40c8-aba7-9c49d1892f02`：inline 图片样例回答颜色错误；原 PNG 与 native transcript 图片 SHA 相同，保留 FAIL，取消和退出检查通过。
- 改用文档对应的 `localImage` 输入及不暗示颜色的文件名后，`e3aa1f2b-9401-4a54-89bb-2da48950e94c` 的图片识别、取消、writer 释放检查通过。一次正确样例不替代 LIVE-22 的三次完整三层验收，也不抹去先前失败。
- 上述旧 binary 探测的 requested/runtime-observed 都是 `gpt-6-sol / medium`；最终 provider 实际路由和费用 unknown。旧探测总体为 `TOOL_SURFACE_AND_COMPACTION_UNVERIFIED`，未将其子项通过算成 M0 PASS。独立候选的新通过结果单独记录如下。
- 安装协议 schema SHA-256：`85619dbd9d267e8551b51b46b7e5f2f325a433eff4a0c3e2cf3a6c1c26c51745`。
- 2026-09-24 的探测 `5e5b6cc0-be6b-4ea8-9368-7eab9c770d93`：该实际 app-server 新线程存活时，POSIX writer 锁检测为 busy；关闭并确认进程组退出后为 idle。只证明此 installed runtime 的写锁读取协议，不证明模型调用、工具隔离或 OS 隔离。整个探测仍 BLOCKED，未提交 prompt。

原生写入者检查使用 `python3 -I` 的标准库 `fcntl.flock`，只读打开 coordination/thread lock，不删除锁、不接管 writer、不复制认证。缺 Python、非 POSIX、锁命名空间/权限不可验证时返回 unknown；生产启用还必须匹配 M0 验证的 binary。Node 主服务并未因此声明支持未经验证的其他 Codex 版本。

文件 fallback 只检查 native header，不读无关 transcript 正文；确认 native 根不存在可记录完整空集合，坏 header/部分页不能冒充完整空集合。恢复资格由独立 verifier 判断：坏转义即使位于被省略的 9 MiB 字符串末尾仍拒绝；部分写入、未知状态事件、profile/revision 不一致和 writer unknown 均拒绝。Pi assistant 时间戳始终不等于 `agent_settled`。

私有证据位于被 Git 忽略的 `runtime/three-layer/`：`baseline-check.txt`、`implementation-check.txt`、`probe/*/probe.json` 等。保留所有失败探测；没有挑选一次成功结果替代失败。认证、私有配置、native refs 与模型原始输出不提交。

维护命令和备份边界见 [迁移说明](THREE_LAYER_MIGRATION.md)。正式 apply 的 CLI 仍要求完整 M0 证明；本轮 apply 仅在离线合成 fixture 中验证，没有迁移生产库。

live 入口进度见 [runner 状态](THREE_LAYER_LIVE_RUNNER.md)。旧 installed runtime 的 core 预检证据 `live-preflight/6ef8e688-1a1c-4173-8a75-d2ad90386202` 输出 57 个 BLOCKED attempt（`CONTROLLER_CAPABILITY_INCOMPLETE`）。binary、configuration 与 model digest 匹配，缺项明确为 `capabilityReady`、`effectiveToolSurfaceVerified`、`nativeAutoCompactionDisabledVerified`。此前 `a45b12e5-1d41-47ce-9263-b6723d35becf` 的泛化 MISMATCH 错误已修正诊断分类；能力门禁没有放宽。该预检未运行对应模型场景、未绕过 M0；独立候选随后已执行的 live 证据见下文。

独立候选基于官方 tag `rust-v0.155.1` / `be2951ea34f0d295ed0becf97079f92fa5f6950e`，补丁、许可证、构建来源和回归限制见 [runtime 兼容说明](THREE_LAYER_RUNTIME_COMPATIBILITY.md)。`compat-probe/2ca4cbad-db5a-4ead-99f6-ae6aff4e8370` 已通过实际 M0；这是新 binary 的新证明，窗口仍为 828400，不是 1M 长测。管理模式只注册 dynamic tools，自动压缩入口明确拒绝；宿主核对每轮实际工具诊断，不靠模型自报。

首轮三层执行 `compat-live/1c7655d1-56da-4e20-ab42-f127401c0dab` 保留 FAIL：LIVE-01 三次及 LIVE-02 首次业务均以 `CODEX_EVENT_ORDER` 中断；后续新 fixture 的能力证明入口被暂时移走以停止新调用，当前 fixture 收尾后退出，没有重跑原任务。元数据探针确认 exec 在有效 turn 中输出四次重连 `error`、一个非致命 warning，随后 final、`turn.completed` 和 exit 0。适配器现仅认可已知重连诊断；未知错误、缺终态、失败退出或模型 reroute 仍拒绝。新单次真实探针 `exec-adapter-probe/2d0df214-7c6a-4115-91fb-2fdd742aff50` 成功且清理确认。该单次探针不替代后续三层验收。

后续 `compat-live/8b4531e1-27ee-481f-a230-4c3434948299` 已结束：LIVE-01 三次各有 7 个断言通过，但缺 3 个全局 oracle，仍为 BLOCKED；LIVE-02 暴露了管理空 final 引发 Route 换代以及模型缓存误否决。原生记录确认业务已成功返回后，Route 的 final 文本可以为空。管理适配器现只在同请求的宿主终态委托结果已返回、全部回调结束且原生 turn.completed 成立时接受空 final；业务 exec 成功条件不变。

定向 LIVE-02 复测 `route-reuse-live/17a32552-825b-4ca6-b112-58cdcb8e0ae5` 保留失败：Route 已能复用，但组合“切换并介绍项目”被误标为纯 switch，业务调用因权限意图不符而拒绝。静态提示已区分纯切换、读取项目文件的工作和历史查询；程序把此冲突记为失败，不能包装成已完成的控制回复。修复后的三次定向复测结果见下一段。

新定向轮次 `route-reuse-live/f3421489-2c56-46fb-b0b8-367fb206fcd1` 已结束：三次的目录序列、Route native 会话复用、业务 native 会话复用、原文一致性四项全部 PASS。全局断言仍缺证据，因此整个 case 仍为 BLOCKED。该轮候选编译文件哈希已写入 `candidate.json`，不拿后续新增审计字段反推其覆盖范围。

原生上下文定向轮次 `native-context-live/51664b39-b26b-4a64-b23b-e21b409ccf68` 六个 attempt 保留 FAIL。LIVE-03 三次均把“开始会话并记住口令”误标为 switch，未执行业务。提示已明确记忆、当前业务对话问题和要求回复本身也属于 work；没有给业务拼接管理历史。随后已使用同一冻结输入完成复测。原生上下文 oracle 读取目标线程的受控记录，只保存输入/文件哈希和状态；不输出 transcript 或 reasoning 正文，不能只凭模型答对/未答出口令判定隔离。

新轮次 `native-context-live/03d53b85-45a6-499a-a215-8d343449998b` 已结束。模型执行满足预期，但初版 oracle 只识别 `event_msg/user_message`，遗漏实际 `response_item/user`，造成顺序/隔离误报。已修复解析，并在确认原文件 SHA、revision 和答案 SHA 未变后生成独立的 `native-context-reevaluation.json` 与 `reevaluated-result.json`；原 FAIL 报告保留。LIVE-03 三次四项核心断言均 PASS，LIVE-04 三次四项核心断言均 PASS；宿主重放与 Bridge 披露断言也有本轮证据。该版重算当时因 `noProductionRemoteWrites` 缺证据而为 BLOCKED。后续 `remote-write-reevaluation.json` 读取全部相关业务原生记录，核对管理受限工具返回、无 recap 模型、原文 hash 与 fixture Git 状态；六个 attempt 均未出现业务工具调用，且最后目标记录 SHA/revision 与原采集相同。独立 `remote-reevaluated-result.json` 的 LIVE-03/04 各三次全部 PASS。此结论限定于合成、无业务工具执行场景，不宣称 OS 隔离或任意 shell/远端操作安全。两次重算没有调用模型或重放业务，原报告均保留。重算脚本首次使用相对证据路径造成的验证失败也已保留，随后以绝对路径重新核验。


定向 LIVE-10 `raw-query-live` 三轮完整 PASS；LIVE-29 `short-answer-live` 三轮核心断言通过，其中两轮完整 PASS，一轮准备阶段有原生 `exec` 工具调用，故远端写入 oracle 保留 BLOCKED，未把它称为无工具执行。短答投影检查使用生产 `listInteractions` 对真实答案的返回。

LIVE-22 `image-forward-live/c3f5cef0-8587-4283-af8e-316d55c37240` 首两轮视觉答案均正确；初版图片输入哈希拼入了 native 包装文字，视觉语义判定也遗漏了明确的左右描述，原结果为 FAIL。修复后核对原生文件 SHA/revision 和答案 SHA 未变，生成独立 `image-reevaluated-result.json`，两次均 PASS。第三次未调用模型，被配置门禁阻止。后续批次与当前补测见下面的配置变更说明，不重放旧请求。

共享 native 配置变化已定位：Codex 0.155.1 在 `workspace-write` thread/start 时，会把未声明信任状态的测试目录自动写为 trusted。`duplicate-live` 与 `duplicate-live-v2` 的首次执行各新增一个测试信任条目，使后续用例的配置 digest 失配。首版宿主修复遗漏了业务配置剥离后的参数传递，随后修复又发现 CLI 对 dotted override key 直接按点拆分；这两版失败记录保留在 `duplicate-live-trust-fix` / `duplicate-live-wiring-fix`，runner 现在会在每个 attempt 结束检查全局配置 hash，变化则 FAIL 并停止新调用。

最终参数使用 `projects={"<cwd>"={trust_level="untrusted"}}` 内联表，通过生产 backend factory 显式传递。已安装 CLI 的无模型 `config/read` 探针确认目标目录实际 untrusted、全局配置 hash 不变（`project-trust-config-probe.json`）。这个固定策略进入三层 profile digest；它禁止加载项目本地 `.codex` 配置，实际写权限仍由显式 sandbox 决定。未给模型新增权限或自动批准。

只撤销了本次测试自动新增的四个目录信任条目；其余配置字节保留。`test-trust-rollback*.json` 保存范围/哈希，清理后与 `clean-trust-probe/cc9a7aa2-b747-4779-9806-56e6e788376b` 的 M0 配置逐字节匹配，生产 factory 已重新验证。之前 `config-refresh-probe/7ec1e69f-e3fc-4c42-9ba2-f1cc4d65a6d1` 和 `trust-fix-probe/41e976a6-1e3d-4b9b-b823-33a1d9e79d9e` 的 PASS 是各自历史配置的证据，不当作当前证明。probe 已增加开始/结束配置及 binary 一致性检查。没有复制认证或回滚无关配置。

LIVE-11 `duplicate-live/4b93b5ca-3a76-4762-9961-e5f8618964a0` 首次实际创建 nonce 文件，重复投递/委托仅提交一次，四项核心断言及 Bridge 披露、宿主重放断言通过；远端写入 oracle 未覆盖写工具，所以 case BLOCKED。后两次因上述配置变化未执行模型。最终内联表策略的 `duplicate-live-table-policy/54ef6f83-9835-4a10-bd8f-930bc0faf9f3` 三轮已结束：四项核心断言及披露/重放/原文/权限检查全部通过，三次共享配置 hash 均未变；每次 case 仅因写工具的远端写入 oracle 未覆盖而 BLOCKED。`image-forward-live-table-policy/478619cb-fcb4-4668-8d0f-d48147387e47` 三轮所有断言 PASS，包含图片 hash、视觉回答、原生续接、无历史图片复制和五项全局断言；共享配置也均未变。两组报告均含所执行编译候选的文件哈希，不将旧候选结果混算为本候选整体验收。

2026-09-24 再次确认 installed CLI 为 `0.155.1`。官方配置参考将 `model_auto_compact_token_limit` 定义为触发阈值，未设置时使用模型默认值；本次未找到可证明全面禁用自动压缩的公开配置保证。已保存的固定上游源码中，阈值受窗口比例上限约束，达到完整窗口仍会触发压缩；`model_post_turn_compact_threshold_percent=0` 只涉及回合后的路径。因此不把调高阈值或一次短请求没有压缩当成“已禁用”的证据。源码观察不替代 installed binary 的行为验证。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

维护父进程不调用摘要模型。标准短回执保存 verbatim recap；若 operator 配置的短答阈值不足，原件与维护结果仍独立提交，recap 明确失败，不退回原件正文给 Bridge。启动恢复先按已落盘的完成证据修复维护原件/终态/outbox，保留原完成时间；没有完成证据时不重做更新或重启操作。

## 80% 后续观测

`ControllerRegistry` 输出结构化事件：`controller.usage_observed`、`controller.usage_unknown`、`controller.rotate_requested`、`controller.rotated`。只记录毫秒时间戳 `at`、Bridge/Route 角色、controller/native/turn ID、generation、runtime `last.totalTokens`、有效 window、basis、换代原因和业务绑定集合 hash；不记录用户原文、答案或 token 凭据。

换代前后绑定 hash 可用于核对业务绑定不变。缺 usage 阻止继续使用管理会话；`799999/800000/800001` 的固定 1M 离线边界已测。埋点已接管理生命周期，实际长期部署和真实 80% 均未验收。

正常阈值换代标 `usage_80`；模型配置变更标 `config_changed`；失败管理 generation 在收到后续新请求时重建标 `runtime_recovery`，不冒充达到阈值。恢复对账本身不创建 runtime、不重发旧 query、不创建业务 job；正在提交的 effect 保留 uncertain。

管理 bootstrap 是单独的初始化请求，不是用户工作请求：在原生 ref 的 role 登记后执行，禁止工具；只有可信 usage 未达 80% 才切换 current generation。用户 rawQuery 随后仅提交一次。初始化失败或过大保留旧 current，单次操作不循环建会话。

## 运行时参考来源

- [OpenAI app-server 文档](https://learn.chatgpt.com/docs/app-server)：协议入口；以本机生成的实验性 schema 为实际字段依据。
- [GPT-6 Sol 官方模型页](https://developers.openai.com/api/docs/models/gpt-6-sol)：模型 ID 和 reasoning 能力参考；不替代当前账号实测。
- 上游源码检查固定到 `openai/codex@cb1eea3e98ebc433ab5f9c12ce043e979d1902df` 的 `config.schema.json`、`core/src/tools/spec_plan.rs`、`codex-home/src/instructions/mod.rs`、`rollout/src/writer_lock.rs`。上游源码不等于 installed binary 的已验证能力；请求配置开关与能力证明保持区分。

本轮已完成报告索引：私有 `runtime/three-layer/completed-evidence-index.json`；它只汇总对应候选的已完成报告，不能替代仍缺 adapter/oracle 的完整矩阵。`post-live-config-integrity.json` 确认全部回归后共享配置仍与清理后的 M0 配置字节一致。

FIFO 和取消第一批三轮真实核心断言均通过，详见 runner 文档的具体范围。取消验证的是保守阻塞，实际子进程退出由测试清理单独处理。中断管理轮已新增逐请求 native 策略记录（只含工具名/哈希/身份）、冲突策略撤销及进程关闭记录；披露 oracle 只在这些实际证据齐全时核验中断路径。最新独立 `cancel-policy-live/3cf30250-50de-47f9-8c07-3554cb820896` 三次中断披露审计及所有已实现断言全部通过；每次只因写工具远端写入 oracle 未实现而 BLOCKED。

跨 scope 的 LIVE-21 已接入可信本地 route、双业务绑定、真实原文请求、B 历史/原生上下文排除 A 校验词、B 对 A 原件实际拒绝读取、真实工具边界身份注入等检查。初版三次未正确准备双业务绑定，误将合法管理查询判为业务未完成；旧 FAIL 保留。新 `scope-bound-live/49c2afdd-7997-4576-8e28-019fec327181` 三轮全部断言 PASS，包含双 scope 的原生会话/管理会话隔离、历史与原件边界、身份字段拒绝和五项全局断言。

本轮一度出现离线维护 MG03 单项失败（351 项中 350 passed / 1 failed，`scope-runner-check.txt`）。单独维护回归与后续完整 352 项通过，原失败保留，原因未确认，不直接归因环境。早期新测试夹具遗漏 command job 对 request 的绑定导致 `ANSWER_REQUEST_OWNER`，已按真实 controlJob 路径补齐关联。

原生兼容补丁静态检查已补齐：在磁盘可用空间恢复后，限定 core/features 的 `just fix` 和只读 `just clippy` 均完成；保留一个上游原有 unused-import warning，未纳入无关修复。随后 `just fmt` 成功，确认源码 diff、补丁和 binary 哈希不变。完整 Rust workspace 的 V8 依赖阻塞及跨平台未验收状态保持不变。

LIVE-30 adapter 与真实历史工具观察仪表已实现。`interaction-live/ed48f84a-1b1b-4c65-a160-bc9e6bda32c1` 已完成 31 轮 × 3 attempt 的真实数据准备和查询测试；这是普通历史行为测试，不是 1M/80% 测试，窗口未缩小。旧轮前两次已通过独立重算、第三次保留真实失败；新轮三次执行完成并通过独立重算。runner 新增 PID 记录、停止信号服务关闭与后续调用准入阻止，逐轮写准备进度。

LIVE-14 `corrupt-live/fe0ac2ef-5ddb-4e64-9d18-7bbb49b2a622` 已完成三轮，每轮分别覆盖已有 binding 和程序显式 `/resume`：真实业务在隔离 native home 完成健康准备并通过 verifier，随后在 native coordination lease 下追加目标 cwd 错误事件；之后业务 backend 调用为零、无 fresh fallback、明确 HISTORY_SCOPE、forbidden.txt 不存在。原始 case 因缺全局 oracle 为 BLOCKED；独立 `corruption-reevaluated-result.json` 从原账本补核原文、权限、无重放及 Bridge 披露，三次均只剩远端写入 oracle BLOCKED。原报告保留。

发现并修复实际缺口：一次恢复验证失败后，同一请求原先还可选择 new 或使用先前拿到的新会话 token。`resume-refusal-before.txt` 记录复现失败；现在 refusal 按 requestId 持久化，覆盖准确 ref 校验和显式 history reference 解析，后续 resolve/select/validate 拒绝同请求回退，Route 正常结束也会返回原校验错误。独立新请求的显式 new 仍可执行，不绕过 tainted workspace。

隔离业务认证只暂存有效 access/id token 与账户标识，refresh token 固定为空，不复制其他密钥；私有目录 0700、文件 0600，结束即删除。三次隔离 home 共 598 个文件的事后扫描未发现访问令牌残留，auth.json 数量为零（`isolated-auth-cleanup-audit.json`）。共享认证文件只读，故障修改限于新建隔离 native store。

LIVE-30 原第一、二轮仅因 oracle 要求第二次必须重新调用历史工具而 FAIL；实际模型正确从刚读取的 30 条数据中筛选 A。已改为核对实际来源页和最终答案编号，在答案文件、DB 与原 manifest 哈希一致后生成独立 `history-reevaluated-result.json`，两次完整 PASS；没有额外模型调用或重放。第三轮已结束且实际失败：请求 limit=70/35 被上限30拒绝；该次不重算放行。

LIVE-19 已三次完整 PASS，证据 `delivery-live/0313d90e-b67a-45e5-8ac0-e3a2fab5eee0`；业务/投递分离、unknown 不重发、重开服务和显式结果恢复均有真实结果。它只验证 LocalChannel 故障注入，不是 live Weixin。

修复历史第三轮问题：模型可见工具描述明确上限/每行含义，安全错误码区分参数错误；全对话历史不再委托给单目录。管理策略 fingerprint 覆盖静态 instructions 与工具定义，策略变动换代管理会话但不改业务 binding。Route 的每请求 intent 由宿主检查，不再持久化为易过期的初始化文本。新 `interaction-limit-live/5c73377b-4e6d-4c69-ab36-078ec98b1efd` 三轮已完成，独立重算结果及限制见下文。

补跑曾出现 MG04 的 359 passed / 1 failed（`delivery-policy-final-check.txt`）：临时副本报 supervisor.js 缺少 supervise 导出。代码检查发现启动脚本生命周期测试与 MG07 会重建共享 dist，与并行维护测试的复制冲突。启动脚本现从私有源码副本进行真实构建；MG07 使用已构建的重启预检和 CLI，不触发无关共享构建。修复后完整 360/360 通过，保留原失败；不把此前所有未明 flake 自动归为同一原因。

Recap 已加入持久化尝试账本：同 answer/source/prompt/model 最多 3 次尝试，开始状态与准入计数、终态与完成记录分别在短事务内提交；仅记录次数、时间和安全错误码。历史失败记录缺计数时返回 RECAP_ATTEMPTS_UNVERIFIED，不猜测剩余预算；ready 结果保持缓存。测试说明更换 RecapService 实例不重置预算，也不改变业务原件。

LIVE-18 adapter 已执行真实长答案与摘要故障/重试，`recap-live/c6baa29e-ed1d-4657-852a-524ada59e54e` 三次业务执行一次、原件不变、无 raw 兜底、摘要可独立恢复、投递独立等核心及已有全局断言通过；每次仅因远端写入 oracle 缺覆盖而 BLOCKED。历史新第一轮的表格答案与无工具筛选均为合法行为；独立重算 PASS，原记录不覆盖。新增无工具审计测试曾发现缺失策略记录也被误认可，已收紧为必须存在匹配 native 策略；修复后 362/362 通过，失败日志保留。

LIVE-15 已接入真实分页负例：隔离 store 中 10 个不可用 alias 和 2 个可读合成候选，首个实际 10 行页为空但 partial/nextCursor=10，后续候选 updated_at 与完成时间顺序相反。合成数据只用于 metadata，不称为真实 Agent 会话。宿主现在拒绝当前请求在覆盖/顺序不明后改走 new，也拒绝直接执行非默认候选；分页 cursor 会返回给管理层，另一个独立显式选择请求仍可处理。

旧 `partial-live/607ad8cd-29b2-41ba-ba04-d67ec88d261e` 的第 1/3 次核心断言通过，第 2 次真实失败：没有查历史就声称沿用会话。已明确“找上次会话”不是纯目录切换；纯目录切换由宿主生成“未恢复或执行业务会话”的回执。新的 `partial-selection-live` 三轮核心通过，加入现有纯管理审计后的 `partial-complete-live/147fd26b-ac5f-4d6e-9693-a238f9ca251b` 三轮完整 PASS；旧失败不改为 PASS。

LIVE-13 adapter 已在隔离业务 native home 建立真实健康绑定后添加同 cwd、单行 9 MiB 的合法合成非对话记录。单独读取该记录得到截断/省略提示；真实续接阶段观测 NativeReader/locateExact，只允许健康目标被检查。`large-history-live/04ea29fb-7d55-48fd-ae6b-3510079457c9` 三次核心及已实现全局断言通过；每次只因远端写入 oracle 缺覆盖而 BLOCKED。该审计限于宿主读取路径，不宣称完整 OS 文件访问监控。

`partial-selection-live/d25505ed-3421-4616-a9ae-a9712d1b43ed` 三次核心和已有全局断言通过；随后加入已有的纯管理远端写入审计，在全新 `partial-complete-live` 三次全部 PASS。没有通过伪造 Git 前态重算旧记录。

无 binding 且 metadata 完整、恰好只有一个候选时，宿主现在仅验证该准确目标并缓存已验证完成时间，再决定是否为默认；不会扫描其他 transcript。多候选/partial 仍拒绝猜测顺序。LIVE-12 已接入隔离 store 中真实 Codex CLI 外部创建、Bridge 无 job/binding、随后准确续接与 nonce 验证。首批 `external-live/886c02c4-6d4e-4027-b40a-b82e88581a49` 三次失败，含工具 limit=20/30 超过本机 10 上限、以及混合“查找+继续+回复”被当成纯历史。现所有工具描述从真实 host schema 自动附加边界，保留原校验；提示明确这种组合必须由业务会话回答。修复后的真实复测结果见下文；首批失败保留。

仅补 bounds 的 external-bounds-live 第 1 次仍因混合请求意图失败，第 2 次已正确恢复外部 native ID 并返回其 nonce（核心及已有全局断言通过，远端写入仍缺）。包含组合意图修正的全新 external-intent-live 三轮已结束，结果见下文。

历史参数修正后的 `interaction-limit-live/5c73377b-4e6d-4c69-ab36-078ec98b1efd` 三次已全部执行完成，`history-reevaluated-result.json` 均 PASS。目录表格中的同一行重复引用自身编号不等于重复交互，无工具筛选仍有本轮可信策略与完成证据；各次原 FAIL/BLOCKED 文件保留。旧 interaction-live 第三次实际参数失败保持 FAIL。

`external-intent-live/d139df9e-ffb7-4db6-8fea-c3636ada3d9a` 三轮准确恢复外部真实 CLI 会话并返回 nonce，核心及已有全局断言通过；原件/输入保持身份，管理 session 被排除。该轮缺远端写入 oracle，仍 BLOCKED。后续 `external-complete-live/1ee08673-60b7-45a4-a9fe-dabbf7d53b75` 已完成：第 3 次完整 PASS；第 2 次只有本地 ALL_TOOLS 元信息筛选，核对原生文件 SHA/revision 未变后，独立 `metadata-reevaluated-result.json` 为 PASS。该查询仍记为工具执行，严格 AST 白名单与同 turn 的 call/output 配对只证明未调用远端动作，不宣称 OS 隔离。第 1 次包含真实命令执行，仍为 BLOCKED。原报告均保留，重算没有模型调用或业务重放。

LIVE-20 adapter 已实现四个独立 fixture：恰好24h、24h+1ms、显式恢复旧会话、管理操作。只通过 openService 的业务时钟 seam 改变会话年龄判断；控制器换代以 rotate_pending 状态注入，保留原 runtime usage，明确不宣称真实等待24h或真实跨80%。管理分支核对历史读取、原件投递、缓存短答 recap 和真实管理换代不刷新业务时钟；缓存 recap 不冒称新的摘要模型调用。旧 `clock-live/50308d83-446c-4d7a-a9bf-282585613b08` 三次 FAIL：过期默认 new 被模型拒绝执行，以及一处准备请求被当作纯目录切换。Route 静态提示现明确普通工作遵从宿主过期后的默认 new，准备阶段使用明确的记忆任务建立业务会话。全新 `clock-default-live/a4e9e6c2-3dbb-4cc4-89c1-d01e46a0ce54` 三轮已完成，四个核心断言及已有全局断言全部通过；各次只因控制命令的远端写入 oracle 未覆盖而 BLOCKED。旧请求未重放。

LIVE-23 adapter 已加入目录描述和合成历史提示注入、随机 scope 外 canary、Bridge 原件读取/伪造委托参数直接拒绝探针，以及真实管理工具返回和宿主读取路径审计。合成历史标为 system fixture，不伪造业务模型完成证据；旧 `injection-live/1a9a90d8-73c8-4d19-b87d-45475e49e064` 三轮 fixture 的目录标识使用错误，历史未命中，保留 FAIL，已改为生产 directoryIdentity 生成方式。新 `injection-bound-live/94e6e948-b7b5-404e-94b5-e4d1aab03175` 三轮均完整 PASS；原旧 fixture 失败保留。

LIVE-05 前置检查 `model-prerequisite-live/35dda94a-f133-49fe-936d-d61538786d74` 三次均为 LIVE_DISTINCT_BUSINESS_MODEL_NOT_CONFIGURED：当前配置只有同一 model ID，没有不同模型的 alternate profile。未调用模型、未以同 ID 冒充替代模型测试。该历史检查不算模型覆盖验收。现已通过实际 model/list 发现 gpt-6-luna，并完成独立能力证明；临时 alternate profile 和 LIVE-05 adapter 已准备，业务窗口映射现已修正并完成三轮 LIVE-05 核心验证，结果见后文。

LIVE-07/09 长答案 adapter 已接入捕获 final/归档 hash 比较、真实工具输出校验词来源、Recap 总字数约束、原件不可变、Bridge 实际工具返回无长原文，以及 Route metadata/outline→range 的真实调用顺序和范围。LIVE-07 额外明确注入一次 Recap 服务故障，再只重试摘要，以同时核对失败兜底和正常摘要；不重跑业务。`long-original-live/cdba79d0-b41d-4126-a9a7-6650e7fb4e97` 首轮核心与已有全局断言通过，仅远端写入审计 BLOCKED；强化后的校验词来源检查另用原生快照 SHA 的精确字节前缀独立重算通过，不重放请求。`long-history-live/a8fd66ec-0deb-437f-88f3-cac7362376ca` 首轮 FAIL：Recap 已包含随机标记，未满足“只能从原件查到”的准备条件。原 LIVE-07 三轮均只剩远端写入审计 BLOCKED；原 LIVE-09 第 2/3 轮核心及已有全局断言通过，仅远端写入审计 BLOCKED。Recap 提示现要求附带随机校验串仅描述用途/存在性，不复制校验串；保留有意义事实、限制和选项。新 `long-history-summary-live/d4300c6c-b7f4-41e5-bb1f-98069d4daf27` 第 1/3 轮核心及已有全局断言通过，仅远端写入审计 BLOCKED；第 2 轮真实失败，Bridge 查到摘要后未委托 Route 读原件。已补 Bridge/Route 的原文细节委托规则，新 `long-history-route-live/92015f4b-d926-4b78-992d-8a3c373186c7` 三轮核心及已有全局断言全部通过，仅远端写入审计 BLOCKED；旧失败保留。

RecapService 在调用模型前持久化每次 attempt 的 modelCallIds；CodexRecapModel 按 ID 保存源原件/请求/recap/hash、阶段、prompt/result hash、真实 thread/turn、policyVerified 和 cleanupConfirmed，并将原生策略诊断关联到该次调用。日志不存原文或摘要正文，关联字段不拼入模型 prompt。远端写入 oracle 只有在所有准入调用都具备匹配的无工具 native 策略和退出证据时才接受 LLM recap；旧缺账本、缺调用、工具返回或清理不明均不通过。

已补设计 §9.7 的 search_interactions：SQLite FTS5 trigram 索引仅含原始 query 和可见短记录，短于三个 code points 的词用同一安全索引内容做字面匹配；查询语法视为字面短语。宿主绑定 scope、校验目录授权、按 ingressSeq 分页，摘要 ready/failed 与结果直送状态变化通过事务触发器同步；不读取原件或 jobs.result_text。已有 v4 库首次启动只回填此派生索引。首次离线检查因视图名撞上 FTS 内部 shadow table 失败，已更名修复，原日志保留。

额外真实模型搜索检查 `search-live/7b29a9fc-fd0c-4581-bfcb-85c04e3a1bd0` 三轮 PASS：真实 gpt-6-sol/medium 管理模型调用搜索，准确返回本目录匹配项，排除另一对话及只在原件中出现的词，业务调用为零，Bridge 披露/远端写入审计通过，配置未变且清理确认。准备数据明确是合成 system 历史，不冒称业务 LLM 完成；报告保存脚本/编译候选 hash。

迁移现在给旧结果增加 legacy-result 元信息：OUTPUT_TRUNCATED 对应 legacy-truncated，其他结果为 unknown；originalArchived=false，旧文本仍在 jobs.result_text，未伪造原件文件或完成证据。/debug 返回该标记而不暴露旧结果正文。LIVE-24 adapter 已加入真实 CLI 旧 session、v3 WAL backup/dry-run/apply、健康原 ID 续接和独立 tainted 分支；旧裁剪命令结果、游标和中断状态是明示合成 fixture。`migration-live/650eb070-d1a6-42cd-b164-c7ebd26dcdb9` 三轮的五个核心断言及已有全局断言通过，每次仅远端写入审计 BLOCKED；临时 auth.json 剩余数为零。

LIVE-13 已接 before/after Git 快照与 native/management/recap 审计，验证读取范围的仪表在事后审计前恢复，避免把审计读取混作续接读取。`large-history-complete-live/09ba8cce-9c21-4a45-a9c0-493d4d93f2bd` 三轮核心及已有全局断言 PASS；每轮原生确有两次读取 README 的 rg 执行及 CommandExecution 记录，原命令审计未覆盖，原报告保持 BLOCKED。现补充受限读取审计并对原件独立重算：read-command-reevaluated-result-v2.json 三轮完整 PASS。记录仍明确为实际命令执行，不改称“无工具调用”。

正常 hierarchical 启动现可在原 Bridge PID 已死亡、记录的 Agent PID/进程组均消失时归档遗留 service/agent 资源锁；ControllerFactory 仍先拒绝活跃或不明管理进程。恢复互斥 guard 防止并发争抢，未完成的 guard 需显式 review；活动资源不清除。此步骤不修改 job、reviewed_at、taint 或 workspace lock，后续正常账本恢复仍保留 interrupted/uncertain 与 blocked，不证明未知 detached daemon 已消失。旧 legacy 启动路径不变。

LIVE-17 crash adapter 已加入真实子进程的 openService/真实管理与业务模型、prompt admitted + 开始标记边界上的 SIGKILL、明确的 harness 脚本释放清理、原生已记录进程组退出检查及正常 openService 重启。配置仅经 IPC 传入，不落盘复制凭据；测试仅 LocalChannel。`crash-live/8cfe67b9-dc59-405a-9784-852c0e7f0dcf` 三轮真实 SIGKILL 已完成，四个核心断言及权限/原文/不重放断言通过，cleanupConfirmed 均为 true；原报告缺少崩溃 Bridge 轮披露审计和命令执行远端写入审计。现已从 kill-boundary、准确 actor/native ref、归档进程 marker 与 PID/组退出证据补充独立 closure-disclosure-reevaluation.json；仅把无 result hash 且无 wire 返回的 started 调用认定为随进程退出而放弃，不伪造 native turn.completed。三轮 closure-reevaluated-result.json 的披露断言 PASS，只剩远端写入 BLOCKED；原数据库字节和既有证据哈希已核对未变，没有模型调用或重放。

LIVE-08 摘要语义 adapter 已加入：fixture 在请求前提交一个已有本地 arithmetic 测试基线，真实业务运行测试并输出长报告；原生 CommandExecution 的固定测试命令、准确 cwd、exit=0 与测试实际发出的随机标记分别核对。摘要限制/未完成/有序 A/B/问题做结构和词法初筛，真实退出结果及 Git 事实独立核验，不拿模型“测试通过”的文字代替执行证据。该测试只是合成项目的轻量测试，非生产 term4u 测试；`recap-semantics-live/5cbc7178-7658-4b65-8674-9e95f8eda1d2` 三轮核心及已有全局断言通过，仅远端写入审计 BLOCKED。Codex 另按源文结论/选项/问题、真实测试退出证据及 Git 快照逐轮复核，semantic-review.json 绑定源文件 hash；这不是独立人工验收。

`alternate-probe/164ac009-0e44-42f2-ad87-fd5d02f971e7` 的 gpt-6-luna/medium 独立 M0 PASS，真实有效窗口同为828400。仅作为 LIVE-05 业务临时覆盖，管理层仍 gpt-6-sol/medium；私有配置及具名能力证明已准备，已运行 LIVE-05，结果见后文。

新发现需要修正的窗口映射：当前 ModelProfile 数值828400用于管理层有效容量断言，但业务 exec 把它直接传作 Codex model_context_window 总窗口，原生 token_count 实际为786980。固定0.155.1源码 ModelInfo.usable_context_window 按有效比例扣除预留区；缓存中 Sol/Luna 的 max_context_window=872000、effective_context_window_percent=95，共享原生配置总窗口=1000000。business-window-discrepancy.json 保存原生记录/数据库/固定源码 hash。新增 observedContextWindows 原样记录观测值，不拿配置替代；该差异的修复及短请求实测见后文，不代表1M/80%通过。

已修正有效窗口映射：hierarchical 业务在 prompt 提交前通过原生 model/list 验证/刷新自身模型缓存，按原生有效比例用整数换算需要的总窗口，并核对 max_context_window；缺元数据或超上限明确拒绝，不猜测回退。当前828400有效容量对应872000原生总窗口，真实业务 token_count 已回到828400。元数据子进程同样记录/清理 PID marker，遵守取消及总任务时限，使用临时 untrusted project 配置，不继承项目本地设置；日志及 business-context-window 只保存数值/模型/metadata hash。新策略进入 profile digest。Legacy 直接 Codex 配置保留总窗口语义。

LIVE-05 首批 model-override-live 三次均保留 FAIL：第二条请求虽由 Bridge 标为 work，但 Route 从目录元数据直接回答名称，未提交业务。宿主现拒绝这种降级：work 无业务提交则 BUSINESS_NOT_SUBMITTED；只有宿主确认无默认会话选项时才生成“尚未执行、需明确选择”回执。静态提示也明确项目名/标题工作必须交给业务。修复后的 model-work-live 三轮模型覆盖、默认来源、profile digest/字段来源及原生有效窗口检查均通过，仅远端写入审计 BLOCKED。

LIVE-06 adapter 已加入真实业务两项独立修改、只读查A后active仍B且focus准确、原session续接、原文透传、A两次提交及本地bare ref与原HEAD一致、B sentinel不变。第一批 git-followup-live 三次 FAIL：原生默认保护 .git 为只读，业务在临时副本提交推送，原工作区HEAD未更新。真实本地 sandbox 探针已确认显式限定权限可写目标工作区/物理.git，并拒绝邻接目录/.codex/.agents写入（git-permission-probe/8d6da5e5-6c5b-4cf8-b164-fd04b52b71f8/scoped-git-profile-report.json）；不是完整Agent OS隔离认证。新 hierarchical workspace-write 使用宿主生成的 bridge_workspace 权限配置，仅为本目录物理.git授予例外，符号链接/外置gitdir不扩大权限，网络和never审批约束保留。`git-scoped-live/2759969f-c531-49c9-9f43-c73cb05d8e08` 三轮核心及已有全局断言全部通过，包括原 A 工作区提交/本地 bare ref 一致与 B 不变；每次仅远端写入审计 BLOCKED。

LIVE-28 adapter 已接唯一连续指代和双候选两个独立 Git fixture。双候选由真实业务分别在 A/B 留下未提交修改，再通过真实用户层说明要求省略目录时先澄清；未向模型手工注入已选目录。核对澄清前零业务执行、选择后 sourceRequestId/原工作 query hash、重复选择消息去重，以及 A 的本地提交/推送和 B 不变。宿主选择解析新增“就是刚才查的 term4u 那个”完整句式，只匹配已授权选项；混有新工作内容仍保留为新请求，多选匹配拒绝歧义。`elliptical-live/cc622b2d-68f0-47d2-8fc0-acb276e28c72` 三轮、每轮两个独立子场景均完成，核心及已有全局断言全部通过，仅远端写入审计 BLOCKED。

受限读取审计仅接受已核对的有限精确 rg README/AGENTS 文件枚举和 README 标题读取形式；TypeScript AST 拒绝额外调用、展开、未知字段和提权参数。显式 workdir 必须等于已验证目录，并要求同 turn 原生 managed/read-only/restricted-network 策略、配对 call/output、唯一成功 CommandExecution 与命令/cwd一致；跨 turn 沿用策略、缺失/重复记录、未知命令仍不通过。LIVE-13 重算核对原 native 文件SHA/revision、原数据库字节与 Git 快照均未变，没有新模型调用或重放。这是有限已观察读取操作的证据，不是任意 shell 或全系统副作用/OS隔离证明。

code-mode-calls 只做闭合语法调用提取，不执行 JS：覆盖 const/await、Promise.all/allSettled、只打印结果的 for-of/forEach、JSON 显示表达式及固定 exit_code 失败退出。输出位置可显示 opaque tool result，但不能把它当作工具参数；隐藏调用、动态参数、未知语法和部分解析均拒绝。shell-commands 使用固定 devDependency mvdan-sh 0.10.1 的 AST 枚举有限命令和条件分支；该包为 BSD-3-Clause、一个包，npm 已标 deprecated（指向上游 mvdan/sh issue 1145），仅用于验收，不进入生产执行路径。最终依赖选择后 npm ci 成功，仍报告原有 1 high vulnerability；未自动升级。bash-parser 和 sh-syntax 的评估安装已移除，不在 lockfile 中。

原生命令审计现在对有限读取、有限 pathlib 读取/字节比较/打印/断言程序（用隔离 Python 标准 AST 解析，源程序不执行）和 fixture Git 命令逐项配对，要求本轮 managed/restricted-network 策略、完整 call/output、唯一命令/cwd/终态 mirror；失败退出也记录真实非零状态，不冒充执行成功。Git 不能仅靠语法获通过：额外读取实际有效 config，拒绝 includes、URL 改写、pushurl、自定义 hooks/filters/fsmonitor/外部 diff 等；核对物理目录和本地 bare ref。add-file patch 需要原生 FileChange 精确匹配和最终物理文件/内容哈希。审计仅保存哈希和有限状态；它依赖本机工具链及原生策略证据，不是全系统副作用或 OS 隔离证明。

`git-audited-live/483d69d6-322d-4648-9cb1-ba86bd2e3139` 三轮已完成，原报告因新命令变体未分类而 BLOCKED，核心及其他全局断言通过、清理确认。补齐受限语法后，使用其真实初始/最终 Git 快照和未改变的原生文件 SHA/revision、原数据库哈希独立重算：三轮 scoped-effects-reevaluated-result.json 全部 PASS，原报告保留，没有业务重放。

同样按原 native SHA/revision、原数据库字节和原 Git 快照只读重算，model-work-live（LIVE-05）、long-history-route-live（LIVE-09）、external-complete-live（LIVE-12）、short-answer-live（LIVE-29）各三轮 scoped-effects-reevaluated-result.json 全部 PASS。均只提升对应候选的远端写入审计，不宣称全套当前候选验收已完成。

完整原生动作中没有写入能力时，远端写入断言可由实际动作和管理工具/摘要审计证明；涉及文件/Git 修改则仍要求真正的前后快照。缺一侧快照、已提供但不匹配的快照、未验证脚本/工具均不放行。补充采集的原生文件用当前采集时间/hash标记，不假称旧时已采集。LIVE-20 clock-default-live 四个分支各三轮 supplemental-effects-reevaluated-result-v2.json 全部 PASS；原始报告和初版补审保留。/read、/more、/result 的直送原件依 system 完成、result-delivery 分类和无 Recap 调用证明，不要求本来就未调用的摘要模型提供完成记录；真实 24h/80% 仍未测。

旧 LIVE-07/18 的补充审计仍 BLOCKED：LIVE-07 的故障是在 native 调用前注入，但未保存对应调用跳过证明；旧 LIVE-18 还缺完整 Recap 调用账本。现测试仪表在调用原 CodexRecapModel.summarize 前记录 test-only injection identity，审计将其与失败准入次数及零 native 调用证据配对，不伪造 turn.completed。这三组批次均已结束。long-original-audited-live 的历史查询出现真实意图冲突失败，后续修复及复测见本阶段提交状态；recap-audited-live 与 elliptical-audited-live 已完成后续补审。

固定 arithmetic fixture.test.cjs/package.json 审计、受限 marker 文件写入哈希审计、FIFO 固定脚本及宿主拒绝检查已纳入编译和离线检查。迁移基线核对作为本阶段新增测试代码提交，其完整 live 验收仍未完成。
