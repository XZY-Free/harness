/**
 * V11 UserActionRequest 集成测试（阶段 8 S08-C04）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.8、§5.5。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §3.18、§3.19、§10。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W04。
 *
 * 覆盖：
 * - 辅助函数：isUserActionRequestType / isUserActionRequestState / isUserActionResolution /
 *   isResolutionAllowedForType / hashAuthSecret。
 * - 创建请求：四类型 + auth 自动生成 state/nonce + input 必填 inputSchema + 过期时间校验。
 * - 查询：byId / byInvocation / byToolCall / getPendingUserActionRequestForToolCall + 跨租户隔离。
 * - resolveUserActionRequest：四类型 + 状态机 + 重复 resolve 报错 + resolution 匹配校验
 *   + grant 类型 approve 同事务创建 Grant + input submit 必填 response。
 * - completeAuthCallback：state/nonce 校验 + 一次性消费 + 非 auth 类型拒绝 + 已 resolved 拒绝。
 * - markExpiredUserActionRequests：批量扫描 + 受影响行数。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  ALLOWED_RESOLUTIONS_BY_TYPE,
  type UserActionRequestType,
  type UserActionResolution,
} from "@/lib/persistence/schema/user-action-request";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { createCredentialRef } from "@/lib/v11/capability/tool-queries";
import {
  UserActionAlreadyResolvedError,
  UserActionAuthCallbackInvalidError,
  UserActionNotFoundError,
  UserActionResolutionMismatchError,
  UserActionValidationError,
  completeAuthCallback,
  createUserActionRequest,
  getPendingUserActionRequestForToolCall,
  getUserActionRequestById,
  getUserActionRequestsByInvocation,
  getUserActionRequestsByToolCall,
  hashAuthSecret,
  isResolutionAllowedForType,
  isUserActionRequestState,
  isUserActionRequestType,
  isUserActionResolution,
  markExpiredUserActionRequests,
  resolveUserActionRequest,
} from "@/lib/v11/permission/user-action-queries";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 默认租户 + 用户 + CredentialRef ──────────

async function seedContext() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "user-action-owner-001",
    email: "user-action@example.com",
    displayName: "UserAction Owner",
  });
  const credentialRef = await createCredentialRef({
    tenantId: tenant.id,
    provider: "vault",
    vaultRef: "vault://test/cred-001",
    fingerprint: "sha256:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e",
  });
  return {
    tenantId: tenant.id,
    userId: identity.id,
    credentialRefId: credentialRef.id,
  };
}

/** 构造随机 thread/turn/invocation id（不依赖相关表，本表只记录 id 无 FK 约束）。 */
function randomContextIds() {
  return {
    threadId: randomUUID(),
    turnId: randomUUID(),
    invocationId: randomUUID(),
  };
}

/** 构造未来时间（默认 +1 小时）。 */
function futureTime(hours = 1): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/** 构造过去时间（默认 -1 小时）。 */
function pastTime(hours = 1): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/**
 * 直接 SQL 把指定请求的 expiresAt 改为过去时间。
 *
 * createUserActionRequest 校验拒绝过去时间，必须绕过校验直接修改 DB。
 */
async function backdateRequestExpiry(requestId: string, hoursAgo = 1): Promise<void> {
  await db
    .update(userActionRequestTable)
    .set({ expiresAt: pastTime(hoursAgo) })
    .where(eq(userActionRequestTable.id, requestId));
}

// ═══════════════════════════════════════════════════════════
// 1. 辅助函数校验
// ═══════════════════════════════════════════════════════════

