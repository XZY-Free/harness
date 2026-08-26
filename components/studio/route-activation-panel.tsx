"use client";

/**
 * 「发布给员工」面板 — 连续 Route 激活（07 §12 + 员工发布闭环）。
 *
 * 管理员只需选择智能体版本与运行服务版本（均以业务名称展示），
 * 一次点击先创建/复用默认 scope 的 RouteSet，再用返回版本原子激活
 * 唯一 route（primary / 10000 / 0）。不自动发布任何 Revision，
 * 运行服务只按 agent_contract_snapshot_id 精确匹配，不做名称/顺序推断。
 */
import {
  type AgentDTO,
  type AgentRevisionSummaryDTO,
  ControlPlaneRequestError,
  type RuntimeDTO,
  type RuntimeRevisionDTO,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { useCallback, useEffect, useMemo, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

function classifyError(err: unknown): string {
  if (err instanceof ControlPlaneRequestError) {
    switch (err.code) {
      case "ETAG_MISMATCH":
        return "发布失败：配置刚被其他人修改，请刷新后重试";
      case "BUSINESS_CONSTRAINT_VIOLATION":
        return "发布失败：所选运行服务与智能体版本不匹配，请重新选择";
      case "ACTION_SCOPE_DENIED":
        return "发布失败：你没有发布智能体的权限";
      case "OPERATION_PAYLOAD_CONFLICT":
        return "发布失败：现有配置与本次请求冲突，请刷新后重试";
      case "RESOURCE_NOT_FOUND":
        return "发布失败：所选智能体或运行服务已不存在，请刷新后重试";
      default:
        return "发布失败：服务暂时不可用，请稍后重试";
    }
  }
  return "发布失败，请稍后重试";
}

interface RuntimeOption {
  runtime: RuntimeDTO;
  revision: RuntimeRevisionDTO;
}

export function RouteActivationPanel({ canManage }: { readonly canManage: boolean }) {
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [agentRevisions, setAgentRevisions] = useState<AgentRevisionSummaryDTO[]>([]);
  const [runtimeOptions, setRuntimeOptions] = useState<RuntimeOption[]>([]);
  const [agentRevisionId, setAgentRevisionId] = useState("");
  const [runtimeRevisionId, setRuntimeRevisionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAssets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const agentList = await client.agents.list();
      const revisionLists = await Promise.all(
        agentList.items.map((agent) =>
          client.agents
            .listRevisions(agent.id)
            .then((list) => list.items.filter((r) => r.revision_state === "published")),
        ),
      );
      const runtimeList = await client.runtimes.list();
      const runtimeRevisionLists = await Promise.all(
        runtimeList.items.map((runtime) =>
          client.runtimes
            .listRevisions(runtime.id)
            .then((list) =>
              list.items
                .filter((r) => r.revision_state === "published")
                .map((revision) => ({ runtime, revision })),
            ),
        ),
      );
      setAgents(agentList.items);
      setAgentRevisions(revisionLists.flat());
      setRuntimeOptions(runtimeRevisionLists.flat());
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const selectedAgentRevision = useMemo(
    () => agentRevisions.find((revision) => revision.id === agentRevisionId) ?? null,
    [agentRevisions, agentRevisionId],
  );

  // 运行服务只按 agent_contract_snapshot_id 精确匹配；null 不匹配。
  const matchingRuntimeOptions = useMemo(
    () =>
      selectedAgentRevision?.agent_contract_snapshot_id
        ? runtimeOptions.filter(
            (option) =>
              option.revision.agent_contract_snapshot_id ===
              selectedAgentRevision.agent_contract_snapshot_id,
          )
        : [],
    [runtimeOptions, selectedAgentRevision],
  );

  // 唯一智能体版本自动选中；切换时清理旧运行服务选择，唯一匹配再自动选。
  useEffect(() => {
    if (!agentRevisionId && agentRevisions.length === 1) {
      setAgentRevisionId(agentRevisions[0]?.id ?? "");
    }
  }, [agentRevisions, agentRevisionId]);

  useEffect(() => {
    if (matchingRuntimeOptions.length === 1) {
      setRuntimeRevisionId(matchingRuntimeOptions[0]?.revision.id ?? "");
      return;
    }
    setRuntimeRevisionId("");
  }, [matchingRuntimeOptions]);

  const noRuntimeReason =
    selectedAgentRevision && matchingRuntimeOptions.length === 0
      ? "没有匹配的运行服务：请先为该智能体版本发布对应的运行服务"
      : null;

  const canSubmit = Boolean(selectedAgentRevision && runtimeRevisionId) && !busy && !loading;

  async function publishToStaff() {
    if (!selectedAgentRevision || !runtimeRevisionId) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // 1) 创建/复用默认 scope 的 RouteSet（无需知道 RouteSet id）。
      const routeSet = await client.routes.ensureRouteSet(
        {
          agent_id: selectedAgentRevision.agent_id,
          route_scope_key: "default",
          route_scope: {},
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      // 2) 用返回的 id/version 原子激活唯一 route。
      await client.routes.activateRouteSet(
        routeSet.id,
        {
          expected_version_no: routeSet.version_no,
          reason: "发布给员工",
          routes: [
            {
              route_group_id: "primary",
              agent_revision_id: selectedAgentRevision.id,
              runtime_revision_id: runtimeRevisionId,
              traffic_weight: 10000,
              priority_no: 0,
            },
          ],
        },
        {
          idempotencyKey: crypto.randomUUID(),
          ifMatch: `route-set-${routeSet.version_no}`,
        },
      );
      setNotice("发布成功：员工新会话现在可以选择该智能体。");
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <div className="mt-4 text-[13px] text-[var(--fg-muted)]">
        你没有发布智能体的权限（发布仍由服务端严格校验）。
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-[13px] font-medium text-[var(--fg)]">发布给员工</div>
      {loading && (
        <div className="text-[12px] text-[var(--fg-muted)]">正在加载智能体与运行服务…</div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-[12px] text-[var(--fg-muted)]">
          智能体版本
          <select
            value={agentRevisionId}
            onChange={(e) => setAgentRevisionId(e.target.value)}
            aria-label="智能体版本"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          >
            <option value="">（选择智能体版本）</option>
            {agentRevisions.map((revision) => (
              <option key={revision.id} value={revision.id}>
                {agentsById.get(revision.agent_id)?.display_name ?? "未知智能体"} · 第{" "}
                {revision.revision_no} 版
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] text-[var(--fg-muted)]">
          运行服务版本
          <select
            value={runtimeRevisionId}
            onChange={(e) => setRuntimeRevisionId(e.target.value)}
            aria-label="运行服务版本"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          >
            <option value="">（选择运行服务版本）</option>
            {matchingRuntimeOptions.map(({ runtime, revision }) => (
              <option key={revision.id} value={revision.id}>
                {runtime.display_name} · 第 {revision.revision_no} 版
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        disabled={!canSubmit}
        onClick={publishToStaff}
        className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] text-[var(--fg)] disabled:opacity-50"
      >
        {busy ? "发布中…" : "发布给员工"}
      </button>
      {noRuntimeReason && (
        <div className="text-[12px] text-[var(--fg-muted)]">{noRuntimeReason}</div>
      )}
      {error && <div className="text-[12px] text-[var(--danger)]">{error}</div>}
      {notice && <div className="text-[12px] text-[var(--fg)]">{notice}</div>}
    </div>
  );
}
