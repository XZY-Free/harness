/**
 * 记忆提取 + 决策（M1 + M2）。
 *
 * 对标与时机（用户 2026-10-17 定稿）：
 * - **提取时机**：**压缩前静默 flush 为主**（对标 OpenClaw memoryFlush）+
 *   显式触发 + 会话终结；**不是每 turn**（成本 = 1 次/压缩周期，而非 N 次/turn）。
 * - **提取**：LLM 从对话抽原子事实（对标 Mem0 extraction phase）。
 * - **决策**：新事实 vs 相似旧记忆 → ADD/UPDATE/DELETE/NOOP（对标 Mem0 update phase）。
 * - **分类**：受控 5 类（对标 Claude Code auto memory：user/feedback/project/reference
 *   + decision）——提取时即归类。
 *
 * 边界：
 * - 只负责"从对话产出候选并落地"；作用域/敏感度策略复用既有 evaluateMemoryPolicy。
 * - 不建向量设施（守 D2/§2.4）：相似旧记忆的召回走本地相关度（M3），
 *   capm 语义召回为后续升级点。
 */
import { getChatModel } from "@/lib/ai/provider";
import { aiConfig, contextConfig } from "@/lib/config";
import {
  computeCandidateKey,
  computeMemoryContentHash,
  createMemoryCandidateWithEntry,
  evaluateMemoryPolicy,
  getMemoryEntryById,
  listActiveMemoryEntriesByScopes,
  supersedeMemoryEntry,
} from "@/lib/context/memory-queries";
import { db } from "@/lib/db/client";
import type { MemoryCategory, MemoryScopeType } from "@/lib/persistence/schema/memory";
import { memoryEntry, memoryExtractionRun } from "@/lib/persistence/schema/memory";
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

/** 提取触发的三种时机。 */
export type ExtractionTrigger = "pre_compaction" | "explicit" | "session_end";

/** 单条提取结果的决策动作。 */
export type MemoryDecisionAction = "ADD" | "UPDATE" | "DELETE" | "NOOP";

/** 提取出的原子事实 + 决策。 */
const MEMORY_EXTRACTION_SCHEMA = z.object({
  facts: z.array(
    z.object({
      fact: z.string().describe("原子事实，独立可读的一句话"),
      category: z
        .enum(["user", "feedback", "project", "reference", "decision"])
        .describe(
          "user=角色/偏好；feedback=纠正或确认；project=在办工作/决定；reference=外部信息位置；decision=架构/技术决策",
        ),
      /** 与已有记忆的关系：ADD 新增 / UPDATE 更新某条 / DELETE 删除某条 / NOOP 无需变更。 */
      action: z.enum(["ADD", "UPDATE", "DELETE", "NOOP"]),
      /** action=UPDATE/DELETE 时，指向已有记忆的 id。 */
      targetId: z.string().nullable().describe("更新/删除的目标记忆 id；ADD 时为空"),
      reason: z.string().nullable().describe("决策理由（简短）"),
    }),
  ),
});

/** 提取出的单条事实（模型输出）。 */
export interface ExtractedFact {
  fact: string;
  category: MemoryCategory;
  action: MemoryDecisionAction;
  targetId: string | null;
  reason: string | null;
}

/**
 * 记忆提取模型端口（可注入，便于单测 mock 与真实调用分离）。
 *
 * 用户偏好（成本红线）：单测/管线验证用 mock；真实 LLM 调用集中在少量脚本。
 */
export interface MemoryExtractionModelPort {
  extract(input: {
    transcript: string;
    existing: Array<{ id: string; content: string; category: string }>;
  }): Promise<ExtractedFact[]>;
}

/**
 * 真实模型实现。
 *
 * 说明：部分 OpenAI 兼容端点（如百炼 qwen-plus）不支持 json_schema 结构化输出，
 * 故用 generateText + **自解析 JSON**（剥 ```json 围栏 → zod 校验），
 * 兼容面更广、成本不变（单次调用）。
 */
