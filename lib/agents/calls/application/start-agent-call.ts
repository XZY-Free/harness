/**
 * startAgentCall — 启动既有 AgentCall 子执行（应用服务，真实 A2A 执行域启动）。
 *
 * 冻结边界：
 * - 只 tenant-scoped 加载 existing AgentCall + exact AgentCallBinding；endpoint / credential /
 *   protocol / contract 全部来自 binding，绝不读取最新 AgentRevision/Route/Contract/Credential。
 * - A2A taskId/contextId 只经 AgentCallEventIngress 写 Attempt / AgentSessionBinding；
 *   绝不触碰 parent Invocation / RuntimeSessionBinding / RuntimeEventIngress。
 * - 原子 current Attempt claim：同 call+同 input 并发只有一个 owner 会 record outbound/发 HTTP；
 *   其它 waiter 返回同一 durable AgentCall。不同 input 在 claim 已存在时稳定冲突。
 * - started 前的 endpoint/auth/503/protocol 错误只结束当前 Attempt，不伪造 queued→failed；
 *   后续由恢复 Worker 判断是否创建新 Attempt。
 * - 不实现 resume/cancel。
 */
import { createHash } from "node:crypto";
import { transitionAgentCall } from "@/lib/agents/calls/application/agent-call-transition";
import { ingestAgentCallEvents } from "@/lib/agents/calls/application/ingest-agent-call-events";
import { type AgentCall, isAgentCallTerminal } from "@/lib/agents/calls/domain/agent-call";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { createA2AAgentTransport } from "@/lib/agents/calls/transport/a2a/a2a-client";
import {
  type AgentBackgroundFailureHandler,
  type AgentCallEventSink,
  type AgentCallTransportAuth,
  AgentTransportError,
} from "@/lib/agents/calls/transport/agent-transport";
import type {
  ContextNecessity,
  InvocationContextContract,
} from "@/lib/agents/domain/public-agent-contract";
import { mysqlAgentContractStore } from "@/lib/agents/persistence/agent-contract-store";
import {
  type PlatformContextEnvironment,
  buildInvocationContextBundle,
} from "@/lib/context/enrichment/build-invocation-context-bundle";
import { externalAgentContextPolicyFilter } from "@/lib/context/enrichment/external-agent-context-policy";
import { resolveOutboundCredential } from "@/lib/identity/resolve-outbound-credential";

/** startAgentCall 冻结 API 入参。 */
export interface StartAgentCallCommand {
  tenantId: string;
  callId: string;
  /** 用户输入文本（非空纯文本；空白/缺失网络前失败）。 */
  input: string;
  /** 平台上下文（tenant 必须等于 call tenant；executionSubject.tenant 也必须等于 call tenant）。 */
  contextEnvironment?: PlatformContextEnvironment;
}

/** startAgentCall 稳定错误基类（message 绝不包含 secret/token）。 */
export class AgentCallStartError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentCallStartError";
  }
}

export class AgentCallNotFoundError extends AgentCallStartError {
  constructor(callId: string, tenantId: string) {
    super("AGENT_CALL_NOT_FOUND", `AgentCall ${callId} 不存在或不属于租户`);
  }
}

export class AgentCallBindingNotFoundError extends AgentCallStartError {
  constructor(callId: string) {
    super("AGENT_CALL_BINDING_NOT_FOUND", `AgentCall ${callId} 无冻结 AgentCallBinding`);
  }
}

export class AgentCallBindingMismatchError extends AgentCallStartError {
  constructor(callId: string) {
    super("AGENT_CALL_BINDING_MISMATCH", `AgentCall ${callId} 的 stable agent 与 binding 不一致`);
  }
}

export class AgentCallUnsupportedProtocolError extends AgentCallStartError {
  constructor(callId: string, protocolType: string, revision: string) {
    super(
      "AGENT_CALL_UNSUPPORTED_PROTOCOL",
      `AgentCall ${callId} 协议不受支持（type=${protocolType} revision=${revision}）`,
    );
  }
}

export class AgentCallContractSnapshotError extends AgentCallStartError {
  constructor(callId: string) {
    super("AGENT_CALL_CONTRACT_SNAPSHOT_MISSING", `AgentCall ${callId} 的 contract snapshot 缺失`);
  }
}

export class AgentCallContractMismatchError extends AgentCallStartError {
  constructor(callId: string) {
    super(
      "AGENT_CALL_CONTRACT_MISMATCH",
      `AgentCall ${callId} 的 contract digest 与 binding 不一致`,
    );
  }
}

export class AgentCallContextEnvironmentError extends AgentCallStartError {
  constructor(callId: string) {
    super("AGENT_CALL_CONTEXT_ENVIRONMENT_MISSING", `AgentCall ${callId} 缺少平台上下文`);
  }
}

