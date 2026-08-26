"use client";

/**
 * Agent Contract 登记面板（07 §4）— agent-contract.json 文件导入形态。
 *
 * 唯一入口是本地 JSON 文件：文件只在组件内存中读取解析，不上传文件本体，
 * 不保存 filename/路径/原始文本，不使用任何浏览器存储。
 * 前端只做轻量结构校验与中文预览；完整严格 schema 由后端权威验证。
 * wire 固定 { protocol:{type:"a2a",contract_revision:"a2a@0.3.0"}, contract }，
 * 禁止 Agent Card URL、Git URL、source path、Runtime endpoint、Credential 字段。
 */
import {
  ControlPlaneRequestError,
  type RegisterAgentContractResponse,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { useCallback, useRef, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

/** 上传体积上限：1 MiB（超大文件直接前端拒绝，不读取内容）。 */
const MAX_CONTRACT_BYTES = 1024 * 1024;

/** 07 §15：错误分类标签（中文，不显示 raw 第三方 stack、message 或内部 code）。 */
function classifyError(err: unknown): string {
  if (err instanceof ControlPlaneRequestError) {
    switch (err.code) {
      case "REQUEST_SCHEMA_INVALID":
        return "合同内容不符合规范";
      case "IDEMPOTENCY_CONFLICT":
        return "重复提交冲突，请重试";
      case "BUSINESS_CONSTRAINT_VIOLATION":
        return "业务规则拒绝（智能体状态或首建限制）";
      case "ACTION_SCOPE_DENIED":
        return "没有登记合同的权限";
      default:
        return "登记失败，请稍后重试";
    }
  }
  return "登记失败，请稍后重试";
}

/** 合同预览：仅暴露中文展示所需的最小投影。 */
interface ContractPreview {
  readonly contract: Record<string, unknown>;
  readonly name: string;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly contractVersion: string;
  readonly capabilityCount: number;
  readonly interactionSummary: string;
}

const INTERACTION_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["streaming_transport", "流式传输"],
  ["incremental_content", "增量内容"],
  ["input_required", "需要输入"],
  ["resume", "可恢复"],
  ["cancel", "可取消"],
  ["durable_task_recovery", "任务恢复"],
];

/** 提取本地化名称：优先 zh-CN，其次 en，最后退回字符串。 */
function pickLocalizedName(name: unknown): string | null {
  if (typeof name === "string" && name.trim().length > 0) return name.trim();
  if (name !== null && typeof name === "object") {
    const record = name as Record<string, unknown>;
    for (const locale of ["zh-CN", "en"]) {
      const candidate = record[locale];
      if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
    }
  }
  return null;
}

/** 轻量结构与关键预览字段校验；不做完整 schema 判定（后端权威）。 */
function buildPreview(contract: unknown): ContractPreview | null {
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) return null;
  const root = contract as Record<string, unknown>;

  const contractVersion = root.contract_version;
  const agent = root.agent;
  const capabilities = root.capabilities;
  const interaction = root.interaction;
  if (typeof contractVersion !== "string" || contractVersion.trim().length === 0) return null;
  if (agent === null || typeof agent !== "object" || Array.isArray(agent)) return null;
  const agentRecord = agent as Record<string, unknown>;
  const agentId = agentRecord.id;
  const name = pickLocalizedName(agentRecord.name);
  const agentVersion = agentRecord.version;
  if (typeof agentId !== "string" || agentId.trim().length === 0) return null;
  if (name === null) return null;
  if (typeof agentVersion !== "string" || agentVersion.trim().length === 0) return null;
  if (!Array.isArray(capabilities)) return null;
  if (interaction === null || typeof interaction !== "object" || Array.isArray(interaction)) {
    return null;
  }
  const interactionRecord = interaction as Record<string, unknown>;

  const supported = INTERACTION_LABELS.filter(([key]) => interactionRecord[key] === true).map(
    ([, label]) => label,
  );

  return {
    contract: root,
    name,
    agentId: agentId.trim(),
    agentVersion: agentVersion.trim(),
    contractVersion: contractVersion.trim(),
    capabilityCount: capabilities.length,
    interactionSummary: supported.length > 0 ? supported.join("、") : "基础请求-响应",
  };
}

/** File.text 与 FileReader 兼容读取（仅内存，不持久化）。 */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsText(file);
  });
}

interface AgentContractRegistrationPanelProps {
  /** 登记成功后以完整响应回调（刷新 Agent/Snapshot 列表，07 §4）。 */
  readonly onRegistered?: (result: RegisterAgentContractResponse) => void;
}

