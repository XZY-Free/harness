"use client";

/**
 * 已注册智能体合同面板。展示后台结构化保存的最新合同快照；不读取远端 AgentCard，
 * 也不消费整份原始合同 JSON。
 */
import type { AgentContractContextDTO, AgentContractSnapshotDTO } from "@/lib/control-plane-client";
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

interface AgentContractPanelProps {
  readonly agentId: string;
  readonly loadContracts: (agentId: string) => Promise<{ items: AgentContractSnapshotDTO[] }>;
}

const GROUPS = [
  { key: "required", label: "必须提供", description: "调用时必须具备并允许发送" },
  { key: "preferred", label: "建议提供", description: "具备时优先提供" },
  { key: "accepted", label: "可选提供", description: "可以使用，但不会默认发送" },
] as const;

const INTERACTIONS = [
  ["streaming_transport", "流式传输"],
  ["incremental_content", "增量内容"],
  ["input_required", "补充输入"],
  ["resume", "恢复任务"],
  ["cancel", "取消任务"],
  ["durable_task_recovery", "任务恢复"],
] as const;

function declarationLabel(source?: string | null): string | null {
  if (source === "operator_declared") return "管理员登记";
  if (source === "provider_declared") return "智能体声明";
  return null;
}

function ContextContractGroup({
  title,
  description,
  items,
}: {
  readonly title: string;
  readonly description: string;
  readonly items: readonly AgentContractContextDTO[];
}) {
  return (
    <section className="rounded-lg border bg-background p-3">
      <h5 className="text-sm font-medium text-foreground">{title}</h5>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      {items.length === 0 ? (
        <div className="mt-3 text-sm text-muted-foreground">暂无字段</div>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => {
            const label = declarationLabel(item.declaration_source);
            return (
              <li key={item.key} className="text-sm text-muted-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">
                    {item.name["zh-CN"] ?? item.key}
                  </span>
                </div>
                {item.description["zh-CN"] && (
                  <p className="mt-0.5 text-xs">{item.description["zh-CN"]}</p>
                )}
                {label && (
                  <span className="mt-1.5 inline-flex rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                    {label}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
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

  if (error) {
    return (
      <div role="alert" className="flex items-center gap-2 px-4 py-5 text-sm text-destructive">
        <CircleAlert className="size-4" aria-hidden />
        {error}
      </div>
    );
  }
  if (!loaded) {
    return (
      <output
        aria-live="polite"
        className="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground"
      >
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        合同加载中…
      </output>
    );
  }
  if (!snapshot) {
    return <div className="px-4 py-5 text-sm text-muted-foreground">暂无外部合同</div>;
  }

  const capabilities = snapshot.capabilities;

  return (
    <div className="space-y-5 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          智能体版本{" "}
          <strong className="font-medium text-foreground">{snapshot.public_agent_version}</strong>
        </span>
        <span>
          合同版本{" "}
          <strong className="font-medium text-foreground">{snapshot.contract_version}</strong>
        </span>
        <span>
          协议{" "}
          <strong className="font-medium text-foreground">
            {snapshot.protocol_type === "a2a" ? "A2A（智能体通信）" : "其他协议"}
          </strong>
        </span>
      </div>

      <section>
        <h4 className="text-sm font-semibold text-foreground">交互能力</h4>
        <ul className="mt-3 flex flex-wrap gap-2">
          {INTERACTIONS.map(([key, label]) => {
            const enabled = snapshot.interaction[key];
            return (
              <li
                key={key}
                className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground"
                aria-label={`${label}：${enabled ? "支持" : "不支持"}`}
              >
                {enabled ? (
                  <Check className="size-3.5 text-success" aria-hidden />
                ) : (
                  <X className="size-3.5 text-foreground-subtle" aria-hidden />
                )}
                <span>{label}</span>
                <span className="sr-only">{enabled ? "支持" : "不支持"}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h4 className="text-sm font-semibold text-foreground">能力清单</h4>
        {capabilities.length === 0 ? (
          <div className="mt-3 text-sm text-muted-foreground">暂无能力</div>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {capabilities.map((capability) => (
              <li key={capability.key} className="rounded-lg border bg-background p-3">
                <div className="text-sm font-medium text-foreground">
                  {capability.name["zh-CN"] ?? capability.key}
                </div>
                {capability.description["zh-CN"] && (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {capability.description["zh-CN"]}
                  </p>
                )}
                {capability.tags && capability.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {capability.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
                {capability.examples && capability.examples.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    示例：{capability.examples.join("；")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="text-sm font-semibold text-foreground">调用上下文</h4>
        <div className="mt-3 grid gap-2 lg:grid-cols-3">
          {GROUPS.map((group) => (
            <ContextContractGroup
              key={group.key}
              title={group.label}
              description={group.description}
              items={snapshot.invocation_context.filter((item) => item.necessity === group.key)}
            />
          ))}
        </div>
      </section>

      <details className="rounded-lg border bg-background px-3 py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none font-medium text-foreground">
          查看技术信息
        </summary>
        <dl className="mt-3 grid gap-2">
          <div>
            <dt>合同快照</dt>
            <dd className="break-all font-mono">{snapshot.snapshot_id}</dd>
          </div>
          <div>
            <dt>协议版本</dt>
            <dd className="break-all font-mono">{snapshot.protocol_contract_revision}</dd>
          </div>
          <div>
            <dt>合同摘要</dt>
            <dd className="break-all font-mono">{snapshot.contract_digest}</dd>
          </div>
          <div>
            <dt>能力摘要</dt>
            <dd className="break-all font-mono">{snapshot.capability_digest}</dd>
          </div>
          <div>
            <dt>上下文摘要</dt>
            <dd className="break-all font-mono">{snapshot.context_digest}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