export class AgentCallContextTenantError extends AgentCallStartError {
  constructor(callId: string) {
    super("AGENT_CALL_CONTEXT_TENANT_MISMATCH", `AgentCall ${callId} 的上下文租户与 call 不一致`);
  }
}

export class AgentCallInvalidInputError extends AgentCallStartError {
  constructor(callId: string) {
    super("AGENT_CALL_INVALID_INPUT", `AgentCall ${callId} 输入必须是非空纯文本`);
  }
}

export class AgentCallClaimConflictError extends AgentCallStartError {
  constructor(callId: string) {
    super("AGENT_CALL_CLAIM_CONFLICT", `AgentCall ${callId} 已被不同输入认领，拒绝冲突`);
  }
}

/** 规范化排序后 sha256（与 ingress payloadHash 语义一致）。 */
function canonicalSha256(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortKeys(value)))
    .digest("hex")}`;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = sortKeys((value as Record<string, unknown>)[k]);
  }
  return out;
}

/** durable 请求摘要：派生自 call/attempt 身份 + input（非随机），供原子 claim 判等。 */
function computeRequestDigest(callId: string, tenantId: string, input: string): string {
  return canonicalSha256({ callId, tenantId, input: input.trim() });
}

/** 本地 transport failure 仍经唯一转换入口，不伪造成供应方 ingress 事件。 */
async function synthesizeTerminalEvent(
  callId: string,
  tenantId: string,
  type: "call.failed" | "call.lost",
  code: string,
  summary: string,
): Promise<void> {
  await transitionAgentCall({
    tenantId,
    callId,
    input: type,
    authority: "local_failure",
    errorCode: code,
    errorSummary: summary,
  });
}

/** 从 binding 冻结 snapshot 读取调用上下文合同。 */
async function loadContract(
  tenantId: string,
  callId: string,
  binding: {
    agentContractSnapshotId: string;
    agentContractDigest: string;
    agentCapabilityDigest: string;
    agentContextDigest: string;
  },
): Promise<{
  contract: InvocationContextContract;
  snapshot: {
    cancel: boolean;
    resume: boolean;
    streamingTransport: boolean;
    inputRequired: boolean;
  };
}> {
  const snapshot = await mysqlAgentContractStore.transaction((s) =>
    s.findContractSnapshotById(tenantId, binding.agentContractSnapshotId),
  );
  if (!snapshot) throw new AgentCallContractSnapshotError(callId);
  if (
    snapshot.contractDigest !== binding.agentContractDigest ||
    snapshot.capabilityDigest !== binding.agentCapabilityDigest ||
    snapshot.contextDigest !== binding.agentContextDigest
  ) {
    throw new AgentCallContractMismatchError(callId);
  }
  const rows = await mysqlAgentContractStore.transaction((s) =>
    s.listInvocationContexts(tenantId, binding.agentContractSnapshotId),
  );
  const contract: InvocationContextContract = {
    contexts: rows.map((r) => ({
      contextKind: r.key,
      necessity: r.necessity as ContextNecessity,
    })),
  };
  return {
    contract,
    snapshot: {
      cancel: snapshot.cancel,
      resume: snapshot.resume,
      streamingTransport: snapshot.streamingTransport,
      inputRequired: snapshot.inputRequired,
    },
  };
}

/** 启动既有 AgentCall，并回读一次当前持久化 AgentCall；后续进展由正式事件路径推进。 */
export async function startAgentCall(command: StartAgentCallCommand): Promise<AgentCall> {
  const { tenantId, callId } = command;

  // 1. tenant-scoped 加载 existing call + exact binding（绝不读取最新 Revision/Route/Contract）。
  const call = await mysqlAgentCallStore.getById({ callId, tenantId });
  if (!call) throw new AgentCallNotFoundError(callId, tenantId);
  const binding = await mysqlAgentCallStore.getBinding({ callId, tenantId });
  if (!binding) throw new AgentCallBindingNotFoundError(callId);

  // 2. AgentCall 只保留 stable agentId；exact revision 唯一权威在 binding。
  if (call.agentId !== binding.agentId) {
    throw new AgentCallBindingMismatchError(callId);
  }

  // 3. 协议只接受 a2a 且 contract revision 精确支持 0.3.0/a2a-0.3.0；其它网络前拒绝。
  const supportedRevisions = new Set(["0.3.0", "a2a-0.3.0"]);
  if (binding.protocolType !== "a2a" || !supportedRevisions.has(binding.protocolContractRevision)) {
    throw new AgentCallUnsupportedProtocolError(
      callId,
      binding.protocolType,
      binding.protocolContractRevision,
    );
  }

  // 4. 只按 binding.agentContractSnapshotId 读取 header + invocation contexts（exact，不 list latest）。
  const { contract, snapshot: contractSnapshot } = await loadContract(tenantId, callId, {
    agentContractSnapshotId: binding.agentContractSnapshotId,
    agentContractDigest: binding.agentContractDigest,
    agentCapabilityDigest: binding.agentCapabilityDigest,
    agentContextDigest: binding.agentContextDigest,
  });

  // 5. 上下文：trusted environment tenant 必须等于 call tenant；required missing/denied 网络前失败。
  const env = command.contextEnvironment;
  if (!env) throw new AgentCallContextEnvironmentError(callId);
  if (env.tenantId !== tenantId) throw new AgentCallContextTenantError(callId);
  if (env.executionSubject && env.executionSubject.tenantId !== tenantId) {
    throw new AgentCallContextTenantError(callId);
  }
  const bundle = buildInvocationContextBundle({
    contract,
    environment: env,
    policyFilter: externalAgentContextPolicyFilter(),
  });
  const contextMetadata: Record<string, unknown> = {};
  for (const entry of bundle.entries) {
    if (entry.supplied) contextMetadata[entry.contextKind] = entry.value;
  }

  // 6. 输入非空纯文本；空白/缺失网络前失败。
  if (typeof command.input !== "string" || command.input.trim() === "") {
    throw new AgentCallInvalidInputError(callId);
  }

  // 7. 只按 binding 冻结 identityMode + credentialRefId 解析出站凭证（secret 短时内存）。
  const auth: AgentCallTransportAuth = await resolveOutboundCredential({
    tenantId,
    identityMode: binding.identityMode,
    credentialRefId: binding.credentialRefId,
  });

  // 8. durable 请求摘要 + 原子 initial claim。
  const requestDigest = computeRequestDigest(callId, tenantId, command.input);
  const claim = await mysqlAgentCallStore.claimCurrentAttempt({
    callId,
    tenantId,
    requestDigest,
    now: new Date(),
  });
  if (claim.status === "conflict") throw new AgentCallClaimConflictError(callId);
  if (claim.status === "idempotent" || claim.status === "terminal") {
    // 同 call 同 input 的并发 waiter / 已终态：返回既有 durable AgentCall，不重复 outbound。
    return claim.call;
  }

  // 9. owner：构造 transport（eventSink 只走 AgentCallEventIngress；background 只合成子域 lost）。
  const eventSink: AgentCallEventSink = async (batch) => {
    await ingestAgentCallEvents({ tenantId, callId, events: batch.events });
  };
  const onBackgroundFailure: AgentBackgroundFailureHandler = async (report) => {
    // 绝不 mark parent lost；只合成 AgentCall 子域 call.lost，sequence 取 durable max+1。
    await synthesizeTerminalEvent(
      callId,
      tenantId,
      "call.lost",
      `AGENT_STREAM_${report.failureKind.toUpperCase()}`,
      report.safeSummary,
    );
  };
  const capabilities = {
    cancel: contractSnapshot.cancel,
    resume: contractSnapshot.resume,
    steer: false,
    user_action: contractSnapshot.inputRequired && contractSnapshot.resume,
    streaming: contractSnapshot.streamingTransport,
  };
  const transport = createA2AAgentTransport({
    capabilities,
    eventSink,
    onBackgroundFailure,
    streamTimeoutMs: 60_000,
  });

  // 10. startCall：binding endpoint、resolved auth、durable idempotency key、冻结 capabilities。
  try {
    await transport.startCall({
      callId,
      endpoint: binding.endpointRef,
      auth,
      input: command.input,
      contextMetadata,
      existingContextId: null,
      idempotencyKey: `agentcall:${callId}:attempt-1`,
      capabilities,
    });
  } catch (err) {
    // 初始 endpoint/auth/503/protocol 错误：claim 后归一化为子域 call.failed，parent 不变。
    const code =
      err instanceof AgentTransportError
        ? `AGENT_TRANSPORT_${err.kind.toUpperCase()}`
        : "AGENT_CALL_START_FAILED";
    const summary = err instanceof Error ? err.message : "AgentCall 启动失败";
    try {
      await synthesizeTerminalEvent(callId, tenantId, "call.failed", code, summary);
    } catch {
      // 可能已被并发 ingress 推进到其他终态；下方按 durable row 判断。
    }
    const current = await mysqlAgentCallStore.getById({ callId, tenantId });
    if (current && isAgentCallTerminal(current.state)) {
      return current;
    }
    throw err;
  }

  // 11. 只回读一次当前 durable disposition；后台流继续经 eventSink 推进状态。
  const current = await mysqlAgentCallStore.getById({ callId, tenantId });
  if (!current) throw new AgentCallNotFoundError(callId, tenantId);
  return current;
}
