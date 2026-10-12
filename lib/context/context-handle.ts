/** ContextHandle is the only signed context contract for Thread and Job subjects. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  InitialCompressionError,
  resolveInitialCompression,
} from "@/lib/context/initial-checkpoint-source";
import { getItemById } from "@/lib/conversations/thread-item-queries";
import { db } from "@/lib/db/client";
import { getEnvironmentRevisionById } from "@/lib/environment/environment-definition-store";
import { assertJobInputDigestMatches } from "@/lib/job/job-input-digest";
import { resolveJobInputReference } from "@/lib/job/job-input-reference";
import { getJobById } from "@/lib/job/job-queries";
import { threadTable } from "@/lib/persistence/schema/conversation";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import {
  type ContextHandle,
  ContextHandleSchema,
  canonicalizeJson,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, eq } from "drizzle-orm";

export const CONTEXT_SOURCE_TYPES = [
  "recent_items",
  "skill",
  "workspace_map",
  "memory",
  "knowledge",
] as const;
export type ContextSourceType = (typeof CONTEXT_SOURCE_TYPES)[number];
export const BASE_CONTEXT_SOURCES = [...CONTEXT_SOURCE_TYPES] as ContextSourceType[];
export const CONTEXT_SOURCE_DIGEST = protocolDigest(BASE_CONTEXT_SOURCES);
const HANDLE_TTL_MS = 5 * 60 * 1000;

export class ContextHandleError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "expired"
      | "binding_not_found"
      | "binding_mismatch"
      | "input_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ContextHandleError";
  }
}

function signingSecret(): string {
  const secret = process.env.SNOW_CONTEXT_HANDLE_SECRET?.trim();
  if (secret && Buffer.byteLength(secret, "utf8") >= 32) return secret;
  if (process.env.NODE_ENV === "test" || process.env.APP_ENV === "test") {
    return "snow-context-handle-test-secret-32-bytes";
  }
  throw new ContextHandleError("invalid", "未配置 SNOW_CONTEXT_HANDLE_SECRET");
}

function signingKeyId(): string {
  return process.env.CONTEXT_SIGNING_KEY_ID?.trim() || "context-primary";
}

function sign(header: string, payload: string): string {
  return createHmac("sha256", signingSecret())
    .update(`snowharness.context\0${header}.${payload}`, "utf8")
    .digest("base64url");
}

function encode(handle: ContextHandle): string {
  const header = Buffer.from(
    canonicalizeJson({ formatVersion: 1, algorithm: "HS256", keyId: signingKeyId() }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(canonicalizeJson(handle), "utf8").toString("base64url");
  return `ch.${header}.${payload}.${sign(header, payload)}`;
}

function decode(value: string): ContextHandle {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "ch") {
    throw new ContextHandleError("invalid", "ContextHandle 格式非法");
  }
  const [prefix, header, payload, mac] = parts;
  if (!prefix || !header || !payload || !mac) {
    throw new ContextHandleError("invalid", "ContextHandle 格式非法");
  }
  const expected = Buffer.from(sign(header, payload), "utf8");
  const actual = Buffer.from(mac, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ContextHandleError("invalid", "ContextHandle 签名无效");
  }
  let parsedHeader: unknown;
  let parsedPayload: unknown;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    parsedPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new ContextHandleError("invalid", "ContextHandle 编码非法");
  }
  const expectedHeader = { formatVersion: 1, algorithm: "HS256", keyId: signingKeyId() };
  if (canonicalizeJson(parsedHeader) !== canonicalizeJson(expectedHeader)) {
    throw new ContextHandleError("invalid", "ContextHandle header 非法");
  }
  const result = ContextHandleSchema.safeParse(parsedPayload);
  if (!result.success) throw new ContextHandleError("invalid", "ContextHandle payload 非法");
  if (Date.now() >= result.data.common.expiresAt) {
    throw new ContextHandleError("expired", "ContextHandle 已过期");
  }
  return result.data;
}

type PersistedContext = { handle: ContextHandle; bindingDigest: string };

async function loadPersistedContext(
  tenantId: string,
  invocationId: string,
): Promise<PersistedContext> {
  const [row] = await db
    .select({ invocation: invocationTable, binding: executionBindingTable, thread: threadTable })
    .from(invocationTable)
    .innerJoin(executionBindingTable, eq(executionBindingTable.invocationId, invocationTable.id))
    .leftJoin(threadTable, eq(threadTable.id, invocationTable.threadId))
    .where(
      and(
        eq(invocationTable.tenantId, tenantId),
        eq(invocationTable.id, invocationId),
        eq(executionBindingTable.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!row) throw new ContextHandleError("binding_not_found", "Invocation 上下文绑定不存在");
  const { invocation, binding, thread } = row;
  const workspace = await getWorkspaceBindingById(tenantId, binding.workspaceBindingId);
  if (!workspace) throw new ContextHandleError("binding_not_found", "WorkspaceBinding 不存在");
  const environment =
    binding.environmentMode === "MANAGED"
      ? await getEnvironmentRevisionById(tenantId, binding.environmentDefinitionRevisionId ?? "")
      : null;
  if (binding.environmentMode === "MANAGED" && !environment) {
    throw new ContextHandleError("binding_not_found", "EnvironmentRevision 不存在");
  }
  // environment 非 null ⇔ MANAGED（上方已 fail closed）；NO_PLATFORM 恒为 null。
  const environmentContext = environment
    ? {
        mode: "MANAGED" as const,
        revisionId: environment.id,
        semanticDigest: environment.semanticDigest,
      }
    : ({ mode: "NO_PLATFORM_ENVIRONMENT" as const } as const);
  const bindingDigest = protocolDigest({
    tenantId: binding.tenantId,
    invocationId: binding.invocationId,
    runtimeRevisionId: binding.runtimeRevisionId,
    policyRevisionId: binding.policyRevisionId,
    policyRulesDigest: binding.policyRulesDigest,
    workspaceBindingId: binding.workspaceBindingId,
    environmentMode: binding.environmentMode,
    environmentDefinitionRevisionId: binding.environmentDefinitionRevisionId,
    configHash: binding.configHash,
  });
  // T33：Binding 冻结了初始压缩材料时，这里真实读一次并核验 Hash/权限/有效期；
  // 失效、损坏或撤权一律显式失败，不静默改用「最新 Checkpoint」或直接丢弃。
  const initialCompression = binding.initialContextCheckpointId
    ? await loadBoundInitialCompression(binding)
    : null;
  const common = {
    contractVersion: 1 as const,
    tenantId,
    invocationId,
    bindingDigest,
    initialCompression,
    principal: {
      type: binding.principalType as "user" | "service",
      id: binding.principalId,
      source: binding.principalSource as "authenticated_user" | "trusted_service",
    },
    runtimeRevisionId: binding.runtimeRevisionId,
    policy: { revisionId: binding.policyRevisionId, digest: binding.policyRulesDigest },
    workspace: { bindingId: workspace.id, contractDigest: workspace.contractDigest },
    environment: environmentContext,
    contextSourceDigest: CONTEXT_SOURCE_DIGEST,
  };

  let subject: ContextHandle["subject"];
  if (invocation.subjectType === "thread") {
    if (!invocation.threadId || !invocation.turnId || !invocation.triggerItemId || !thread) {
      throw new ContextHandleError("binding_not_found", "Thread Invocation 上下文不完整");
    }
    const item = await getItemById(tenantId, invocation.triggerItemId);
    if (!item) throw new ContextHandleError("input_unavailable", "Thread 输入 Item 不可用");
    subject = {
      type: "thread",
      threadId: invocation.threadId,
      turnId: invocation.turnId,
      triggerItemId: invocation.triggerItemId,
      triggerItemDigest: protocolDigest(item.contentJson),
    };
  } else {
    if (!invocation.jobId)
      throw new ContextHandleError("binding_not_found", "Job Invocation 缺少 jobId");
    const job = await getJobById(tenantId, invocation.jobId);
    if (!job) throw new ContextHandleError("binding_not_found", "Job 不存在");
    try {
      assertJobInputDigestMatches({ job, invocationInputDigest: invocation.inputDigest });
      if (job.inputKind === "reference") {
        if (!job.inputRef) throw new Error("InputUnavailable");
        await resolveJobInputReference({
          tenantId,
          inputRef: job.inputRef,
          inputHash: job.inputHash,
        });
      }
    } catch (error) {
      throw new ContextHandleError(
        "input_unavailable",
        error instanceof Error && error.message === "InputDigestMismatch"
          ? "InputDigestMismatch"
          : "InputUnavailable",
      );
    }
    subject = {
      type: "job",
      jobId: job.id,
      inputKind: job.inputKind,
      inputHash: job.inputHash,
      ...(job.inputRef ? { inputRef: job.inputRef } : {}),
      triggerRef: job.triggerRef,
      ...(job.replacesJobId ? { replacesJobId: job.replacesJobId } : {}),
    };
  }
  return {
    bindingDigest,
    handle: {
      common: { ...common, issuedAt: 0, expiresAt: 0, jti: randomUUID() },
      subject,
    },
  };
}

/**
 * 读取 Binding 冻结的初始压缩材料并投影为 ContextHandle 受控字段（T33）。
 *
 * 失败语义（fail-closed，均有明确错误码）：
 * - 撤权 / 跨 Principal → binding_mismatch；
 * - 其余（不存在、非 compression、过期、Hash 不符、不可回读）→ input_unavailable。
 */
