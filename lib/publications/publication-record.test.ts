import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import * as publicationQueries from "@/lib/publications/persistence/publication-record-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { v11Agent, v11AgentRevision } from "@/lib/v11/schema/agent";
import { v11Runtime, v11RuntimeRevision } from "@/lib/v11/schema/runtime";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

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

    await expect(
      db.insert(publicationRecord).values({ id: "publication-unique-2", ...values }),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
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

    await expect(
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
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });

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
    await expect(
      db.insert(withdrawalRecord).values({ id: "withdrawal-record-2", ...withdrawalValues }),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });

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
    expect(Object.keys(publicationQueries).sort()).toEqual([
      "getPublicationRecordById",
      "getPublicationRecordBySubject",
      "getWithdrawalRecordBySubject",
    ]);
  });

  it("迁移为既有 Agent 与 Runtime 的 published/withdrawn 投影建立可追溯正式事实", async () => {
    const tenant = await ensureDefaultTenant();
    await db.insert(v11Agent).values({
      id: "migration-agent",
      tenantId: tenant.id,
      agentKey: "migration-agent",
      displayName: "Migration Agent",
      ownerUserId: "migration-owner",
    });
    await db.insert(v11AgentRevision).values([
      {
        id: "migration-agent-published",
        agentId: "migration-agent",
        revisionNo: 1,
        sourceType: "code",
        sourceRevision: "published",
        instructionHash: "sha256:published",
        agentArtifactRef: "artifact://agent/published",
        modelPolicyJson: {},
        permissionRequirementsJson: [],
        delegationPolicyJson: {},
        agentInterfaceRequirementsJson: {},
        revisionState: "published",
        createdBy: "legacy-user",
        publishedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      {
        id: "migration-agent-withdrawn",
        agentId: "migration-agent",
        revisionNo: 2,
        sourceType: "code",
        sourceRevision: "withdrawn",
        instructionHash: "sha256:withdrawn",
        agentArtifactRef: "artifact://agent/withdrawn",
        modelPolicyJson: {},
        permissionRequirementsJson: [],
        delegationPolicyJson: {},
        agentInterfaceRequirementsJson: {},
        revisionState: "withdrawn",
        createdBy: "legacy-user",
        publishedAt: new Date("2026-07-02T00:00:00.000Z"),
      },
    ]);
    await db.insert(v11Runtime).values({
      id: "migration-runtime",
      tenantId: tenant.id,
      runtimeKey: "migration-runtime",
      displayName: "Migration Runtime",
      runtimeKind: "external",
      ownerUserId: "migration-owner",
    });
    await db.insert(v11RuntimeRevision).values([
      {
        id: "migration-runtime-published",
        runtimeId: "migration-runtime",
        revisionNo: 1,
        protocolType: "a2a",
        endpointRef: "endpoint://published",
        runtimeArtifactRef: "artifact://runtime/published",
        runtimeCapabilitiesJson: {},
        identityMode: "workload_token",
        networkZone: "internal",
        configHash: "sha256:published",
        revisionState: "published",
        createdBy: "legacy-user",
        publishedAt: new Date("2026-07-03T00:00:00.000Z"),
      },
      {
        id: "migration-runtime-withdrawn",
        runtimeId: "migration-runtime",
        revisionNo: 2,
        protocolType: "a2a",
        endpointRef: "endpoint://withdrawn",
        runtimeArtifactRef: "artifact://runtime/withdrawn",
        runtimeCapabilitiesJson: {},
        identityMode: "workload_token",
        networkZone: "internal",
        configHash: "sha256:withdrawn",
        revisionState: "withdrawn",
        createdBy: "legacy-user",
        publishedAt: new Date("2026-07-04T00:00:00.000Z"),
      },
    ]);

    const migrationSql = await readFile(
      resolve(process.cwd(), "drizzle/0112_publication_records.sql"),
      "utf8",
    );
    const backfillStatements = migrationSql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.startsWith("INSERT INTO"));
    expect(backfillStatements).toHaveLength(4);
    for (const statement of backfillStatements) {
      await db.execute(sql.raw(statement.replace(/;\s*$/, "")));
    }

    const subjects = [
      ["agent_revision", "migration-agent-published", false],
      ["agent_revision", "migration-agent-withdrawn", true],
      ["runtime_revision", "migration-runtime-published", false],
      ["runtime_revision", "migration-runtime-withdrawn", true],
    ] as const;
    for (const [subjectType, subjectRevisionId, isWithdrawn] of subjects) {
      const publication = await publicationQueries.getPublicationRecordBySubject({
        tenantId: tenant.id,
        subjectType,
        subjectRevisionId,
      });
      expect(publication).toMatchObject({
        attestationIds: [],
        conformanceRunId: null,
        publishedByType: "system",
        publishedBy: "migration-0112",
      });
      expect(publication?.evidenceSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(
        await publicationQueries.getWithdrawalRecordBySubject({
          tenantId: tenant.id,
          subjectType,
          subjectRevisionId,
        }),
      ).toEqual(
        isWithdrawn
          ? expect.objectContaining({
              publicationRecordId: publication?.id,
              reasonCode: "legacy_state_backfill",
              withdrawnBy: "migration-0112",
            })
          : null,
      );
    }
  });
});
