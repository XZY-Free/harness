import type { ProviderProfile } from "@/lib/db/schema";

/**
 * Phase 4-4 切片 B1：Providers 只读展示。
 * 表格列：name / baseUrl / apiKeyRef（引用名，非明文）/ isDefault / createdAt。
 * apiKeyRef 仅展示 env 引用名（如 LLM_API_KEY），不暴露明文 secret。
 */
export function ProvidersViewer({ providers }: { providers: ProviderProfile[] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-[13px]">
        <thead className="bg-[var(--surface-2)] text-[var(--fg-subtle)]">
          <tr>
            <th className="px-3 py-2 text-left font-medium">名称</th>
            <th className="px-3 py-2 text-left font-medium">接口地址</th>
            <th className="px-3 py-2 text-left font-medium">API Key 引用</th>
            <th className="px-3 py-2 text-left font-medium">默认</th>
            <th className="px-3 py-2 text-left font-medium">创建时间</th>
          </tr>
        </thead>
        <tbody>
          {providers.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-[var(--fg-muted)]">
                暂无模型提供方档案（运行 pnpm db:seed 灌入默认模型提供方）
              </td>
            </tr>
          )}
          {providers.map((p) => (
            <tr key={p.id} className="border-t border-[var(--border)]">
              <td className="px-3 py-2 text-[var(--fg)]">{p.name}</td>
              <td className="px-3 py-2 font-mono text-[var(--fg-muted)]">{p.baseUrl}</td>
              <td className="px-3 py-2 font-mono text-[var(--fg-muted)]">{p.apiKeyRef}</td>
              <td className="px-3 py-2 text-[var(--fg-muted)]">{p.isDefault ? "是" : "否"}</td>
              <td className="px-3 py-2 text-[var(--fg-muted)]">
                {new Date(p.createdAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