export function configuredMemoryExtractionPort(modelRef: string): MemoryExtractionModelPort {
  return {
    async extract(input) {
      if (!aiConfig.apiKey) throw new Error("LLM_API_KEY 未配置");
      const { text } = await generateText({
        model: getChatModel(modelRef),
        prompt: [
          "你是记忆提取器。**只返回一个 json 对象**，形如：",
          '{"facts":[{"fact":"原子事实","category":"user|feedback|project|reference|decision","action":"ADD|UPDATE|DELETE|NOOP","targetId":null,"reason":null}]}',
          "不要输出任何解释、markdown 围栏或额外文本，只输出 json。",
          "从对话中抽取**值得跨会话记住**的原子事实，并对每条给出与已有记忆的关系决策。",
          "只抽取：用户角色/偏好、用户给的纠正或确认、在办工作与决定、外部信息位置、架构/技术决策。",
          "**不要抽取**：能从代码库或对话上下文直接推导的内容、一次性的闲聊、临时状态、已有记忆重复的内容。",
          "决策规则：与已有记忆语义相同 → NOOP；补充/修正某条已有记忆 → UPDATE 并给 targetId；",
          "与某条已有记忆矛盾（已被新事实取代）→ UPDATE 同一 targetId（系统会标记旧条失效）；确定删除 → DELETE；",
          "全新事实 → ADD（targetId 为 null）。宁可少抽，也不要编造。",
          `已有记忆（id 与内容）：${JSON.stringify(input.existing)}`,
          `对话内容：\n${input.transcript}`,
        ].join("\n\n"),
      });
      const parsed = MEMORY_EXTRACTION_SCHEMA.safeParse(parseJsonLoose(text));
      if (!parsed.success) {
        throw new Error(`记忆提取输出非合法 JSON：${text.slice(0, 200)}`);
      }
      return parsed.data.facts.map((f) => ({
        fact: f.fact,
        category: f.category as MemoryCategory,
        action: f.action as MemoryDecisionAction,
        targetId: f.targetId,
        reason: f.reason,
      }));
    },
  };
}

/** 宽松 JSON 解析：剥 ```json 围栏、截取首个 { 到末个 }。 */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? body.slice(start, end + 1) : body;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export interface MemoryExtractionResult {
  runId: string;
  trigger: ExtractionTrigger;
  extracted: number;
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
}

/**
 * 判定是否应触发"压缩前 flush"（对标 OpenClaw：reserveTokensFloor + softThresholdTokens）。
 *
 * @param estimatedTokens 当前会话 token 估算
 * @param contextWindowTokens 模型上下文窗口
 */
export function shouldFlushBeforeCompaction(
  estimatedTokens: number,
  contextWindowTokens: number,
): boolean {
  const reserveFloor = contextConfig.flushReserveTokens;
  const softThreshold = contextConfig.flushSoftThresholdTokens;
  const triggerLine = contextWindowTokens - reserveFloor - softThreshold;
  // 已越过压缩硬线（budgetThreshold）也视为需 flush（尚未压缩前抢救记忆）
  const hardLine = contextWindowTokens * contextConfig.budgetThreshold;
  return estimatedTokens >= triggerLine || estimatedTokens >= hardLine;
}

/**
 * 执行一次记忆提取 + 决策（核心）。
 *
 * @param transcript 待提取的对话文本（最近若干轮；由调用方按触发时机裁剪）
 * @param scopes 本次可写入的作用域（按 context 传入的 scope 列表）
 */
