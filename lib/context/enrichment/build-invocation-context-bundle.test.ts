/**
 * buildInvocationContextBundle 测试 — Batch 5 Gate（05 §8/§9，10 Batch 5）。
 *
 * 覆盖：required 缺失 fail / required policy deny / preferred 缺失 continue /
 * accepted 不默认全量 / trusted ExecutionSubject 只来自认证 Principal /
 * 集成 Binding 冻结 Contract（resolveBindingContextContract 结果直接可用）。
 */
import type { InvocationContextContract } from "@/lib/agents/domain/agent-descriptor";
import {
  type PlatformContextEnvironment,
  RequiredContextDeniedError,
  RequiredContextUnavailableError,
  buildInvocationContextBundle,
} from "@/lib/context/enrichment/build-invocation-context-bundle";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-08-25T08:00:00.000Z");

const SUBJECT = {
  userIdentityId: "user-1",
  externalSubject: "employee-42",
  email: "employee42@example.com",
  displayName: "员工42",
};

function environment(
  overrides: Partial<PlatformContextEnvironment> = {},
): PlatformContextEnvironment {
  return {
    tenantId: "tenant-1",
    executionSubject: SUBJECT,
    now: NOW,
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    conversationContextRef: "context-handle:thread-1",
    ...overrides,
  };
}

function contract(
  contexts: Array<{ contextKind: string; necessity: "required" | "preferred" | "accepted" }>,
): InvocationContextContract {
  return {
    contexts: contexts.map((c) => ({ ...c, provenance: "provider_declared" as const })),
  };
}

