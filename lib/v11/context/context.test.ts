/**
 * S07-C01：V11 Context Fragment / 预算 / Context Gateway 集成测试
 * （真实 MySQL 8 Testcontainers，不使用 mock）。
 *
 * 覆盖：
 * - Fragment 领域类型：kind/scope/trust/sensitivity 校验、优先级推导、内容 hash 计算/校验。
 * - 预算策略：优先级排序、去重、预算耗尽排除、关键内容溢出失败、ToolCall/ToolResult 配对检测。
 * - 源解析器：RecentItems（真实 Thread Item）、Skill（真实 Skill 版本）、
 *   WorkspaceMap（empty）、Memory/Knowledge（unavailable，不伪装为 empty）。
 * - assembleContextView：并发运行解析器、汇总状态、应用预算。
 * - Gateway API：POST /gateway/v1/context:query 身份校验、请求体校验、
 *   源状态返回、预算超限 413、跨租户隔离。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。Gateway Token 由 issueWorkloadToken 构造。
 */
import { randomUUID } from "node:crypto";
import { POST as contextQueryPOST } from "@/app/gateway/v1/context:query/route";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { computeContentHash } from "@/lib/v11/capability/content-cache";
import {
  createSkill,
  createSkillVersion,
  publishSkillVersion,
  updateSkill,
} from "@/lib/v11/capability/skill-queries";
import {
  DEFAULT_BUDGET_CONFIG,
  detectUnpairedToolResults,
  selectFragmentsByBudget,
} from "@/lib/v11/context/budget";
import { assembleContextView } from "@/lib/v11/context/context-query";
import {
  type ContextFragment,
  FRAGMENT_PRIORITY_TIERS,
  type FragmentKind,
  type FragmentPriorityTier,
  computeFragmentContentHash,
  derivePriorityTier,
  isKnownFragmentKind,
  isValidFragmentContentHash,
  verifyFragmentContentHash,
} from "@/lib/v11/context/fragment";
import {
  KnowledgeResolver,
  MemoryResolver,
  RecentItemsResolver,
  SkillResolver,
  type SourceQueryResult,
  type SourceResolver,
  WorkspaceMapResolver,
  estimateTokens,
} from "@/lib/v11/context/source-resolvers";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { acceptUserMessageTurn } from "@/lib/v11/conversation/turn-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { type WorkloadTokenClaims, issueWorkloadToken } from "@/lib/identity/workload-token";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed 默认租户 + 用户身份 ────────────────────────

async function seedContext() {
  const t = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: t.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  return { tenantId: t.id, userIdentityId: identity.id };
}

/** 构造 Gateway Workload Token。 */
function makeGatewayToken(
  tenantId: string,
  invocationId: string,
  overrides: Partial<Omit<WorkloadTokenClaims, "issuedAt">> = {},
): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "gateway",
    tenantId,
    jti: "jti-gateway-context-001",
    invocationId,
    audience: "gateway",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
  return issueWorkloadToken(claims);
}

/** 构造过期 Token。 */
function makeExpiredGatewayToken(tenantId: string, invocationId: string): string {
  return makeGatewayToken(tenantId, invocationId, { expiresAt: Date.now() - 1_000 });
}

/** 构造 runtime audience Token（错误 audience）。 */
function makeRuntimeAudienceToken(
  tenantId: string,
  invocationId: string,
  runtimeRevisionId: string,
): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "runtime",
    tenantId,
    jti: "jti-runtime-context-001",
    invocationId,
    runtimeRevisionId,
    audience: "runtime",
    expiresAt: Date.now() + 60_000,
  };
  return issueWorkloadToken(claims);
}

