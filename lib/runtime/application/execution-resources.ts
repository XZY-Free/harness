/**
 * 唯一生产组合层（R01 §1）。
 *
 * 每一次真实执行（默认 Thread、Job、Redispatch、Resume、后台恢复）都必须从**已冻结的
 * ExecutionBinding** 解析运行资源，而不是由调用方各自拼装：
 *
 * | 资源 | 唯一来源 |
 * |---|---|
 * | 冻结能力目录 | `Binding.capabilityCatalogJson` + `capabilityCatalogDigest`（重验摘要） |
 * | 可信执行主体 | `Binding.principalType/principalId/principalSource`（`recoverTrustedExecutionSubject`） |
 * | 平台 Action Executors | 上述冻结目录 → `createPlatformHarnessActionExecutors` |
 * | Workspace 执行资源 | `Binding.workspaceBindingId` → 受管 Host 真实解析 |
 * | EnvironmentProvisioner | `Binding.environmentMode`（MANAGED 必需） |
 *
 * 关键不变量：
 * - 调用方不得提交 WorkspaceBackend 实例、本地路径或未经验证的 Environment；它们只能
 *   在**部署边界**上作为适配器注入（`ExecutionResourceOverrides`）。
 * - BOUND（非 `NO_PLATFORM_WORKSPACE`）且服务端是 Writer 时，必须解析出真实 Host；
 *   解析不到就是 `WorkspaceNotReady`，**绝不**降级成 NO_PLATFORM 合同。
 * - NO_PLATFORM 只来自领域显式冻结的 NO_PLATFORM_WORKSPACE 合同。
 * - 能力目录、Workspace 契约、Environment Revision 与真正运行资源必须引用同一份冻结事实：
 *   不允许"用真实 Workspace 构造 Catalog，再用 NONE 启动"。
 */
