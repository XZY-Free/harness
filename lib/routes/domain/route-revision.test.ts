import { describe, expect, it } from "vitest";
import {
  RouteAgentEndpointFactsError,
  type RouteRevisionContent,
  computeRouteRevisionContentDigest,
  validateRouteRevisionContent,
  validateRouteRevisionTarget,
} from "./route-revision";

/** 基础 Harness Runtime Route — 只含 Runtime target 事实。 */
function runtimeContent(overrides: Partial<RouteRevisionContent> = {}): RouteRevisionContent {
  return {
    target: { kind: "runtime", runtimeRevisionId: "runtime-revision-1" },
    policyRevisionId: null,
    modelPolicyRevisionId: null,
    toolsetRevisionId: null,
    trafficWeight: 5_000,
    priorityNo: 0,
    effectiveFrom: null,
    effectiveUntil: null,
    eligibilityConditions: {},
    routeGroupId: "primary",
    ...overrides,
  };
}

/** Agent Route — 只含 Agent target 事实。 */
function agentContent(overrides: Partial<RouteRevisionContent> = {}): RouteRevisionContent {
  return runtimeContent({
    target: {
      kind: "agent",
      agentRevisionId: "agent-revision-1",
      agentEndpointRef: "https://agent.example.com/capability",
      agentIdentityMode: "bearer",
      agentCredentialRefId: "cred-1",
      agentNetworkZone: "cn-north",
    },
    ...overrides,
  });
}

/** 经 cast 注入非法字段（模拟调用方 unknown/any 输入）。 */
function cast<T>(value: unknown): T {
  return value as T;
}