export async function extractMemoryFromTranscript(params: {
  tenantId: string;
  invocationId: string;
  threadId?: string | null;
  trigger: ExtractionTrigger;
  /** 对话文本（已含目标与关键回合）。 */
  transcript: string;
  /** 来源消息范围 hash（幂等键的一部分）。 */
  sourceRangesHash: string;
  /** 允许写入的作用域；缺省 thread（若提供 threadId）+ user_preference。 */
  scopes?: Array<{ scopeType: MemoryScopeType; scopeRef?: string | null }>;
  /** 关联来源（thread_item 等）。 */
  sourceItemId?: string | null;
  /** 模型端口（可注入 mock；缺省用真实模型）。 */
  modelPort?: MemoryExtractionModelPort;
  modelRef?: string;
}): Promise<MemoryExtractionResult> {
  const { tenantId, invocationId, trigger, transcript, sourceRangesHash } = params;
  if (!transcript.trim()) {
    return { runId: "", trigger, extracted: 0, added: 0, updated: 0, deleted: 0, skipped: 0 };
  }
  const port =
    params.modelPort ?? configuredMemoryExtractionPort(params.modelRef ?? "deepseek-v4-flash");

  const scopes: Array<{ scopeType: MemoryScopeType; scopeRef?: string | null }> = params.scopes ?? [
    ...(params.threadId ? [{ scopeType: "thread" as const, scopeRef: params.threadId }] : []),
    { scopeType: "user_preference" as const, scopeRef: null },
  ];
  const primaryScope = scopes[0] ?? {
    scopeType: "thread" as const,
    scopeRef: params.threadId ?? null,
  };

  // 1. 取已有记忆（供 LLM 决策 ADD/UPDATE/DELETE/NOOP 对照）
  const existing = await listActiveMemoryEntriesByScopes(tenantId, scopes, { limit: 30 });
  const existingView = existing.map((e) => ({
    id: e.id,
    content: e.contentRedacted ?? "",
    category: e.memoryCategory,
  }));

  // 2. 提取 + 决策（经端口）
  const facts = await port.extract({ transcript, existing: existingView });

  // 3. 建提取批次（幂等：同 invocation+trigger+范围 只跑一次）
  const runId = await insertExtractionRun({
    tenantId,
    invocationId,
    threadId: params.threadId ?? null,
    trigger,
    sourceRangesHash,
    extractedCount: facts.length,
    decisions: facts.map((f) => ({
      fact: f.fact,
      action: f.action,
      targetEntryId: f.targetId,
      reason: f.reason,
    })),
  });
  if (runId === null) {
    // 该范围已提取过（幂等命中）
    return { runId: "", trigger, extracted: 0, added: 0, updated: 0, deleted: 0, skipped: 0 };
  }

  // 4. 逐条执行决策
  let added = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  for (const d of facts) {
    const fact = d.fact.trim();
    if (!fact) {
      skipped++;
      continue;
    }
    try {
      if (d.action === "NOOP") {
        skipped++;
        continue;
      }
      if (d.action === "DELETE" && d.targetId) {
        const archived = await restoreOrArchiveTarget(tenantId, d.targetId);
        if (archived) deleted++;
        else skipped++;
        continue;
      }
      if (d.action === "UPDATE" && d.targetId) {
        // 更新：新条取代旧条（双时态演化，不物理删）
        const newId = await writeFact({
          tenantId,
          invocationId,
          scopes,
          primaryScope,
          fact,
          category: d.category,
          sourceItemId: params.sourceItemId ?? null,
          runId,
        });
        const superseded = await supersedeMemoryEntry({
          tenantId,
          oldEntryId: d.targetId,
          newEntryId: newId,
        });
        if (superseded) updated++;
        else skipped++;
        continue;
      }
      // ADD（默认）
      await writeFact({
        tenantId,
        invocationId,
        scopes,
        primaryScope,
        fact,
        category: d.category,
        sourceItemId: params.sourceItemId ?? null,
        runId,
      });
      added++;
    } catch (err) {
      console.error("[mem-extract] writeFact 失败:", err instanceof Error ? err.message : err);
      skipped++;
    }
  }

  return { runId, trigger, extracted: facts.length, added, updated, deleted, skipped };
}

