import { validAgentRouteResolution } from "@/lib/agents/calls/test/agent-call-test-fixtures";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { resolveBindingGovernance } from "@/lib/executions/application/resolve-binding-governance";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { agentTable } from "@/lib/persistence/schema/agents";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildProductionCapabilityCatalog } from "./build-production-capability-catalog";

beforeEach(async () => {
  await resetDatabase(db);
});

describe("ExecutionBinding capability catalog persistence", () => {
  it("fresh migration 创建不可空的快照、摘要、版本、来源和创建时间列", async () => {
    const [rows] = await db.execute(
      sql.raw(
        "SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS " +
          "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ExecutionBinding' " +
          "AND COLUMN_NAME IN ('capabilityCatalogJson','capabilityCatalogDigest','capabilityCatalogVersion','capabilityCatalogSourceRefs','capabilityCatalogCreatedAt')",
      ),
    );
    const columns = new Map(
      (rows as unknown as Array<{ COLUMN_NAME: string; IS_NULLABLE: string }>).map((row) => [
        row.COLUMN_NAME,
        row.IS_NULLABLE,
      ]),
    );
    expect([...columns.keys()].sort()).toEqual([
      "capabilityCatalogCreatedAt",
      "capabilityCatalogDigest",
      "capabilityCatalogJson",
      "capabilityCatalogSourceRefs",
      "capabilityCatalogVersion",
    ]);
    expect([...columns.values()]).toEqual(["NO", "NO", "NO", "NO", "NO"]);
  });

  it("生产 Catalog 只投影 exact ContractSnapshot scenario，Agent 改名不生成场景", async () => {
    const tenant = await ensureDefaultTenant();
    const owner = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "catalog-scenario-owner",
      email: "catalog-scenario-owner@example.com",
      displayName: "Catalog Scenario Owner",
    });
    const agent = await createAgent({
      tenantId: tenant.id,
      agentKey: "hr-assistant",
      displayName: "HR Agent",
      ownerUserId: owner.id,
      lifecycleState: "enabled",
    });
    const snapshot = await seedAgentContractSnapshot({
      tenantId: tenant.id,
      agentId: agent.id,
      createdBy: owner.id,
    });
    await db
      .update(agentTable)
      .set({ displayName: "财务 Agent" })
      .where(eq(agentTable.id, agent.id));
    const governance = await resolveBindingGovernance(db, tenant.id, null);
    const baseResolution = validAgentRouteResolution();
    const resolution = validAgentRouteResolution({
      policyRevisionId: governance.policyRevisionId,
      target: {
        ...baseResolution.target,
        agentRevisionId: "agent-revision-scenario",
      },
      controlPlaneEvidence: {
        kind: "agent",
        agentContractSnapshotId: snapshot.id,
        agentContractDigest: snapshot.contractDigest,
        agentContextDigest: snapshot.contextDigest,
        agentPublicationRecordId: "publication-scenario",
      },
    });
    const result = await buildProductionCapabilityCatalog({
      tenantId: tenant.id,
      invocationId: "invocation-scenario",
      threadId: "thread-scenario",
      preferredAgentId: agent.id,
      runtimeRevisionId: "runtime-revision-scenario",
      policyRevisionId: governance.policyRevisionId,
      policyRulesDigest: governance.policyRulesDigest,
      executionSubject: { tenantId: tenant.id, subjectType: "user", subjectId: owner.id },
      resolveRoute: async () => ({ status: "resolved", eligibleCandidateCount: 1, resolution }),
    });

    expect(result.snapshot.agents).toEqual([
      expect.objectContaining({
        displayName: "财务 Agent",
        scenarioDeclaration: "unspecified",
        applicableScenarios: [],
        excludedScenarios: [],
      }),
    ]);
  });
});
