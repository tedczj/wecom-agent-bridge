# 当前验证记录：统一三层入口（2026-09-25）

旧 Bridge、Router、临时意图解释器、旧历史扫描器、专用诊断和三个旧 smoke 脚本已删除。保留目录授权/模型选择/目录锁、原生历史读取、Codex/Pi 后端、媒体和 outbox。`routing.interpreter` 明确拒绝，入口不再有旧链路回退。

- `npm ci --no-audit --no-fund`：exit 0，按 lockfile 安装 16 个包，未升级依赖。
- `npm run check`：类型检查、构建及 **317/317 OFFLINE PASS**，0 failed/cancelled/skipped。CLI、微信协议、启动、取消、维护和排队恢复用例均接三层测试入口；临时分类器专属测试退役。原 58 验收 ID 全部保留，见 [测试映射](TEST_MATRIX.md)。
- 新回归覆盖项目名称/别名优先、原文透传、查询不启动业务、同目录 Route 复用、分页进度持久化、业务覆盖不改变管理模型，以及普通搜索仅在 `~/workspace`、显式外部路径仍受权限约束。
- 真实 `gpt-6-sol / high` 能力探测 **PASS**：create/resume、动态工具、实际受限工具集合、禁止原生压缩、图片、取消、writer busy→idle、进程清理。有效窗口 **828400**；证明绑定兼容 binary、登录配置和该模型参数。
- 真实隔离进展链路 **PASS**：合成 term4u 项目建立 1 次业务记录；随后“看下 term4u 项目里在干啥”和续查均原文透传、复用同一 Route、未新增业务执行、未更新业务回复时间。原生 `turn_context` 确认 business/Bridge/Route 均为 **gpt-6-sol / high**。初轮与最终复测分别记录，未发送微信消息。
- 本机旧接收进程停止前、停止后均核对没有运行任务、pending/sending/unknown 投递或 Agent 标记。删除旧 `bridge.sqlite` 及 WAL/SHM、`routing-agent`、媒体、实例 Agent 产物和 supervisor 状态，未导入或转换任何旧历史。空库初始化为 **v4，0 任务、0 请求、0 管理会话**；微信配对和传输位置保留并校验，项目文件和 `~/.codex` 原生业务会话未删除。
- 本机配置已清除遗留目录模型默认覆盖，业务兜底、Bridge、Route、摘要统一 **gpt-6-sol / high**。启动日志确认 `mode=hierarchical`、`schemaVersion=4` 和 `微信接收已启动`；核对一组 supervisor/worker、唯一接收 worker。管理会话按首条新请求懒初始化，隔离测试已验证新建与复用。

本次没有手机端到端验收；没有真实 1M/80% 长测，也不将局部模型验证宣称为完整三层故障矩阵、视觉泛化或 OS 隔离通过。原生业务 Codex 未替换；管理层使用 [兼容构建](THREE_LAYER_RUNTIME_COMPATIBILITY.md)。

[脱敏证据摘要](evidence/three-layer-only-verification.txt)与[当前源码清单](source-manifest.sha256)记录本次范围。完整输出仅保存在忽略的 `runtime/three-layer/high-cutover/`：`check-final.txt`、`reset-evidence.json`、`startup-evidence.json`、`service-final.log`；能力探测 `probe/3feddbbb-f702-45b5-a86d-d7827eb79d06/`；最终链路 `final-progress/f49e1382-fcf5-43e6-b3f3-798a47669605/`。实施过程的失败日志保留，最终结果不覆盖此前失败记录。

以下均为旧候选的历史记录，旧脚本、旧入口及旧测试计数不代表现行实现。

## 此前验证记录：远程 debug

