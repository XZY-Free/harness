# §7.4: Cutover 最终退役策略

## 性质

Cutover 属于**迁移工具**，不应永久成为常规控制面模块。
其存在目的是将历史 Route 从旧资格模型迁移到统一资格模型（Phase 1-4）。

## 退役条件

全部历史 Route 重新认证完成后，执行退役。

## 退役步骤

1. **禁止创建新 Plan** — 移除 `insertPlan` 写入口，保留只读查询
2. **停止 Worker** — 停止 `control-plane-cutover-worker` 进程
3. **保留只读查询** — 保留 `getPlanById`、`listItemsByPlan` 等读取接口（审计期）
4. **保留审计期** — 数据表按保留策略保留（建议 ≥ 90 天）
5. **删除写 API 和执行器** — 删除以下文件：
   - `execute-cutover.ts`
   - `cutover-readiness-checker.ts`
   - `create-replacement-agent-revision.ts`
   - `create-replacement-runtime-revision.ts`
   - `scripts/workers/control-plane-cutover-worker.ts`
6. **数据表归档** — `ControlPlaneCutoverPlan` + `ControlPlaneCutoverItem` 表按数据保留策略归档

## 当前状态

- ✅ Item Ready 正式条件已实现（§7.1）
- ✅ Worker 轮询已实现（§7.2）
- ✅ Plan 真实激活流程已实现（§7.3）
- ⏳ 退役待全部历史 Route 重新认证完成后执行

## 标记

在全部 Cutover Plan 完成激活（`state = activated`）且无 `failed`/`manual_review` Item 后，
可安全启动退役流程。