describe("RouteRevisionContent target 判别", () => {
  describe("validateRouteRevisionContent — 非法 target fail-closed", () => {
    it("runtime content 不携带任何 Agent target 事实（混入 Agent target 被拒）", () => {
      expect(() =>
        validateRouteRevisionContent(
          cast<RouteRevisionContent>({
            ...runtimeContent(),
            target: {
              kind: "runtime",
              runtimeRevisionId: "runtime-revision-1",
              agentEndpointRef: "https://leak.example.com",
            },
          }),
        ),
      ).toThrow(RouteAgentEndpointFactsError);
    });

    it("bearer identityMode 必须冻结 agentCredentialRefId", () => {
      expect(() =>
        validateRouteRevisionContent(
          cast<RouteRevisionContent>({
            ...agentContent(),
            target: {
              kind: "agent",
              agentRevisionId: "agent-revision-1",
              agentEndpointRef: "https://agent.example.com/capability",
              agentIdentityMode: "bearer",
              agentCredentialRefId: null,
              agentNetworkZone: "cn-north",
            },
          }),
        ),
      ).toThrow(RouteAgentEndpointFactsError);
    });

    it("agent target 缺少 endpoint / network 被拒", () => {
      expect(() =>
        validateRouteRevisionTarget(
          cast<Parameters<typeof validateRouteRevisionTarget>[0]>({
            kind: "agent",
            agentRevisionId: "agent-revision-1",
            agentEndpointRef: "",
            agentIdentityMode: "bearer",
            agentCredentialRefId: "cred-1",
            agentNetworkZone: "cn-north",
          }),
        ),
      ).toThrow(RouteAgentEndpointFactsError);
      expect(() =>
        validateRouteRevisionTarget(
          cast<Parameters<typeof validateRouteRevisionTarget>[0]>({
            kind: "agent",
            agentRevisionId: "agent-revision-1",
            agentEndpointRef: "https://agent.example.com/capability",
            agentIdentityMode: "bearer",
            agentCredentialRefId: "cred-1",
            agentNetworkZone: " ",
          }),
        ),
      ).toThrow(RouteAgentEndpointFactsError);
    });

    it("none identityMode 允许 credentialRefId 为 null", () => {
      expect(() =>
        validateRouteRevisionContent(
          agentContent({
            target: {
              kind: "agent",
              agentRevisionId: "agent-revision-1",
              agentEndpointRef: "https://agent.example.com/capability",
              agentIdentityMode: "none",
              agentCredentialRefId: null,
              agentNetworkZone: "cn-north",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("runtime target 以 own property 携带 Agent key（null/undefined legacy 占位）被拒", () => {
      // 冻结 omitted/null 规则：对侧 target 的 key 必须缺失，不得以 null/undefined 占位。
      const nullLeak = cast<RouteRevisionContent>({
        ...runtimeContent(),
        target: {
          kind: "runtime",
          runtimeRevisionId: "runtime-revision-1",
          agentRevisionId: null,
        },
      });
      const undefinedLeak = cast<RouteRevisionContent>({
        ...runtimeContent(),
        target: {
          kind: "runtime",
          runtimeRevisionId: "runtime-revision-1",
          agentEndpointRef: undefined,
        },
      });
      expect(() => validateRouteRevisionContent(nullLeak)).toThrow(RouteAgentEndpointFactsError);
      expect(() => validateRouteRevisionContent(undefinedLeak)).toThrow(
        RouteAgentEndpointFactsError,
      );
    });

    it("agent target 以 own property 携带 runtimeRevisionId（null/undefined legacy 占位）被拒", () => {
      const nullRogue = cast<RouteRevisionContent>({
        ...agentContent(),
        target: {
          kind: "agent",
          agentRevisionId: "agent-revision-1",
          agentEndpointRef: "https://agent.example.com/capability",
          agentIdentityMode: "none",
          agentCredentialRefId: null,
          agentNetworkZone: "cn-north",
          runtimeRevisionId: null,
        },
      });
      const undefinedRogue = cast<RouteRevisionContent>({
        ...agentContent(),
        target: {
          kind: "agent",
          agentRevisionId: "agent-revision-1",
          agentEndpointRef: "https://agent.example.com/capability",
          agentIdentityMode: "none",
          agentCredentialRefId: null,
          agentNetworkZone: "cn-north",
          runtimeRevisionId: undefined,
        },
      });
      expect(() => validateRouteRevisionContent(nullRogue)).toThrow(RouteAgentEndpointFactsError);
      expect(() => validateRouteRevisionContent(undefinedRogue)).toThrow(
        RouteAgentEndpointFactsError,
      );
    });

    it("空/空白标识符或事实非法", () => {
      expect(() =>
        validateRouteRevisionContent(
          cast<RouteRevisionContent>({
            ...runtimeContent(),
            target: { kind: "runtime", runtimeRevisionId: "  " },
          }),
        ),
      ).toThrow(RouteAgentEndpointFactsError);
      expect(() =>
        validateRouteRevisionContent(
          cast<RouteRevisionContent>({
            ...agentContent(),
            target: {
              kind: "agent",
              agentRevisionId: "",
              agentEndpointRef: "https://agent.example.com/capability",
              agentIdentityMode: "none",
              agentCredentialRefId: null,
              agentNetworkZone: "cn-north",
            },
          }),
        ),
      ).toThrow(RouteAgentEndpointFactsError);
    });
  });

  describe("target digest 隔离（专题01 冻结架构）", () => {
    it("agent target 经 cast 注入 legacy runtimeRevisionId 被拒而非静默忽略", () => {
      // 冻结设计：有效 agent digest 只基于有效 agent target；不得接受混入的
      // runtimeRevisionId。经 cast 注入的 legacy/mixed runtimeRevisionId 必须拒绝，
      // 而非静默忽略后吞入 runtime 事实。
      const rogue = cast<RouteRevisionContent>({
        ...agentContent(),
        target: {
          ...agentContent().target,
          runtimeRevisionId: "rogue-runtime-revision",
        },
      });
      expect(() => validateRouteRevisionContent(rogue)).toThrow(RouteAgentEndpointFactsError);
      expect(() => computeRouteRevisionContentDigest(rogue)).toThrow(RouteAgentEndpointFactsError);
    });

    it("digest 非法混合 target（runtime + Agent 事实）必须 fail-closed 拒绝", () => {
      // 非法混合 target：runtime target 却携带 Agent target 事实。
      const mixed = cast<RouteRevisionContent>({
        ...runtimeContent(),
        target: {
          kind: "runtime",
          runtimeRevisionId: "runtime-revision-1",
          agentEndpointRef: "https://leak.example.com/capability",
          agentIdentityMode: "bearer",
          agentCredentialRefId: "cred-leak",
          agentNetworkZone: "cn-north",
        },
      });
      expect(() => validateRouteRevisionContent(mixed)).toThrow(RouteAgentEndpointFactsError);
      expect(() => computeRouteRevisionContentDigest(mixed)).toThrow(RouteAgentEndpointFactsError);
    });

    it("有效 agent digest 只基于有效 agent target", () => {
      const digest = computeRouteRevisionContentDigest(agentContent());
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      // 冻结设计：有效 agent digest 由 agent target 事实决定。相同 agent target 必须
      // 稳定产生相同摘要（不掺入任何 runtime 事实）。
      expect(computeRouteRevisionContentDigest(agentContent())).toBe(digest);
    });

    it("合法 runtime content digest 只含 Runtime target 事实", () => {
      const digest = computeRouteRevisionContentDigest(runtimeContent());
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });
});
