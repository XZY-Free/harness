"use client";

/**
 * External Runtime 登记面板（07 §7/§8/§9）。
 *
 * 字段：AgentContractSnapshot / Runtime endpoint / Authentication mode（只
 * none|bearer；bearer 只能选择已有 CredentialRef，禁止 Secret 文本框）/
 * Capability-driven Conformance probes（basic 永远显示；input_required/resume/cancel
 * 按 Snapshot interaction 动态显示，false 能力不显示也不发隐藏空字段）。
 * 调用正式 POST /admin/api/v1/agents/{id}/runtime-registrations。
 */
import {
  type AgentContractSnapshotDTO,
  ControlPlaneRequestError,
  type CredentialRefSummaryDTO,
  type RegisterAgentRuntimeConformance,
  type RegisterAgentRuntimeResponse,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { useCallback, useEffect, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

/** 实测能力名（后台英文枚举 → 管理员可见中文）。 */
const FEATURE_LABELS: Record<string, string> = {
  streaming_transport: "流式传输",
  incremental_content: "增量内容",
  input_required: "需要补充信息",
  resume: "会话恢复",
  cancel: "任务取消",
  durable_task_recovery: "持久任务恢复",
};

/** 实测结果值映射。 */
const MEASURED_VALUE_LABELS: Record<string, string> = {
  pass: "通过",
  fail: "未通过",
  not_applicable: "不适用",
  not_measured: "未测量",
};

/** 验证状态映射；未知值不回显后台英文内部枚举。 */
const VERIFICATION_STATE_LABELS: Record<string, string> = {
  verified: "已验证",
};

/** 未知值统一落到稳定中文兜底（能力名/实测值/状态）。 */
function featureLabel(value: string): string {
  return FEATURE_LABELS[value] ?? "其他能力";
}

function measuredLabel(value: string): string {
  return MEASURED_VALUE_LABELS[value] ?? "未知结果";
}

function verificationLabel(value: string): string {
  return VERIFICATION_STATE_LABELS[value] ?? "未知状态";
}

function classifyError(err: unknown): string {
  if (err instanceof ControlPlaneRequestError) {
    switch (err.code) {
      case "REQUEST_SCHEMA_INVALID":
        return "请求内容不符合规范（引用/地址/凭证/探测项不匹配）";
      case "RESOURCE_NOT_FOUND":
        return "智能体 / 合同快照 / 凭证引用不存在或无权访问";
      case "BUSINESS_CONSTRAINT_VIOLATION":
        return "运行验收失败（能力探测未通过）";
      case "IDEMPOTENCY_CONFLICT":
        return "重复提交冲突，请重试";
      case "ACTION_SCOPE_DENIED":
        return "没有登记运行服务的权限";
      default:
        return "登记失败，请稍后重试";
    }
  }
  return "登记失败";
}

interface AgentRuntimeRegistrationPanelProps {
  /** 登记成功回调：恰好一次，携带完整登记响应（含 runtime_revision_id，供同页发布交接）。 */
  readonly onRegistered?: (result: RegisterAgentRuntimeResponse) => void;
  /** 上游合同登记交接：智能体列表真实存在该智能体时自动选中。 */
  readonly preferredAgentId?: string | null;
  /** 上游合同登记交接：合同列表真实存在该快照时自动选中。 */
  readonly preferredSnapshotId?: string | null;
  /** 递增代次：上游变更后重新加载智能体与合同列表。 */
  readonly refreshToken?: number;
}

export function AgentRuntimeRegistrationPanel({
  onRegistered,
  preferredAgentId = null,
  preferredSnapshotId = null,
  refreshToken = 0,
}: AgentRuntimeRegistrationPanelProps) {
  const [agents, setAgents] = useState<Array<{ id: string; display_name: string }>>([]);
  const [agentId, setAgentId] = useState("");
  const [snapshots, setSnapshots] = useState<AgentContractSnapshotDTO[]>([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authMode, setAuthMode] = useState<"none" | "bearer">("none");
  const [credentialRefs, setCredentialRefs] = useState<CredentialRefSummaryDTO[]>([]);
  const [credentialRefId, setCredentialRefId] = useState("");
  const [basicInput, setBasicInput] = useState("");
  const [inputRequiredInput, setInputRequiredInput] = useState("");
  const [resumeStartInput, setResumeStartInput] = useState("");
  const [resumeInput, setResumeInput] = useState("");
  const [cancelInput, setCancelInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterAgentRuntimeResponse | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 是刷新代次信号（合同登记后重载智能体列表），非直接引用
  useEffect(() => {
    let active = true;
    setError(null);
    client.agents
      .list()
      .then((list) => {
        if (!active) return;
        const items = list.items.map((a) => ({ id: a.id, display_name: a.display_name }));
        setAgents(items);
        const ids = new Set(items.map((a) => a.id));
        // preferred agent 真实存在则优先交接；否则保留仍在真实列表中的人工选择；
        // 两者都不在列表（如已被删除）时清空，绝不保留失效 id。
        setAgentId((current) => {
          if (preferredAgentId && ids.has(preferredAgentId)) return preferredAgentId;
          return ids.has(current) ? current : "";
        });
      })
      .catch(() => {
        if (active) setError("智能体列表加载失败");
      });
    client.credentials
      .list()
      .then((list) => {
        if (active) setCredentialRefs(list.items);
      })
      .catch(() => {
        if (active) setError("凭证引用列表加载失败");
      });
    return () => {
      active = false;
    };
  }, [refreshToken, preferredAgentId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 是刷新代次信号（合同登记后重载合同列表），非直接引用
  useEffect(() => {
    setSnapshots([]);
    setSnapshotId("");
    setResult(null);
    if (!agentId) return;
    let active = true;
    client.agents
      .listContracts(agentId)
      .then((list) => {
        if (!active) return;
        setSnapshots(list.items);
        // 只有 preferred snapshot 真实存在时才选中，不生成假选项。
        if (
          preferredSnapshotId &&
          list.items.some((item) => item.snapshot_id === preferredSnapshotId)
        ) {
          setSnapshotId(preferredSnapshotId);
        }
      })
      .catch(() => {
        if (active) setError("合同快照列表加载失败");
      });
    return () => {
      active = false;
    };
  }, [agentId, refreshToken, preferredSnapshotId]);

  const snapshot = snapshots.find((item) => item.snapshot_id === snapshotId) ?? null;
  // 07 §8：probe 字段按 Snapshot interaction 动态显示；false 能力不显示。
  const showInputRequired = snapshot?.interaction.input_required === true;
  const showResume = snapshot?.interaction.resume === true;
  const showCancel = snapshot?.interaction.cancel === true;

  const reloadContracts = useCallback(() => {
    if (!agentId) return;
    client.agents
      .listContracts(agentId)
      .then((list) => setSnapshots(list.items))
      .catch(() => {});
  }, [agentId]);

  async function submit() {
    setError(null);
    setResult(null);
    if (!snapshot) {
      setError("必须先选择运行服务使用的合同");
      return;
    }
    const conformance: RegisterAgentRuntimeConformance = {
      basic: { input: basicInput.trim() },
    };
    if (showInputRequired) conformance.input_required = { input: inputRequiredInput.trim() };
    if (showResume) {
      conformance.resume = {
        start_input: resumeStartInput.trim(),
        resume_input: resumeInput.trim(),
      };
    }
    if (showCancel) conformance.cancel = { input: cancelInput.trim() };
    setBusy(true);
    try {
      const response = await client.agents.registerRuntime(
        agentId,
        {
          contract_snapshot_id: snapshotId,
          runtime_endpoint: endpoint.trim(),
          authentication:
            authMode === "bearer"
              ? { mode: "bearer", credential_ref_id: credentialRefId }
              : { mode: "none", credential_ref_id: null },
          conformance,
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      setResult(response);
      reloadContracts();
      onRegistered?.(response);
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    agentId &&
    snapshotId &&
    endpoint.trim().length > 0 &&
    basicInput.trim().length > 0 &&
    (!showInputRequired || inputRequiredInput.trim().length > 0) &&
    (!showResume || (resumeStartInput.trim().length > 0 && resumeInput.trim().length > 0)) &&
    (!showCancel || cancelInput.trim().length > 0) &&
    (authMode === "none" || credentialRefId.length > 0) &&
    !busy;

  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-[13px] font-medium text-[var(--fg)]">登记外部运行服务</div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-[12px] text-[var(--fg-muted)]">
          登记运行服务的智能体
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            aria-label="登记运行服务的智能体"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          >
            <option value="">（选择智能体）</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] text-[var(--fg-muted)]">
          运行服务使用的合同
          <select
            value={snapshotId}
            onChange={(e) => setSnapshotId(e.target.value)}
            aria-label="运行服务使用的合同"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          >
            <option value="">（选择合同）</option>
            {snapshots.map((item) => (
              <option key={item.snapshot_id} value={item.snapshot_id}>
                {item.snapshot_id}（{item.protocol_type}）
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block text-[12px] text-[var(--fg-muted)]">
        运行服务地址
        <input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://agent.example.com"
          aria-label="运行服务地址"
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
        />
      </label>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-[12px] text-[var(--fg-muted)]">
          身份验证方式
          <select
            value={authMode}
            onChange={(e) => setAuthMode(e.target.value as "none" | "bearer")}
            aria-label="身份验证方式"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          >
            <option value="none">无需认证</option>
            <option value="bearer">访问令牌</option>
          </select>
        </label>
        {authMode === "bearer" && (
          <label className="text-[12px] text-[var(--fg-muted)]">
            访问凭证（已有引用，禁止密钥输入）
            <select
              value={credentialRefId}
              onChange={(e) => setCredentialRefId(e.target.value)}
              aria-label="访问凭证"
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
            >
              <option value="">（选择访问凭证）</option>
              {credentialRefs.map((ref) => (
                <option key={ref.id} value={ref.id}>
                  {ref.id}（{ref.provider}）
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-[12px] font-medium text-[var(--fg)]">
          实际能力验收（探测项按合同能力动态显示）
        </div>
        <label className="block text-[12px] text-[var(--fg-muted)]">
          基础对话输入（始终显示）
          <input
            value={basicInput}
            onChange={(e) => setBasicInput(e.target.value)}
            aria-label="基础对话输入"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          />
        </label>
        {showInputRequired && (
          <label className="block text-[12px] text-[var(--fg-muted)]">
            需要补充信息时的输入
            <input
              value={inputRequiredInput}
              onChange={(e) => setInputRequiredInput(e.target.value)}
              aria-label="需要补充信息时的输入"
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
            />
          </label>
        )}
        {showResume && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-[12px] text-[var(--fg-muted)]">
              恢复会话的起始输入
              <input
                value={resumeStartInput}
                onChange={(e) => setResumeStartInput(e.target.value)}
                aria-label="恢复会话的起始输入"
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
              />
            </label>
            <label className="text-[12px] text-[var(--fg-muted)]">
              恢复会话的继续输入
              <input
                value={resumeInput}
                onChange={(e) => setResumeInput(e.target.value)}
                aria-label="恢复会话的继续输入"
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
              />
            </label>
          </div>
        )}
        {showCancel && (
          <label className="block text-[12px] text-[var(--fg-muted)]">
            取消任务的输入
            <input
              value={cancelInput}
              onChange={(e) => setCancelInput(e.target.value)}
              aria-label="取消任务的输入"
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
            />
          </label>
        )}
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] text-[var(--fg)] disabled:opacity-50"
      >
        {busy ? "验收中…" : "登记运行服务（执行实际能力验收）"}
      </button>

      {error && <div className="text-[12px] text-[var(--danger)]">{error}</div>}

      {result && (
        <div className="space-y-2 rounded border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <div className="text-[12px] font-medium text-[var(--fg)]">登记运行服务结果</div>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-2">
            <div className="text-[var(--fg-muted)]">
              运行服务：<span className="font-mono">{result.runtime_id}</span>
            </div>
            <div className="text-[var(--fg-muted)]">
              运行服务版本：<span className="font-mono">{result.runtime_revision_id}</span>
            </div>
            <div className="text-[var(--fg-muted)]">
              服务地址：<span className="font-mono">{result.runtime_endpoint}</span>
            </div>
            <div className="text-[var(--fg-muted)]">
              协议：<span className="font-mono">{result.protocol.type}</span>
            </div>
            <div className="text-[var(--fg-muted)]">
              验证状态：{verificationLabel(result.verification_state)}
            </div>
            <div className="text-[var(--fg-muted)]">
              验证时间：<span className="font-mono">{result.verified_at}</span>
            </div>
            <div className="text-[var(--fg-muted)]">
              运行目标摘要：<span className="font-mono">{result.runtime_target_digest}</span>
            </div>
            <div className="text-[var(--fg-muted)]">
              证据摘要：<span className="font-mono">{result.evidence_digest}</span>
            </div>
          </dl>
          <div className="text-[12px] font-medium text-[var(--fg)]">实测能力矩阵</div>
          <ul className="text-[12px] text-[var(--fg-muted)]">
            {Object.entries(result.measured.features).map(([key, value]) => (
              <li key={key}>
                {featureLabel(key)}：{measuredLabel(String(value))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