/** 写入一条事实（经 policy → candidate + entry + source）。 */
async function writeFact(params: {
  tenantId: string;
  invocationId: string;
  scopes: Array<{ scopeType: MemoryScopeType; scopeRef?: string | null }>;
  primaryScope: { scopeType: MemoryScopeType; scopeRef?: string | null };
  fact: string;
  category: MemoryCategory;
  sourceItemId: string | null;
  runId: string;
}): Promise<string> {
  const contentHash = computeMemoryContentHash(params.fact);
  const policy = evaluateMemoryPolicy({
    contentRedacted: params.fact,
    proposedScopeType: params.primaryScope.scopeType,
    sensitivityClass: "internal",
  });
  // 敏感内容 → 不写（policy 判 rejected）；organization → 走人审（此处跳过，留待 M2 扩展）
  if (policy.decision !== "accepted") {
    throw new Error(`memory_policy_${policy.decision}`);
  }
  const result = await createMemoryCandidateWithEntry({
    tenantId: params.tenantId,
    invocationId: params.invocationId,
    sourceExtractionRunId: params.runId,
    proposedScopeType: params.primaryScope.scopeType,
    proposedScopeRef: params.primaryScope.scopeRef ?? null,
    memoryType: params.category,
    memoryCategory: params.category,
    contentRedacted: params.fact,
    contentHash,
    candidateKey: computeCandidateKey({
      invocationId: params.invocationId,
      sourceType: "extraction_run",
      sourceId: params.runId,
      contentHash,
      scopeType: params.primaryScope.scopeType,
      scopeRef: params.primaryScope.scopeRef ?? null,
    }),
    sensitivityClass: "internal",
    sourceHash: contentHash,
    rationaleCode: "AUTO_EXTRACTED",
  });
  // 回填提取批次
  await db
    .update(memoryEntry)
    .set({ extractionRunId: params.runId })
    .where(eq(memoryEntry.id, result.entry.id));

  // 索引进 capm（语义检索设施归 capm；失败不阻断——索引是增强能力）
  try {
    const { indexMemoryEntry } = await import("@/lib/context/capm-memory-index");
    const docRef = await indexMemoryEntry({
      entryId: result.entry.id,
      tenantId: params.tenantId,
      content: params.fact,
      contentHash,
      category: params.category,
      scopeType: params.primaryScope.scopeType,
      scopeRef: params.primaryScope.scopeRef ?? null,
    });
    await db
      .update(memoryEntry)
      .set({ indexedRevisionRef: docRef })
      .where(eq(memoryEntry.id, result.entry.id));
  } catch {
    /* capm 不可达/未配置：跳过索引，检索回退本地相关度排序 */
  }
  return result.entry.id;
}

/** DELETE 决策：归档目标（不物理删）。 */
async function restoreOrArchiveTarget(tenantId: string, entryId: string): Promise<boolean> {
  const entry = await getMemoryEntryById(tenantId, entryId);
  if (!entry) return false;
  await db
    .update(memoryEntry)
    .set({ memoryState: "archived", updatedAt: new Date() })
    .where(and(eq(memoryEntry.tenantId, tenantId), eq(memoryEntry.id, entryId)));
  return true;
}

/** 插入提取批次；命中唯一约束（同范围已提取）返回 null。 */
async function insertExtractionRun(params: {
  tenantId: string;
  invocationId: string;
  threadId: string | null;
  trigger: ExtractionTrigger;
  sourceRangesHash: string;
  extractedCount: number;
  decisions: Array<{
    fact: string;
    action: string;
    targetEntryId: string | null;
    reason: string | null;
  }>;
}): Promise<string | null> {
  try {
    const [row] = await db
      .insert(memoryExtractionRun)
      .values({
        tenantId: params.tenantId,
        invocationId: params.invocationId,
        threadId: params.threadId,
        trigger: params.trigger,
        sourceRangesHash: params.sourceRangesHash,
        extractedCount: params.extractedCount,
        decisionsJson: params.decisions,
      })
      .$returningId();
    return row?.id ?? null;
  } catch {
    // 唯一约束冲突 = 该范围已提取过（幂等）
    return null;
  }
}
