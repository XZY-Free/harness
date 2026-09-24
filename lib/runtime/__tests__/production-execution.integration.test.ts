/**
 * R01「默认生产入口」权威场景（ENTRY-01..06）。
 *
 * 层：real MySQL（testcontainers）+ real docker（受管容器）+ 真实 Thread API Route Handler
 * + 真实生产组合层（`resolveExecutionResources` / 真实 Hosted Runtime / 真实 Ingress）。
 *
 * 唯一允许的测试替身（repairs/01-production.md §5）：**最末端的模型响应 / 外部 Provider
 * 网络边界**。因此本文件把 `LLM_BASE_URL` 指向一个真实监听的 OpenAI 兼容桩服务，
 * 其余一切都走生产 Factory —— 不注入自定义 WorkspaceBackend、不注入自定义
 * EnvironmentProvisioner、不注入自定义 Action Executors（那正是 R01 的缺陷形态）。
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST as createTurnPOST } from "@/app/api/threads/[threadId]/turns/route";
import { createToolExecutionWorker } from "@/lib/capability/tool-execution-worker";
import {
  createConnection,
  createTool,
  createToolProvider,
  createToolSchemaRevision,
  publishToolSchemaRevision,
  updateConnection,
  updateTool,
  updateToolProvider,
} from "@/lib/capability/tool-queries";
import {
  acceptUserMessageTurn,
  getTurnById,
  getTurnsByThread,
} from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { buildDrizzle, resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createEnvironmentDefinition,
  getEnvironmentRevisionById,
} from "@/lib/environment/environment-definition-store";
import { managedContainerName } from "@/lib/environment/environment-instance-backend";
import { getEnvironmentLeaseByAttempt } from "@/lib/environment/environment-lease-store";
import { ENVIRONMENT_PREPARED_TTL_MS } from "@/lib/environment/environment-prepared-evidence";
import type { EnvironmentRevisionInput } from "@/lib/environment/environment-revision";
import { createCreateExecutionBinding } from "@/lib/executions/application/create-execution-binding";
import type { ExecutionBindingConfigInput } from "@/lib/executions/domain/execution-binding";
import { assertExecutionSourceSnapshot } from "@/lib/executions/domain/preparation-source";
import { assertAttemptPreparationClaimHeld } from "@/lib/executions/persistence/attempt-store";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import {
  closeExecutionOwnership,
  getActiveExecutionOwnership,
  getAuthorityDatabaseTime,
  renewExecutionOwnership,
} from "@/lib/executions/persistence/execution-ownership-store";
import { createInvocation } from "@/lib/executions/persistence/invocation-store";
import { mysqlExecutionBindingStore } from "@/lib/executions/persistence/mysql-execution-binding-store";
import { registerDevice, revokeDevice } from "@/lib/identity/device-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { ALL_SUCCESS_COMPLETION_POLICY } from "@/lib/job/completion-policy";
import { resolveJobBindingCommand } from "@/lib/job/job-admission";
import { createJobInvocation } from "@/lib/job/job-execution";
import { createJob } from "@/lib/job/job-queries";
import { getPermissionDecisionsByToolCall } from "@/lib/permission/permission-queries";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable } from "@/lib/persistence/schema/runtimes";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import { workspace, workspaceBinding } from "@/lib/persistence/schema/workspace";
import { getIngressByInvocation } from "@/lib/runtime/application/ingress-runtime-events";
import {
  inspectContainer,
  inspectImage,
  removeContainer,
} from "@/lib/runtime/container/docker-cli";
import { createProductionInvocationContinuationWorker } from "@/lib/runtime/continuation/production-invocation-continuation-worker";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import { HARNESS_ACTION_EVENT_PAYLOAD_SCHEMA } from "@/lib/runtime/harness-loop/action-schema";
import { verifyCapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import { getRuntimeSessionBindingsByInvocation } from "@/lib/runtime/persistence/runtime-session-store";
import { DISPATCH_STUCK_GRACE_MS } from "@/lib/runtime/retry/dispatch-retry-queries";
import { createRuntimeDispatchRetryWorker } from "@/lib/runtime/retry/runtime-dispatch-retry-worker";
import {
  requireExecutionBinding,
  resolveRuntimeTransportFromBinding,
} from "@/lib/runtime/retry/runtime-transport-from-binding";
import {
  runDueUndispatchedIntentRecoveries,
  scanUndispatchedAcceptedTurns,
  scanUndispatchedInvocations,
} from "@/lib/runtime/retry/undispatched-intent-lane";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import {
  AuthorityIdentitySchema,
  ContextHandleCommonSchema,
  ContextHandleSubjectSchema,
  EnvironmentSchema,
  ExecutionBindingSchema,
  ExecutionLimitsSchema,
  InputSchema,
  IntentTypeSchema,
  RecoverySchema,
  WorkspaceSchema,
  positiveDecimalStringSchema,
  protocolDigest,
  sha256DigestSchema,
} from "@/lib/runtime/runtime-protocol";
import { spawnInitialDispatchCrashProcess } from "@/lib/runtime/test-support/initial-dispatch-crash-process";
import {
  ensureDesktopWorkspace,
  resolveWorkspaceBindingId,
} from "@/lib/workspace/desktop-workspace-queries";
import { computeWorkspaceContractDigest } from "@/lib/workspace/workspace-contract";
import {
  createWorkspace,
  createWorkspaceBinding,
  getWorkspaceBindingById,
  getWorkspaceById,
  resolveDeclaredWorkspaceBinding,
} from "@/lib/workspace/workspace-queries";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Session 冻结的**语义域** Start 请求（`buildStartSemanticDigestInput` 的产物）。
 *
 * 由协议自身导出的子 schema 组合：被去掉的 credentials / traceContext /
 * callbackEndpoints / semanticRequestDigest 与 ContextHandle 的签名时间、jti 都是
 * **非语义域**事实，不参与 `semanticRequestDigest`。
 */
const FrozenStartSemanticSchema = z
  .object({
    protocolVersion: z.literal(3),
    authority: AuthorityIdentitySchema,
    intentType: IntentTypeSchema,
    executionBinding: ExecutionBindingSchema,
    context: z
      .object({
        common: ContextHandleCommonSchema.omit({ issuedAt: true, expiresAt: true, jti: true }),
        subject: ContextHandleSubjectSchema,
      })
      .strict(),
    inputs: z.array(InputSchema).min(1),
    environment: EnvironmentSchema,
    workspace: WorkspaceSchema,
    activationDigest: sha256DigestSchema,
    recovery: RecoverySchema,
    producerSequenceStart: positiveDecimalStringSchema,
    executionLimits: ExecutionLimitsSchema,
  })
  .strict();

// ─── 环境 ───────────────────────────────────────────────────

const ORIGINAL_AUTH_MODE = process.env.SNOW_VITEST_IDENTITY_FIXTURE;
const ORIGINAL_LLM_BASE_URL = process.env.LLM_BASE_URL;
const ORIGINAL_LLM_API_KEY = process.env.LLM_API_KEY;
const ORIGINAL_ENV_CONTROL_ROOT = process.env.SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT;
const ORIGINAL_WORKSPACE_HOST_ROOT = process.env.SNOWHARNESS_WORKSPACE_HOST_ROOT;
const ORIGINAL_WORKSPACE_HOST_URL = process.env.SNOWHARNESS_WORKSPACE_HOST_URL;
const ORIGINAL_RUNTIME_DEFAULT = process.env.RUNTIME_DEFAULT;

const IMAGE_CANDIDATES = ["debian:bookworm-slim", "node:24-alpine", "alpine/socat:latest"] as const;
const MEMORY_BYTES = 128 * 1024 * 1024;
const PIDS_LIMIT = 64;
const OPEN_FILES_LIMIT = 128;

const temporaryRoots: string[] = [];
let environmentControlRoot = "";
let resolvedImage: string | null = null;
let resolvedImageDigest = "";

// ─── 模型边界替身（唯一允许的测试替身）─────────────────────

interface StubRequest {
  path: string;
  body: Record<string, unknown>;
  streamed: boolean;
}

/**
 * 取出模型边界实际收到的提示文本。
 *
 * 决策端口用 `generateObject({ prompt })`，AI SDK 会把它归一成单条 `role: "user"` 消息，
 * 内容是 `[指令…, JSON.stringify(view)].join("\n\n")` —— 冻结能力目录就在这段文本里。
 */
function promptText(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (part as { text?: string } | undefined)?.text ?? "")
        .join("");
    }
  }
  return "";
}

/**
 * 决策提示的末段就是模型看到的 `view`（`JSON.stringify` 产物）。
 *
 * 按真实结构读目录，而不是对提示文本做字符串猜测 —— 桩要证明的是"模型确实看到了这份
 * 冻结目录"，所以它必须读模型实际拿到的那份 JSON。
 */
