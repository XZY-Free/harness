/**
 * 02-6 P2 Governance 正式领域集成测试（真实 MySQL 8 · 冻结方案 §5 / §29 / §32 / §33 / §55.1）。
 *
 * 覆盖（§55.1）：
 * - initial revision（P1 baseline 可被 fail-closed 读取，返回 INITIAL_GOVERNANCE_CONFIG）。
 * - publish：新 published Revision + 切 currentRevisionId + versionNo+1 + AuditEvent 同事务。
 * - ETag conflict（versionNo 不匹配 → GovernanceVersionConflictError，DB 无变化）。
 * - invalid config（validate 拒绝）。
 * - digest stability。
 * - withdraw（手动置 withdrawn → load fail-closed）。
 * - disabled set（publish 拒绝）。
 * - cross tenant（load 无 Set → 抛错，不回退 INITIAL）。
 * - missing current revision（load 抛错）。
 * - DB failure no fallback：Set 缺失路径绝不 return INITIAL_GOVERNANCE_CONFIG。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { canonicalizeGovernanceConfig } from "@/lib/governance/compiler";
import {
  GovernanceConfigValidationError,
  INITIAL_GOVERNANCE_CONFIG,
  validateGovernanceConfig,
} from "@/lib/governance/config";
import {
  GovernanceLoadError,
  loadGovernanceConfigFromDB,
} from "@/lib/governance/governance-repository";
import {
  GovernanceSetStateError,
  GovernanceVersionConflictError,
  publishGovernanceConfig,
} from "@/lib/governance/publish-governance-config";
import { computeContentHash } from "@/lib/identity/audit";
import {
  DEFAULT_TENANT_ID,
  GOVERNANCE_CONFIG_SET_KEY,
  ensureDefaultTenant,
} from "@/lib/identity/tenant-bootstrap";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import {
  type GovernanceConfig,
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function setAuthMode(mode: string | undefined) {
  process.env.SNOW_AUTH_MODE = mode;
}

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

const ACTOR = { tenantId: DEFAULT_TENANT_ID, actorType: "user" as const, actorId: "test-user" };
const REQ_ID = "req-governance-1";

const NEW_CONFIG: GovernanceConfig = {
  protectedPaths: ["/etc/secret", "/home/user/.ssh"],
  commandDenyList: ["rm -rf"],
  formatOnWrite: true,
  verifyBeforeDelivery: false,
};

beforeEach(async () => {
  await resetDatabase(db);
  setAuthMode("dev");
  await ensureDefaultTenant();
});

afterEach(() => {
  setAuthMode(ORIGINAL_AUTH_MODE);
});

describe("Governance（02-6 P2 §5/§29/§32/§33/§55.1）", () => {
  it("initial revision：publish 前 load 返回 INITIAL + published + configDigest 稳定", async () => {
    const loaded = await loadGovernanceConfigFromDB(DEFAULT_TENANT_ID);
    expect(loaded.config).toEqual(INITIAL_GOVERNANCE_CONFIG);
    expect(loaded.configDigest).toBe(canonicalizeGovernanceConfig(INITIAL_GOVERNANCE_CONFIG));
    expect(loaded.configDigest.startsWith("sha256:")).toBe(true);
    expect(loaded.revision.revisionState).toBe("published");
    expect(loaded.revision.revisionNo).toBe(1);
    expect(loaded.set.configSetKey).toBe(GOVERNANCE_CONFIG_SET_KEY);
    expect(loaded.set.lifecycleState).toBe("enabled");
    expect(loaded.set.versionNo).toBe(1);
  });

  it("publish：新 published Revision + 切 currentRevisionId + versionNo+1 + AuditEvent 同事务", async () => {
    const result = await publishGovernanceConfig({
      tenantId: DEFAULT_TENANT_ID,
      newConfig: NEW_CONFIG,
      expectedVersionNo: 1,
      actor: ACTOR,
      requestId: REQ_ID,
    });

    expect(result.set.versionNo).toBe(2);
    expect(result.revision.revisionNo).toBe(2);
    expect(result.revision.revisionState).toBe("published");
    expect(result.revision.configJson).toEqual(NEW_CONFIG);
    expect(result.configDigest).toBe(canonicalizeGovernanceConfig(NEW_CONFIG));

    // load 现在返回新配置。
    const loaded = await loadGovernanceConfigFromDB(DEFAULT_TENANT_ID);
    expect(loaded.config).toEqual(NEW_CONFIG);
    expect(loaded.set.versionNo).toBe(2);

    // AuditEvent(governance.config.publish) 同事务落库（§35）。
    const events = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, DEFAULT_TENANT_ID)));
    expect(events).toHaveLength(1);
    expect(events[0]!.actionType).toBe("governance.config.publish");
    expect(events[0]!.targetType).toBe("governance_config");
    expect(events[0]!.targetId).toBe(result.set.id);
    // 审计契约：beforeHash/afterHash = computeContentHash（64 hex 无前缀，§35）。
    expect(events[0]!.beforeHash).toBe(computeContentHash(INITIAL_GOVERNANCE_CONFIG));
    expect(events[0]!.afterHash).toBe(computeContentHash(NEW_CONFIG));
    expect(events[0]!.actorId).toBe("test-user");
    expect(events[0]!.requestId).toBe(REQ_ID);
  });

  it("ETag conflict：versionNo 不匹配 → GovernanceVersionConflictError，DB 无变化", async () => {
    await expect(
      publishGovernanceConfig({
        tenantId: DEFAULT_TENANT_ID,
        newConfig: NEW_CONFIG,
        expectedVersionNo: 99,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(GovernanceVersionConflictError);

    // DB 未被污染：仍是 initial。
    const loaded = await loadGovernanceConfigFromDB(DEFAULT_TENANT_ID);
    expect(loaded.config).toEqual(INITIAL_GOVERNANCE_CONFIG);
    expect(loaded.set.versionNo).toBe(1);
  });

  it("invalid config → validateGovernanceConfig 拒绝发布", () => {
    const bad = { protectedPaths: "not-array", commandDenyList: [], formatOnWrite: "x" };
    expect(() => validateGovernanceConfig(bad)).toThrow(GovernanceConfigValidationError);
    // 合法 config 通过。
    expect(() => validateGovernanceConfig(NEW_CONFIG)).not.toThrow();
  });

  it("digest stability：同一 config 两次计算 digest 一致且带 sha256: 前缀", () => {
    const a = canonicalizeGovernanceConfig(NEW_CONFIG);
    const b = canonicalizeGovernanceConfig({ ...NEW_CONFIG });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("withdraw fail-closed：revision 被置 withdrawn → load 抛错", async () => {
    const loaded = await loadGovernanceConfigFromDB(DEFAULT_TENANT_ID);
    await db
      .update(governanceConfigRevisionTable)
      .set({ revisionState: "withdrawn" })
      .where(eq(governanceConfigRevisionTable.id, loaded.revision.id));
    await expect(loadGovernanceConfigFromDB(DEFAULT_TENANT_ID)).rejects.toBeInstanceOf(
      GovernanceLoadError,
    );
  });

  it("disabled set：publish 拒绝（GovernanceSetStateError）", async () => {
    const loaded = await loadGovernanceConfigFromDB(DEFAULT_TENANT_ID);
    await db
      .update(governanceConfigSetTable)
      .set({ lifecycleState: "disabled" })
      .where(eq(governanceConfigSetTable.id, loaded.set.id));
    await expect(
      publishGovernanceConfig({
        tenantId: DEFAULT_TENANT_ID,
        newConfig: NEW_CONFIG,
        expectedVersionNo: 1,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(GovernanceSetStateError);
  });

  it("cross tenant：无 Set → load 抛错（不回退 INITIAL_GOVERNANCE_CONFIG）", async () => {
    // 只建了 default tenant；另一个 tenant 无 GovernanceConfigSet。
    await expect(
      loadGovernanceConfigFromDB("99999999-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(GovernanceLoadError);
  });

  it("missing current revision：currentRevisionId 置 null → load 抛错", async () => {
    const loaded = await loadGovernanceConfigFromDB(DEFAULT_TENANT_ID);
    await db
      .update(governanceConfigSetTable)
      .set({ currentRevisionId: null })
      .where(eq(governanceConfigSetTable.id, loaded.set.id));
    await expect(loadGovernanceConfigFromDB(DEFAULT_TENANT_ID)).rejects.toBeInstanceOf(
      GovernanceLoadError,
    );
  });
});
