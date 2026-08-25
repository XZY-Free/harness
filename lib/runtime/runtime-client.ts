/**
 * Runtime HTTP 客户端（S05-C02）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md §4（Runtime Protocol API）
 * - docs/architecture/agent-control-plane.md §6（Invocation 生命周期）
 * - docs/architecture/runtime-control-plane.md S05-C02
 *
 * 职责：
 * - 提供调用 Runtime HTTP API 的接口（Runtime 协议 = HTTP+JSON）。
 * - 支持真实 HTTP（createHttpRuntimeClient）与 mock（createMockRuntimeClient）两种实现。
 * - 五个端点：probeCapabilities / startInvocation / cancelInvocation / resumeInvocation / steerInvocation。
 *
 * 安全边界：
 * - 客户端只持有 runtimeEndpoint 和 authToken，不读数据库与平台 Secret。
 * - authToken 是短期 Workload Token（绑定 runtime_revision/invocation/租户），由调度器颁发。
 * - 网络错误统一抛 RuntimeHttpClientError（kind=network），调度器据此判断是否重试。
 *
 * 关键约束：
 * - Runtime 不可达（kind=network）时 Turn 保持 queued，不报错（§7 接纳周期）。
 * - Runtime 409 IDEMPOTENCY_CONFLICT：调用方复用现有 session_binding。
 * - Runtime 503 RUNTIME_UNAVAILABLE：调用方回退，Turn 保持 queued。
 * - 响应体结构非法抛 kind=protocol（不可重试）。
 */

import { IDEMPOTENCY_KEY_HEADER } from "@/lib/http";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import type { ExecutionSubjectWire } from "@/lib/runtime/transport/execution-subject";

// ─── 共享类型 ──────────────────────────────────────────────

/** Runtime Protocol 协商版本（冻结方案 §23：agent-runtime-protocol@2，无 @1 fallback）。 */
export const RUNTIME_PROTOCOL_VERSION = "2" as const;

/** Gateway Access Token（§25 / §27：type=gateway，与 inbound auth token 不混用）。 */
export interface GatewayAccess {
  /** 短期 Gateway Workload Token（HMAC 签名，§26）。 */
  access_token: string;
  /** 过期时间（ISO 8601）。 */
  expires_at: string;
}

/** 下发 Runtime 的 Governance Config 引用（§24：可下发；不含 permission_policy.rules）。 */
export interface GovernanceConfigRef {
  revision_id: string;
  config_digest: string;
  /** Governance config 全量快照（Runtime 按 Snapshot 约束本地行为）。 */
  config: Record<string, unknown>;
}

/** 平台 Gateway 回调端点集合（Runtime 通过这些 URL 调用 Tool Gateway / 上报事件 / 接收控制指令）。 */
export interface GatewayEndpoints {
  events: string;
  cancel: string;
  resume: string;
  steer: string;
  tools: string;
  tool_calls: string;
  user_action_requests: string;
}

/** Runtime 能力探测响应（GET /runtime/v1/capabilities）。 */
export interface RuntimeCapabilitiesResponse {
  /** Runtime 支持的协议版本列表（@2 必须声明 ["2"]，§49）。 */
  protocol_versions: string[];
  /** 能力声明。 */
  features: {
    event_stream: boolean;
    cancel: boolean;
    resume: boolean;
    steer: boolean;
    dynamic_tools: boolean;
    user_action: boolean;
    workspace_types: string[];
    filesystem_checkpoint: boolean;
  };
  /** Runtime 限制。 */
  limits: {
    max_invocation_seconds: number;
    max_event_bytes: number;
  };
}

