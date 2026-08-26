/**
 * 主动黑盒 Runtime 注册验收（权威应用服务）。
 *
 * 冻结不变量（Runtime Registration 权威切片）：
 * - 协议/交互事实只来自已导入的结构化 AgentContractSnapshot（同租户、同 Agent）；
 *   远端 AgentCard 身份/skills/extensions 只是一致性证据，绝不覆盖导入事实。
 * - SnowHarness 主动对黑盒 Runtime 发起真实 HTTP/SSE 一致性调用（全局 fetch，有限超时）：
 *   GET /.well-known/agent-card.json（协议版本/JSONRPC transport/streaming 与快照一致）
 *   → message/stream(start_input) 观测 input-required（非空 taskId/contextId）
 *   → message/send(resume_input) 同 taskId/contextId 观测 completed。
 *   快照 cancel=false 绝不调用 tasks/cancel；不发送内部 invocation/trace/主体字段。
 * - 一切校验失败（schema/引用/凭证）发生在任何网络调用之前；网络验收失败 fail closed，
 *   不产生任何 Runtime/RuntimeRevision 行。
 * - 持久化只在验收成功后：单事务 create/reuse 恰一个 external Runtime + draft
 *   RuntimeRevision（绑定快照/凭证引用/endpoint/协议事实/measured 证据 digest）。
 *   不发布、不启用、不建路由；不落原始合同/AgentCard/prompts/transcript/secret。
 */
import { createHash, randomUUID } from "node:crypto";
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
import { credentialRefTable } from "@/lib/persistence/schema/tool";
import { computeRuntimeTargetDigest } from "@/lib/runtime/domain/runtime-target-digest";
import { and, eq, max } from "drizzle-orm";

/** 注册失败类别（路由据此映射稳定错误响应）。 */
export type AgentRuntimeRegistrationErrorKind =
  | "reference_invalid" // 快照/Agent/凭证引用非法（400，网络前）
  | "endpoint_invalid" // endpoint 结构非法（400，网络前）
  | "credential_unresolvable" // 凭证引用存在但不可解析/指纹不符（400，网络前）
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
  conformance: { startInput: string; resumeInput: string };
  /** 创建者 userIdentityId 或 serviceId。 */
  createdBy: string;
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

// ─── 凭证解析（只解析被引用的 CredentialRef）──────────────

interface ResolvedCredential {
  identityMode: "none" | "bearer";
  credentialRefId: string | null;
  authorizationHeader: string | null;
}

