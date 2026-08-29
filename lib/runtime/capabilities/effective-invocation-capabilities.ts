/**
 * EffectiveInvocationCapabilities（05 §2/§3/§4）。
 *
 * 只读派生服务，不是新 Authority：全部输入来自已冻结事实
 * （ExecutionBinding 的 runtimeRevisionId），禁止查"当前最新 Agent/Runtime"。
 *
 * 专题01 冻结架构：ExecutionBinding 只绑定 Harness Runtime，不再有 Agent Contract
 * 证据，effective capability 退化为 runtime-only——
 * ```text
 * Base Harness: runtime.measured.cancel AND 协议实现支持（保持 Hosted 现有语义）
 * ```
 *
 * 事实源：docs/V12/01/SnowHarness_阶段1_代码收口详细方案_2026-08-26/05-Cancel能力贯通.md。
 */
import type { RuntimeRevisionRow } from "@/lib/runtime/persistence/runtime-revision-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";

/** Invocation 级 effective 能力（至少统一表达 05 §2 五项）。 */
export interface EffectiveInvocationCapabilities {
  readonly cancel: boolean;
  readonly resume: boolean;
  readonly steer: boolean;
  readonly user_action: boolean;
  readonly streaming: boolean;
}

/** ExecutionBinding 冻结证据（05 §3 精确公式输入；专题01 冻结架构：runtime-only）。 */
export interface EffectiveCapabilityBindingEvidence {
  readonly runtimeRevisionId: string;
}

/** Runtime 层（无 Agent Contract）能力：measured AND 协议实现（05 §4 Base Harness）。 */
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
 * 协议实现能力（05 §3 第三因子）：Transport/执行模型是否实现该方法。
 * 冻结架构下 Runtime 仅 harness_runtime_protocol（Hosted in-process）：
 * cancel/resume/steer/user_action/streaming 由 Turn/Invocation 状态机与
 * in-process adapter 吸收（05 §4 保持现有语义）。A2A 是外部 Agent 能力调用
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

/** External RuntimeRevision.runtimeCapabilitiesJson 的三态投影（02 §10）。 */
interface ExternalCapabilitiesProjection {
  measured?: {
    features?: {
      cancel?: string;
      resume?: string;
      input_required?: string;
      streaming_transport?: string;
    };
  };
}

function pass(value: string | undefined): boolean {
  return value === "pass";
}

/**
 * Runtime 层 measured 能力（05 §4）。
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
      steer: false,
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

/**
 * 按精确 Binding 事实派生 Invocation 级 effective 能力（05 §3）。
 *
 * 专题01 冻结架构：ExecutionBinding 只绑定 Harness Runtime，effective capability
 * 退化为 runtime-only（Base Harness 公式：runtime measured AND 协议实现支持）。
 * 事实不可解析（Revision 缺失）→ fail-closed 全 false。
 */
export async function resolveEffectiveInvocationCapabilities(params: {
  tenantId: string;
  binding: EffectiveCapabilityBindingEvidence;
}): Promise<EffectiveInvocationCapabilities> {
  const runtimeRevision = await getRuntimeRevisionById(params.binding.runtimeRevisionId);
  if (!runtimeRevision) {
    return NO_CAPABILITIES;
  }
  return resolveRuntimeLevelCapabilities(runtimeRevision);
}
