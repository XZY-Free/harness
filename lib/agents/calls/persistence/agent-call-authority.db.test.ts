import { createCreateAgentCall } from "@/lib/agents/calls/application/create-agent-call";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
} from "@/lib/persistence/schema/agent-calls";
import { capabilityUseTable } from "@/lib/persistence/schema/capability-use";
import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let scenario: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>> | null = null;

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(async () => {
  if (!scenario) return;
  delete process.env[scenario.credentialEnvVar];
  await scenario.provider.server.close();
  scenario = null;
});

describe("AgentCall 数据 Authority", () => {
  it("主表不保存 revision/context/task，logicalCallKey 为非空", async () => {
    const [databaseRows] = (await db.execute("SELECT DATABASE() AS databaseName")) as unknown as [
      Array<{ databaseName: string }>,
    ];
    const databaseName = databaseRows[0]?.databaseName;
    const [rows] = (await db.execute(
      `SELECT COLUMN_NAME AS columnName, IS_NULLABLE AS isNullable, COLUMN_TYPE AS columnType
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = '${databaseName}' AND TABLE_NAME = 'AgentCall'`,
    )) as unknown as [Array<{ columnName: string; isNullable: "YES" | "NO"; columnType: string }>];
    const columns = new Map(rows.map((row) => [row.columnName, row]));

    expect(columns.has("agentRevisionId")).toBe(false);
    expect(columns.has("externalContextRef")).toBe(false);
    expect(columns.has("externalTaskRef")).toBe(false);
    expect(columns.get("logicalCallKey")?.isNullable).toBe("NO");
    expect(columns.get("sourceRef")?.isNullable).toBe("NO");
    expect(columns.get("sourceType")?.columnType).toBe("enum('harness_planned')");
    expect(agentCallTable).not.toHaveProperty("externalTaskRef");
  });

  it("并发提交同一父 Invocation/action/Agent 只创建一个规范 Call", async () => {
    scenario = await seedAgentCallExecutionScenario();
    await db.delete(agentCallAttemptTable).where(eq(agentCallAttemptTable.callId, scenario.callId));
    await db.delete(agentCallBindingTable).where(eq(agentCallBindingTable.callId, scenario.callId));
    await db.delete(agentCallTable).where(eq(agentCallTable.id, scenario.callId));
    await db
      .delete(capabilityUseTable)
      .where(eq(capabilityUseTable.invocationId, scenario.parentInvocationId));
    const create = createCreateAgentCall({ store: mysqlAgentCallStore });
    const command = {
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      agentId: scenario.agentId,
      actionId: scenario.actionId,
      transportChannel: "hosted" as const,
      bindingCandidate: scenario.binding,
    };
    const [first, second] = await Promise.all([create(command), create(command)]);
    const [row] = await db
      .select({ value: count() })
      .from(agentCallTable)
      .where(
        and(
          eq(agentCallTable.parentInvocationId, scenario.parentInvocationId),
          eq(agentCallTable.logicalCallKey, scenario.logicalCallKey),
        ),
      );
    const [attempt] = await db
      .select()
      .from(agentCallAttemptTable)
      .where(eq(agentCallAttemptTable.callId, first.call.id));

    expect(second.call.id).toBe(first.call.id);
    expect(row?.value).toBe(1);
    expect(attempt).toMatchObject({
      attemptNo: 1,
      transportChannel: "hosted",
      transportMetadataJson: { channel: "hosted" },
    });
    await expect(
      db.execute(`UPDATE AgentCall SET logicalCallKey = NULL WHERE id = '${first.call.id}'`),
    ).rejects.toThrow();
  });
});
