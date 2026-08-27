/**
 * Generic Live External Agent Runner（06 专项）。
 *
 * 唯一目标：给 SnowHarness 一个公共 Agent Contract + live endpoint +（可选）
 * CredentialRef，仅通过正式 Admin / Employee HTTP API 完成黑盒联调：
 *   R1 合同登记 → R2 AgentRevision 创建/发布 → R3 Runtime Registration（真实
 *   ConformanceRun）→ R4 正式 GET 投影 + RuntimeRevision 发布 → R5 Route 激活
 *   → R6 Catalog 轮询 → （可选 R7）Employee Thread/Turn/Resume API 验收。
 *
 * 冻结不变量：
 * - 只走公开/管理 API：不 import db/stores/persistence/internal services；
 * - 不读取 Provider 源码/框架/仓 SHA；不接 raw bearer token（只传 CredentialRef ID）；
 * - 每步有限超时；失败 fail closed（不 delete DB 重来）；
 * - 幂等键稳定派生 `<run-id>:<step>`；
 * - 输出 sanitized evidence JSON（无 token/私钥/DSSE envelope/transcript 全文）。
 */
import { randomUUID } from "node:crypto";
import type { LiveExternalAgentConfig } from "@/scripts/integration/live-external-agent-config";

/** 最小 HTTP 客户端口（供测试注入 fake server）。 */
export interface LiveHttpClient {
  request(params: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    ifMatch?: string;
  }): Promise<{ status: number; body: unknown }>;
}

/** 基于全局 fetch 的正式实现。 */
export function createFetchLiveHttpClient(
  config: Pick<LiveExternalAgentConfig, "baseUrl" | "httpTimeoutMs" | "adminBearerToken">,
): LiveHttpClient {
  return {
    async request({ method, path, body, idempotencyKey, ifMatch }) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      if (ifMatch) headers["If-Match"] = ifMatch;
      if (config.adminBearerToken) {
        headers.Authorization = `Bearer ${config.adminBearerToken}`;
      }
      const response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(config.httpTimeoutMs),
      });
      const text = await response.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
  };
}

export class LiveJoinStepError extends Error {
  constructor(
    public readonly step: string,
    message: string,
  ) {
    super(`[${step}] ${message}`);
    this.name = "LiveJoinStepError";
  }
}

/** sanitized 输出证据（06 §10；无 secret/合同原文/envelope）。 */
export interface LiveJoinEvidence {
  run_id: string;
  agent_id: string;
  contract_snapshot_id: string;
  agent_revision_id: string;
  agent_publication_record_id: string | null;
  runtime_id: string;
  runtime_revision_id: string;
  conformance_run_id: string;
  runtime_publication_record_id: string;
  route_set_id: string;
  route_revision_id: string;
  invocation_id?: string;
  final_state?: string;
  input_required_seen?: boolean;
  resume_completed?: boolean;
}

interface InteractionFlags {
  input_required: boolean;
  resume: boolean;
  cancel: boolean;
}

function interactionFlagsOf(contract: unknown): InteractionFlags {
  const interaction =
    contract && typeof contract === "object"
      ? (contract as Record<string, unknown>).interaction
      : null;
  const flags = (interaction && typeof interaction === "object" ? interaction : {}) as Record<
    string,
    unknown
  >;
  return {
    input_required: flags.input_required === true,
    resume: flags.resume === true,
    cancel: flags.cancel === true,
  };
}

function expectOk(
  step: string,
  response: { status: number; body: unknown },
): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300) {
    throw new LiveJoinStepError(
      step,
      `HTTP ${response.status}（${JSON.stringify(response.body ?? null).slice(0, 300)}）`,
    );
  }
  const body = response.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LiveJoinStepError(step, "响应不是 JSON object");
  }
  return body as Record<string, unknown>;
}

function requireString(step: string, body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new LiveJoinStepError(step, `响应缺少 ${key}`);
  }
  return value;
}

async function pollUntil(
  step: string,
  params: { timeoutMs: number; intervalMs?: number },
  probe: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const interval = params.intervalMs ?? 1_000;
  const deadline = Date.now() + params.timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() >= deadline) {
      throw new LiveJoinStepError(step, `等待超时（${params.timeoutMs}ms）`);
    }
    await sleep(Math.min(interval, Math.max(deadline - Date.now(), 0)));
  }
}

