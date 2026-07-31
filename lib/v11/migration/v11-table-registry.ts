import { v11Agent, v11AgentRevision } from "@/lib/v11/schema/agent";
import { v11ArtifactAttestation } from "@/lib/v11/schema/artifact";
import { auditEvent } from "@/lib/v11/schema/audit";
import { roleActionBinding } from "@/lib/v11/schema/authorization";
import { contextCheckpoint } from "@/lib/v11/schema/context-checkpoint";
import {
  v11Goal,
  v11Thread,
  v11ThreadEvent,
  v11ThreadItem,
  v11ThreadRelation,
} from "@/lib/v11/schema/conversation";
import { v11DeploymentRoute, v11DeploymentRouteSet } from "@/lib/v11/schema/deployment-route";
import { device } from "@/lib/v11/schema/device";
import { v11FilesystemCheckpoint } from "@/lib/v11/schema/filesystem-checkpoint";
import { principalBinding, tenant, userIdentity } from "@/lib/v11/schema/identity";
import { v11Job } from "@/lib/v11/schema/job";
import { memoryCandidate, memoryEntry, memoryIndex } from "@/lib/v11/schema/memory";
import {
  v11Grant,
  v11PermissionDecision,
  v11Policy,
  v11PolicyRevision,
  v11PolicySet,
} from "@/lib/v11/schema/permission";
import {
  v11ExecutionBinding,
  v11Invocation,
  v11InvocationAttempt,
  v11RuntimeEventIngress,
} from "@/lib/v11/schema/runtime";
import { v11Skill, v11SkillVersion } from "@/lib/v11/schema/skill";
import {
  v11Connection,
  v11CredentialRef,
  v11Tool,
  v11ToolProvider,
  v11ToolSchemaRevision,
} from "@/lib/v11/schema/tool";
import { v11ToolCall } from "@/lib/v11/schema/tool-call";
import { v11UserActionRequest } from "@/lib/v11/schema/user-action-request";
import { workspace, workspaceBinding } from "@/lib/v11/schema/workspace";
/**
 * S13-W03 V11 目标表注册表：将 V11 物理表名映射到 drizzle 表对象。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W03
 *         （按身份/授权、Agent/能力、Thread/事件顺序回填）。
 *
 * MigrationRunner.writeTargets 通过此注册表查找表对象并执行 db.insert。
 * 按迁移域逐步注册，未注册的表名在写入时抛错（防止误写）。
 */
import type { MySqlTable } from "drizzle-orm/mysql-core";

/** V11 表名 → drizzle 表对象映射。 */
const V11_TABLE_REGISTRY = new Map<string, MySqlTable>([
  // identity 域
  ["Tenant", tenant],
  ["UserIdentity", userIdentity],
  ["PrincipalBinding", principalBinding],
  // authorization 域
  ["RoleActionBinding", roleActionBinding],
  // agent_skill 域
  ["V11Skill", v11Skill],
  ["V11SkillVersion", v11SkillVersion],
  ["V11Agent", v11Agent],
  ["V11AgentRevision", v11AgentRevision],
  // conversation 域
  ["V11Thread", v11Thread],
  ["V11ThreadItem", v11ThreadItem],
  ["V11ThreadEvent", v11ThreadEvent],
  ["V11ThreadRelation", v11ThreadRelation],
  ["V11Goal", v11Goal],
  // context_plan 域
  ["V11ContextCheckpoint", contextCheckpoint],
  // runtime 域（conversation 域 ThreadRun 迁移依赖）
  ["V11Invocation", v11Invocation],
  ["V11InvocationAttempt", v11InvocationAttempt],
  // runtime_fact 域
  ["V11ToolCall", v11ToolCall],
  ["V11RuntimeEventIngress", v11RuntimeEventIngress],
  ["V11ExecutionBinding", v11ExecutionBinding],
  // background_subagent 域
  ["V11Job", v11Job],
  // mcp_tool 域
  ["V11Connection", v11Connection],
  ["V11CredentialRef", v11CredentialRef],
  ["V11ToolProvider", v11ToolProvider],
  ["V11Tool", v11Tool],
  ["V11ToolSchemaRevision", v11ToolSchemaRevision],
  // memory 域
  ["V11MemoryEntry", memoryEntry],
  ["V11MemoryCandidate", memoryCandidate],
  ["V11MemoryIndex", memoryIndex],
  // policy 域
  ["V11PolicySet", v11PolicySet],
  ["V11PolicyRevision", v11PolicyRevision],
  ["V11Policy", v11Policy],
  ["V11PermissionDecision", v11PermissionDecision],
  ["AuditEvent", auditEvent],
  ["V11UserActionRequest", v11UserActionRequest],
  // deployment_secret 域
  ["V11DeploymentRouteSet", v11DeploymentRouteSet],
  ["V11DeploymentRoute", v11DeploymentRoute],
  ["V11Grant", v11Grant],
  // git_checkpoint 域
  ["V11Workspace", workspace],
  ["V11WorkspaceBinding", workspaceBinding],
  ["V11FilesystemCheckpoint", v11FilesystemCheckpoint],
  ["V11ArtifactAttestation", v11ArtifactAttestation],
  // misc 域
  ["Device", device],
]);

/** 查找 V11 表对象；未注册返回 undefined。 */
export function getV11Table(tableName: string): MySqlTable | undefined {
  return V11_TABLE_REGISTRY.get(tableName);
}

/** 返回 V11 表注册表（只读视图），供 createExecutionRunner 传入 tableRegistry。 */
export function getV11TableRegistry(): ReadonlyMap<string, MySqlTable> {
  return V11_TABLE_REGISTRY;
}

/** 注册新的 V11 表（扩展用）。 */
export function registerV11Table(tableName: string, table: MySqlTable): void {
  V11_TABLE_REGISTRY.set(tableName, table);
}

/** 返回已注册的所有 V11 表名。 */
export function listRegisteredV11Tables(): readonly string[] {
  return [...V11_TABLE_REGISTRY.keys()];
}

/** 判断指定 V11 表是否已注册。 */
export function isV11TableRegistered(tableName: string): boolean {
  return V11_TABLE_REGISTRY.has(tableName);
}
