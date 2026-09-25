# Acceptance and regression matrix

## 三层施工覆盖

下方原 58 ID 表保留验收编号和退役说明，现行服务仅为三层模式，不代表三层模式已经逐项 live 验收。三层新增测试均明确标为 OFFLINE；实际运行计数见 [当前验证](verification.md)，剩余设计差距见 [实现状态](THREE_LAYER_IMPLEMENTATION_STATUS.md)。

| 原 ID 范围 / 新边界 | 三层离线补充 |
|---|---|
| N01/N04/N07、Q01 | `unit/orchestration` 原文身份、scope、去重和冲突；`e2e/hierarchical` 三层原文传递 |
| M01/M09/M10、B01 | `e2e/hierarchical` 当前媒体 hash、后台准备和活动 root 保留；不代替视觉 live |
| B02/B03/B06、Q 系列 | `unit/business-sessions`、`dispatch`、`controller-manager` 与 `e2e/hierarchical` 会话、FIFO、单次派发和换代 |
| B04/B05、R 系列 | `unit/answers` 原件提交/恢复与 recap 失败；管理代际和取消离线覆盖，完整故障矩阵仍未完成 |
| D 系列、诊断和历史 | `unit/history-*`、`directories`、`tool-audit` 与 `e2e/hierarchical` 的 scope、只读和脱敏检查 |
| 模型/window 来源 | `unit/orchestration` 逐字段来源；`contract/codex` 固定窗口参数；`contract/pi` prompt 前 window 校验；`e2e/hierarchical` digest 变化不静默续接 |
| 初始化、维护与 live 报告 | `unit/hierarchy-schema` 检查空库初始化与非空库原样拒绝；`unit/maintenance-result` 和 `e2e/hierarchical` 维护原件、重复收尾、启动恢复与 live 重放仪表的离线检查；`unit/live-report` 保留 33 case / 145 assertion / 5 global，锁定预期并校验证据文件/hash，缺证据不得 PASS；LIVE-24 迁移实现已移除，保留设计编号并返回 `DATA_MIGRATION_REMOVED` |

当前 high 能力探测和隔离进展查询验证见 verification.md；完整三层 live 故障矩阵仍未通过。LIVE-26/27 真实大上下文测试按用户要求暂缓；LIVE-W01/W02 需手机参与，尚未执行。

## 原 58 ID

原 58 个验收 ID 来自基线 `5d882cbbd6906678ca8f0728b3a1b0a14734d361`。下表映射当前本地和个人微信实现，明确标记企微特定行为的退役，不把退役项计为通过。实际用例数与现场验证边界见 [verification.md](verification.md)。