/** startInvocation 请求体（POST /runtime/v1/invocations）。 */
export interface StartInvocationRequestBody {
  /** 协商的 Runtime Protocol 版本（§23：固定 "2"，无 @1 fallback）。 */
  protocol_version: typeof RUNTIME_PROTOCOL_VERSION;
  invocation_id: string;
  turn_context?: {
    thread_id: string;
    turn_id: string;
    trigger_item_id?: string | null;
  } | null;
  job_context?: {
    job_id: string;
    trigger_item_id?: string | null;
  } | null;
  /**
   * Agent 控制面资产约束；基础 Harness Route 传 null（无 Agent 资产约束，§8.3）。
   * 单个字段为 null 表示该维度无约束。
   */
  agent?: {
    agent_revision_id: string | null;
    instruction_hash: string | null;
    artifact_ref: string | null;
    model_policy: Record<string, unknown> | null;
    permission_requirements: Record<string, unknown> | null;
    interface_requirements: Record<string, unknown> | null;
  } | null;
  input_items: unknown[];
  context_handle: string;
  /** §24：下发 Governance Config 引用（Runtime 按 Snapshot 约束本地行为；不含 permission_policy.rules）。 */
  governance_config: GovernanceConfigRef;
  /** §24/§27：Gateway Access Token（Runtime 调用 Tool Gateway 用，type=gateway）。 */
  gateway_access: GatewayAccess;
  gateway_endpoints: GatewayEndpoints;
  workspace?: {
    workspace_binding_id: string | null;
    workspace_type: string;
  } | null;
  execution_limits: {
    max_invocation_seconds: number;
    max_event_bytes: number;
  };
  trace_context: {
    trace_id: string;
    span_id: string;
  };
  /**
   * ExecutionSubject（06 §6-§7）：可信调用主体，由服务端认证 Principal 生成，
   * 禁止 caller 自报。Agent Runtime Protocol 直接放 dispatch envelope；
   * A2A Transport 映射为 namespaced metadata（snowharness.execution_subject）。
   */
  execution_subject?: ExecutionSubjectWire;
  attempt?: {
    attempt_no: number;
    /** 重调度时平台分配的 Attempt id（关联 InvocationAttempt 行）。 */
    attempt_id?: string;
    /** 重调度原因码（如 infra_error / runtime_lost / requires_redispatch）。 */
    retry_reason?: string;
    /** 重调度检查点引用（必须避开已确认副作用，事实源 L755）。 */
    checkpoint_ref?: string;
    /** 重调度时 Runtime 的 producer_sequence 起点（整个 Invocation 内连续，事实源 L500）。 */
    producer_sequence_start?: number;
  } | null;
}

/** startInvocation 响应体。 */
export interface StartInvocationResponse {
  invocation_id: string;
  accepted: boolean;
  attempt_no: number;
  runtime_session_ref: string;
  runtime_execution_ref: string;
  capabilities: RuntimeCapabilitiesResponse;
}

/** startInvocation 请求参数。 */
export interface StartInvocationRequest {
  runtimeEndpoint: string;
  authToken: string;
  idempotencyKey: string;
  requestBody: StartInvocationRequestBody;
}

/** cancelInvocation 请求体。 */
export interface CancelInvocationRequestBody {
  reason: string;
  trace_context?: { trace_id: string; span_id: string } | null;
}

/** cancelInvocation 响应体。 */
export interface CancelInvocationResponse {
  invocation_id: string;
  cancelled: boolean;
  attempt_no: number;
}

/** cancelInvocation 请求参数。 */
export interface CancelInvocationRequest {
  runtimeEndpoint: string;
  authToken: string;
  invocationId: string;
  idempotencyKey: string;
  requestBody: CancelInvocationRequestBody;
}

/** resumeInvocation 请求体。 */
export interface ResumeInvocationRequestBody {
  resume_payload: unknown;
  trace_context?: { trace_id: string; span_id: string } | null;
  /** §28：员工 resolve 后 resume 必须重新签发新 Gateway Access Token。 */
  gateway_access: GatewayAccess;
}

/** resumeInvocation 响应体。 */
export interface ResumeInvocationResponse {
  invocation_id: string;
  resumed: boolean;
  attempt_no: number;
  /**
   * Runtime 要求平台为同一 Invocation 创建新 Attempt 重调度（事实源 L924-928）。
   *
   * - true：Runtime 内存状态已丢失，平台必须创建新 Attempt + 新 EnvironmentLease，
   * 从安全 Checkpoint 重调度；不能新建 continuation Invocation，不能更换 ExecutionBinding。
   * - false / undefined：Resume 成功，平台按原流程写 turn.resumed + invocation.resumed Events。
   */
  requires_redispatch?: boolean;
}

/** resumeInvocation 请求参数。 */
export interface ResumeInvocationRequest {
  runtimeEndpoint: string;
  authToken: string;
  invocationId: string;
  idempotencyKey: string;
  requestBody: ResumeInvocationRequestBody;
}

/** steerInvocation 请求体。 */
export interface SteerInvocationRequestBody {
  steer_payload: unknown;
  trace_context?: { trace_id: string; span_id: string } | null;
}

/** steerInvocation 响应体。 */
export interface SteerInvocationResponse {
  invocation_id: string;
  steered: boolean;
  attempt_no: number;
}

/** steerInvocation 请求参数。 */
export interface SteerInvocationRequest {
  runtimeEndpoint: string;
  authToken: string;
  invocationId: string;
  idempotencyKey: string;
  requestBody: SteerInvocationRequestBody;
}

// ─── 接口 ─────────────────────────────────────────────────

