/**
 * EffectiveInvocationCapabilities。
 *
 * 只读派生服务，不是新 Authority：全部输入来自已冻结事实
 * （ExecutionBinding 的 runtimeRevisionId），禁止查"当前最新 Agent/Runtime"。
 *
 * Agent 与 Runtime Authority 分离：ExecutionBinding 只绑定 Harness Runtime，不再有 Agent Contract
 * 证据，effective capability 退化为 runtime-only——
 * ```text
 * Base Harness: runtime.measured.cancel AND 协议实现支持（保持 Hosted 现有语义）
 * ```
 *
 * 事实源：docs/architecture/runtime-control-plane.md
 */
import type { RuntimeRevisionRow } from "@/lib/runtime/persistence/runtime-revision-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  type RuntimeCapabilitiesResponse,
  isRuntimeCapabilitiesResponse,
} from "@/lib/runtime/runtime-client";

/** Invocation 级 effective 能力（至少统一表达  五项）。 */
export interface EffectiveInvocationCapabilities {
  readonly cancel: boolean;
  readonly resume: boolean;
  readonly steer: boolean;
  readonly user_action: boolean;
  readonly streaming: boolean;
}

/** ExecutionBinding 冻结证据（ 精确公式输入；Agent 与 Runtime Authority 分离：runtime-only）。 */
export interface EffectiveCapabilityBindingEvidence {
  readonly runtimeRevisionId: string;
}

/** Runtime 层（无 Agent Contract）能力：measured AND 协议实现（ Base Harness）。 */
export interface RuntimeLevelCapabilities {
  readonly cancel: boolean;
  readonly resume: boolean;
  readonly steer: boolean;
  readonly user_action: boolean;
  readonly streaming: boolean;
}

/** fail-closed：任何事实不可解析 → 全部 false（deny），不抛错掩盖为可用。 */
const NO_CAPABILITIES: EffectiveInvocationCapabilities = {
  cancel: false,
  resume: false,
  steer: false,
  user_action: false,
  streaming: false,
};

/**
 * 协议实现能力（ 第三因子）：Transport/执行模型是否实现该方法。
 * 冻结架构下 Runtime 仅 harness_runtime_protocol（Hosted in-process）：
 * cancel/resume/steer/user_action/streaming 由 Turn/Invocation 状态机与
 * in-process adapter 吸收（ 保持现有语义）。A2A 是外部 Agent 能力调用
 * 协议，归属 AgentCall 域，不在 Runtime 协议能力范围。
 */
const PROTOCOL_IMPLEMENTATION_SUPPORT: Readonly<Record<string, RuntimeLevelCapabilities>> = {
  harness_runtime_protocol: {
    cancel: true,
    resume: true,
    steer: true,
    user_action: true,
    streaming: true,
  },
};

/** Hosted runtimeCapabilitiesJson 的权威契约是 string[] 能力名列表（hosted gateways）。 */
type HostedCapabilityNames = readonly string[];

/** External RuntimeRevision.runtimeCapabilitiesJson 的三态投影。 */
interface ExternalCapabilitiesProjection {
  measured?: {
    features?: {
      cancel?: string;
      resume?: string;
      steer?: string;
      input_required?: string;
      streaming_transport?: string;
    };
  };
}

function pass(value: string | undefined): boolean {
  return value === "pass";
}

/**
 * Runtime 层 measured 能力。
 * Hosted（string[] 契约）语义由状态机承载：cancel/resume/user_action 恒可用，
 * streaming 取 event_stream 声明；External 只认 measured.features===pass。
 */
