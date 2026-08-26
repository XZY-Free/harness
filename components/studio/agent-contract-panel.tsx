"use client";

/**
 * 已注册智能体合同面板。展示后台结构化保存的最新合同快照；不读取远端 AgentCard，
 * 也不消费整份原始合同 JSON。
 */
import type { AgentContractContextDTO, AgentContractSnapshotDTO } from "@/lib/control-plane-client";
import { useEffect, useState } from "react";

interface AgentContractPanelProps {
  readonly agentId: string;
  readonly loadContracts: (agentId: string) => Promise<{ items: AgentContractSnapshotDTO[] }>;
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
  readonly items: readonly AgentContractContextDTO[];
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
              <li key={item.key} className="text-[12px] text-[var(--fg-muted)]">
                <span className="font-mono">{item.key}</span>
                {item.description["zh-CN"] ? ` — ${item.description["zh-CN"]}` : ""}
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

export function AgentContractPanel({ agentId, loadContracts }: AgentContractPanelProps) {
  const [snapshot, setSnapshot] = useState<AgentContractSnapshotDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setError(null);
    setLoaded(false);
    loadContracts(agentId).then(
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
  }, [agentId, loadContracts]);

  if (error) return <div className="px-3 py-2 text-[12px] text-[var(--danger)]">{error}</div>;
  if (!loaded) {
    return <div className="px-3 py-2 text-[12px] text-[var(--fg-muted)]">合同加载中…</div>;
  }
  if (!snapshot) {
    return <div className="px-3 py-2 text-[12px] text-[var(--fg-muted)]">暂无外部合同</div>;
  }

  const capabilities = snapshot.capabilities;

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="space-y-1 text-[12px] text-[var(--fg-muted)]">
        <div>
          Snapshot <span className="font-mono">{snapshot.snapshot_id}</span> · Agent version{" "}
          <span className="font-mono">{snapshot.public_agent_version}</span>
        </div>
        <div>
          合同版本 <span className="font-mono">{snapshot.contract_version}</span> ·{" "}
          {snapshot.protocol_type}@{snapshot.protocol_contract_revision}
        </div>
        <div className="break-all">
          contractDigest <span className="font-mono">{snapshot.contract_digest}</span>
        </div>
        <div className="break-all">
          capabilityDigest <span className="font-mono">{snapshot.capability_digest}</span>
        </div>
        <div className="break-all">
          contextDigest <span className="font-mono">{snapshot.context_digest}</span>
        </div>
      </div>

      <div>
        <div className="text-[12px] font-medium text-[var(--fg)]">
          交互能力（Interaction Capability）
        </div>
        <ul className="mt-1 flex flex-wrap gap-2 text-[12px] text-[var(--fg-muted)]">
          {[
            ["streaming_transport", snapshot.interaction.streaming_transport],
            ["incremental_content", snapshot.interaction.incremental_content],
            ["input_required", snapshot.interaction.input_required],
            ["resume", snapshot.interaction.resume],
            ["cancel", snapshot.interaction.cancel],
            ["durable_task_recovery", snapshot.interaction.durable_task_recovery],
          ].map(([key, enabled]) => (
            <li
              key={String(key)}
              className="rounded bg-[var(--surface-2)] px-1.5 py-0.5"
              aria-label={`interaction_${key}`}
            >
              <span className="font-mono">{String(key)}</span>
              <span className={enabled ? " text-[var(--fg)]" : " text-[var(--fg-subtle)]"}>
                {enabled ? " ✓" : " ✗"}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="text-[12px] font-medium text-[var(--fg)]">能力（Capability Manifest）</div>
        {capabilities.length === 0 ? (
          <div className="mt-1 text-[12px] text-[var(--fg-muted)]">（无）</div>
        ) : (
          <ul className="mt-1 space-y-1">
            {capabilities.map((capability) => (
              <li key={capability.key} className="text-[12px] text-[var(--fg-muted)]">
                <span className="text-[var(--fg)]">
                  {capability.name["zh-CN"] ?? capability.key}
                </span>
                {capability.description["zh-CN"] ? ` — ${capability.description["zh-CN"]}` : ""}
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
            items={snapshot.invocation_context.filter((item) => item.necessity === group.key)}
          />
        ))}
      </div>
    </div>
  );
}
