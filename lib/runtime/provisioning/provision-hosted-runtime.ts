/**
 * Hosted Provisioning 类型定义。
 *
 * Hosted Runtime 供应使用分步 Gateway，由 Saga 负责编排。
 * 异步 Saga（hosted-provisioning-saga.ts）+ Gateway 接口是唯一的供应路径。
 * 本文件仅保留 Gateway 接口共享的类型定义。
 *
 * 专题01 冻结（runtime-only）：
 * - HostedRuntimeRoute 只表示 tenant 内 builtin Harness Runtime 的 targetKind=runtime Route，
 *   不包含 agentRevisionId（Agent Route 从不引用 RuntimeRevision，Hosted 不 inspect Agent）。
 * - 已删除 PublishedHostedAgentRevision（Agent 发布不在 Hosted 供应范围内）。
 */

/** Hosted Runtime Route — runtime-only 解析结果。无 Agent 字段。 */
export interface HostedRuntimeRoute {
  routeId: string;
  routeRevisionId: string;
  routeActivationId: string;
  runtimeRevisionId: string;
  /** Projection 版本号，用于精确 ID 验证。 */
  projectionVersionNo: number;
}
