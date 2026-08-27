/**
 * Capability-driven 黑盒 Runtime 注册验收（权威应用服务，02 专项）。
 *
 * 冻结不变量（Runtime Registration 权威切片）：
 * - 协议/交互事实只来自已导入的结构化 AgentContractSnapshot（同租户、同 Agent）；
 *   快照 interaction 六布尔决定本次需要验证哪些 capability（declared ≠ measured）。
 *   远端 AgentCard 身份/skills/extensions 只是一致性证据，绝不覆盖导入事实。
 * - probe presence 严格匹配快照：basic 永远必填；input_required/resume/cancel 仅在
 *   快照声明对应能力时必填，否则必须缺席（多余/缺失一律 400，网络前）。
 * - SnowHarness 主动对黑盒 Runtime 发起真实 HTTP/SSE 一致性调用（全局 fetch，有限超时）：
 *   GET /.well-known/agent-card.json → basic probe（按 streamingTransport 分
 *   message/send / message/stream）→ 按声明依次 input_required / resume / cancel probe。
 *   incremental_content=true 必须真实观测至少一条内容/artifact 增量（状态 update 不算）。
 *   cancel=false 绝不调用 tasks/cancel；不发送内部 invocation/trace/tenant 键
 *   （probe 携带平台系统验收身份的公共 Context metadata，00 §5）。
 * - durableTaskRecovery 阶段 1 不冒充验证：measured=not_measured、effective=false。
 * - 一切校验失败（schema/引用/凭证/presence）发生在任何网络调用之前；网络验收失败
 *   fail closed，不产生任何 Runtime/RuntimeRevision 行。
 * - 持久化只在验收成功后：单事务 create/reuse 恰一个 external Runtime + draft
 *   RuntimeRevision（绑定快照/凭证引用/endpoint/协议事实/measured 证据 digest，
 *   capabilities 区分 declared/measured/effective）。不发布、不启用、不建路由；
 *   不落原始合同/AgentCard/prompts/transcript/secret。
 * - 01 专项：平台 signer 在任何 Provider 网络请求前解析（不可信即 fail closed，
 *   零网络零行）；Probe 区间时间冻结进 Builder；Revision ID 预生成并同时绑定
 *   RuntimeRevision insert 与 buildActiveExternalConformance 报告；正式
 *   RuntimeConformanceRun/Cases/Audit/Outbox/Delivery 经 prepare（事务外验签）+
 *   append（调用方事务）与 RuntimeRevision 原子落库。Conformance idempotency
 *   由注册幂等键确定性派生；actor 为平台系统身份，非外部 Agent 自证。
 */
