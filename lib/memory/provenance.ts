import type { MemoryProvenanceEntry } from "@/lib/db/schema";

/**
 * 记忆 provenance 规范化、校验与摘要（纯函数，无 DB）。
 *
 * provenance 是长期记忆的「来源」——必填、可审计、可追溯，防孤儿记忆（蓝图 ）。
 * 来源三类：tool_run（agent 经 rememberFact 写入时的 ToolRun）/ message（对话消息）/ user（Studio curate）。
 */

const PROVENANCE_KINDS = new Set<MemoryProvenanceEntry["kind"]>(["tool_run", "message", "user"]);

/**
 * 规范化 provenance 输入为 MemoryProvenanceEntry[]。
 * 接受数组或单条对象；剔除结构无效项（不抛错，宽松归一）。
 */
export function normalizeProvenance(input: unknown): MemoryProvenanceEntry[] {
  const arr = Array.isArray(input) ? input : input == null ? [] : [input];
  const out: MemoryProvenanceEntry[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const kind = typeof r.kind === "string" ? r.kind : null;
    const refId = typeof r.refId === "string" ? r.refId : null;
    if (!kind || !PROVENANCE_KINDS.has(kind as MemoryProvenanceEntry["kind"]) || !refId) continue;
    const entry: MemoryProvenanceEntry = {
      kind: kind as MemoryProvenanceEntry["kind"],
      refId,
    };
    if (typeof r.threadId === "string") entry.threadId = r.threadId;
    if (typeof r.summary === "string") entry.summary = r.summary;
    out.push(entry);
  }
  return out;
}

/**
 * 校验 provenance：非空、每条 kind 合法 + refId 非空。不合规抛错（store/工具据此拒绝写入）。
 */
export function validateProvenance(provenance: MemoryProvenanceEntry[]): void {
  if (!Array.isArray(provenance) || provenance.length === 0) {
    throw new Error("provenance 必填：记忆必须带来源（至少一条）");
  }
  for (const e of provenance) {
    if (!e || !PROVENANCE_KINDS.has(e.kind) || !e.refId || e.refId.length === 0) {
      throw new Error(`provenance 非法：kind/refId 缺失（${JSON.stringify(e)}）`);
    }
  }
}

/** 人可读摘要（供 memory.created 事件 payload + Studio 展示）。截断到 200 字符。 */
export function summarizeProvenance(provenance: MemoryProvenanceEntry[]): string {
  const s = provenance
    .map((e) => {
      const t = e.threadId ? `@${e.threadId.slice(0, 8)}` : "";
      const sum = e.summary ? `:${e.summary}` : "";
      return `${e.kind}#${e.refId.slice(0, 12)}${t}${sum}`;
    })
    .join(", ");
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}