| ID | 原要求 | 当前实现与证据边界 |
|---|---|---|
| N01 | 单聊文本与路由 | 本地固定 actor/session：unit/core N01；个人微信路由：W01、W06。 |
| N02 | SDK generic / specific 双事件 | 企微 SDK 双事件机制退役；本地和微信重复投递由 Q01、CLI01、W06/W12 覆盖。 |
| N03 | 远程用户/群白名单 | 企微白名单退役；本地拒绝注入 actor/route；微信仅允许扫码绑定用户，拒绝群消息：W01。 |
| N04 | 缺少消息身份/错误 bot | 本地必须提供 request ID；微信必须有消息 ID 和上下文，校验发送者及提供的目标 bot：W01。 |
| N05 | mixed 多段文本/图片 | 企微 mixed 帧退役；本地图片数组与文本限制仍在；微信解析 item_list 的文字、图片和语音转写：W02/W07。 |
| N06 | 一层 quote | 本地拒绝 quote 字段；微信引用消息明确回复暂不支持：W02。 |
| N07 | 群/单聊/发送者隔离 | 按通道、账号、会话、工作区和后端隔离：unit/core N07、store identity、W01/W11。 |
| N08 | 未知类型/命令 | 本地未知字段或 slash command 被拒绝：unit/core、e2e/bridge N08。 |
| M01 | 明文/加密图片内容 | 本地原始字节/hash：unit/media M01；微信解密后图片字节：W05/W07。 |
| M02 | AES padding / key | 原企微加密协议退役；个人微信 AES-128-ECB、密钥格式及解密错误由 W05 覆盖。 |
| M03 | 下载流字节边界 | 有界本地文件读取：unit/media M03；微信 CDN 响应上限：W05。 |
| M04 | SSRF / DNS / 重定向 | 本地拒绝 URL：unit/core M04；微信下载器限制 HTTPS 固定 CDN、拒绝重定向：W05。 |
| M05 | 伪装的 HTML/SVG/EXE | unit/media M05。 |
| M06 | 像素、损坏和动画 | unit/media M06：像素、全解码、有效动画 WebP 拒绝。 |
| M07 | 下载超时/URL 过期 | 本地缺失文件与取消：unit/media M07；微信下载设 20 秒超时，真实 URL 过期/超时场景尚未逐项验收。 |
| M08 | 路径逃逸和 symlink | unit/media M08 + controlled-path helpers。 |
| M09 | 活动媒体 TTL | unit/media M09。 |
| M10 | 长任务期间下一张图先准备 | e2e/bridge M10，独立于单 Agent worker。 |
| P01 | JSONL 任意字节切分 | unit/core P01。 |
| P02 | Unicode separators / CRLF | unit/core P02。 |
| P03 | prompt ACK 非完成 | contract/pi delayed case。 |
| P04 | agent_end / retry / settled | contract/pi retry case。 |
| P05 | 最终 error stopReason | contract/pi error case。 |
| P06 | 会话切换取消 | contract/pi session-cancel case；守卫同时用于 new/switch。 |
| P07 | prompt 拒绝 | contract/pi reject case。 |
| P08 | 进程退出/EPIPE/非法/超大帧 | unit/core P08 + contract/pi exit/malformed + Codex bounded stream cases；完整真实 CLI 行为仍待 live。 |
| P09 | 旧 epoch | contract/pi unknown epoch response + pre-prompt stale events。 |
| P10 | extension UI | contract/pi ui case；拒绝审批并保守中断。 |
| P11 | 父环境凭据隔离 | unit/core P11 + contract/codex C17；改用通用父进程秘密，无旧 transport 常量。 |
| P12 | 历史会话丢失/未保存会话 | contract/pi P12。 |
| B01 | 原生图片输入 | unit/media、Codex C02、Pi B01、微信 W07 验证字节传递；现场带图任务成功不代表视觉语义正确。 |
| B02 | 两轮会话复用 | Codex C01、Pi B02、CLI01、微信 W06；真实 Codex / Pi 两轮 smoke 的结果单独记录。 |
| B03 | 新会话清除上下文映射 | contract/codex C04 + e2e/bridge /new。 |
| B04 | 空结果/拒绝/工具错误 | empty final、错误 stopReason、非答案事件测试。真实模型拒绝/工具失败的业务语义未 live 验证。 |
| B05 | 取消与实际子孙进程停止 | contract/codex C12–C14 + contract/pi B05 + CLI05；脱离进程组的守护程序仍属人工/外部隔离边界。 |
| B06 | 会话映射持久化失败 | contract/codex C11 + contract/pi B06。 |
| Q01 | 十次并发重复和重启重放 | e2e/bridge Q01、recovery R02、CLI01、微信 W06/W12。 |
| Q02 | 全局单执行任务 | 每个 stateRoot 单 worker：unit/store Q02、e2e/bridge queue；`unit/codex-permissions`、`dispatch` 与目录锁验证跨 stateRoot 同真实目录互斥（同宿主同用户）。 |
| Q03 | preparing 不被同会话越序 | unit/store Q03 + e2e/bridge Q03。 |
| Q04 | 队列容量前置拒绝 | e2e/bridge queue capacity case。 |
| Q05 | 重复 /new | e2e/bridge Q05。 |
| Q06 | 任务所有权 | unit/store Q06、e2e/bridge ownership、微信 W01/W11。 |
| Q07 | 取消/成功竞态 | unit/store Q07。 |
| Q08 | 执行中 status | e2e/bridge status-not-waiting；不是已测量生产 SLA。 |
| D01 | Unicode 输出分片 | unit/core D01。 |
| D02 | 过期回调与主动回复 | 企微回调生命周期退役；本地 outbox/CLI03 与微信配对用户/context 路由 W06 分别验证。 |
| D03 | 明确未发送 | unit/store-reply disconnected case。 |
| D04 | 输出确认未知 | unit/store-reply unknown、微信 W09：不确定发送不自动重发，不重跑 Agent。 |
| D05 | 已确认发送 | unit/store-reply sent-once、微信 W14：合法 ACK 记录 sent；不等同手机已读。 |
| D06 | 永久/可重试错误 | unit/store-reply D06。 |
| D07 | 自动分页上限和结果领取 | unit/core D07、store D07、e2e/bridge /result。 |
| D08 | 原始错误含秘密 | Codex C08 和结构化日志；微信 W03/W09/W13 验证 API 错误边界，日志不输出原始错误体或凭据。 |
| R01 | preparing 时强杀 | e2e/recovery R01：真实 SIGKILL，失败及孤儿清理。 |
| R02 | queued 时强杀 | e2e/recovery R02：SIGKILL 后完整输入持久化；三层冷启动执行已验证的排队请求一次且重投去重；unit/dispatch 验证 FIFO 与提交不确定时禁止重放。 |
| R03 | running 已有修改时强杀 | e2e/recovery R03：实际文件变化，blocked/tainted，不重跑。 |
| R04 | 结果事务中强杀 | e2e/recovery R04：原子回滚。 |
| R05 | 提交结果后强杀 | e2e/recovery R05：只输出，不调用 Agent。 |
| R06 | 输出中强杀 | e2e/recovery R06：unknown，人工领取原结果。 |

