import { memoryConfig } from "@/lib/config";
import { listActiveEmbeddingRows, listActiveEmbeddingRowsAnyProvider } from "@/lib/db/queries";
import type { MemoryEntry, MemoryScope } from "@/lib/db/schema";
import { type EmbeddingProvider, cosineSimilarity } from "./embedding";
import { listMemories } from "./store";
import { normalizeMemoryText } from "./text";

export type RetrievedMemoryEntry = MemoryEntry & {
  /** 最终排序分（lexical 归一化/综合分）。 */
  retrievalScore?: number;
  /** 命中来源：lexical 召回、semantic rerank 或纯 semantic 匹配。 */
  retrievalReason?: "lexical" | "semantic" | "rerank";
};

/**
 * 混合检索 lexical recall + semantic embedding rerank。
 *
 * 用户指令覆盖方案 §1 的纯关键词决策：
 * - lexical 只是 fallback / 基础召回（关键词重叠 × scope 优先级 × confidence）。
 * - semantic ready 时必须参与排序（cosine rerank）。
 * - provider disabled/stale/error 必须进入返回结构（→ manifest/UI 可观测），**不允许静默伪装成功**。
 * - 测试用 deterministic fake embedding，不请求真实网络。
 *
 * 返回 { memories, lexicalCandidates, embedding }：embedding.status 供 注入 manifest
 * 与 Studio 面板可观测。memories 为最终注入候选（reranked 或 lexical fallback）。
 */

export type RetrievalEmbeddingStatus = {
  provider: string;
  status: "ready" | "disabled" | "stale" | "error";
  error?: string;
  /** semantic rerank 是否实际发生（provider ready + 有 active embedding）。 */
  reranked: boolean;
};

export type RetrieveMemoriesResult = {
  memories: RetrievedMemoryEntry[];
  lexicalCandidates: MemoryEntry[];
  embedding: RetrievalEmbeddingStatus;
};

// scope/confidence 权重从 memoryConfig 读（env 可覆盖），原硬编码。
function scopeWeight(scope: string): number {
  return memoryConfig.scopeWeights[scope] ?? 0.5;
}
function confidenceWeight(confidence: string): number {
  return memoryConfig.confidenceWeights[confidence] ?? 0.7;
}

const STOP_WORDS = new Set([
  "的",
  "是",
  "了",
  "和",
  "与",
  "在",
  "用",
  "the",
  "a",
  "an",
  "is",
  "to",
  "of",
  "and",
  "for",
  "in",
  "on",
]);

/**
 * 分词：小写 + 非字母数字（含中文）分割 + 去停用词 + 长度>1。
 *
 * CJK 连续段原作为一个 token（"实现登录页" 单 token），中文召回率低。
 * 改为对 CJK 段额外生成 bigram（"实现"/"现登"/"登录"/"录页"），提升中文 lexical 召回。
 */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const chunks = text.toLowerCase().split(/[^a-z0-9一-龥]+/);
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    // ASCII 词（长度>1，去停用词）
    if (/^[a-z0-9]+$/.test(chunk)) {
      if (chunk.length > 1 && !STOP_WORDS.has(chunk)) out.add(chunk);
      continue;
    }
    // CJK 段：整段（去停用词）+ bigram
    if (chunk.length > 1 && !STOP_WORDS.has(chunk)) out.add(chunk);
    for (let i = 0; i < chunk.length - 1; i++) {
      const bg = chunk.slice(i, i + 2);
      if (!STOP_WORDS.has(bg)) out.add(bg);
    }
  }
  return out;
}

function lexicalScore(memory: MemoryEntry, queryTokens: Set<string>): number {
  const memTokens = tokenize(memory.text);
  let overlap = 0;
  for (const t of queryTokens) if (memTokens.has(t)) overlap++;
  if (overlap === 0) return 0;
  return overlap * scopeWeight(memory.scope) * confidenceWeight(memory.confidence);
}

function isSemanticOnlyCandidate(memory: MemoryEntry, lexical: number): boolean {
  if (lexical > 0) return false;
  return (
    (memory.kind === "preference" || memory.kind === "convention") &&
    (memory.scope === "user" || memory.scope === "project") &&
    memory.confidence === "high"
  );
}

