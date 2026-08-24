import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("ExecutionBinding Attestation JSON 基线约束", () => {
  it("Runtime Attestation JSON 限定非空数组；Agent Attestation 可空（§18 基础 Route）", () => {
    const schema = projectFile("lib/persistence/schema/executions.ts");
    const baseline = projectFile("drizzle/0000_initial_schema.sql");

    // Runtime 维度（Agent Route 必填）仍为非空 JSON Array。
    expect(schema).toContain(
      `JSON_TYPE(\${t.runtimeAttestationIds}) = 'ARRAY' AND JSON_LENGTH(\${t.runtimeAttestationIds}) >= 1`,
    );
    expect(baseline).toContain(
      "JSON_TYPE(`runtimeAttestationIds`) = 'ARRAY' AND JSON_LENGTH(`runtimeAttestationIds`) >= 1",
    );
    // Agent 维度（基础 Harness Route，agentRevisionId=null，§18 not_applicable）可空为 null，
    // Schema 不再声明非空 CHECK；基线 0000 为历史原始 schema，仍保留非空 CHECK（迁移 0003 才移除）。
    expect(schema).not.toContain(
      `JSON_TYPE(\${t.agentAttestationIds}) = 'ARRAY' AND JSON_LENGTH(\${t.agentAttestationIds}) >= 1`,
    );
    expect(baseline).toContain(
      "JSON_TYPE(`agentAttestationIds`) = 'ARRAY' AND JSON_LENGTH(`agentAttestationIds`) >= 1",
    );
  });

  it("Agent Artifact ID 可空（§18），Runtime Artifact ID 必填；均带索引", () => {
    const schema = projectFile("lib/persistence/schema/executions.ts");
    const baseline = projectFile("drizzle/0000_initial_schema.sql");
    const snapshot = projectFile("drizzle/meta/0000_snapshot.json");

    // Agent 维度可空（基础 Harness Route，§18 not_applicable）——不再 .notNull()。
    expect(schema).toContain(`agentArtifactId: varchar("agentArtifactId", { length: 36 })`);
    expect(schema).not.toContain(
      `agentArtifactId: varchar("agentArtifactId", { length: 36 }).notNull()`,
    );
    // Runtime 维度必填。
    expect(schema).toContain(
      `runtimeArtifactId: varchar("runtimeArtifactId", { length: 36 }).notNull()`,
    );

    // 基线 0000 为历史原始 schema，两列均 NOT NULL（迁移 0003 才放宽 Agent 维度）。
    for (const column of ["agentArtifactId", "runtimeArtifactId"] as const) {
      expect(baseline).toContain(`\`${column}\` varchar(36) NOT NULL`);
      expect(snapshot).toContain(`"name": "${column}"`);
    }
    // 两列均保留索引。
    for (const indexName of [
      "ExecutionBinding_agentArtifact_idx",
      "ExecutionBinding_runtimeArtifact_idx",
    ]) {
      expect(schema).toContain(indexName);
      expect(baseline).toContain(indexName);
      expect(snapshot).toContain(indexName);
    }
  });
});

describe("Route 历史表 append-only 基线约束", () => {
  it.each(["RouteRevision", "RouteActivation"])("%s 禁止 UPDATE", (table) => {
    const baseline = projectFile("drizzle/0000_initial_schema.sql");

    expect(baseline).toContain(`CREATE TRIGGER \`${table}_prevent_update\``);
    expect(baseline).toContain(`BEFORE UPDATE ON \`${table}\``);
    expect(baseline).toContain(`MESSAGE_TEXT = '${table} is append-only'`);
  });
});
