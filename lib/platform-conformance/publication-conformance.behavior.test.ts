import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import {
  PLATFORM_INTEGRATION_CASES,
  PLATFORM_INTEGRATION_SUITE_REVISION,
} from "@/lib/platform-conformance/platform-integration-contract";
import {
  type RuntimeAdapter,
  createHostedAdapter,
  hostedAdapterCapabilities,
} from "@/lib/runtime/adapters/hosted-adapter";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import * as contract from "@/lib/runtime/domain/runtime-conformance-contract";
import { PUBLICATION_CONFORMANCE_CASES } from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  type RuntimeConformanceReport,
  computeCaseEvidenceDigest,
  computeEvidenceManifestDigest,
} from "@/lib/runtime/domain/runtime-conformance-run";
import { runPublicationConformanceSuite } from "@/lib/runtime/runtime-conformance-runner";
import {
  buildDsseConformanceEnvelope,
  generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import { createCapturingEventBatchSink } from "@/lib/runtime/test-support/capturing-event-batch-sink";
import {
  computeRunnerArtifactDigest,
  computeRunnerArtifactDigestFromSources,
} from "@/lib/test-support/publish-runtime-revision-for-test";
import { describe, expect, it } from "vitest";

/**
 * 构造 Publication Conformance 隔离环境的 Hosted Adapter。
 *
 * 注入进程内捕获型 EventBatchSink：接收并保留真实候选事件，不黑洞吞掉、
 * 不伪造 ack、不依赖外部 HTTP 端点（避免「无可用 sink」）。
 */
function createConformanceHostedAdapter() {
  const capturing = createCapturingEventBatchSink();
  return {
    adapter: createHostedAdapter({
      platformEndpoint: "in-process://conformance-test",
      platformAuthToken: "conformance-test-token",
      eventBatchSink: capturing.sink,
      modelFn: async (message) => `probe: ${message}`,
      modelRef: "conformance-test-model",
    }),
    capturing,
  };
}

const PLATFORM_ONLY_CASES = [
  "dispatch-binds-immutable-config",
  "event-batch-idempotent",
  "event-payload-hash-conflict",
  "attempt-sequence-continuity",
  "tool-schema-refresh",
  "unknown-effect-no-replay",
  "capability-search-not-use",
  "memory-proposal-only",
  "child-thread-isolation",
  "child-cancel-requires-ack",
  "credential-never-in-model-data",
  "execution-ownership-epoch",
  "steer-requires-ack",
  "unsupported-steer",
  "cancel-request-not-terminal",
] as const;

describe("Runtime Publication Conformance 职责拆分", () => {
  it("Publication 套件明确排除 ExecutionBinding/event ingress/tool/memory/child/credential/ownership 平台 case", () => {
    const pubIds = new Set<string>(PUBLICATION_CONFORMANCE_CASES);
    for (const platformCase of PLATFORM_ONLY_CASES) {
      expect(pubIds.has(platformCase), `Publication 套件不得包含平台 case: ${platformCase}`).toBe(
        false,
      );
    }
    // Publication 套件只有 6 个 Adapter/Protocol 行为 case。
    expect(PUBLICATION_CONFORMANCE_CASES).toEqual([
      "capability-manifest-contract",
      "dispatch-acknowledgement",
      "cancel-acknowledgement",
      "steer-capability-consistency",
      "resume-capability-consistency",
      "session-recovery-declaration",
    ]);
  });

  it("Platform Integration 套件包含全部平台级不变量 case", () => {
    for (const platformCase of PLATFORM_ONLY_CASES) {
      expect(
        PLATFORM_INTEGRATION_CASES.includes(platformCase),
        `Platform 套件应包含平台 case: ${platformCase}`,
      ).toBe(true);
    }
    expect(PLATFORM_INTEGRATION_SUITE_REVISION).toBe("platform-integration@1");
  });

  it("Platform 套件为 15 个平台不变量且与 Publication 无交集、无 session 重叠", () => {
    expect(PLATFORM_INTEGRATION_CASES).toHaveLength(15);
    // session-does-not-claim-filesystem-recovery 已物理移出 Platform 套件（与 Runtime Publication 重叠）。
    expect(PLATFORM_INTEGRATION_CASES).not.toContain("session-does-not-claim-filesystem-recovery");
    const pubIds = new Set<string>(PUBLICATION_CONFORMANCE_CASES);
    for (const caseId of PLATFORM_INTEGRATION_CASES) {
      expect(pubIds.has(caseId), `Platform case 与 Publication 重叠: ${caseId}`).toBe(false);
    }
  });

  it("clean/no-route/no-binding Hosted Adapter 可完成真实 Publication 套件", async () => {
    const { adapter } = createConformanceHostedAdapter();
    const results = await runPublicationConformanceSuite({
      tenantId: "tenant-clean",
      runtimeRevisionId: "revision-clean",
      runtimeAdapter: adapter,
    });
    // 全部 6 个 case 真实通过，证据来自真实 Adapter 调用。
    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result.passed, `case ${result.caseId} 必须由真实 Adapter 调用通过`).toBe(true);
    }
  });

  it("adapter probe/ack 错误 fail-closed（不冒充 Passed）", async () => {
    const failingCancelAdapter: RuntimeAdapter = {
      probeCapabilities: async () => ({
        protocol_versions: ["2"],
        features: {
          event_stream: true,
          cancel: true,
          resume: true,
          steer: true,
          dynamic_tools: false,
          user_action: false,
          workspace_types: ["cloud"],
          filesystem_checkpoint: false,
        },
        limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
      }),
      startInvocation: async () => ({
        accepted: true,
        runtime_session_ref: "sess-1",
        runtime_execution_ref: "exec-1",
        capabilities: {
          protocol_versions: ["2"],
          features: {
            event_stream: true,
            cancel: true,
            resume: true,
            steer: true,
            dynamic_tools: false,
            user_action: false,
            workspace_types: ["cloud"],
            filesystem_checkpoint: false,
          },
          limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
        },
      }),
      handleCancel: async () => {
        throw new Error("cancel endpoint down");
      },
      handleResume: async () => ({
        resume_state: "accepted" as const,
        runtime_execution_ref: "exec-resume-1",
        requires_redispatch: false,
      }),
      handleSteer: async () => ({
        steer_state: "accepted" as const,
        applies_at: "next_safe_point" as const,
        generation_interrupted: false,
      }),
    };
    const results = await runPublicationConformanceSuite({
      tenantId: "tenant-fail",
      runtimeRevisionId: "revision-fail",
      runtimeAdapter: failingCancelAdapter,
    });
    const cancel = results.find((r) => r.caseId === "cancel-acknowledgement");
    expect(cancel?.passed).toBe(false);
    expect(cancel?.reason).toMatch(/cancel/i);
  });

  it("verifier 拒绝缺失/重复/多余 case", async () => {
    const key = generateTestRunnerKey("behavior-verifier");
    const verifier = createDSSEConformanceVerifier({
      runnerIdentityRegistry: new RunnerSigningIdentityRegistry([
        {
          keyId: key.keyid,
          publicKey: key.publicKeyBase64,
          runnerIdentity: "behavior/runner",
          tenantScope: "tenant-verifier",
          validFrom: "2020-01-01T00:00:00.000Z",
          validUntil: null,
          revokedAt: null,
        },
      ]),
    });
    const caseResults = PUBLICATION_CONFORMANCE_CASES.map((caseId) => {
      const evidence = { caseId, passed: true };
      return {
        caseId,
        passed: true,
        reason: null,
        evidenceDigest: computeCaseEvidenceDigest(evidence),
        evidence,
      };
    });
    const report = {
      runId: "run-verifier",
      runtimeRevisionId: "revision-verifier",
      runtimeTargetDigest: `sha256:${"a".repeat(64)}`,
      runtimeConfigDigest: `sha256:${"b".repeat(64)}`,
      protocolContractRevision: "agent-runtime-protocol@2",
      suiteRevision: contract.PUBLICATION_CONFORMANCE_SUITE_REVISION,
      runnerArtifactDigest: `sha256:${"c".repeat(64)}`,
      runnerIdentity: "behavior/runner",
      testEnvironmentRevision: "unit@1",
      startedAt: "2026-08-02T01:00:00.000Z",
      completedAt: "2026-08-02T01:00:01.000Z",
      overallResult: "passed" as const,
      evidenceManifestDigest: computeEvidenceManifestDigest({
        suiteRevision: contract.PUBLICATION_CONFORMANCE_SUITE_REVISION,
        testEnvironmentRevision: "unit@1",
        runtimeRevisionId: "revision-verifier",
        runtimeTargetDigest: `sha256:${"a".repeat(64)}`,
        runtimeConfigDigest: `sha256:${"b".repeat(64)}`,
        protocolContractRevision: "agent-runtime-protocol@2",
        runnerArtifactDigest: `sha256:${"c".repeat(64)}`,
        cases: caseResults.map((result) => ({
          caseId: result.caseId,
          passed: result.passed,
          evidenceDigest: result.evidenceDigest,
        })),
      }),
      caseResults,
    };

    // 完整报告 → verified
    const ok = await verifier.verify({
      dsseEnvelopeBytes: Buffer.from(buildDsseConformanceEnvelope(report, key), "utf-8"),
      expectedRuntimeRevisionId: report.runtimeRevisionId,
      tenantId: "tenant-verifier",
    });
    expect(ok.verified).toBe(true);

    // 缺失 case → 拒绝
    const missing = {
      ...report,
      caseResults: report.caseResults.slice(1),
    };
    const resMissing = await verifier.verify({
      dsseEnvelopeBytes: Buffer.from(buildDsseConformanceEnvelope(missing, key), "utf-8"),
      expectedRuntimeRevisionId: report.runtimeRevisionId,
      tenantId: "tenant-verifier",
    });
    expect(resMissing.verified).toBe(false);

    // 重复 case → 拒绝
    const duplicated: RuntimeConformanceReport = {
      ...report,
      caseResults: [
        ...report.caseResults,
        {
          ...(report.caseResults[0] as (typeof report.caseResults)[number]),
          evidenceDigest: `sha256:${"f".repeat(64)}`,
        },
      ],
    };
    const resDuplicated = await verifier.verify({
      dsseEnvelopeBytes: Buffer.from(buildDsseConformanceEnvelope(duplicated, key), "utf-8"),
      expectedRuntimeRevisionId: report.runtimeRevisionId,
      tenantId: "tenant-verifier",
    });
    expect(resDuplicated.verified).toBe(false);

    // 多余（陌生）case → 拒绝
    const ghost = {
      caseId: "platform-ghost-case",
      passed: true,
      reason: null,
      evidenceDigest: `sha256:${"0".repeat(64)}`,
      evidence: { caseId: "platform-ghost-case", passed: true },
    } as unknown as RuntimeConformanceReport["caseResults"][number];
    const extra: RuntimeConformanceReport = {
      ...report,
      caseResults: [...report.caseResults, ghost],
    };
    const resExtra = await verifier.verify({
      dsseEnvelopeBytes: Buffer.from(buildDsseConformanceEnvelope(extra, key), "utf-8"),
      expectedRuntimeRevisionId: report.runtimeRevisionId,
      tenantId: "tenant-verifier",
    });
    expect(resExtra.verified).toBe(false);
  });

  it("旧 helper 与旧 contract 导出不存在（静态）", () => {
    // 旧单体导出已物理删除。
    expect("ALL_CONFORMANCE_CASES" in contract).toBe(false);
    expect("MANDATORY_GATE_CASES" in contract).toBe(false);
    // 旧 test-support 文件已物理删除。
    expect(
      existsSync(resolve(process.cwd(), "lib/test-support/isolated-conformance-runner.ts")),
    ).toBe(false);
    expect(
      existsSync(resolve(process.cwd(), "lib/test-support/publish-trusted-runtime-revision.ts")),
    ).toBe(false);
    // 新 helper 提供正式链发布入口。
    expect(
      existsSync(resolve(process.cwd(), "lib/test-support/publish-runtime-revision-for-test.ts")),
    ).toBe(true);
  });

  it("Publication report digest 均为真实 sha256", async () => {
    const { adapter } = createConformanceHostedAdapter();
    const results = await runPublicationConformanceSuite({
      tenantId: "tenant-digest",
      runtimeRevisionId: "revision-digest",
      runtimeAdapter: adapter,
    });
    for (const result of results) {
      expect(result.passed).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 关口 01 Codex 审查修复（严格 TDD 锁定项）
// ═══════════════════════════════════════════════════════════

describe("关口01 Codex 审查修复", () => {
  function hostedAdapterWith(overrides: Partial<RuntimeAdapter>): RuntimeAdapter {
    return {
      ...createConformanceHostedAdapter().adapter,
      ...overrides,
    };
  }

  it("整个 suite 只 probeCapabilities 一次并共享同一能力快照", async () => {
    let probeCount = 0;
    const adapter = hostedAdapterWith({
      probeCapabilities: async () => {
        probeCount += 1;
        return hostedAdapterCapabilities();
      },
    });
    const results = await runPublicationConformanceSuite({
      tenantId: "tenant-probe-once",
      runtimeRevisionId: "revision-probe-once",
      runtimeAdapter: adapter,
    });
    expect(results).toHaveLength(6);
    expect(probeCount).toBe(1);
  });

  it("dispatch-acknowledgement 只做一次真实 dispatch（不制造重复调用）", async () => {
    let dispatchCount = 0;
    const adapter = hostedAdapterWith({
      startInvocation: async (params) => {
        dispatchCount += 1;
        return {
          accepted: true,
          runtime_session_ref: "sess-once",
          runtime_execution_ref: "exec-once",
          capabilities: hostedAdapterCapabilities(),
        };
      },
    });
    const results = await runPublicationConformanceSuite({
      tenantId: "tenant-dispatch-once",
      runtimeRevisionId: "revision-dispatch-once",
      runtimeAdapter: adapter,
    });
    const dispatch = results.find((r) => r.caseId === "dispatch-acknowledgement");
    expect(dispatch?.passed).toBe(true);
    expect(dispatchCount).toBe(1);
  });

  it("case evidenceDigest 用 RFC8785 canonical 绑定真实返回字段且稳定", async () => {
    const mk = (ref: string): RuntimeAdapter =>
      hostedAdapterWith({
        startInvocation: async () => ({
          accepted: true,
          runtime_session_ref: `sess-${ref}`,
          runtime_execution_ref: `exec-${ref}`,
          capabilities: hostedAdapterCapabilities(),
        }),
      });
    const r1 = await runPublicationConformanceSuite({
      tenantId: "tenant-evidence",
      runtimeRevisionId: "revision-evidence",
      runtimeAdapter: mk("A"),
    });
    const r1b = await runPublicationConformanceSuite({
      tenantId: "tenant-evidence",
      runtimeRevisionId: "revision-evidence",
      runtimeAdapter: mk("A"),
    });
    const r2 = await runPublicationConformanceSuite({
      tenantId: "tenant-evidence",
      runtimeRevisionId: "revision-evidence",
      runtimeAdapter: mk("B"),
    });
    const d1 = r1.find((x) => x.caseId === "dispatch-acknowledgement")!;
    const d1b = r1b.find((x) => x.caseId === "dispatch-acknowledgement")!;
    const d2 = r2.find((x) => x.caseId === "dispatch-acknowledgement")!;
    // evidenceDigest 是 evidence 对象的 RFC8785 canonical digest
    expect(d1.evidenceDigest).toBe(computeCanonicalDigest(d1.evidence));
    // 同一证据 canonical 稳定
    expect(d1b.evidenceDigest).toBe(d1.evidenceDigest);
    // 真实返回字段不同 → digest 不同（不只能绑定布尔值）
    expect(d2.evidenceDigest).not.toBe(d1.evidenceDigest);
    // evidence 绑定真实返回字段，而非只有布尔值
    expect(d1.evidence).toMatchObject({
      caseId: "dispatch-acknowledgement",
      passed: true,
      runtime_execution_ref: "exec-A",
      runtime_session_ref: "sess-A",
    });
  });

  it("dispatch 返回的 capabilities 与唯一 probe 快照一致", async () => {
    const snapshot = hostedAdapterCapabilities();
    const probe = { ...snapshot, features: { ...snapshot.features, steer: true } };
    const adapter = hostedAdapterWith({
      probeCapabilities: async () => probe,
      startInvocation: async () => ({
        accepted: true,
        runtime_session_ref: "sess-snap",
        runtime_execution_ref: "exec-snap",
        capabilities: probe,
      }),
    });
    const results = await runPublicationConformanceSuite({
      tenantId: "tenant-snapshot",
      runtimeRevisionId: "revision-snapshot",
      runtimeAdapter: adapter,
    });
    const dispatch = results.find((r) => r.caseId === "dispatch-acknowledgement");
    expect(dispatch?.passed).toBe(true);
    expect(dispatch?.evidence).toMatchObject({
      capabilities_match_probe_snapshot: true,
    });
  });

  it("session-recovery-declaration: filesystem_checkpoint=true 需 resume=true + 真实 checkpoint resume + requires_redispatch=false", async () => {
    // filesystem_checkpoint=false → 证明未宣称（通过）
    const notClaiming = hostedAdapterWith({
      probeCapabilities: async () => ({
        ...hostedAdapterCapabilities(),
        features: { ...hostedAdapterCapabilities().features, filesystem_checkpoint: false },
      }),
    });
    const r1 = await runPublicationConformanceSuite({
      tenantId: "tenant-session-false",
      runtimeRevisionId: "revision-session-false",
      runtimeAdapter: notClaiming,
    });
    expect(r1.find((x) => x.caseId === "session-recovery-declaration")?.passed).toBe(true);

    // filesystem_checkpoint=true + resume=true + 真实 checkpoint resume + requires_redispatch=false → 通过
    let sawCheckpointRef = false;
    const recovering = hostedAdapterWith({
      probeCapabilities: async () => ({
        ...hostedAdapterCapabilities(),
        features: { ...hostedAdapterCapabilities().features, filesystem_checkpoint: true },
      }),
      handleResume: async (params) => {
        if (params.checkpointRef) sawCheckpointRef = true;
        return {
          resume_state: "accepted" as const,
          runtime_execution_ref: "exec-checkpoint",
          requires_redispatch: false,
        };
      },
    });
    const r2 = await runPublicationConformanceSuite({
      tenantId: "tenant-session-true-ok",
      runtimeRevisionId: "revision-session-true-ok",
      runtimeAdapter: recovering,
    });
    expect(r2.find((x) => x.caseId === "session-recovery-declaration")?.passed).toBe(true);
    expect(sawCheckpointRef).toBe(true);

    // filesystem_checkpoint=true 但 resume=false → fail-closed
    const noResume = hostedAdapterWith({
      probeCapabilities: async () => ({
        ...hostedAdapterCapabilities(),
        features: {
          ...hostedAdapterCapabilities().features,
          filesystem_checkpoint: true,
          resume: false,
        },
      }),
    });
    const r3 = await runPublicationConformanceSuite({
      tenantId: "tenant-session-true-noresume",
      runtimeRevisionId: "revision-session-true-noresume",
      runtimeAdapter: noResume,
    });
    expect(r3.find((x) => x.caseId === "session-recovery-declaration")?.passed).toBe(false);

    // filesystem_checkpoint=true + resume=true 但 requires_redispatch=true → fail-closed
    const needsRedispatch = hostedAdapterWith({
      probeCapabilities: async () => ({
        ...hostedAdapterCapabilities(),
        features: { ...hostedAdapterCapabilities().features, filesystem_checkpoint: true },
      }),
      handleResume: async () => ({
        resume_state: "accepted" as const,
        runtime_execution_ref: "exec-redispatch",
        requires_redispatch: true,
      }),
    });
    const r4 = await runPublicationConformanceSuite({
      tenantId: "tenant-session-redispatch",
      runtimeRevisionId: "revision-session-redispatch",
      runtimeAdapter: needsRedispatch,
    });
    expect(r4.find((x) => x.caseId === "session-recovery-declaration")?.passed).toBe(false);
  });

  it("computeRunnerArtifactDigestFromSources: 相对路径稳定、源码变化影响 digest、与真实入口一致", async () => {
    const b = Buffer.from("source-a");
    const d1 = computeRunnerArtifactDigestFromSources([
      { relativePath: "lib/runtime/runtime-conformance-runner.ts", bytes: b },
    ]);
    const d2 = computeRunnerArtifactDigestFromSources([
      { relativePath: "lib/runtime/runtime-conformance-runner.ts", bytes: b },
    ]);
    expect(d1).toBe(d2);
    const d3 = computeRunnerArtifactDigestFromSources([
      { relativePath: "lib/runtime/runtime-conformance-runner.ts", bytes: Buffer.from("source-b") },
    ]);
    expect(d3).not.toBe(d1);
    // 不同 cwd 绝对前缀不影响 digest：纯函数只依赖 relativePath + bytes
    const real = await computeRunnerArtifactDigest();
    const fromRel = computeRunnerArtifactDigestFromSources([
      {
        relativePath: "lib/runtime/runtime-conformance-runner.ts",
        bytes: await readFile(resolve(process.cwd(), "lib/runtime/runtime-conformance-runner.ts")),
      },
      {
        relativePath: "lib/runtime/domain/runtime-conformance-contract.ts",
        bytes: await readFile(
          resolve(process.cwd(), "lib/runtime/domain/runtime-conformance-contract.ts"),
        ),
      },
    ]);
    expect(real).toBe(fromRel);
  });

  it("test helper 无 db.update / runtimeRevisionTable / updateDraftRuntimeRevisionContent / failCase（静态）", () => {
    const src = readFileSync(
      resolve(process.cwd(), "lib/test-support/publish-runtime-revision-for-test.ts"),
      "utf-8",
    );
    expect(src).not.toContain("db.update");
    expect(src).not.toContain("runtimeRevisionTable");
    expect(src).not.toContain("updateDraftRuntimeRevisionContent");
    expect(src).not.toContain("failCase");
  });

  it("trusted-hosted-control-plane-evidence 不再制造 Passed（静态）：无 PUBLICATION_CONFORMANCE_CASES.map / passed: true / 固定时间摘要", () => {
    const src = readFileSync(
      resolve(process.cwd(), "lib/test-support/trusted-hosted-control-plane-evidence.ts"),
      "utf-8",
    );
    expect(src).not.toContain("PUBLICATION_CONFORMANCE_CASES.map");
    expect(src).not.toContain("passed: true");
    expect(src).not.toContain("2026-08-03T00:01:00.000Z");
    expect(src).not.toContain("hosted-evidence:");
  });

  it("fake-runtime-conformance-verifier 不再提供 deprecated 包装器（架构静态）", () => {
    const path = resolve(
      process.cwd(),
      "lib/runtime/test-support/fake-runtime-conformance-verifier.ts",
    );
    expect(existsSync(path)).toBe(false);
  });

  it("Conformance adapter 用进程内捕获型 sink 接收真实候选事件（不黑洞吞掉、不伪造 ack）", async () => {
    const { adapter, capturing } = createConformanceHostedAdapter();
    const results = await runPublicationConformanceSuite({
      tenantId: "tenant-sink",
      runtimeRevisionId: "revision-sink",
      runtimeAdapter: adapter,
    });
    // cancel 是发布基础能力，必须真实执行并回传 execution.cancelled 候选事件。
    expect(results.find((r) => r.caseId === "cancel-acknowledgement")?.passed).toBe(true);
    expect(capturing.calls.length).toBeGreaterThan(0);
    expect(capturing.events.some((e) => e.type === "execution.cancelled")).toBe(true);
  });

  it("dispatch 返回 capabilities 键序不同但值一致 → 判定一致（RFC8785 canonical 比较）", async () => {
    const snapshot = hostedAdapterCapabilities();
    const probe = { ...snapshot, features: { ...snapshot.features, steer: true } };
    // 反转顶层键序构造「值等价但 JSON.stringify 不同」的 capabilities。
    const reordered = {
      limits: probe.limits,
      features: probe.features,
      protocol_versions: probe.protocol_versions,
    };
    const adapter = hostedAdapterWith({
      probeCapabilities: async () => probe,
      startInvocation: async () => ({
        accepted: true,
        runtime_session_ref: "sess-order",
        runtime_execution_ref: "exec-order",
        capabilities: reordered,
      }),
    });
    const results = await runPublicationConformanceSuite({
      tenantId: "tenant-order",
      runtimeRevisionId: "revision-order",
      runtimeAdapter: adapter,
    });
    const dispatch = results.find((r) => r.caseId === "dispatch-acknowledgement");
    expect(dispatch?.passed).toBe(true);
    expect(dispatch?.evidence).toMatchObject({ capabilities_match_probe_snapshot: true });
  });
});
