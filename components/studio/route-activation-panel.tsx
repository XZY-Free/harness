"use client";

/**
 * 最小 Route 激活面板（07 §12）。
 *
 * 无既有 Route UI 入口时的最小补充：选择 published AgentRevision +
 * published RuntimeRevision + route scope（routeSetId/routeGroupId），
 * 走正式 RouteSet 原子激活 API（Idempotency-Key + If-Match）。
 * Runtime 注册后绝不自动 publish/route/activate —— 激活必须由管理员显式提交。
 */
import {
  type AgentRevisionSummaryDTO,
  ControlPlaneRequestError,
  type RuntimeRevisionDTO,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { useCallback, useEffect, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

function classifyError(err: unknown): string {
  if (err instanceof ControlPlaneRequestError) {
    switch (err.code) {
      case "ETAG_MISMATCH":
        return "ETag 冲突（RouteSet 已被修改，请刷新后重试）";
      case "BUSINESS_CONSTRAINT_VIOLATION":
        return "激活被拒（发布前置条件/权重约束）";
      case "ACTION_SCOPE_DENIED":
        return "无 route.update 操作权限";
      default:
        return `激活失败（${err.code ?? "未知错误"}）`;
    }
  }
  return "激活失败";
}

export function RouteActivationPanel({ canManage }: { readonly canManage: boolean }) {
  const [routeSetId, setRouteSetId] = useState("");
  const [routeSet, setRouteSet] = useState<{
    id: string;
    version_no: number;
    route_scope_key: string;
  } | null>(null);
  const [agentRevisions, setAgentRevisions] = useState<AgentRevisionSummaryDTO[]>([]);
  const [runtimeRevisions, setRuntimeRevisions] = useState<
    Array<{ runtimeId: string; revision: RuntimeRevisionDTO }>
  >([]);
  const [agentRevisionId, setAgentRevisionId] = useState("");
  const [runtimeRevisionId, setRuntimeRevisionId] = useState("");
  const [routeGroupId, setRouteGroupId] = useState("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAssets = useCallback(async () => {
    try {
      // 只列 published（正式激活前置条件：双 published Revision）。
      const agents = await client.agents.list();
      const agentRevisionLists = await Promise.all(
        agents.items.map((agent) =>
          client.agents
            .listRevisions(agent.id)
            .then((list) => list.items.filter((r) => r.revision_state === "published")),
        ),
      );
      setAgentRevisions(agentRevisionLists.flat());
      const runtimes = await client.runtimes.list();
      const runtimeRevisionLists = await Promise.all(
        runtimes.items.map((runtime) =>
          client.runtimes
            .listRevisions(runtime.id)
            .then((list) =>
              list.items
                .filter((r) => r.revision_state === "published")
                .map((revision) => ({ runtimeId: runtime.id, revision })),
            ),
        ),
      );
      setRuntimeRevisions(runtimeRevisionLists.flat());
    } catch (err) {
      setError(classifyError(err));
    }
  }, []);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  async function loadRouteSet() {
    setError(null);
    setRouteSet(null);
    if (!routeSetId.trim()) return;
    try {
      const set = await client.routes.getRouteSet(routeSetId.trim());
      setRouteSet({ id: set.id, version_no: set.version_no, route_scope_key: set.route_scope_key });
    } catch (err) {
      setError(classifyError(err));
    }
  }

  async function activate() {
    setError(null);
    setNotice(null);
    if (!routeSet) {
      setError("必须先加载 RouteSet");
      return;
    }
    setBusy(true);
    try {
      await client.routes.activateRouteSet(
        routeSet.id,
        {
          expected_version_no: routeSet.version_no,
          reason: "Studio 最小 Route 激活（07 §12）",
          routes: [
            {
              route_group_id: routeGroupId.trim(),
              agent_revision_id: agentRevisionId,
              runtime_revision_id: runtimeRevisionId,
              traffic_weight: 100,
              priority_no: 0,
            },
          ],
        },
        {
          idempotencyKey: crypto.randomUUID(),
          ifMatch: `route-set-${routeSet.version_no}`,
        },
      );
      setNotice("RouteSet 已激活（正式 activation）");
      await loadRouteSet();
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    routeSet && agentRevisionId && runtimeRevisionId && routeGroupId.trim() && !busy;

  if (!canManage) {
    return (
      <div className="mt-4 text-[13px] text-[var(--fg-muted)]">
        Route 操作需要 route.update 权限（正式激活仍由后端严格校验）。
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-[13px] font-medium text-[var(--fg)]">
        Route 激活（正式 RouteSet Activation）
      </div>
      <div className="flex items-end gap-2">
        <label className="flex-1 text-[12px] text-[var(--fg-muted)]">
          RouteSet id
          <input
            value={routeSetId}
            onChange={(e) => setRouteSetId(e.target.value)}
            aria-label="route_set_id"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          />
        </label>
        <button
          type="button"
          onClick={loadRouteSet}
          className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] text-[var(--fg)]"
        >
          加载
        </button>
      </div>
      {routeSet && (
        <div className="text-[12px] text-[var(--fg-muted)]">
          scope <span className="font-mono">{routeSet.route_scope_key}</span> · version{" "}
          <span className="font-mono">{routeSet.version_no}</span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-[12px] text-[var(--fg-muted)]">
          published AgentRevision
          <select
            value={agentRevisionId}
            onChange={(e) => setAgentRevisionId(e.target.value)}
            aria-label="agent_revision_id"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          >
            <option value="">（选择）</option>
            {agentRevisions.map((revision) => (
              <option key={revision.id} value={revision.id}>
                {revision.id}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] text-[var(--fg-muted)]">
          published RuntimeRevision
          <select
            value={runtimeRevisionId}
            onChange={(e) => setRuntimeRevisionId(e.target.value)}
            aria-label="runtime_revision_id"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          >
            <option value="">（选择）</option>
            {runtimeRevisions.map(({ revision }) => (
              <option key={revision.id} value={revision.id}>
                {revision.id}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] text-[var(--fg-muted)]">
          route_group_id
          <input
            value={routeGroupId}
            onChange={(e) => setRouteGroupId(e.target.value)}
            aria-label="route_group_id"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          />
        </label>
      </div>
      <button
        type="button"
        disabled={!canSubmit}
        onClick={activate}
        className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] text-[var(--fg)] disabled:opacity-50"
      >
        {busy ? "激活中…" : "激活 RouteSet"}
      </button>
      {error && <div className="text-[12px] text-[var(--danger)]">{error}</div>}
      {notice && <div className="text-[12px] text-[var(--fg)]">{notice}</div>}
    </div>
  );
}
