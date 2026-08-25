/**
 * RuntimeTransport Port（04 §2）。
 *
 * Transport 是协议抽象，不是框架抽象：
 * - agent_runtime_protocol → SnowHarness Runtime Protocol（HTTP wire）；
 * - a2a → A2A 0.3.0（JSON-RPC over HTTP + SSE，04 §4）。
 *
 * 不同 Transport 内部可以使用不同 wire protocol，但必须产出同一 SnowHarness
 * 归一化 Runtime Event（经 Transport Mapper → RuntimeEventIngress，04 §6）。
 *
 * 端口形状与 RuntimeHttpClient 五端点一致（probe/start/cancel/resume/steer）；
 * Transport 实现不得暴露 framework 分支或 callCapability 式旁路（04 §10）。
 */

import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";

/** 协议中立的 Runtime Transport 端口。 */
export type RuntimeTransport = RuntimeHttpClient;

/** Transport 错误分类（04 §7：进入 SnowHarness 稳定错误码，不暴露供应商 SDK 异常字符串）。 */
export type RuntimeTransportFailureKind =
  | "endpoint_auth"
  | "protocol_schema"
  | "unsupported_capability"
  | "remote_task_failed"
  | "remote_task_rejected"
  | "stream_interrupted"
  | "cancellation_rejected"
  | "resume_target_not_found"
  | "invalid_correlation";

export class RuntimeTransportError extends Error {
  constructor(
    readonly kind: RuntimeTransportFailureKind,
    message: string,
    readonly detail?: unknown,
  ) {
    super(`RuntimeTransport ${kind}: ${message}`);
    this.name = "RuntimeTransportError";
  }
}

/** Runtime 协议类型（RuntimeRevision.protocolType 权威值）。 */
export const SUPPORTED_RUNTIME_PROTOCOL_TYPES = ["agent_runtime_protocol", "a2a"] as const;

export type SupportedRuntimeProtocolType = (typeof SUPPORTED_RUNTIME_PROTOCOL_TYPES)[number];
