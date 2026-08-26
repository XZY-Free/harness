import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("ExecutionBinding Attestation JSON 基线约束", () => {
  it("Runtime Attestation JSON 限定非空数组；Agent 无 Attestation 列（黑盒权威）", () => {
    const schema = projectFile("lib/persistence/schema/executions.ts");

    // Runtime 维度（hosted 必填非空 JSON Array；external_endpoint 允许空数组，03 §3）。
    expect(schema).toContain(
      `JSON_TYPE(\${t.runtimeAttestationIds}) = 'ARRAY' AND (JSON_LENGTH(\${t.runtimeAttestationIds}) >= 1 OR \${t.runtimeEvidenceKind} = 'external_endpoint')`,
    );
    // Agent 是源码不可见黑盒：无 Agent Artifact/Attestation 列（迁移 0016 删除）。
    expect(schema).not.toContain("agentAttestationIds");
    expect(schema).not.toContain("agentArtifactId");
    expect(schema).not.toContain("agentArtifactDigest");
  });

  it("Agent Contract 证据列存在；Runtime Artifact ID 可空（external_endpoint）", () => {
    const schema = projectFile("lib/persistence/schema/executions.ts");
    const latest = projectFile("drizzle/0016_youthful_redwing.sql");

    // Agent 发布权威 = AgentContractSnapshot 三元组（contract/capability/context digest）。
    for (const column of [
      "agentContractSnapshotId",
      "agentContractDigest",
      "agentContextDigest",
      "agentPublicationRecordId",
    ]) {
      expect(schema).toContain(`"${column}"`);
    }
    // Runtime 维度证据种类分派（03 §3）：hosted_artifact 必填 artifact；external_endpoint 无 artifact（可空）。
    expect(schema).toContain(`runtimeArtifactId: varchar("runtimeArtifactId", { length: 36 })`);
    expect(schema).not.toContain(
      `runtimeArtifactId: varchar("runtimeArtifactId", { length: 36 }).notNull()`,
    );
    expect(schema).toContain(`runtimeEvidenceKind: mysqlEnum("runtimeEvidenceKind", [`);
    expect(schema).toContain('"hosted_artifact",');
    expect(schema).toContain('"external_endpoint",');

    // 迁移 0016 正式删除 Agent 源码权威列。
    for (const column of ["agentArtifactId", "agentArtifactDigest", "agentAttestationIds"]) {
      expect(latest).toContain(`DROP COLUMN \`${column}\``);
    }
    expect(schema).toContain("ExecutionBinding_runtimeArtifact_idx");
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