describe("buildInvocationContextBundle（Batch 5 Gate）", () => {
  it("required 可用且允许 → supplied（trusted，含审计字段）", () => {
    const bundle = buildInvocationContextBundle({
      contract: contract([
        { contextKind: "execution_subject", necessity: "required" },
        { contextKind: "current_datetime", necessity: "required" },
      ]),
      environment: environment(),
    });
    const subject = bundle.entries.find((e) => e.contextKind === "execution_subject");
    expect(subject?.supplied).toBe(true);
    expect(subject?.trusted).toBe(true);
    expect(subject?.provenance).toBe("principal");
    expect(subject?.policyDecision.decision).toBe("allow");
    expect(subject?.value).toEqual(SUBJECT);
    const datetime = bundle.entries.find((e) => e.contextKind === "current_datetime");
    expect(datetime?.value).toBe(NOW.toISOString());
    expect(datetime?.provenance).toBe("platform");
  });

  it("required 缺失 → fail（RequiredContextUnavailableError）", () => {
    expect(() =>
      buildInvocationContextBundle({
        contract: contract([{ contextKind: "timezone", necessity: "required" }]),
        environment: environment({ timezone: null }),
      }),
    ).toThrow(RequiredContextUnavailableError);
  });

  it("required 被 Policy 拒绝 → deny（RequiredContextDeniedError，不因 required 绕开策略）", () => {
    expect(() =>
      buildInvocationContextBundle({
        contract: contract([{ contextKind: "execution_subject", necessity: "required" }]),
        environment: environment(),
        policyFilter: (kind) =>
          kind === "execution_subject"
            ? { decision: "deny", reason: "privacy_policy" }
            : { decision: "allow" },
      }),
    ).toThrow(RequiredContextDeniedError);
  });

  it("preferred 缺失 → continue（omitted: not_available，不抛错）", () => {
    const bundle = buildInvocationContextBundle({
      contract: contract([
        { contextKind: "current_datetime", necessity: "required" },
        { contextKind: "attachment_references", necessity: "preferred" },
      ]),
      environment: environment({ attachmentRefs: [] }),
    });
    const attachment = bundle.entries.find((e) => e.contextKind === "attachment_references");
    expect(attachment?.supplied).toBe(false);
    expect(attachment?.omissionReason).toBe("not_available");
  });

  it("preferred 被 Policy 拒绝 → omitted: policy_denied（不 fail）", () => {
    const bundle = buildInvocationContextBundle({
      contract: contract([{ contextKind: "conversation_context", necessity: "preferred" }]),
      environment: environment(),
      policyFilter: () => ({ decision: "deny", reason: "egress_policy" }),
    });
    expect(bundle.entries[0]?.supplied).toBe(false);
    expect(bundle.entries[0]?.omissionReason).toBe("policy_denied");
    expect(bundle.entries[0]?.policyDecision.decision).toBe("deny");
  });

  it("accepted 不默认全量发送：未显式选择 → not_selected", () => {
    const bundle = buildInvocationContextBundle({
      contract: contract([
        { contextKind: "workspace_context", necessity: "accepted" },
        { contextKind: "attachment_references", necessity: "accepted" },
      ]),
      environment: environment(),
    });
    expect(bundle.entries.every((e) => !e.supplied && e.omissionReason === "not_selected")).toBe(
      true,
    );
  });

  it("accepted 显式选择且允许 → supply（其余仍 not_selected）", () => {
    const bundle = buildInvocationContextBundle({
      contract: contract([
        { contextKind: "workspace_context", necessity: "accepted" },
        { contextKind: "attachment_references", necessity: "accepted" },
      ]),
      environment: environment({ workspaceContextRef: "workspace-handle:ws-1" }),
      selectedAcceptedContextKinds: ["workspace_context"],
    });
    const workspace = bundle.entries.find((e) => e.contextKind === "workspace_context");
    expect(workspace?.supplied).toBe(true);
    const attachment = bundle.entries.find((e) => e.contextKind === "attachment_references");
    expect(attachment?.supplied).toBe(false);
    expect(attachment?.omissionReason).toBe("not_selected");
  });

  it("accepted 被显式选择但 Policy 拒绝 → policy_denied", () => {
    const bundle = buildInvocationContextBundle({
      contract: contract([{ contextKind: "workspace_context", necessity: "accepted" }]),
      environment: environment(),
      policyFilter: () => ({ decision: "deny", reason: "egress_policy" }),
      selectedAcceptedContextKinds: ["workspace_context"],
    });
    expect(bundle.entries[0]?.supplied).toBe(false);
    expect(bundle.entries[0]?.omissionReason).toBe("policy_denied");
  });

  it("trusted ExecutionSubject 只能来自认证 Principal：environment 无 principal → required fail", () => {
    // 客户端不能伪造 trusted subject：environment 由 Harness 从认证 Principal 组装，
    // 无认证主体时 execution_subject 不可用（required → fail，preferred → omitted）。
    expect(() =>
      buildInvocationContextBundle({
        contract: contract([{ contextKind: "execution_subject", necessity: "required" }]),
        environment: environment({ executionSubject: null }),
      }),
    ).toThrow(RequiredContextUnavailableError);

    const bundle = buildInvocationContextBundle({
      contract: contract([{ contextKind: "execution_subject", necessity: "preferred" }]),
      environment: environment({ executionSubject: null }),
    });
    expect(bundle.entries[0]?.supplied).toBe(false);
    expect(bundle.entries[0]?.omissionReason).toBe("not_available");
  });

  it("未成熟/未知 contextKind → not_available（不伪造）", () => {
    const bundle = buildInvocationContextBundle({
      contract: contract([
        { contextKind: "memory_context", necessity: "preferred" },
        { contextKind: "knowledge_context", necessity: "preferred" },
        { contextKind: "organization_context", necessity: "preferred" },
        { contextKind: "custom_future_kind", necessity: "preferred" },
      ]),
      environment: environment(),
    });
    expect(bundle.entries.every((e) => e.omissionReason === "not_available")).toBe(true);
  });

  it("同一 contextKind 重复声明 → 去重（首声明优先）", () => {
    const bundle = buildInvocationContextBundle({
      contract: contract([
        { contextKind: "locale", necessity: "required" },
        { contextKind: "locale", necessity: "accepted" },
      ]),
      environment: environment(),
    });
    expect(bundle.entries).toHaveLength(1);
    expect(bundle.entries[0]?.necessity).toBe("required");
  });
});