export function resolveRuntimeLevelCapabilities(
  runtimeRevision: Pick<RuntimeRevisionRow, "protocolType" | "runtimeCapabilitiesJson">,
): RuntimeLevelCapabilities {
  const protocol = PROTOCOL_IMPLEMENTATION_SUPPORT[runtimeRevision.protocolType] ?? {
    cancel: false,
    resume: false,
    steer: false,
    user_action: false,
    streaming: false,
  };
  const json = runtimeRevision.runtimeCapabilitiesJson as unknown;
  let measured: RuntimeLevelCapabilities;
  if (Array.isArray(json)) {
    measured = {
      cancel: true,
      resume: true,
      steer: true,
      user_action: true,
      streaming: (json as HostedCapabilityNames).includes("event_stream"),
    };
  } else if (
    json !== null &&
    typeof json === "object" &&
    (json as ExternalCapabilitiesProjection).measured?.features !== undefined
  ) {
    const features = (json as ExternalCapabilitiesProjection).measured?.features ?? {};
    measured = {
      cancel: pass(features.cancel),
      resume: pass(features.resume),
      steer: pass(features.steer),
      user_action: pass(features.input_required),
      streaming: pass(features.streaming_transport),
    };
  } else {
    // 形状不可识别 → fail-closed。
    measured = {
      cancel: false,
      resume: false,
      steer: false,
      user_action: false,
      streaming: false,
    };
  }
  return {
    cancel: measured.cancel && protocol.cancel,
    resume: measured.resume && protocol.resume,
    steer: measured.steer && protocol.steer,
    user_action: measured.user_action && protocol.user_action,
    streaming: measured.streaming && protocol.streaming,
  };
}

/** 把已通过 Runtime Protocol schema 的 session 能力快照投影为控制能力。 */
export function resolveSessionRuntimeCapabilities(value: unknown): RuntimeLevelCapabilities {
  if (!isRuntimeCapabilitiesResponse(value)) {
    return NO_CAPABILITIES;
  }
  return {
    cancel: value.features.cancel,
    resume: value.features.resume,
    steer: value.features.steer,
    user_action: value.features.user_action,
    streaming: value.features.event_stream,
  };
}

/** 发布时 measured 能力与 start 响应必须一致；不一致时不能建立会话事实。 */
export function runtimeCapabilitiesMatchPublishedRevision(
  revision: Pick<RuntimeRevisionRow, "protocolType" | "runtimeCapabilitiesJson">,
  observed: RuntimeCapabilitiesResponse,
): boolean {
  // Hosted 的发布事实是旧有 string[] capability catalog，并非完整 probe 快照；
  // 会话能力仍持久化并参与 effective 交集，但不能对不等形状做伪精确比较。
  if (Array.isArray(revision.runtimeCapabilitiesJson)) return true;
  const measuredFeatures = (
    revision.runtimeCapabilitiesJson as ExternalCapabilitiesProjection | null
  )?.measured?.features;
  if (
    !measuredFeatures ||
    !["cancel", "resume", "steer", "input_required", "streaming_transport"].every(
      (name) => typeof measuredFeatures[name as keyof typeof measuredFeatures] === "string",
    )
  ) {
    return false;
  }
  const published = resolveRuntimeLevelCapabilities(revision);
  const session = resolveSessionRuntimeCapabilities(observed);
  return (
    published.cancel === session.cancel &&
    published.resume === session.resume &&
    published.steer === session.steer &&
    published.user_action === session.user_action &&
    published.streaming === session.streaming
  );
}

/**
 * 按精确 Binding 事实派生 Invocation 级 effective 能力。
 *
 * Agent 与 Runtime Authority 分离：ExecutionBinding 只绑定 Harness Runtime，effective capability
 * 退化为 runtime-only（Base Harness 公式：runtime measured AND 协议实现支持）。
 * 事实不可解析（Revision 缺失）→ fail-closed 全 false。
 */
export async function resolveEffectiveInvocationCapabilities(params: {
  tenantId: string;
  binding: EffectiveCapabilityBindingEvidence;
  /** startInvocation 返回并持久化在 RuntimeSessionBinding 的能力快照。 */
  sessionCapabilitiesJson?: unknown;
}): Promise<EffectiveInvocationCapabilities> {
  const runtimeRevision = await getRuntimeRevisionById(params.binding.runtimeRevisionId);
  if (!runtimeRevision) {
    return NO_CAPABILITIES;
  }
  const published = resolveRuntimeLevelCapabilities(runtimeRevision);
  if (params.sessionCapabilitiesJson === undefined) {
    return published;
  }
  const session = resolveSessionRuntimeCapabilities(params.sessionCapabilitiesJson);
  return {
    cancel: published.cancel && session.cancel,
    resume: published.resume && session.resume,
    steer: published.steer && session.steer,
    user_action: published.user_action && session.user_action,
    streaming: published.streaming && session.streaming,
  };
}