function decisionView(prompt: string): Record<string, unknown> | null {
  const start = prompt.lastIndexOf("\n\n{");
  if (start < 0) return null;
  try {
    return JSON.parse(prompt.slice(start + 2)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function catalogToolsFromView(
  view: Record<string, unknown> | null,
): Array<{ toolId: string; operationId: string }> {
  const capabilities = view?.capabilities as { catalog?: { tools?: unknown } } | undefined;
  const tools = capabilities?.catalog?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (tool): tool is { toolId: string; operationId: string } =>
      typeof (tool as { toolId?: unknown }).toolId === "string" &&
      typeof (tool as { operationId?: unknown }).operationId === "string",
  );
}

/**
 * OpenAI 兼容的模型端点桩。
 *
 * `generateObject`（行动决策）走非流式 `json_object`；`streamText`（正文）走 SSE。
 * 用例脚本化「决策序列」：先按队列返回行动，队列耗尽后返回 `respond`。
 */
class ModelBoundaryStub {
  private server: Server | null = null;
  private endpointValue: string | null = null;
  readonly requests: StubRequest[] = [];
  /** 脚本化决策队列；空队列 → `respond`。 */
  readonly actions: Array<Record<string, unknown>> = [];
  /**
   * 「自动工具计划」：首次决策就按**冻结能力目录**（决策提示里真实携带的 catalog）里的
   * 这个 `operationId` 发起 `tool.call`。它模拟的是"模型读了目录后决定用工具"，
   * 因此 toolId 只能来自目录本身 —— 测试不自己编一个工具身份。
   */
  autoTool: { operationId: string; arguments: Record<string, unknown> } | null = null;
  /** 模型边界实际收到的决策提示（未流式请求）。 */
  readonly decisionPrompts: string[] = [];
  finalText = "已按冻结能力完成。";

  get endpoint(): string {
    if (!this.endpointValue) throw new Error("model stub 尚未启动");
    return this.endpointValue;
  }

  get decisionCount(): number {
    return this.requests.filter((request) => !request.streamed).length;
  }

  get finalResponseCount(): number {
    return this.requests.filter((request) => request.streamed).length;
  }

  reset(): void {
    this.actions.length = 0;
    this.requests.length = 0;
    this.decisionPrompts.length = 0;
    this.autoTool = null;
  }

  /** 从决策提示里取出冻结目录中的工具（工具身份来自模型真实看到的目录）。 */
  private catalogToolFromPrompt(
    prompt: string,
    operationId: string,
  ): { toolId: string; operationId: string } | null {
    return (
      catalogToolsFromView(decisionView(prompt)).find(
        (entry) => entry.operationId === operationId,
      ) ?? null
    );
  }

  /**
   * 本轮的 `stepNo`。
   *
   * 必须从模型视图里的 `budget.used.loopSteps` 推导，**不能**用桩自己的请求计数：
   * 一个测试里可能跑多个 Loop（多个 Turn / 多轮恢复），计数器会把第二个 Loop 的
   * 第一步算成 2，于是 Harness 判定 `action.stepNo=2，期望 1` 并让执行失败。
   */
  private nextStepNo(prompt: string): number {
    const view = decisionView(prompt);
    const used = (view?.budget as { used?: { loopSteps?: unknown } } | undefined)?.used;
    const loopSteps = typeof used?.loopSteps === "number" ? used.loopSteps : 0;
    return loopSteps + 1;
  }

  /**
   * 首个决策按冻结目录发起 `tool.call`，之后回落到 `respond`。
   *
   * 只认目录里真实存在的 `operationId`：解析不出目录条目就返回 null（回落 `respond`），
   * 绝不自造工具身份 —— 否则 `validateHarnessActionAgainstCatalog` 会拒绝，测试就变成
   * 在验证"测试自己编的工具"而不是"模型按目录取证"。
   */
  private autoToolAction(prompt: string, stepNo: number): Record<string, unknown> | null {
    const plan = this.autoTool;
    if (!plan) return null;
    if (stepNo !== 1) return null;
    const tool = this.catalogToolFromPrompt(prompt, plan.operationId);
    if (!tool) return null;
    return {
      actionId: `tool-call-${plan.operationId}`,
      stepNo,
      actionType: "tool.call",
      purposeCode: "gather_evidence",
      shortPurpose: `调用 ${plan.operationId} 获取证据`,
      payload: { toolId: tool.toolId, operationId: tool.operationId, arguments: plan.arguments },
    };
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address() as AddressInfo;
    this.endpointValue = `http://127.0.0.1:${address.port}`;
  }

  async dispose(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.endpointValue = null;
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readJson(request);
    const streamed = body.stream === true;
    this.requests.push({ path: request.url ?? "", body, streamed });
    if (streamed) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const head = {
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, delta: { role: "assistant", content: this.finalText }, finish_reason: null },
        ],
      };
      response.write(`data: ${JSON.stringify(head)}\n\n`);
      const tail = {
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      response.write(`data: ${JSON.stringify(tail)}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    this.decisionPrompts.push(promptText(body));
    const prompt = this.decisionPrompts.at(-1) ?? "";
    const stepNo = this.nextStepNo(prompt);
    const next = this.actions.shift() ??
      this.autoToolAction(prompt, stepNo) ?? {
        actionId: `respond-${stepNo}`,
        stepNo,
        actionType: "respond",
        purposeCode: "answer_ready",
        shortPurpose: "直接回答",
        payload: { evidenceRefs: [] },
      };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(next) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  }
}

const modelStub = new ModelBoundaryStub();

// ─── 外部 Provider 网络边界替身 ─────────────────────────────

/**
 * 外部 Provider（webhook）网络对端替身 —— 与模型桩同为 R01 §5 允许的**最末端**替身。
 *
 * 它不替换任何平台执行器：ToolCall 仍经正式 Policy / 执行合同校验、由正式
 * `webhook.post_json` executor 真实建立 HTTP 连接；这里只充当网络另一端的服务，
 * 因此模型观测到的 tool 结果确实来自一次真实请求-响应往返。
 */
class ProviderBoundaryStub {
  private server: Server | null = null;
  private endpointValue: string | null = null;
  readonly requests: Array<{ body: unknown; idempotencyKey: string | null }> = [];
  payload: unknown = { ok: true };

  get endpoint(): string {
    if (!this.endpointValue) throw new Error("provider stub 尚未启动");
    return this.endpointValue;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString("utf8");
        this.requests.push({
          body: text ? (JSON.parse(text) as unknown) : null,
          idempotencyKey:
            typeof request.headers["idempotency-key"] === "string"
              ? request.headers["idempotency-key"]
              : null,
        });
        response.writeHead(200, { "content-type": "application/json", "x-request-id": "stub-1" });
        response.end(JSON.stringify(this.payload));
      })();
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address() as AddressInfo;
    this.endpointValue = `http://127.0.0.1:${address.port}/tool`;
  }

  async dispose(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.endpointValue = null;
  }
}

const providerStub = new ProviderBoundaryStub();

beforeAll(async () => {
  for (const candidate of IMAGE_CANDIDATES) {
    const inspected = await inspectImage(candidate);
    if (inspected) {
      resolvedImage = candidate;
      resolvedImageDigest = inspected.Id;
      break;
    }
  }
  // 平台部署事实（不是测试替身）：生产默认受管 Runtime 类型是 container
  // （`runtimeConfig.defaultType` 在 NODE_ENV=production 下即 container）。受管
  // Environment 的真实实例化只在 container Runtime 上成立；host_agent Backend 按
  // repairs/06-environment.md 的诚实边界**永远**拒绝 processIsolation，无法承载 MANAGED。
  process.env.RUNTIME_DEFAULT = "container";
  await modelStub.start();
  process.env.LLM_BASE_URL = modelStub.endpoint;
  process.env.LLM_API_KEY = "vitest-model-boundary";
  await providerStub.start();
});

afterAll(async () => {
  await modelStub.dispose();
  await providerStub.dispose();
  restore("LLM_BASE_URL", ORIGINAL_LLM_BASE_URL);
  restore("LLM_API_KEY", ORIGINAL_LLM_API_KEY);
  restore("RUNTIME_DEFAULT", ORIGINAL_RUNTIME_DEFAULT);
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
  restore("SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT", ORIGINAL_ENV_CONTROL_ROOT);
  restore("SNOWHARNESS_WORKSPACE_HOST_ROOT", ORIGINAL_WORKSPACE_HOST_ROOT);
  restore("SNOWHARNESS_WORKSPACE_HOST_URL", ORIGINAL_WORKSPACE_HOST_URL);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) clearEnv(name);
  else process.env[name] = value;
}

function clearEnv(name: string): void {
  // 注意：`process.env[name] = undefined` 会写入字符串 "undefined"（Node 会把值强制转成
  // 字符串），从而让「未配置」被误判成「已配置一个名为 undefined 的部署」。必须真正删除。
  Reflect.deleteProperty(process.env, name);
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

// ─── 夹具 ───────────────────────────────────────────────────

interface EntryContext {
  tenantId: string;
  ownerId: string;
  threadId: string;
  deviceKey: string;
  /** HOST_AFFINE（desktop）WorkspaceBinding id。 */
  desktopBindingId: string;
  desktopWorkspaceId: string;
  environmentDefinitionId: string;
  environmentRevisionId: string;
}

/**
 * 建出「真实 Thread + MANAGED Environment + HOST_AFFINE Workspace」的上下文。
 *
 * 模型边界（`LLM_BASE_URL`）之外的每一环都来自生产代码：真实 Route Resolver、
 * 真实 ExecutionBinding Store、真实 EnvironmentProvisioner（真实 docker 容器）、
 * 真实 Workspace 绑定解析。
 */
async function seedEntryContext(contentSuffix: string): Promise<EntryContext> {
  const { seedDispatchableTurn } = await import("@/lib/test-support/seed-dispatchable-turn");
  const context = await seedDispatchableTurn({ contentSuffix });

  // 播种器会先建一个 accepted Turn 用于其它场景；本文件要求 Turn 只能由真实 API 创建，
  // 因此删除它，让「真实 Thread API」成为唯一接纳入口。
  await db.delete(turnTable).where(eq(turnTable.id, context.turnId));

  const deviceKey = `device-${contentSuffix}`;
  await registerDevice({
    tenantId: context.tenantId,
    userId: context.ownerId,
    deviceKey,
    publicKey: "vitest-public-key",
    deviceName: "Vitest Desktop",
    appVersion: "1.0.0",
  });
  const desktop = await ensureDesktopWorkspace({
    tenantId: context.tenantId,
    userId: context.ownerId,
    deviceKey,
    displayName: "snow_harness",
    storageScopeDigest: `sha256:${contentSuffix
      .padEnd(64, "0")
      .slice(0, 64)
      .replace(/[^0-9a-f]/g, "a")}`,
  });

  const definition = await createEnvironmentDefinition({
    tenantId: context.tenantId,
    environmentKey: `entry-env-${contentSuffix}`,
    displayName: "ENTRY 受管环境",
    revision: managedRevisionInput(),
  });
  const revision = await getEnvironmentRevisionById(
    context.tenantId,
    definition.currentRevisionId as string,
  );
  if (!revision) throw new Error("EnvironmentRevision 创建后回查失败");

  await db
    .update(threadTable)
    .set({
      defaultWorkspaceId: desktop.workspaceId,
      defaultEnvironmentDefinitionId: definition.id,
    })
    .where(and(eq(threadTable.tenantId, context.tenantId), eq(threadTable.id, context.threadId)));

  return {
    tenantId: context.tenantId,
    ownerId: context.ownerId,
    threadId: context.threadId,
    deviceKey,
    desktopBindingId: desktop.bindingId,
    desktopWorkspaceId: desktop.workspaceId,
    environmentDefinitionId: definition.id,
    environmentRevisionId: revision.id,
  };
}

/**
 * MANAGED Environment Revision：真实可核验的容器目标（镜像 digest 固定、策略全部可回读）。
 *
 * 不含 `workspaceMountPath`：HOST_AFFINE Workspace 的写由绑定设备本机执行，服务端不持有
 * 该目录，因此服务端容器不能声明一个它无法回读的挂载。
 */
function managedRevisionInput(): EnvironmentRevisionInput {
  if (!resolvedImage) {
    throw new Error(
      `ENTRY 验收需要真实 docker 与本地候选镜像之一：${IMAGE_CANDIDATES.join(", ")}（不允许静默跳过）`,
    );
  }
  return {
    environmentType: "sandbox",
    filesystemPolicyJson: {
      readOnlyRootfs: true,
      workspaceMountPath: null,
      isolatedFromHost: true,
      extraMounts: [],
    },
    networkPolicyJson: { mode: "disabled" },
    resourceLimitsJson: {
      memoryBytes: MEMORY_BYTES,
      cpus: 0.5,
      pidsLimit: PIDS_LIMIT,
      openFilesLimit: OPEN_FILES_LIMIT,
    },
    secretPolicyJson: { injection: "none", envNames: [] },
    executionTarget: {
      kind: "container",
      image: resolvedImage,
      imageDigest: resolvedImageDigest,
      entrypoint: ["/bin/sh"],
      args: ["-c", "sleep 900"],
    },
    requiredCapabilities: {
      containerized: true,
      processIsolation: true,
      networkIsolation: true,
      readOnlyRootfs: true,
      resourceLimits: true,
      memoryLimit: true,
      cpuLimit: true,
      pidsLimit: true,
      openFilesLimit: true,
      pinnedImage: true,
      secretInjection: "none",
      filesystemIsolation: true,
    },
    createdByType: "user",
    createdById: "vitest-entry",
  };
}

/** 真实 Thread API：POST /api/threads/{threadId}/turns。 */
async function postTurn(threadId: string, idempotencyKey: string, text: string): Promise<Response> {
  return createTurnPOST(
    buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/turns`,
      idempotencyKey,
      body: { input: { type: "message", text } },
    }),
    { params: Promise.resolve({ threadId }) },
  );
}

async function waitForTurn(
  tenantId: string,
  turnId: string,
  timeoutMs = 30_000,
): Promise<{
  id: string;
  turnState: string;
  errorCode: string | null;
  latestInvocationId: string | null;
}> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const turn = await getTurnById(tenantId, turnId);
    if (turn && ["completed", "failed", "cancelled"].includes(turn.turnState)) return turn;
    if (Date.now() > deadline) {
      const invocations = await listInvocationsForTurn(tenantId, turnId);
      const latest = invocations.at(-1);
      const owner = latest
        ? await getActiveExecutionOwnership({ tenantId, invocationId: latest.id })
        : null;
      const attempts = latest ? await listAttemptsForInvocation(tenantId, latest.id) : [];
      const sessions = latest
        ? await getRuntimeSessionBindingsByInvocation(tenantId, latest.id)
        : [];
      throw new Error(
        `Turn 未在 ${timeoutMs}ms 内到达终态：${JSON.stringify({
          turn: turn?.turnState ?? "缺失",
          invocation: latest?.executionState ?? null,
          owner: owner ? { state: owner.ownershipState, phase: owner.executionPhase } : null,
          attempts: attempts.map((row) => ({ state: row.attemptState, errorCode: row.errorCode })),
          sessions: sessions.map((row) => ({
            state: row.bindingState,
            dispatchCount: row.dispatchCount,
            errorCode: row.lastErrorCode,
            nextDispatchAt: row.nextDispatchAt,
          })),
        })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 测试结束只清理本 Turn 的真实容器；允许正式 Worker 已先行释放。 */
async function removeTestContainerForTurn(tenantId: string, turnId: string): Promise<void> {
  const invocations = await listInvocationsForTurn(tenantId, turnId);
  for (const invocation of invocations) {
    const attempts = await listAttemptsForInvocation(tenantId, invocation.id);
    for (const attempt of attempts) {
      const lease = await getEnvironmentLeaseByAttempt(tenantId, invocation.id, attempt.id);
      const manifest = lease?.resourceManifest as { operationId?: unknown } | undefined;
      if (typeof manifest?.operationId === "string") {
        await removeContainer(managedContainerName(manifest.operationId));
      }
    }
  }
}

/**
 * 登记一个**真实可执行**的 webhook Tool。
 *
 * 每一步都走正式资产发布接口（Connection → Provider → Tool → published SchemaRevision），
 * 没有任何一条记录是测试直接 INSERT 的：能力目录只认这套事实，因此"目录里有这个工具"
 * 本身就证明发布链是通的。
 */
async function seedWebhookTool(input: {
  tenantId: string;
  ownerId: string;
  suffix: string;
}): Promise<{ toolId: string; toolKey: string; schemaRevisionId: string }> {
  const connection = await createConnection({
    tenantId: input.tenantId,
    connectionKey: `entry-conn-${input.suffix}`,
    connectionType: "http",
    endpointRef: providerStub.endpoint,
    authMethod: "none",
    ownerUserId: input.ownerId,
  });
  const enabledConnection = await updateConnection({
    tenantId: input.tenantId,
    connectionId: connection.id,
    expectedVersionNo: connection.versionNo,
    lifecycleState: "enabled",
  });
  const draftProvider = await createToolProvider({
    tenantId: input.tenantId,
    providerKey: `entry-provider-${input.suffix}`,
    providerType: "webhook",
    connectionId: enabledConnection.id,
    displayName: "ENTRY 外部资料 Provider",
    ownerUserId: input.ownerId,
  });
  const provider = await updateToolProvider({
    tenantId: input.tenantId,
    providerId: draftProvider.id,
    expectedVersionNo: draftProvider.versionNo,
    lifecycleState: "enabled",
  });
  const toolKey = `entry-lookup-${input.suffix}`;
  const tool = await createTool({
    tenantId: input.tenantId,
    providerId: provider.id,
    toolKey,
    displayName: "查询外部资料",
    description: "从外部资料服务取回一小段结构化事实。",
    riskClass: "low",
  });
  const revision = await createToolSchemaRevision({
    tenantId: input.tenantId,
    toolId: tool.id,
    createdBy: input.ownerId,
    description: "查询外部资料",
    inputSchemaJson: {
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: { topic: { type: "string", minLength: 1, maxLength: 200 } },
    },
    executionContractJson: {
      timeoutMs: 5_000,
      idempotencySupport: "none",
      sideEffectMode: "read",
      verificationMode: "provider_response",
      responseLimits: { maxBytes: 65_536 },
      providerOperationMetadata: { operation: "lookup" },
    },
  });
  const published = await publishToolSchemaRevision({
    tenantId: input.tenantId,
    schemaRevisionId: revision.id,
    publishedBy: input.ownerId,
  });
  await updateTool({
    tenantId: input.tenantId,
    toolId: published.tool.id,
    expectedVersionNo: published.tool.versionNo,
    lifecycleState: "enabled",
  });
  return { toolId: tool.id, toolKey, schemaRevisionId: revision.id };
}

/** 读取某个 Invocation 的首个 ToolCall（本文件始终只产生一个）。 */
async function getToolCallByInvocation(tenantId: string, invocationId: string) {
  const [call] = await db
    .select()
    .from(toolCallTable)
    .where(and(eq(toolCallTable.tenantId, tenantId), eq(toolCallTable.invocationId, invocationId)))
    .limit(1);
  return call ?? null;
}

/**
 * 等到「模型已按冻结目录发起 tool.call，ToolCall 进入 queued」这个正式状态。
 *
 * Hosted Loop 是**后台**执行的（HTTP 路由不等待它），因此触发 postTurn 之后不能立刻断言
 * 模型侧事实 —— 必须等平台落出可观察的正式状态再断言，否则断言的是时序而不是事实。
 */
async function waitForQueuedToolCall(
  tenantId: string,
  invocationId: string,
  timeoutMs = 30_000,
): Promise<NonNullable<Awaited<ReturnType<typeof getToolCallByInvocation>>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const call = await getToolCallByInvocation(tenantId, invocationId);
    if (call && call.callState === "queued") return call;
    if (Date.now() > deadline) {
      throw new Error(
        `ToolCall 未在 ${timeoutMs}ms 内进入 queued（state=${call?.callState ?? "缺失"}, error=${call?.errorCode ?? "-"}）`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * 驱动真实生产 Worker 完成一次「工具执行 → 父 Invocation 续接」。
 *
 * 两个 Worker 都是生产实现：`tool-execution-worker` 领取 queued ToolCall、按冻结执行合同
 * 真实调用外部 Provider；`invocation-continuation` 消费 outbox 的 continuation 事件并
 * 唤醒父 Harness。测试只负责按部署方式把它们各推一轮，不替它们写任何状态。
 */
async function driveToolCompletionRound(tenantId: string, invocationId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  const toolWorker = createToolExecutionWorker({ allowLoopbackHttp: true });
  for (;;) {
    if ((await toolWorker.runOnce()) !== "idle") break;
    if (Date.now() > deadline) {
      const call = await getToolCallByInvocation(tenantId, invocationId);
      throw new Error(
        `ToolCall 未在 30s 内被正式 Worker 领取（state=${call?.callState ?? "缺失"}, error=${call?.errorCode ?? "-"}）`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await createProductionInvocationContinuationWorker(
    `entry-continuation-${randomUUID()}`,
  ).pollOnce();
}

beforeEach(async () => {
  process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
  process.env.SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT = await temporaryRoot("entry-env-control-");
  // 受管 WorkspaceHost Backend 必须保持「未配置」：ENTRY-01/03 的断言依赖这一点。
  clearEnv("SNOWHARNESS_WORKSPACE_HOST_ROOT");
  clearEnv("SNOWHARNESS_WORKSPACE_HOST_URL");
  environmentControlRoot = process.env.SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT;
  modelStub.reset();
  providerStub.requests.length = 0;
  providerStub.payload = { ok: true };
  await resetDatabase(db);
  await ensureDefaultTenant();
});

/**
 * 登记一个**服务端 Writer**的云端 Workspace 合同（`SHARED_DURABLE`）。
 *
 * 这是真实存在的 Workspace（可被正式合同解析），但它的 Backend（受管 WorkspaceHost）
 * 在本次部署里**未配置** —— 用于验证 MANAGED 执行在其上必须 `WorkspaceNotReady`
 * 而不是被静默替换成 NONE。
 */
async function seedServerSideWorkspace(input: {
  tenantId: string;
  ownerId: string;
  suffix: string;
}): Promise<{ workspaceId: string; bindingId: string }> {
  const logical = await createWorkspace({
    tenantId: input.tenantId,
    workspaceKey: `entry-cloud-${input.suffix}`,
    displayName: "ENTRY 端侧托管 Workspace",
    ownerUserId: input.ownerId,
  });
  const storageScopeDigest = `sha256:${input.suffix
    .padEnd(64, "5")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "b")}`;
  const storageIdentity = storageScopeDigest;
  const hostIdentity = `host-${input.suffix}`;
  const backendKind = "managed_host";
  const filesystemSemantics = {
    kind: "managed",
    caseSensitive: true,
    symlinks: true,
    permissions: true,
    hardlinks: true,
    specialFiles: false,
    xattrsAcl: true,
    mtime: "preserved",
  } as const;
  const contractDigest = computeWorkspaceContractDigest({
    bindingId: "candidate",
    continuityMode: "SHARED_DURABLE",
    storageScopeDigest,
    hostIdentity,
    storageIdentity,
    backendKind,
    filesystemSemantics,
    checkpointPolicy: null,
  });
  const binding = await createWorkspaceBinding({
    tenantId: input.tenantId,
    workspaceId: logical.id,
    continuityMode: "SHARED_DURABLE",
    bindingType: "cloud",
    deviceId: null,
    locationRef: `managed://entry-${input.suffix}`,
    storageScopeDigest,
    backendKind,
    hostIdentity,
    storageIdentity,
    accessMode: "read_write",
    filesystemSemantics,
    checkpointPolicy: null,
    contractDigest,
    createdBy: "entry-fixture",
  });
  // 声明「当前合同」：`resolveDeclaredWorkspaceBinding` 只认 Workspace.defaultBindingId。
  await db
    .update(workspace)
    .set({ defaultBindingId: binding.id, updatedAt: new Date() })
    .where(and(eq(workspace.tenantId, input.tenantId), eq(workspace.id, logical.id)));
  return { workspaceId: logical.id, bindingId: binding.id };
}

/** 把 Thread 声明的 Workspace 指到指定逻辑 Workspace（Thread 设置的正式字段）。 */
async function pointThreadAtWorkspace(
  tenantId: string,
  threadId: string,
  workspaceId: string,
): Promise<void> {
  await db
    .update(threadTable)
    .set({ defaultWorkspaceId: workspaceId })
    .where(and(eq(threadTable.tenantId, tenantId), eq(threadTable.id, threadId)));
}

/** 租户内 NO_PLATFORM_WORKSPACE 合同数量（"不得降 NONE" 的直接计数证据）。 */
async function countNoPlatformWorkspaceBindings(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(workspaceBinding)
    .where(
      and(
        eq(workspaceBinding.tenantId, tenantId),
        eq(workspaceBinding.continuityMode, "NO_PLATFORM_WORKSPACE"),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Thread 下所有 Invocation 的 ExecutionBinding（只回 Workspace 引用，用于"伪正式"判定）。 */
async function listExecutionBindingsForThread(tenantId: string, threadId: string) {
  return db
    .select({
      invocationId: executionBindingTable.invocationId,
      workspaceBindingId: executionBindingTable.workspaceBindingId,
      environmentMode: executionBindingTable.environmentMode,
    })
    .from(executionBindingTable)
    .innerJoin(invocationTable, eq(invocationTable.id, executionBindingTable.invocationId))
    .where(
      and(eq(executionBindingTable.tenantId, tenantId), eq(invocationTable.threadId, threadId)),
    );
}

/**
 * 断言 Binding Authority **拒绝**（而不是落下一份伪正式 Binding）。
 *
 * Authority 有两种正式拒绝形态，都在 Insert 之前的同一事务内发生：
 * - `ExecutionBindingEvidenceError`：锁定证据 / TOCTOU 复验失败；
 * - `EligibilityError`：`validateBindingEligibility` 的资格校验失败（带稳定 `code`）。
 */
async function expectBindingRejected(work: () => Promise<unknown>): Promise<void> {
  const rejection = await work().then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection, "Binding Authority 必须拒绝，而不是留下伪正式 Binding").not.toBeNull();
  const name = rejection instanceof Error ? rejection.name : "";
  expect(["ExecutionBindingEvidenceError", "EligibilityError"]).toContain(name);
}

/** Thread 最近一个 Turn（含终态与错误码）。 */
async function latestTurn(tenantId: string, threadId: string) {
  const turns = await getTurnsByThread(tenantId, threadId);
  return turns.at(-1) ?? null;
}

/**
 * 只接纳、**不调度**：等价于"接纳事务已提交、进程立刻死亡"。
 *
 * 走正式接纳入口 `acceptUserMessageTurn`（与 HTTP Route 同一实现），不伪造 Turn 行。
 */
async function acceptTurnOnly(context: EntryContext, idempotencyKey: string, text: string) {
  const result = await acceptUserMessageTurn({
    tenantId: context.tenantId,
    threadId: context.threadId,
    ownerUserId: context.ownerId,
    content: { text, client_message_id: idempotencyKey },
    actorId: context.ownerId,
    idempotencyKey,
    correlationId: `entry:${idempotencyKey}`,
  });
  return result.turn;
}

async function listInvocationsForTurn(tenantId: string, turnId: string) {
  return db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.turnId, turnId)));
}

async function listAttemptsForInvocation(tenantId: string, invocationId: string) {
  return db
    .select()
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, tenantId),
        eq(invocationAttemptTable.invocationId, invocationId),
      ),
    );
}

/**
 * 维护 lane 的安全窗口之后。
 *
 * `next*At` 为空的半程事实不能永久不可见：静默超过 `DISPATCH_STUCK_GRACE_MS` 即视为到期。
 * 这里只把"现在"推到窗口之后（不修改任何行），因此被测的仍是生产判定。
 */
function afterStuckWindow(): Date {
  return new Date(Date.now() + DISPATCH_STUCK_GRACE_MS + 1_000);
}

/**
 * 把**真实** Runtime Transport 包一层：`startInvocation` 永不返回，其余方法原样透传。
 *
 * 它模拟的是"入口进程在 `execution.started` 发出处停止推进"：此时 Session 意图、Owner
 * 激活事实、Attempt 都已是**持久**事实，而 `nextDispatchAt` 从未被写过（那是失败重试才
 * 写的列）。资源组合仍是生产链（Transport 由 `resolveRuntimeTransportFromBinding` 从
 * 冻结 Binding 解析），只有"这一步不再返回"是被注入的故障。
 */
function stallStartInvocation(client: RuntimeHttpClient): RuntimeHttpClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "startInvocation") return () => new Promise<never>(() => {});
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 等到某 Turn 的 Invocation 出现（入口进程在它之后才可能停在 Transport 处）。 */
async function waitForInvocationForTurn(
  tenantId: string,
  turnId: string,
  timeoutMs = 30_000,
): Promise<NonNullable<Awaited<ReturnType<typeof listInvocationsForTurn>>>[number]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [invocation] = await listInvocationsForTurn(tenantId, turnId);
    if (invocation) return invocation;
    if (Date.now() > deadline)
      throw new Error(`Turn ${turnId} 未在 ${timeoutMs}ms 内建立 Invocation`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ─── ENTRY-01 ───────────────────────────────────────────────

describe("R01 ENTRY 默认生产入口（真实 Thread API + 真实组合层）", () => {
  it("ENTRY-01: 真实 Thread API 使用 MANAGED Environment + HOST_AFFINE Workspace，不注入测试 Resolver", async () => {
    const context = await seedEntryContext("entry01");
    // 前置事实：Thread 的 Workspace 事实由真实解析器解析（不是测试注入的 Resolver）。
    await expect(
      resolveWorkspaceBindingId(context.tenantId, context.desktopWorkspaceId, context.ownerId),
    ).resolves.toBe(context.desktopBindingId);

    const response = await postTurn(context.threadId, "entry01-key", "请读取工作区并回答");
    expect(response.status).toBe(201);
    const accepted = (await response.json()) as { turn: { id: string } };

    const turn = await waitForTurn(context.tenantId, accepted.turn.id);
    expect(turn.turnState).toBe("completed");
    const invocationId = turn.latestInvocationId;
    if (!invocationId) throw new Error("Turn 缺少 latestInvocationId");

    // ── 1. 实际 Binding：真实 WorkspaceBinding（不是 NO_PLATFORM/NONE 降级）──
    const binding = await getExecutionBindingByInvocation(context.tenantId, invocationId);
    if (!binding) throw new Error("ExecutionBinding 缺失");
    expect(binding.environmentMode).toBe("MANAGED");
    expect(binding.environmentDefinitionRevisionId).toBe(context.environmentRevisionId);
    expect(binding.workspaceBindingId).toBe(context.desktopBindingId);

    const workspaceBinding = await getWorkspaceBindingById(
      context.tenantId,
      binding.workspaceBindingId,
    );
    if (!workspaceBinding) throw new Error("WorkspaceBinding 缺失");
    expect(workspaceBinding.continuityMode).toBe("HOST_AFFINE");
    // 「不能降 NONE」：本次调度没有为这个 Thread 造出 NO_PLATFORM_WORKSPACE 绑定。
    expect(workspaceBinding.continuityMode).not.toBe("NO_PLATFORM_WORKSPACE");

    // ── 2. Catalog：由冻结事实重验，且引用同一份 Workspace 契约 ──
    const catalog = verifyCapabilityCatalogSnapshot(
      binding.capabilityCatalogJson,
      binding.capabilityCatalogDigest,
    );
    expect(catalog.sourceRefs).toContain(`runtime-revision:${binding.runtimeRevisionId}`);

    // ── 3. Context 与运行根：ContextHandle / Start 请求 / Lease 三者同一份事实 ──
    const sessions = await getRuntimeSessionBindingsByInvocation(context.tenantId, invocationId);
    expect(sessions.length).toBe(1);
    const session = sessions[0];
    if (!session?.semanticRequestJson) throw new Error("Session 未冻结语义请求");
    // Session 冻结的是**语义域**投影（`buildStartSemanticDigestInput`）：去掉凭据 / trace /
    // callback 与 ContextHandle 的签名时间与 jti。用协议自身导出的子 schema 校验它，
    // 并逐字复核它确实是 `semanticRequestDigest` 的输入。
    const startRequest = FrozenStartSemanticSchema.parse(session.semanticRequestJson);
    expect(protocolDigest(session.semanticRequestJson)).toBe(session.semanticRequestDigest);

    expect(startRequest.context.common.workspace.bindingId).toBe(context.desktopBindingId);
    expect(startRequest.context.common.workspace.contractDigest).toBe(
      workspaceBinding.contractDigest,
    );
    expect(startRequest.context.common.environment).toMatchObject({
      mode: "MANAGED",
      revisionId: context.environmentRevisionId,
    });
    expect(startRequest.workspace).toMatchObject({
      mode: "BOUND",
      bindingId: context.desktopBindingId,
      contractDigest: workspaceBinding.contractDigest,
      continuityMode: "HOST_AFFINE",
    });
    expect(startRequest.environment).toMatchObject({
      mode: "MANAGED",
      revisionId: context.environmentRevisionId,
    });
    // 运行根同源：Start 请求冻结的 Binding 摘要 = ContextHandle 的 Binding 摘要。
    expect(startRequest.executionBinding.bindingDigest).toBe(
      startRequest.context.common.bindingDigest,
    );

    // ── 4. 真实资源准备：真实容器实例 + 真实 docker 回读证据 ──
    const lease = await getEnvironmentLeaseByAttempt(
      context.tenantId,
      invocationId,
      session.attemptId,
    );
    if (!lease) throw new Error("EnvironmentLease 缺失（MANAGED 必须真实准备实例）");
    // A08 8.1：Turn 已 completed ⇒ 统一终态收口已经按生命周期给这份 Lease 登记了真实清理
    // 工作（`releasing` + 清空激活指针），"物理已释放"只由清理 Worker 拿到 Backend 回执后
    // 才写。因此**不能**再用终态之后的 Lease 行来证明"受管环境被激活"——它此刻按定义
    // 已经不在 ready/active 上了。
    expect(lease.leaseState).toBe("releasing");
    expect(lease.releasedAt).toBeNull();
    expect(lease.readinessState).toBe("blocked");
    expect(lease.activationOwnershipId).toBeNull();

    // 激活事实改用持久取证：本 Invocation 的那一代 Ownership 明确绑定这份 Lease
    // （activating 阶段由 `activateEnvironmentLease` 写回互指针）。
    const [activatedOwner] = await db
      .select()
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.id, session.ownershipId))
      .limit(1);
    expect(activatedOwner?.environmentLeaseId).toBe(lease.id);
    // 而且这一代真的在受管环境里把执行跑完了（下面还有 docker_inspect 回读证据）——
    // 这反证 activating 阶段确实把 Lease 推到了 ready+active 并绑定了当前 Owner，
    // 否则 `requireCurrentExecutionAuthority` 会在执行前直接拒绝。
    expect(activatedOwner?.ownershipState).toBe("released");
    expect(activatedOwner?.reasonCode).toBe("execution_terminal");
    expect(lease.environmentDefinitionRevisionId).toBe(context.environmentRevisionId);
    // Lease 自身也冻结了同一份 WorkspaceBinding（运行根同源）。
    expect((lease.resourceManifest as Record<string, unknown>).workspaceBindingId).toBe(
      context.desktopBindingId,
    );
    const evidence = lease.preparedEvidence as {
      verifier?: { kind?: string };
      policyChecks?: Array<{ policy: string; satisfied: boolean }>;
    };
    expect(evidence.verifier?.kind).toBe("docker_inspect");
    for (const check of evidence.policyChecks ?? []) {
      expect(check.satisfied).toBe(true);
    }
    expect(environmentControlRoot.length).toBeGreaterThan(0);
  });

  // ─── ENTRY-02 ─────────────────────────────────────────────

  it("ENTRY-02: 需要 Tool 的任务由平台执行器真实执行，冻结能力与权限生效（不是纯文本直答）", async () => {
    const context = await seedEntryContext("entry02");
    const tool = await seedWebhookTool({
      tenantId: context.tenantId,
      ownerId: context.ownerId,
      suffix: "entry02",
    });
    // 外部 Provider 返回的事实只可能来自真实 HTTP 往返，且刻意与最终正文不同 —— 若模型
    // 直接给出正文而没经过工具，下面的观测断言必然失败。
    providerStub.payload = {
      source: "external-lookup-service",
      facts: [{ key: "release", value: "topic02-closure" }],
    };
    // 模型计划：第一步按冻结目录调用该工具，之后回到正文。
    modelStub.autoTool = { operationId: tool.toolKey, arguments: { topic: "topic02 收尾" } };
    modelStub.finalText = "已按外部资料完成回答。";

    const response = await postTurn(context.threadId, "entry02-key", "请查询外部资料再回答");
    expect(response.status).toBe(201);
    const accepted = (await response.json()) as { turn: { id: string } };
    const acceptedTurn = await getTurnById(context.tenantId, accepted.turn.id);
    const invocationId = acceptedTurn?.latestInvocationId;
    if (!acceptedTurn || !invocationId) {
      throw new Error(
        `Turn 未进入可调度状态（state=${acceptedTurn?.turnState ?? "缺失"}, error=${acceptedTurn?.errorCode ?? "-"}）`,
      );
    }

    // 前置事实：模型必须已经按冻结目录发起 tool.call —— 决策提示确实携带了目录，
    // 且 Turn 因此停在"等待工具"而不是直接给出正文。
    // Hosted Loop 是后台执行：`postTurn` 201 只表示接纳，平台事实要等 Loop 走到工具
    // 阶段才落库，因此这里等正式状态（ToolCall 被领取）而不是等模型侧计数。
    const queuedCall = await waitForQueuedToolCall(context.tenantId, invocationId);
    expect(queuedCall.toolSchemaRevisionId).toBe(tool.schemaRevisionId);
    expect(modelStub.decisionPrompts.at(-1) ?? "").toContain(tool.toolKey);
    const turnWhileWaiting = await getTurnById(context.tenantId, accepted.turn.id);
    expect(turnWhileWaiting?.turnState).not.toBe("completed");

    await driveToolCompletionRound(context.tenantId, invocationId);
    const turn = await waitForTurn(context.tenantId, accepted.turn.id);
    expect(turn.turnState).toBe("completed");

    // ── 1. 平台执行器真的跑了：ToolCall 落到 succeeded ──
    const toolCall = await getToolCallByInvocation(context.tenantId, invocationId);
    if (!toolCall) throw new Error("ToolCall 缺失（模型发起了 tool.call 却没有平台事实）");
    expect(toolCall.toolSchemaRevisionId).toBe(tool.schemaRevisionId);
    expect(toolCall.callState).toBe("succeeded");
    expect(toolCall.errorCode).toBeNull();

    // ── 2. 观测来自真实 Provider 往返（不是模型自述）──
    expect(providerStub.requests.length).toBe(1);
    const providerRequest = providerStub.requests[0];
    if (!providerRequest) throw new Error("Provider 边界未收到请求");
    expect(providerRequest.body).toMatchObject({
      arguments: { topic: "topic02 收尾" },
      context: {
        invocation_id: invocationId,
        tool_call_id: toolCall.id,
        tenant_id: context.tenantId,
      },
    });

    // ── 3. 冻结目录里确实有这个工具，且权限判定记录的正是它 ──
    const binding = await getExecutionBindingByInvocation(context.tenantId, invocationId);
    if (!binding) throw new Error("ExecutionBinding 缺失");
    const catalog = verifyCapabilityCatalogSnapshot(
      binding.capabilityCatalogJson,
      binding.capabilityCatalogDigest,
    );
    expect(catalog.tools.map((entry) => [entry.toolId, entry.operationId])).toContainEqual([
      tool.toolId,
      tool.toolKey,
    ]);
    const decisions = await getPermissionDecisionsByToolCall(context.tenantId, toolCall.id);
    expect(decisions.map((decision) => decision.decision)).toEqual(["allow"]);

    // ── 4. 工具观测经正式事件契约回到 Loop（含真实 Provider 结果）──
    const ingress = await getIngressByInvocation(context.tenantId, invocationId, { limit: 500 });
    const observations = ingress
      .map((row) => HARNESS_ACTION_EVENT_PAYLOAD_SCHEMA.safeParse(row.payloadJson))
      .filter((parsed) => parsed.success)
      .map((parsed) => (parsed.success ? parsed.data : null))
      .filter((payload) => payload?.action_type === "tool.call" && payload.state === "completed")
      .map((payload) => payload?.observation);
    expect(observations.length).toBe(1);
    const observation = observations[0] as {
      summary?: string;
      sourceRefs?: string[];
      data?: { state?: string; result?: unknown };
    };
    // `applyToolCall` 把 Provider 结果写进 `resultSummaryJson`，Executor 再投影成观测。
    expect(observation.data?.state).toBe("succeeded");
    expect(observation.data?.result).toMatchObject({
      source: "external-lookup-service",
      facts: [{ key: "release", value: "topic02-closure" }],
    });
    expect(observation.sourceRefs).toContain(`tool-call:${toolCall.id}`);

    // ── 5. 不是"纯文本直答"：模型被再次询问，并且正文来自末端口 ──
    expect(modelStub.decisionCount).toBeGreaterThanOrEqual(2);
    expect(modelStub.finalResponseCount).toBe(1);
    // 第二次决策的提示里必须已经带上工具观测（否则"执行了工具"没有回流到模型）。
    expect(modelStub.decisionPrompts.at(-1)).toContain("external-lookup-service");
  });

  // ─── ENTRY-03 ─────────────────────────────────────────────

  it("ENTRY-03: 真实 Workspace 存在但 Backend 不可用 → WorkspaceNotReady 明确失败，不创建 NONE Binding", async () => {
    const context = await seedEntryContext("entry03");

    // ── 1. Workspace 合同真实存在（SHARED_DURABLE / 服务端 Writer）但部署未配置受管
    //      WorkspaceHost Backend（beforeEach 显式保持未配置）──
    const serverSide = await seedServerSideWorkspace({
      tenantId: context.tenantId,
      ownerId: context.ownerId,
      suffix: "entry03",
    });
    await pointThreadAtWorkspace(context.tenantId, context.threadId, serverSide.workspaceId);
    // "真实 Workspace 存在"这一事实成立：正式合同解析得到该 Binding（不是解析不到）。
    await expect(
      resolveDeclaredWorkspaceBinding(context.tenantId, serverSide.workspaceId, context.ownerId),
    ).resolves.toMatchObject({
      id: serverSide.bindingId,
      continuityMode: "SHARED_DURABLE",
    });

    // MANAGED 执行携带了该 Workspace 合同 → 必须 WorkspaceNotReady 明确失败，
    // 而不是静默换成 NO_PLATFORM_WORKSPACE 合同继续跑。
    await expect(
      postTurn(context.threadId, "entry03-backend", "请读取工作区并回答"),
    ).rejects.toMatchObject({ name: "WorkspaceNotReady", stableCode: "WorkspaceNotReady" });

    const backendUnavailableTurn = await latestTurn(context.tenantId, context.threadId);
    expect(backendUnavailableTurn?.turnState).toBe("failed");
    // 不创建 NONE Binding：租户内不存在任何 NO_PLATFORM_WORKSPACE 合同。
    expect(await countNoPlatformWorkspaceBindings(context.tenantId)).toBe(0);
    // 已经落下的执行图只能引用真实 Workspace 合同（没有"引用真实 Workspace 却按 NONE 跑"）。
    const bindingsAfterBackendFailure = await listExecutionBindingsForThread(
      context.tenantId,
      context.threadId,
    );
    for (const binding of bindingsAfterBackendFailure) {
      expect(binding.workspaceBindingId).toBe(serverSide.bindingId);
      expect(binding.environmentMode).toBe("MANAGED");
    }

    // ── 2. 真实 Workspace 存在但 Backend（绑定设备）已被撤销 → 同样 fail closed ──
    await pointThreadAtWorkspace(context.tenantId, context.threadId, context.desktopWorkspaceId);
    await revokeDevice(context.tenantId, context.deviceKey);
    // Workspace 行本身仍在（不是"Workspace 被删除了"）。
    expect(await getWorkspaceById(context.tenantId, context.desktopWorkspaceId)).not.toBeNull();
    expect(
      await resolveDeclaredWorkspaceBinding(
        context.tenantId,
        context.desktopWorkspaceId,
        context.ownerId,
      ),
    ).toBeNull();

    await expect(
      postTurn(context.threadId, "entry03-revoked", "请读取工作区并回答"),
    ).rejects.toMatchObject({ name: "WorkspaceNotReady", stableCode: "WorkspaceNotReady" });
    expect((await latestTurn(context.tenantId, context.threadId))?.turnState).toBe("failed");
    expect(await countNoPlatformWorkspaceBindings(context.tenantId)).toBe(0);
  });

  // ─── ENTRY-04 ─────────────────────────────────────────────

  it("ENTRY-04: 接纳后 / 执行图各阶段提交后终止入口进程，正式 Worker 发现全部半程意图且不重建另一逻辑执行", async () => {
    const context = await seedEntryContext("entry04");

    // ── 断点 A：Turn 接纳事务已提交，执行图尚未建立 ──
    const admissionTurn = await acceptTurnOnly(context, "entry04-admission", "请读取工作区并回答");
    expect(await listInvocationsForTurn(context.tenantId, admissionTurn.id)).toEqual([]);
    // 半程事实是**持久**事实：维护 lane 必须能发现它（不是只活在那个 HTTP 栈里）。
    const admissionCandidates = await scanUndispatchedAcceptedTurns({
      now: afterStuckWindow(),
      limit: 10,
    });
    expect(admissionCandidates.map((candidate) => candidate.turnId)).toContain(admissionTurn.id);

    const admissionSummary = await runDueUndispatchedIntentRecoveries({ now: afterStuckWindow() });
    expect(admissionSummary.turns.recovered).toBeGreaterThanOrEqual(1);

    const recoveredTurn = await waitForTurn(context.tenantId, admissionTurn.id);
    expect(recoveredTurn.turnState).toBe("completed");
    // 不重建另一逻辑执行：该 Turn 恰好一个 Invocation。
    expect(await listInvocationsForTurn(context.tenantId, admissionTurn.id)).toHaveLength(1);

    // ── 断点 B：Invocation/Binding/Attempt 已提交，Session 尚未写入 ──
    const preparationTurn = await acceptTurnOnly(context, "entry04-preparation", "继续读取工作区");
    const dispatched = await dispatchInvocationForTurn({
      tenantId: context.tenantId,
      turnId: preparationTurn.id,
      executionSubject: {
        tenantId: context.tenantId,
        subjectType: "user",
        subjectId: context.ownerId,
      },
      // 进程死在 Transport 发出之前：入口已建好执行图，但没有任何 Session/Owner。
    });
    const invocation = dispatched.invocation;
    const attempt = dispatched.attempt;
    if (!dispatched.dispatched || !invocation || !attempt) {
      throw new Error("执行图未建立，无法构造 preparation 断点");
    }
    expect(await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id)).toEqual(
      [],
    );
    expect((await getTurnById(context.tenantId, preparationTurn.id))?.turnState).toBe("queued");
    const preparationCandidates = await scanUndispatchedInvocations({
      now: afterStuckWindow(),
      limit: 10,
    });
    expect(preparationCandidates.map((candidate) => candidate.invocationId)).toContain(
      invocation.id,
    );

    const preparationSummary = await runDueUndispatchedIntentRecoveries({
      now: afterStuckWindow(),
    });
    expect(preparationSummary.invocations.recovered).toBeGreaterThanOrEqual(1);

    const preparationSettled = await waitForTurn(context.tenantId, preparationTurn.id);
    expect(preparationSettled.turnState).toBe("completed");
    // 复用既有 Attempt（不产生第二个候选），Session 恰一个且已走完单向生命周期
    // （`dispatching → active → closed`）—— 不停留在任何可派发状态，即"不永久 queued"。
    const attempts = await listAttemptsForInvocation(context.tenantId, invocation.id);
    expect(attempts.map((row) => row.id)).toEqual([attempt.id]);
    const sessions = await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.bindingState).toBe("closed");
    expect(sessions[0]?.closedAt).not.toBeNull();
    expect(await listInvocationsForTurn(context.tenantId, preparationTurn.id)).toHaveLength(1);
  });

  it("R2-a: 初次调度在准备 claim 后真实进程死亡，正式 Worker 在租期越过后复用唯一候选", async () => {
    const context = await seedEntryContext("r2a");
    const turn = await acceptTurnOnly(context, "r2a-crash", "请读取工作区并回答");
    const child = spawnInitialDispatchCrashProcess({
      tenantId: context.tenantId,
      turnId: turn.id,
      ownerId: context.ownerId,
      stage: "after_claim",
    });
    try {
      await child.barrier;
      const [invocation] = await listInvocationsForTurn(context.tenantId, turn.id);
      if (!invocation) throw new Error("子进程未建立 Invocation");
      const [before] = await listAttemptsForInvocation(context.tenantId, invocation.id);
      if (
        !before?.preparationClaimId ||
        !before.preparationIntentKey ||
        !before.preparationRequestDigest ||
        !before.preparationSourceJson ||
        !before.preparationLeaseExpiresAt
      )
        throw new Error("子进程未提交准备来源与 claim");
      expect(before.preparationState).toBe("preparing");
      expect(await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id)).toEqual(
        [],
      );
      const oldClaim = {
        tenantId: context.tenantId,
        invocationId: invocation.id,
        attemptId: before.id,
        intentKey: before.preparationIntentKey,
        requestDigest: before.preparationRequestDigest,
        claimId: before.preparationClaimId,
        source: assertExecutionSourceSnapshot(before.preparationSourceJson),
      };
      const leaseExpiresAt = before.preparationLeaseExpiresAt;
      child.kill();
      expect((await child.exited).signal).toBe("SIGKILL");
      const databaseNow = await getAuthorityDatabaseTime(db);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, leaseExpiresAt.getTime() - databaseNow.getTime() + 1_000)),
      );
      const recovered = await runDueUndispatchedIntentRecoveries({ now: new Date() });
      expect(recovered.invocations.recovered).toBeGreaterThanOrEqual(1);
      expect((await waitForTurn(context.tenantId, turn.id)).turnState).toBe("completed");
      const attempts = await listAttemptsForInvocation(context.tenantId, invocation.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.id).toBe(before.id);
      expect(attempts[0]?.preparationRequestDigest).toBe(before.preparationRequestDigest);
      expect(attempts[0]?.preparationSourceJson).toEqual(before.preparationSourceJson);
      expect(attempts[0]?.preparationClaimId).not.toBe(before.preparationClaimId);
      await expect(assertAttemptPreparationClaimHeld(oldClaim)).rejects.toThrow(
        "PreparationClaimSuperseded",
      );
      expect(
        await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id),
      ).toHaveLength(1);
    } finally {
      child.kill();
      await child.exited;
      await removeTestContainerForTurn(context.tenantId, turn.id);
    }
  }, 120_000);

  it("R2-b: 真实容器 Lease Prepared 后进程死亡，正式 Worker 回读同一资源并完成 Attempt", async () => {
    const context = await seedEntryContext("r2b");
    const turn = await acceptTurnOnly(context, "r2b-crash", "请读取工作区并回答");
    const child = spawnInitialDispatchCrashProcess({
      tenantId: context.tenantId,
      turnId: turn.id,
      ownerId: context.ownerId,
      stage: "after_lease_prepared",
    });
    try {
      await child.barrier;
      const [invocation] = await listInvocationsForTurn(context.tenantId, turn.id);
      if (!invocation) throw new Error("子进程未建立 Invocation");
      const [attempt] = await listAttemptsForInvocation(context.tenantId, invocation.id);
      if (!attempt?.preparationLeaseExpiresAt) throw new Error("子进程未提交准备 claim");
      const lease = await getEnvironmentLeaseByAttempt(context.tenantId, invocation.id, attempt.id);
      if (!lease) throw new Error("子进程未提交 EnvironmentLease");
      expect(attempt.preparationState).toBe("preparing");
      expect(lease.readinessState).toBe("prepared");
      expect(lease.preparedEvidence).not.toBeNull();
      expect(await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id)).toEqual(
        [],
      );
      const manifest = lease.resourceManifest as { operationId?: string };
      if (!manifest.operationId) throw new Error("Prepared Lease 缺少 operationId");
      const containerName = managedContainerName(manifest.operationId);
      const physicalBefore = await inspectContainer(containerName);
      expect(physicalBefore).not.toBeNull();
      child.kill();
      expect((await child.exited).signal).toBe("SIGKILL");
      const databaseNow = await getAuthorityDatabaseTime(db);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, attempt.preparationLeaseExpiresAt!.getTime() - databaseNow.getTime() + 1_000),
        ),
      );
      const recovered = await runDueUndispatchedIntentRecoveries({ now: new Date() });
      expect(recovered.invocations.recovered).toBeGreaterThanOrEqual(1);
      expect((await waitForTurn(context.tenantId, turn.id)).turnState).toBe("completed");
      const attempts = await listAttemptsForInvocation(context.tenantId, invocation.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.id).toBe(attempt.id);
      expect(attempts[0]?.preparationState).toBe("prepared");
      const resumedLease = await getEnvironmentLeaseByAttempt(
        context.tenantId,
        invocation.id,
        attempt.id,
      );
      expect(resumedLease?.id).toBe(lease.id);
      expect((resumedLease?.resourceManifest as { operationId?: string }).operationId).toBe(
        manifest.operationId,
      );
      const physicalAfter = await inspectContainer(containerName);
      expect(physicalAfter?.Id).toBe(physicalBefore?.Id);
      expect(
        await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id),
      ).toHaveLength(1);
    } finally {
      child.kill();
      await child.exited;
      await removeTestContainerForTurn(context.tenantId, turn.id);
    }
  }, 120_000);

  it("R2-c: Attempt Prepared 已提交但尚无 Owner/Session 时进程死亡，正式 Worker 原地继续", async () => {
    const context = await seedEntryContext("r2c");
    const turn = await acceptTurnOnly(context, "r2c-crash", "请读取工作区并回答");
    // 测试库的临时触发器只阻塞 O INSERT：让真实 dispatcher 自己提交 Prepared，
    // 然后在下一事务被 SQL 挡住。父进程 SIGKILL 后删除触发器，恢复仍走正式 Worker。
    await db.execute(
      sql.raw(
        "CREATE TRIGGER topic02_r2c_before_owner BEFORE INSERT ON ExecutionOwnership FOR EACH ROW DO SLEEP(60)",
      ),
    );
    const child = spawnInitialDispatchCrashProcess({
      tenantId: context.tenantId,
      turnId: turn.id,
      ownerId: context.ownerId,
      stage: "before_owner",
    });
    try {
      let invocation: Awaited<ReturnType<typeof listInvocationsForTurn>>[number] | undefined;
      let attempt: Awaited<ReturnType<typeof listAttemptsForInvocation>>[number] | undefined;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        [invocation] = await listInvocationsForTurn(context.tenantId, turn.id);
        if (invocation)
          [attempt] = await listAttemptsForInvocation(context.tenantId, invocation.id);
        if (attempt?.preparationState === "prepared") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!invocation || !attempt || attempt.preparationState !== "prepared") {
        throw new Error(`子进程未提交 Attempt Prepared：${child.stderr()}`);
      }
      const beforeDigest = attempt.preparationRequestDigest;
      const beforeSource = attempt.preparationSourceJson;
      const lease = await getEnvironmentLeaseByAttempt(context.tenantId, invocation.id, attempt.id);
      expect(lease?.readinessState).toBe("prepared");
      expect(
        await db
          .select()
          .from(executionOwnershipTable)
          .where(
            and(
              eq(executionOwnershipTable.tenantId, context.tenantId),
              eq(executionOwnershipTable.invocationId, invocation.id),
            ),
          ),
      ).toHaveLength(0);
      expect(await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id)).toEqual(
        [],
      );
      child.kill();
      expect((await child.exited).signal).toBe("SIGKILL");
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS topic02_r2c_before_owner"));
      const databaseNow = await getAuthorityDatabaseTime(db);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(
            0,
            invocation.updatedAt.getTime() +
              DISPATCH_STUCK_GRACE_MS -
              databaseNow.getTime() +
              1_000,
          ),
        ),
      );
      const recovered = await runDueUndispatchedIntentRecoveries({ now: new Date() });
      expect(recovered.invocations.recovered).toBeGreaterThanOrEqual(1);
      expect((await waitForTurn(context.tenantId, turn.id)).turnState).toBe("completed");
      const attempts = await listAttemptsForInvocation(context.tenantId, invocation.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.preparationState).toBe("prepared");
      expect(attempts[0]?.preparationRequestDigest).toBe(beforeDigest);
      expect(attempts[0]?.preparationSourceJson).toEqual(beforeSource);
      const owners = await db
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, context.tenantId),
            eq(executionOwnershipTable.invocationId, invocation.id),
          ),
        );
      expect(owners).toHaveLength(1);
      const sessions = await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.startedEventId).not.toBeNull();
      expect(
        (await getEnvironmentLeaseByAttempt(context.tenantId, invocation.id, attempt.id))?.id,
      ).toBe(lease?.id);
    } finally {
      child.kill();
      await child.exited;
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS topic02_r2c_before_owner"));
      await removeTestContainerForTurn(context.tenantId, turn.id);
    }
  }, 120_000);

  it("R2-d: NO_PLATFORM 的准备进程死亡后按原来源接续且不伪造 Lease", async () => {
    const { seedDispatchableTurn } = await import("@/lib/test-support/seed-dispatchable-turn");
    const seed = await seedDispatchableTurn({ contentSuffix: "r2d" });
    const child = spawnInitialDispatchCrashProcess({
      tenantId: seed.tenantId,
      turnId: seed.turnId,
      ownerId: seed.ownerId,
      stage: "after_claim",
    });
    try {
      await child.barrier;
      const [invocation] = await listInvocationsForTurn(seed.tenantId, seed.turnId);
      if (!invocation) throw new Error("NO_PLATFORM 子进程未建立 Invocation");
      const [before] = await listAttemptsForInvocation(seed.tenantId, invocation.id);
      if (!before?.preparationLeaseExpiresAt) throw new Error("NO_PLATFORM 子进程未提交准备 claim");
      const beforeDigest = before.preparationRequestDigest;
      const beforeSource = before.preparationSourceJson;
      expect(
        await getEnvironmentLeaseByAttempt(seed.tenantId, invocation.id, before.id),
      ).toBeNull();
      child.kill();
      expect((await child.exited).signal).toBe("SIGKILL");
      const databaseNow = await getAuthorityDatabaseTime(db);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, before.preparationLeaseExpiresAt!.getTime() - databaseNow.getTime() + 1_000),
        ),
      );
      const recovered = await runDueUndispatchedIntentRecoveries({ now: new Date() });
      expect(recovered.invocations.recovered).toBeGreaterThanOrEqual(1);
      expect((await waitForTurn(seed.tenantId, seed.turnId)).turnState).toBe("completed");
      const attempts = await listAttemptsForInvocation(seed.tenantId, invocation.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.preparationRequestDigest).toBe(beforeDigest);
      expect(attempts[0]?.preparationSourceJson).toEqual(beforeSource);
      expect(
        await getEnvironmentLeaseByAttempt(seed.tenantId, invocation.id, before.id),
      ).toBeNull();
    } finally {
      child.kill();
      await child.exited;
    }
  }, 120_000);

  it(
    "R2-e: Prepared 证据实际过期后，正式 Worker 真实回读原容器并以原 Revision 续写证据",
    async () => {
      const context = await seedEntryContext("r2e-existing");
      const turn = await acceptTurnOnly(context, "r2e-existing", "请读取工作区并回答");
      const child = spawnInitialDispatchCrashProcess({
        tenantId: context.tenantId,
        turnId: turn.id,
        ownerId: context.ownerId,
        stage: "after_lease_prepared",
      });
      try {
        await child.barrier;
        const [invocation] = await listInvocationsForTurn(context.tenantId, turn.id);
        if (!invocation) throw new Error("子进程未建立 Invocation");
        const [attempt] = await listAttemptsForInvocation(context.tenantId, invocation.id);
        if (!attempt) throw new Error("子进程未建立 Attempt");
        expect(attempt.preparationState).toBe("preparing");
        expect(
          (await getExecutionBindingByInvocation(context.tenantId, invocation.id))?.environmentMode,
        ).toBe("MANAGED");
        const lease = await getEnvironmentLeaseByAttempt(
          context.tenantId,
          invocation.id,
          attempt.id,
        );
        if (!lease) throw new Error("子进程未提交 Prepared Lease");
        const evidence = lease.preparedEvidence as { expiresAt?: string };
        const manifest = lease.resourceManifest as { operationId?: string };
        if (!evidence.expiresAt || !manifest.operationId) throw new Error("Prepared 证据不完整");
        const containerName = managedContainerName(manifest.operationId);
        const physicalBefore = await inspectContainer(containerName);
        expect(physicalBefore).not.toBeNull();
        child.kill();
        expect((await child.exited).signal).toBe("SIGKILL");
        const databaseNow = await getAuthorityDatabaseTime(db);
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, Date.parse(evidence.expiresAt!) - databaseNow.getTime() + 1_000),
          ),
        );
        const recovered = await runDueUndispatchedIntentRecoveries({ now: new Date() });
        expect(recovered.invocations.recovered).toBeGreaterThanOrEqual(1);
        expect((await waitForTurn(context.tenantId, turn.id)).turnState).toBe("completed");
        const renewed = await getEnvironmentLeaseByAttempt(
          context.tenantId,
          invocation.id,
          attempt.id,
        );
        expect(renewed?.id).toBe(lease.id);
        expect(renewed?.environmentDefinitionRevisionId).toBe(context.environmentRevisionId);
        expect(renewed?.preparedDigest).not.toBe(lease.preparedDigest);
        expect(
          Date.parse((renewed?.preparedEvidence as { expiresAt: string }).expiresAt),
        ).toBeGreaterThan(Date.parse(evidence.expiresAt));
        expect((await inspectContainer(containerName))?.Id).toBe(physicalBefore?.Id);
        expect(await listAttemptsForInvocation(context.tenantId, invocation.id)).toHaveLength(1);
      } finally {
        child.kill();
        await child.exited;
        await removeTestContainerForTurn(context.tenantId, turn.id);
      }
    },
    ENVIRONMENT_PREPARED_TTL_MS + 90_000,
  );

  it(
    "R2-e: Prepared 证据过期且原容器丢失后，正式 Worker 以原 operation 幂等重建",
    async () => {
      const context = await seedEntryContext("r2e-missing");
      const turn = await acceptTurnOnly(context, "r2e-missing", "请读取工作区并回答");
      const child = spawnInitialDispatchCrashProcess({
        tenantId: context.tenantId,
        turnId: turn.id,
        ownerId: context.ownerId,
        stage: "after_lease_prepared",
      });
      try {
        await child.barrier;
        const [invocation] = await listInvocationsForTurn(context.tenantId, turn.id);
        if (!invocation) throw new Error("子进程未建立 Invocation");
        const [attempt] = await listAttemptsForInvocation(context.tenantId, invocation.id);
        if (!attempt) throw new Error("子进程未建立 Attempt");
        const lease = await getEnvironmentLeaseByAttempt(
          context.tenantId,
          invocation.id,
          attempt.id,
        );
        if (!lease) throw new Error("子进程未提交 Prepared Lease");
        const evidence = lease.preparedEvidence as { expiresAt?: string };
        const manifest = lease.resourceManifest as { operationId?: string };
        if (!evidence.expiresAt || !manifest.operationId) throw new Error("Prepared 证据不完整");
        const evidenceExpiresAt = evidence.expiresAt;
        const containerName = managedContainerName(manifest.operationId);
        const physicalBefore = await inspectContainer(containerName);
        expect(physicalBefore).not.toBeNull();
        child.kill();
        expect((await child.exited).signal).toBe("SIGKILL");
        await removeContainer(containerName);
        expect(await inspectContainer(containerName)).toBeNull();
        const databaseNow = await getAuthorityDatabaseTime(db);
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, Date.parse(evidenceExpiresAt) - databaseNow.getTime() + 1_000),
          ),
        );
        const recovered = await runDueUndispatchedIntentRecoveries({ now: new Date() });
        expect(recovered.invocations.recovered).toBeGreaterThanOrEqual(1);
        expect((await waitForTurn(context.tenantId, turn.id)).turnState).toBe("completed");
        const renewed = await getEnvironmentLeaseByAttempt(
          context.tenantId,
          invocation.id,
          attempt.id,
        );
        expect(renewed?.id).toBe(lease.id);
        expect(renewed?.environmentDefinitionRevisionId).toBe(context.environmentRevisionId);
        expect((renewed?.resourceManifest as { operationId: string }).operationId).toBe(
          manifest.operationId,
        );
        expect(renewed?.preparedDigest).not.toBe(lease.preparedDigest);
        expect(
          Date.parse((renewed?.preparedEvidence as { expiresAt: string }).expiresAt),
        ).toBeGreaterThan(Date.parse(evidenceExpiresAt));
        const physicalAfter = await inspectContainer(containerName);
        expect(physicalAfter).not.toBeNull();
        expect(physicalAfter?.Id).not.toBe(physicalBefore?.Id);
        const attempts = await listAttemptsForInvocation(context.tenantId, invocation.id);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.preparationState).toBe("prepared");
      } finally {
        child.kill();
        await child.exited;
        await removeTestContainerForTurn(context.tenantId, turn.id);
      }
    },
    ENVIRONMENT_PREPARED_TTL_MS + 90_000,
  );

  // ─── ENTRY-05 ─────────────────────────────────────────────

  it("ENTRY-05: Owner 已激活、Session 意图已写入、首次 nextDispatchAt 之前进程死亡 → Worker 按正式状态恢复", async () => {
    const context = await seedEntryContext("entry05");
    const turn = await acceptTurnOnly(context, "entry05-session-intent", "请读取工作区再回答");

    // 真实 Transport（由冻结 Binding 经唯一组合层解析），只把 `startInvocation` 换成"永不返回"。
    // 入口进程停在 Transport 调用处，因此 Owner 激活事实与 Session 启动意图都已是**持久**
    // 事实，而 `nextDispatchAt` 从未被写过（该列只由失败重试排定写入）。
    let realClient: RuntimeHttpClient | null = null;
    const clientStalledAtTransport = new Proxy({} as RuntimeHttpClient, {
      get(_target, property) {
        if (property === "startInvocation") return () => new Promise<never>(() => {});
        if (!realClient) throw new Error("真实 Runtime Transport 尚未解析");
        const value = Reflect.get(realClient, property);
        return typeof value === "function" ? value.bind(realClient) : value;
      },
    });

    const stalledDispatch = dispatchInvocationForTurn({
      tenantId: context.tenantId,
      turnId: turn.id,
      executionSubject: {
        tenantId: context.tenantId,
        subjectType: "user",
        subjectId: context.ownerId,
      },
      runtimeClient: clientStalledAtTransport,
      runtimeEndpointResolver: async (frozenBinding) => {
        const transport = await resolveRuntimeTransportFromBinding({
          tenantId: context.tenantId,
          binding: frozenBinding,
        });
        realClient = transport.runtimeClient;
        return {
          runtimeEndpoint: transport.runtimeEndpoint,
          auth: transport.auth,
          callbackEndpoints: buildGatewayEndpoints({
            external: !transport.hosted,
            invocationId: frozenBinding.invocationId,
          }),
        };
      },
    });
    void stalledDispatch.catch(() => undefined);

    const invocation = await waitForInvocationForTurn(context.tenantId, turn.id);
    // 崩溃点的正式事实：Owner 已激活、Session 意图已冻结且**从未排定过重试**。
    const crashDeadline = Date.now() + 30_000;
    let session:
      | Awaited<ReturnType<typeof getRuntimeSessionBindingsByInvocation>>[number]
      | undefined;
    let owner: Awaited<ReturnType<typeof getActiveExecutionOwnership>> = null;
    for (;;) {
      [session] = await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id);
      owner = await getActiveExecutionOwnership({
        tenantId: context.tenantId,
        invocationId: invocation.id,
      });
      if (
        session?.bindingState === "dispatching" &&
        owner?.executionPhase === "dispatching" &&
        owner.activationEvidence
      ) {
        break;
      }
      if (Date.now() > crashDeadline) {
        throw new Error(
          `崩溃点状态未出现（session=${session?.bindingState ?? "缺失"}, owner=${owner?.executionPhase ?? "缺失"}）`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!session) throw new Error("Session 缺失");
    expect(session.semanticRequestDigest).toBeTruthy();
    expect(session.nextDispatchAt).toBeNull();
    expect(owner?.activatedAt).toBeTruthy();
    const [attempt] = await listAttemptsForInvocation(context.tenantId, invocation.id);
    if (!attempt) throw new Error("Attempt 缺失");
    expect(attempt.attemptState).toBe("queued");
    expect(realClient).not.toBeNull();

    // ── 正式 Worker 按正式状态恢复：此后测试只读，不再手动调用任何后续仓储 ──
    const worker = createRuntimeDispatchRetryWorker({
      workerId: `entry05-worker-${randomUUID()}`,
      clock: () => afterStuckWindow(),
    });
    expect((await worker.tick()).attempts).toBeGreaterThanOrEqual(1);

    const settled = await waitForTurn(context.tenantId, turn.id);
    expect(settled.turnState).toBe("completed");

    const sessions = await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id);
    // 同一 Session generation 被真正交付（单向生命周期走到 closed），而不是新建第二个。
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(session.id);
    expect(sessions[0]?.bindingState).toBe("closed");
    // 恰好一次重新交付（崩溃点已经计过一次），Attempt 复用未变。
    expect(sessions[0]?.dispatchCount).toBe(session.dispatchCount + 1);
    expect(
      (await listAttemptsForInvocation(context.tenantId, invocation.id)).map((row) => row.id),
    ).toEqual([attempt.id]);
    expect(await listInvocationsForTurn(context.tenantId, turn.id)).toHaveLength(1);
  });

  // ─── ENTRY-06 ─────────────────────────────────────────────

  it("ENTRY-06: 错误租户 / 未发布 Runtime / 错 Policy·Route 证据被同一 Binding Authority 拒绝，事务无伪正式 Binding", async () => {
    const context = await seedEntryContext("entry06");

    // 正式 Thread 入口先建出一份**真实** Binding —— 它是"同一 Authority"的参照事实：
    // Thread 调度（`lib/runtime/dispatcher.ts`）与 Job 接纳（`lib/job/job-admission.ts`）
    // 都使用 `createCreateExecutionBinding({ store: mysqlExecutionBindingStore })` 这一对实现。
    const response = await postTurn(context.threadId, "entry06-ok", "请读取工作区并回答");
    expect(response.status).toBe(201);
    const accepted = (await response.json()) as { turn: { id: string } };
    const referenceTurn = await waitForTurn(context.tenantId, accepted.turn.id);
    expect(referenceTurn.turnState).toBe("completed");
    const referenceInvocationId = referenceTurn.latestInvocationId;
    if (!referenceInvocationId) throw new Error("Turn 缺少 latestInvocationId");
    const reference = await getExecutionBindingByInvocation(
      context.tenantId,
      referenceInvocationId,
    );
    if (!reference) throw new Error("真实 Thread 入口未产出 ExecutionBinding");

    const authority = createCreateExecutionBinding({ store: mysqlExecutionBindingStore });
    const baseConfig: ExecutionBindingConfigInput = {
      runtimeRevisionId: reference.runtimeRevisionId,
      deploymentRouteId: reference.deploymentRouteId,
      modelProvider: reference.modelProvider,
      modelId: reference.modelId,
      modelRevisionRef: reference.modelRevisionRef,
      workspaceBindingId: reference.workspaceBindingId,
      policyRevisionId: reference.policyRevisionId,
      policyRulesDigest: reference.policyRulesDigest,
      governanceConfigRevisionId: reference.governanceConfigRevisionId,
      governanceConfigDigest: reference.governanceConfigDigest,
      environmentDefinitionRevisionId: reference.environmentDefinitionRevisionId,
      environmentMode: reference.environmentMode,
      capabilityCatalogJson: reference.capabilityCatalogJson,
      capabilityCatalogDigest: reference.capabilityCatalogDigest,
      capabilityCatalogVersion: reference.capabilityCatalogVersion,
      capabilityCatalogSourceRefs: reference.capabilityCatalogSourceRefs,
      capabilityCatalogCreatedAt: reference.capabilityCatalogCreatedAt,
      controlPlaneEvidence: {
        routeRevisionId: reference.routeRevisionId,
        routeActivationId: reference.routeActivationId,
        routeContentDigest: reference.routeContentDigest,
        runtimeArtifactId: reference.runtimeArtifactId,
        runtimeArtifactDigest: reference.runtimeArtifactDigest,
        runtimeEvidenceKind: reference.runtimeEvidenceKind,
        runtimeConfigDigest: reference.runtimeConfigDigest,
        runtimeTargetDigest: reference.runtimeTargetDigest,
        capabilityManifestDigest: reference.capabilityManifestDigest,
        runtimeAttestationIds: [...reference.runtimeAttestationIds],
        runtimePublicationRecordId: reference.runtimePublicationRecordId,
        conformanceRunId: reference.conformanceRunId,
        resolutionInputDigest: reference.resolutionInputDigest,
      },
      projectionVersionNo: reference.projectionVersionNo,
      principalType: reference.principalType,
      principalId: reference.principalId,
      principalSource: reference.principalSource,
      principalFrozenAt: reference.principalFrozenAt,
      initialContextCompression: null,
    };

    // 每个反例都用**独立的** Invocation：否则会先撞上 1:1 的既存 Binding 检查。
    const freshInvocation = async (suffix: string) => {
      const turn = await acceptTurnOnly(context, `entry06-${suffix}`, "请读取工作区并回答");
      const { invocation } = await createInvocation({
        tenantId: context.tenantId,
        threadId: context.threadId,
        turnId: turn.id,
        triggerItemId: turn.triggerItemId ?? null,
        invocationKind: "initial",
      });
      return invocation;
    };

    // (a) 错误租户
    const tenantMismatch = await freshInvocation("tenant");
    await expectBindingRejected(() =>
      authority({ ...baseConfig, invocationId: tenantMismatch.id, tenantId: randomUUID() }),
    );
    expect(await getExecutionBindingByInvocation(context.tenantId, tenantMismatch.id)).toBeNull();

    // (b) 错 Route 证据（冻结的 RouteRevision 与当前 Activation 不一致）
    const routeMismatch = await freshInvocation("route-evidence");
    await expectBindingRejected(() =>
      authority({
        ...baseConfig,
        invocationId: routeMismatch.id,
        tenantId: context.tenantId,
        controlPlaneEvidence: {
          ...baseConfig.controlPlaneEvidence,
          routeRevisionId: randomUUID(),
        },
      }),
    );
    expect(await getExecutionBindingByInvocation(context.tenantId, routeMismatch.id)).toBeNull();

    // (c) 错 Policy 证据
    const policyMismatch = await freshInvocation("policy-evidence");
    await expectBindingRejected(() =>
      authority({
        ...baseConfig,
        invocationId: policyMismatch.id,
        tenantId: context.tenantId,
        policyRevisionId: randomUUID(),
      }),
    );
    expect(await getExecutionBindingByInvocation(context.tenantId, policyMismatch.id)).toBeNull();

    // (d) 未发布 Runtime：把真实 RuntimeRevision 从 published 摘到 draft（部署事实变化，
    //     与"设备撤销"同类），Binding Authority 必须拒绝而不是照旧冻结。
    const draftInvocation = await freshInvocation("draft-runtime");
    await db
      .update(runtimeRevisionTable)
      .set({ revisionState: "draft" })
      .where(eq(runtimeRevisionTable.id, reference.runtimeRevisionId));
    try {
      await expectBindingRejected(() =>
        authority({ ...baseConfig, invocationId: draftInvocation.id, tenantId: context.tenantId }),
      );
    } finally {
      await db
        .update(runtimeRevisionTable)
        .set({ revisionState: "published" })
        .where(eq(runtimeRevisionTable.id, reference.runtimeRevisionId));
    }
    expect(await getExecutionBindingByInvocation(context.tenantId, draftInvocation.id)).toBeNull();

    // (e) **Job Binding**：同一份「部署事实变化（RuntimeRevision 被摘回 draft）」经由
    //     Job 接纳链提交。Job 与 Thread 必须共用**同一个** Binding Authority：
    //     解析阶段（`resolveJobBindingCommand`）只看当前事实，提交阶段必须复验，
    //     否则解析与提交之间的事实漂移会被照旧冻结成正式 Binding。
    const { job } = await createJob({
      tenantId: context.tenantId,
      agentId: null,
      jobType: "knowledge_build",
      triggerRef: `trigger:${randomUUID()}`,
      creationKey: `creation:${randomUUID()}`,
      completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
      inputJson: { task: "entry06-job-binding" },
      createdBy: context.ownerId,
    });
    const jobResolved = await resolveJobBindingCommand({
      tenantId: context.tenantId,
      job,
      thread: null,
      initialContextCheckpointId: null,
    });
    if (!jobResolved.resolved) throw new Error(`Job Binding 解析失败：${jobResolved.reason}`);
    expect(jobResolved.binding.runtimeRevisionId).toBe(reference.runtimeRevisionId);

    const countJobInvocations = async (): Promise<number> => {
      const [row] = await db
        .select({ total: sql<number>`count(*)` })
        .from(invocationTable)
        .where(
          and(eq(invocationTable.tenantId, context.tenantId), eq(invocationTable.jobId, job.id)),
        );
      return Number(row?.total ?? 0);
    };

    await db
      .update(runtimeRevisionTable)
      .set({ revisionState: "draft" })
      .where(eq(runtimeRevisionTable.id, reference.runtimeRevisionId));
    try {
      await expectBindingRejected(() =>
        createJobInvocation({
          tenantId: context.tenantId,
          jobId: job.id,
          binding: jobResolved.binding,
          capabilityCatalog: jobResolved.capabilityCatalog,
        }),
      );
    } finally {
      await db
        .update(runtimeRevisionTable)
        .set({ revisionState: "published" })
        .where(eq(runtimeRevisionTable.id, reference.runtimeRevisionId));
    }
    // Job 根事务整体回滚：没有 Invocation，也就没有引用它的伪正式 Binding。
    expect(await countJobInvocations()).toBe(0);

    // 对照：同一份解析输入，只把 Runtime 事实改回 published 就能真正冻结 —— 说明上面
    // 的拒绝来自「提交时复验」而不是解析失败或无关的夹具问题。
    const admitted = await createJobInvocation({
      tenantId: context.tenantId,
      jobId: job.id,
      binding: jobResolved.binding,
      capabilityCatalog: jobResolved.capabilityCatalog,
    });
    expect(await countJobInvocations()).toBe(1);
    const jobBinding = await getExecutionBindingByInvocation(
      context.tenantId,
      admitted.invocation.id,
    );
    expect(jobBinding?.runtimeRevisionId).toBe(reference.runtimeRevisionId);

    // 事务无伪正式 Binding：这个 Thread 下最终只有真实入口产出的那一份。
    expect(
      (await listExecutionBindingsForThread(context.tenantId, context.threadId)).map(
        (binding) => binding.invocationId,
      ),
    ).toEqual([referenceInvocationId]);
  });

  // ─── CROSS 跨模块故障组合辅助 ───────────────────────────────

  /**
   * N 方屏障：让各方**真实同时**进入临界区，而不是靠 sleep 碰运气。
   */
  function createBarrier(parties: number): () => Promise<void> {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return async () => {
      arrived += 1;
      if (arrived >= parties) release();
      await gate;
    };
  }

  /**
   * 等到入口进程"停在 `execution.started` 之前"的正式崩溃点出现：
   * Owner 已激活（dispatching + activationEvidence）、Session 启动意图已冻结（dispatching）、
   * Attempt 仍 queued 且从未排定重试。这些都是**持久**事实，不是内存状态。
   */
  async function waitForCrashPoint(tenantId: string, invocationId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [session] = await getRuntimeSessionBindingsByInvocation(tenantId, invocationId);
      const owner = await getActiveExecutionOwnership({ tenantId, invocationId });
      if (
        session?.bindingState === "dispatching" &&
        owner?.executionPhase === "dispatching" &&
        owner.activationEvidence
      ) {
        return { session, owner };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `崩溃点状态未出现（session=${session?.bindingState ?? "缺失"}, owner=${owner?.executionPhase ?? "缺失"}）`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // ─── CROSS-T01 ─────────────────────────────────────────────

  /**
   * 跨模块故障组合：入口进程在 `execution.started` 处停止后，"心跳续租 / 内联重试 Worker"
   * 三方**同时**运行（两个 Worker 实例 + 一条真实心跳）。
   *
   * 参与者分属 ExecutionOwnership Store、Runtime Dispatch Retry Worker、Dispatcher 三个模块，
   * 且使用**两条真实 MySQL 连接**与真实屏障同时进入临界区——不是把三条单测串起来跑。
   * 断言落在持久事实上：不重建第二次逻辑执行、不产生第二个 Session、并发心跳不改写代际
   * 元组（claim 不越权）、最终完成。
   */
  it("CROSS-T01: 恢复/心跳/内联重试同时交错——锁图正确、claim 不越权、ready 不回退、最终完成", async () => {
    const context = await seedEntryContext("cross01");
    const turn = await acceptTurnOnly(context, "cross01-intent", "请读取工作区再回答");

    // 真实 Transport（由冻结 Binding 经唯一组合层解析），只把 `startInvocation` 换成"永不返回"。
    let realClient: RuntimeHttpClient | null = null;
    const stalled = dispatchInvocationForTurn({
      tenantId: context.tenantId,
      turnId: turn.id,
      executionSubject: {
        tenantId: context.tenantId,
        subjectType: "user",
        subjectId: context.ownerId,
      },
      runtimeClient: new Proxy({} as RuntimeHttpClient, {
        get(_target, property) {
          if (property === "startInvocation") return () => new Promise<never>(() => {});
          if (!realClient) throw new Error("真实 Runtime Transport 尚未解析");
          const value = Reflect.get(realClient, property);
          return typeof value === "function" ? value.bind(realClient) : value;
        },
      }),
      runtimeEndpointResolver: async (frozenBinding) => {
        const transport = await resolveRuntimeTransportFromBinding({
          tenantId: context.tenantId,
          binding: frozenBinding,
        });
        realClient = transport.runtimeClient;
        return {
          runtimeEndpoint: transport.runtimeEndpoint,
          auth: transport.auth,
          callbackEndpoints: buildGatewayEndpoints({
            external: !transport.hosted,
            invocationId: frozenBinding.invocationId,
          }),
        };
      },
    });
    void stalled.catch(() => undefined);

    const invocation = await waitForInvocationForTurn(context.tenantId, turn.id);
    const crashPoint = await waitForCrashPoint(context.tenantId, invocation.id);
    const frozenSessionId = crashPoint.session.id;
    expect(crashPoint.session.nextDispatchAt).toBeNull();

    // 第二条**真实** MySQL 连接：三方并发必须真的跑在不同连接上。
    const second = buildDrizzle(process.env.DATABASE_URL as string);
    try {
      const barrier = createBarrier(3);
      const workerTick = (workerId: string) =>
        (async () => {
          await barrier();
          const worker = createRuntimeDispatchRetryWorker({
            workerId,
            clock: () => afterStuckWindow(),
          });
          return worker.tick();
        })();

      const settled = await Promise.allSettled([
        (async () => {
          await barrier();
          // 真实心跳：经 Ownership Store 的完整 tuple 续租（不改代际、不换 claim）。
          return renewExecutionOwnership({
            tenantId: context.tenantId,
            invocationId: invocation.id,
            ownershipId: crashPoint.owner.id,
            attemptId: crashPoint.owner.attemptId,
            leaseEpoch: crashPoint.owner.leaseEpoch,
          });
        })(),
        workerTick(`cross01-worker-a-${randomUUID()}`),
        workerTick(`cross01-worker-b-${randomUUID()}`),
      ]);

      // 心跳必须真实成功；两个 Worker 中至少一个真实推进（另一个可因 claim 竞争让位）。
      expect(settled[0]?.status).toBe("fulfilled");
      expect(settled.slice(1).some((result) => result.status === "fulfilled")).toBe(true);
    } finally {
      await second.pool.end();
    }

    // ── 持久事实：恰好一次逻辑执行，同一条 Session 走完单向生命周期 ──
    const settledTurn = await waitForTurn(context.tenantId, turn.id);
    expect(settledTurn.turnState).toBe("completed");
    expect(await listInvocationsForTurn(context.tenantId, turn.id)).toHaveLength(1);

    const attempts = await listAttemptsForInvocation(context.tenantId, invocation.id);
    expect(attempts.map((row) => row.id)).toEqual([crashPoint.owner.attemptId]);

    const sessions = await getRuntimeSessionBindingsByInvocation(context.tenantId, invocation.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(frozenSessionId);
    expect(sessions[0]?.bindingState).toBe("closed");

    // 并发心跳不改写失权边界：若仍有 active Owner，它必须是同一条代际元组（未换 claim/epoch）。
    const afterOwner = await getActiveExecutionOwnership({
      tenantId: context.tenantId,
      invocationId: invocation.id,
    });
    if (afterOwner) {
      expect(afterOwner.id).toBe(crashPoint.owner.id);
      expect(afterOwner.leaseEpoch).toBe(crashPoint.owner.leaseEpoch);
    }
  });
});
