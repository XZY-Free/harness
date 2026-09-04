import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AgentCallAuthorityMigrationConflictError,
  assertAgentCallAuthorityMigrationProfile,
} from "@/lib/agents/calls/persistence/agent-call-authority-migration";
import { describe, expect, it } from "vitest";

describe("AgentCall Authority migration guard", () => {
  it("干净基线只创建最终 AgentCall Authority，不携带旧 task Authority", () => {
    const sql = readFileSync(resolve("drizzle/0000_initial_schema.sql"), "utf8");
    const agentCall = sql.slice(
      sql.indexOf("CREATE TABLE `AgentCall`"),
      sql.indexOf("CREATE TABLE `AgentSessionBinding`"),
    );
    const attempt = sql.slice(
      sql.indexOf("CREATE TABLE `AgentCallAttempt`"),
      sql.indexOf("CREATE TABLE `AgentCallBinding`"),
    );

    expect(agentCall).toContain("`logicalCallKey` varchar(256) NOT NULL");
    expect(agentCall).toContain("`creationRequestDigest` varchar(71) NOT NULL");
    expect(agentCall).not.toContain("`externalTaskRef`");
    expect(attempt).toContain("`externalTaskRef` varchar(256)");
    expect(attempt).toContain("`transportChannel` enum('hosted','gateway') NOT NULL");
    expect(sql).not.toContain("_AgentCallAuthorityMigrationGuard");
  });

  it("阻断无法回填的非终态记录并报告精确分类", () => {
    expect(() =>
      assertAgentCallAuthorityMigrationProfile({
        totalCalls: 3,
        missingSourceActionCount: 1,
        emptyLogicalCallKeyCount: 1,
        taskAuthorityConflictCount: 0,
        ambiguousTaskAttemptCount: 0,
        duplicateTaskMappingCount: 0,
        duplicateContextMappingCount: 0,
        duplicateBindingCount: 0,
        attemptSequenceConflictCount: 0,
        nonTerminalOrphanCount: 1,
      }),
    ).toThrowError(AgentCallAuthorityMigrationConflictError);
    try {
      assertAgentCallAuthorityMigrationProfile({
        totalCalls: 3,
        missingSourceActionCount: 1,
        emptyLogicalCallKeyCount: 1,
        taskAuthorityConflictCount: 0,
        ambiguousTaskAttemptCount: 0,
        duplicateTaskMappingCount: 0,
        duplicateContextMappingCount: 0,
        duplicateBindingCount: 0,
        attemptSequenceConflictCount: 0,
        nonTerminalOrphanCount: 1,
      });
    } catch (error) {
      expect(error).toMatchObject({
        conflicts: expect.arrayContaining(["missing_source_action=1", "non_terminal_orphan=1"]),
      });
    }
  });
});
