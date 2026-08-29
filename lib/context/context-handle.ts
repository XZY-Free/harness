import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db/client";
import { threadTable } from "@/lib/persistence/schema/conversation";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import { and, eq } from "drizzle-orm";

export const CONTEXT_SOURCE_TYPES = [
  "recent_items",
  "skill",
  "workspace_map",
  "memory",
  "knowledge",
] as const;
export type ContextSourceType = (typeof CONTEXT_SOURCE_TYPES)[number];

export const CONTEXT_CLASSIFICATIONS = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
export type ContextClassification = (typeof CONTEXT_CLASSIFICATIONS)[number];

/**
 * 基础 Harness Route 的 Context 策略默认值。
 *
 * 冻结架构：ExecutionBinding 只绑定 Harness Runtime，不再携带 Agent Context
 * Contract（原 classification/allowedSources/allowedSkillIds 由 AgentRevision
 * permissionRequirementsJson 派生）。无 Agent Contract 时按基础 Harness 默认：
 * 允许全部已声明的上下文来源、无额外 skill 白名单、敏感级别 internal。
 * （A2A 的 AgentSessionBinding Context Contract 属后续批次。）
 */
export const BASE_HARNESS_CONTEXT_POLICY = {
  classification: "internal" as ContextClassification,
  allowedSources: [...CONTEXT_SOURCE_TYPES],
  allowedSkillIds: [] as string[],
};

export interface ContextHandleBinding {
  tenantId: string;
  invocationId: string;
  threadId: string;
  triggerItemId: string;
  userId: string;
  workspaceId: string | null;
  workspaceBindingId: string | null;
  policyRevisionId: string | null;
  classification: ContextClassification;
  allowedSources: ContextSourceType[];
  allowedSkillIds: string[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export class ContextHandleError extends Error {
  constructor(
    readonly code: "invalid" | "expired" | "binding_not_found" | "binding_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ContextHandleError";
  }
}

const HANDLE_TTL_MS = 5 * 60 * 1000;

function signingSecret(): string {
  const configured = process.env.SNOW_CONTEXT_HANDLE_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "test" || process.env.APP_ENV === "test") {
    return "snow-context-handle-test-secret-32-bytes";
  }
  throw new ContextHandleError("invalid", "未配置 SNOW_CONTEXT_HANDLE_SECRET");
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", signingSecret()).update(encodedPayload).digest("base64url");
}

function encode(binding: ContextHandleBinding): string {
  const payload = Buffer.from(JSON.stringify(binding), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decode(handle: string): ContextHandleBinding {
  const [payload, signature, extra] = handle.split(".");
  if (!payload || !signature || extra) {
    throw new ContextHandleError("invalid", "context_handle 格式非法");
  }
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ContextHandleError("invalid", "context_handle 签名无效");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new ContextHandleError("invalid", "context_handle payload 非法");
  }
  if (!value || typeof value !== "object") {
    throw new ContextHandleError("invalid", "context_handle payload 非法");
  }
  const binding = value as ContextHandleBinding;
  if (
    typeof binding.tenantId !== "string" ||
    typeof binding.invocationId !== "string" ||
    typeof binding.threadId !== "string" ||
    typeof binding.triggerItemId !== "string" ||
    typeof binding.userId !== "string" ||
    typeof binding.nonce !== "string" ||
    typeof binding.issuedAt !== "number" ||
    typeof binding.expiresAt !== "number" ||
    !Array.isArray(binding.allowedSources) ||
    !Array.isArray(binding.allowedSkillIds) ||
    !CONTEXT_CLASSIFICATIONS.includes(binding.classification) ||
    binding.allowedSources.some(
      (source) => !CONTEXT_SOURCE_TYPES.includes(source as ContextSourceType),
    ) ||
    binding.allowedSkillIds.some((skillId) => typeof skillId !== "string")
  ) {
    throw new ContextHandleError("invalid", "context_handle 缺少绑定字段");
  }
  if (Date.now() >= binding.expiresAt) {
    throw new ContextHandleError("expired", "context_handle 已过期");
  }
  return binding;
}

async function loadPersistedBinding(tenantId: string, invocationId: string) {
  const [row] = await db
    .select({
      invocationId: invocationTable.id,
      threadId: invocationTable.threadId,
      triggerItemId: invocationTable.triggerItemId,
      userId: threadTable.ownerUserId,
      workspaceId: threadTable.defaultWorkspaceId,
      workspaceBindingId: executionBindingTable.workspaceBindingId,
      policyRevisionId: executionBindingTable.policyRevisionId,
    })
    .from(invocationTable)
    .innerJoin(executionBindingTable, eq(executionBindingTable.invocationId, invocationTable.id))
    .innerJoin(threadTable, eq(threadTable.id, invocationTable.threadId))
    .where(
      and(
        eq(invocationTable.tenantId, tenantId),
        eq(invocationTable.id, invocationId),
        eq(executionBindingTable.tenantId, tenantId),
        eq(threadTable.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!row?.threadId || !row.triggerItemId) {
    throw new ContextHandleError("binding_not_found", "Invocation 上下文绑定不存在或不完整");
  }
  // 冻结架构：ExecutionBinding 不再携带 Agent Context Contract，
  // Context 策略按基础 Harness 默认（无 Agent 读取）。
  return {
    ...row,
    ...BASE_HARNESS_CONTEXT_POLICY,
    threadId: row.threadId,
    triggerItemId: row.triggerItemId,
  };
}

export async function issueContextHandle(input: {
  tenantId: string;
  invocationId: string;
  ttlMs?: number;
}): Promise<string> {
  const persisted = await loadPersistedBinding(input.tenantId, input.invocationId);
  const issuedAt = Date.now();
  return encode({
    ...persisted,
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    issuedAt,
    expiresAt: issuedAt + Math.max(0, Math.min(input.ttlMs ?? HANDLE_TTL_MS, HANDLE_TTL_MS)),
    nonce: randomUUID(),
  });
}

export async function resolveContextHandle(
  handle: string,
  expected: { tenantId: string; invocationId: string },
): Promise<ContextHandleBinding> {
  const binding = decode(handle);
  if (binding.tenantId !== expected.tenantId || binding.invocationId !== expected.invocationId) {
    throw new ContextHandleError("binding_mismatch", "context_handle 与调用身份不匹配");
  }
  const persisted = await loadPersistedBinding(expected.tenantId, expected.invocationId);
  for (const key of [
    "threadId",
    "triggerItemId",
    "userId",
    "workspaceId",
    "workspaceBindingId",
    "policyRevisionId",
    "classification",
  ] as const) {
    if (binding[key] !== persisted[key]) {
      throw new ContextHandleError("binding_mismatch", `context_handle ${key} 绑定已失效`);
    }
  }
  if (
    binding.allowedSources.join("\0") !== persisted.allowedSources.join("\0") ||
    binding.allowedSkillIds.join("\0") !== persisted.allowedSkillIds.join("\0")
  ) {
    throw new ContextHandleError("binding_mismatch", "context_handle 资源授权已失效");
  }
  return binding;
}