import { randomUUID } from "node:crypto";
import { mysqlAgentContractStore } from "@/lib/agents/persistence/agent-contract-store";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import type { AgentContractSnapshot } from "@/lib/persistence/schema/agents";
import {
  type RuntimeRevisionRow,
  type RuntimeRow,
  runtimeRevisionTable,
  runtimeTable,
} from "@/lib/persistence/schema/runtimes";
import { buildActiveExternalConformanceReport } from "@/lib/runtime/application/build-active-external-conformance";
import {
  ActiveExternalConformanceSignerError,
  resolveActiveExternalConformanceSigner,
} from "@/lib/runtime/application/resolve-active-external-conformance-signer";
import { createConfiguredRuntimeConformanceVerifier } from "@/lib/runtime/conformance/configured-runtime-conformance-verifier";
import {
  OutboundRuntimeAuthError,
  type RuntimeTransportAuth,
  outboundAuthHeaders,
  resolveOutboundRuntimeAuth,
} from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { computeRuntimeTargetDigest } from "@/lib/runtime/domain/runtime-target-digest";
import { createMysqlRuntimeConformanceRunSession } from "@/lib/runtime/persistence/mysql-runtime-conformance-run-store";
import type {
  RuntimeConformanceCaseResultRecord,
  RuntimeConformanceRunRecord,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import {
  appendRuntimeConformanceRun,
  prepareRuntimeConformanceRun,
} from "@/lib/runtime/provisioning/record-runtime-conformance-run";
import { buildA2APublicMessageMetadata } from "@/lib/runtime/transport/a2a-transport";
import {
  executionSubjectFromServiceIdentity,
  executionSubjectToPublicAgentSubject,
} from "@/lib/runtime/transport/execution-subject";
import { and, eq, max } from "drizzle-orm";

/** 注册失败类别（路由据此映射稳定错误响应）。 */
export type AgentRuntimeRegistrationErrorKind =
  | "reference_invalid" // 快照/Agent/凭证/presence 引用非法（400，网络前）
  | "endpoint_invalid" // endpoint 结构非法（400，网络前）
  | "credential_unresolvable" // 凭证引用存在但不可解析/指纹不符（400，网络前）
  | "signer_untrusted" // 平台 active-external signer 缺失/不可信（422，网络前 fail closed）
  | "runtime_conflict" // 稳定 Runtime 身份存在但形态/生命周期冲突（422，拒绝复用）
  | "conformance_failed"; // 主动网络验收失败（422，fail closed）

export class AgentRuntimeRegistrationError extends Error {
  constructor(
    public readonly kind: AgentRuntimeRegistrationErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AgentRuntimeRegistrationError";
  }
}

/** 已结构校验的注册命令（endpoint 规范化/引用/网络/持久化由本服务负责）。 */
export interface AgentRuntimeRegistrationCommand {
  tenantId: string;
  agentId: string;
  contractSnapshotId: string;
  runtimeEndpoint: string;
  authentication: { mode: "none" | "bearer"; credentialRefId: string | null };
  /** capability-driven probe 输入：basic 永远必填，其余按快照声明 presence 匹配。 */
  conformance: {
    basic: { input: string };
    input_required?: { input: string };
    resume?: { startInput: string; resumeInput: string };
    cancel?: { input: string };
  };
  /** 创建者 userIdentityId 或 serviceId。 */
  createdBy: string;
  /** HTTP 注册幂等键（Conformance idempotency 由其确定性派生）。 */
  idempotencyKey: string;
  /** 本次注册请求 ID（进入 Conformance Run 审计链）。 */
  requestId: string;
}

/** 结构化 measured 证据矩阵（02 §9；替换 HR 命名固定四 boolean）。 */
export interface RuntimeMeasuredEvidence {
  agent_card: {
    protocol_version: "pass";
    transport: "pass";
    streaming_consistency: "pass";
  };
  basic_invocation: { status: "pass" };
  features: {
    streaming_transport: "pass" | "not_applicable";
    incremental_content: "pass" | "not_applicable";
    input_required: "pass" | "not_applicable";
    resume: "pass" | "not_applicable";
    cancel: "pass" | "not_applicable";
    durable_task_recovery: "not_measured";
  };
}

/** 持久化的 RuntimeCapabilitiesJson：declared / measured / effective 三态严格分离（02 §10）。 */
export interface RuntimeCapabilitiesProjection {
  declared: {
    streaming_transport: boolean;
    incremental_content: boolean;
    input_required: boolean;
    resume: boolean;
    cancel: boolean;
    durable_task_recovery: boolean;
  };
  measured: RuntimeMeasuredEvidence;
  effective: {
    streaming_transport: boolean;
    incremental_content: boolean;
    input_required: boolean;
    resume: boolean;
    cancel: boolean;
    durable_task_recovery: boolean;
  };
}

/** 单次网络验收的超时上限（有限，禁止无限等待）。 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 规范化 endpoint：仅允许绝对 http/https、无 userinfo/query/fragment；仅剥离尾斜杠。 */
export function normalizeRuntimeEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AgentRuntimeRegistrationError("endpoint_invalid", "runtime_endpoint 必须是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AgentRuntimeRegistrationError(
      "endpoint_invalid",
      "runtime_endpoint 必须是 http/https",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new AgentRuntimeRegistrationError(
      "endpoint_invalid",
      "runtime_endpoint 不允许携带 userinfo",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new AgentRuntimeRegistrationError(
      "endpoint_invalid",
      "runtime_endpoint 不允许携带 query 或 fragment",
    );
  }
  let normalized = `${url.protocol}//${url.host}${url.pathname}`;
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// ─── 凭证解析（03 §7：唯一共享 resolver，禁止本地重复实现）────

interface ResolvedCredential {
  identityMode: "none" | "bearer";
  credentialRefId: string | null;
  auth: RuntimeTransportAuth;
}

/**
 * 解析 outbound auth：tenantId + identityMode + credentialRefId → RuntimeTransportAuth。
 * 逐项验证（同租户/active/未过期/provider=env/env 存在/指纹一致）全部在共享
 * resolver 内完成；失败在网络前 fail closed，不回显 token。
 */
async function resolveCredential(
  tenantId: string,
  authentication: AgentRuntimeRegistrationCommand["authentication"],
): Promise<ResolvedCredential> {
  try {
    const auth = await resolveOutboundRuntimeAuth({
      tenantId,
      identityMode: authentication.mode,
      credentialRefId: authentication.mode === "none" ? null : authentication.credentialRefId,
    });
    return {
      identityMode: authentication.mode,
      credentialRefId: authentication.credentialRefId ?? null,
      auth,
    };
  } catch (err) {
    if (err instanceof OutboundRuntimeAuthError) {
      throw new AgentRuntimeRegistrationError("credential_unresolvable", err.message);
    }
    throw err;
  }
}

function authHeaders(credential: ResolvedCredential): Record<string, string> {
  // Registration 是 External 调用：workload_token 在共享 resolver 内 fail closed。
  return outboundAuthHeaders(credential.auth);
}

// ─── 主动一致性验收（真实 HTTP/SSE，全局 fetch）────────────

/** AgentCard 协议证据校验（绝不采纳远端身份/skills/extensions 为注册事实）。 */
async function probeAgentCardConsistency(
  endpoint: string,
  credential: ResolvedCredential,
  snapshot: AgentContractSnapshot,
): Promise<void> {
  const response = await fetch(`${endpoint}/.well-known/agent-card.json`, {
    method: "GET",
    headers: { accept: "application/json", ...authHeaders(credential) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new AgentRuntimeRegistrationError("conformance_failed", "AgentCard 不可达");
  });
  if (!response.ok) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "AgentCard 路径不可用");
  }
  const card = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "AgentCard 非法");
  }
  if (card.protocolVersion !== snapshot.protocolContractRevision) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "AgentCard 协议版本与快照不一致");
  }
  const transport = card.preferredTransport;
  if (typeof transport !== "string" || transport.trim().toUpperCase() !== "JSONRPC") {
    // 仅接受 JSONRPC transport（大小写不敏感精确匹配），其他非空 transport 一律拒绝。
    throw new AgentRuntimeRegistrationError(
      "conformance_failed",
      "AgentCard transport 必须是 JSONRPC",
    );
  }
  const capabilities = card.capabilities;
  const streaming =
    capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
      ? (capabilities as Record<string, unknown>).streaming
      : undefined;
  if (streaming !== snapshot.streamingTransport) {
    throw new AgentRuntimeRegistrationError(
      "conformance_failed",
      "AgentCard streaming 与快照不一致",
    );
  }
}