- `npm ci --no-audit --no-fund` exit 0，按 lockfile 安装 16 个包；未升级依赖，未运行 audit。
- `npm run check` exit 0：类型检查、构建、216 tests，216 passed，0 failed / cancelled / skipped。
- DBG01–DBG04 和 W16 为新增离线、无模型验证：同对话任务前缀查询、路由模型绕过、旧任务无快照、历史失败快照与当前检查分离、文件指纹脱敏与样本上限、目录失效、去重、待授权消费，以及配对微信协议 double 的结果投递。
- 第一轮检查 214 项中 DBG01 失败：夹具执行了普通工作却拿执行前状态作比较；改为明确触发历史校验失败后重跑。最终 216 项全部通过。
- 既有 MG 更新/重启离线测试继续通过。未连接截图所在远端，未发送真实微信消息，未完成远端更新或手机端 `/debug` 验收，也未重放截图中的 commit/push 任务。
- `git diff --check` exit 0。原 58 验收 ID 保留；当前源码清单包含 `src/debug.ts`。不提交用户截图、真实任务内容、认证或运行状态。

以下为此前验证记录，其 live 结果不代表本轮 debug 或远端验收。

# 此前组合路由验证记录

验证日期：2026-09-23。环境：macOS / Darwin arm64、Node v24.15.0、npm 11.12.1、Codex CLI 0.155.1。

## 本轮组合路由实现

自然语言请求现在可组合目录、执行 backend/model/reasoning、新会话和材料交接；路由可请求有界只读查询，宿主验证并执行。未登记的项目继承授权根的 profile，模型组合不需单独建 profile。原 58 个验收 ID 与 BR-01..BR-22 均保留，新增 PL01..PL14、AUTH01..AUTH12、MG01..MG08、W15 及两项 Pi 参数契约测试，映射见 [TEST_MATRIX.md](TEST_MATRIX.md)。

| 检查 | 本轮结果 |
|---|---|
| `npm ci --no-audit --no-fund` | exit 0，按 lockfile 安装；本次未运行 audit，未升级依赖 |
| `npm run check` | exit 0；类型检查、构建、211 tests；0 failed / cancelled / skipped |
| `git diff --check` | exit 0 |
| `smoke:planner --live` | exit 0；真实规划、两次本地只读工作任务、合成图片交接和原生 turn metadata 校验通过 |
| 默认启动配置查找 | HOME / XDG 两项隔离启动测试通过，兼容 macOS `sh start.sh` |
| 微信端新版消息收发 | 现场已记录用户明确授权后的一次任务；兜底修复后服务已重启、有效配置已核对，手机端新任务展示尚未复测 |

[此前组合路由结果摘要](evidence/planner-verification.txt)和[本次交互授权摘要](evidence/authorization-verification.txt)是已执行命令的结果摘录，不是完整控制台日志。[源码 SHA-256 清单](source-manifest.sha256)记录源码/测试输入；当前清单覆盖本阶段源码、测试、构建输入和兼容补丁。

## 微信管理命令（2026-09-23）

实现 `/approve`（目录与服务管理确认）、`/update`、`/restart`；未接入 Codex 任意 shell 审批。`start` 使用稳定管理进程与桥接子进程，确认后排空已有工作，结果写回同一对话 outbox。目录、配对、去重、FIFO、未知送达和中断阻塞规则保留。

- 完整 `npm run check` exit 0：211 tests，0 failed/cancelled/skipped。AUTH12、MG01–MG08、W15 的新增覆盖见 TEST_MATRIX.md。MG 使用真实本地桥接进程和临时 Git 仓库，但 npm 为离线 double；W15 为 iLink 协议 double，均不是手机端实测。
- `npm run smoke:maintenance -- --live` exit 0：临时源码副本、本地 Git origin/dev，真实快进、真实 npm ci 与完整 npm run check、桥接进程替换和本地最终回执通过。没有调用模型或发送微信消息。无 `--live` 时 exit 1 / LIVE_OPT_IN_REQUIRED。
- 回归先发现暂停管理进程后的僵尸子进程误判、正常退出移除锁时的竞态，以及既有后端切换身份检查不适配父子进程；修复后原启动/强制退出/旧锁/后端切换测试通过。测试的“就绪”改为核验子进程初始化回执；保留首次微信登录的五分钟扫码窗口和验证码 stdin。
- 本机空闲预检后已部署管理进程入口。微信端 `/update` / `/restart` 的下一条确认与最终投递尚未现场验收；测试没有替用户发起生产管理命令。

