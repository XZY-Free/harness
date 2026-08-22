import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { computeBindingConfigHash } from "@/lib/executions/test-support/create-unverified-execution-binding";
/**
 * D 阶段 §10.3/§10.4 ExecutionBinding Agent Evidence 条件性完整组集成测试（真实 MySQL 8）。
 *
 * §10.3：Agent Evidence 必须是「全部为空」（base route，§18 not_applicable）或「全部完整」
 * （agent route，§7.4）。DB 层 CHECK（迁移 0004，手写）拒绝「随便 nullable」的半完整组。
 *
 * §10.4：Binding config hash 对 base route 的 agent evidence 用 canonical null（禁空串/省略歧义）。
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/** 构造一个 ExecutionBinding 的 raw INSERT 行（满足全部 NOT NULL 列；agent 维度由调用方指定）。 */
function bindingInsertSql(
  invocationId: string,
  agentRevisionId: string | null,
  agentArtifactId: string | null,
  agentArtifactDigest: string | null,
  agentAttestationIds: string[] | null,
  agentPublicationRecordId: string | null,
): string {
  const digest = (hex: string) => `sha256:${hex.repeat(64)}`;
  const attestationSql = (ids: string[] | null) =>
    ids === null ? "NULL" : `JSON_ARRAY(${ids.map((id) => `'${id}'`).join(",")})`;
  const s = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
  return `INSERT INTO \`ExecutionBinding\` (
    invocationId, tenantId, runtimeRevisionId, deploymentRouteId, modelProvider, modelId,
    policyRevisionId, policyRulesDigest, governanceConfigRevisionId, governanceConfigDigest,
    routeRevisionId, routeActivationId, routeContentDigest, runtimeArtifactId, runtimeArtifactDigest,
    runtimeConfigDigest, capabilityManifestDigest, runtimeAttestationIds, runtimePublicationRecordId,
    conformanceRunId, resolutionInputDigest, projectionVersionNo, configHash, boundAt,
    agentRevisionId, agentArtifactId, agentArtifactDigest, agentAttestationIds, agentPublicationRecordId
  ) VALUES (
    '${invocationId}', 'tenant-1', 'runtime-rev-1', 'route-1', 'provider', 'model',
    'policy-rev-1', '${digest("a")}', 'gov-rev-1', '${digest("b")}',
    'route-rev-1', 'route-act-1', '${digest("c")}', 'runtime-art-1', '${digest("d")}',
    '${digest("e")}', '${digest("f")}', JSON_ARRAY('runtime-att-1'), 'runtime-pub-1',
    'conformance-1', '${digest("g")}', 1, '${digest("h")}', '2026-01-01 00:00:00.000',
    ${s(agentRevisionId)}, ${s(agentArtifactId)}, ${s(agentArtifactDigest)},
    ${attestationSql(agentAttestationIds)}, ${s(agentPublicationRecordId)}
  )`;
}

async function insertBinding(sqlText: string): Promise<void> {
  // 每个用例独立事务：关 FK（测试用最小行无依赖）→ insert → 校验 → 失败回滚。resetDatabase 已隔离。
  const conn = db.$client as import("mysql2/promise").Pool;
  const connection = await conn.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("SET FOREIGN_KEY_CHECKS=0");
    await connection.execute(sqlText);
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    await connection.execute("SET FOREIGN_KEY_CHECKS=1").catch(() => undefined);
    connection.release();
  }
}

describe("ExecutionBinding Agent Evidence 条件性完整组（§10.3/§10.4）", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("base route（agent 全 null）通过 DB CHECK —— §10.3 全部为空合法", async () => {
    await expect(
      insertBinding(bindingInsertSql("inv-base-1", null, null, null, null, null)),
    ).resolves.toBeUndefined();
  });

  it("agent route（agent 全完整）通过 DB CHECK —— §10.3 全部完整合法", async () => {
    await expect(
      insertBinding(
        bindingInsertSql(
          "inv-agent-1",
          "agent-rev-1",
          "agent-art-1",
          `sha256:${"2".repeat(64)}`,
          ["agent-att-1"],
          "agent-pub-1",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("半完整组（agentRevisionId=null 但 agentArtifactId 非空）被 DB CHECK 拒绝 —— §10.3 禁 4 态模糊", async () => {
    await expect(
      insertBinding(
        bindingInsertSql(
          "inv-half-1",
          null, // agentRevisionId null（base 语义）
          "agent-art-1", // 但 agentArtifactId 非空 → 半完整组
          `sha256:${"2".repeat(64)}`,
          ["agent-att-1"],
          "agent-pub-1",
        ),
      ),
    ).rejects.toThrow();
  });

  it("半完整组（agentRevisionId 非空但 agentAttestationIds 空数组）被 DB CHECK 拒绝 —— §10.3", async () => {
    await expect(
      insertBinding(
        bindingInsertSql(
          "inv-half-2",
          "agent-rev-1",
          "agent-art-1",
          `sha256:${"2".repeat(64)}`,
          [], // 空数组非 JSON_LENGTH>=1 → 半完整
          "agent-pub-1",
        ),
      ),
    ).rejects.toThrow();
  });

  it("config hash：base route 的 null agent evidence 为 canonical null（§10.4），且与 concrete / 空串均不同摘要", () => {
    const baseParams = {
      runtimeRevisionId: "runtime-rev-1",
      deploymentRouteId: "route-1",
      modelProvider: "provider",
      modelId: "model",
      modelRevisionRef: null,
      initialEnvironmentLeaseId: null,
      workspaceBindingId: null,
      policyRevisionId: null,
      contextCheckpointId: null,
    };
    const base = computeBindingConfigHash({ ...baseParams, agentRevisionId: null });
    const concrete = computeBindingConfigHash({ ...baseParams, agentRevisionId: "agent-rev-1" });
    // canonical null 确定性：同一输入重复计算摘要一致（§10.4 稳定）。
    expect(base).toBe(computeBindingConfigHash({ ...baseParams, agentRevisionId: null }));
    // base(null) 与 concrete 必须不同（§8.4 防 4 态模糊）。
    expect(base).not.toBe(concrete);
    // 空串不是 null（§8.4 禁空串伪 null）：空串产生不同摘要，杜绝同一语义不同 Hash。
    expect(computeBindingConfigHash({ ...baseParams, agentRevisionId: "" })).not.toBe(base);
  });
});
