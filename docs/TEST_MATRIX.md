# Acceptance and regression matrix

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
| Q02 | 全局单执行任务 | 每个 stateRoot 单 worker：unit/store Q02、e2e/bridge queue；新增 routing BR-19 验证跨 stateRoot 同真实目录互斥（同宿主同用户）。 |
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
| R02 | queued 时强杀 | e2e/recovery R02：完整输入仅执行一次。 |
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

## 目录路由与历史会话

原始 58 个 ID 保持原表。新增 22 个行为场景由 `tests/unit/routing.test.ts` 的具名 BR 测试覆盖；该文件还包含生产 openService + Codex/Pi 测试子进程的集成路径，名称中的 production entry 只表示真实入口，backend 仍是离线 double。

| ID | 可执行断言 |
|---|---|
| BR-01 | 首次默认目录，记录实际 worker workspaceId |
| BR-02 | 换话题/参考其他项目仍用同一 workspace/session |
| BR-03 | operator 别名定位；session 不串项目 |
| BR-04 | 授权根扫描、README 用途匹配、确定 profile 继承 |
| BR-05 | 分页预算与持久化 continuation，超过 200 个目录仍可继续 |
| BR-06 | 多候选澄清，不执行；答目录名后选择 |
| BR-07 | 不存在/无 profile 不执行且保持当前绑定 |
| BR-08 | symlink、撤权、同路径替换设备/inode 均拒绝 |
| BR-09 | 查询其他目录不改变 activeWorkspace |
| BR-10 | 23h59m、24h、24h+1ms，未知/未来时间；过期生成新 session |
| BR-11 | status/history 控制不更新完整回复时间；原 D 系列另测交付 |
| BR-12 | 新建去重、重新跑仍续接；新建不取消活跃任务 |
| BR-13 | A-B-A 保留 A 原绑定 |
| BR-14 | 活跃尚未回复时连续输入保持同一个 session |
| BR-15 | 格式故障/注入超时/partial 不当空历史执行 |
| BR-16 | 超过 10 条搜索、超过 100 文件继续、列表快照序号、结果分页 |
| BR-17 | 显式恢复超过 24h 后下一任务仍续接所选历史 |
| BR-18 | conversation/profile/cwd 归属验证；跨会话查询/恢复拒绝 |
| BR-19 | 排队目标固定、重启恢复、事务回滚、profile 漂移拒绝、跨 stateRoot 互斥；真实入口切换 Codex/Pi doubles |
| BR-20 | tainted/blocked 下新建仍拒绝 |
| BR-21 | 恶意 README 只能作数据，不扩大根/profile/执行 schema |
| BR-22 | 简称纠正版本递增，删除路径使别名失效 |

还测试 Pi v3 不伪造 settled 时间、解释器 schema/响应上限/禁止重定向/实际配置模型保持。默认离线模型响应仅用于协议验证，不证明真实语义分类准确率、真实原生会话版本兼容或微信新路由送达。

## 历史兼容与 Agent 优先修复

`tests/unit/routing.test.ts` 新增 H01–H07、I01–I05：旧版无 cwd 文件、其他项目坏正文、native SQLite cwd 索引/失效路径、超过 8 MiB 流式 UTF-8、活动/半写入会话的读取与恢复分离、坏文件不完整提示、活动绑定不得被当作丢失新建、model/reasoning 匹配；Codex 分类优先、固定安全参数、工具事件拒绝、模型失败不转 worker、路径越权拒绝、HTTP high 参数、关闭时取消分类器。

`smoke:routing` 必须 --live；只验证路由分类与只读 native history，不发送微信或派发 worker。现场观测与离线 doubles 分开记录于 verification.md。

## 组合请求与对话材料交接

`tests/unit/routing.test.ts` 的 PL01–PL13 覆盖：排障材料交给 worker、缺目标切换不伪报成功；未登记目录及模型简称/推理参数组合；换模型独立会话与非法配置不变更状态；只读查询结果反馈模型且不切目录/执行；查询循环/越权；真实图片字节跨新会话复制、原文和来源保留；跨对话/清空上下文隔离；排队配置固定；空结果查询范围；生产入口 CLI 参数与跨重启续接；缺图和 schema 注入拒绝；启动回执去重且不伪造完成时间；重启预检验证排队任务覆盖参数。

PL14 补充目录查询省略 query / query=null：返回默认或切换后的当前目录，不启动 worker、不改变绑定；显式越权路径继续拒绝。

`tests/contract/pi.test.ts` 补充动态模型/推理 RPC 设置以及后端降档时拒绝 prompt。以上默认测试为离线 doubles。`smoke:planner --live` 验证真实中文请求分类、发现未配置目录、terra/high、新会话原生图片交接和实际 turn metadata；合成红图正确回复只证明该样本，不能代替用户截图理解或手机端验收。

## 目录交互授权

`tests/unit/authorization.test.ts` AUTH01–AUTH09 覆盖：完整路径询问且授权前不读元数据/不启动 worker；原请求与确认身份分离、去重；拒绝/含糊回复消耗待授权状态；过期、配置变化、目录替换/符号链接、未送达/unknown/部分送达阻断；对话隔离、精确目录、重启后的执行预检；私有路径拒绝；带图片确认拒绝；历史查询不切目录/执行；模型改变授权目标时拒绝。测试使用离线模型和后端 doubles。

`smoke:authorization --live` 使用真实规划与只读工作 Agent，在临时目录和独立本地 stateRoot 验证两条消息授权与一次执行，不发送微信、不替真实目录授权。

AUTH10–AUTH11 验证新授权目录选择默认工作区 root 的兜底 profile、询问展示模型/推理、重启后保持、显式覆盖优先、既有项目不变；root 未配置 profile 时不继承当前工作区。I03/PL05 的拒绝样本使用夹具私有目录，不依赖 macOS /etc 符号链接。
