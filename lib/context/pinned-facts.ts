import { getThreadById, mutateThreadPinnedFacts, updateThreadPinnedFacts } from "@/lib/db/queries";

/**
 * V3.3a Stage D：用户 pinned facts 存取（protected 集合数据源之一）。
 *
 * P0 修复（持久化）：原进程内 Map 重启即失,改为 DB 持久化（Thread.pinnedFacts json 列）。
 * 接口签名不变（getPinnedFacts / addPinnedFact / removePinnedFact）,调用方无需改动。
 *
 * S1 修复（03-P2-3 并发保护）：addPinnedFact/removePinnedFact 改用 mutateThreadPinnedFacts
 * （事务内 SELECT FOR UPDATE + 读-改-写原子），消除并发丢失写入。getPinnedFacts 仍为只读快照。
 *
 * pinnedFacts 是用户明确要求保留的事实（如"必须用 Tailwind"）,纳入 protected 集合,
 * 任意压缩后仍逐字出现在装配 messages 里（见 protected-refs.ts）。
 *
 * 写入入口（后续阶段补）：agent 工具 / chat 命令 / Studio UI。当前 addPinnedFact/removePinnedFact
 * 已就位,供未来入口调用。
 */

/** 取某 thread 的 pinned facts（无则空数组）。只读快照,不锁。 */
export async function getPinnedFacts(threadId: string): Promise<string[]> {
  const t = await getThreadById(threadId);
  if (!t || !t.pinnedFacts) return [];
  return Array.isArray(t.pinnedFacts) ? (t.pinnedFacts as string[]) : [];
}

/** 追加一条 pinned fact（去重）。事务内原子读-改-写，并发安全。 */
export async function addPinnedFact(threadId: string, fact: string): Promise<string[]> {
  return mutateThreadPinnedFacts(threadId, (current) =>
    current.includes(fact) ? current : [...current, fact],
  );
}

/** 移除一条 pinned fact。事务内原子读-改-写，并发安全。清空时落 null。 */
export async function removePinnedFact(threadId: string, fact: string): Promise<string[]> {
  return mutateThreadPinnedFacts(threadId, (current) => {
    const next = current.filter((f) => f !== fact);
    return next.length > 0 ? next : null;
  });
}

/**
 * 测试用：清空某 thread 的 pinned facts。
 * P0 后改 DB 持久化,本函数清 DB 行（测试间隔离）。
 */
export async function _clearPinnedFactsForTest(threadId: string): Promise<void> {
  await updateThreadPinnedFacts(threadId, null);
}
