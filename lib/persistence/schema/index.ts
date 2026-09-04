/**
 * Root Schema（单一 Canonical Schema Authority）。
 *
 * 本文件是整仓唯一的 Schema 聚合入口（关口02 §3 / §21）：
 * - 聚合 lib/persistence/schema/ 内全部 Canonical 表定义（38 个）。
 * - 聚合领域内、目录位于其他模块的 Canonical 表定义（8 个外部 Canonical：
 *   control-plane / artifacts / publications / routes / runtime）。
 * - Facade（agents/artifacts/control-plane/executions/publications/routes/runtimes）
 *   只是重导出，不入 Root。
 *
 * drizzle.config.ts 与 lib/db/client.ts 都只消费本文件，作为唯一 Authority。
 * 任何新增 Canonical 表都必须在此聚合，否则 Architexture Gate 会失败。
 */

// ─── lib/persistence/schema 内 Canonical（38）──────────────────────
export * from "@/lib/persistence/schema/admin-export";
export * from "@/lib/persistence/schema/agents";
export * from "@/lib/persistence/schema/agent-calls";
export * from "@/lib/persistence/schema/audit";
export * from "@/lib/persistence/schema/authorization";
export * from "@/lib/persistence/schema/capability-use";
export * from "@/lib/persistence/schema/catalog";
export * from "@/lib/persistence/schema/context-checkpoint";
export * from "@/lib/persistence/schema/conversation";
export * from "@/lib/persistence/schema/deletion-request";
export * from "@/lib/persistence/schema/deployment-route";
export * from "@/lib/persistence/schema/device";
export * from "@/lib/persistence/schema/effect";
export * from "@/lib/persistence/schema/environment";
export * from "@/lib/persistence/schema/evaluation";
export * from "@/lib/persistence/schema/file-change";
export * from "@/lib/persistence/schema/filesystem-checkpoint";
export * from "@/lib/persistence/schema/governance-config";
export * from "@/lib/persistence/schema/idempotency";
export * from "@/lib/persistence/schema/identity";
export * from "@/lib/persistence/schema/job";
export * from "@/lib/persistence/schema/knowledge";
export * from "@/lib/persistence/schema/memory";
export * from "@/lib/persistence/schema/permission";
export * from "@/lib/persistence/schema/projection";
export * from "@/lib/persistence/schema/recovery-drill";
export * from "@/lib/persistence/schema/retention-policy";
// runtime-artifact 的 Artifact/NewArtifact 类型与外部 artifact-record 冲突，
// 故不在此 `export *`，显式导出并对冲突类型别名（表名 artifactTable 与 artifact 不冲突）。
export {
  RUNTIME_ARTIFACT_TYPES,
  VISIBILITY_SCOPES,
  artifactTable,
} from "@/lib/persistence/schema/runtime-artifact";
export type {
  RuntimeArtifactType,
  VisibilityScope,
  Artifact as RuntimeArtifact,
  NewArtifact as NewRuntimeArtifact,
} from "@/lib/persistence/schema/runtime-artifact";
export * from "@/lib/persistence/schema/runtimes";
export * from "@/lib/persistence/schema/executions";
export * from "@/lib/persistence/schema/security-incident";
export * from "@/lib/persistence/schema/skill";
export * from "@/lib/persistence/schema/skill-sync";
export * from "@/lib/persistence/schema/tool-call";
export * from "@/lib/persistence/schema/tool-execution";
export * from "@/lib/persistence/schema/tool";
export * from "@/lib/persistence/schema/trace";
export * from "@/lib/persistence/schema/usage";
export * from "@/lib/persistence/schema/user-action-request";
export * from "@/lib/persistence/schema/workload-token-revocation";
export * from "@/lib/persistence/schema/workspace-lock";
export * from "@/lib/persistence/schema/workspace";

// ─── 外部 Canonical（8）────────────────────────────────────────────
export * from "@/lib/control-plane/events/control-plane-event-delivery";
export * from "@/lib/control-plane/events/control-plane-outbox";
export * from "@/lib/artifacts/persistence/artifact-record";
export * from "@/lib/publications/persistence/publication-record";
export * from "@/lib/routes/persistence/route-revision-record";
export * from "@/lib/routes/projection/route-eligibility-projection-record";
export * from "@/lib/runtime/persistence/runtime-conformance-run-record";
export * from "@/lib/runtime/persistence/hosted-provisioning-request-record";
