# 三层 Agent Bridge 设计包

设计版本1.0，2026-09-23；目标仓库`tedczj/wecom-agent-bridge`的`dev`分支，审查基线`e7d7328c13b33f8e5feab4c1691350ed21dab2d2`。

**这是可交给编码Agent施工的完整设计和验收规格，不是已实现的Bridge版本。未修改/提交GitHub，未运行目标仓库npm检查，未调用用户live模型，未发送微信。**

## 阅读顺序

| 文件 | 内容 |
|---|---|
| `DESIGN.md` | 唯一架构规范：冻结规则、三层职责、runtime选择、工具权限、原文透传、80%换代、原件/recap、数据模型、任务状态、文件级改造、M0–M8施工和迁移 |
| `LIVE_LLM_CASES.md` | 33个逐步live用例、145个case断言、5个全局断言、16组配套offline合同用例；所有live状态NOT_RUN |
| `live-cases.json` | 同一批用例的机器可读定义；未来runner按固定predicate handler解释，不执行任意JSON代码 |
| `live-cases.schema.json` | 用例定义的JSON Schema |
| `config.hierarchical.example.json` | 新配置结构示例；旧版本parser不能使用，路径需替换，模型/窗口需probe |
| `schema-v4-reference.sql` | 8张新增表的参考DDL；不是生产迁移入口，也不执行绑定导入或设置user_version |
| `prompts/` | Bridge、Route、Recap静态角色模板 |
| `threshold80.mjs` / `threshold80.test.mjs` | 可独立执行的整数80%判定参考实现与offline测试，不是runtime上下文计量实现 |
| `validate_design_bundle.py` | 设计包结构、跨文件一致性、参考DDL约束的offline自检 |
| `bundle-validation.json` | 本次设计包自检结果，不是产品测试结果 |
| `threshold80-test.tap` | 本次参考函数的offline测试输出 |
| `SHA256SUMS` | 交付文件完整性校验 |

## 冻结要求

80%判定只使用已观测usage：`used*5 >= window*4`。不预测下一轮输入、工具结果或回答，不悄悄留余量。管理session换代不改变业务session绑定。

userQuery由宿主从原始request读取，透传到业务adapter；不让模型手工复制改写，不拼routingContext、历史答案或上游摘要。授权/纯目标澄清用sourceRequestId引用尚未执行的原工作请求，引用不等于重写或重放已执行任务。

Bridge模型不读长原件；宿主Delivery可以读取并投递。Recap和投递失败都不能重跑业务。模型名称、1M、high等能力必须以真实runtime探测为准，模型自报不构成证据。

## 如何施工

先执行DESIGN M0能力探测，再按M1–M8推进。M0不通过时可以继续离线开发，但不能声称三层功能已具备上线条件。修改在dev，不force push，不自动更新main。所有关键代码事实/上游来源在DESIGN末尾。

目标仓库已有的命令为`npm ci`、`npm run check`以及原smoke脚本。设计中`probe:controller`、`test:live`等命令是**待新增的施工产物**；本包没有假冒这些生产runner已存在。

默认配置只读；带commit/push的live case只能用operator授权的临时fixture写profile和本地bare remote，不能对真实term4u/bridge项目执行。真实微信测试需要owner从手机发消息，LocalChannel结果不能替代微信验收。

## 如何复核本设计包

以下只运行参考函数和设计结构自检，不会联网、调用模型、连接微信、访问生产DB或执行Git：

```bash
node --test threshold80.test.mjs
python validate_design_bundle.py
```

Python自检需要`jsonschema`；缺少时明确报错，不跳过schema检查。运行后默认输出JSON到stdout；保留报告可执行`python validate_design_bundle.py > bundle-validation.json`。

参考DDL自检在内存SQLite中创建最小v3占位表，验证DDL和约束；它不证明真实v3数据迁移已经通过。原项目完整npm测试、所有业务backend/live模型/1M跨80%/微信交付均须在施工后另验，NOT_RUN/BLOCKED不能记作PASS。