export function AgentContractRegistrationPanel({
  onRegistered,
}: AgentContractRegistrationPanelProps) {
  const [preview, setPreview] = useState<ContractPreview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [successName, setSuccessName] = useState<string | null>(null);
  // 成功后递增 key 重新挂载 file input，可靠清空浏览器已选文件。
  const [fileInputKey, setFileInputKey] = useState(0);
  // 连续选择文件时丢弃过期的异步读取结果。
  const readToken = useRef(0);

  const handleFile = useCallback(async (file: File | undefined) => {
    setError(null);
    setSuccess(null);
    setSuccessName(null);
    setPreview(null);
    // 在任何提前返回之前先占用读取令牌：旧文件的异步结果一律作废。
    const token = ++readToken.current;
    if (!file) return;

    // fail-closed：文件名必须以 .json 结尾，MIME 只允许空或 JSON 类型；
    // MIME 绝不能放行非 .json 文件名。
    const hasJsonExtension = /\.json$/i.test(file.name);
    const jsonMime =
      file.type === "" || file.type === "application/json" || file.type === "text/json";
    if (!hasJsonExtension || !jsonMime) {
      setError("不支持的文件类型：请选择 .json 合同文件");
      return;
    }
    if (file.size > MAX_CONTRACT_BYTES) {
      setError("合同文件超过 1 MiB 大小限制");
      return;
    }

    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      if (token === readToken.current) setError("合同文件读取失败");
      return;
    }
    if (token !== readToken.current) return;

    if (text.trim().length === 0) {
      setError("合同文件为空");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("合同内容不符合 JSON 格式");
      return;
    }
    const nextPreview = buildPreview(parsed);
    if (!nextPreview) {
      setError("合同内容不符合规范：缺少必要字段或结构不正确");
      return;
    }
    setPreview(nextPreview);
  }, []);

  async function submit() {
    if (!preview) return;
    setError(null);
    setSuccess(null);
    setSuccessName(null);
    setSubmitting(true);
    try {
      const result = await client.agents.registerContract(
        {
          // operator runbook：协议固定 A2A 0.3.0，不由界面编辑。
          protocol: { type: "a2a", contract_revision: "a2a@0.3.0" },
          contract: preview.contract,
        },
        // 每次提交独立 Idempotency-Key（正式端点强制要求）。
        { idempotencyKey: crypto.randomUUID() },
      );
      setSuccess("已登记");
      setSuccessName(result.agent.display_name);
      setPreview(null);
      setFileInputKey((key) => key + 1);
      onRegistered?.(result);
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting;

  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-[13px] font-medium text-[var(--fg)]">登记智能体合同</div>
      <label className="block text-[12px] text-[var(--fg-muted)]">
        选择智能体合同文件
        <input
          key={fileInputKey}
          type="file"
          accept=".json,application/json"
          aria-label="选择智能体合同文件"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            void handleFile(file);
          }}
          className="mt-1 block w-full max-w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)] file:mr-2 file:rounded file:border-0 file:bg-transparent file:text-[12px] file:text-[var(--fg-muted)]"
        />
      </label>
      {preview && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 rounded border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[12px] sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-[var(--fg-muted)]">智能体名称</dt>
            <dd className="truncate text-[var(--fg)]">{preview.name}</dd>
          </div>
          <div>
            <dt className="text-[var(--fg-muted)]">稳定标识</dt>
            <dd className="truncate text-[var(--fg)]">{preview.agentId}</dd>
          </div>
          <div>
            <dt className="text-[var(--fg-muted)]">智能体版本</dt>
            <dd className="text-[var(--fg)]">{preview.agentVersion}</dd>
          </div>
          <div>
            <dt className="text-[var(--fg-muted)]">合同版本</dt>
            <dd className="text-[var(--fg)]">{preview.contractVersion}</dd>
          </div>
          <div>
            <dt className="text-[var(--fg-muted)]">能力数量</dt>
            <dd className="text-[var(--fg)]">{preview.capabilityCount} 项</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-[var(--fg-muted)]">交互能力</dt>
            <dd className="text-[var(--fg)]">{preview.interactionSummary}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-[var(--fg-muted)]">通信协议</dt>
            <dd className="text-[var(--fg)]">A2A 0.3.0</dd>
          </div>
        </dl>
      )}
      {error && (
        <div className="text-[12px] text-[var(--danger)]" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="text-[12px] text-[var(--fg)]">
          {success}：<span>{successName}</span>
        </div>
      )}
      <button
        type="button"
        disabled={!preview || busy}
        onClick={submit}
        className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] text-[var(--fg)] disabled:opacity-50"
      >
        {busy ? "登记中…" : "登记合同"}
      </button>
    </div>
  );
}
