import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("ExecutionBinding Attestation JSON 基线约束", () => {
  it("Runtime Attestation JSON 为必填数组列；Agent 无 Attestation 列（黑盒权威）", () => {
    const schema = projectFile("lib/persistence/schema/executions.ts");

    // Runtime 维度：runtimeAttestationIds 为必填 JSON 数组（精确证据 ID 有序去重数组；
    // 外部 endpoint 允许空数组——V12 冻结基线不在 DB 层用 JSON_TYPE CHECK 表达）。
    expect(schema).toContain(
      'runtimeAttestationIds: json("runtimeAttestationIds").$type<string[]>().notNull()',
    );
    // Agent 是源码不可见黑盒：无 Agent Artifact/Attestation 列。
    expect(schema).not.toContain("agentAttestationIds");
    expect(schema).not.toContain("agentArtifactId");
    expect(schema).not.toContain("agentArtifactDigest");
  });

  it("V12 冻结架构：ExecutionBinding 不携带 Agent Contract 证据列；Runtime Artifact ID 走 external_endpoint 判别", () => {
    const schema = projectFile("lib/persistence/schema/executions.ts");
    const baseline = projectFile("drizzle/0000_initial_schema.sql");
    // 只检查 ExecutionBinding 表块（agentContractSnapshotId 合法存在于 RuntimeArtifact 等表）。
    const bindingBlock =
      baseline.match(/CREATE TABLE `ExecutionBinding` \([\s\S]*?\n\)/)?.[0] ?? "";
    expect(bindingBlock).toContain("CREATE TABLE `ExecutionBinding`");

    // V12 冻结架构：ExecutionBinding 只绑定 Harness Runtime，不再携带任何 Agent evidence，
    // Agent Contract / Publication 证据列已从 schema 移除（源码与迁移基线均不得含）。
    for (const column of [
      "agentContractSnapshotId",
      "agentContractDigest",
      "agentContextDigest",
      "agentPublicationRecordId",
      "agentRevisionId",
    ]) {
      expect(schema).not.toContain(`"${column}"`);
      expect(bindingBlock).not.toContain(`\`${column}\``);
    }
    // Runtime 维度证据种类分派：hosted_artifact 必填 artifact；external_endpoint 无 artifact（可空）。
    expect(schema).toContain('runtimeEvidenceKind: ascii("runtimeEvidenceKind", 32)');
    expect(schema).toContain('"ExecutionBinding_runtime_evidence_allowed"');
    expect(schema).toContain("'hosted_artifact'");
    expect(schema).toContain("'external_endpoint'");
    expect(schema).toContain('"ExecutionBinding_artifact_evidence_shape"');
    expect(schema).toContain('runtimeArtifactId: ascii("runtimeArtifactId", 36)');
    expect(schema).not.toContain('runtimeArtifactId: ascii("runtimeArtifactId", 36).notNull()');
    expect(baseline).toContain("`runtimeArtifactId`");
    expect(baseline).toContain("`runtimeAttestationIds`");
    expect(baseline).toContain("`ExecutionBinding_runtime_evidence_allowed`");
    expect(baseline).toContain("`ExecutionBinding_artifact_evidence_shape`");

    // Runtime 维度索引按 tenantId + runtimeRevisionId 组织。
    expect(schema).toContain('"ExecutionBinding_tenant_runtime_revision_idx"');
  });
});