[管理流程验证摘要](evidence/maintenance-verification.txt)为受限结果摘录。更新失败恢复的是生成的运行产物，不撤销 Git 源码快进；异常终止不自动重新执行管理操作。当前管理进程在工作子进程更新时保持稳定，完整外部停止/启动才加载新的管理进程实现。

## 目录查询缺参修复（2026-09-23）

规划约定允许 query 省略以表示当前目录，但目录 inspect 原实现直接抛出 ROUTER_QUERY_REQUIRED。现在省略或 null 只返回授权校验后的当前目录元数据，显式查询仍遵守原 roots。PL14 两个离线回归在修复前均失败，修复后验证默认目录、切换后目录、绑定不变、不调用 worker 和越权拒绝；完整 178 项检查通过。微信服务已重启加载修复，未重放失败请求；本次没有运行真实模型复测或库存网站查询。

## 交互目录授权（2026-09-23）

用户要求根外目录必须经下一条明确同意授权，不能直接编辑 roots。手工加入的生产目录已撤回；本次实现将提案与 grant 保存在对话私有状态，未自动授权生产目录。AUTH01–AUTH09 共 19 个离线用例验证确认、拒绝/含糊回复、送达状态、过期、路径/配置变化、隔离、重启、请求身份和模型目标变更。模型改派目标的初版测试在提示后改变 fake 环境，先触发了正确的 PROFILE_CHANGED；改为提示前固定两阶段响应后才验证到目标变更拒绝，没有放宽配置校验。

- `smoke:authorization --live`：真实规划 Agent 先返回含绝对路径的授权问题，此时没有工作任务；测试会话下一条明确同意后，真实只读工作 Agent 成功报告临时工作目录。原请求与确认消息身份分别保留，重复确认消息只执行一次。
- 使用原现场请求与近期上下文做只读真实规划复测，返回目标绝对路径的授权询问；未 commit 计划、未运行工作 Agent、未发送微信消息、未写入生产授权。
- 测试使用临时目录和独立本地状态；本次不重认 OS 隔离、库存网站查询或手机端完整授权流程。服务已通过空闲/进程预检并重启加载修复；随后现场已记录用户下一条明确同意和一次工作任务；该任务使用了错误的默认模型，引出了本节下方的兜底修复。

## 授权目录兜底修复（2026-09-23）

新授权目录原先继承当前工作区 profile，导致项目的显式 Astra 配置覆盖预期兜底；现改为默认工作区所属最具体 root 的 profile。授权询问展示默认模型/推理，用户明确指定的设置优先；缺少 root profile 时阻断。AUTH10/11 在修复前均失败，修复后通过；既有项目配置、隔离、队列和确认流程保持。两处路径拒绝夹具改用私有测试目录，消除 macOS /etc 链接差异。

本机兜底已修正为 gpt-5.6-terra / high。针对已有的单个授权目录，在服务空闲停机、私有配置与 SQLite 备份后，核验原授权问题、同意消息归属和目录物理身份，仅修正 profile/版本及对应目录引用；保留原确认关联，roots 和历史任务记录不变。服务已重启，当前目标配置核对为 Terra high。

更新后的 `smoke:authorization --live` 在临时目录以默认工作区 profile 与 root 兜底 profile 分离的配置复测；真实两轮授权/执行通过，原生 turn_context 确认 model=gpt-5.6-terra、reasoning=high 和临时工作目录。仅说明客户端实际配置，不是服务端最终模型路由证明；未发送微信或新增生产目录授权。

## 真实模型证据与边界

`npm run smoke:planner -- --live --codex <已安装CLI> --home <已登录Codex目录>` 在临时项目和独立 stateRoot 中运行，使用合成纯红图片，不读取生产对话或发送微信消息。