async function loadBoundInitialCompression(binding: {
  tenantId: string;
  initialContextCheckpointId: string | null;
  principalType: string;
  principalId: string;
}): Promise<ContextHandle["common"]["initialCompression"]> {
  const verified = await resolveInitialCompression({
    tenantId: binding.tenantId,
    checkpointId: binding.initialContextCheckpointId as string,
    requester: {
      type: binding.principalType as "user" | "service",
      id: binding.principalId,
    },
  }).catch((error: unknown) => {
    if (error instanceof InitialCompressionError) {
      throw new ContextHandleError(
        error.failure === "access_denied" ? "binding_mismatch" : "input_unavailable",
        `初始压缩材料不可用：${error.message}`,
      );
    }
    throw error;
  });
  return {
    checkpointId: verified.checkpointId,
    summaryHash: verified.summaryHash,
    sourceRangesHash: verified.sourceRangesHash,
  };
}

export async function issueContextHandle(input: {
  tenantId: string;
  invocationId: string;
  ttlMs?: number;
}): Promise<string> {
  const persisted = await loadPersistedContext(input.tenantId, input.invocationId);
  const issuedAt = Date.now();
  const ttl = Math.max(1, Math.min(input.ttlMs ?? HANDLE_TTL_MS, HANDLE_TTL_MS));
  persisted.handle.common.issuedAt = issuedAt;
  persisted.handle.common.expiresAt = issuedAt + ttl;
  return encode(persisted.handle);
}

export async function resolveContextHandle(
  value: string,
  expected: { tenantId: string; invocationId: string },
): Promise<ContextHandle> {
  const handle = decode(value);
  if (
    handle.common.tenantId !== expected.tenantId ||
    handle.common.invocationId !== expected.invocationId
  ) {
    throw new ContextHandleError("binding_mismatch", "ContextHandle 与执行身份不匹配");
  }
  const current = await loadPersistedContext(expected.tenantId, expected.invocationId);
  if (handle.common.bindingDigest !== current.bindingDigest) {
    throw new ContextHandleError("binding_mismatch", "ContextHandle 的 Binding 已变化");
  }
  if (canonicalizeJson(handle.subject) !== canonicalizeJson(current.handle.subject)) {
    throw new ContextHandleError("binding_mismatch", "ContextHandle 的 Subject 已变化");
  }
  return handle;
}