describe("V11 user-action-queries：辅助函数校验", () => {
  it("isUserActionRequestType：合法/非法判断", () => {
    expect(isUserActionRequestType("confirmation")).toBe(true);
    expect(isUserActionRequestType("auth")).toBe(true);
    expect(isUserActionRequestType("grant")).toBe(true);
    expect(isUserActionRequestType("input")).toBe(true);
    expect(isUserActionRequestType("other")).toBe(false);
    expect(isUserActionRequestType("")).toBe(false);
  });

  it("isUserActionRequestState：合法/非法判断", () => {
    expect(isUserActionRequestState("pending")).toBe(true);
    expect(isUserActionRequestState("resolved")).toBe(true);
    expect(isUserActionRequestState("expired")).toBe(true);
    expect(isUserActionRequestState("cancelled")).toBe(false);
  });

  it("isUserActionResolution：合法/非法判断", () => {
    expect(isUserActionResolution("approve")).toBe(true);
    expect(isUserActionResolution("deny")).toBe(true);
    expect(isUserActionResolution("submit")).toBe(true);
    expect(isUserActionResolution("cancel")).toBe(true);
    expect(isUserActionResolution("reject")).toBe(false);
  });

  it("isResolutionAllowedForType：四类型 × 四 resolution 匹配矩阵", () => {
    // confirmation: approve / deny
    expect(isResolutionAllowedForType("confirmation", "approve")).toBe(true);
    expect(isResolutionAllowedForType("confirmation", "deny")).toBe(true);
    expect(isResolutionAllowedForType("confirmation", "submit")).toBe(false);
    expect(isResolutionAllowedForType("confirmation", "cancel")).toBe(false);

    // auth: :resolve 接口仅接受 cancel
    expect(isResolutionAllowedForType("auth", "cancel")).toBe(true);
    expect(isResolutionAllowedForType("auth", "approve")).toBe(false);
    expect(isResolutionAllowedForType("auth", "deny")).toBe(false);
    expect(isResolutionAllowedForType("auth", "submit")).toBe(false);

    // grant: approve / deny
    expect(isResolutionAllowedForType("grant", "approve")).toBe(true);
    expect(isResolutionAllowedForType("grant", "deny")).toBe(true);
    expect(isResolutionAllowedForType("grant", "submit")).toBe(false);
    expect(isResolutionAllowedForType("grant", "cancel")).toBe(false);

    // input: submit / cancel
    expect(isResolutionAllowedForType("input", "submit")).toBe(true);
    expect(isResolutionAllowedForType("input", "cancel")).toBe(true);
    expect(isResolutionAllowedForType("input", "approve")).toBe(false);
    expect(isResolutionAllowedForType("input", "deny")).toBe(false);
  });

  it("hashAuthSecret：返回 sha256: 前缀 + 64 hex", () => {
    const hash = hashAuthSecret("test-state-value");
    expect(hash.startsWith("sha256:")).toBe(true);
    const hex = hash.slice("sha256:".length);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashAuthSecret：相同输入产生相同 hash", () => {
    expect(hashAuthSecret("abc")).toBe(hashAuthSecret("abc"));
  });

  it("hashAuthSecret：不同输入产生不同 hash", () => {
    expect(hashAuthSecret("abc")).not.toBe(hashAuthSecret("abd"));
  });

  it("ALLOWED_RESOLUTIONS_BY_TYPE：覆盖四类型", () => {
    expect(ALLOWED_RESOLUTIONS_BY_TYPE.confirmation).toEqual(["approve", "deny"]);
    expect(ALLOWED_RESOLUTIONS_BY_TYPE.auth).toEqual(["cancel"]);
    expect(ALLOWED_RESOLUTIONS_BY_TYPE.grant).toEqual(["approve", "deny"]);
    expect(ALLOWED_RESOLUTIONS_BY_TYPE.input).toEqual(["submit", "cancel"]);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. createUserActionRequest：四类型 + 校验
// ═══════════════════════════════════════════════════════════

describe("V11 createUserActionRequest：四类型 + 校验", () => {
  it("confirmation：成功创建 + 默认 pending + 无 state/nonce", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();

    const result = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "确认执行", impact: "写入文件" },
    });

    expect(result.request.requestState).toBe("pending");
    expect(result.request.requestType).toBe("confirmation");
    expect(result.request.tenantId).toBe(tenantId);
    expect(result.request.authStateHash).toBeNull();
    expect(result.request.nonceHash).toBeNull();
    expect(result.request.inputSchemaJson).toBeNull();
    expect(result.request.versionNo).toBe(1);
    expect(result.request.expiresAt).toBeNull();
    expect(result.authStatePlaintext).toBeUndefined();
    expect(result.noncePlaintext).toBeUndefined();
  });

  it("auth：自动生成 state/nonce + hash 存储 + 返回原值", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();

    const result = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "auth",
      promptJson: { title: "登录 Google", impact: "访问 Drive" },
    });

    expect(result.request.authStateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.request.nonceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.authStatePlaintext).toBeDefined();
    expect(result.noncePlaintext).toBeDefined();
    expect(result.authStatePlaintext).not.toBe(result.request.authStateHash);
    expect(hashAuthSecret(result.authStatePlaintext ?? "")).toBe(result.request.authStateHash);
    expect(hashAuthSecret(result.noncePlaintext ?? "")).toBe(result.request.nonceHash);
  });

  it("auth：调用方提供 state/nonce 原值时使用提供的", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();

    const result = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "auth",
      promptJson: { title: "登录" },
      authState: "custom-state-123",
      nonce: "custom-nonce-456",
    });

    expect(result.authStatePlaintext).toBe("custom-state-123");
    expect(result.noncePlaintext).toBe("custom-nonce-456");
    expect(result.request.authStateHash).toBe(hashAuthSecret("custom-state-123"));
    expect(result.request.nonceHash).toBe(hashAuthSecret("custom-nonce-456"));
  });

  it("input：必填 inputSchemaJson", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();

    // 缺 inputSchemaJson → 报错
    await expect(
      createUserActionRequest({
        tenantId,
        ...ids,
        requestType: "input",
        promptJson: { title: "补充信息" },
      }),
    ).rejects.toThrow(UserActionValidationError);

    // 提供 inputSchemaJson → 成功
    const result = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "input",
      promptJson: { title: "补充信息" },
      inputSchemaJson: { type: "object", properties: { reason: { type: "string" } } },
    });
    expect(result.request.inputSchemaJson).toEqual({
      type: "object",
      properties: { reason: { type: "string" } },
    });
  });

  it("grant：成功创建（无特殊字段）", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();

    const result = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "grant",
      promptJson: { title: "授权访问 Google Drive" },
      purpose: "credential_login",
    });

    expect(result.request.requestType).toBe("grant");
    expect(result.request.purpose).toBe("credential_login");
    expect(result.request.grantId).toBeNull();
  });

  it("空 tenantId/threadId/invocationId → ValidationError", async () => {
    await expect(
      createUserActionRequest({
        tenantId: "",
        threadId: randomUUID(),
        turnId: randomUUID(),
        invocationId: randomUUID(),
        requestType: "confirmation",
        promptJson: { title: "x" },
      }),
    ).rejects.toThrow(UserActionValidationError);
  });

  it("非法 requestType → ValidationError", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();
    await expect(
      createUserActionRequest({
        tenantId,
        ...ids,
        requestType: "invalid" as UserActionRequestType,
        promptJson: { title: "x" },
      }),
    ).rejects.toThrow(UserActionValidationError);
  });

  it("promptJson 非对象 → ValidationError", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();
    await expect(
      createUserActionRequest({
        tenantId,
        ...ids,
        requestType: "confirmation",
        promptJson: "not-an-object" as unknown as object,
      }),
    ).rejects.toThrow(UserActionValidationError);
  });

  it("expiresAt 过去时间 → ValidationError", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();
    await expect(
      createUserActionRequest({
        tenantId,
        ...ids,
        requestType: "confirmation",
        promptJson: { title: "x" },
        expiresAt: pastTime(1),
      }),
    ).rejects.toThrow(UserActionValidationError);
  });

  it("含 toolCallId + itemId + expiresAt", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();
    const toolCallId = randomUUID();
    const itemId = randomUUID();

    const result = await createUserActionRequest({
      tenantId,
      ...ids,
      toolCallId,
      itemId,
      requestType: "confirmation",
      promptJson: { title: "x" },
      expiresAt: futureTime(2),
    });

    expect(result.request.toolCallId).toBe(toolCallId);
    expect(result.request.itemId).toBe(itemId);
    expect(result.request.expiresAt).toBeInstanceOf(Date);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 查询 + 跨租户隔离
// ═══════════════════════════════════════════════════════════

describe("V11 UserActionRequest 查询 + 跨租户隔离", () => {
  it("getUserActionRequestById：跨租户返回 null", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
    });

    const fromA = await getUserActionRequestById(tenantId, request.id);
    const fromB = await getUserActionRequestById(randomUUID(), request.id);
    expect(fromA?.id).toBe(request.id);
    expect(fromB).toBeNull();
  });

  it("getUserActionRequestsByInvocation：按状态过滤 + 升序", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();

    const r1 = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "1" },
    });
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "input",
      promptJson: { title: "2" },
      inputSchemaJson: { type: "object" },
    });

    const all = await getUserActionRequestsByInvocation(tenantId, ids.invocationId);
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe(r1.request.id);
    expect(all[1]?.id).toBe(r2.request.id);

    const pendingOnly = await getUserActionRequestsByInvocation(tenantId, ids.invocationId, {
      requestState: "pending",
    });
    expect(pendingOnly).toHaveLength(2);

    const resolvedOnly = await getUserActionRequestsByInvocation(tenantId, ids.invocationId, {
      requestState: "resolved",
    });
    expect(resolvedOnly).toHaveLength(0);
  });

  it("getUserActionRequestsByToolCall", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();
    const toolCallId = randomUUID();

    await createUserActionRequest({
      tenantId,
      ...ids,
      toolCallId,
      requestType: "confirmation",
      promptJson: { title: "1" },
    });
    await createUserActionRequest({
      tenantId,
      ...ids,
      toolCallId,
      requestType: "confirmation",
      promptJson: { title: "2" },
    });

    const list = await getUserActionRequestsByToolCall(tenantId, toolCallId);
    expect(list).toHaveLength(2);
  });

  it("getPendingUserActionRequestForToolCall：仅返回 pending 最新", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();
    const toolCallId = randomUUID();

    const r1 = await createUserActionRequest({
      tenantId,
      ...ids,
      toolCallId,
      requestType: "confirmation",
      promptJson: { title: "1" },
    });

    const pending = await getPendingUserActionRequestForToolCall(tenantId, toolCallId);
    expect(pending?.id).toBe(r1.request.id);

    // resolve 后不再返回
    await resolveUserActionRequest({
      tenantId,
      requestId: r1.request.id,
      resolution: "approve",
      resolvedBy: "engine",
    });
    const pendingAfter = await getPendingUserActionRequestForToolCall(tenantId, toolCallId);
    expect(pendingAfter).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. resolveUserActionRequest：状态机 + 四类型
// ═══════════════════════════════════════════════════════════

describe("V11 resolveUserActionRequest：状态机 + 四类型", () => {
  it("confirmation approve：成功解析 + versionNo 递增", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
    });

    const resolved = await resolveUserActionRequest({
      tenantId,
      requestId: request.id,
      resolution: "approve",
      resolvedBy: userId,
    });

    expect(resolved.request.requestState).toBe("resolved");
    expect(resolved.request.resolution).toBe("approve");
    expect(resolved.request.resolvedBy).toBe(userId);
    expect(resolved.request.resolvedAt).toBeInstanceOf(Date);
    expect(resolved.request.versionNo).toBe(request.versionNo + 1);
  });

  it("confirmation deny：成功解析", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
    });

    const resolved = await resolveUserActionRequest({
      tenantId,
      requestId: request.id,
      resolution: "deny",
      resolvedBy: userId,
    });

    expect(resolved.request.resolution).toBe("deny");
  });

  it("confirmation submit → ResolutionMismatchError", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
    });

    await expect(
      resolveUserActionRequest({
        tenantId,
        requestId: request.id,
        resolution: "submit" as UserActionResolution,
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionResolutionMismatchError);
  });

  it("auth approve → ResolutionMismatchError（:resolve 仅接受 cancel）", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "auth",
      promptJson: { title: "x" },
    });

    await expect(
      resolveUserActionRequest({
        tenantId,
        requestId: request.id,
        resolution: "approve" as UserActionResolution,
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionResolutionMismatchError);
  });

  it("auth cancel：成功解析", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "auth",
      promptJson: { title: "x" },
    });

    const resolved = await resolveUserActionRequest({
      tenantId,
      requestId: request.id,
      resolution: "cancel",
      resolvedBy: userId,
    });

    expect(resolved.request.resolution).toBe("cancel");
    expect(resolved.request.requestState).toBe("resolved");
  });

  it("input submit：必须提供 responseRedactedJson", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "input",
      promptJson: { title: "x" },
      inputSchemaJson: { type: "object" },
    });

    // 缺 responseRedactedJson → 报错
    await expect(
      resolveUserActionRequest({
        tenantId,
        requestId: request.id,
        resolution: "submit",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionValidationError);

    // 提供 responseRedactedJson → 成功
    const resolved = await resolveUserActionRequest({
      tenantId,
      requestId: request.id,
      resolution: "submit",
      resolvedBy: userId,
      responseRedactedJson: { reason: "user-typed-text" },
    });
    expect(resolved.request.responseRedactedJson).toEqual({ reason: "user-typed-text" });
  });

  it("input cancel：不需要 responseRedactedJson", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "input",
      promptJson: { title: "x" },
      inputSchemaJson: { type: "object" },
    });

    const resolved = await resolveUserActionRequest({
      tenantId,
      requestId: request.id,
      resolution: "cancel",
      resolvedBy: userId,
    });
    expect(resolved.request.resolution).toBe("cancel");
    expect(resolved.request.responseRedactedJson).toBeNull();
  });

  it("grant approve：同事务创建 Grant + 回填 grantId", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "grant",
      promptJson: { title: "授权访问 Drive" },
    });

    const resolved = await resolveUserActionRequest({
      tenantId,
      requestId: request.id,
      resolution: "approve",
      resolvedBy: userId,
      grantParams: {
        userId,
        scope: ["tool:execute", "file:read"],
        credentialRefId,
        issuedBy: userId,
      },
    });

    expect(resolved.grantId).toBeDefined();
    expect(resolved.request.grantId).toBe(resolved.grantId);
  });

  it("grant approve：缺 grantParams → ValidationError", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "grant",
      promptJson: { title: "x" },
    });

    await expect(
      resolveUserActionRequest({
        tenantId,
        requestId: request.id,
        resolution: "approve",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionValidationError);
  });

  it("grant deny：不创建 Grant", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "grant",
      promptJson: { title: "x" },
    });

    const resolved = await resolveUserActionRequest({
      tenantId,
      requestId: request.id,
      resolution: "deny",
      resolvedBy: userId,
    });

    expect(resolved.grantId).toBeUndefined();
    expect(resolved.request.grantId).toBeNull();
  });

  it("重复 resolve → UserActionAlreadyResolvedError", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
    });

    await resolveUserActionRequest({
      tenantId,
      requestId: request.id,
      resolution: "approve",
      resolvedBy: userId,
    });

    await expect(
      resolveUserActionRequest({
        tenantId,
        requestId: request.id,
        resolution: "approve",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionAlreadyResolvedError);
  });

  it("请求不存在 → UserActionNotFoundError", async () => {
    const { tenantId, userId } = await seedContext();
    await expect(
      resolveUserActionRequest({
        tenantId,
        requestId: randomUUID(),
        resolution: "approve",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionNotFoundError);
  });

  it("跨租户 resolve → NotFoundError", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
    });

    await expect(
      resolveUserActionRequest({
        tenantId: randomUUID(),
        requestId: request.id,
        resolution: "approve",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionNotFoundError);
  });

  it("乐观锁版本不匹配 → AlreadyResolvedError", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
    });

    await expect(
      resolveUserActionRequest({
        tenantId,
        requestId: request.id,
        resolution: "approve",
        resolvedBy: userId,
        expectedVersionNo: request.versionNo + 999,
      }),
    ).rejects.toThrow(UserActionAlreadyResolvedError);
  });

  it("过期请求 resolve → AlreadyResolvedError", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const { request } = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
      expiresAt: futureTime(1),
    });
    await backdateRequestExpiry(request.id, 1);

    await expect(
      resolveUserActionRequest({
        tenantId,
        requestId: request.id,
        resolution: "approve",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionAlreadyResolvedError);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. completeAuthCallback：state/nonce 校验 + 一次性消费
// ═══════════════════════════════════════════════════════════

describe("V11 completeAuthCallback：state/nonce 校验", () => {
  it("成功 callback：state/nonce 匹配 → resolved + approve", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const created = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "auth",
      promptJson: { title: "登录 Google" },
    });

    const completed = await completeAuthCallback({
      tenantId,
      requestId: created.request.id,
      authState: created.authStatePlaintext ?? "",
      nonce: created.noncePlaintext ?? "",
      resolvedBy: userId,
    });

    expect(completed.requestState).toBe("resolved");
    expect(completed.resolution).toBe("approve");
    expect(completed.resolvedBy).toBe(userId);
  });

  it("state 不匹配 → AuthCallbackInvalidError + 请求保持 pending", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const created = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "auth",
      promptJson: { title: "x" },
    });

    await expect(
      completeAuthCallback({
        tenantId,
        requestId: created.request.id,
        authState: "wrong-state",
        nonce: created.noncePlaintext ?? "",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionAuthCallbackInvalidError);

    const after = await getUserActionRequestById(tenantId, created.request.id);
    expect(after?.requestState).toBe("pending");
  });

  it("nonce 不匹配 → AuthCallbackInvalidError + 请求保持 pending", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const created = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "auth",
      promptJson: { title: "x" },
    });

    await expect(
      completeAuthCallback({
        tenantId,
        requestId: created.request.id,
        authState: created.authStatePlaintext ?? "",
        nonce: "wrong-nonce",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionAuthCallbackInvalidError);

    const after = await getUserActionRequestById(tenantId, created.request.id);
    expect(after?.requestState).toBe("pending");
  });

  it("非 auth 类型 → AuthCallbackInvalidError", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const created = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
    });

    await expect(
      completeAuthCallback({
        tenantId,
        requestId: created.request.id,
        authState: "any",
        nonce: "any",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionAuthCallbackInvalidError);
  });

  it("已 resolved 的 auth 请求 → AlreadyResolvedError", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const created = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "auth",
      promptJson: { title: "x" },
    });

    await completeAuthCallback({
      tenantId,
      requestId: created.request.id,
      authState: created.authStatePlaintext ?? "",
      nonce: created.noncePlaintext ?? "",
      resolvedBy: userId,
    });

    await expect(
      completeAuthCallback({
        tenantId,
        requestId: created.request.id,
        authState: created.authStatePlaintext ?? "",
        nonce: created.noncePlaintext ?? "",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionAlreadyResolvedError);
  });

  it("请求不存在 → NotFoundError", async () => {
    const { tenantId, userId } = await seedContext();
    await expect(
      completeAuthCallback({
        tenantId,
        requestId: randomUUID(),
        authState: "any",
        nonce: "any",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionNotFoundError);
  });

  it("跨租户 → NotFoundError", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const created = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "auth",
      promptJson: { title: "x" },
    });

    await expect(
      completeAuthCallback({
        tenantId: randomUUID(),
        requestId: created.request.id,
        authState: created.authStatePlaintext ?? "",
        nonce: created.noncePlaintext ?? "",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionNotFoundError);
  });

  it("过期 auth 请求 callback → AlreadyResolvedError", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const created = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "auth",
      promptJson: { title: "x" },
      expiresAt: futureTime(1),
    });
    await backdateRequestExpiry(created.request.id, 1);

    await expect(
      completeAuthCallback({
        tenantId,
        requestId: created.request.id,
        authState: created.authStatePlaintext ?? "",
        nonce: created.noncePlaintext ?? "",
        resolvedBy: userId,
      }),
    ).rejects.toThrow(UserActionAlreadyResolvedError);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. markExpiredUserActionRequests：批量扫描
