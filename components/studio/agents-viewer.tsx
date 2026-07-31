import type { Agent } from "@/lib/db/schema";

/**
 * Phase 4-4 切片 B1：Agents 只读展示。
 * 表格列：name / description / model / skillId / createdAt。
 * config（subagent 模板 / 并行策略）本切片不渲染，仅存储以备后续切片。
 */
export function AgentsViewer({ agents }: { agents: Agent[] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-[13px]">
        <thead className="bg-[var(--surface-2)] text-[var(--fg-subtle)]">
          <tr>
            <th className="px-3 py-2 text-left font-medium">名称</th>
            <th className="px-3 py-2 text-left font-medium">描述</th>
            <th className="px-3 py-2 text-left font-medium">模型</th>
            <th className="px-3 py-2 text-left font-medium">绑定技能</th>
            <th className="px-3 py-2 text-left font-medium">创建时间</th>
          </tr>
        </thead>
        <tbody>
          {agents.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-[var(--fg-muted)]">
                暂无智能体档案（运行 pnpm db:seed 灌入默认智能体）
              </td>
            </tr>
          )}
          {agents.map((a) => (
            <tr key={a.id} className="border-t border-[var(--border)]">
              <td className="px-3 py-2 text-[var(--fg)]">{a.name}</td>
              <td className="px-3 py-2 text-[var(--fg-muted)]">{a.description ?? "—"}</td>
              <td className="px-3 py-2 font-mono text-[var(--fg-muted)]">{a.model}</td>
              <td className="px-3 py-2 font-mono text-[var(--fg-muted)]">
                {a.skillId ? a.skillId.slice(0, 8) : "—"}
              </td>
              <td className="px-3 py-2 text-[var(--fg-muted)]">
                {new Date(a.createdAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
