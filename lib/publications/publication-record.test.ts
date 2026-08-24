import { db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import * as publicationQueries from "@/lib/publications/persistence/publication-record-queries";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

async function expectDuplicateEntry(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(isMysqlDuplicateEntryError(caught)).toBe(true);
}

describe("PublicationRecord 与 WithdrawalRecord", () => {
  it("为 Revision 保存不可变发布事实并分配单调 publicationSequence", async () => {
    const tenant = await ensureDefaultTenant();

    await db.insert(publicationRecord).values([
      {
        id: "publication-record-1",
        tenantId: tenant.id,
        subjectType: "agent_revision",
        subjectRevisionId: "agent-revision-1",
        evidenceSetDigest: `sha256:${"a".repeat(64)}`,
        attestationIds: ["attestation-1"],
        conformanceRunId: null,
        approvals: [],
        publishedByType: "user",
        publishedBy: "user-1",
        publishedAt: new Date("2026-08-02T00:00:00.000Z"),
        idempotencyKey: "publish-agent-revision-1",
        idempotencyRecordId: "idempotency-record-1",
      },
      {
        id: "publication-record-2",
        tenantId: tenant.id,
        subjectType: "runtime_revision",
        subjectRevisionId: "runtime-revision-1",
        evidenceSetDigest: `sha256:${"b".repeat(64)}`,
        attestationIds: ["attestation-2"],
        conformanceRunId: "conformance-run-1",
        approvals: [{ approval_id: "approval-1" }],
        publishedByType: "service",
        publishedBy: "release-service",
        publishedAt: new Date("2026-08-02T00:01:00.000Z"),
        idempotencyKey: "publish-runtime-revision-1",
        idempotencyRecordId: "idempotency-record-2",
      },
    ]);

    const agentRecord = await publicationQueries.getPublicationRecordBySubject({
      tenantId: tenant.id,
      subjectType: "agent_revision",
      subjectRevisionId: "agent-revision-1",
    });
    const runtimeRecord = await publicationQueries.getPublicationRecordBySubject({
      tenantId: tenant.id,
      subjectType: "runtime_revision",
      subjectRevisionId: "runtime-revision-1",
    });

    expect(agentRecord?.publicationSequence).toBeGreaterThan(0);
    expect(runtimeRecord?.publicationSequence).toBeGreaterThan(
      agentRecord?.publicationSequence ?? 0,
    );
    expect(agentRecord?.attestationIds).toEqual(["attestation-1"]);
    expect(runtimeRecord?.conformanceRunId).toBe("conformance-run-1");
  });

  it("数据库唯一约束拒绝同一 subject Revision 的第二个发布事实", async () => {
    const tenant = await ensureDefaultTenant();
    const values = {
      tenantId: tenant.id,
      subjectType: "agent_revision" as const,
      subjectRevisionId: "agent-revision-unique",
      evidenceSetDigest: `sha256:${"c".repeat(64)}`,
      attestationIds: [],
      conformanceRunId: null,
      approvals: [],
      publishedByType: "system" as const,
      publishedBy: "test",
      publishedAt: new Date("2026-08-02T00:00:00.000Z"),
      idempotencyKey: "publication-unique",
      idempotencyRecordId: null,
    };
    await db.insert(publicationRecord).values({ id: "publication-unique-1", ...values });

    await expectDuplicateEntry(
      db.insert(publicationRecord).values({ id: "publication-unique-2", ...values }),
    );
  });

  it("数据库唯一约束拒绝重复命令事实和同一 Revision 的第二个撤回事实", async () => {
    const tenant = await ensureDefaultTenant();
    await db.insert(publicationRecord).values({
      id: "publication-withdrawal-1",
      tenantId: tenant.id,
      subjectType: "agent_revision",
      subjectRevisionId: "agent-revision-withdrawal",
      evidenceSetDigest: `sha256:${"d".repeat(64)}`,
      attestationIds: [],
      conformanceRunId: null,
      approvals: [],
      publishedByType: "user",
      publishedBy: "user-1",
      publishedAt: new Date("2026-08-02T00:00:00.000Z"),
      idempotencyKey: "publication-withdrawal",
      idempotencyRecordId: "idempotency-publication-withdrawal",
    });

    await expectDuplicateEntry(
      db.insert(publicationRecord).values({
        id: "publication-command-conflict",
        tenantId: tenant.id,
        subjectType: "runtime_revision",
        subjectRevisionId: "runtime-revision-command-conflict",
        evidenceSetDigest: `sha256:${"e".repeat(64)}`,
        attestationIds: [],
        conformanceRunId: null,
        approvals: [],
        publishedByType: "user",
        publishedBy: "user-1",
        publishedAt: new Date("2026-08-02T00:00:00.000Z"),
        idempotencyKey: "different-key",
        idempotencyRecordId: "idempotency-publication-withdrawal",
      }),
    );

    const withdrawalValues = {
      tenantId: tenant.id,
      publicationRecordId: "publication-withdrawal-1",
      subjectType: "agent_revision" as const,
      subjectRevisionId: "agent-revision-withdrawal",
      reasonCode: "security_policy",
      reason: "撤回存在风险的版本",
      withdrawnByType: "user" as const,
      withdrawnBy: "user-1",
      withdrawnAt: new Date("2026-08-02T01:00:00.000Z"),
    };
    await db.insert(withdrawalRecord).values({ id: "withdrawal-record-1", ...withdrawalValues });
    await expectDuplicateEntry(
      db.insert(withdrawalRecord).values({ id: "withdrawal-record-2", ...withdrawalValues }),
    );

    expect(
      await publicationQueries.getWithdrawalRecordBySubject({
        tenantId: tenant.id,
        subjectType: "agent_revision",
        subjectRevisionId: "agent-revision-withdrawal",
      }),
    ).toMatchObject({
      publicationRecordId: "publication-withdrawal-1",
      reasonCode: "security_policy",
    });
  });

  it("正式查询模块不暴露 PublicationRecord 或 WithdrawalRecord 的更新删除入口", () => {
    // 全部导出必须是只读查询；禁止 update/delete/insert 写入口（§27 一个事实一个 Authority）。
    const writeEntryPattern = /^(update|delete|insert|upsert|remove|truncate)/i;
    const exports = Object.keys(publicationQueries).sort();
    expect(exports.length).toBeGreaterThanOrEqual(3);
    expect(exports.filter((name) => writeEntryPattern.test(name))).toEqual([]);
    // 基线的只读查询面稳定存在
    expect(exports).toContain("getPublicationRecordById");
    expect(exports).toContain("getPublicationRecordBySubject");
    expect(exports).toContain("getWithdrawalRecordBySubject");
  });
});
