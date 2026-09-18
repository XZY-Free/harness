import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
/**
 * 从**已冻结的** ExecutionBinding / RuntimeRevision 重建 Runtime Transport。
 *
 * 事实源：R01 §1「唯一生产组合层」——Runtime endpoint 与出站认证只能由冻结事实解析，
 * 维护 lane 不得从请求或调用方另取一份（那会让重投用不同的 Runtime 语义）。
 *
 * 唯一实现：Session dispatch lane 与半程意图（preparation）lane 共用同一份解析，
 * 不允许各自写一个"看起来一样"的版本。
 */
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import type { ExecutionBinding } from "@/lib/persistence/schema/executions";
import {
  type ExecutionResourcePurpose,
  resolveExecutionResources,
} from "@/lib/runtime/application/execution-resources";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { hostedRuntimeApplicationService } from "@/lib/runtime/application/runtime-resume";
import {
  type RuntimeTransportAuth,
  resolveOutboundRuntimeAuth,
} from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import { createRuntimeTransportResolver } from "@/lib/runtime/transport/runtime-transport-resolver";
import type { WorkspaceExecutionResources } from "@/lib/workspace/workspace-backend";

export interface RuntimeTransportFromBinding {
  runtimeEndpoint: string;
  auth: RuntimeTransportAuth;
  runtimeClient: RuntimeHttpClient;
  /** hosted 直接跑在进程内；external 需要外部 endpoint 的真实网络调用。 */
  hosted: boolean;
}

export interface RuntimeTransportDependencies {
  hostedApplicationService?: HostedRuntimeApplicationService;
  createExternalTransport?: typeof createHttpHarnessRuntimeTransport;
}

/**
 * 解析 Transport；冻结事实与 RuntimeRevision 不一致时抛 `RuntimeTransportMismatch`。
 *
 * 调用方负责把它映射成自己的失败语义（Session lane 走 durable retry / 终态收口）。
 */
export async function resolveRuntimeTransportFromBinding(
  input: { tenantId: string; binding: ExecutionBinding } & RuntimeTransportDependencies,
): Promise<RuntimeTransportFromBinding> {
  const revision = await getRuntimeRevisionById(input.binding.runtimeRevisionId);
  if (
    !revision ||
    revision.protocolType !== "harness_runtime_protocol" ||
    revision.runtimeEvidenceKind !== input.binding.runtimeEvidenceKind
  ) {
    throw new RuntimeTransportMismatchError("冻结的 ExecutionBinding 与 RuntimeRevision 不一致");
  }
  const hosted = revision.runtimeEvidenceKind === "hosted_artifact";
  const endpoint = hosted ? "in-process://hosted" : revision.endpointRef;
  const auth: RuntimeTransportAuth = hosted
    ? { mode: "workload_token", token: "in-process-runtime" }
    : await resolveOutboundRuntimeAuth({
        tenantId: input.tenantId,
        identityMode: revision.identityMode,
        credentialRefId: revision.credentialRefId,
      });
  const runtimeClient = await createRuntimeTransportResolver({
    factories: {
      harness_runtime_protocol: {
        hosted_artifact: () =>
          createInProcessHostedRuntimeClient({
            tenantId: input.tenantId,
            publishedCapabilityEvidence: {
              runtimeRevisionId: revision.id,
              runtimeCapabilitiesJson: revision.runtimeCapabilitiesJson,
            },
            applicationService: input.hostedApplicationService ?? hostedRuntimeApplicationService,
          }),
        external_endpoint: ({ endpoint: externalEndpoint, auth: externalAuth }) =>
          (input.createExternalTransport ?? createHttpHarnessRuntimeTransport)({
            endpoint: externalEndpoint,
            auth: externalAuth,
          }),
      },
    },
  })({
    protocolType: revision.protocolType,
    runtimeEvidenceKind: revision.runtimeEvidenceKind,
    endpoint,
    auth,
  });
  return { runtimeEndpoint: endpoint, auth, runtimeClient, hosted };
}

/** Binding 与 RuntimeRevision 不匹配（终态失败，不可重试）。 */
export class RuntimeTransportMismatchError extends Error {
  readonly stableCode = "RuntimeTransportMismatch";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeTransportMismatch";
  }
}

/** 读取 Invocation 的冻结 Binding；缺失即 `RuntimeTransportMismatch`。 */
export async function requireExecutionBinding(
  tenantId: string,
  invocationId: string,
): Promise<ExecutionBinding> {
  const binding = await getExecutionBindingByInvocation(tenantId, invocationId);
  if (!binding) throw new RuntimeTransportMismatchError("ExecutionBinding 不存在");
  return binding;
}

/** 后台重投所需的执行资源（与请求内联调度同源的投影）。 */
export interface BoundExecutionResources {
  environmentProvisioner?: EnvironmentProvisioner;
  workspace?: WorkspaceExecutionResources;
}

/**
 * 从**已冻结的** ExecutionBinding 解析后台重投所需的执行资源（R01 §5）。
 *
 * Transport 只是执行资源的一项：受管 Environment Provisioner 与 Workspace 执行资源
 * 同样只能来自同一份冻结事实。维护 lane 若不解析它们，MANAGED Binding 的重投就会在
 * 「没有 Provisioner / 没有 Workspace 根」上直接变成终态失败 —— 恢复能力与请求内联
 * 调度不一致，而这正是"后台恢复"最需要一致的地方。
 */
export async function resolveBoundExecutionResources(input: {
  tenantId: string;
  binding: ExecutionBinding;
  purpose: ExecutionResourcePurpose;
}): Promise<BoundExecutionResources> {
  const resources = await resolveExecutionResources({
    tenantId: input.tenantId,
    binding: input.binding,
    purpose: input.purpose,
  });
  return {
    ...(resources.environmentProvisioner
      ? { environmentProvisioner: resources.environmentProvisioner }
      : {}),
    ...(resources.workspace ? { workspace: resources.workspace } : {}),
  };
}
