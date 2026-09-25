# 隐私与提交边界

## 当前发布内容

可提交：源码、启动脚本、占位示例配置、lockfile、合成测试用例、当前说明文档、脱敏后的离线测试结果和构建输入哈希清单。

不可提交：真实账号/认证文件、bot token、context token、游标值、二维码内容、手机截图、消息或模型回答、图片及音频、数据库、会话和进程状态、本地配置、个人主目录路径。

`.gitignore` 排除本地配置、环境文件、SQLite、日志、依赖/构建输出，并额外排除 auth.json、weixin-auth.json 及其临时文件、instance.lock、agent-process.json 和 weixin-incoming 目录。忽略规则不会保护已跟踪的文件，所以发布前还要检查 Git index。

## 发布检查方式

- 检查将要提交的文件清单、暂存内容和 diff，排除本地配置与运行时文件；示例配置只保留占位路径。
- 扫描个人绝对路径、私钥头、常见 API key/JWT 格式、邮箱及凭据赋值候选；合成 fixture 和公开协议域名经人工区分。
- 在本机内存中，把私有配置、已绑定账号和运行状态中的真实敏感值与候选发布文件作精确比较；不输出这些值、不复制到审查报告或仓库。
- 重新生成当前离线证据并替换本机临时路径/PID。实际消息、模型输出和媒体不进入证据文件。

本次统一三层入口提交检查候选索引中的文件路径、凭据格式和本机实际敏感值；私有配置、认证、运行库和完整模型日志均保持忽略。公开验证摘要只保留模型、计数、验证结论和本地证据相对位置，实际 PID 仅保留在私有启动证据中。历史扫描计数不代替本次发布检查。

此前 Pi 配置保留在被忽略的 `*.local.json` 中，启动包装器、沙箱 profile、会话及本地 smoke 结果保留在仓库外的私有运行目录。本轮已按 operator 请求修改私有联网/兜底配置并修正已有授权的 profile 关联，这些私人部署文件、备份及运行状态均未纳入提交。公开验证仅记录版本、结果和受限探针结论，不包含模型回答、认证内容或本机绝对路径。

扫描和人工检查针对本次发布文件，不是对任意未知秘密格式或运行环境的全面保证。

## Git 历史边界

先前已发布的 macOS 初次失败日志曾含本机绝对路径。旧日志已从当前文件树移除，但没有改写或强推既有 Git 历史，因此旧提交仍可找到该路径。该发现是路径信息暴露，不是发现真实 token 或 API key 泄露。Git 正常作者元数据也不在内容脱敏范围内。

## 运行时数据

三层模式的 raw requests、原件、摘要、handoff、native refs 和 capability/live 证据均属私有运行数据。当前探测保存在忽略的 `runtime/three-layer/`，不提交配置、认证、媒体或模型回答。工具审计只存标识、哈希、范围与状态；用量日志只存时间、角色、会话标识、tokens/window、换代理由和绑定集合哈希。哈希及会话标识仍应按私有运维数据保管。`/debug` 不返回原文、答案正文、绝对路径、工具参数或凭据。

微信凭据写入 stateRoot/weixin-auth.json，权限 0600；目录使用 0700。SQLite 保存消息、结果、会话、配对身份、context 和 cursor，属于私有运行数据。日志只记录结构化状态和受限错误字段。

首次扫码会在终端显示临时二维码，启动提示包含工作目录，本地 JSONL 模式会输出模型结果。不要把整段真实终端录屏、输出或运行目录当作公开测试证据提交。

## 路由数据边界

routing_state 中的目录绑定、别名、授权和查询游标属于私有状态。Bridge/Route 管理会话接收当前请求原文和角色允许的有界目录/历史记录，业务请求不拼接历史原文或图片；不向管理模型提供 bot/context token。旧 HTTP/Codex 临时解释器已删除，旧 interpreter 配置拒绝加载。目录权限与执行 profile 由宿主控制，模型不能扩大授权。根外路径的授权问题、物理目录身份、原请求与确认关联同属私有状态，不纳入公开证据或配置模板。

workspace 锁位于宿主用户临时私有目录，记录 bridge PID、stateRoot 和随机锁 token；它不是可发布证据。测试清理只删除精确属于各自合成 fixture 的锁，不清除生产锁。新增公开配置示例仅含占位路径/模型示例，不使用现有私人配置。

本次真实验证仅公开模型/推理配置、有效窗口、查询原文透传与 Route 复用结论、业务执行次数和清理结果。没有复制真实 rollout、消息预览、微信截图或模型原文到仓库；隔离模型验证和微信手机验收分别记录。登录信息与现场完整启动日志不提交。

管理进程的身份令牌、PID、就绪标记、更新阶段与原对话关联、运行产物备份均位于私有 stateRoot，不纳入提交。`/status` 仅展示管理动作、阶段、任务 ID、受限错误码与版本，不展示令牌。更新命令不继承完整宿主环境，且不向 Git/npm 转发模型 API 凭据。

## Remote debug reports

`/debug` is available only after normal transport identity verification and reads saved request, execution, artifact/recap and delivery metadata in that conversation. It performs no native-history scan or model call. Reports exclude absolute paths, original messages, model output, native history text, authentication/context tokens, media URLs/keys and raw exceptions. Diagnostic reports remain private command results and outbox payloads; public verification uses synthetic fixtures only.

### Isolated native-history fault tests

LIVE-14 creates a private business native home. Its temporary authentication snapshot contains only the currently valid access/id token and account identifier; it excludes the real refresh token and other credentials. The source authentication file is read-only. The snapshot directory is 0700, the auth file is 0600, and cleanup removes auth.json after the owned services close. Credentials and test homes remain ignored and are never publication artifacts. Test evidence records hashes, permission checks, failure codes and cleanup state, never token contents. The three completed LIVE-14 homes were scanned after cleanup: no access-token residue was found. This applies to this historical test workflow. There is no data migration tool.