/** 构造测试 Fragment。 */
function makeFragment(overrides: Partial<ContextFragment> & { id: string }): ContextFragment {
  const tokenEstimate = overrides.tokenEstimate ?? 100;
  const text =
    overrides.text ??
    (tokenEstimate === 0
      ? ""
      : `${overrides.id}${"x".repeat(tokenEstimate * 3)}`.slice(0, tokenEstimate * 3));
  const kind = overrides.kind ?? "system";
  return {
    kind,
    sourceRef: { type: "platform_rule", id: `src-${overrides.id}` },
    scope: "thread",
    trust:
      overrides.trust ??
      (kind === "system" || kind === "agent_instruction" ? "instruction" : "trusted_data"),
    sensitivity: "internal",
    contentHash: overrides.contentHash ?? computeFragmentContentHash(text),
    tokenEstimate,
    freshness: { updatedAt: new Date() },
    selectionReason: "test",
    priorityTier: overrides.priorityTier ?? FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY,
    text,
    ...overrides,
  } as ContextFragment;
}

// ─── 1. Fragment 领域类型 ───────────────────────────────────

describe("Fragment 领域类型", () => {
  it("isKnownFragmentKind：合法 kind 返回 true", () => {
    for (const kind of [
      "system",
      "agent_instruction",
      "user",
      "memory",
      "knowledge",
      "file",
      "tool",
      "skill",
    ] as const) {
      expect(isKnownFragmentKind(kind)).toBe(true);
    }
  });

  it("isKnownFragmentKind：非法 kind 返回 false", () => {
    expect(isKnownFragmentKind("unknown")).toBe(false);
    expect(isKnownFragmentKind("")).toBe(false);
    expect(isKnownFragmentKind("credential")).toBe(false);
  });

  it("derivePriorityTier：仅 system/agent_instruction 默认 TIER_MANDATORY", () => {
    expect(derivePriorityTier("system")).toBe(FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY);
    expect(derivePriorityTier("agent_instruction")).toBe(FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY);
    expect(derivePriorityTier("user")).toBe(FRAGMENT_PRIORITY_TIERS.TIER_RECENT);
  });

  it("derivePriorityTier：tool → TIER_RECENT", () => {
    expect(derivePriorityTier("tool")).toBe(FRAGMENT_PRIORITY_TIERS.TIER_RECENT);
  });

  it("derivePriorityTier：file/knowledge/memory/skill → TIER_RELATED", () => {
    expect(derivePriorityTier("file")).toBe(FRAGMENT_PRIORITY_TIERS.TIER_RELATED);
    expect(derivePriorityTier("knowledge")).toBe(FRAGMENT_PRIORITY_TIERS.TIER_RELATED);
    expect(derivePriorityTier("memory")).toBe(FRAGMENT_PRIORITY_TIERS.TIER_RELATED);
    expect(derivePriorityTier("skill")).toBe(FRAGMENT_PRIORITY_TIERS.TIER_RELATED);
  });

  it("computeFragmentContentHash：返回 sha256: 前缀 + 64 hex", () => {
    const hash = computeFragmentContentHash("hello");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("isValidFragmentContentHash：合法格式 true / 非法 false", () => {
    expect(isValidFragmentContentHash(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isValidFragmentContentHash("sha256:abc")).toBe(false);
    expect(isValidFragmentContentHash("md5:abc")).toBe(false);
    expect(isValidFragmentContentHash("")).toBe(false);
  });

  it("verifyFragmentContentHash：一致 true / 不一致 false", () => {
    const text = "测试内容";
    const hash = computeFragmentContentHash(text);
    expect(verifyFragmentContentHash(text, hash)).toBe(true);
    expect(verifyFragmentContentHash("篡改内容", hash)).toBe(false);
  });

  it("estimateTokens：空文本 0 / 非空至少 1", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("abcdefghij")).toBeGreaterThanOrEqual(3);
  });
});

// ─── 2. 预算策略 ────────────────────────────────────────────

describe("预算策略 selectFragmentsByBudget", () => {
  it("空候选 → selected 空、excluded 空、failureReason null", () => {
    const result = selectFragmentsByBudget([]);
    expect(result.selected).toHaveLength(0);
    expect(result.excluded).toHaveLength(0);
    expect(result.failureReason).toBeNull();
  });

  it("高优先级先选入：MANDATORY 在 RECENT 之前", () => {
    const mandatory = makeFragment({
      id: "m1",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY,
      tokenEstimate: 100,
    });
    const recent = makeFragment({
      id: "r1",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RECENT,
      tokenEstimate: 100,
    });
    // 插入顺序相反，但排序后 mandatory 先
    const result = selectFragmentsByBudget([recent, mandatory], {
      totalBudget: 1000,
      modelOutputReserve: 0,
      toolResultReserve: 0,
    });
    expect(result.selected[0]?.id).toBe("m1");
    expect(result.selected[1]?.id).toBe("r1");
  });

  it("去重：相同 contentHash 只保留首个，其余 duplicate 排除", () => {
    const duplicateText = "重".repeat(150);
    const hash = computeFragmentContentHash(duplicateText);
    const f1 = makeFragment({
      id: "f1",
      text: duplicateText,
      contentHash: hash,
      tokenEstimate: 50,
    });
    const f2 = makeFragment({
      id: "f2",
      text: duplicateText,
      contentHash: hash,
      tokenEstimate: 50,
    });
    const result = selectFragmentsByBudget([f1, f2], {
      totalBudget: 1000,
      modelOutputReserve: 0,
      toolResultReserve: 0,
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.id).toBe("f1");
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.id).toBe("f2");
    expect(result.excluded[0]?.reasonCode).toBe("duplicate");
  });

  it("预算耗尽：低优先级被排除（low_priority / requeryable / budget_exhausted）", () => {
    const mandatory = makeFragment({
      id: "m1",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY,
      tokenEstimate: 80,
    });
    const related = makeFragment({
      id: "rel1",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RELATED,
      tokenEstimate: 50,
    });
    const summary = makeFragment({
      id: "sum1",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_SUMMARY,
      tokenEstimate: 50,
    });
    const result = selectFragmentsByBudget([mandatory, related, summary], {
      totalBudget: 100,
      modelOutputReserve: 0,
      toolResultReserve: 0,
    });
    // mandatory 80 先选入；remaining 20，related 50 不够 → requeryable；summary 50 不够 → low_priority
    expect(result.selected.map((f) => f.id)).toEqual(["m1"]);
    expect(result.excluded).toHaveLength(2);
    const relEx = result.excluded.find((e) => e.id === "rel1");
    const sumEx = result.excluded.find((e) => e.id === "sum1");
    expect(relEx?.reasonCode).toBe("requeryable");
    expect(sumEx?.reasonCode).toBe("low_priority");
  });

  it("关键内容溢出：MANDATORY 超预算 → failureReason 非空", () => {
    const mandatory = makeFragment({
      id: "m1",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY,
      tokenEstimate: 200,
    });
    const result = selectFragmentsByBudget([mandatory], {
      totalBudget: 100,
      modelOutputReserve: 0,
      toolResultReserve: 0,
    });
    // mandatory 无法容纳时稳定失败，不把超预算内容伪装成已选入
    expect(result.selected).toHaveLength(0);
    expect(result.excluded[0]?.reasonCode).toBe("mandatory_overflow");
    expect(result.failureReason).not.toBeNull();
    expect(result.failureReason).toContain("关键内容");
  });

  it("非关键内容超出预算：failureReason 为空（不静默丢约束）", () => {
    const related = makeFragment({
      id: "rel1",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RELATED,
      tokenEstimate: 200,
    });
    const result = selectFragmentsByBudget([related], {
      totalBudget: 100,
      modelOutputReserve: 0,
      toolResultReserve: 0,
    });
    expect(result.selected).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.failureReason).toBeNull();
  });

  it("modelOutputReserve 从 totalBudget 扣除", () => {
    const recent = makeFragment({
      id: "r1",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RECENT,
      tokenEstimate: 80,
    });
    const result = selectFragmentsByBudget([recent], {
      totalBudget: 100,
      modelOutputReserve: 30,
      toolResultReserve: 0,
    });
    // availableInputBudget = 100 - 30 = 70；recent 80 不够
    expect(result.availableInputBudget).toBe(70);
    expect(result.selected).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
  });

  it("detectUnpairedToolResults：ToolCall 无配对 ToolResult", () => {
    const call = makeFragment({
      id: "call1",
      kind: "tool",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RECENT,
      sourceRef: { type: "tool_call", id: "op-1" },
    });
    const result = detectUnpairedToolResults([call], []);
    expect(result.unpairedToolCallSourceIds).toEqual(["op-1"]);
  });

  it("detectUnpairedToolResults：ToolCall 有配对 ToolResult", () => {
    const call = makeFragment({
      id: "call1",
      kind: "tool",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RECENT,
      sourceRef: { type: "tool_call", id: "op-1" },
    });
    const resultFrag = makeFragment({
      id: "res1",
      kind: "tool",
      priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RECENT,
      sourceRef: { type: "tool_result", id: "op-1" },
    });
    const result = detectUnpairedToolResults([call, resultFrag], []);
    expect(result.unpairedToolCallSourceIds).toHaveLength(0);
  });
});

