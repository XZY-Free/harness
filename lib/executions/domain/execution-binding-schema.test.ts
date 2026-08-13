import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("ExecutionBinding Attestation JSON 基线约束", () => {
  it("Drizzle Schema 与 0000 SQL 都限定为非空 JSON Array", () => {
    const schema = projectFile("lib/persistence/schema/runtime.ts");
    const baseline = projectFile("drizzle/0000_initial_schema.sql");

    for (const column of ["agentAttestationIds", "runtimeAttestationIds"]) {
      expect(schema).toContain(
        `JSON_TYPE(\${t.${column}}) = 'ARRAY' AND JSON_LENGTH(\${t.${column}}) >= 1`,
      );
      expect(baseline).toContain(
        `JSON_TYPE(\`${column}\`) = 'ARRAY' AND JSON_LENGTH(\`${column}\`) >= 1`,
      );
    }
  });

  it("Artifact ID 在 Schema、基线 SQL 与 Snapshot 中均为必填并带索引", () => {
    const schema = projectFile("lib/persistence/schema/runtime.ts");
    const baseline = projectFile("drizzle/0000_initial_schema.sql");
    const snapshot = projectFile("drizzle/meta/0000_snapshot.json");

    for (const [column, indexName] of [
      ["agentArtifactId", "ExecutionBinding_agentArtifact_idx"],
      ["runtimeArtifactId", "ExecutionBinding_runtimeArtifact_idx"],
    ] as const) {
      expect(schema).toContain(`${column}: varchar("${column}", { length: 36 }).notNull()`);
      expect(baseline).toContain(`\`${column}\` varchar(36) NOT NULL`);
      expect(snapshot).toContain(`"name": "${column}"`);
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