export interface RunLiveJoinParams {
  config: LiveExternalAgentConfig;
  /** 已解析的公共合同对象（调用方读文件；Runner 不读 Provider 其他文件）。 */
  contract: unknown;
  client: LiveHttpClient;
  runId?: string;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 执行完整非点击 Join。任何一步失败抛 LiveJoinStepError（fail closed）。
 * 返回 sanitized evidence。
 */
export async function runLiveExternalAgentJoin(
  params: RunLiveJoinParams,
): Promise<LiveJoinEvidence> {
  const { config, contract, client } = params;
  const runId = params.runId ?? randomUUID();
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const idem = (step: string) => `${runId}:${step}`;
  const interaction = interactionFlagsOf(contract);

  // ─── R1 合同登记 ───────────────────────────────────────
  const r1 = expectOk(
    "R1-contract",
    await client.request({
      method: "POST",
      path: "/admin/api/v1/agent-registrations",
      idempotencyKey: idem("contract"),
      body: {
        protocol: {
          type: "a2a",
          contract_revision: config.protocolContractRevision,
        },
        contract,
      },
    }),
  );
  const agent = (r1.agent ?? {}) as Record<string, unknown>;
  const contractWire = (r1.contract ?? {}) as Record<string, unknown>;
  const agentId = requireString("R1-contract", agent, "id");
  const contractSnapshotId = requireString("R1-contract", contractWire, "snapshot_id");

  // ─── R2 AgentRevision 创建 + 发布 ─────────────────────
  const r2create = expectOk(
    "R2-agent-revision",
    await client.request({
      method: "POST",
      path: `/admin/api/v1/agents/${agentId}/revisions`,
      idempotencyKey: idem("agent-revision-create"),
      body: {
        agent_contract_snapshot_id: contractSnapshotId,
        model_policy: {},
        permission_requirements: {},
        delegation_policy: {},
        agent_interface_requirements: {},
      },
    }),
  );
  const agentRevisionId = requireString("R2-agent-revision", r2create, "id");
  const agentRevisionEtag = requireString("R2-agent-revision", r2create, "etag");
  const r2publish = expectOk(
    "R2-agent-publish",
    await client.request({
      method: "POST",
      path: `/admin/api/v1/agent-revisions/${agentRevisionId}/publish`,
      idempotencyKey: idem("agent-publish"),
      ifMatch: agentRevisionEtag,
      body: { release_notes: `live-external-agent ${runId}` },
    }),
  );
  const agentPublicationRecordId =
    typeof r2publish.publication_record_id === "string" ? r2publish.publication_record_id : null;

  // ─── R3 Runtime Registration（真实 Conformance）────────
  const conformance: Record<string, unknown> = { basic: { input: config.basicInput } };
  if (interaction.input_required) {
    conformance.input_required = {
      input: config.inputRequiredInput ?? config.basicInput,
    };
  }
  if (interaction.resume) {
    conformance.resume = {
      start_input: config.resumeStartInput ?? config.basicInput,
      resume_input: config.resumeInput ?? "明天一天",
    };
  }
  // cancel=false 绝不声明 cancel probe（Runner 不要求 Provider 伪造取消）。
  if (interaction.cancel && config.expectCancelSupported) {
    conformance.cancel = { input: config.basicInput };
  }
  const r3 = expectOk(
    "R3-runtime-registration",
    await client.request({
      method: "POST",
      path: `/admin/api/v1/agents/${agentId}/runtime-registrations`,
      idempotencyKey: idem("runtime-registration"),
      body: {
        contract_snapshot_id: contractSnapshotId,
        runtime_endpoint: config.runtimeEndpoint,
        authentication: {
          mode: config.runtimeAuthMode,
          credential_ref_id:
            config.runtimeAuthMode === "bearer" ? config.runtimeCredentialRefId : null,
        },
        conformance,
      },
    }),
  );
  const runtimeId = requireString("R3-runtime-registration", r3, "runtime_id");
  const runtimeRevisionId = requireString("R3-runtime-registration", r3, "runtime_revision_id");
  const conformanceRunId = requireString("R3-runtime-registration", r3, "conformance_run_id");
  if (r3.conformance_overall_result !== "passed") {
    throw new LiveJoinStepError(
      "R3-runtime-registration",
      `conformance_overall_result=${String(r3.conformance_overall_result)}（期望 passed）`,
    );
  }

  // ─── R4 正式 GET 投影 + RuntimeRevision 发布 ──────────
  // Publish 必须以刷新后的正式 GET 为准（06 §4），不直接用 registration 响应。
  await pollUntil(
    "R4-revision-projection",
    { timeoutMs: config.catalogWaitMs },
    async () => {
      const revision = expectOk(
        "R4-revision-projection",
        await client.request({
          method: "GET",
          path: `/admin/api/v1/runtime-revisions/${runtimeRevisionId}`,
        }),
      );
      return revision.latest_valid_conformance_run_id === conformanceRunId;
    },
    sleep,
  );
  const revisionProjection = expectOk(
    "R4-revision-projection",
    await client.request({
      method: "GET",
      path: `/admin/api/v1/runtime-revisions/${runtimeRevisionId}`,
    }),
  );
  if (revisionProjection.latest_valid_conformance_overall_result !== "passed") {
    throw new LiveJoinStepError("R4-revision-projection", "latest_valid_conformance 未通过");
  }
  if (config.expectCancelSupported !== true) {
    const capabilities = (revisionProjection.runtime_capabilities ?? {}) as {
      effective?: Record<string, unknown>;
    };
    if (capabilities.effective?.cancel === true) {
      throw new LiveJoinStepError("R4-revision-projection", "effective cancel=true 与配置不符");
    }
  }
  const runtime = expectOk(
    "R4-runtime-version",
    await client.request({
      method: "GET",
      path: `/admin/api/v1/runtimes/${runtimeId}`,
    }),
  );
  const runtimeVersionNo = runtime.version_no;
  if (typeof runtimeVersionNo !== "number") {
    throw new LiveJoinStepError("R4-runtime-version", "响应缺少 version_no");
  }
  const runtimeRevisionNo = revisionProjection.revision_no;
  if (typeof runtimeRevisionNo !== "number") {
    throw new LiveJoinStepError("R4-revision-projection", "响应缺少 revision_no");
  }
  const r4 = expectOk(
    "R4-runtime-publish",
    await client.request({
      method: "POST",
      path: `/admin/api/v1/runtime-revisions/${runtimeRevisionId}/publish`,
      idempotencyKey: idem("runtime-publish"),
      ifMatch: `runtime-revision-${runtimeRevisionNo}`,
      body: {
        expected_version_no: runtimeVersionNo,
        attestation_id: null,
        conformance_run_id: conformanceRunId,
      },
    }),
  );
  const runtimePublicationRecordId = requireString(
    "R4-runtime-publish",
    r4,
    "publication_record_id",
  );

  // ─── R5 RouteSet + 激活 ───────────────────────────────
  const r5create = expectOk(
    "R5-route-set",
    await client.request({
      method: "POST",
      path: "/admin/api/v1/deployment-route-sets",
      idempotencyKey: idem("route-set"),
      body: {
        agent_id: agentId,
        route_scope_key: "default",
        route_scope: {},
      },
    }),
  );
  const routeSetId = requireString("R5-route-set", r5create, "id");
  const routeSetVersionNo = r5create.version_no;
  if (typeof routeSetVersionNo !== "number") {
    throw new LiveJoinStepError("R5-route-set", "响应缺少 version_no");
  }
  const r5activate = expectOk(
    "R5-route-activation",
    await client.request({
      method: "PUT",
      path: `/admin/api/v1/deployment-route-sets/${routeSetId}/activation`,
      idempotencyKey: idem("route-activation"),
      ifMatch: `route-set-${routeSetVersionNo}`,
      body: {
        expected_version_no: routeSetVersionNo,
        reason: `live-external-agent ${runId}`,
        routes: [
          {
            route_group_id: "primary",
            agent_revision_id: agentRevisionId,
            runtime_revision_id: runtimeRevisionId,
            traffic_weight: 10000,
            priority_no: 1,
          },
        ],
      },
    }),
  );
  const activations = (r5activate.activations ?? []) as Array<Record<string, unknown>>;
  const activation = activations[0];
  if (!activation || typeof activation.route_revision_id !== "string") {
    throw new LiveJoinStepError("R5-route-activation", "响应缺少 route_revision_id");
  }
  const routeRevisionId = activation.route_revision_id;
  const routeId = typeof activation.route_id === "string" ? activation.route_id : null;
  if (!routeId) {
    throw new LiveJoinStepError("R5-route-activation", "响应缺少 route_id");
  }
  // 激活新鲜度门：正式 Admin read API 投影反映本次 route_revision_id 后才进入
  // 员工链路（RouteEligibilityProjection 异步更新，投影滞后会让 Binding 落到
  // 已被取代的 activation 上 → route_activation_superseded）。
  await pollUntil(
    "R5-route-projection",
    { timeoutMs: config.catalogWaitMs },
    async () => {
      const route = expectOk(
        "R5-route-projection",
        await client.request({
          method: "GET",
          path: `/admin/api/v1/deployment-routes/${routeId}`,
        }),
      );
      return route.active_route_revision_id === routeRevisionId;
    },
    sleep,
  );

  // ─── R6 Catalog 轮询（正式 Employee API）──────────────
  await pollUntil(
    "R6-catalog",
    { timeoutMs: config.catalogWaitMs },
    async () => {
      const catalog = expectOk(
        "R6-catalog",
        await client.request({
          method: "GET",
          path: "/api/v1/catalog/options?resource_type=agent",
        }),
      );
      const items = (catalog.items ?? []) as Array<Record<string, unknown>>;
      return items.some(
        (item) =>
          (item.agent_id === agentId || item.id === agentId || item.resource_id === agentId) &&
          item.lifecycle_state !== "disabled",
      );
    },
    sleep,
  );

  const evidence: LiveJoinEvidence = {
    run_id: runId,
    agent_id: agentId,
    contract_snapshot_id: contractSnapshotId,
    agent_revision_id: agentRevisionId,
    agent_publication_record_id: agentPublicationRecordId,
    runtime_id: runtimeId,
    runtime_revision_id: runtimeRevisionId,
    conformance_run_id: conformanceRunId,
    runtime_publication_record_id: runtimePublicationRecordId,
    route_set_id: routeSetId,
    route_revision_id: routeRevisionId,
  };

  // ─── R7（可选）Employee API 验收 ─────────────────────
  if (config.exercise) {
    const exercised = await exerciseEmployeeFlow({
      config,
      client,
      agentId,
      sleep,
      idem,
    });
    Object.assign(evidence, exercised);
  }

  return evidence;
}

/** R7：create Thread → Turn(agent_selection.required) → input-required → Resume。 */
async function exerciseEmployeeFlow(params: {
  config: LiveExternalAgentConfig;
  client: LiveHttpClient;
  agentId: string;
  sleep: (ms: number) => Promise<void>;
  idem: (step: string) => string;
}): Promise<Partial<LiveJoinEvidence>> {
  const { config, client, agentId, sleep, idem } = params;
  // 1) Thread + Turn（agent_selection.required，走真实 Route 解析）。
  const thread = expectOk(
    "R7-thread",
    await client.request({
      method: "POST",
      path: "/api/v1/threads",
      idempotencyKey: idem("thread"),
      body: { title: "live-external-agent" },
    }),
  );
  const threadId = requireString("R7-thread", thread, "id");
  expectOk(
    "R7-turn",
    await client.request({
      method: "POST",
      path: `/api/v1/threads/${threadId}/turns`,
      idempotencyKey: idem("turn"),
      body: {
        input: { type: "text", text: config.resumeStartInput ?? config.basicInput },
        agent_selection: { agent_id: agentId, mode: "required" },
      },
    }),
  );

  // 2) 等待 pending user_action Item（input-required 证据；正式 Employee read API）。
  let requestId: string | null = null;
  await pollUntil(
    "R7-wait-input-required",
    { timeoutMs: config.invocationWaitMs },
    async () => {
      const items = expectOk(
        "R7-wait-input-required",
        await client.request({
          method: "GET",
          path: `/api/v1/threads/${threadId}/items`,
        }),
      );
      const list = (items.items ?? []) as Array<Record<string, unknown>>;
      const pending = list.find(
        (item) => item.item_type === "user_action" && item.item_state === "pending",
      );
      if (!pending) return false;
      const content = (pending.content ?? {}) as Record<string, unknown>;
      if (typeof content.request_id === "string") {
        requestId = content.request_id;
        return true;
      }
      return false;
    },
    sleep,
  );
  if (!requestId) {
    throw new LiveJoinStepError("R7-wait-input-required", "未观测到 pending user_action Item");
  }

  // 3) 记录 resume 前 correlation（正式 Admin read API：taskId / session binding）。
  const threadBefore = expectOk(
    "R7-correlation",
    await client.request({ method: "GET", path: `/api/v1/threads/${threadId}` }),
  );
  const turnBefore = (threadBefore.latest_turn ?? {}) as Record<string, unknown>;
  const invocationId = requireString("R7-correlation", turnBefore, "active_invocation_id");
  const invocationBefore = expectOk(
    "R7-correlation",
    await client.request({
      method: "GET",
      path: `/admin/api/v1/invocations/${invocationId}`,
    }),
  );
  const taskIdBefore = requireString("R7-correlation", invocationBefore, "runtime_execution_ref");

  // 4) Resolve（Resume）—— 真实 200/202/422 语义由路由保证；failed 视为联调失败。
  const resolve = expectOk(
    "R7-resume",
    await client.request({
      method: "POST",
      path: `/api/v1/threads/${threadId}/user-actions/${requestId}/resolve`,
      idempotencyKey: idem("resolve"),
      body: {
        resolution: "submit",
        response_redacted: { text: config.resumeInput ?? "明天一天" },
      },
    }),
  );
  const resumeDispatch = (resolve.resume_dispatch ?? {}) as Record<string, unknown>;
  if (
    typeof resumeDispatch.command_state === "string" &&
    resumeDispatch.command_state === "failed"
  ) {
    throw new LiveJoinStepError("R7-resume", "Resume 命令 failed（运行服务拒绝恢复）");
  }

  // 5) 等待同 Invocation 终态（Turn 终态；不新建 continuation）。
  let finalState: string | null = null;
  await pollUntil(
    "R7-wait-terminal",
    { timeoutMs: config.invocationWaitMs },
    async () => {
      const threadNow = expectOk(
        "R7-wait-terminal",
        await client.request({ method: "GET", path: `/api/v1/threads/${threadId}` }),
      );
      const turnNow = (threadNow.latest_turn ?? {}) as Record<string, unknown>;
      // same Invocation：active 指针非空时不得漂移（终态 Turn 可能清空 active 指针，
      // null 视为正常收尾而非新建 continuation）。
      if (turnNow.active_invocation_id != null && turnNow.active_invocation_id !== invocationId) {
        throw new LiveJoinStepError(
          "R7-wait-terminal",
          "active_invocation_id 漂移（Resume 不得新建 continuation Invocation）",
        );
      }
      const state = turnNow.turn_state;
      if (
        typeof state === "string" &&
        ["completed", "failed", "lost", "cancelled", "withdrawn"].includes(state)
      ) {
        finalState = state;
        return true;
      }
      return false;
    },
    sleep,
  );

  // 6) correlation 断言：resume 后 taskId 不变（06 §8）。
  const invocationAfter = expectOk(
    "R7-correlation",
    await client.request({
      method: "GET",
      path: `/admin/api/v1/invocations/${invocationId}`,
    }),
  );
  const taskIdAfter = requireString("R7-correlation", invocationAfter, "runtime_execution_ref");
  if (taskIdAfter !== taskIdBefore) {
    throw new LiveJoinStepError(
      "R7-correlation",
      `taskId 发生变化（${taskIdBefore} → ${taskIdAfter}）`,
    );
  }

  return {
    invocation_id: invocationId,
    final_state: finalState ?? undefined,
    input_required_seen: true,
    resume_completed: finalState === "completed",
  };
}

/** CLI 入口（node --import tsx scripts/integration/live-external-agent.ts）。 */
async function main(): Promise<void> {
  const { resolveLiveExternalAgentConfig } = await import(
    "@/scripts/integration/live-external-agent-config"
  );
  const { readFile } = await import("node:fs/promises");
  const config = resolveLiveExternalAgentConfig();
  const contract = JSON.parse(await readFile(config.contractFile, "utf-8")) as unknown;
  const evidence = await runLiveExternalAgentJoin({
    config,
    contract,
    client: createFetchLiveHttpClient(config),
  });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1]?.includes("live-external-agent")) {
  void main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
