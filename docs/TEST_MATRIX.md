# Original 58-ID migration matrix

原基线为 `5d882cbbd6906678ca8f0728b3a1b0a14734d361`。当前用户删除网络通道，因此表中明确区分保留、改写和退役，不把删除的企微/AES/网络测试计为通过。实际离线用例数量见 verification.md。

| ID | 原要求 | 当前实现与证据边界 |
|---|---|---|
| N01 | 单聊文本与路由 | 改为本地固定 actor / session：unit/core N01。 |
| N02 | SDK generic / specific 双事件 | SDK 事件已删除；本地重复请求由 Q01 + CLI01 覆盖。 |
| N03 | 远程用户/群白名单 | 远程鉴权已删除；本地不能注入 actor/route：unit/core N03。不宣称支持远程多用户。 |
| N04 | 缺少消息身份/错误 bot | bot 身份已删除；必需本地 request ID 和固定 actor：unit/core N04。 |
| N05 | mixed 多段文本/图片 | mixed 帧已删除；本地图片数组顺序、数量和文本上限：unit/core N05、media。 |
| N06 | 一层 quote | quote 接口已删除；明确拒绝该字段：unit/core N06。 |
| N07 | 群/单聊/发送者隔离 | 改为 actor、会话、工作区、后端隔离：unit/core N07、store identity。 |
| N08 | 未知类型/命令 | 本地未知字段或 slash command 被拒绝：unit/core、e2e/bridge N08。 |
| M01 | 明文/加密图片内容 | 保留本地原始字节与 hash：unit/media M01；加密输入已删除。 |
| M02 | AES padding / key | 删除，与远程解密代码同时退役；不伪造通过记录。 |
| M03 | 下载流字节边界 | 改为有界本地文件读取和累计大小：unit/media M03。 |
| M04 | SSRF / DNS / 重定向 | 下载器已删除；本地接口拒绝 URL：unit/core M04。 |
| M05 | 伪装的 HTML/SVG/EXE | unit/media M05。 |
| M06 | 像素、损坏和动画 | unit/media M06：像素、全解码、有效动画 WebP 拒绝。 |
| M07 | 下载超时/URL 过期 | 远程生命周期退役；本地文件缺失和取消：unit/media M07 / cancellation。 |
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
| B01 | 原生图片输入 | unit/media + contract/codex C02 + contract/pi B01；仅字节/协议，不代表看图理解正确。 |
| B02 | 两轮会话复用 | contract/codex C01、contract/pi B02、CLI01。 |
| B03 | 新会话清除上下文映射 | contract/codex C04 + e2e/bridge /new。 |
| B04 | 空结果/拒绝/工具错误 | empty final、错误 stopReason、非答案事件测试。真实模型拒绝/工具失败的业务语义未 live 验证。 |
| B05 | 取消与实际子孙进程停止 | contract/codex C12–C14 + contract/pi B05 + CLI05；脱离进程组的守护程序仍属人工/外部隔离边界。 |
| B06 | 会话映射持久化失败 | contract/codex C11 + contract/pi B06。 |
| Q01 | 十次并发重复和重启重放 | e2e/bridge Q01 + recovery R02 + CLI01。 |
| Q02 | 全局单执行任务 | unit/store Q02 + e2e/bridge queue。 |
| Q03 | preparing 不被同会话越序 | unit/store Q03 + e2e/bridge Q03。 |
| Q04 | 队列容量前置拒绝 | e2e/bridge queue capacity case。 |
| Q05 | 重复 /new | e2e/bridge Q05。 |
| Q06 | 任务所有权 | unit/store Q06 + e2e/bridge ownership。 |
| Q07 | 取消/成功竞态 | unit/store Q07。 |
| Q08 | 执行中 status | e2e/bridge status-not-waiting；不是已测量生产 SLA。 |
| D01 | Unicode 输出分片 | unit/core D01。 |
| D02 | 过期回调与主动回复 | 聊天回调已删除；独立本地 outbox 输出，CLI03 验证会话路由。 |
| D03 | 明确未发送 | unit/store-reply disconnected case。 |
| D04 | 输出确认未知 | unit/store-reply unknown case，不重发不重跑。 |
| D05 | 已确认发送 | unit/store-reply sent-once case。 |
| D06 | 永久/可重试错误 | unit/store-reply D06。 |
| D07 | 自动分页上限和结果领取 | unit/core D07、store D07、e2e/bridge /result。 |
| D08 | 原始错误含秘密 | contract/codex C08 + stderr structured-error implementation；不再存在 SDK HTTP 错误对象。 |
| R01 | preparing 时强杀 | e2e/recovery R01：真实 SIGKILL，失败及孤儿清理。 |
| R02 | queued 时强杀 | e2e/recovery R02：完整输入仅执行一次。 |
| R03 | running 已有修改时强杀 | e2e/recovery R03：实际文件变化，blocked/tainted，不重跑。 |
| R04 | 结果事务中强杀 | e2e/recovery R04：原子回滚。 |
| R05 | 提交结果后强杀 | e2e/recovery R05：只输出，不调用 Agent。 |
| R06 | 输出中强杀 | e2e/recovery R06：unknown，人工领取原结果。 |

新增 Codex C 系列覆盖 exec 参数、精确 thread resume、坏帧/超大帧、线程不匹配、持久化失败、终态和进程退出的联合判定、超时及进程树取消。CLI01–CLI06 覆盖真实 CLI 进程的端到端路径。默认运行绝不连接真实模型或账号。
