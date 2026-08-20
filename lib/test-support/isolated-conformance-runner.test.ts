import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { createHostedAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import { runConformanceSuite } from "@/lib/runtime/runtime-conformance-runner";
import { runIsolatedConformanceCases } from "@/lib/test-support/isolated-conformance-runner";
import { describe, expect, it } from "vitest";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

describe("runIsolatedConformanceCases（真实 isolated runner）", () => {
  it("补齐生产 runner fail-closed 的 4 个 case 并真实通过；其余 4 个 deep case fail-closed", async () => {
    const tenant = await ensureDefaultTenant();
    const runtimeRevisionId = "revision-isolated-001";
    const adapter = createHostedAdapter({
      platformEndpoint: "in-process://conformance-test",
      platformAuthToken: "conformance-test-token",
      modelFn: async (message) => `conformance probe reply: ${message}`,
      modelRef: "conformance-test-model",
    });
    const productionResults = await runConformanceSuite({
      tenantId: tenant.id,
      runtimeRevisionId,
      runtimeAdapter: adapter,
    });

    const result = await runIsolatedConformanceCases({
      tenantId: tenant.id,
      runtimeRevisionId,
      productionResults,
    });

    // 全部 16 个 case 都有结果。
    expect(result.caseResults).toHaveLength(16);

    // 由 isolated runner 真实执行的 case 必须通过，且带真实非占位 evidenceDigest。
    for (const caseId of [
      "tool-schema-refresh",
      "unknown-effect-no-replay",
      "capability-search-not-use",
      "memory-proposal-only",
      "child-cancel-requires-ack",
    ]) {
      const r = result.caseResults.find((c) => c.caseId === caseId);
      expect(r, `case ${caseId} 必须有结果`).toBeTruthy();
      expect(r?.passed, `case ${caseId} 必须真实通过`).toBe(true);
      expect(r?.evidenceDigest).toMatch(SHA256_PATTERN);
      expect(r?.evidenceDigest).not.toMatch(/sha256:0{64}$/);
    }

    // 未装配 deep case 必须 fail-closed（不得冒充 Passed）。child-thread-isolation 的
    // 子 Turn/Invocation/Event/budget/投影已接线，但 immutable ExecutionBinding 需已发布
    // Runtime（受 conformance 门禁死锁），故保持 fail-closed 并给出精确缺口。
    for (const caseId of [
      "child-thread-isolation",
      "credential-never-in-model-data",
      "execution-ownership-epoch",
    ]) {
      const r = result.caseResults.find((c) => c.caseId === caseId);
      expect(r, `case ${caseId} 必须有结果`).toBeTruthy();
      expect(r?.passed, `case ${caseId} 必须 fail-closed`).toBe(false);
      expect(r?.reason).toMatch(/fail-closed/);
    }
  });

  it("强制 failCase → 对应 case 明确失败且整体不可发布", async () => {
    const tenant = await ensureDefaultTenant();
    const runtimeRevisionId = "revision-isolated-002";
    const adapter = createHostedAdapter({
      platformEndpoint: "in-process://conformance-test",
      platformAuthToken: "conformance-test-token",
      modelFn: async (message) => `conformance probe reply: ${message}`,
      modelRef: "conformance-test-model",
    });
    const productionResults = await runConformanceSuite({
      tenantId: tenant.id,
      runtimeRevisionId,
      runtimeAdapter: adapter,
    });

    const result = await runIsolatedConformanceCases({
      tenantId: tenant.id,
      runtimeRevisionId,
      productionResults,
      failCase: "tool-schema-refresh",
    });
    const forced = result.caseResults.find((c) => c.caseId === "tool-schema-refresh");
    expect(forced?.passed).toBe(false);
    expect(forced?.reason).toMatch(/forced-failure-for-test/);
  });
});