// ═══════════════════════════════════════════════════════════

describe("V11 markExpiredUserActionRequests：批量扫描", () => {
  it("批量标记过期 pending → expired", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();

    // 已过期但 state 仍为 pending
    const expired1 = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "1" },
      expiresAt: futureTime(1),
    });
    await backdateRequestExpiry(expired1.request.id, 1);
    const expired2 = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "input",
      promptJson: { title: "2" },
      inputSchemaJson: { type: "object" },
      expiresAt: futureTime(2),
    });
    await backdateRequestExpiry(expired2.request.id, 2);

    // 未过期
    const active = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "3" },
      expiresAt: futureTime(1),
    });

    // 永不过期
    const neverExpires = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "4" },
    });

    const count = await markExpiredUserActionRequests();
    expect(count).toBe(2);

    const after1 = await getUserActionRequestById(tenantId, expired1.request.id);
    const after2 = await getUserActionRequestById(tenantId, expired2.request.id);
    const afterActive = await getUserActionRequestById(tenantId, active.request.id);
    const afterNever = await getUserActionRequestById(tenantId, neverExpires.request.id);
    expect(after1?.requestState).toBe("expired");
    expect(after2?.requestState).toBe("expired");
    expect(afterActive?.requestState).toBe("pending");
    expect(afterNever?.requestState).toBe("pending");
  });

  it("无过期请求返回 0", async () => {
    const { tenantId } = await seedContext();
    const ids = randomContextIds();

    await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
      expiresAt: futureTime(1),
    });

    const count = await markExpiredUserActionRequests();
    expect(count).toBe(0);
  });

  it("已 resolved 的过期请求不被再次标记", async () => {
    const { tenantId, userId } = await seedContext();
    const ids = randomContextIds();

    const created = await createUserActionRequest({
      tenantId,
      ...ids,
      requestType: "confirmation",
      promptJson: { title: "x" },
      expiresAt: futureTime(1),
    });
    await resolveUserActionRequest({
      tenantId,
      requestId: created.request.id,
      resolution: "approve",
      resolvedBy: userId,
    });
    await backdateRequestExpiry(created.request.id, 1);

    const count = await markExpiredUserActionRequests();
    expect(count).toBe(0);

    const after = await getUserActionRequestById(tenantId, created.request.id);
    expect(after?.requestState).toBe("resolved");
  });
});
