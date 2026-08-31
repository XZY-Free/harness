# Clean Migration 与 Fresh DB 验证

> 验证日期：2026-08-31。对象是临时 MySQL 8 容器，不是开发库或生产库。

## Migration

- Canonical Root：`lib/persistence/schema/index.ts`
- clean initial migration：`drizzle/0000_initial_schema.sql`
- migration 数：1
- 业务表：123
- 开发期 rename/drop/backfill 兼容链：0
- 已删衤表：13，详见 `07-final-schema-manifest.json#deletedTables`

## 可重复验收

```bash
pnpm db:verify-fresh
```

脚本执行以下真实流程：

1. 创建空 MySQL 8 容器。
2. 执行 `pnpm db:migrate`。
3. 执行 `pnpm db:seed`。
4. 用 `SHOW TABLES` 对比最终 manifest。
5. 以隔离的 `.next-fresh-db` 目录启动 Next.js，对真实 HTTP 入口发起请求。
6. 关闭临时服务和容器，删除隔离构建目录。

## 2026-08-31 结果

| 检查 | 结果 |
|---|---|
| migrate | exit 0 |
| manifest | 123/123，与 Root/Runtime/Migration 完全一致 |
| seed Tenant | 1 |
| seed UserIdentity | 1 |
| seed RoleActionBinding | 21 |
| seed Agent | 0（Agent 空表合法） |
| Next.js boot | Ready，`GET /` 返回 HTTP 307 |
| 整体 | `PASS migrate -> seed -> boot` |
