import { randomUUID } from "node:crypto";
import { POST as contextQueryPOST } from "@/app/gateway/v1/context:query/route";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { createDraftRevision } from "@/lib/agents/persistence/agent-revision-queries";
import { publishRevision } from "@/lib/agents/test-support/publish-agent-revision-without-attestation";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createExecutionBinding } from "@/lib/executions/test-support/create-unverified-execution-binding";
import {
  createSkill,
  createSkillVersion,
  publishSkillVersion,
  updateSkill,
} from "@/lib/v11/capability/skill-queries";
import { selectFragmentsByBudget } from "@/lib/v11/context/budget";
import { issueContextHandle, resolveContextHandle } from "@/lib/v11/context/context-handle";
import { assembleContextView } from "@/lib/v11/context/context-query";
import {
  type ContextFragment,
  FRAGMENT_PRIORITY_TIERS,
  assertContextFragment,
  computeFragmentContentHash,
} from "@/lib/v11/context/fragment";
import {
  RecentItemsResolver,
  SkillResolver,
  threadItemToFragment,
} from "@/lib/v11/context/source-resolvers";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { acceptUserMessageTurn } from "@/lib/v11/conversation/turn-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { issueWorkloadToken } from "@/lib/v11/identity/workload-token";
import { createInvocation } from "@/lib/v11/runtime/invocation-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_CONTEXT_HANDLE_SECRET = process.env.SNOW_CONTEXT_HANDLE_SECRET;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  process.env.SNOW_CONTEXT_HANDLE_SECRET = "test-context-handle-secret-at-least-32-bytes";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_CONTEXT_HANDLE_SECRET = ORIGINAL_CONTEXT_HANDLE_SECRET;
});

async function seedInvocation(
  permissions: Record<string, unknown> = {
    context_classification: "internal",
    context_sources: ["recent_items", "skill", "workspace_map", "memory", "knowledge"],
    context_skill_ids: [],
  },
) {
  const tenant = await ensureDefaultTenant();
  const user = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: `context-${randomUUID()}`,
    displayName: "Context Agent",
    ownerUserId: user.id,
    lifecycleState: "enabled",
  });
  const draft = await createDraftRevision({
    tenantId: tenant.id,
    agentId: agent.id,
    sourceType: "agent_yaml",
    sourceRevision: `git:${randomUUID()}`,
    instructionHash: computeFragmentContentHash("受控 Agent 指令"),
    agentArtifactRef: `oci://context/${randomUUID()}`,
    modelPolicyJson: {},
    permissionRequirementsJson: permissions,
    delegationPolicyJson: {},
    agentInterfaceRequirementsJson: {},
    createdBy: user.id,
  });
  const revision = await publishRevision(tenant.id, draft.id, 1);
  const workspaceId = randomUUID();
  const { thread } = await createThread({
    tenantId: tenant.id,
    ownerUserId: user.id,
    primaryAgentId: agent.id,
    defaultWorkspaceId: workspaceId,
    actorId: user.id,
  });
  const accepted = await acceptUserMessageTurn({
    tenantId: tenant.id,
    threadId: thread.id,
    ownerUserId: user.id,
    content: { text: "只分析本次输入" },
    actorId: user.id,
  });
  const { invocation } = await createInvocation({
    tenantId: tenant.id,
    threadId: thread.id,
    turnId: accepted.turn.id,
    invocationKind: "initial",
    triggerItemId: accepted.item.id,
    actorId: user.id,
  });
  const agentRevisionId = revision.id;
  const policyRevisionId = randomUUID();
  const workspaceBindingId = randomUUID();
  await createExecutionBinding({
    tenantId: tenant.id,
    invocationId: invocation.id,
    agentRevisionId,
    runtimeRevisionId: randomUUID(),
    deploymentRouteId: randomUUID(),
    modelProvider: "test",
    modelId: "test-model",
    workspaceBindingId,
    policyRevisionId,
  });
  return {
    tenantId: tenant.id,
    userId: user.id,
    agentId: agent.id,
    agentRevisionId,
    workspaceId,
    workspaceBindingId,
    policyRevisionId,
    threadId: thread.id,
    triggerItemId: accepted.item.id,
    invocationId: invocation.id,
  };
}

function makeGatewayToken(tenantId: string, invocationId: string): string {
  return issueWorkloadToken({
    type: "gateway",
    tenantId,
    invocationId,
    audience: "gateway",
    expiresAt: Date.now() + 60_000,
  });
}

