"use client";

import { useEffect, useState } from "react";

/**
 * V3.3b Stage E：Studio 长期记忆面板。
 *
 * 列当前 thread 可见记忆（user + thread scope），展示 text/scope/kind/confidence/provenance 来源。
 * curate：revoke（soft delete）+ confidence 编辑。空状态「当前 thread 无长期记忆」。
 * memory-derived 来源可见（蓝图 §6.5）：每条展示 provenance 摘要。
 */

type Memory = {
  id: string;
  scope: string;
  scopeRef: string | null;
  kind: string;
  text: string;
  confidence: string;
  status: string;
  expiresAt: string | null;
  provenance: Array<{ kind: string; refId: string; threadId?: string; summary?: string }>;
  updatedAt: string;
};

function provenanceText(p: Memory["provenance"]): string {
  return p
    .map((e) => `${e.kind}#${e.refId.slice(0, 8)}${e.summary ? `:${e.summary}` : ""}`)
    .join(", ");
}

export function MemoryPanel({ threadId }: { threadId: string }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const res = await fetch(`/studio/api/threads/${threadId}/memories`);
      const body = await res.json();
      setMemories(body.data?.memories ?? []);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    let cancelled = false;
    fetch(`/studio/api/threads/${threadId}/memories`)
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setMemories(body.data?.memories ?? []);
      })
      .catch(() => {
        if (!cancelled) setMemories([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  async function revoke(id: string) {
    await fetch(`/studio/api/threads/${threadId}/memories/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke" }),
    });
    void load();
  }

  async function setConfidence(id: string, confidence: string) {
    await fetch(`/studio/api/threads/${threadId}/memories/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", confidence }),
    });
    void load();
  }

  if (loading) return <div className="text-sm text-gray-500">加载长期记忆…</div>;
  if (memories.length === 0) {
    return <div className="text-sm text-gray-500">当前 thread 无长期记忆</div>;
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">长期记忆（memory-derived，来源可查）</h3>
      <ul className="space-y-2">
        {memories.map((m) => (
          <li key={m.id} className="rounded border border-gray-200 p-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="rounded bg-gray-100 px-1 text-xs">
                {m.scope}/{m.kind}
              </span>
              <span className="flex-1">{m.text}</span>
              <select
                value={m.confidence}
                onChange={(e) => void setConfidence(m.id, e.target.value)}
                className="border border-gray-300 text-xs"
                disabled={m.status === "revoked"}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              {m.status === "active" ? (
                <button
                  type="button"
                  onClick={() => void revoke(m.id)}
                  className="rounded border border-red-300 px-2 text-xs text-red-600"
                >
                  撤销
                </button>
              ) : (
                <span className="text-xs text-gray-400">已撤销</span>
              )}
            </div>
            <div className="mt-1 text-xs text-gray-500">来源: {provenanceText(m.provenance)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