// ─── 3. 源解析器 ────────────────────────────────────────────

describe("源解析器", () => {
  it("MemoryResolver：无 active Entry → empty（S07-C04 已接入真实查询）", async () => {
    const resolver = new MemoryResolver();
    const result = await resolver.resolve({
      tenantId: "t1",
      invocationId: "inv1",
    });
    // S07-C04 起 MemoryResolver 接入真实 DB 查询；无 active Entry 时返回 empty（不再伪装为 unavailable）
    expect(result.status).toBe("empty");
    expect(result.fragments).toHaveLength(0);
    expect(result.reasonCode).toBe("no_active_memory");
  });

  it("KnowledgeResolver：无 query → empty + empty_query（S07-C05 已接入真实检索）", async () => {
    const resolver = new KnowledgeResolver();
    const result = await resolver.resolve({
      tenantId: "t1",
      invocationId: "inv1",
    });
    // S07-C05 起 KnowledgeResolver 接入真实 DB 检索；无 query 时返回 empty（Agent 先看到目录，需要时提交查询）
    expect(result.status).toBe("empty");
    expect(result.fragments).toHaveLength(0);
    expect(result.reasonCode).toBe("empty_query");
  });

  it("KnowledgeResolver：有 query 但租户无 KnowledgeBase → empty + no_knowledge_base", async () => {
    const resolver = new KnowledgeResolver();
    const result = await resolver.resolve({
      tenantId: "00000000-0000-4000-8000-000000000099",
      invocationId: "inv1",
      query: "部署指南",
    });
    expect(result.status).toBe("empty");
    expect(result.reasonCode).toBe("no_knowledge_base");
  });

  it("KnowledgeResolver：allowedSources 不含 knowledge → denied", async () => {
    const resolver = new KnowledgeResolver();
    const result = await resolver.resolve({
      tenantId: "t1",
      invocationId: "inv1",
      query: "部署指南",
      allowedSources: ["recent_items", "memory"],
    });
    expect(result.status).toBe("denied");
    expect(result.reasonCode).toBe("source_not_authorized");
  });

  it("WorkspaceMapResolver：未指定 workspaceId → empty", async () => {
    const resolver = new WorkspaceMapResolver();
    const result = await resolver.resolve({
      tenantId: "t1",
      invocationId: "inv1",
    });
    expect(result.status).toBe("empty");
    expect(result.reasonCode).toBe("workspace_not_specified");
  });

  it("WorkspaceMapResolver：指定 workspaceId 但 provider 未接入 → unavailable", async () => {
    const resolver = new WorkspaceMapResolver();
    const result = await resolver.resolve({
      tenantId: "t1",
      invocationId: "inv1",
      workspaceId: "ws1",
    });
    expect(result.status).toBe("unavailable");
    expect(result.reasonCode).toBe("workspace_provider_not_ready");
  });

  it("RecentItemsResolver：未指定 threadId → empty", async () => {
    const resolver = new RecentItemsResolver();
    const result = await resolver.resolve({
      tenantId: "t1",
      invocationId: "inv1",
    });
    expect(result.status).toBe("empty");
    expect(result.reasonCode).toBe("thread_not_specified");
  });

  it("RecentItemsResolver：真实 Thread Item → ok + fragments", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: randomUUID(),
      actorId: userIdentityId,
    });
    await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: userIdentityId,
      content: { text: "分析销售异常数据" },
      actorId: userIdentityId,
    });

    const resolver = new RecentItemsResolver();
    const result = await resolver.resolve({
      tenantId,
      invocationId: "inv1",
      threadId: thread.id,
    });
    expect(result.status).toBe("ok");
    expect(result.fragments.length).toBeGreaterThanOrEqual(1);
    const userFrag = result.fragments.find((f) => f.kind === "user");
    expect(userFrag).toBeDefined();
    expect(userFrag?.trust).toBe("untrusted_external");
    expect(userFrag?.scope).toBe("thread");
    expect(userFrag?.priorityTier).toBe(FRAGMENT_PRIORITY_TIERS.TIER_RECENT);
    expect(userFrag?.sourceRef.type).toBe("thread_item");
  });

  it("RecentItemsResolver：跨租户隔离 → empty", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: randomUUID(),
      actorId: userIdentityId,
    });
    await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: userIdentityId,
      content: { text: "本租户消息" },
      actorId: userIdentityId,
    });

    const resolver = new RecentItemsResolver();
    // 用不同租户查询 → 跨租户隔离返回 empty
    const result = await resolver.resolve({
      tenantId: "00000000-0000-4000-8000-000000000099",
      invocationId: "inv1",
      threadId: thread.id,
    });
    expect(result.status).toBe("empty");
    expect(result.reasonCode).toBe("no_items");
  });

  it("SkillResolver：Skill 不存在 → empty（跨租户隐藏）", async () => {
    const { tenantId } = await seedContext();
    const resolver = new SkillResolver(randomUUID());
    const result = await resolver.resolve({ tenantId, invocationId: "inv1" });
    expect(result.status).toBe("empty");
    expect(result.reasonCode).toBe("skill_not_found");
  });

  it("SkillResolver：Skill 非 enabled → denied", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const skill = await createSkill({
      tenantId,
      skillKey: "test-skill-disabled",
      displayName: "测试 Skill（disabled）",
      ownerUserId: userIdentityId,
      createdBy: userIdentityId,
    });
    const resolver = new SkillResolver(skill.id);
    const result = await resolver.resolve({ tenantId, invocationId: "inv1" });
    expect(result.status).toBe("denied");
    expect(result.reasonCode).toBe("skill_not_enabled");
  });

  it("SkillResolver：enabled 但无 published 版本 → empty", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const skill = await createSkill({
      tenantId,
      skillKey: "test-skill-no-version",
      displayName: "测试 Skill（无版本）",
      ownerUserId: userIdentityId,
      createdBy: userIdentityId,
    });
    await updateSkill({
      tenantId,
      skillId: skill.id,
      lifecycleState: "enabled",
      expectedVersionNo: skill.versionNo,
    });
    const resolver = new SkillResolver(skill.id);
    const result = await resolver.resolve({ tenantId, invocationId: "inv1" });
    expect(result.status).toBe("empty");
  });

  it("SkillResolver：enabled + published 版本 → ok", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const skill = await createSkill({
      tenantId,
      skillKey: "test-skill-published",
      displayName: "测试 Skill（已发布）",
      ownerUserId: userIdentityId,
      createdBy: userIdentityId,
    });
    await updateSkill({
      tenantId,
      skillId: skill.id,
      lifecycleState: "enabled",
      expectedVersionNo: skill.versionNo,
    });
    const skillBody = "Skill 指令正文";
    const contentHash = computeContentHash(skillBody);
    const version = await createSkillVersion({
      tenantId,
      skillId: skill.id,
      contentRef: `inline+base64:${Buffer.from(skillBody).toString("base64url")}`,
      contentHash,
      manifestJson: { name: "test-skill" },
      createdBy: userIdentityId,
    });
    await publishSkillVersion({
      tenantId,
      skillVersionId: version.id,
      publishedBy: userIdentityId,
    });

    const resolver = new SkillResolver(skill.id);
    const result = await resolver.resolve({ tenantId, invocationId: "inv1" });
    expect(result.status).toBe("ok");
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]?.kind).toBe("skill");
    expect(result.fragments[0]?.trust).toBe("trusted_data");
    expect(result.fragments[0]?.text).toBe(skillBody);
    expect(result.fragments[0]?.sourceRef.revisionId).toBe(version.id);
  });

  it("SkillResolver：跨租户隐藏 → empty", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const skill = await createSkill({
      tenantId,
      skillKey: "test-skill-cross-tenant",
      displayName: "测试 Skill（跨租户）",
      ownerUserId: userIdentityId,
      createdBy: userIdentityId,
    });
    await updateSkill({
      tenantId,
      skillId: skill.id,
      lifecycleState: "enabled",
      expectedVersionNo: skill.versionNo,
    });
    const contentHash = computeContentHash("内容");
    const version = await createSkillVersion({
      tenantId,
      skillId: skill.id,
      contentRef: "git://commit/def",
      contentHash,
      manifestJson: {},
      createdBy: userIdentityId,
    });
    await publishSkillVersion({
      tenantId,
      skillVersionId: version.id,
      publishedBy: userIdentityId,
    });

    const resolver = new SkillResolver(skill.id);
    const result = await resolver.resolve({
      tenantId: "00000000-0000-4000-8000-000000000099",
      invocationId: "inv1",
    });
    expect(result.status).toBe("empty");
    expect(result.reasonCode).toBe("skill_not_found");
  });
});

