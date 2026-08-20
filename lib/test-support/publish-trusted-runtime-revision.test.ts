import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { ALL_CONFORMANCE_CASES } from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  ConformanceSuiteFailedError,
  assertAllConformanceCasesPassed,
  runTrustedTestConformanceSuite,
} from "@/lib/test-support/publish-trusted-runtime-revision";
import { describe, expect, it } from "vitest";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** §18.6 明确禁止的全零占位摘要。 */
const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

/** 本切片真实的 isolated runner 尚未装配的三个 deep case（见 isolated-conformance-runner.ts）。 */
const GENUINELY_FAIL_CLOSED_CASES = [
  "child-thread-isolation",
  "credential-never-in-model-data",
  "execution-ownership-epoch",
] as const;

describe("runTrustedTestConformanceSuite（测试侧确定性 Conformance runner）", () => {
  it("逐条执行全部 ALL_CONFORMANCE_CASES，case 完整且唯一", async () => {
    const tenant = await ensureDefaultTenant();
    const report = await runTrustedTestConformanceSuite({
      tenantId: tenant.id,
      runtimeRevisionId: "revision-001",
      runtimeArtifactDigest: `sha256:${"a1".repeat(32)}`,
      runtimeConfigDigest: `sha256:${"b2".repeat(32)}`,
      protocolContractRevision: "a2a@1",
    });

    expect(report.caseResults).toHaveLength(ALL_CONFORMANCE_CASES.length);
    const caseIds = report.caseResults.map((r) => r.caseId);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    expect(caseIds).toEqual(expect.arrayContaining([...ALL_CONFORMANCE_CASES]));
  });

  it("基础 adapter probe 调用生产 runConformanceSuite：8 个基础 case 通过", async () => {
    const tenant = await ensureDefaultTenant();
    const report = await runTrustedTestConformanceSuite({
      tenantId: tenant.id,
      runtimeRevisionId: "revision-002",
      runtimeArtifactDigest: `sha256:${"c3".repeat(32)}`,
      runtimeConfigDigest: `sha256:${"d4".repeat(32)}`,
      protocolContractRevision: "a2a@1",
    });

    // 生产 runConformanceSuite 真实通过的基础 case（adapter probe / design guarantee）。
    const productionPassed = report.caseResults.filter((r) =>
      [
        "dispatch-binds-immutable-config",
        "event-batch-idempotent",
        "event-payload-hash-conflict",
        "attempt-sequence-continuity",
        "steer-requires-ack",
        "unsupported-steer",
        "cancel-request-not-terminal",
        "session-does-not-claim-filesystem-recovery",
      ].includes(r.caseId),
    );
    expect(productionPassed).toHaveLength(8);
    for (const result of productionPassed) {
      expect(result.passed, `基础 case ${result.caseId} 必须由生产 runner 真实通过`).toBe(true);
    }
  });

  it("每个 case 的 evidenceDigest 都是真实 SHA256 且非占位/非重复字符", async () => {
    const tenant = await ensureDefaultTenant();
    const report = await runTrustedTestConformanceSuite({
      tenantId: tenant.id,
      runtimeRevisionId: "revision-003",
      runtimeArtifactDigest: `sha256:${"e5".repeat(32)}`,
      runtimeConfigDigest: `sha256:${"f6".repeat(32)}`,
      protocolContractRevision: "a2a@1",
    });

    for (const result of report.caseResults) {
      expect(result.evidenceDigest, `case=${result.caseId}`).toMatch(SHA256_PATTERN);
      expect(result.evidenceDigest, `case=${result.caseId} 不得为全零占位摘要`).not.toBe(
        PLACEHOLDER_DIGEST,
      );
      const hex = result.evidenceDigest.replace("sha256:", "");
      const repeated = hex.length > 0 && new Set(hex.split("")).size === 1;
      expect(repeated, `case=${result.caseId} evidenceDigest 不得为重复字符`).toBe(false);
    }
    expect(report.runnerArtifactDigest).toMatch(SHA256_PATTERN);
    expect(report.runnerArtifactDigest).not.toBe(PLACEHOLDER_DIGEST);
    expect(report.evidenceManifestDigest).toMatch(SHA256_PATTERN);
    expect(report.evidenceManifestDigest).not.toBe(PLACEHOLDER_DIGEST);
  });

  it("真实 isolated 执行的 5 个 case 通过；3 个未装配 case 保持 fail-closed（不冒充 Passed）", async () => {
    const tenant = await ensureDefaultTenant();
    const report = await runTrustedTestConformanceSuite({
      tenantId: tenant.id,
      runtimeRevisionId: "revision-004",
      runtimeArtifactDigest: `sha256:${"a7".repeat(32)}`,
      runtimeConfigDigest: `sha256:${"b8".repeat(32)}`,
      protocolContractRevision: "a2a@1",
    });

    const genuinelyPassed = report.caseResults.filter((r) =>
      [
        "tool-schema-refresh",
        "unknown-effect-no-replay",
        "capability-search-not-use",
        "memory-proposal-only",
        "child-cancel-requires-ack",
      ].includes(r.caseId),
    );
    expect(genuinelyPassed).toHaveLength(5);
    for (const result of genuinelyPassed) {
      expect(result.passed, `isolated case ${result.caseId} 必须真实通过`).toBe(true);
      expect(result.reason).toBeNull();
    }

    // 3 个本切片未装配的 deep case：必须 fail-closed，不得被声明为通过。
    for (const caseId of GENUINELY_FAIL_CLOSED_CASES) {
      const result = report.caseResults.find((r) => r.caseId === caseId);
      expect(result, `case ${caseId} 必须存在`).toBeTruthy();
      expect(result?.passed, `case ${caseId} 必须 fail-closed（不得冒充 Passed）`).toBe(false);
      expect(result?.reason).toMatch(/fail-closed/);
    }
    // 存在 fail-closed → overallResult=failed，发布门禁拦截。
    expect(report.overallResult).toBe("failed");
    expect(() => assertAllConformanceCasesPassed(report)).toThrow(ConformanceSuiteFailedError);
  });

  it("任一 case 强制失败 → overallResult=failed 且发布门禁抛错，不能发布", async () => {
    const tenant = await ensureDefaultTenant();
    const failingReport = await runTrustedTestConformanceSuite({
      tenantId: tenant.id,
      runtimeRevisionId: "revision-005",
      runtimeArtifactDigest: `sha256:${"c9".repeat(32)}`,
      runtimeConfigDigest: `sha256:${"d0".repeat(32)}`,
      protocolContractRevision: "a2a@1",
      failCase: "dispatch-binds-immutable-config",
    });

    expect(failingReport.overallResult).toBe("failed");
    expect(
      failingReport.caseResults.find((r) => r.caseId === "dispatch-binds-immutable-config")?.passed,
    ).toBe(false);
    expect(() => assertAllConformanceCasesPassed(failingReport)).toThrow(
      ConformanceSuiteFailedError,
    );
  });

  it("evidenceManifestDigest 随 runtimeRevisionId 变化而变化（非硬编码常量）", async () => {
    const tenant = await ensureDefaultTenant();
    const reportA = await runTrustedTestConformanceSuite({
      tenantId: tenant.id,
      runtimeRevisionId: "revision-A",
      runtimeArtifactDigest: `sha256:${"a1".repeat(32)}`,
      runtimeConfigDigest: `sha256:${"b2".repeat(32)}`,
      protocolContractRevision: "a2a@1",
    });
    const reportB = await runTrustedTestConformanceSuite({
      tenantId: tenant.id,
      runtimeRevisionId: "revision-B",
      runtimeArtifactDigest: `sha256:${"a1".repeat(32)}`,
      runtimeConfigDigest: `sha256:${"b2".repeat(32)}`,
      protocolContractRevision: "a2a@1",
    });

    // §验收：manifest canonical 绑定 runtimeRevisionId，Revision 变化 → digest 必须变化。
    expect(reportA.evidenceManifestDigest).not.toBe(reportB.evidenceManifestDigest);
    // runner 制品内容固定，digest 应一致（确定性）。
    expect(reportA.runnerArtifactDigest).toBe(reportB.runnerArtifactDigest);
  });
});