/** Runtime HTTP 客户端接口。 */
export interface RuntimeHttpClient {
  probeCapabilities(endpoint: string, token: string): Promise<RuntimeCapabilitiesResponse>;
  startInvocation(req: StartInvocationRequest): Promise<StartInvocationResponse>;
  cancelInvocation(req: CancelInvocationRequest): Promise<CancelInvocationResponse>;
  resumeInvocation(req: ResumeInvocationRequest): Promise<ResumeInvocationResponse>;
  steerInvocation(req: SteerInvocationRequest): Promise<SteerInvocationResponse>;
}

// ─── 真实 HTTP 实现 ───────────────────────────────────────

/** 默认请求超时（10s）。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 创建真实 HTTP Runtime 客户端（生产用）。
 *
 * 用全局 fetch；超时由 AbortController 控制。
 * 网络错误（fetch 抛错）统一包装为 RuntimeHttpClientError(kind=network)。
 */
export function createHttpRuntimeClient(options?: {
  timeoutMs?: number;
}): RuntimeHttpClient {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function doFetch(
    url: string,
    init: RequestInit & { headers: Record<string, string> },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      // fetch 抛 TypeError 视为网络错误（DNS / 连接拒绝 / 超时）
      throw new RuntimeHttpClientError(
        "network",
        `Runtime 网络不可达：${url} — ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 读取非 2xx 响应错误体，构造 RuntimeHttpClientError(kind=http)。 */
  async function throwHttpError(resp: Response): Promise<never> {
    let runtimeErrorCode: string | undefined;
    let message = `Runtime HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: { code?: string; message?: string } };
      runtimeErrorCode = body?.error?.code;
      if (body?.error?.message) {
        message = body.error.message;
      }
    } catch {
      // 响应体非 JSON 或为空，使用默认 message
    }
    throw new RuntimeHttpClientError("http", message, resp.status, runtimeErrorCode);
  }

  return {
    async probeCapabilities(endpoint: string, token: string): Promise<RuntimeCapabilitiesResponse> {
      const url = `${endpoint}/runtime/v1/capabilities?protocol_version=${RUNTIME_PROTOCOL_VERSION}`;
      const resp = await doFetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      if (!resp.ok) {
        await throwHttpError(resp);
      }
      const body = (await resp.json()) as RuntimeCapabilitiesResponse;
      if (!body || !Array.isArray(body.protocol_versions) || typeof body.features !== "object") {
        throw new RuntimeHttpClientError(
          "protocol",
          "Runtime 能力响应结构非法：缺少 protocol_versions 或 features",
        );
      }
      return body;
    },

    async startInvocation(req: StartInvocationRequest): Promise<StartInvocationResponse> {
      const url = `${req.runtimeEndpoint}/runtime/v1/invocations`;
      const resp = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${req.authToken}`,
          [IDEMPOTENCY_KEY_HEADER]: req.idempotencyKey,
        },
        body: JSON.stringify(req.requestBody),
      });
      if (!resp.ok) {
        await throwHttpError(resp);
      }
      const body = (await resp.json()) as StartInvocationResponse;
      if (!body || typeof body.invocation_id !== "string" || typeof body.accepted !== "boolean") {
        throw new RuntimeHttpClientError(
          "protocol",
          "Runtime startInvocation 响应结构非法：缺少 invocation_id 或 accepted",
        );
      }
      return body;
    },

    async cancelInvocation(req: CancelInvocationRequest): Promise<CancelInvocationResponse> {
      const url = `${req.runtimeEndpoint}/runtime/v1/invocations/${req.invocationId}/cancel`;
      const resp = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${req.authToken}`,
          [IDEMPOTENCY_KEY_HEADER]: req.idempotencyKey,
        },
        body: JSON.stringify(req.requestBody),
      });
      if (!resp.ok) {
        await throwHttpError(resp);
      }
      const body = (await resp.json()) as CancelInvocationResponse;
      if (!body || typeof body.invocation_id !== "string") {
        throw new RuntimeHttpClientError("protocol", "Runtime cancelInvocation 响应结构非法");
      }
      return body;
    },

    async resumeInvocation(req: ResumeInvocationRequest): Promise<ResumeInvocationResponse> {
      const url = `${req.runtimeEndpoint}/runtime/v1/invocations/${req.invocationId}/resume`;
      const resp = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${req.authToken}`,
          [IDEMPOTENCY_KEY_HEADER]: req.idempotencyKey,
        },
        body: JSON.stringify(req.requestBody),
      });
      if (!resp.ok) {
        await throwHttpError(resp);
      }
      const body = (await resp.json()) as ResumeInvocationResponse;
      if (!body || typeof body.invocation_id !== "string") {
        throw new RuntimeHttpClientError("protocol", "Runtime resumeInvocation 响应结构非法");
      }
      return body;
    },

    async steerInvocation(req: SteerInvocationRequest): Promise<SteerInvocationResponse> {
      const url = `${req.runtimeEndpoint}/runtime/v1/invocations/${req.invocationId}/steer`;
      const resp = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${req.authToken}`,
          [IDEMPOTENCY_KEY_HEADER]: req.idempotencyKey,
        },
        body: JSON.stringify(req.requestBody),
      });
      if (!resp.ok) {
        await throwHttpError(resp);
      }
      const body = (await resp.json()) as SteerInvocationResponse;
      if (!body || typeof body.invocation_id !== "string") {
        throw new RuntimeHttpClientError("protocol", "Runtime steerInvocation 响应结构非法");
      }
      return body;
    },
  };
}