// ─── A2A wire 基础（Message 官方形态 + correlation 归一化）──

/** A2A 官方 Task/status-update 两种形态统一取 correlation。 */
interface Correlation {
  taskId: string;
  contextId: string;
}

function correlationOf(result: Record<string, unknown>): Correlation | null {
  const taskIdRaw =
    result.kind === "task" && typeof result.id === "string" ? result.id : result.taskId;
  const taskId = typeof taskIdRaw === "string" ? taskIdRaw.trim() : "";
  const contextId = typeof result.contextId === "string" ? result.contextId.trim() : "";
  if (!taskId || !contextId) return null;
  return { taskId, contextId };
}

/** A2A 官方 Task / status-update 两种形态统一取 state。 */
function resultState(result: Record<string, unknown>): string | null {
  const status = result.status;
  if (status && typeof status === "object" && !Array.isArray(status)) {
    const state = (status as Record<string, unknown>).state;
    if (typeof state === "string") return state;
  }
  if (typeof result.state === "string") return result.state;
  return null;
}

/** 真实内容/artifact 增量：artifact-update 且 artifact.parts 非空（状态 update 不算，02 §4）。 */
function isContentIncrement(result: Record<string, unknown>): boolean {
  if (result.kind !== "artifact-update") return false;
  const artifact = result.artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
  const parts = (artifact as Record<string, unknown>).parts;
  return Array.isArray(parts) && parts.length > 0;
}

/**
 * 官方 Message wire：kind=message + 每次新 messageId；不携带内部 invocation/trace 键。
 *
 * probe 携带平台系统验收身份的公共 Context metadata（execution_subject=
 * platform_service + fresh current_datetime + 合同首个 supported locale）：
 * 真实 Provider 按公共合同从当前 message.metadata 提取执行上下文（00 §5），
 * 匿名 probe 会落入 Provider 的匿名分支使验收结果不可靠。经唯一公共 mapper
 * 构造，键为公共合同 context_kind，绝不出现内部 ID/trace/tenant。
 */
function buildA2AMessage(
  input: string,
  correlation?: Correlation,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    kind: "message",
    messageId: randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: input }],
  };
  if (correlation) {
    message.taskId = correlation.taskId;
    message.contextId = correlation.contextId;
  }
  if (metadata && Object.keys(metadata).length > 0) {
    message.metadata = metadata;
  }
  return message;
}

/** message/send：非流式调用（basic/input-required/resume 等按快照 transport 分派）。 */
async function sendMessage(
  endpoint: string,
  credential: ResolvedCredential,
  input: string,
  correlation?: Correlation,
  metadata?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...authHeaders(credential),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/send",
      params: { message: buildA2AMessage(input, correlation) },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new AgentRuntimeRegistrationError("conformance_failed", "Runtime 不可达");
  });
  if (!response.ok) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "message/send 被拒绝");
  }
  const payload = (await response.json().catch(() => null)) as {
    result?: Record<string, unknown>;
  } | null;
  const result = payload?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "message/send 响应非法");
  }
  return result;
}

