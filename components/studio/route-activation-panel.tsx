"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AgentDTO,
  type AgentRevisionSummaryDTO,
  ControlPlaneRequestError,
  type CredentialRefSummaryDTO,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { CheckCircle2, LoaderCircle, Send, ShieldAlert } from "lucide-react";
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

function credentialLabel(credential: CredentialRefSummaryDTO): string {
  const fingerprint = credential.fingerprint.split(":").at(-1) ?? credential.fingerprint;
  const kind = credential.provider === "a2a-bearer" ? "智能体令牌" : "访问令牌";
  return `${kind} · ${fingerprint.slice(-8)}`;
}

interface RouteActivationPanelProps {
  readonly canManage: boolean;
  /** 上游真实 AgentRevision 发布成功后递增，要求重新读取权威资产。 */
  readonly refreshToken?: number;
  /** 只有新 GET 的 published AgentRevision 中存在该 id 才会选中。 */
  readonly preferredAgentRevisionId?: string | null;
}

/**
 * 「发布给员工」面板 — 为黑盒 Agent 冻结 A2A Route endpoint Authority。
 *
 * AgentRevision 只负责合同；实际调用位置、身份方式、凭证引用和网络区域只写入
 * targetKind=agent 的 RouteRevision。此面板不读取、不选择也不提交 RuntimeRevision。
 */
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
  const selectedCredential = useMemo(
    () => credentials.find((credential) => credential.id === credentialRefId) ?? null,
    [credentials, credentialRefId],
  );

  function agentRevisionLabel(revision: AgentRevisionSummaryDTO): string {
    const agentName = agentsById.get(revision.agent_id)?.display_name ?? "未知智能体";
    return `${agentName} · 第${revision.revision_no}版`;
  }

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
      <div
        role="note"
        className="mt-4 flex items-start gap-3 rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground shadow-xs"
      >
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        当前账号没有发布智能体的权限。
      </div>
    );
  }

  return (
    <section
      aria-label="发布给员工"
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs"
    >
      <div className="flex flex-col gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground">发布给员工</h2>
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
            设置员工新建会话时使用的智能体与访问方式。
          </p>
        </div>
        <span className="w-fit shrink-0 rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground">
          仅影响新会话
        </span>
      </div>

      <div className="space-y-5 px-5 py-5">
        {loading && (
          <output className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            正在加载可发布版本与访问凭证…
          </output>
        )}

        {!loading && agentRevisions.length === 0 && !error && (
          <output className="block rounded-xl bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
            暂无可发布的智能体版本。
          </output>
        )}

        <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="staff-agent-revision">智能体版本</Label>
            <Select
              value={agentRevisionId}
              onValueChange={(value) => applyAgentRevisionId(value ?? "")}
              disabled={loading || agentRevisions.length === 0}
            >
              <SelectTrigger id="staff-agent-revision" aria-label="智能体版本" className="w-full">
                <SelectValue placeholder="选择智能体版本">
                  {selectedAgentRevision ? agentRevisionLabel(selectedAgentRevision) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                {agentRevisions.map((revision) => (
                  <SelectItem key={revision.id} value={revision.id}>
                    {agentRevisionLabel(revision)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="staff-endpoint">调用地址</Label>
            <Input
              id="staff-endpoint"
              name="staffEndpoint"
              type="url"
              value={endpointRef}
              onChange={(event) => setEndpointRef(event.target.value)}
              aria-label="调用地址"
              placeholder="输入 HTTPS 调用地址…"
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="staff-network-zone">网络区域</Label>
            <Input
              id="staff-network-zone"
              name="staffNetworkZone"
              value={networkZone}
              onChange={(event) => setNetworkZone(event.target.value)}
              aria-label="网络区域"
              placeholder="例如：公网区域…"
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="staff-identity-mode">认证方式</Label>
            <Select
              value={identityMode}
              onValueChange={(value) => changeIdentityMode(value as "none" | "bearer")}
            >
              <SelectTrigger id="staff-identity-mode" aria-label="认证方式" className="w-full">
                <SelectValue>{identityMode === "none" ? "无需认证" : "令牌认证"}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="none">无需认证</SelectItem>
                <SelectItem value="bearer">令牌认证</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {identityMode === "bearer" && (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="staff-credential">访问凭证</Label>
              <Select
                value={credentialRefId}
                onValueChange={(value) => setCredentialRefId(value ?? "")}
                disabled={loading || credentials.length === 0}
              >
                <SelectTrigger id="staff-credential" aria-label="访问凭证" className="w-full">
                  <SelectValue placeholder="选择已配置的访问凭证">
                    {selectedCredential ? credentialLabel(selectedCredential) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start">
                  {credentials.map((credential) => (
                    <SelectItem key={credential.id} value={credential.id}>
                      {credentialLabel(credential)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {credentials.length === 0 && !loading && (
                <p className="text-xs text-muted-foreground">暂无可用的访问凭证。</p>
              )}
            </div>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        {notice && (
          <output className="flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            {notice}
          </output>
        )}
      </div>

      <div className="flex justify-end border-t border-border bg-muted/30 px-5 py-4">
        <Button type="button" disabled={!canSubmit} onClick={publishToStaff}>
          {busy ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Send aria-hidden="true" />
          )}
          {busy ? "发布中…" : "发布给员工"}
        </Button>
      </div>
    </section>
  );
}