function fragment(id: string, overrides: Partial<ContextFragment> = {}): ContextFragment {
  const tokenEstimate = overrides.tokenEstimate ?? 10;
  const text =
    overrides.text ??
    (tokenEstimate === 0
      ? ""
      : `${id}${"x".repeat(tokenEstimate * 3)}`.slice(0, tokenEstimate * 3));
  return {
    id,
    kind: "system",
    sourceRef: { type: "platform_rule", id },
    scope: "thread",
    trust: "instruction",
    sensitivity: "internal",
    contentHash: computeFragmentContentHash(text),
    tokenEstimate,
    freshness: { updatedAt: new Date() },
    selectionReason: "test",
    priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY,
    text,
    ...overrides,
  };
}

describe("Context Fragment 运行时不变量", () => {
  it("restricted Fragment 禁止携带正文", () => {
    expect(() =>
      assertContextFragment(fragment("restricted", { sensitivity: "restricted" })),
    ).toThrow(/restricted/);
  });

  it("instruction trust 仅允许 system/agent_instruction", () => {
    expect(() => assertContextFragment(fragment("external", { kind: "knowledge" }))).toThrow(
      /instruction/,
    );
  });

  it("正文、hash 与 token estimate 必须一致", () => {
    expect(() =>
      assertContextFragment(fragment("bad-hash", { contentHash: computeFragmentContentHash("x") })),
    ).toThrow(/contentHash/);
  });
});

describe("预算 reserve 与 Tool 配对", () => {
  it("outputReserve 与 toolResultReserve 都从普通输入预算扣除", () => {
    const normal = fragment("normal", {
      kind: "knowledge",
      trust: "trusted_data",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RELATED,
      tokenEstimate: 61,
    });
    const result = selectFragmentsByBudget([normal], {
      totalBudget: 100,
      modelOutputReserve: 20,
      toolResultReserve: 20,
    });
    expect(result.availableInputBudget).toBe(80);
    expect(result.selected).toEqual([]);
    expect(result.excluded[0]?.reasonCode).toBe("requeryable");
  });

  it("ToolCall 与 ToolResult 只能成组选择或成组排除", () => {
    const call = fragment("call", {
      kind: "tool",
      trust: "untrusted_external",
      sourceRef: { type: "tool_call", id: "operation-1" },
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RECENT,
      tokenEstimate: 15,
    });
    const resultFragment = fragment("result", {
      kind: "tool",
      trust: "untrusted_external",
      sourceRef: { type: "tool_result", id: "operation-1" },
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RECENT,
      tokenEstimate: 30,
    });
    const selected = selectFragmentsByBudget([call, resultFragment], {
      totalBudget: 50,
      modelOutputReserve: 10,
      toolResultReserve: 20,
    });
    expect(selected.selected).toEqual([]);
    expect(selected.excluded.map((item) => item.id)).toEqual(["call", "result"]);
    expect(selected.excluded.every((item) => item.detail?.includes("operation-1"))).toBe(true);
  });

  it.each([
    ["call-only", "tool_call"],
    ["result-only", "tool_result"],
  ] as const)("孤儿 Tool group %s 整体排除且原因稳定", (_name, sourceType) => {
    const orphan = fragment(`orphan-${sourceType}`, {
      kind: "tool",
      trust: "untrusted_external",
      sourceRef: { type: sourceType, id: "op-orphan" },
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RECENT,
    });

    const result = selectFragmentsByBudget([orphan], {
      totalBudget: 100,
      modelOutputReserve: 0,
      toolResultReserve: 20,
    });

    expect(result.selected).toEqual([]);
    expect(result.excluded).toEqual([
      expect.objectContaining({ id: orphan.id, reasonCode: "tool_pair_incomplete" }),
    ]);
  });
});