/** message/stream：流式调用，返回全部已解析事件并登记内容增量。 */
async function streamMessage(
  endpoint: string,
  credential: ResolvedCredential,
  input: string,
  correlation: Correlation | undefined,
  increments: { observed: boolean },
  metadata?: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...authHeaders(credential),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/stream",
      params: { message: buildA2AMessage(input, correlation) },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new AgentRuntimeRegistrationError("conformance_failed", "Runtime 不可达");
  });
  if (!response.ok) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "message/stream 被拒绝");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "message/stream 未返回事件流");
  }
  const events = await readSseResults(response);
  if (events.some(isContentIncrement)) {
    increments.observed = true;
  }
  return events;
}

/**
 * message/stream（cancel 起始）：增量解析到第一个带 correlation 的事件即中止读取，
 * 供 tasks/cancel 使用（long-running 流不等待终态）。
 */
async function streamUntilCorrelation(
  endpoint: string,
  credential: ResolvedCredential,
  input: string,
): Promise<Correlation> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...authHeaders(credential),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/stream",
      params: { message: buildA2AMessage(input) },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new AgentRuntimeRegistrationError("conformance_failed", "Runtime 不可达");
  });
  if (!response.ok) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "message/stream 被拒绝");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "message/stream 未返回事件流");
  }
  if (!response.body) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "message/stream 无响应体");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const results: Array<Record<string, unknown>> = [];
  const consumeFrame = (frame: string) => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as { result?: unknown };
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.result &&
        typeof parsed.result === "object" &&
        !Array.isArray(parsed.result)
      ) {
        results.push(parsed.result as Record<string, unknown>);
      }
    } catch {
      // 非 JSON 帧（comment/keep-alive）忽略——验收以状态事件为准。
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match || match.index === undefined) break;
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          consumeFrame(frame);
        }
        const correlated = results.map(correlationOf).find((c) => c !== null);
        if (correlated) {
          // 拿到 correlation 即可发起 tasks/cancel，主动中止长驻流。
          await reader.cancel().catch(() => undefined);
          return correlated;
        }
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new AgentRuntimeRegistrationError("conformance_failed", "cancel 起始流缺少 correlation");
}

// ─── Capability-driven probes（02 §3/§5/§6/§7）─────────────

/** Basic probe：按 streamingTransport 分 message/send / message/stream（02 §3）。 */
async function probeBasic(
  endpoint: string,
  credential: ResolvedCredential,
  input: string,
  streamingTransport: boolean,
  increments: { observed: boolean },
  metadata: () => Record<string, unknown>,
): Promise<void> {
  if (!streamingTransport) {
    const result = await sendMessage(endpoint, credential, input, undefined, metadata());
    if (!correlationOf(result)) {
      throw new AgentRuntimeRegistrationError(
        "conformance_failed",
        "basic probe 缺少有效 correlation",
      );
    }
    return;
  }
  const events = await streamMessage(
    endpoint,
    credential,
    input,
    undefined,
    increments,
    metadata(),
  );
  if (events.length === 0) {
    throw new AgentRuntimeRegistrationError(
      "conformance_failed",
      "message/stream 未解析到任何事件",
    );
  }
  if (!events.some((r) => correlationOf(r) !== null)) {
    throw new AgentRuntimeRegistrationError(
      "conformance_failed",
      "basic probe 缺少有效 correlation",
    );
  }
}

/** Input-required probe：必须观测 input-required + taskId + contextId（02 §5）。 */
async function probeInputRequired(
  endpoint: string,
  credential: ResolvedCredential,
  input: string,
  streamingTransport: boolean,
  increments: { observed: boolean },
  metadata: () => Record<string, unknown>,
): Promise<void> {
  const requireEvidence = (result: Record<string, unknown>) => {
    if (resultState(result) !== "input-required" || !correlationOf(result)) {
      throw new AgentRuntimeRegistrationError(
        "conformance_failed",
        "未观测到 input-required（或缺少 correlation）",
      );
    }
  };
  if (!streamingTransport) {
    const result = await sendMessage(endpoint, credential, input, undefined, metadata());
    requireEvidence(result);
    return;
  }
  const events = await streamMessage(
    endpoint,
    credential,
    input,
    undefined,
    increments,
    metadata(),
  );
  const hit = events.find((r) => resultState(r) === "input-required");
  if (!hit || !correlationOf(hit)) {
    throw new AgentRuntimeRegistrationError(
      "conformance_failed",
      "未观测到 input-required（或缺少 correlation）",
    );
  }
}

