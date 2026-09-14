import { afterEach, expect, it, vi } from "vitest";
import {
  type EnterpriseAuthorizationProvider,
  evaluateEnterpriseAuthorization,
} from "./enterprise-authorization";
import type { EnterpriseUserProfileFacts } from "./enterprise-user-profile-queries";
const facts: EnterpriseUserProfileFacts = {
  attributes: [],
  syncState: {
    id: "profile-state",
    updatedAt: new Date(),
    userIdentityId: "u",
    sourceSystem: "directory",
    profileFingerprint: "test",
    lastVerifiedAt: new Date(),
    freshUntil: new Date(Date.now() + 60000),
    staleUntil: new Date(Date.now() + 120000),
    lastSyncErrorCode: null,
  },
};
const request = {
  actionCode: "agent.invoke" as const,
  resource: { type: "agent" as const, id: "a" },
};
afterEach(() => vi.useRealTimers());
it("无企业接管时不添加额外约束", async () =>
  expect(await evaluateEnterpriseAuthorization(undefined, "t", "u", [request], null)).toBeNull());
it("企业接管必须显式允许，缺失决策和失败都拒绝", async () => {
  const provider: EnterpriseAuthorizationProvider = {
    name: "enterprise",
    agentIds: "all",
    evaluate: async () => [],
  };
  expect(
    (await evaluateEnterpriseAuthorization(provider, "t", "u", [request], facts))?.decisions.a
      ?.allowed,
  ).toBe(false);
  provider.evaluate = async () => {
    throw new Error("upstream unavailable");
  };
  expect(
    (await evaluateEnterpriseAuthorization(provider, "t", "u", [request], facts))?.decisions.a
      ?.allowed,
  ).toBe(false);
});
it("批量过滤只调用一次，使用同一份逐资源结果", async () => {
  const evaluate = vi.fn(async () => [
    { agentId: "a", allowed: true },
    { agentId: "b", allowed: false },
  ]);
  const provider: EnterpriseAuthorizationProvider = {
    name: "enterprise",
    agentIds: ["a", "b"],
    evaluate,
  };
  const result = await evaluateEnterpriseAuthorization(
    provider,
    "t",
    "u",
    [request, { ...request, resource: { type: "agent", id: "b" } }, request],
    facts,
  );
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(result?.decisions.a?.allowed).toBe(true);
  expect(result?.decisions.b?.allowed).toBe(false);
});
it("没有新鲜资料不出站，接管域拒绝而不影响基础聊天", async () => {
  const evaluate = vi.fn(async () => [{ agentId: "a", allowed: true }]);
  const provider: EnterpriseAuthorizationProvider = {
    name: "enterprise",
    agentIds: "all",
    evaluate,
  };
  const result = await evaluateEnterpriseAuthorization(provider, "t", "u", [request], null);
  expect(result?.decisions.a?.allowed).toBe(false);
  expect(evaluate).not.toHaveBeenCalled();
});
it("提供器超时后明确拒绝并发送取消信号", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const provider: EnterpriseAuthorizationProvider = {
    name: "enterprise",
    agentIds: "all",
    evaluate: async (context) => {
      signal = context.signal;
      return new Promise(() => {});
    },
  };
  const pending = evaluateEnterpriseAuthorization(provider, "t", "u", [request], facts);
  await vi.advanceTimersByTimeAsync(3001);
  expect((await pending)?.decisions.a?.allowed).toBe(false);
  expect(signal?.aborted).toBe(true);
});