describe("短期 context_handle", () => {
  it("绑定 tenant、invocation、user、agent、workspace、policy 与 classification 并反查持久记录", async () => {
    const seeded = await seedInvocation();
    const handle = await issueContextHandle({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
    });
    const binding = await resolveContextHandle(handle, {
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
    });
    expect(binding).toMatchObject({
      userId: seeded.userId,
      agentId: seeded.agentId,
      agentRevisionId: seeded.agentRevisionId,
      workspaceId: seeded.workspaceId,
      workspaceBindingId: seeded.workspaceBindingId,
      policyRevisionId: seeded.policyRevisionId,
      classification: "internal",
    });
  });

  it("拒绝伪造句柄与跨 invocation 重放", async () => {
    const seeded = await seedInvocation();
    const otherInvocation = await seedInvocation();
    const handle = await issueContextHandle({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
    });
    await expect(
      resolveContextHandle(`${handle.slice(0, -1)}x`, {
        tenantId: seeded.tenantId,
        invocationId: seeded.invocationId,
      }),
    ).rejects.toThrow();
    await expect(
      resolveContextHandle(handle, {
        tenantId: seeded.tenantId,
        invocationId: otherInvocation.invocationId,
      }),
    ).rejects.toThrow();
  });

  it("classification 与资源授权只能从绑定 AgentRevision 当前事实派生", async () => {
    const allowedSkillId = randomUUID();
    const seeded = await seedInvocation({
      context_classification: "confidential",
      context_sources: ["skill"],
      context_skill_ids: [allowedSkillId],
    });

    const issueWithoutCallerPolicy = issueContextHandle as unknown as (input: {
      tenantId: string;
      invocationId: string;
      classification?: string;
      allowedSources?: string[];
      allowedSkillIds?: string[];
    }) => Promise<string>;
    const handle = await issueWithoutCallerPolicy({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
      classification: "public",
      allowedSources: ["recent_items"],
      allowedSkillIds: [randomUUID()],
    });
    const resolved = await resolveContextHandle(handle, {
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
    });

    expect(resolved.classification).toBe("confidential");
    expect(resolved.allowedSources).toEqual(["skill"]);
    expect(resolved.allowedSkillIds).toEqual([allowedSkillId]);
  });

  it("当前受控 classification 变化后旧 handle 立即失效", async () => {
    const seeded = await seedInvocation();
    const handle = await issueContextHandle({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
    });

    const { v11AgentRevision } = await import("@/lib/v11/schema/agent");
    const { eq } = await import("drizzle-orm");
    await db
      .update(v11AgentRevision)
      .set({
        permissionRequirementsJson: {
          context_classification: "restricted",
          context_sources: ["recent_items"],
          context_skill_ids: [],
        },
      })
      .where(eq(v11AgentRevision.id, seeded.agentRevisionId));

    await expect(
      resolveContextHandle(handle, {
        tenantId: seeded.tenantId,
        invocationId: seeded.invocationId,
      }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
  });

  it("过期 handle 被拒绝", async () => {
    const seeded = await seedInvocation();
    const handle = await issueContextHandle({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
      ttlMs: 0,
    });
    await expect(
      resolveContextHandle(handle, {
        tenantId: seeded.tenantId,
        invocationId: seeded.invocationId,
      }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("非 test 环境即使 SNOW_AUTH_MODE=dev 也不回退公开测试密钥", async () => {
    const seeded = await seedInvocation();
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAuthMode = process.env.SNOW_AUTH_MODE;
    const previousSecret = process.env.SNOW_CONTEXT_HANDLE_SECRET;
    const mutableEnv = process.env as unknown as Record<string, string | undefined>;
    mutableEnv.NODE_ENV = "production";
    process.env.SNOW_AUTH_MODE = "dev";
    Reflect.deleteProperty(process.env, "SNOW_CONTEXT_HANDLE_SECRET");
    try {
      await expect(
        issueContextHandle({
          tenantId: seeded.tenantId,
          invocationId: seeded.invocationId,
        }),
      ).rejects.toMatchObject({ code: "invalid" });
    } finally {
      mutableEnv.NODE_ENV = previousNodeEnv;
      if (previousAuthMode === undefined) {
        Reflect.deleteProperty(process.env, "SNOW_AUTH_MODE");
      } else {
        process.env.SNOW_AUTH_MODE = previousAuthMode;
      }
      if (previousSecret === undefined) {
        Reflect.deleteProperty(process.env, "SNOW_CONTEXT_HANDLE_SECRET");
      } else {
        process.env.SNOW_CONTEXT_HANDLE_SECRET = previousSecret;
      }
    }
  });
});

describe("源授权与可信度", () => {
  it("普通 agent_message、plan 和未知 Item 不提升为指令，旧 user message 也不是 mandatory", async () => {
    const seeded = await seedInvocation();
    const result = await new RecentItemsResolver().resolve({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
      threadId: seeded.threadId,
      triggerItemId: seeded.triggerItemId,
      userId: seeded.userId,
      agentId: seeded.agentId,
      workspaceId: seeded.workspaceId,
      policyRevisionId: seeded.policyRevisionId,
      classification: "internal",
      allowedSources: ["recent_items"],
      allowedSkillIds: [],
    });
    expect(result.status).toBe("ok");
    const current = result.fragments.find((item) => item.sourceRef.id === seeded.triggerItemId);
    expect(current?.priorityTier).toBe(FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY);
    expect(
      result.fragments
        .filter((item) => item.sourceRef.id !== seeded.triggerItemId)
        .every((item) => item.trust !== "instruction"),
    ).toBe(true);
    for (const itemType of ["agent_message", "plan", "future_item"]) {
      const historical = threadItemToFragment(
        {
          id: `${itemType}-id`,
          itemType,
          contentJson: { text: "历史数据" },
          itemSequence: 99,
        },
        99,
        {
          tenantId: seeded.tenantId,
          invocationId: seeded.invocationId,
          triggerItemId: seeded.triggerItemId,
          classification: "internal",
        },
      );
      expect(historical.trust).not.toBe("instruction");
      expect(historical.priorityTier).toBe(FRAGMENT_PRIORITY_TIERS.TIER_RECENT);
    }
  });

  it("Skill 必须加载受控正文并校验 hash，URI 本身不能当正文", async () => {
    const seeded = await seedInvocation();
    const body = "受控 Skill 正文";
    const skill = await createSkill({
      tenantId: seeded.tenantId,
      skillKey: "controlled-content",
      displayName: "受控正文",
      ownerUserId: seeded.userId,
      createdBy: seeded.userId,
    });
    await updateSkill({
      tenantId: seeded.tenantId,
      skillId: skill.id,
      lifecycleState: "enabled",
      expectedVersionNo: skill.versionNo,
    });
    const version = await createSkillVersion({
      tenantId: seeded.tenantId,
      skillId: skill.id,
      contentRef: `inline+base64:${Buffer.from(body).toString("base64url")}`,
      contentHash: computeFragmentContentHash(body),
      manifestJson: {},
      createdBy: seeded.userId,
    });
    await publishSkillVersion({
      tenantId: seeded.tenantId,
      skillVersionId: version.id,
      publishedBy: seeded.userId,
    });
    const result = await new SkillResolver(skill.id).resolve({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
      classification: "internal",
      allowedSources: ["skill"],
      allowedSkillIds: [skill.id],
    });
    expect(result.status).toBe("ok");
    expect(result.fragments[0]?.text).toBe(body);
    expect(result.fragments[0]?.contentHash).toBe(computeFragmentContentHash(body));
    expect(result.fragments[0]?.tokenEstimate).toBeGreaterThan(0);
  });

  it("recent_items 使用 query 筛选并落实 max_items", async () => {
    const seeded = await seedInvocation();
    const { threadItem } = await acceptUserMessageTurn({
      tenantId: seeded.tenantId,
      threadId: seeded.threadId,
      ownerUserId: seeded.userId,
      content: { text: "alpha evidence" },
      actorId: seeded.userId,
    }).then((result) => ({ threadItem: result.item }));
    await acceptUserMessageTurn({
      tenantId: seeded.tenantId,
      threadId: seeded.threadId,
      ownerUserId: seeded.userId,
      content: { text: "alpha second" },
      actorId: seeded.userId,
    });
    await acceptUserMessageTurn({
      tenantId: seeded.tenantId,
      threadId: seeded.threadId,
      ownerUserId: seeded.userId,
      content: { text: "beta unrelated" },
      actorId: seeded.userId,
    });

    const result = await new RecentItemsResolver().resolve({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
      threadId: seeded.threadId,
      triggerItemId: threadItem.id,
      classification: "internal",
      query: "alpha",
      maxItems: 1,
    } as never);

    expect(result.status).toBe("ok");
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]?.text).toContain("alpha");
  });

  it("同一 source 多 resolver 按 denied > unavailable > ok > empty 聚合", async () => {
    const result = await assembleContextView({
      ctx: { tenantId: "tenant", invocationId: "invocation" },
      resolvers: [
        {
          sourceType: "skill",
          async resolve() {
            return { sourceType: "skill", status: "denied" as const, fragments: [] };
          },
        },
        {
          sourceType: "skill",
          async resolve() {
            return { sourceType: "skill", status: "unavailable" as const, fragments: [] };
          },
        },
        {
          sourceType: "skill",
          async resolve() {
            return { sourceType: "skill", status: "ok" as const, fragments: [] };
          },
        },
      ],
    });
    expect(result.sourceStatus.skill).toBe("denied");
  });
});

describe("Context Query oneOf 投影", () => {
  it("Knowledge 与 Memory 使用各自唯一合法结果形态，其他 Fragment 不伪装", async () => {
    const routeModule = await import("@/app/gateway/v1/context:query/route");
    const project = (routeModule as Record<string, unknown>).projectContextResult as
      | ((fragment: ContextFragment) => Record<string, unknown> | null)
      | undefined;
    expect(project).toBeTypeOf("function");

    const knowledge = fragment("knowledge", {
      kind: "knowledge",
      trust: "trusted_data",
      sourceRef: {
        type: "knowledge_document",
        id: "kdoc-1",
        revisionId: "krev-2",
      },
      text: "knowledge",
      contentHash: computeFragmentContentHash("knowledge"),
      tokenEstimate: 3,
    });
    const memory = fragment("memory", {
      kind: "memory",
      trust: "trusted_data",
      scope: "user",
      sourceRef: { type: "memory", id: "mem-1" },
      text: "memory",
      contentHash: computeFragmentContentHash("memory"),
      tokenEstimate: 2,
    });

    expect(project?.(knowledge)).toEqual({
      source_type: "knowledge_document",
      source_id: "kdoc-1",
      revision_id: "krev-2",
      content_hash: knowledge.contentHash,
      content: "knowledge",
      citation_ref: "kb://kdoc-1#krev-2",
    });
    expect(project?.(memory)).toEqual({
      source_type: "memory",
      source_id: "mem-1",
      content_hash: memory.contentHash,
      content: "memory",
      scope: "user",
    });
    expect(project?.(fragment("recent", { kind: "user", trust: "trusted_data" }))).toBeNull();
    expect(project?.(fragment("skill", { kind: "skill", trust: "trusted_data" }))).toBeNull();
  });
});

describe("POST /gateway/v1/context:query V11 唯一契约", () => {
  it("拒绝旧字段和任意 unknown field", async () => {
    const seeded = await seedInvocation();
    const token = makeGatewayToken(seeded.tenantId, seeded.invocationId);
    const response = await contextQueryPOST(
      buildV11Request({
        audience: "gateway",
        method: "POST",
        path: "/context:query",
        token,
        body: {
          context_handle: "x",
          sources: ["recent_items"],
          query: "当前缺口",
          limits: {},
          thread_id: seeded.threadId,
        },
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("recent_items 当前无合法 oneOf 结果形态时明确阻断", async () => {
    const seeded = await seedInvocation();
    const token = makeGatewayToken(seeded.tenantId, seeded.invocationId);
    const handle = await issueContextHandle({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
    });
    const response = await contextQueryPOST(
      buildV11Request({
        audience: "gateway",
        method: "POST",
        path: "/context:query",
        token,
        body: {
          context_handle: handle,
          sources: ["recent_items"],
          query: "只分析",
          limits: { max_items: 1, max_tokens: 4096 },
        },
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("Workspace provider 未接入时返回允许的 RESOURCE_NOT_FOUND，不伪装 empty", async () => {
    const seeded = await seedInvocation();
    const token = makeGatewayToken(seeded.tenantId, seeded.invocationId);
    const handle = await issueContextHandle({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
    });
    const response = await contextQueryPOST(
      buildV11Request({
        audience: "gateway",
        method: "POST",
        path: "/context:query",
        token,
        body: {
          context_handle: handle,
          sources: ["workspace_map"],
          query: "文件索引",
          limits: {},
        },
      }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("当前事实为 restricted 时有效 handle 也不能返回正文", async () => {
    const seeded = await seedInvocation({
      context_classification: "restricted",
      context_sources: ["recent_items"],
      context_skill_ids: [],
    });
    const token = makeGatewayToken(seeded.tenantId, seeded.invocationId);
    const handle = await issueContextHandle({
      tenantId: seeded.tenantId,
      invocationId: seeded.invocationId,
    });
    const response = await contextQueryPOST(
      buildV11Request({
        audience: "gateway",
        method: "POST",
        path: "/context:query",
        token,
        body: {
          context_handle: handle,
          sources: ["recent_items"],
          query: "只分析",
          limits: { max_items: 1, max_tokens: 100 },
        },
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ACCESS_DENIED");
  });
});
