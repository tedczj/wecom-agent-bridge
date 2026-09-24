# 三层模式迁移命令

迁移工具不会调用模型、重放任务或复制 Codex/微信认证文件。正式 `--apply` 要求完整 M0 证明；独立兼容候选已通过 M0，实际生产库尚未迁移。

先停止服务并确认没有运行中的业务、规划或管理进程。不要直接复制仍打开的 SQLite 主文件，也不要为通过检查删除进程标记。

```bash
npm run migrate:hierarchical -- --dry-run --config /private/path/config.json --out /private/path/backups
```

命令获得服务实例锁，检查队列和不确定状态，使用 SQLite backup API 保存包含已提交 WAL 页的数据库快照，同时复制 artifact 和媒体目录。备份目录权限 0700，文件 0600，含本地忽略规则。备份包含私人请求和结果，只供本地维护。

`snapshot.sqlite` 是迁移前副本；`dry-run.sqlite` 是执行迁移和约束检查的副本。`report.json` 记录原版本、导入数量和资源数量。dry-run 不更改原库 schema、native ref、回复时间或旧输入 provenance。

绑定导入按旧请求中保存的目录、完整 profile digest、scope 和 session 验证。目录/配置已变化、缺失绑定元数据、活跃服务、未排空任务、sending 投递或 uncertain effect 都会明确失败。旧路由命名空间保留审计；有效别名和 tombstone 导入新 scope，过期选择和待批准授权不会复活。旧默认模型值不升级为 session-explicit。

三层模式对 Codex 使用固定的临时 untrusted 项目策略，因此配置 hash 包含该策略。迁移先以旧模式重新计算并严格核对原 profile 与 base key，只有底层执行配置完全相同才允许这个固定策略升级。在同一事务中将绑定和 session base key 映射到新 digest，保留 session/native ID、回复时间和旧请求，记录 `legacy-profile-migration:*` 哈希映射。模型、权限、目录或 operator profile 的实际变更仍被拒绝；此映射不调用模型或重放任务。

只有 dry-run 已通过、M0 证明有效且服务仍停止时才应用：

```bash
npm run migrate:hierarchical -- --apply --config /private/path/config.json --out /private/path/backups
```

apply 再次创建一致性备份、验证试迁移，并在短事务中更新原库。重复应用 v4 不会把当前目录和别名重置为旧 v3 状态。旧 binary 不应继续写 v4；回退须停机并对账已执行消息、投递状态和 cursor，不能仅恢复旧 cursor 或旧数据库来隐藏迁移后的副作用。

旧结果完整性通过 `legacy-result:<jobId>` 标记：已知 OUTPUT_TRUNCATED 为 legacy-truncated，其余为 unknown，originalArchived=false。此步骤只保存元信息，不读取旧正文到管理模型、不创建伪造的完整原件；`/debug` 可查标记，`/result` 仍要求真正 ready 的完整原件。旧文本保持在原 jobs 行。已迁移 v4 库在显式维护迁移时可幂等补齐标记。