// ─── 4. assembleContextView ────────────────────────────────

describe("assembleContextView 编排器", () => {
  it("并发运行多源：汇总 status + 应用预算", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: randomUUID(),
      actorId: userIdentityId,
    });
    await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: userIdentityId,
      content: { text: "组装测试" },
      actorId: userIdentityId,
    });

    const view = await assembleContextView({
      ctx: { tenantId, invocationId: "inv1", threadId: thread.id },
      resolvers: [
        new RecentItemsResolver(),
        new MemoryResolver(),
        new KnowledgeResolver(),
        new WorkspaceMapResolver(),
      ],
    });

    expect(view.sourceStatus.recent_items).toBe("ok");
    // S07-C04：MemoryResolver 已接入真实查询；新 Thread 无 active Entry → empty
    expect(view.sourceStatus.memory).toBe("empty");
    // S07-C05：KnowledgeResolver 已接入真实检索；无 query 时返回 empty（Agent 先看目录，需要时提交查询）
    expect(view.sourceStatus.knowledge).toBe("empty");
    expect(view.sourceStatus.workspace_map).toBe("empty");
    expect(view.fragments.length).toBeGreaterThanOrEqual(1);
    expect(view.failureReason).toBeNull();
    expect(view.tokenAccounting.inputTokens).toBeGreaterThan(0);
  });

  it("解析器抛错 → unavailable（不阻断其他源）", async () => {
    const throwingResolver: SourceResolver = {
      sourceType: "throwing",
      async resolve(): Promise<SourceQueryResult> {
        throw new Error("解析器内部错误");
      },
    };
    const view = await assembleContextView({
      ctx: { tenantId: "t1", invocationId: "inv1" },
      resolvers: [throwingResolver, new MemoryResolver()],
    });
    expect(view.sourceStatus.throwing).toBe("unavailable");
    // S07-C04：MemoryResolver 已接入真实查询；tenantId="t1" 无 active Entry → empty
    expect(view.sourceStatus.memory).toBe("empty");
  });

  it("关键内容溢出 → failureReason 非空", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: randomUUID(),
      actorId: userIdentityId,
    });
    const accepted = await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: userIdentityId,
      content: { text: "x".repeat(1000) },
      actorId: userIdentityId,
    });

    const view = await assembleContextView({
      ctx: {
        tenantId,
        invocationId: "inv1",
        threadId: thread.id,
        triggerItemId: accepted.item.id,
      },
      resolvers: [new RecentItemsResolver()],
      budget: { totalBudget: 10, modelOutputReserve: 0, toolResultReserve: 0 },
    });
    // 仅当前 trigger user input 是 TIER_MANDATORY，超出预算 → failureReason
    expect(view.failureReason).not.toBeNull();
    expect(view.failureReason).toContain("关键内容");
  });
});

