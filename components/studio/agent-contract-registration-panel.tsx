"use client";

/**
 * Agent Contract 登记面板（07 §4）。
 *
 * 表单固定三字段：protocol_type / protocol_contract_revision / contract_json；
 * 禁止 Agent Card URL、Git URL、source path、Runtime endpoint、Credential 字段。
 * 调用正式 POST /admin/api/v1/agent-registrations（client.agents.registerContract），
 * 成功后通过 onRegistered 回调刷新 Agent/Snapshot 列表。
 */
import { ControlPlaneRequestError, createControlPlaneClient } from "@/lib/control-plane-client";
import { useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

/** 07 §15：错误分类标签（不显示 raw 第三方 stack 或 secret）。 */
function classifyError(err: unknown): string {
  if (err instanceof ControlPlaneRequestError) {
    switch (err.code) {
      case "REQUEST_SCHEMA_INVALID":
        return "合同 schema 非法（未知键/URL/secret/员工身份字段一律拒绝）";
      case "IDEMPOTENCY_CONFLICT":
        return "同 Idempotency-Key 已用于不同请求体";
      case "BUSINESS_CONSTRAINT_VIOLATION":
        return "业务拒绝（service 首建 / retired / deleted）";
      case "ACTION_SCOPE_DENIED":
        return "无 agent.contract.register 操作权限";
      default:
        return `登记失败（${err.code ?? "未知错误"}）`;
    }
  }
  return "登记失败";
}

interface AgentContractRegistrationPanelProps {
  /** 登记成功后刷新 Agent/Snapshot（07 §4）。 */
  readonly onRegistered?: () => void;
}

export function AgentContractRegistrationPanel({
  onRegistered,
}: AgentContractRegistrationPanelProps) {
  const [protocolType, setProtocolType] = useState("a2a");
  const [protocolContractRevision, setProtocolContractRevision] = useState("");
  const [contractJson, setContractJson] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setSuccess(null);
    let contract: unknown;
    try {
      contract = JSON.parse(contractJson);
    } catch {
      setError("contract_json 不是合法 JSON");
      return;
    }
    setSubmitting(true);
    try {
      const result = await client.agents.registerContract(
        {
          protocol: {
            type: protocolType.trim(),
            contract_revision: protocolContractRevision.trim(),
          },
          contract,
        },
        // 每次提交独立 Idempotency-Key（正式端点强制要求）。
        { idempotencyKey: crypto.randomUUID() },
      );
      setSuccess(`已登记：${result.agent.display_name}（snapshot ${result.contract.snapshot_id}）`);
      setProtocolContractRevision("");
      setContractJson("");
      onRegistered?.();
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    protocolType.trim().length > 0 &&
    protocolContractRevision.trim().length > 0 &&
    contractJson.trim().length > 0 &&
    !submitting;

  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-[13px] font-medium text-[var(--fg)]">登记 Agent Contract</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-[12px] text-[var(--fg-muted)]">
          protocol_type
          <input
            value={protocolType}
            onChange={(e) => setProtocolType(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          />
        </label>
        <label className="text-[12px] text-[var(--fg-muted)]">
          protocol_contract_revision
          <input
            value={protocolContractRevision}
            onChange={(e) => setProtocolContractRevision(e.target.value)}
            placeholder="如 a2a@0.3.0"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
          />
        </label>
      </div>
      <label className="block text-[12px] text-[var(--fg-muted)]">
        contract_json（Public Agent Contract JSON）
        <textarea
          value={contractJson}
          onChange={(e) => setContractJson(e.target.value)}
          rows={8}
          spellCheck={false}
          aria-label="contract_json"
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 font-mono text-[12px] text-[var(--fg)]"
        />
      </label>
      {error && <div className="text-[12px] text-[var(--danger)]">{error}</div>}
      {success && <div className="text-[12px] text-[var(--fg)]">{success}</div>}
      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] text-[var(--fg)] disabled:opacity-50"
      >
        {submitting ? "登记中…" : "登记合同"}
      </button>
    </div>
  );
}
