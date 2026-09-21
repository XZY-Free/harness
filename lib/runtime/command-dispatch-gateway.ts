import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import {
  executionOwnershipTable,
  invocationCommandTable,
} from "@/lib/persistence/schema/executions";
import type {
  ExecutionBinding,
  ExecutionOwnership,
  Invocation,
  InvocationCommand,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import type { RuntimeRevisionRow } from "@/lib/persistence/schema/runtimes";
import type { ExecutionResourcePurpose } from "@/lib/runtime/application/execution-resources";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { hostedRuntimeApplicationService } from "@/lib/runtime/application/runtime-resume";
import { resolveEffectiveInvocationCapabilities } from "@/lib/runtime/capabilities/effective-invocation-capabilities";
import {
  CommandDispatchClaimSupersededError,
  type CommandDispatchResult,
  type CommandRuntimeEndpointResolution,
  acceptResumeCommandPreparation,
  dispatchCancelCommand,
  dispatchCheckpointCommand,
  dispatchResumeCommand,
  dispatchSteerCommand,
  retryDispatchedInvocationCommand,
} from "@/lib/runtime/command-dispatcher";
import { resolveOutboundRuntimeAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingsByInvocation,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
  claimInvocationCommandDispatch,
  settleSupersededInvocationCommand,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import { RUNTIME_DISPATCH_RETRY_POLICY } from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import {
  type BoundExecutionResources,
  resolveBoundExecutionResources,
} from "@/lib/runtime/retry/runtime-transport-from-binding";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import type { RuntimeTransport } from "@/lib/runtime/transport/runtime-transport";
import { createRuntimeTransportResolver } from "@/lib/runtime/transport/runtime-transport-resolver";
/** Builds the Runtime transport for durable InvocationCommand delivery. */
import { and, eq, sql } from "drizzle-orm";

let hostedApplicationServiceForTest: HostedRuntimeApplicationService | null = null;

export function setCommandGatewayHostedApplicationServiceForTest(
  service: HostedRuntimeApplicationService | null,
): void {
  hostedApplicationServiceForTest = service;
}

export type CommandGatewayResult =
  | { dispatched: true; command: CommandDispatchResult }
  | {
      dispatched: false;
      reason:
        | "command_not_found"
        | "unsupported_capability"
        | "target_superseded"
        | "not_claimable"
        /** 已取得领取，但在网络等待期间丢失（被接管或过期）：本次投递不产生任何交付。 */
        | "claim_superseded";
    };

type CommandContextLoad =
  | {
      ok: true;
      command: InvocationCommand;
      invocation: Invocation;
      binding: ExecutionBinding;
      owner: ExecutionOwnership | null;
      session: RuntimeSessionBinding | null;
      revision: RuntimeRevisionRow;
    }
  | { ok: false; reason: "command_not_found" | "target_superseded" };

/**
 * R03 §6：命令的目标在**正式接受时**固定。
 *
 * - `cancel`/`steer`/`checkpoint`：只按 `targetOwnershipId` + `targetSessionId` 读取冻结
 *   目标，绝不回落到"当前 active ownership"；目标缺失或已失效 → `target_superseded`
 *   （不把同一命令重定向新 Owner）。
 * - `resume`：目标是 Invocation 本身而非某一代际，Session 仅用于读 effective capability，
 *   因此允许按 Invocation 取最近一条 SessionBinding。
 */
async function loadContext(tenantId: string, commandId: string): Promise<CommandContextLoad> {
  const [command] = await db
    .select()
    .from(invocationCommandTable)
    .where(
      and(eq(invocationCommandTable.tenantId, tenantId), eq(invocationCommandTable.id, commandId)),
    )
    .limit(1);
  if (!command) return { ok: false, reason: "command_not_found" };
  const invocation = await getInvocationById(tenantId, command.invocationId);
  const binding = invocation
    ? await getExecutionBindingByInvocation(tenantId, invocation.id)
    : null;
  const isResume = command.commandType === "resume";
  const ownerRows =
    invocation && command.targetOwnershipId
      ? await db
          .select()
          .from(executionOwnershipTable)
          .where(
            and(
              eq(executionOwnershipTable.tenantId, tenantId),
              eq(executionOwnershipTable.id, command.targetOwnershipId),
              eq(executionOwnershipTable.invocationId, invocation.id),
            ),
          )
          .limit(1)
      : [];
  const owner = ownerRows[0] ?? null;
  const session = invocation
    ? command.targetSessionId
      ? await getRuntimeSessionBindingById(tenantId, command.targetSessionId)
      : isResume
        ? ((await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id))[0] ?? null)
        : null
    : null;
  const revision = binding ? await getRuntimeRevisionById(binding.runtimeRevisionId) : null;
  if (!invocation || !binding || !revision) return { ok: false, reason: "command_not_found" };
  if (!isResume) {
    // 冻结目标必须仍然有效：Owner 属于本 Invocation、仍 active，Session 与它一一对应。
    if (
      !owner ||
      owner.ownershipState !== "active" ||
      !session ||
      session.ownershipId !== owner.id ||
      session.leaseEpoch !== owner.leaseEpoch
    ) {
      return { ok: false, reason: "target_superseded" };
    }
  }
  return { ok: true, command, invocation, binding, owner, session, revision };
}

async function resolveTransport(
  tenantId: string,
  context: Extract<CommandContextLoad, { ok: true }>,
): Promise<{ client: RuntimeTransport; endpoint: CommandRuntimeEndpointResolution }> {
  const external = context.revision.runtimeEvidenceKind === "external_endpoint";
  // A05：Resume 需要与**请求内联调度**同源的受管执行资源（Workspace 执行资源 +
  // Environment Provisioner）。它们只能来自同一份冻结 Binding，调用方不得另拼；
  // 缺了它们，默认命令网关上的 MANAGED Resume 会在"没有 Provisioner"上直接变成
  // 终态失败 —— 同一份持久意图在请求内联路径可执行、在正式恢复路径不可恢复。
  //
  // 只在需要它们的命令上解析：
  // - `resume`：受管 Environment（Provisioner）+ Workspace 执行资源；
  // - `checkpoint`：Checkpoint 生产者必须拿到带 `snapshotStorageRoot` 的真实写根，
  //   否则默认路径恒 `WorkspaceNotReady`（同一类"接线缺参"缺陷）。
  // - `cancel`/`steer` 不需要写根与实例：不该因为"部署没配受管 WorkspaceHost"而被拒。
  const managedResourcePurpose: ExecutionResourcePurpose | null =
    context.command.commandType === "resume"
      ? "resume"
      : context.command.commandType === "checkpoint"
        ? "recovery"
        : null;
  const managedResources: BoundExecutionResources = managedResourcePurpose
    ? await resolveBoundExecutionResources({
        tenantId,
        binding: context.binding,
        purpose: managedResourcePurpose,
      })
    : {};
  const endpoint = external ? context.revision.endpointRef : "http://127.0.0.1";
  const authority =
    context.owner && context.session
      ? {
          invocationId: context.invocation.id,
          runtimeRevisionId: context.binding.runtimeRevisionId,
          attemptId: context.owner.attemptId,
          ownershipId: context.owner.id,
          leaseEpoch: String(context.owner.leaseEpoch),
          sessionBindingId: context.session.id,
        }
      : null;
  const auth = external
    ? await resolveOutboundRuntimeAuth({
        tenantId,
        identityMode: context.revision.identityMode,
        credentialRefId: context.revision.credentialRefId,
      })
    : authority
      ? {
          mode: "workload_token" as const,
          token: issueWorkloadToken({
            contractVersion: 3,
            type: "execution",
            tenantId,
            ...authority,
            audience: "runtime",
            expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
          }),
        }
      : { mode: "workload_token" as const, token: "in-process-runtime" };
  const client = await createRuntimeTransportResolver({
    factories: {
      harness_runtime_protocol: {
        hosted_artifact: () =>
          createInProcessHostedRuntimeClient({
            tenantId,
            publishedCapabilityEvidence: {
              runtimeRevisionId: context.revision.id,
              runtimeCapabilitiesJson: context.revision.runtimeCapabilitiesJson,
            },
            applicationService: hostedApplicationServiceForTest ?? hostedRuntimeApplicationService,
          }),
        external_endpoint: ({ endpoint: externalEndpoint, auth: externalAuth }) =>
          createHttpHarnessRuntimeTransport({ endpoint: externalEndpoint, auth: externalAuth }),
      },
    },
  })({
    protocolType: context.revision.protocolType,
    runtimeEvidenceKind: context.revision.runtimeEvidenceKind,
    endpoint,
    auth,
  });
  return {
    client,
    endpoint: {
      runtimeEndpoint: endpoint,
      auth,
      callbackEndpoints: buildGatewayEndpoints({ external, invocationId: context.invocation.id }),
      ...managedResources,
    },
  };
}

/**
 * R03 §6：目标失效（`target_superseded`）的唯一终态收口入口。
 *
 * 目标失效在到达 dispatcher 之前就可能被判出；此时必须同样落终态，否则
 * `queued` 行无人扫描、`dispatched` 行会被维护 lane 每 30s 反复领取，永不排空。
 */
async function settleIfSuperseded(
  tenantId: string,
  commandId: string,
  claimToken: string,
  reason: "command_not_found" | "target_superseded",
): Promise<void> {
  if (reason !== "target_superseded") return;
  await settleSupersededInvocationCommand({ tenantId, commandId, claimToken });
}

/**
 * A09：真实投递前**必须**持有领取 nonce。
 *
 * 后台 lane 已经在自己的领取事务里写过 `dispatchLeaseOwner`，直接沿用；
 * 请求内联调度此前没有领取身份（`claimToken=null`），现在走**同一个**原子领取服务，
 * 只是触发资格不同：内联请求即创建者，允许立即领取刚写的 `queued` 行。
 * 取得 claim 之后，内联与后台的续期/尾部规则完全一致。
 */
async function acquireDeliveryClaim(params: {
  tenantId: string;
  commandId: string;
  claimToken?: string;
}): Promise<string | null> {
  if (params.claimToken) return params.claimToken;
  const claim = await claimInvocationCommandDispatch({
    commandId: params.commandId,
    leaseOwner: `inline-dispatch:${randomUUID()}`,
    leaseDurationMs: RUNTIME_DISPATCH_RETRY_POLICY.leaseDurationMs,
    now: new Date(),
    allowImmediateQueued: true,
  });
  return claim?.claimToken ?? null;
}

async function dispatchCommand(params: {
  tenantId: string;
  commandId: string;
  type: "cancel" | "resume" | "steer" | "checkpoint";
  retry?: boolean;
  /** R04 §5：维护 lane 领取到的 claim 令牌；请求内联路径为 undefined。 */
  claimToken?: string;
}): Promise<CommandGatewayResult> {
  const claimToken = await acquireDeliveryClaim(params);
  if (!claimToken) {
    // 该命令当前不可领取（已被别的投递者持有 / 已终态）：不产生第二次交付，
    // 也不在没有领取身份的情况下写任何尾部结论。
    return { dispatched: false, reason: "not_claimable" };
  }
  const loaded = await loadContext(params.tenantId, params.commandId);
  if (!loaded.ok) {
    await settleIfSuperseded(params.tenantId, params.commandId, claimToken, loaded.reason);
    return { dispatched: false, reason: loaded.reason };
  }
  const context = loaded;
  if (context.command.commandType !== params.type)
    return { dispatched: false, reason: "command_not_found" };
  // Resume 前置 capability 门控：effective capability（SessionBinding 冻结快照与
  // RuntimeRevision 发布事实的交集；session 缺省时回退发布事实，形状不可识别一律
  // fail-closed）未声明 resume 时零网络拒绝，不产生 transport 调用。
  if (params.type === "resume") {
    const capabilities = await resolveEffectiveInvocationCapabilities({
      tenantId: params.tenantId,
      binding: context.binding,
      ...(context.session
        ? { sessionCapabilitiesJson: context.session.runtimeCapabilitiesJson }
        : {}),
    });
    if (!capabilities.resume) return { dispatched: false, reason: "unsupported_capability" };
  }
  const resumePreparationClaim =
    params.type === "resume"
      ? await acceptResumeCommandPreparation({
          tenantId: params.tenantId,
          commandId: params.commandId,
        })
      : null;
  const transport = await resolveTransport(params.tenantId, context);
  const input = {
    tenantId: params.tenantId,
    commandId: params.commandId,
    runtimeClient: transport.client,
    runtimeEndpointResolver: async (_binding: ExecutionBinding) => transport.endpoint,
    // A09：领取已在上面的 `acquireDeliveryClaim` 里完成（领取事务把行推进到
    // `dispatched`），dispatcher 只按**已领取**状态进入 —— 没有 claim 就没有
    // `dispatched` 行，也就没有尾部写入。
    claimToken,
    ...(resumePreparationClaim ? { resumePreparationClaim } : {}),
  };
  let command: CommandDispatchResult;
  try {
    command = params.retry
      ? await retryDispatchedInvocationCommand(input)
      : params.type === "cancel"
        ? await dispatchCancelCommand(input)
        : params.type === "resume"
          ? await dispatchResumeCommand(input)
          : params.type === "steer"
            ? await dispatchSteerCommand(input)
            : await dispatchCheckpointCommand(input);
  } catch (error) {
    // A09：等待网络期间领取被别人接管（或本领取已过期）。dispatcher 正确地以
    // `CommandDispatchClaimSupersededError` 拒绝且零写入；网关把它收敛成一个稳定的
    // **无交付**结果，让调用方（HTTP 入口 / 维护 lane）不会把它当成"投递失败"再去
    // 生成新的失败事实，也不会重试同一份已失效的 claim。
    if (error instanceof CommandDispatchClaimSupersededError) {
      return { dispatched: false, reason: "claim_superseded" };
    }
    throw error;
  }
  return { dispatched: true, command };
}

type CommandGatewayInput = {
  tenantId: string;
  commandId: string;
  actorId?: string;
  correlationId?: string;
  /** R04 §5：维护 lane 领取到的 claim 令牌（重投时用于复核完成身份）。 */
  claimToken?: string;
};

export function dispatchInterruptCommandToRuntime(
  params: CommandGatewayInput,
): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, type: "cancel" });
}
export function dispatchResumeCommandToRuntime(
  params: CommandGatewayInput,
): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, type: "resume" });
}
export function dispatchSteerCommandToRuntime(
  params: CommandGatewayInput,
): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, type: "steer" });
}
export function dispatchCheckpointCommandToRuntime(
  params: CommandGatewayInput,
): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, type: "checkpoint" });
}
export async function retryDispatchedCommandToRuntime(
  params: CommandGatewayInput,
): Promise<CommandGatewayResult> {
  const claimToken = await acquireDeliveryClaim(params);
  if (!claimToken) return { dispatched: false, reason: "not_claimable" };
  const loaded = await loadContext(params.tenantId, params.commandId);
  if (!loaded.ok) {
    await settleIfSuperseded(params.tenantId, params.commandId, claimToken, loaded.reason);
    return { dispatched: false, reason: loaded.reason };
  }
  const type = loaded.command.commandType;
  if (type !== "cancel" && type !== "resume" && type !== "steer" && type !== "checkpoint") {
    return { dispatched: false, reason: "unsupported_capability" };
  }
  // 重投沿用冻结目标；目标失效同样返回 target_superseded，不追随 current。
  // 已取得的 claim 必须继续沿用，不能再次领取（否则会把本次领取自己顶掉）。
  return dispatchCommand({ ...params, type, retry: true, claimToken });
}
