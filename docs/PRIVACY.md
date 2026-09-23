# 隐私与提交边界

## 当前发布内容

可提交：源码、启动脚本、占位示例配置、lockfile、合成测试用例、当前说明文档、脱敏后的离线测试结果和构建输入哈希清单。

不可提交：真实账号/认证文件、bot token、context token、游标值、二维码内容、手机截图、消息或模型回答、图片及音频、数据库、会话和进程状态、本地配置、个人主目录路径。

`.gitignore` 排除本地配置、环境文件、SQLite、日志、依赖/构建输出，并额外排除 auth.json、weixin-auth.json 及其临时文件、instance.lock、agent-process.json 和 weixin-incoming 目录。忽略规则不会保护已跟踪的文件，所以发布前还要检查 Git index。

## 本次检查方式

- 检查将要提交的文件清单、暂存内容和 diff，排除本地配置与运行时文件；示例配置只保留占位路径。
- 扫描个人绝对路径、私钥头、常见 API key/JWT 格式、邮箱及凭据赋值候选；合成 fixture 和公开协议域名经人工区分。
- 在本机内存中，把私有配置、已绑定账号和运行状态中的真实敏感值与候选发布文件作精确比较；不输出这些值、不复制到审查报告或仓库。
- 重新生成当前离线证据并替换本机临时路径/PID。实际消息、模型输出和媒体不进入证据文件。

本轮发布扫描检查 Git index 的候选文件，个人绝对路径、私钥、API key/JWT 候选和运行时文件清单均无命中。旧报告中的“56 个文件 / 21 个私有值”属于上一轮，不沿用为当前证据；本轮不为发布检查读取真实会话内容或模型回答。

此前 Pi 配置保留在被忽略的 `*.local.json` 中，启动包装器、沙箱 profile、会话及本地 smoke 结果保留在仓库外的私有运行目录。本轮已按 operator 请求修改私有联网/兜底配置并修正已有授权的 profile 关联，这些私人部署文件、备份及运行状态均未纳入提交。公开验证仅记录版本、结果和受限探针结论，不包含模型回答、认证内容或本机绝对路径。

扫描和人工检查针对本次发布文件，不是对任意未知秘密格式或运行环境的全面保证。

## Git 历史边界

先前已发布的 macOS 初次失败日志曾含本机绝对路径。旧日志已从当前文件树移除，但没有改写或强推既有 Git 历史，因此旧提交仍可找到该路径。该发现是路径信息暴露，不是发现真实 token 或 API key 泄露。Git 正常作者元数据也不在内容脱敏范围内。

## 运行时数据

微信凭据写入 stateRoot/weixin-auth.json，权限 0600；目录使用 0700。SQLite 保存消息、结果、会话、配对身份、context 和 cursor，属于私有运行数据。日志只记录结构化状态和受限错误字段。

首次扫码会在终端显示临时二维码，启动提示包含工作目录，本地 JSONL 模式会输出模型结果。不要把整段真实终端录屏、输出或运行目录当作公开测试证据提交。

## 路由数据边界

routing_state 中的 active directory、版本化别名、历史预览、列表快照与搜索 continuation 都属于私有状态，不提交仓库。HTTP 解释器密钥从 operator 指定环境变量读取；Codex 解释器使用原有认证 home，但忽略用户工具配置，采用 ephemeral 会话。没有解释器配置时不会发出解释器请求。配置后会把当前用户路由文本、有限近期用户上下文和有界项目说明发给选定模型；不传 bot/context token、native 全部历史或 worker 工具输出。根授权和执行 profile 仍由宿主控制，不能由模型返回值扩大。根外精确目录可由同一对话下一条明确同意授权；待授权问题、目录绝对路径、目录身份、原请求/确认消息关联和授权记录同属私有 routing_state，不纳入公开证据或配置模板。

workspace 锁位于宿主用户临时私有目录，记录 bridge PID、stateRoot 和随机锁 token；它不是可发布证据。测试清理只删除精确属于各自合成 fixture 的锁，不清除生产锁。新增公开配置示例仅含占位路径/模型示例，不使用现有私人配置。

本次修复的真实验证仅公开请求模型/推理配置、识别动作、目录逻辑 ID、会话数量和活动状态计数。没有复制真实 rollout、消息预览、微信截图或模型原文到仓库；一次成功分类也不声称证明最终服务端模型路由。私有 interpreter 配置、登录信息与现场启动日志均不提交。

管理进程的身份令牌、PID、就绪标记、更新阶段与原对话关联、运行产物备份均位于私有 stateRoot，不纳入提交。`/status` 仅展示管理动作、阶段、任务 ID、受限错误码与版本，不展示令牌。更新命令不继承完整宿主环境，且不向 Git/npm 转发模型 API 凭据。

## Remote debug reports

`/debug` is available only after normal transport identity verification and can inspect tasks from that same conversation. Reports include logical workspace IDs, path fingerprints, allowlisted error codes, task/scan/delivery states and startup checkout SHA. They exclude absolute paths, original messages, model output, native history text, authentication/context tokens, media URLs/keys and raw exceptions. Request-time snapshots remain private job state; diagnostic reports remain private command results and outbox payloads. Public verification uses synthetic fixtures only. Fingerprints are identifiers for correlation, not anonymization guarantees.
