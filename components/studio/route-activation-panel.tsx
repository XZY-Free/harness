"use client";

/**
 * 「发布给员工」面板 — 连续 Route 激活（07 §12 + 员工发布闭环）。
 *
 * 管理员只需选择智能体版本与运行服务版本（均以业务名称展示），
 * 一次点击先创建/复用默认 scope 的 RouteSet，再用返回版本原子激活
 * 唯一 route（primary / 10000 / 0）。不自动发布任何 Revision，
 * 运行服务只按 agent_contract_snapshot_id 精确匹配，不做名称/顺序推断。
 *
 * 同页发布交接：refreshToken 变化重新 GET 真实资产；preferred 版本只有在
 * 新拉取的 published 列表中（运行服务还须与所选智能体版本快照精确匹配）
 * 才被选中，绝不凭上游 id 造假选项。刷新失败 fail closed。
 */
import {
  type AgentDTO,
  type AgentRevisionSummaryDTO,
  ControlPlaneRequestError,
  type RuntimeDTO,
  type RuntimeRevisionDTO,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

interface RouteActivationPanelProps {
  readonly canManage: boolean;
  /** 递增代次：上游（如同页真实发布）成功后要求重新拉取真实资产。 */
  readonly refreshToken?: number;
  /** 上游交接：只有新 GET 的 published AgentRevision 中存在才选中。 */
  readonly preferredAgentRevisionId?: string | null;
  /** 上游交接：只有与所选 AgentRevision 快照精确匹配的 published 版本中存在才选中。 */
  readonly preferredRuntimeRevisionId?: string | null;
}

export function RouteActivationPanel({
  canManage,
  refreshToken = 0,
  preferredAgentRevisionId = null,
  preferredRuntimeRevisionId = null,
}: RouteActivationPanelProps) {
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [agentRevisions, setAgentRevisions] = useState<AgentRevisionSummaryDTO[]>([]);
  const [runtimeOptions, setRuntimeOptions] = useState<RuntimeOption[]>([]);
  const [agentRevisionId, setAgentRevisionId] = useState("");
  const [runtimeRevisionId, setRuntimeRevisionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 选择的最新值（刷新时判定“保留仍有效的人工选择”），避免闭包读到过期值。
  const agentRevisionIdRef = useRef("");
  const runtimeRevisionIdRef = useRef("");
  // 递增代次：只有最新一次刷新的响应可以落地，过期响应不得覆盖新结果。
  const loadGeneration = useRef(0);

  function applyAgentRevisionId(value: string) {
    agentRevisionIdRef.current = value;
    setAgentRevisionId(value);
  }

  function applyRuntimeRevisionId(value: string) {
    runtimeRevisionIdRef.current = value;
    setRuntimeRevisionId(value);
  }

  /** 运行服务版本解析：preferred（精确匹配）→ 仍匹配的人工选择 → 唯一匹配 → 空。 */
  function resolveRuntimeRevisionId(
    selected: AgentRevisionSummaryDTO | null,
    options: RuntimeOption[],
    preferred: string | null,
    current: string,
  ): string {
    // 运行服务只按 agent_contract_snapshot_id 精确匹配；null 不匹配。
    if (!selected?.agent_contract_snapshot_id) return "";
    const matching = options.filter(
      (option) =>
        option.revision.agent_contract_snapshot_id === selected.agent_contract_snapshot_id,
    );
    if (preferred && matching.some((option) => option.revision.id === preferred)) {
      return preferred;
    }
    if (matching.some((option) => option.revision.id === current)) {
      return current;
    }
    if (matching.length === 1) {
      return matching[0]?.revision.id ?? "";
    }
    return "";
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken/preferred 是刷新交接信号（同页真实发布后重拉），apply*/resolve 为本组件稳定 helper，非直接引用
  const loadAssets = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const currentAgentRevisionId = agentRevisionIdRef.current;
    const currentRuntimeRevisionId = runtimeRevisionIdRef.current;
    // 刷新开始即清空旧错误/成功文案与旧资产、旧选择：加载中与失败都 fail closed。
    setError(null);
    setNotice(null);
    setLoading(true);
    setAgents([]);
    setAgentRevisions([]);
    setRuntimeOptions([]);
    applyAgentRevisionId("");
    applyRuntimeRevisionId("");
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
      if (loadGeneration.current !== generation) return;

      const publishedAgentRevisions = revisionLists.flat();
      const publishedRuntimeOptions = runtimeRevisionLists.flat();
      setAgents(agentList.items);
      setAgentRevisions(publishedAgentRevisions);
      setRuntimeOptions(publishedRuntimeOptions);

      // AgentRevision 解析：preferred（真实存在）→ 仍有效的人工选择 → 唯一 published → 空。
      const publishedIds = new Set(publishedAgentRevisions.map((revision) => revision.id));
      let nextAgentRevisionId = "";
      if (preferredAgentRevisionId && publishedIds.has(preferredAgentRevisionId)) {
        nextAgentRevisionId = preferredAgentRevisionId;
      } else if (publishedIds.has(currentAgentRevisionId)) {
        nextAgentRevisionId = currentAgentRevisionId;
      } else if (publishedAgentRevisions.length === 1) {
        nextAgentRevisionId = publishedAgentRevisions[0]?.id ?? "";
      }
      applyAgentRevisionId(nextAgentRevisionId);

      const selected =
        publishedAgentRevisions.find((revision) => revision.id === nextAgentRevisionId) ?? null;
      applyRuntimeRevisionId(
        resolveRuntimeRevisionId(
          selected,
          publishedRuntimeOptions,
          preferredRuntimeRevisionId,
          currentRuntimeRevisionId,
        ),
      );
    } catch (err) {
      if (loadGeneration.current !== generation) return;
      setError(classifyError(err));
    } finally {
      if (loadGeneration.current === generation) {
        setLoading(false);
      }
    }
  }, [refreshToken, preferredAgentRevisionId, preferredRuntimeRevisionId]);

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

  // 人工切换智能体版本：运行服务选择按新版本的精确匹配快照重新解析。
  function handleAgentRevisionChange(value: string) {
    const selected = agentRevisions.find((revision) => revision.id === value) ?? null;
    applyAgentRevisionId(value);
    applyRuntimeRevisionId(
      resolveRuntimeRevisionId(
        selected,
        runtimeOptions,
        preferredRuntimeRevisionId,
        runtimeRevisionIdRef.current,
      ),
    );
  }

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
            onChange={(e) => handleAgentRevisionChange(e.target.value)}
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
            onChange={(e) => applyRuntimeRevisionId(e.target.value)}
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