- 中文排障材料被识别为 work；OCR session 进度请求被识别为只读 inspect；“切换到 wecom bridge 目录”产生带目标的 switch。
- 第一条带图消息由真实工作 Agent 完成。随后请求发现未登记的 doc-ocr-service 目录，指定 Codex / terra / high，新开会话并携带前图；两次任务均 succeeded。
- 新旧会话身份不同；复制图片的 SHA-256 相同；新会话回复包含目标绝对路径，并正确识别红色。
- 原生 Codex 索引与 rollout turn_context 验证实际 cwd、model=gpt-5.6-terra、effort=high。它们是客户端记录，不是服务端最终模型路由证明。
- 最初 smoke 因子进程缺少当前网络代理而连接失败；CLI error item 曾被误标为 ROUTER_TOOL_ATTEMPT。测试现仅显式传入 HTTP_PROXY/HTTPS_PROXY/NO_PROXY，产品把错误事件与执行工具事件区分，仍拒绝执行工具，不放宽目录/沙箱权限。失败尝试未派发工作任务。
- 真实 smoke 通过后，补充启动回执、重启预检和默认私有配置查找；这些调整由完整 176 项离线检查验证，没有将它们说成手机端已验证。

## 离线验证范围

默认测试不调用模型。PL01..PL14 使用脚本化解释器及合成文件，验证组合请求的执行与状态契约，而不是模型准确率：未配置目录、别名模型选择、配置独立会话、只读查询循环、越权拒绝、真实图片字节复制、原文保留、跨对话隔离、上下文清空边界、排队配置、重启续接、缺图拒绝、启动回执去重与重启配置预检。

Pi 新增测试通过 native RPC double 验证 get_available_models / set_model / set_thinking_level / get_state，在实际推理等级与请求不符时不发送 prompt。本轮没有运行真实 Pi 模型切换。

启动脚本依次查仓库内配置与 `${XDG_CONFIG_HOME:-$HOME/.config}/wecom-agent-bridge/`，显式指定文件不走兜底。两项新增测试运行隔离的真实本地 CLI，测试夹具仅跳过已完成的 npm 安装/构建步骤。最初夹具把 dist 作为符号链接，触发 CLI 入口路径检查而未启动；改为复制已编译文件后通过，未放宽产品入口检查。

回归中发现只含完成事件最终文本的历史没有 assistant preview，现补入摘要并去重。全部既有队列、去重、所有权、取消、故障恢复、消息投递和媒体预算测试保留通过。

## 历史证据（本轮不重新认定）

`evidence/check.txt`、`install.txt`、`routing-live.txt` 和 `routing-opt-in.txt` 是此前 159 项检查及真实只读 OCR 历史查询的记录，环境为此前运行环境，不是本轮控制台日志。此前观察过 Codex/Pi 两轮会话、微信配对和图片投递，不能据此认定本轮微信新版验收通过。

## 尚未验收与隐私

- 用户实际截图的理解准确率、任意中文表达的泛化效果、修复后的手机端最新消息展示与完整工作任务验收。
- Pi 真实模型/推理切换，以及各后端的真实取消、脱离进程组副作用和完整 OS 隔离。
- 远端 CI；本地 macOS 检查不能代替远端 workflow 结果。

临时测试状态和原生测试会话保留用于本地核查；不提交认证、代理值、私有路径、模型原文、图片或运行数据库。公开证据仅包含合成样本的状态与参数摘要。图片交接仍受保留期/数量/大小/像素上限限制；不支持无限历史记忆或微信原生引用消息。

LIVE-25 FIFO 与 LIVE-16 取消各三轮核心断言通过；取消为 `interrupted + blocked` 保守分支，脚本退出由测试清理另行完成。新三次取消中断披露审计已通过，但两类场景的写工具远端写入 oracle 尚缺，因此 case 仍 BLOCKED，不能算整套 fault 验收。
