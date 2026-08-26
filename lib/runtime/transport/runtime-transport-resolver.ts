/**
 * RuntimeTransport Resolver（04 §3）。
 *
 * protocolType 真正决定 Transport：
 * - agent_runtime_protocol → SnowHarness Runtime Protocol（Hosted/HTTP wire）；
 * - a2a → A2A 0.3.0 Transport。
 *
 * Resolver 输入只来自：
 * - ExecutionBinding；
 * - RuntimeRevision protocol facts（protocolType/endpointRef）；
 * - managed endpoint/identity configuration（endpoint/token）。
 *
 * 禁止输入 framework name、Agent displayName、project path、业务判断（04 §3）。
 * 未知 protocolType → fail-closed（UnsupportedRuntimeProtocolError），无回退。
 */
import type { RuntimeTransportAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import type { RuntimeTransport } from "@/lib/runtime/transport/runtime-transport";

/** protocolType 未注册（fail-closed，不回退到任何默认 Transport）。 */
export class UnsupportedRuntimeProtocolError extends Error {
  constructor(readonly protocolType: string) {
    super(`不支持的 Runtime protocolType：${protocolType}`);
    this.name = "UnsupportedRuntimeProtocolError";
  }
}

/** 单个 protocolType 的 Transport 工厂（闭包内绑定该协议所需装配，如 sink/modelFn）。 */
export type RuntimeTransportFactory = (input: {
  /** managed endpoint configuration（external endpoint URL 或 in-process 引用）。 */
  endpoint: string;
  /**
   * managed identity configuration（03 §8 协议中立）：
   * Hosted = 短期 Workload Token；External = 唯一 resolver 解析的外部凭据。
   */
  auth: RuntimeTransportAuth;
}) => RuntimeTransport;

export type RuntimeTransportFactories = Partial<Record<string, RuntimeTransportFactory>>;

export interface CreateRuntimeTransportResolverParams {
  /** 已注册的 protocolType → Transport 工厂。 */
  factories: RuntimeTransportFactories;
}

export interface ResolveRuntimeTransportInput {
  /** RuntimeRevision.protocolType（权威值）。 */
  protocolType: string;
  /** managed endpoint configuration（external endpoint URL 或 in-process 引用）。 */
  endpoint: string;
  /**
   * managed identity configuration（03 §8 协议中立）：
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
 * Resolver 不含任何 framework/业务分支：只按 protocolType 查工厂表；
 * 未知 protocolType 抛 UnsupportedRuntimeProtocolError（04 §10：Hosted 路径无行为回退）。
 */
export function createRuntimeTransportResolver(
  params: CreateRuntimeTransportResolverParams,
): RuntimeTransportResolver {
  return async (input) => {
    const factory = params.factories[input.protocolType];
    if (!factory) {
      throw new UnsupportedRuntimeProtocolError(input.protocolType);
    }
    return factory({ endpoint: input.endpoint, auth: input.auth });
  };
}