// ─── 5. Gateway API ────────────────────────────────────────

describe("POST /gateway/v1/context:query", () => {
  it("缺少 Token → 401 AUTHENTICATION_REQUIRED", async () => {
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context:query",
    });
    const response = await contextQueryPOST(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("过期 Token → 401", async () => {
    const { tenantId } = await seedContext();
    const token = makeExpiredGatewayToken(tenantId, "inv1");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context:query",
      token,
    });
    const response = await contextQueryPOST(request);
    expect(response.status).toBe(401);
  });

  it("runtime audience Token → 401（audience 不匹配）", async () => {
    const { tenantId } = await seedContext();
    const token = makeRuntimeAudienceToken(tenantId, "inv1", randomUUID());
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context:query",
      token,
    });
    const response = await contextQueryPOST(request);
    expect(response.status).toBe(401);
  });

  it("请求体非法 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv1");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context:query",
      token,
    });
    // 传非法 JSON
    const req = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: "{invalid json",
    });
    const response = await contextQueryPOST(req);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("旧 requested_sources 字段即使值合法也拒绝 → 400", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv1");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context:query",
      token,
      body: { requested_sources: ["recent_items"] },
    });
    const response = await contextQueryPOST(request);
    expect(response.status).toBe(400);
  });

  it("旧 requested_sources/thread_id 双轨请求拒绝", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: randomUUID(),
      actorId: userIdentityId,
    });
    await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: userIdentityId,
      content: { text: "Gateway 查询测试" },
      actorId: userIdentityId,
    });

    const token = makeGatewayToken(tenantId, "inv1");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context:query",
      token,
      body: {
        requested_sources: ["recent_items", "memory", "knowledge"],
        thread_id: thread.id,
      },
    });
    const response = await contextQueryPOST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("旧 budget 字段拒绝，不再返回契约未声明的 413", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: randomUUID(),
      actorId: userIdentityId,
    });
    await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: userIdentityId,
      content: { text: "x".repeat(500) },
      actorId: userIdentityId,
    });

    const token = makeGatewayToken(tenantId, "inv1");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context:query",
      token,
      body: {
        requested_sources: ["recent_items"],
        thread_id: thread.id,
        budget: { total: 10, model_output_reserve: 0, tool_result_reserve: 0 },
      },
    });
    const response = await contextQueryPOST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("客户端不能用 thread_id 指定或枚举同租户/跨租户资源", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: randomUUID(),
      actorId: userIdentityId,
    });
    await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: userIdentityId,
      content: { text: "本租户" },
      actorId: userIdentityId,
    });

    // 用另一租户的 Token 查询本租户的 thread
    const otherTenantToken = makeGatewayToken("00000000-0000-4000-8000-000000000099", "inv-other");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context:query",
      token: otherTenantToken,
      body: {
        requested_sources: ["recent_items"],
        thread_id: thread.id,
      },
    });
    const response = await contextQueryPOST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("缺少四个必填机器字段时拒绝，不再默认全量源", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv1");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context:query",
      token,
      body: {},
    });
    const response = await contextQueryPOST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });
});
