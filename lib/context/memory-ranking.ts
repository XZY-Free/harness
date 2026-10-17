/**
 * 记忆检索相关性排序（M3）。
 *
 * 背景：`MemoryResolver` 原先只按 `updatedAt DESC` 排序，**完全不看 query**——
 * 记忆检索无语义。本模块提供本地相关度打分，作为 capm 语义召回不可用时的
 * 降级排序（capm 可用时用其 score，本函数用于缺分/兜底）。
 *
 * 打分（轻量、确定性、可单测）：
 * - 词项重合：query 分词（中英混合，按非字母数字切分 + 中文二字滑窗）与内容比对，
 *   命中数 / query 词项数 → 覆盖度。
 * - 分类权重：user/decision 略高（稳定事实优先级高）；feedback 略低（时效性）。
 * - 时效衰减：越新越靠前（对数衰减，避免"刚刚更新"压倒强相关）。
 * - 命中历史：retrievalCount 轻微加成（对标 Mem0 retrieval_count）。
 *
 * 总分为加权和；同分时按 updatedAt 降序稳定排序。
 */

/** 记忆排序输入（从 MemoryEntry 投影，避免依赖完整行）。 */
export interface MemoryRankCandidate {
  id: string;
  content: string | null;
  memoryCategory: string;
  updatedAt: Date;
  retrievalCount: number;
}

export interface MemoryRankOptions {
  /** 查询串；空则纯按时效排序。 */
  query?: string | null;
  /** 参考时间（默认 now）；用于时效衰减。 */
  now?: Date;
  /** 时效衰减半衰期（天）；默认 30。 */
  halfLifeDays?: number;
}

/** 分类权重（稳定事实优先）。 */
const CATEGORY_WEIGHT: Record<string, number> = {
  user: 1.15,
  decision: 1.1,
  project: 1.0,
  reference: 0.95,
  feedback: 0.85,
};

/**
 * 查询分词：非字母数字切分；对中文片段做二字滑窗补充（无需分词库）。
 */
export function tokenizeQuery(query: string): string[] {
  const raw = query.toLowerCase();
  const tokens = new Set<string>();
  // 英数词
  for (const m of raw.match(/[a-z0-9]+/g) ?? []) {
    if (m.length >= 2) tokens.add(m);
  }
  // 中文：连续中文字段上做二字滑窗
  for (const seg of raw.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (seg.length === 1) {
      tokens.add(seg);
      continue;
    }
    for (let i = 0; i + 2 <= seg.length; i++) {
      tokens.add(seg.slice(i, i + 2));
    }
  }
  return [...tokens];
}

/**
 * 对候选记忆排序（返回新数组，不改入参）。
 */
export function rankMemoryCandidates(
  candidates: ReadonlyArray<MemoryRankCandidate>,
  options: MemoryRankOptions = {},
): MemoryRankCandidate[] {
  const now = options.now ?? new Date();
  const halfLife = (options.halfLifeDays ?? 30) * 24 * 60 * 60 * 1000;
  const tokens = options.query?.trim() ? tokenizeQuery(options.query) : [];

  const scored = candidates.map((c) => {
    const content = (c.content ?? "").toLowerCase();
    // 覆盖度：命中词项 / 总词项
    let coverage = 0;
    if (tokens.length > 0) {
      let hit = 0;
      for (const t of tokens) if (content.includes(t)) hit++;
      coverage = hit / tokens.length;
    }
    // 时效衰减：0.5 ^ (age / halfLife)
    const age = Math.max(0, now.getTime() - c.updatedAt.getTime());
    const recency = 0.5 ** (age / halfLife);
    // 命中历史加成（上限 0.15，避免高频霸榜）
    const usageBonus = Math.min(0.15, c.retrievalCount * 0.01);
    const categoryWeight = CATEGORY_WEIGHT[c.memoryCategory] ?? 1.0;

    const score = (coverage * 0.7 + recency * 0.3 + usageBonus) * categoryWeight;
    return { candidate: c, score, coverage };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.candidate.updatedAt.getTime() - a.candidate.updatedAt.getTime();
  });
  return scored.map((s) => s.candidate);
}
