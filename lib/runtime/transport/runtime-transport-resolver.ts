import type { RuntimeEvidenceKind } from "@/lib/persistence/schema/runtimes";
/**
 * RuntimeTransport Resolver。
 *
 * protocolType + runtimeEvidenceKind 共同决定 Transport：
 * - harness_runtime_protocol + hosted_artifact → Hosted local transport。
 * - harness_runtime_protocol + external_endpoint → External HTTP transport。
 *
 * Resolver 输入只来自：
 * - ExecutionBinding；
 * - RuntimeRevision protocol facts（protocolType/endpointRef）；
 * - managed endpoint/identity configuration（endpoint/token）。
 *
 * 禁止输入 framework name、Agent displayName、project path、业务判断。
 * 未知 protocolType → fail-closed（UnsupportedRuntimeProtocolError），无回退。
 */
import type { RuntimeTransportAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import type { RuntimeTransport } from "@/lib/runtime/transport/runtime-transport";

/** protocolType 未注册（fail-closed，不回退到任何默认 Transport）。 */
export class UnsupportedRuntimeProtocolError extends Error {
  constructor(
    readonly protocolType: string,
    readonly runtimeEvidenceKind?: string,
  ) {
    super(
      runtimeEvidenceKind
        ? `不支持的 Runtime transport 组合：${protocolType} + ${runtimeEvidenceKind}`
        : `不支持的 Runtime protocolType：${protocolType}`,
    );
    this.name = "UnsupportedRuntimeProtocolError";
  }
}

/** 单个 protocolType 的 Transport 工厂（闭包内绑定该协议所需事件与 Harness 模型端口）。 */
export type RuntimeTransportFactory = (input: {
  /** managed endpoint configuration（external endpoint URL 或 in-process 引用）。 */
  endpoint: string;
  /**
   * managed identity configuration（ 协议中立）：
   * Hosted = 短期 Workload Token；External = 唯一 resolver 解析的外部凭据。
   */
  auth: RuntimeTransportAuth;
}) => RuntimeTransport;

export type RuntimeTransportFactories = Partial<
  Record<string, Partial<Record<RuntimeEvidenceKind, RuntimeTransportFactory>>>
>;

export interface CreateRuntimeTransportResolverParams {
  /** 已注册的 protocolType → Transport 工厂。 */
  factories: RuntimeTransportFactories;
}

export interface ResolveRuntimeTransportInput {
  /** RuntimeRevision.protocolType（权威值）。 */
  protocolType: string;
  /** RuntimeRevision.runtimeEvidenceKind（权威值，不从 endpoint 形状推断）。 */
  runtimeEvidenceKind: RuntimeEvidenceKind;
  /** managed endpoint configuration（external endpoint URL 或 in-process 引用）。 */
  endpoint: string;
  /**
   * managed identity configuration（ 协议中立）：
   * Hosted = 短期 Workload Token；External = 唯一 resolver 解析的外部凭据。
   */
  auth: RuntimeTransportAuth;
}

export type RuntimeTransportResolver = (
  input: ResolveRuntimeTransportInput,
) => Promise<RuntimeTransport>;

/**
 * 创建 RuntimeTransport Resolver。
 *
 * Resolver 不含任何 framework/业务分支：只按 protocolType + runtimeEvidenceKind 查工厂表；
 * 未知组合抛 UnsupportedRuntimeProtocolError，不做 Hosted fallback。
 */
export function createRuntimeTransportResolver(
  params: CreateRuntimeTransportResolverParams,
): RuntimeTransportResolver {
  return async (input) => {
    const factory = params.factories[input.protocolType]?.[input.runtimeEvidenceKind];
    if (!factory) {
      throw new UnsupportedRuntimeProtocolError(input.protocolType, input.runtimeEvidenceKind);
    }
    return factory({ endpoint: input.endpoint, auth: input.auth });
  };
}
