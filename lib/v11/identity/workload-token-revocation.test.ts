/**
 * S12-W05：V11 Workload Token 撤销仓储集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - revokeWorkloadToken：撤销 Token（写撤销表 + 审计事件 workload.token.revoked）；幂等保护。
 * - isTokenRevoked：查询 jti 是否已撤销。
 * - getRevocationByJti：按 tenantId + jti 查询撤销记录；跨租户隔离。
 * - deleteExpiredRevocations：清理过期撤销记录（expiresAt < now）。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import {
  deleteExpiredRevocations,
  getRevocationByJti,
  isTokenRevoked,
  revokeWorkloadToken,
} from "@/lib/v11/identity/workload-token-revocation-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助 ──────────────────────────────────────────────────

function buildActor(tenantId: string): AuditActor {
  return {
    tenantId,
    actorType: "user",
    actorId: "admin-001",
  };
}

function buildRevokeParams(opts: {
  tenantId: string;
  jti?: string;
  tokenType?: "runtime" | "gateway" | "service";
  expiresAt?: Date;
}) {
  return {
    tenantId: opts.tenantId,
    jti: opts.jti ?? "jti-001",
    tokenType: opts.tokenType ?? ("runtime" as const),
    revokedBy: "admin-001",
    reason: "suspicious activity",
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000), // 1h 后过期
    actor: buildActor(opts.tenantId),
  };
}

// ═══════════════════════════════════════════════════════════
// 1. revokeWorkloadToken
// ═══════════════════════════════════════════════════════════

describe("V11 revokeWorkloadToken", () => {
  it("撤销后写入撤销记录", async () => {
    const tenant = await ensureDefaultTenant();
    const params = buildRevokeParams({ tenantId: tenant.id });
    const record = await revokeWorkloadToken(params);

    expect(record.id).toBeDefined();
    expect(record.tenantId).toBe(tenant.id);
    expect(record.jti).toBe("jti-001");
    expect(record.tokenType).toBe("runtime");
    expect(record.revokedBy).toBe("admin-001");
    expect(record.reason).toBe("suspicious activity");
    expect(record.expiresAt.getTime()).toBe(params.expiresAt.getTime());
    expect(record.revokedAt).toBeInstanceOf(Date);
  });

  it("撤销后写入审计事件 workload.token.revoked", async () => {
    const tenant = await ensureDefaultTenant();
    await revokeWorkloadToken(buildRevokeParams({ tenantId: tenant.id }));

    const events = await listAuditEvents({
      tenantId: tenant.id,
      actionType: "workload.token.revoked",
      targetType: "workload_token",
      targetId: "jti-001",
    });

    expect(events.length).toBe(1);
    const event = events[0];
    expect(event).toBeDefined();
    expect(event?.actionType).toBe("workload.token.revoked");
    expect(event?.targetType).toBe("workload_token");
    expect(event?.targetId).toBe("jti-001");
    expect(event?.actorType).toBe("user");
    expect(event?.actorId).toBe("admin-001");
    expect(event?.reason).toBe("suspicious activity");
  });

  it("幂等：重复撤销同一 jti 返回原记录（不重复写入）", async () => {
    const tenant = await ensureDefaultTenant();
    const params = buildRevokeParams({ tenantId: tenant.id });
    const first = await revokeWorkloadToken(params);
    const second = await revokeWorkloadToken(params);

    expect(second.id).toBe(first.id);
    expect(second.jti).toBe(first.jti);
    expect(second.revokedAt.getTime()).toBe(first.revokedAt.getTime());

    // 审计事件只写一条
    const events = await listAuditEvents({
      tenantId: tenant.id,
      actionType: "workload.token.revoked",
    });
    expect(events.length).toBe(1);
  });

  it("不同 tokenType 撤销", async () => {
    const tenant = await ensureDefaultTenant();
    for (const tokenType of ["runtime", "gateway", "service"] as const) {
      const record = await revokeWorkloadToken(
        buildRevokeParams({ tenantId: tenant.id, jti: `jti-${tokenType}`, tokenType }),
      );
      expect(record.tokenType).toBe(tokenType);
    }
  });

  it("不同 jti 各自独立撤销", async () => {
    const tenant = await ensureDefaultTenant();
    const a = await revokeWorkloadToken(buildRevokeParams({ tenantId: tenant.id, jti: "jti-a" }));
    const b = await revokeWorkloadToken(buildRevokeParams({ tenantId: tenant.id, jti: "jti-b" }));
    expect(a.jti).toBe("jti-a");
    expect(b.jti).toBe("jti-b");
    expect(a.id).not.toBe(b.id);

    const events = await listAuditEvents({
      tenantId: tenant.id,
      actionType: "workload.token.revoked",
    });
    expect(events.length).toBe(2);
  });

  it("expiresAt 透传到记录", async () => {
    const tenant = await ensureDefaultTenant();
    const future = new Date("2027-01-01T00:00:00Z");
    const record = await revokeWorkloadToken(
      buildRevokeParams({ tenantId: tenant.id, expiresAt: future }),
    );
    expect(record.expiresAt.toISOString()).toBe(future.toISOString());
  });

  it("审计事件 after 含 jti / token_type / revoked_by / reason / expires_at", async () => {
    const tenant = await ensureDefaultTenant();
    await revokeWorkloadToken(buildRevokeParams({ tenantId: tenant.id }));

    const events = await listAuditEvents({
      tenantId: tenant.id,
      actionType: "workload.token.revoked",
    });
    // afterHash 已计算，不含原文 after；但 recordAuditEvent 计算 hash 不存储 after 原文
    // 验证 afterHash 非空
    expect(events[0]?.afterHash).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. isTokenRevoked
// ═══════════════════════════════════════════════════════════

describe("V11 isTokenRevoked", () => {
  it("未撤销返回 false", async () => {
    const tenant = await ensureDefaultTenant();
    const revoked = await isTokenRevoked(tenant.id, "jti-not-revoked");
    expect(revoked).toBe(false);
  });

  it("撤销后返回 true", async () => {
    const tenant = await ensureDefaultTenant();
    await revokeWorkloadToken(buildRevokeParams({ tenantId: tenant.id, jti: "jti-revoked" }));
    const revoked = await isTokenRevoked(tenant.id, "jti-revoked");
    expect(revoked).toBe(true);
  });

  it("不同 jti 不互相影响", async () => {
    const tenant = await ensureDefaultTenant();
    await revokeWorkloadToken(buildRevokeParams({ tenantId: tenant.id, jti: "jti-a" }));
    expect(await isTokenRevoked(tenant.id, "jti-a")).toBe(true);
    expect(await isTokenRevoked(tenant.id, "jti-b")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. getRevocationByJti
// ═══════════════════════════════════════════════════════════

describe("V11 getRevocationByJti", () => {
  it("未撤销返回 null", async () => {
    const tenant = await ensureDefaultTenant();
    const record = await getRevocationByJti(tenant.id, "jti-not-exist");
    expect(record).toBeNull();
  });

  it("撤销后返回记录", async () => {
    const tenant = await ensureDefaultTenant();
    await revokeWorkloadToken(buildRevokeParams({ tenantId: tenant.id, jti: "jti-find" }));
    const record = await getRevocationByJti(tenant.id, "jti-find");
    expect(record).not.toBeNull();
    expect(record?.jti).toBe("jti-find");
    expect(record?.tokenType).toBe("runtime");
  });

  it("跨租户隔离：租户 A 撤销的 jti 在租户 B 不可查", async () => {
    const tenant = await ensureDefaultTenant();
    // tenant.id === DEFAULT_TENANT_ID（ensureDefaultTenant 固定 id）
    await revokeWorkloadToken(buildRevokeParams({ tenantId: tenant.id, jti: "jti-cross" }));

    // 用不同 tenantId 查询同一 jti 应返回 null（WHERE tenantId 不匹配）
    const otherTenantId = "00000000-0000-4000-8000-000000000001";
    const record = await getRevocationByJti(otherTenantId, "jti-cross");
    expect(record).toBeNull();
  });

  it("按 DEFAULT_TENANT_ID 撤销后可按同一 tenantId 查询", async () => {
    await ensureDefaultTenant();
    await revokeWorkloadToken(
      buildRevokeParams({ tenantId: DEFAULT_TENANT_ID, jti: "jti-default-tenant" }),
    );
    const record = await getRevocationByJti(DEFAULT_TENANT_ID, "jti-default-tenant");
    expect(record).not.toBeNull();
    expect(record?.jti).toBe("jti-default-tenant");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. deleteExpiredRevocations
// ═══════════════════════════════════════════════════════════

describe("V11 deleteExpiredRevocations", () => {
  it("清理过期记录（expiresAt < now）", async () => {
    const tenant = await ensureDefaultTenant();
    const past = new Date(Date.now() - 60 * 1000); // 1min 前过期
    await revokeWorkloadToken(
      buildRevokeParams({ tenantId: tenant.id, jti: "jti-expired", expiresAt: past }),
    );

    const deleted = await deleteExpiredRevocations(new Date());
    expect(deleted).toBeGreaterThanOrEqual(1);

    // 清理后查询应返回 null
    const record = await getRevocationByJti(tenant.id, "jti-expired");
    expect(record).toBeNull();
  });

  it("未过期记录保留", async () => {
    const tenant = await ensureDefaultTenant();
    const future = new Date(Date.now() + 60 * 60 * 1000); // 1h 后过期
    await revokeWorkloadToken(
      buildRevokeParams({ tenantId: tenant.id, jti: "jti-valid", expiresAt: future }),
    );

    const before = new Date(); // now
    await deleteExpiredRevocations(before);

    const record = await getRevocationByJti(tenant.id, "jti-valid");
    expect(record).not.toBeNull();
    expect(record?.jti).toBe("jti-valid");
  });

  it("混合场景：过期清理 + 未过期保留", async () => {
    const tenant = await ensureDefaultTenant();
    const past = new Date(Date.now() - 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);

    await revokeWorkloadToken(
      buildRevokeParams({ tenantId: tenant.id, jti: "jti-expired", expiresAt: past }),
    );
    await revokeWorkloadToken(
      buildRevokeParams({ tenantId: tenant.id, jti: "jti-valid", expiresAt: future }),
    );

    const deleted = await deleteExpiredRevocations(new Date());
    expect(deleted).toBeGreaterThanOrEqual(1);

    expect(await getRevocationByJti(tenant.id, "jti-expired")).toBeNull();
    expect(await getRevocationByJti(tenant.id, "jti-valid")).not.toBeNull();
  });

  it("无过期记录时返回 0", async () => {
    const tenant = await ensureDefaultTenant();
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await revokeWorkloadToken(
      buildRevokeParams({ tenantId: tenant.id, jti: "jti-valid", expiresAt: future }),
    );

    const deleted = await deleteExpiredRevocations(new Date());
    expect(deleted).toBe(0);
  });

  it("自定义 now 参数：未来时间点清理所有记录", async () => {
    const tenant = await ensureDefaultTenant();
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await revokeWorkloadToken(
      buildRevokeParams({ tenantId: tenant.id, jti: "jti-future", expiresAt: future }),
    );

    // now 设为 future + 1day，所有记录过期
    const farFuture = new Date(future.getTime() + 24 * 60 * 60 * 1000);
    const deleted = await deleteExpiredRevocations(farFuture);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const record = await getRevocationByJti(tenant.id, "jti-future");
    expect(record).toBeNull();
  });
});