/** 解析凭证引用：本切片仅支持 provider=env（vaultRef 为 env 变量名，指纹必须精确匹配）。 */
async function resolveCredential(
  tenantId: string,
  authentication: AgentRuntimeRegistrationCommand["authentication"],
): Promise<ResolvedCredential> {
  if (authentication.mode === "none") {
    return { identityMode: "none", credentialRefId: null, authorizationHeader: null };
  }
  const credentialRefId = authentication.credentialRefId;
  if (!credentialRefId) {
    throw new AgentRuntimeRegistrationError("credential_unresolvable", "缺少 credential_ref_id");
  }
  const [ref] = await db
    .select()
    .from(credentialRefTable)
    .where(
      and(eq(credentialRefTable.tenantId, tenantId), eq(credentialRefTable.id, credentialRefId)),
    )
    .limit(1);
  if (!ref) {
    throw new AgentRuntimeRegistrationError("credential_unresolvable", "credential_ref 不存在");
  }
  if (ref.lifecycleState !== "active") {
    throw new AgentRuntimeRegistrationError("credential_unresolvable", "credential_ref 非 active");
  }
  if (ref.provider !== "env") {
    throw new AgentRuntimeRegistrationError(
      "credential_unresolvable",
      "本切片仅支持 provider=env 的凭证引用",
    );
  }
  // vaultRef 是 env 变量名：只加载该字段，不落库/不回显/不写日志。
  const token = process.env[ref.vaultRef];
  if (typeof token !== "string" || token.length === 0) {
    throw new AgentRuntimeRegistrationError("credential_unresolvable", "凭证引用不可解析");
  }
  const fingerprint = `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
  if (fingerprint !== ref.fingerprint) {
    throw new AgentRuntimeRegistrationError("credential_unresolvable", "凭证指纹不匹配");
  }
  return {
    identityMode: "bearer",
    credentialRefId: ref.id,
    authorizationHeader: `Bearer ${token}`,
  };
}

function authHeaders(credential: ResolvedCredential): Record<string, string> {
  return credential.authorizationHeader ? { authorization: credential.authorizationHeader } : {};
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

interface StreamProbeResult {
  taskId: string;
  contextId: string;
}

/** message/stream：观测 input-required 与非空 taskId/contextId（真实 SSE，跨 chunk 解析）。 */
async function probeMessageStream(
  endpoint: string,
  credential: ResolvedCredential,
  startInput: string,
): Promise<StreamProbeResult> {
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
      params: {
        // A2A 0.3 官方 Message wire：kind=message + 每次新 messageId；不携带内部
        // invocation/trace/protocol 键（metadata 保持缺席）。
        message: {
          kind: "message",
          messageId: randomUUID(),
          role: "user",
          parts: [{ kind: "text", text: startInput }],
        },
      },
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
  for (const result of events) {
    if (resultState(result) === "input-required") {
      const taskId = typeof result.taskId === "string" ? result.taskId.trim() : "";
      const contextId = typeof result.contextId === "string" ? result.contextId.trim() : "";
      if (!taskId || !contextId) {
        throw new AgentRuntimeRegistrationError(
          "conformance_failed",
          "input-required 缺少 correlation",
        );
      }
      return { taskId, contextId };
    }
  }
  throw new AgentRuntimeRegistrationError("conformance_failed", "未观测到 input-required");
}

/** message/send：同 taskId/contextId resume 并要求 completed（官方 Task/status-update 均可）。 */
async function probeResumeCompletion(
  endpoint: string,
  credential: ResolvedCredential,
  resumeInput: string,
  correlation: StreamProbeResult,
): Promise<void> {
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
      params: {
        // A2A 0.3 官方 Message wire：kind=message + 每次新 messageId；同 taskId/contextId。
        message: {
          kind: "message",
          messageId: randomUUID(),
          role: "user",
          parts: [{ kind: "text", text: resumeInput }],
          taskId: correlation.taskId,
          contextId: correlation.contextId,
        },
      },
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
  if (!result) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "message/send 响应非法");
  }
  // 官方两种响应形态归一化取 correlation：Task={id, contextId}；
  // status-update={taskId, contextId}。要求与原 correlation 精确一致。
  const respondedTaskId =
    result.kind === "task" && typeof result.id === "string" ? result.id : result.taskId;
  if (respondedTaskId !== correlation.taskId || result.contextId !== correlation.contextId) {
    throw new AgentRuntimeRegistrationError("conformance_failed", "resume correlation 发生变化");
  }
  if (resultState(result) !== "completed") {
    throw new AgentRuntimeRegistrationError("conformance_failed", "resume 未完成");
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

// ─── 持久化（单事务，仅验收成功后）────────────────────────

export interface AgentRuntimeRegistrationResult {
  runtime: RuntimeRow;
  revision: RuntimeRevisionRow;
  snapshot: AgentContractSnapshot;
  runtimeEndpoint: string;
  evidence: {
    agentCardProtocolVersionMatch: boolean;
    eventStreamObserved: boolean;
    inputRequiredObserved: boolean;
    resumeCompleted: boolean;
  };
}

/**
 * 执行主动黑盒注册验收：引用校验（网络前）→ 真实 HTTP/SSE 一致性调用 → 单事务持久化。
 * 任何失败抛 AgentRuntimeRegistrationError，且不产生 Runtime/RuntimeRevision 行。
 */
export async function registerAgentRuntime(
  command: AgentRuntimeRegistrationCommand,
): Promise<AgentRuntimeRegistrationResult> {
  // 1) 引用校验（网络前，fail-closed）
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
  // 本冻结流只支持 input_required + resume 的 HR 形交互；其余组合 fail closed。
  if (!snapshot.inputRequired || !snapshot.resume) {
    throw new AgentRuntimeRegistrationError(
      "reference_invalid",
      "该合同快照的交互形态不适用本注册验收流",
    );
  }
  const endpoint = normalizeRuntimeEndpoint(command.runtimeEndpoint);
  const credential = await resolveCredential(command.tenantId, command.authentication);

  // 2) AgentCard 协议证据 + 3) 主动一致性验收（顺序执行，一次网络序列）
  await probeAgentCardConsistency(endpoint, credential, snapshot);
  const stream = await probeMessageStream(endpoint, credential, command.conformance.startInput);
  await probeResumeCompletion(endpoint, credential, command.conformance.resumeInput, stream);

  const evidence = {
    agentCardProtocolVersionMatch: true,
    eventStreamObserved: true,
    inputRequiredObserved: true,
    resumeCompleted: true,
  };

  // 4) 单事务持久化（create/reuse 恰一个 external Runtime + draft Revision）
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
    const evidenceDigest = computeCanonicalDigest({
      agent_contract_snapshot_id: snapshot.id,
      runtime_endpoint: endpoint,
      runtime_target_digest: runtimeTargetDigest,
      agent_card_protocol_version_match: evidence.agentCardProtocolVersionMatch,
      event_stream_observed: evidence.eventStreamObserved,
      input_required_observed: evidence.inputRequiredObserved,
      resume_completed: evidence.resumeCompleted,
    });
    const runtimeCapabilitiesJson = {
      conformance: {
        agent_card_protocol_version_match: evidence.agentCardProtocolVersionMatch,
        event_stream_observed: evidence.eventStreamObserved,
        input_required_observed: evidence.inputRequiredObserved,
        resume_completed: evidence.resumeCompleted,
      },
      interaction: {
        streaming_transport: snapshot.streamingTransport,
        incremental_content: snapshot.incrementalContent,
        input_required: snapshot.inputRequired,
        resume: snapshot.resume,
        cancel: snapshot.cancel,
        durable_task_recovery: snapshot.durableTaskRecovery,
      },
    };

    const revisionId = randomUUID();
    await tx.insert(runtimeRevisionTable).values({
      id: revisionId,
      runtimeId: runtime.id,
      revisionNo,
      protocolType: snapshot.protocolType,
      protocolContractRevision: snapshot.protocolContractRevision,
      runtimeEvidenceKind: "external_endpoint",
      runtimeTargetDigest,
      endpointRef: endpoint,
      runtimeArtifactRef: null,
      runtimeCapabilitiesJson,
      identityMode: credential.identityMode,
      networkZone: "external",
      configHash,
      agentContractSnapshotId: snapshot.id,
      credentialRefId: credential.credentialRefId,
      verificationState: "verified",
      evidenceDigest,
      verifiedAt: new Date(),
      revisionState: "draft",
      createdBy: command.createdBy,
    });
    const [revision] = await tx
      .select()
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.id, revisionId))
      .limit(1);
    if (!revision) {
      throw new AgentRuntimeRegistrationError("reference_invalid", "RuntimeRevision 落库失败");
    }
    if (!revision.verifiedAt) {
      // fail loudly：verified Revision 必须携带精确的持久化验收时间，禁止伪造回退值。
      throw new Error("registerAgentRuntime: verified Revision 缺少 verifiedAt（读回失败）");
    }
    return { runtime, revision };
  });

  return {
    runtime: persisted.runtime,
    revision: persisted.revision,
    snapshot,
    runtimeEndpoint: endpoint,
    evidence,
  };
}