// ─── Mock 实现 ────────────────────────────────────────────

/** Mock 客户端的处理器集合（每个端点可独立 mock）。 */
export interface MockRuntimeClientHandlers {
  probeCapabilities?: (endpoint: string, token: string) => Promise<RuntimeCapabilitiesResponse>;
  startInvocation?: (req: StartInvocationRequest) => Promise<StartInvocationResponse>;
  cancelInvocation?: (req: CancelInvocationRequest) => Promise<CancelInvocationResponse>;
  resumeInvocation?: (req: ResumeInvocationRequest) => Promise<ResumeInvocationResponse>;
  steerInvocation?: (req: SteerInvocationRequest) => Promise<SteerInvocationResponse>;
}

/**
 * 创建 mock Runtime 客户端（测试用）。
 *
 * 未提供 handler 的端点抛 RuntimeHttpClientError(kind=protocol, "未实现")。
 * 调用记录存入 calls 数组，便于测试断言。
 */
export function createMockRuntimeClient(handlers: MockRuntimeClientHandlers): RuntimeHttpClient & {
  /** 累积调用记录，供测试断言。 */
  calls: {
    probeCapabilities: Array<{ endpoint: string; token: string }>;
    startInvocation: StartInvocationRequest[];
    cancelInvocation: CancelInvocationRequest[];
    resumeInvocation: ResumeInvocationRequest[];
    steerInvocation: SteerInvocationRequest[];
  };
} {
  const calls = {
    probeCapabilities: [] as Array<{ endpoint: string; token: string }>,
    startInvocation: [] as StartInvocationRequest[],
    cancelInvocation: [] as CancelInvocationRequest[],
    resumeInvocation: [] as ResumeInvocationRequest[],
    steerInvocation: [] as SteerInvocationRequest[],
  };

  return {
    calls,

    async probeCapabilities(endpoint: string, token: string): Promise<RuntimeCapabilitiesResponse> {
      calls.probeCapabilities.push({ endpoint, token });
      if (!handlers.probeCapabilities) {
        throw new RuntimeHttpClientError("protocol", "mock probeCapabilities 未实现");
      }
      return handlers.probeCapabilities(endpoint, token);
    },

    async startInvocation(req: StartInvocationRequest): Promise<StartInvocationResponse> {
      calls.startInvocation.push(req);
      if (!handlers.startInvocation) {
        throw new RuntimeHttpClientError("protocol", "mock startInvocation 未实现");
      }
      return handlers.startInvocation(req);
    },

    async cancelInvocation(req: CancelInvocationRequest): Promise<CancelInvocationResponse> {
      calls.cancelInvocation.push(req);
      if (!handlers.cancelInvocation) {
        throw new RuntimeHttpClientError("protocol", "mock cancelInvocation 未实现");
      }
      return handlers.cancelInvocation(req);
    },

    async resumeInvocation(req: ResumeInvocationRequest): Promise<ResumeInvocationResponse> {
      calls.resumeInvocation.push(req);
      if (!handlers.resumeInvocation) {
        throw new RuntimeHttpClientError("protocol", "mock resumeInvocation 未实现");
      }
      return handlers.resumeInvocation(req);
    },

    async steerInvocation(req: SteerInvocationRequest): Promise<SteerInvocationResponse> {
      calls.steerInvocation.push(req);
      if (!handlers.steerInvocation) {
        throw new RuntimeHttpClientError("protocol", "mock steerInvocation 未实现");
      }
      return handlers.steerInvocation(req);
    },
  };
}

/**
 * 构造默认能力响应（供 mock 与参考 Runtime 路由复用）。
 *
 * 事实源：11-api-and-event-boundaries.md §4 必需能力集。
 */
export function defaultRuntimeCapabilities(): RuntimeCapabilitiesResponse {
  return {
    protocol_versions: ["2"],
    features: {
      event_stream: true,
      cancel: true,
      resume: true,
      steer: true,
      dynamic_tools: false,
      user_action: true,
      workspace_types: ["local"],
      filesystem_checkpoint: true,
    },
    limits: {
      max_invocation_seconds: 600,
      max_event_bytes: 1_048_576,
    },
  };
}