import { runtimeConfig } from "@/lib/config";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import { createDefaultEnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import type { ExecutionBinding } from "@/lib/persistence/schema/executions";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import { createConfiguredRouteResolver } from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import {
  type CapabilityCatalogSnapshot,
  verifyCapabilityCatalogSnapshot,
} from "@/lib/runtime/harness-loop/capability-catalog";
import type { HarnessActionExecutors } from "@/lib/runtime/harness-loop/loop";
import { createPlatformHarnessActionExecutors } from "@/lib/runtime/harness-loop/platform-action-executors";
import {
  type ExecutionSubject,
  recoverTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";
import {
  type ManagedWorkspaceHostOverrides,
  WorkspaceNotReadyError,
  requiresManagedWorkspaceWriter,
  resolveManagedWorkspaceResources,
} from "@/lib/workspace/managed-workspace-host";
import {
  type WorkspaceExecutionResources,
  createWorkspaceBackend,
} from "@/lib/workspace/workspace-backend";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";

/**
 * 正式 Route Resolver（Projection 是唯一数据源）。
 *
 * 这是默认 Thread、Job 与后台恢复共用的唯一实例；不允许各入口各自构造一份。
 */
const configuredRouteResolver = createConfiguredRouteResolver({
  projectionStore: mysqlRouteEligibilityResolutionStore,
});
export const canonicalRouteResolver: RouteResolver = async (input) =>
  (
    await configuredRouteResolver({
      tenantId: input.tenantId,
      target: input.target,
      routeScopeKey: input.routeScopeKey,
      businessKey: input.businessKey,
      attributes: input.attributes,
      threadDefaultModelRef: input.threadDefaultModelRef,
    })
  ).outcome;

/** 用途只影响可恢复失败事实的措辞，不改变任何解析来源。 */
export type ExecutionResourcePurpose = "thread" | "job" | "redispatch" | "resume" | "recovery";

/** 外部边界适配器（部署/测试注入）。缺省时由本层给出生产默认。 */
export interface ExecutionResourceOverrides {
  /** 受管 Environment Backend（容器/Host）解析；缺省为部署默认 Backend。 */
  environmentProvisioner?: EnvironmentProvisioner | null;
  /** 受管 Workspace Host 解析覆盖（部署根、Host 身份）。 */
  workspaceHost?: ManagedWorkspaceHostOverrides;
}

export interface ExecutionResources {
  binding: ExecutionBinding;
  workspaceBinding: WorkspaceBinding;
  /** 已重验摘要的冻结能力目录。 */
  capabilityCatalog: CapabilityCatalogSnapshot;
  /** Binding 冻结的可信执行主体。 */
  executionSubject: ExecutionSubject;
  /** 由冻结目录装配的平台 Action Executors（Agent/Tool/Knowledge）。 */
  actionExecutors: HarnessActionExecutors;
  /**
   * BOUND 且服务端为 Writer 时必需；`NO_PLATFORM_WORKSPACE` 与 `HOST_AFFINE`
   * （写由绑定设备本机执行）为 `undefined`。never `NONE` 降级的产物。
   */
  workspace?: WorkspaceExecutionResources;
  /** MANAGED 时必需；NO_PLATFORM_ENVIRONMENT 时为 `null`。 */
  environmentProvisioner: EnvironmentProvisioner | null;
}

/**
 * 从 Binding 重验并返回冻结能力目录。
 *
 * 摘要不一致即 `CapabilityCatalogIntegrityError`：能力目录一旦冻结就不可被当前目录改写。
 */
export function resolveFrozenCapabilityCatalog(
  binding: ExecutionBinding,
): CapabilityCatalogSnapshot {
  return verifyCapabilityCatalogSnapshot(
    binding.capabilityCatalogJson,
    binding.capabilityCatalogDigest,
  );
}

/** 从 Binding 恢复冻结的可信执行主体（唯一恢复入口）。 */
export function resolveFrozenExecutionSubject(
  binding: ExecutionBinding,
  tenantId: string,
): ExecutionSubject {
  return recoverTrustedExecutionSubject(
    {
      tenantId: binding.tenantId,
      principalType: binding.principalType,
      principalId: binding.principalId,
      principalSource: binding.principalSource,
      principalFrozenAt: binding.principalFrozenAt,
    },
    tenantId,
  );
}

/**
 * 解析 Workspace 执行资源。
 *
 * - `NO_PLATFORM_WORKSPACE`：领域显式冻结的 NO_PLATFORM 合同 → 无执行资源。
 * - `HOST_AFFINE`：写由绑定设备本机执行（R08 冻结事实），服务端不持有 Writer。
 * - `SHARED_DURABLE` / `CHECKPOINT_RESTORABLE`：服务端 Writer → 必须有真实 Host，
 *   否则 `WorkspaceNotReady`（保留可恢复失败事实，不降级）。
 */
export async function resolveWorkspaceExecutionResources(
  workspaceBinding: WorkspaceBinding,
  overrides: ExecutionResourceOverrides = {},
): Promise<WorkspaceExecutionResources | undefined> {
  if (workspaceBinding.continuityMode === "NO_PLATFORM_WORKSPACE") return undefined;
  if (!requiresManagedWorkspaceWriter(workspaceBinding)) return undefined;
  const resources = await resolveManagedWorkspaceResources(
    workspaceBinding,
    overrides.workspaceHost ?? {},
  );
  return {
    binding: workspaceBinding,
    backend: createWorkspaceBackend(resources.host),
    root: resources.root,
    snapshotStorage: resources.snapshotStorage,
  };
}

/** MANAGED 环境的 Provisioner；NO_PLATFORM_ENVIRONMENT 返回 `null`。 */
export function resolveEnvironmentProvisioner(
  binding: ExecutionBinding,
  overrides: ExecutionResourceOverrides = {},
): EnvironmentProvisioner | null {
  if (binding.environmentMode !== "MANAGED") return null;
  if (overrides.environmentProvisioner) return overrides.environmentProvisioner;
  return createDefaultEnvironmentProvisioner({ runtimeType: runtimeConfig.defaultType });
}

/**
 * 解析一次真实执行的全部运行资源。
 *
 * 输入只有：可信 tenant、已冻结 Binding、用途、部署/测试边界适配器。
 * 输出即执行所需的一切；调用方不得再从别处拼装任何一项。
 */
export async function resolveExecutionResources(input: {
  tenantId: string;
  binding: ExecutionBinding;
  purpose: ExecutionResourcePurpose;
  overrides?: ExecutionResourceOverrides;
}): Promise<ExecutionResources> {
  const overrides = input.overrides ?? {};
  const workspaceBinding = await getWorkspaceBindingById(
    input.tenantId,
    input.binding.workspaceBindingId,
  );
  if (!workspaceBinding) {
    throw new WorkspaceNotReadyError(
      `Binding ${input.binding.invocationId} 引用的 WorkspaceBinding 不存在（${input.binding.workspaceBindingId}）`,
    );
  }
  const capabilityCatalog = resolveFrozenCapabilityCatalog(input.binding);
  const executionSubject = resolveFrozenExecutionSubject(input.binding, input.tenantId);
  const workspace = await resolveWorkspaceExecutionResources(workspaceBinding, overrides);
  return {
    binding: input.binding,
    workspaceBinding,
    capabilityCatalog,
    executionSubject,
    actionExecutors: createPlatformHarnessActionExecutors({
      tenantId: input.tenantId,
      executionSubject,
      resolveRoute: canonicalRouteResolver,
      capabilityCatalog,
      transportChannel: "hosted",
    }),
    ...(workspace ? { workspace } : {}),
    environmentProvisioner: resolveEnvironmentProvisioner(input.binding, overrides),
  };
}
