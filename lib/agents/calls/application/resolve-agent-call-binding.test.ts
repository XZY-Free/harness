/**
 * resolveRequiredAgentBinding — 消费者迁移 RED 测试（专题01 工程包01）。
 *
 * 冻结模型：RouteResolution 仅以 resolution.target.kind 判别。Agent target 含
 * agentRevisionId；Runtime target 不含任何 Agent 事实。不存在 resolution.targetKind /
 * resolution.agentRevisionId 平铺字段。
 *
 * 目标不变量：
 * 1. resolveRoute 返回 resolved Agent resolution 时，resolveRequiredAgentBinding 必须从
 *    resolution.target.agentRevisionId 传入 buildAgentCallBindingConfig 并返回同一 revision。
 * 2. 返回 Runtime resolution 时，必须在读取 ContractSnapshot / governance / build binding
 *    之前 fail-closed，报 RequiredAgentUnavailableError。
 * 3. 保持 resolveRoute 调用 target={kind:"agent", agentId}，不允许宽松 Runtime fallback。
 *
 * 隔离：mock mysqlAgentContractStore / resolveBindingGovernance / buildAgentCallBindingConfig
 * 仅隔离本 application service；RouteResolution 一律使用合法 fixture（判别 target），
 * 不用 as/any/@ts-ignore 伪造旧平铺字段。
 */
import {
  RequiredAgentUnavailableError,
  resolveRequiredAgentBinding,
} from "@/lib/agents/calls/application/resolve-agent-call-binding";
import {
  D,
  runtimeRouteResolution,
  validAgentRouteResolution,
  validBindingConfig,
} from "@/lib/agents/calls/test/agent-call-test-fixtures";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type { RouteResolution } from "@/lib/routes/domain/route-resolution-policy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  resolveBindingGovernance: vi.fn(),
  buildAgentCallBindingConfig: vi.fn(),
  /** builder 配置的返回产物（断言返回的 binding 就是 build 的产物）。 */
  builtBinding: undefined as ReturnType<typeof validBindingConfig> | undefined,
}));

vi.mock("@/lib/agents/persistence/agent-contract-store", () => ({
  mysqlAgentContractStore: { transaction: mocks.transaction },
}));
vi.mock("@/lib/executions/application/resolve-binding-governance", () => ({
  resolveBindingGovernance: mocks.resolveBindingGovernance,
}));
vi.mock("@/lib/agents/calls/application/build-agent-call-binding-config", () => ({
  buildAgentCallBindingConfig: mocks.buildAgentCallBindingConfig,
}));
vi.mock("@/lib/db/client", () => ({ db: {} }));

describe("resolveRequiredAgentBinding（消费者迁移 · 判别 target 冻结）", () => {
  const tenantId = "tenant-1";
  const agentId = "agent-1";

  beforeEach(() => {
    mocks.transaction.mockReset();
    mocks.resolveBindingGovernance.mockReset();
    mocks.buildAgentCallBindingConfig.mockReset();

    // mock store：transaction 调用回调并返回一个合法 ContractSnapshot（含 capability/protocol 事实）。
    mocks.transaction.mockImplementation(
      async (
        op: (session: {
          findContractSnapshotById: (t: string, id: string) => Promise<unknown>;
        }) => Promise<unknown>,
      ) =>
        op({
          async findContractSnapshotById() {
            return {
              id: "contract-1",
              capabilityDigest: D("b"),
              protocolType: "a2a",
              protocolContractRevision: "a2a-0.3.0",
            };
          },
        }),
    );
    mocks.resolveBindingGovernance.mockResolvedValue({
      policyRevisionId: "policy-rev-1",
      policyRulesDigest: D("e"),
      governanceConfigRevisionId: "gov-rev-1",
      governanceConfigDigest: D("f"),
    });
    mocks.builtBinding = validBindingConfig();
    mocks.buildAgentCallBindingConfig.mockReturnValue(mocks.builtBinding);
  });

  /** mock RouteResolver：记录调用 target 并返回给定 resolution。 */
  function mockResolveRoute(resolution: RouteResolution): {
    resolveRoute: RouteResolver;
    calls: Array<{ target: unknown }>;
  } {
    const calls: Array<{ target: unknown }> = [];
    const resolveRoute: RouteResolver = async (command) => {
      calls.push({ target: command.target });
      return { status: "resolved", eligibleCandidateCount: 1, resolution };
    };
    return { resolveRoute, calls };
  }

  it("invariant1：resolved Agent resolution → 从 resolution.target.agentRevisionId 传给 build 并返回同一 revision", async () => {
    const agentResolution = validAgentRouteResolution(); // target.kind=agent, agentRevisionId=agent-rev-1
    const { resolveRoute, calls } = mockResolveRoute(agentResolution);

    const result = await resolveRequiredAgentBinding({
      tenantId,
      agentId,
      resolveRoute,
      businessKey: { threadId: "thread-1" },
    });

    // 返回同一 revision（来自判别 target.agentRevisionId，非平铺字段）。
    expect(result.agentRevisionId).toBe("agent-rev-1");
    // build 收到的 agentRevisionId 必须来自 resolution.target.agentRevisionId。
    const buildInput = mocks.buildAgentCallBindingConfig.mock.calls[0]?.[0];
    expect(buildInput).toBeTruthy();
    // fixture 是合法 agent resolution → 先按 target.kind 收窄再读 agentRevisionId。
    const resolvedTarget = agentResolution.target;
    if (resolvedTarget.kind !== "agent") {
      throw new Error("fixture validAgentRouteResolution 应为 agent target");
    }
    expect(buildInput?.agentRevisionId).toBe(resolvedTarget.agentRevisionId);
    expect(buildInput?.agentRevisionId).toBe("agent-rev-1");
    // 返回的 binding 即 build 的产物（同一对象）。
    expect(result.binding).toBe(mocks.builtBinding);
  });

  it("invariant3：resolveRoute 始终以 target={kind:'agent', agentId} 调用（无宽松 Runtime fallback）", async () => {
    const { resolveRoute, calls } = mockResolveRoute(validAgentRouteResolution());
    await resolveRequiredAgentBinding({
      tenantId,
      agentId,
      resolveRoute,
      businessKey: { jobId: "job-1" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toEqual({ kind: "agent", agentId });
  });

  it("invariant2：Runtime resolution → fail-closed RequiredAgentUnavailableError，且不读 ContractSnapshot/governance/build", async () => {
    const { resolveRoute } = mockResolveRoute(runtimeRouteResolution());

    await expect(
      resolveRequiredAgentBinding({
        tenantId,
        agentId,
        resolveRoute,
        businessKey: { threadId: "thread-1" },
      }),
    ).rejects.toThrow(RequiredAgentUnavailableError);

    // 读取 ContractSnapshot / governance / build binding 一律不得发生。
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.resolveBindingGovernance).not.toHaveBeenCalled();
    expect(mocks.buildAgentCallBindingConfig).not.toHaveBeenCalled();
  });
});
