import {
  AgentCallAuthorityMigrationConflictError,
  assertAgentCallAuthorityMigrationProfile,
} from "@/lib/agents/calls/persistence/agent-call-authority-migration";
import { describe, expect, it } from "vitest";

describe("AgentCall Authority migration guard", () => {
  it("迁移先画像阻断，再回填和删除旧 task Authority", () => {
    const sql = readFileSync(resolve("drizzle/0003_sweet_peter_parker.sql"), "utf8");
    const guardIndex = sql.indexOf("missing_source_action");
    const addColumnIndex = sql.indexOf("ADD `externalTaskRef`");
    const backfillIndex = sql.indexOf("SET attempt_row.`externalTaskRef`");
    const dropIndex = sql.indexOf("DROP COLUMN `externalTaskRef`");

    expect(guardIndex).toBeGreaterThan(0);
    expect(addColumnIndex).toBeGreaterThan(guardIndex);
    expect(backfillIndex).toBeGreaterThan(addColumnIndex);
    expect(dropIndex).toBeGreaterThan(backfillIndex);
    expect(sql).toContain("ambiguous_task_attempt");
    expect(sql).toContain("duplicate_context_mapping");
    expect(sql).toContain("transport_channel_unresolved");
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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
