"use client";

/**
 * 「发布给员工」面板 — 为黑盒 Agent 冻结 A2A Route endpoint Authority。
 *
 * AgentRevision 只负责合同；实际调用位置、身份方式、凭证引用和网络区域只写入
 * targetKind=agent 的 RouteRevision。此面板不读取、不选择也不提交 RuntimeRevision。
 */
import {
  type AgentDTO,
  type AgentRevisionSummaryDTO,
  ControlPlaneRequestError,
  type CredentialRefSummaryDTO,
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
        return "发布失败：调用地址或身份信息不符合要求，请检查后重试";
      case "ACTION_SCOPE_DENIED":
        return "发布失败：你没有发布智能体的权限";
      case "OPERATION_PAYLOAD_CONFLICT":
        return "发布失败：现有配置与本次请求冲突，请刷新后重试";
      case "RESOURCE_NOT_FOUND":
        return "发布失败：所选智能体版本或访问凭证已不存在，请刷新后重试";
      default:
        return "发布失败：服务暂时不可用，请稍后重试";
    }
  }
  return "发布失败，请稍后重试";
}

interface RouteActivationPanelProps {
  readonly canManage: boolean;
  /** 上游真实 AgentRevision 发布成功后递增，要求重新读取权威资产。 */
  readonly refreshToken?: number;
  /** 只有新 GET 的 published AgentRevision 中存在该 id 才会选中。 */
  readonly preferredAgentRevisionId?: string | null;
}

export function RouteActivationPanel({
  canManage,
  refreshToken = 0,
  preferredAgentRevisionId = null,
}: RouteActivationPanelProps) {
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [agentRevisions, setAgentRevisions] = useState<AgentRevisionSummaryDTO[]>([]);
  const [credentials, setCredentials] = useState<CredentialRefSummaryDTO[]>([]);
  const [agentRevisionId, setAgentRevisionId] = useState("");
  const [endpointRef, setEndpointRef] = useState("");
  const [networkZone, setNetworkZone] = useState("");
  const [identityMode, setIdentityMode] = useState<"none" | "bearer">("none");
  const [credentialRefId, setCredentialRefId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const agentRevisionIdRef = useRef("");
  const loadGeneration = useRef(0);

  function applyAgentRevisionId(value: string) {
    agentRevisionIdRef.current = value;
    setAgentRevisionId(value);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken/preferred 是上游发布交接信号；ref 保存刷新前的人工选择
  const loadAssets = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const currentAgentRevisionId = agentRevisionIdRef.current;
    setError(null);
    setNotice(null);
    setLoading(true);
    setAgents([]);
    setAgentRevisions([]);
    setCredentials([]);
    applyAgentRevisionId("");
    setCredentialRefId("");

    try {
      const [agentList, credentialList] = await Promise.all([
        client.agents.list(),
        client.credentials.list(),
      ]);
      const revisionLists = await Promise.all(
        agentList.items.map((agent) =>
          client.agents
            .listRevisions(agent.id)
            .then((list) =>
              list.items.filter((revision) => revision.revision_state === "published"),
            ),
        ),
      );
      if (loadGeneration.current !== generation) return;

      const publishedAgentRevisions = revisionLists.flat();
      setAgents(agentList.items);
      setAgentRevisions(publishedAgentRevisions);
      setCredentials(credentialList.items);

      const publishedIds = new Set(publishedAgentRevisions.map((revision) => revision.id));
      if (preferredAgentRevisionId && publishedIds.has(preferredAgentRevisionId)) {
        applyAgentRevisionId(preferredAgentRevisionId);
      } else if (publishedIds.has(currentAgentRevisionId)) {
        applyAgentRevisionId(currentAgentRevisionId);
      } else if (publishedAgentRevisions.length === 1) {
        applyAgentRevisionId(publishedAgentRevisions[0]?.id ?? "");
      }
    } catch (err) {
      if (loadGeneration.current !== generation) return;
      setError(classifyError(err));
    } finally {
      if (loadGeneration.current === generation) setLoading(false);
    }
  }, [refreshToken, preferredAgentRevisionId]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const selectedAgentRevision = useMemo(
    () => agentRevisions.find((revision) => revision.id === agentRevisionId) ?? null,
    [agentRevisions, agentRevisionId],
  );

  function changeIdentityMode(value: "none" | "bearer") {
    setIdentityMode(value);
    if (value === "none") setCredentialRefId("");
  }

  const canSubmit =
    !loading &&
    !busy &&
    selectedAgentRevision !== null &&
    endpointRef.trim() !== "" &&
    networkZone.trim() !== "" &&
    (identityMode === "none" || credentialRefId.trim() !== "");

  async function publishToStaff() {
    if (!canSubmit || !selectedAgentRevision) return;
    const endpoint = endpointRef.trim();
    const zone = networkZone.trim();
    const credential = identityMode === "bearer" ? credentialRefId.trim() : null;

    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const routeSet = await client.routes.ensureRouteSet(
        {
          target: { kind: "agent", agent_id: selectedAgentRevision.agent_id },
          route_scope_key: "default",
          route_scope: {},
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      await client.routes.activateRouteSet(
        routeSet.id,
        {
          expected_version_no: routeSet.version_no,
          reason: "发布给员工",
          routes: [
            {
              route_group_id: "primary",
              target: {
                kind: "agent",
                agent_revision_id: selectedAgentRevision.id,
                endpoint_ref: endpoint,
                identity_mode: identityMode,
                credential_ref_id: credential,
                network_zone: zone,
              },
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

  const fieldClass =
    "mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]";

  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-[13px] font-medium text-[var(--fg)]">发布给员工</div>
      {loading && (
        <div className="text-[12px] text-[var(--fg-muted)]">正在加载智能体与访问凭证…</div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-[12px] text-[var(--fg-muted)]">
          智能体版本
          <select
            value={agentRevisionId}
            onChange={(event) => applyAgentRevisionId(event.target.value)}
            aria-label="智能体版本"
            className={fieldClass}
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
          端点 URL
          <input
            value={endpointRef}
            onChange={(event) => setEndpointRef(event.target.value)}
            aria-label="端点 URL"
            className={fieldClass}
            autoComplete="off"
          />
        </label>
        <label className="text-[12px] text-[var(--fg-muted)]">
          网络区域
          <input
            value={networkZone}
            onChange={(event) => setNetworkZone(event.target.value)}
            aria-label="网络区域"
            className={fieldClass}
            autoComplete="off"
          />
        </label>
        <label className="text-[12px] text-[var(--fg-muted)]">
          身份模式
          <select
            value={identityMode}
            onChange={(event) => changeIdentityMode(event.target.value as "none" | "bearer")}
            aria-label="身份模式"
            className={fieldClass}
          >
            <option value="none">无需认证</option>
            <option value="bearer">访问令牌</option>
          </select>
        </label>
        {identityMode === "bearer" && (
          <label className="text-[12px] text-[var(--fg-muted)] sm:col-span-2">
            访问凭证
            <select
              value={credentialRefId}
              onChange={(event) => setCredentialRefId(event.target.value)}
              aria-label="访问凭证"
              className={fieldClass}
            >
              <option value="">（选择访问凭证）</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.provider} · {credential.fingerprint}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <button
        type="button"
        disabled={!canSubmit}
        onClick={publishToStaff}
        className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] text-[var(--fg)] disabled:opacity-50"
      >
        {busy ? "发布中…" : "发布给员工"}
      </button>
      {error && <div className="text-[12px] text-[var(--danger)]">{error}</div>}
      {notice && <div className="text-[12px] text-[var(--fg)]">{notice}</div>}
    </div>
  );
}