新增 Codex C 系列覆盖 exec 参数、精确 thread resume、坏帧/超大帧、线程不匹配、持久化失败、终态和进程退出的联合判定、超时及进程树取消。CLI01–CLI06 覆盖真实 CLI 进程的端到端路径。默认运行绝不连接真实模型或账号。

## 个人微信和启动脚本回归

| ID | 验证内容 |
|---|---|
| W01 | 配对身份、目标 bot、群消息/机器人回声拒绝、会话路由 |
| W02 | 语音转写输入；无转写、文件、引用的能力边界 |
| W03 | 请求头、uint64 消息 ID、业务错误、有界响应和 API 主机限制 |
| W04 | 扫码验证码、跳转、认证文件权限与登录复用 |
| W05 | 图片密钥格式、解密、下载体积和 CDN 限制 |
| W06 | 微信输入到真实测试子进程、会话延续、去重、回复路由 |
| W07 | 加密图片到 Agent 原生字节；未授权图片不下载 |
| W08 | 无转写语音明确回复且不启动 Agent |
| W09 | 发送 ACK 不确定时不重发、不重跑 |
| W10 | 长轮询、游标持久化、回声过滤、取消退出 |
| W11 | 不允许切换已有状态的 transport 或绑定账号 |
| W12 | 接收持久化后、游标提交前的重复投递仍去重 |
| W13 | 收发响应允许省略成功码，仍拒绝非法及非零错误码 |
| W14 | 省略成功码时完整接收、执行、回复确认和游标链路 |

`tests/e2e/start.test.ts` 验证其他 cwd、含空格配置路径、平滑替换、SIGSTOP 后 SIGKILL 升级、残留锁恢复、JSONL stdout、拒绝终止无关 PID、显式后端来回切换时保留共享状态、配置不匹配时不终止原实例，以及无存活实例时仍拒绝把排队任务交给其他后端。

默认测试不连接真实模型或微信账号。图片理解、语音转写质量、实际沙箱以及脱离进程组的守护程序清理需要独立验收。

## 目录路由与历史会话（现行映射）

旧 `routing.test.ts` 的临时分类器、规则解析、旧扫描器和固定诊断专属测试已退役；其仍有效的行为改接三层或由既有三层用例覆盖，不把删除用例计算成通过。

| 原新增编号/行为 | 当前离线验证位置 |
|---|---|
| BR-01/02/03/06/07/09/12/13/14，目录选择、查询、A-B-A、澄清、FIFO | `e2e/hierarchical`、`unit/directories`、`unit/business-sessions` |
| BR-04/05/08/21/22，名称优先、分页、范围、物理身份、别名 | `unit/routing`、`unit/directories` |
| BR-10/11/15/16/17/18/20，时间、历史覆盖、选择和归属 | `unit/business-sessions`、`history-catalog`、`history-reader`、`history-references` |
| BR-19，固定配置、幂等、恢复、跨目录执行 | `unit/dispatch`、`recover-resources`、`e2e/hierarchical`、`e2e/start` |
| AUTH01–12，显式外部路径、授权、过期、送达、scope、参数 | `unit/directories`、`unit/routing`、`e2e/hierarchical`；旧自然语言确认同义词分类器退役 |
| PL01–05/08–10/13–14，原文、模型覆盖、进度查询 | `e2e/hierarchical`、`unit/orchestration`、`unit/routing`；旧组合分类器退役 |
| PL06/07/11，历史图片/背景注入 | 旧功能退役；三层只传当前请求原文与附件，`e2e/hierarchical`、`unit/orchestration` 验证 |
| H01–07，按需原生历史读取及验证 | `unit/history-*`、`unit/business-sessions` |
| I01–05，临时解释器 | 实现退役；`unit/routing` 验证旧配置明确拒绝，`controller-factory` 验证缺少能力证明拒绝 |
| DBG01–04/W16，scope 与脱敏 | `e2e/hierarchical`、`contract/weixin` 使用现行 `/debug`，不扫描原生历史 |
| MG01–08/W15，维护与恢复 | `e2e/maintenance`、`unit/maintenance-result`、`contract/weixin` |

`smoke:progress -- --live --config FILE --out DIR` 使用真实模型和合成项目验证：建立一条业务记录，按项目名称查询进度，原文传递、同 Route 续查、不额外启动业务、不改业务回复时间。它不发送微信，不替代手机或完整 live 故障验收。

原 58 编号仍全部保留。所有默认测试使用离线 doubles，不是 live Agent、视觉或 OS 隔离证明。
