"use client";

/**
 * Agent External Contract 面板（09 §1/§4/§5，Batch 11）。
 *
 * 展示最新 AgentDescriptorSnapshot：
 * - Capability Manifest：任务能力描述（名称/描述/标签/示例），禁止呈现为函数列表；
 * - Invocation Context Contract：required / preferred / accepted 三组，逐项
 *   context kind + purpose + declaration source（operator_declared 必须标"管理员登记"）。
 *
 * 数据来源：GET /admin/api/v1/agents/{agent_id}/descriptors（同一 Control Plane 合同）。
 */
import type {
  AgentContextContractItemDTO,
  AgentDescriptorSnapshotDTO,
} from "@/lib/control-plane-client";
import { useEffect, useState } from "react";

interface AgentContractPanelProps {
  readonly agentId: string;
  readonly loadDescriptors: (agentId: string) => Promise<{ items: AgentDescriptorSnapshotDTO[] }>;
}

const GROUPS = [
  { key: "required", label: "Required（必须具备且允许发送）" },
  { key: "preferred", label: "Preferred（有就尽量提供）" },
  { key: "accepted", label: "Accepted（可消费，非默认全发）" },
] as const;

function declarationLabel(source?: string | null): string | null {
  if (source === "operator_declared") return "管理员登记";
  if (source === "provider_declared") return "Agent 声明";
  return null;
}

function ContextContractGroup({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly AgentContextContractItemDTO[];
}) {
  return (
    <div>
      <div className="text-[12px] font-medium text-[var(--fg)]">{title}</div>
      {items.length === 0 ? (
        <div className="mt-1 text-[12px] text-[var(--fg-muted)]">（无）</div>
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((item) => {
            const label = declarationLabel(item.declaration_source);
            return (
              <li key={item.context_kind} className="text-[12px] text-[var(--fg-muted)]">
                <span className="font-mono">{item.context_kind}</span>
                {item.purpose ? ` — ${item.purpose}` : ""}
                {label && (
                  <span className="ml-1.5 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--fg-subtle)]">
                    {label}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function AgentContractPanel({ agentId, loadDescriptors }: AgentContractPanelProps) {
  const [snapshot, setSnapshot] = useState<AgentDescriptorSnapshotDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setError(null);
    setLoaded(false);
    loadDescriptors(agentId).then(
      (result) => {
        // 列表按 capturedAt 降序；取最新一条作当前合同。
        if (active) {
          setSnapshot(result.items[0] ?? null);
          setLoaded(true);
        }
      },
      () => {
        if (active) setError("合同加载失败");
      },
    );
    return () => {
      active = false;
    };
  }, [agentId, loadDescriptors]);

  if (error) return <div className="px-3 py-2 text-[12px] text-[var(--danger)]">{error}</div>;
  if (!loaded) {
    return <div className="px-3 py-2 text-[12px] text-[var(--fg-muted)]">合同加载中…</div>;
  }
  if (!snapshot) {
    return <div className="px-3 py-2 text-[12px] text-[var(--fg-muted)]">暂无外部合同</div>;
  }

  const capabilities = snapshot.normalized_capability_manifest?.capabilities ?? [];
  const contract = snapshot.invocation_context_contract ?? {};
  const provenance = snapshot.contract_section_provenance ?? {};
  const capabilitySource = declarationLabel(provenance.capability);

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="text-[12px] text-[var(--fg-muted)]">
        Descriptor Snapshot <span className="font-mono">{snapshot.id.slice(0, 8)}</span> ·{" "}
        {snapshot.protocol_type}@{snapshot.protocol_contract_revision}
        {capabilitySource && (
          <span className="ml-1.5 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px]">
            {capabilitySource}
          </span>
        )}
      </div>

      <div>
        <div className="text-[12px] font-medium text-[var(--fg)]">能力（Capability Manifest）</div>
        {capabilities.length === 0 ? (
          <div className="mt-1 text-[12px] text-[var(--fg-muted)]">（无）</div>
        ) : (
          <ul className="mt-1 space-y-1">
            {capabilities.map((capability) => (
              <li key={capability.capability_key} className="text-[12px] text-[var(--fg-muted)]">
                <span className="text-[var(--fg)]">
                  {capability.display_name ?? capability.capability_key}
                </span>
                {capability.description ? ` — ${capability.description}` : ""}
                {capability.tags && capability.tags.length > 0 && (
                  <span className="ml-1.5 text-[11px]">#{capability.tags.join(" #")}</span>
                )}
                {capability.examples && capability.examples.length > 0 && (
                  <div className="text-[11px] text-[var(--fg-subtle)]">
                    示例：{capability.examples.join("；")}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-[12px] font-medium text-[var(--fg)]">
          调用上下文合同（Invocation Context Contract）
        </div>
        {GROUPS.map((group) => (
          <ContextContractGroup
            key={group.key}
            title={group.label}
            items={(contract[group.key] ?? []) as AgentContextContractItemDTO[]}
          />
        ))}
      </div>
    </div>
  );
}
