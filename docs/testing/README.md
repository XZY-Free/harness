# 测试与验收

测试文件的唯一归属由 `docs/implementation/topic-01-final-closure/72-test-collection-audit.json` 管理：

- Vitest：`unit`、`db`、`integration`、`contract`，每个 `.test.ts/.test.tsx` 只进入一个 project。
- Playwright：`e2e-web`、`e2e-desktop`、`e2e-cross-client`，每个 `.spec.ts` 只进入一个阶段。
- DB 测试使用真实 MySQL 并串行；E2E 使用真实应用入口，不以截图或 mock 代替状态验证。

完整本地验收只运行 `pnpm topic01:acceptance`。`pnpm verify` 复用同一机器计划，CI 也调用同一入口；
`pnpm topic01:acceptance --plan` 只打印计划，不执行任何测试、数据库、构建或 E2E。

涉及 HR Agent 的联调只调用已部署的云端 AgentKit 服务，不启动本地 `hr-agent` 项目。