/** Resume probe：专用 start_input/resume_input 同 correlation 至 completed（02 §6）。 */
async function probeResume(
  endpoint: string,
  credential: ResolvedCredential,
  startInput: string,
  resumeInput: string,
  streamingTransport: boolean,
  increments: { observed: boolean },
  metadata: () => Record<string, unknown>,
): Promise<void> {
  let start: Correlation;
  if (streamingTransport) {
    const events = await streamMessage(
      endpoint,
      credential,
      startInput,
      undefined,
      increments,
      metadata(),
    );
    const correlated = events.map(correlationOf).find((c) => c !== null);
    if (!correlated) {
      throw new AgentRuntimeRegistrationError("conformance_failed", "resume 起始缺少 correlation");
    }
    start = correlated;
  } else {
    const result = await sendMessage(endpoint, credential, startInput, undefined, metadata());
    const correlated = correlationOf(result);
    if (!correlated) {
      throw new AgentRuntimeRegistrationError("conformance_failed", "resume 起始缺少 correlation");
    }
    start = correlated;
  }
  const result = await sendMessage(endpoint, credential, resumeInput, start, metadata());
  const responded = correlationOf(result);
  if (!responded || responded.taskId !== start.taskId || responded.contextId !== start.contextId) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "resume correlation 发生变化");
  }
  if (resultState(result) !== "completed") {
    throw new AgentRuntimeRegistrationError("conformance_failed", "resume 未完成");
  }
}

/** Cancel probe：start long-running task → tasks/cancel → 同 correlation canceled（02 §7）。 */
async function probeCancel(
  endpoint: string,
  credential: ResolvedCredential,
  input: string,
  streamingTransport: boolean,
): Promise<void> {
  let start: Correlation;
  if (streamingTransport) {
    start = await streamUntilCorrelation(endpoint, credential, input);
  } else {
    const result = await sendMessage(endpoint, credential, input);
    const correlated = correlationOf(result);
    if (!correlated) {
      throw new AgentRuntimeRegistrationError("conformance_failed", "cancel 起始缺少 correlation");
    }
    start = correlated;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...authHeaders(credential),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tasks/cancel",
      params: { taskId: start.taskId },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new AgentRuntimeRegistrationError("conformance_failed", "Runtime 不可达");
  });
  if (!response.ok) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "tasks/cancel 被拒绝");
  }
  const payload = (await response.json().catch(() => null)) as {
    result?: Record<string, unknown>;
  } | null;
  const result = payload?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "tasks/cancel 响应非法");
  }
  const taskIdRaw =
    result.kind === "task" && typeof result.id === "string" ? result.id : result.taskId;
  if (taskIdRaw !== start.taskId) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "cancel correlation 发生变化");
  }
  if (resultState(result) !== "canceled") {
    throw new AgentRuntimeRegistrationError("conformance_failed", "未观察到取消终态");
  }
}

/** SSE 事件 result 集合（跨 chunk 健壮解析 data: 帧）。 */
async function readSseResults(response: Response): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  if (!response.body) {
    return results;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeFrame = (frame: string) => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as { result?: unknown };
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.result &&
        typeof parsed.result === "object" &&
        !Array.isArray(parsed.result)
      ) {
        results.push(parsed.result as Record<string, unknown>);
      }
    } catch {
      // 非 JSON 帧（comment/keep-alive）忽略——验收以状态事件为准。
    }
  };
  const drainBuffer = () => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match || match.index === undefined) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      consumeFrame(frame);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      drainBuffer();
    }
    if (done) break;
  }
  buffer += decoder.decode();
  drainBuffer();
  if (buffer.trim().length > 0) {
    consumeFrame(buffer);
  }
  return results;
}

// ─── 持久化（单事务，仅验收成功后）────────────────────────

export interface AgentRuntimeRegistrationResult {
  runtime: RuntimeRow;
  revision: RuntimeRevisionRow;
  snapshot: AgentContractSnapshot;
  runtimeEndpoint: string;
  /** 结构化 measured 证据矩阵（02 §9）。 */
  measured: RuntimeMeasuredEvidence;
  /** declared/measured/effective 三态投影（02 §10）。 */
  capabilities: RuntimeCapabilitiesProjection;
  /** 与 RuntimeRevision 同事务落库的正式 Conformance Run（01 专项）。 */
  conformanceRun: RuntimeConformanceRunRecord;
  conformanceCaseResults: RuntimeConformanceCaseResultRecord[];
}

// ─── 仅供测试：事务内 Conformance append 之后注入失败（验证整体回滚）──
let runtimeRegistrationPostAppendHook: (() => void | Promise<void>) | null = null;

/** 注入/清除事务内 append 后失败钩子（生产恒为 null，禁止业务代码调用）。 */
export function __setRuntimeRegistrationPostAppendHookForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  runtimeRegistrationPostAppendHook = hook;
}

/**
 * 执行 capability-driven 黑盒注册验收：presence/引用校验（网络前）→ 真实 HTTP/SSE
 * 一致性调用 → 单事务持久化。任何失败抛 AgentRuntimeRegistrationError，且不产生
 * Runtime/RuntimeRevision 行。
 */
