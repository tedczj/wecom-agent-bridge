# 三层 Agent Bridge：目标设计与 Live LLM 验收入口

版本：1.0 · 设计日期：2026-09-23  
适用仓库：`tedczj/wecom-agent-bridge` · 施工分支：`dev`  
设计审查基线：`e7d7328c13b33f8e5feab4c1691350ed21dab2d2`

**本次提交仅归档已确认的目标设计、参考文件和验收规格，不表示三层功能已经实现或 live 测试已经通过。**

## 阅读入口

| 文件 | 用途 |
|---|---|
| [完整设计](plans/three-layer-agent-bridge/DESIGN.md) | 冻结规则、架构、配置、权限、状态机、文件级改造及 M0–M8 实施计划 |
| [Live LLM cases](plans/three-layer-agent-bridge/LIVE_LLM_CASES.md) | 33 个逐步用例、145 个用例断言、5 个全局断言及 16 组离线合同测试 |
| [机器可读用例](plans/three-layer-agent-bridge/live-cases.json) | 供待实现的 runner 使用；所有 live case 均为 `NOT_RUN` |
| [设计包说明](plans/three-layer-agent-bridge/README.md) | 配置、参考 SQL、角色模板、JSON Schema 和自检文件的完整索引 |
| [原问题交接](handoff/2026-09-23-weixin-history-routing.md) | 历史读取与后续工作路由故障的证据和现场边界 |

## 已确认的关键规则

- Bridge Agent 定位目录；每目录一个惰性创建的 Route Agent；业务 Agent 在准确的原生 session 中执行。
- 管理上下文阈值固定为 **80%**：只使用已观测 runtime usage，不估计下一轮输入、工具结果或回答 token。管理 session 换代不改变业务绑定。
- **原始 userQuery 透传**：宿主按 requestId 读取原文，不让管理模型改写，不拼接历史、recap 或 routingContext。
- 最终答案原件完整归档；Bridge 模型只看短记录，投递程序可读取原件；Route 按权限渐进读取历史。
- 不确定的业务执行不自动重跑；摘要失败、投递失败、管理 session 换代均不能触发业务重放。

## 与现有文档的关系

`docs/DESIGN.md`、`README.md` 和现有实现文档继续描述当前已实现行为。此目录是**待实施的 hierarchical 目标设计**；开发按其 M0–M8 推进，实施后按 M8 收敛权威文档，不能在功能尚未实现时把当前行为描述改成已经支持。

设计包 16 个交付文件逐字节保留原版本及 `SHA256SUMS`。其中“未修改/提交 GitHub”等文字描述的是**设计包生成时**的状态；此入口记录后续将该快照提交到 `dev` 的归档动作。包内“唯一架构规范”指该目标设计包的架构与验收分工，不表示它已替代当前运行规范。目录内额外的 `.gitattributes` 保护 live 文档中用于原文透传测试的 CRLF 样例，不属于原交付清单。

## 本次提交验证边界

提交准备阶段已复核：交付文件 SHA-256、三个主文件的 Git blob hash、设计包 JSON Schema/跨文件一致性/参考 DDL 约束，以及整数 80% 参考函数的 3 项离线测试。它们都只是规格与参考代码自检。

目标仓库完整 `npm ci` / `npm run check` 未运行：容器克隆 GitHub 时 DNS 解析失败。未调用 live 模型，未执行真实 1M/80% 长上下文用例，未连接或发送微信，未修改业务实现，也未重放原故障中的 commit/push 请求。

可在设计包目录内复核（均不调用模型）：

```bash
cd docs/plans/three-layer-agent-bridge
sha256sum -c SHA256SUMS
node --test threshold80.test.mjs
python validate_design_bundle.py
```

Python 自检依赖 `jsonschema`；上述检查不能替代仓库完整测试或 live 验收。`probe:controller`、`test:live` 是待实现的脚本入口，不是本次提交已经新增的可运行产品命令。