export type RetrieveMemoriesArgs = {
  /** 候选 scope 集合（如 user 本人 + project 当前 + thread 当前）。 */
  scopes: Array<{ scope: MemoryScope; scopeRef: string | null }>;
  currentGoal: string;
  activePlanTitle?: string;
  recentUserText?: string;
  limit?: number;
  /** semantic rerank provider；undefined/disabled → lexical only（status=disabled 可观测）。 */
  embeddingProvider?: EmbeddingProvider;
};

export async function retrieveMemories(
  args: RetrieveMemoriesArgs,
): Promise<RetrieveMemoriesResult> {
  // P0 修复（配置死代码）：默认 limit/candidateLimit 读 memoryConfig，让运维环境变量生效。
  const limit = args.limit ?? memoryConfig.retrievalLimit;
  const candidateLimit = memoryConfig.candidateLimit;
  const queryText = [args.currentGoal, args.activePlanTitle ?? "", args.recentUserText ?? ""].join(
    " ",
  );
  const queryTokens = tokenize(queryText);

  // 1) lexical recall：拉各 scope active 记忆，过滤过期，打分（综合分 0 不召回）
  const now = new Date();
  const all: MemoryEntry[] = [];
  for (const s of args.scopes) {
    const rows = await listMemories({ scope: s.scope, scopeRef: s.scopeRef });
    all.push(...rows);
  }
  const notExpired = all.filter(
    (m) => m.expiresAt === null || m.expiresAt.getTime() > now.getTime(),
  );
  const scoredAll = notExpired.map((m) => ({ m, score: lexicalScore(m, queryTokens) }));
  const scored = scoredAll
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.updatedAt.getTime() - a.m.updatedAt.getTime());
  // P0：candidateLimit 限制 lexical 候选池规模（防大记忆库全量拉取）
  const lexicalCandidates = scored.slice(0, candidateLimit).map((x) => x.m);
  const semanticOnlyCandidates = scoredAll
    .filter((x) => isSemanticOnlyCandidate(x.m, x.score))
    .slice(0, candidateLimit)
    .map((x) => x.m);

  // 2) embedding rerank
  const provider = args.embeddingProvider;
  if (!provider || !provider.isReady()) {
    return {
      memories: scored.slice(0, limit).map((x) => ({
        ...x.m,
        retrievalScore: x.score,
        retrievalReason: "lexical" as const,
      })),
      lexicalCandidates,
      embedding: {
        provider: provider?.name ?? "none",
        status: "disabled",
        reranked: false,
      },
    };
  }

  const candidatePool = new Map<string, { m: MemoryEntry; lexical: number }>();
  for (const item of scored) {
    candidatePool.set(item.m.id, { m: item.m, lexical: item.score });
  }
  for (const memory of semanticOnlyCandidates) {
    if (!candidatePool.has(memory.id)) {
      candidatePool.set(memory.id, { m: memory, lexical: 0 });
    }
  }

  if (candidatePool.size === 0) {
    return {
      memories: [],
      lexicalCandidates,
      embedding: {
        provider: provider.name,
        status: "ready",
        reranked: false,
      },
    };
  }

  // provider ready：embed query（失败 → error，fallback lexical，不静默伪装）
  let queryVec: number[];
  try {
    // 审计修复：查询 embedding 须与存储 embedding 使用相同的 normalizeMemoryText 规范化，
    // 否则非规范空白（如双空格、前后空白）导致不同向量，语义搜索质量下降。
    const er = await provider.embed(normalizeMemoryText(queryText));
    if (er.status !== "ready" || er.vector.length === 0) {
      return {
        memories: scored.slice(0, limit).map((x) => ({
          ...x.m,
          retrievalScore: x.score,
          retrievalReason: "lexical" as const,
        })),
        lexicalCandidates,
        embedding: {
          provider: provider.name,
          status: er.status,
          error: er.error,
          reranked: false,
        },
      };
    }
    queryVec = er.vector;
  } catch (e) {
    return {
      memories: scored.slice(0, limit).map((x) => ({
        ...x.m,
        retrievalScore: x.score,
        retrievalReason: "lexical" as const,
      })),
      lexicalCandidates,
      embedding: {
        provider: provider.name,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        reranked: false,
      },
    };
  }

  // 批量取 candidate 的 active embedding（单查询替代 N+1）。
  const candidateIds = [...candidatePool.keys()];
  const embMap = await listActiveEmbeddingRows(candidateIds, provider.name);
  // + 当前 provider 缺失的 candidate，批量 fallback 到任意 provider 的老 embedding
  const missingIds = candidateIds.filter((id) => !embMap.has(id));
  let usedFallbackProvider = false;
  if (missingIds.length > 0) {
    const fallbackMap = await listActiveEmbeddingRowsAnyProvider(missingIds);
    for (const [id, anyEmb] of fallbackMap) {
      if (anyEmb.provider !== provider.name) {
        embMap.set(id, anyEmb);
        usedFallbackProvider = true;
      }
    }
  }

  const cosines = [...candidatePool.values()].map(({ m, lexical }) => {
    const emb = embMap.get(m.id);
    if (!emb) return { m, lexical, cosine: null as number | null };
    return { m, lexical, cosine: cosineSimilarity(queryVec, (emb.vector as number[]) ?? []) };
  });

  const hasEmbedding = cosines.some((c) => c.cosine !== null);
  if (!hasEmbedding) {
    // provider ready 但 candidate 都无 active embedding → stale，fallback lexical（可观测）
    return {
      memories: scored.slice(0, limit).map((x) => ({
        ...x.m,
        retrievalScore: x.score,
        retrievalReason: "lexical" as const,
      })),
      lexicalCandidates,
      embedding: {
        provider: provider.name,
        status: "stale",
        error: "no active embeddings for candidates",
        reranked: false,
      },
    };
  }

  // §7 综合分（内部排序用，不进返回结构）：
  // finalScore = lexicalNormalized*0.35 + semanticSimilarity*0.45 + scopeWeight*0.1
  // + confidenceWeight*0.1 - stalePenalty
  // - lexicalNormalized：lexicalScore 归一化到 [0,1]（除以候选最大 lexicalScore）。
  // - semanticSimilarity：cosine（[-1,1]）。
  // - scopeWeight / confidenceWeight：见上方权重表。
  // - stalePenalty：本阶段 candidate 无 active embedding 的已被 hasEmbedding 检查排除到 stale fallback；
  // 个别无 cosine 的候选给 -2 占位（综合分极低，排末尾）。本阶段 stalePenalty=0。
  const maxLex = cosines.reduce((mx, c) => Math.max(mx, c.lexical), 0);
  const finalScore = (c: { m: MemoryEntry; lexical: number; cosine: number | null }): number => {
    const lexicalNormalized = maxLex > 0 ? c.lexical / maxLex : 0;
    const semanticSimilarity = c.cosine ?? -2; // 无 embedding → 排末尾
    return (
      lexicalNormalized * 0.35 +
      semanticSimilarity * 0.45 +
      scopeWeight(c.m.scope) * 0.1 +
      confidenceWeight(c.m.confidence) * 0.1
    );
  };

  // 综合分降序；同分按 scope priority、updatedAt（与 lexical fallback 一致）。
  const reranked = [...cosines].sort((a, b) => {
    const fa = finalScore(a);
    const fb = finalScore(b);
    if (fb !== fa) return fb - fa;
    const sa = scopeWeight(a.m.scope);
    const sb = scopeWeight(b.m.scope);
    if (sb !== sa) return sb - sa;
    return b.m.updatedAt.getTime() - a.m.updatedAt.getTime();
  });

  return {
    memories: reranked
      .filter((x) => finalScore(x) >= 0.2)
      .slice(0, limit)
      .map((x) => ({
        ...x.m,
        retrievalScore: finalScore(x),
        retrievalReason: x.cosine === null ? "lexical" : x.lexical > 0 ? "rerank" : "semantic",
      })),
    lexicalCandidates,
    embedding: {
      provider: provider.name,
      status: usedFallbackProvider ? "stale" : "ready",
      error: usedFallbackProvider ? "fallback to old provider embedding" : undefined,
      reranked: true,
    },
  };
}