export async function registerAgentRuntime(
  command: AgentRuntimeRegistrationCommand,
): Promise<AgentRuntimeRegistrationResult> {
  // 1) 引用 + probe presence 校验（网络前，fail-closed）
  const agent = await getAgentById(command.tenantId, command.agentId);
  if (!agent) {
    throw new AgentRuntimeRegistrationError("reference_invalid", "Agent 不存在或无权访问");
  }
  const snapshot = await mysqlAgentContractStore.transaction((session) =>
    session.findContractSnapshotById(command.tenantId, command.contractSnapshotId),
  );
  if (!snapshot) {
    throw new AgentRuntimeRegistrationError("reference_invalid", "合同快照不存在");
  }
  if (snapshot.agentId !== command.agentId) {
    throw new AgentRuntimeRegistrationError("reference_invalid", "合同快照不属于该 Agent");
  }
  // 02 §2 Presence 规则：probe 输入严格匹配快照声明（多余/缺失一律网络前拒绝）。
  if (snapshot.inputRequired !== (command.conformance.input_required !== undefined)) {
    throw new AgentRuntimeRegistrationError(
      "reference_invalid",
      snapshot.inputRequired
        ? "快照声明 input_required，conformance.input_required 必填"
        : "快照未声明 input_required，conformance.input_required 必须缺席",
    );
  }
  if (snapshot.resume !== (command.conformance.resume !== undefined)) {
    throw new AgentRuntimeRegistrationError(
      "reference_invalid",
      snapshot.resume
        ? "快照声明 resume，conformance.resume 必填"
        : "快照未声明 resume，conformance.resume 必须缺席",
    );
  }
  if (snapshot.cancel !== (command.conformance.cancel !== undefined)) {
    throw new AgentRuntimeRegistrationError(
      "reference_invalid",
      snapshot.cancel
        ? "快照声明 cancel，conformance.cancel 必填"
        : "快照未声明 cancel，conformance.cancel 必须缺席",
    );
  }
  // 防御历史快照：incremental_content 依赖流式传输（登记解析器已强制，02 §4）。
  if (snapshot.incrementalContent && !snapshot.streamingTransport) {
    throw new AgentRuntimeRegistrationError(
      "reference_invalid",
      "快照 incremental_content=true 但 streaming_transport=false（非法合同组合）",
    );
  }
  const endpoint = normalizeRuntimeEndpoint(command.runtimeEndpoint);
  const credential = await resolveCredential(command.tenantId, command.authentication);

  // 1.5) 平台 active-external signer 必须在任何 Provider 网络请求之前解析成功
  //（01 专项 §3：无可信 signer 则即使 Probe 通过也无法产生正式发布证据 → fail closed，
  //  Provider 请求次数 = 0）。
  let signer: ReturnType<typeof resolveActiveExternalConformanceSigner>;
  try {
    signer = resolveActiveExternalConformanceSigner(command.tenantId);
  } catch (err) {
    if (err instanceof ActiveExternalConformanceSignerError) {
      throw new AgentRuntimeRegistrationError("signer_untrusted", err.message);
    }
    throw err;
  }

  // 2) AgentCard 协议证据 + capability-driven probes（顺序执行，一次网络序列）。
  // probe 携带平台系统验收身份的公共 Context metadata（每次调用刷新 current_datetime）；
  // 真实 Provider 按公共合同从当前 message.metadata 提取执行上下文（00 §5）。
  const probeMetadata = (): Record<string, unknown> =>
    buildA2APublicMessageMetadata([
      {
        context_kind: "execution_subject",
        value: executionSubjectToPublicAgentSubject(
          executionSubjectFromServiceIdentity(command.tenantId, signer.runnerIdentity),
        ),
      },
      { context_kind: "current_datetime", value: new Date().toISOString() },
      ...(Array.isArray(snapshot.supportedLocales) && snapshot.supportedLocales.length > 0
        ? [{ context_kind: "locale", value: snapshot.supportedLocales[0] as string }]
        : []),
    ]);
  const probeStartedAt = new Date();
  await probeAgentCardConsistency(endpoint, credential, snapshot);
  const increments = { observed: false };
  await probeBasic(
    endpoint,
    credential,
    command.conformance.basic.input,
    snapshot.streamingTransport,
    increments,
    probeMetadata,
  );
  if (command.conformance.input_required) {
    await probeInputRequired(
      endpoint,
      credential,
      command.conformance.input_required.input,
      snapshot.streamingTransport,
      increments,
      probeMetadata,
    );
  }
  if (command.conformance.resume) {
    await probeResume(
      endpoint,
      credential,
      command.conformance.resume.startInput,
      command.conformance.resume.resumeInput,
      snapshot.streamingTransport,
      increments,
      probeMetadata,
    );
  }
  if (command.conformance.cancel) {
    await probeCancel(
      endpoint,
      credential,
      command.conformance.cancel.input,
      snapshot.streamingTransport,
    );
  }
  // 02 §4：incremental_content=true 必须真实观测至少一条内容/artifact 增量。
  if (snapshot.incrementalContent && !increments.observed) {
    throw new AgentRuntimeRegistrationError(
      "conformance_failed",
      "incremental_content=true 但未观测到内容增量",
    );
  }
  // 01 专项 §4：Probe 时间事实只来自真实网络区间（首条 AgentCard 请求前 →
  // 全部声明能力验证完成），禁止模块加载/服务启动/写库后反推时间。
  const probeCompletedAt = new Date();

  // 3) 结构化 measured 证据（02 §9）与 declared/measured/effective 投影（02 §10）。
  const measured: RuntimeMeasuredEvidence = {
    agent_card: {
      protocol_version: "pass",
      transport: "pass",
      streaming_consistency: "pass",
    },
    basic_invocation: { status: "pass" },
    features: {
      streaming_transport: snapshot.streamingTransport ? "pass" : "not_applicable",
      incremental_content: snapshot.incrementalContent ? "pass" : "not_applicable",
      input_required: snapshot.inputRequired ? "pass" : "not_applicable",
      resume: snapshot.resume ? "pass" : "not_applicable",
      cancel: snapshot.cancel ? "pass" : "not_applicable",
      // 02 §8：阶段 1 不冒充 durable recovery 验证。
      durable_task_recovery: "not_measured",
    },
  };
  const capabilities: RuntimeCapabilitiesProjection = {
    declared: {
      streaming_transport: snapshot.streamingTransport,
      incremental_content: snapshot.incrementalContent,
      input_required: snapshot.inputRequired,
      resume: snapshot.resume,
      cancel: snapshot.cancel,
      durable_task_recovery: snapshot.durableTaskRecovery,
    },
    measured,
    // effective = declared=true AND measured=pass（durable 未测恒 false，02 §8/§10）。
    effective: {
      streaming_transport: snapshot.streamingTransport,
      incremental_content: snapshot.incrementalContent,
      input_required: snapshot.inputRequired,
      resume: snapshot.resume,
      cancel: snapshot.cancel,
      durable_task_recovery: false,
    },
  };

  // 4) 正式 Conformance 事实（01 专项）：Digest Authority 不变，Revision ID 预冻结。
  const configHash = computeCanonicalDigest({
    agent_contract_snapshot_id: snapshot.id,
    credential_ref_id: credential.credentialRefId,
    runtime_endpoint: endpoint,
    protocol_type: snapshot.protocolType,
    protocol_contract_revision: snapshot.protocolContractRevision,
    identity_mode: credential.identityMode,
  });
  const runtimeTargetDigest = computeRuntimeTargetDigest({
    runtimeEvidenceKind: "external_endpoint",
    endpointRef: endpoint,
    runtimeConfigDigest: configHash,
    protocolType: snapshot.protocolType,
    protocolContractRevision: snapshot.protocolContractRevision,
    identityMode: credential.identityMode,
    networkZone: "external",
  });
  // 证据摘要对结构化 measured facts 计算，不保存 raw transcript（02 §9）。
  const evidenceDigest = computeCanonicalDigest({
    agent_contract_snapshot_id: snapshot.id,
    runtime_endpoint: endpoint,
    runtime_target_digest: runtimeTargetDigest,
    measured,
  });
  // 同一 Revision ID 同时用于 Builder 报告、insert 与 Conformance 绑定（01 §5）。
  const runtimeRevisionId = randomUUID();

  // 构建 DSSE 签名正式报告（复用权威 Builder，禁止第二份 digest 计算）。
  const built = buildActiveExternalConformanceReport({
    runtimeRevisionId,
    runtimeTargetDigest,
    runtimeConfigDigest: configHash,
    protocolContractRevision: snapshot.protocolContractRevision,
    startedAt: probeStartedAt.toISOString(),
    completedAt: probeCompletedAt.toISOString(),
    measured,
    capabilities,
    signer,
  });
  if (built.report.overallResult !== "passed") {
    // 诚实一致性裁决失败（如声明 durable 未测）：fail closed，零行落库。
    throw new AgentRuntimeRegistrationError(
      "conformance_failed",
      "正式 Conformance 裁决未通过，注册被拒绝",
    );
  }

  // prepare：DSSE 验签 + 报告校验（事务外，零 DB 写）。
  // Conformance idempotency 从注册幂等键确定性派生（禁止随机 key）；这是 SnowHarness
  // 主动验收，actor 固定为平台系统身份（signer.runnerIdentity），非外部 Agent 自证。
  const conformanceCommand = {
    tenantId: command.tenantId,
    runtimeRevisionId,
    dsseEnvelope: built.dsseEnvelopeJson,
    idempotencyKey: `runtime-registration-conformance:${command.idempotencyKey}`,
    requestId: command.requestId,
    actor: { actorType: "system" as const, actorId: signer.runnerIdentity },
  };
  const prepared = await prepareRuntimeConformanceRun({
    verifier: createConfiguredRuntimeConformanceVerifier(),
    command: conformanceCommand,
  });

  // 5) 单事务持久化：Runtime + draft RuntimeRevision + ConformanceRun/Cases/
  //    Audit/Outbox/Delivery 原子绑定（任何失败全部回滚）。
  const runtimeKey = `agent-${command.agentId}`;
  const persisted = await db.transaction(async (tx) => {
    const [existingRuntime] = await tx
      .select()
      .from(runtimeTable)
      .where(
        and(eq(runtimeTable.tenantId, command.tenantId), eq(runtimeTable.runtimeKey, runtimeKey)),
      )
      .limit(1);
    let runtime = existingRuntime;
    if (runtime) {
      // 复用守卫：稳定 Runtime 身份必须仍是本 Agent 的 external 运行入口；
      // 已删除/hosted/retired 等冲突形态一律拒绝复用（不扩展到发布/激活语义）。
      if (runtime.deletedAt !== null) {
        throw new AgentRuntimeRegistrationError("runtime_conflict", "稳定 Runtime 身份已删除");
      }
      if (runtime.runtimeKind !== "external") {
        throw new AgentRuntimeRegistrationError("runtime_conflict", "稳定 Runtime 身份非 external");
      }
      if (runtime.lifecycleState === "retired") {
        throw new AgentRuntimeRegistrationError("runtime_conflict", "稳定 Runtime 身份已退役");
      }
    }
    if (!runtime) {
      const runtimeId = randomUUID();
      await tx.insert(runtimeTable).values({
        id: runtimeId,
        tenantId: command.tenantId,
        runtimeKey,
        displayName: `${agent.displayName} Runtime`,
        runtimeKind: "external",
        ownerUserId: command.createdBy,
        lifecycleState: "draft",
      });
      const [created] = await tx
        .select()
        .from(runtimeTable)
        .where(eq(runtimeTable.id, runtimeId))
        .limit(1);
      runtime = created;
    }
    if (!runtime) {
      throw new AgentRuntimeRegistrationError("reference_invalid", "Runtime 身份创建失败");
    }

    const [maxRow] = await tx
      .select({ maxRevisionNo: max(runtimeRevisionTable.revisionNo) })
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.runtimeId, runtime.id));
    const revisionNo = (maxRow?.maxRevisionNo ?? 0) + 1;

    await tx.insert(runtimeRevisionTable).values({
      id: runtimeRevisionId,
      runtimeId: runtime.id,
      revisionNo,
      protocolType: snapshot.protocolType,
      protocolContractRevision: snapshot.protocolContractRevision,
      runtimeEvidenceKind: "external_endpoint",
      runtimeTargetDigest,
      endpointRef: endpoint,
      runtimeArtifactRef: null,
      runtimeCapabilitiesJson: capabilities,
      identityMode: credential.identityMode,
      networkZone: "external",
      configHash,
      agentContractSnapshotId: snapshot.id,
      credentialRefId: credential.credentialRefId,
      verificationState: "verified",
      evidenceDigest,
      // 01 §11：verifiedAt 唯一由真实 Probe 完成时间决定，禁止第二条时间事实。
      verifiedAt: probeCompletedAt,
      revisionState: "draft",
      createdBy: command.createdBy,
    });
    const [revision] = await tx
      .select()
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.id, runtimeRevisionId))
      .limit(1);
    if (!revision) {
      throw new AgentRuntimeRegistrationError("reference_invalid", "RuntimeRevision 落库失败");
    }
    if (!revision.verifiedAt) {
      // fail loudly：verified Revision 必须携带精确的持久化验收时间，禁止伪造回退值。
      throw new Error("registerAgentRuntime: verified Revision 缺少 verifiedAt（读回失败）");
    }

    // Conformance append 与 Revision 同事务（01 §10，禁止第二事务/补偿删除）。
    const session = createMysqlRuntimeConformanceRunSession(tx);
    const appended = await appendRuntimeConformanceRun({
      session,
      prepared,
      command: conformanceCommand,
    });
    if (runtimeRegistrationPostAppendHook) {
      await runtimeRegistrationPostAppendHook();
    }
    return { runtime, revision, appended };
  });

  return {
    runtime: persisted.runtime,
    revision: persisted.revision,
    snapshot,
    runtimeEndpoint: endpoint,
    measured,
    capabilities,
    conformanceRun: persisted.appended.run,
    conformanceCaseResults: persisted.appended.caseResults,
  };
}
