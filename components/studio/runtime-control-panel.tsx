"use client";

/**
 * Runtime 治理控制面板（07 §10/§11）。
 *
 * 展示 Runtime / RuntimeRevision 权威字段（runtimeKind/runtimeEvidenceKind/protocol/
 * endpoint/identityMode/credentialRefId 引用/verificationState/measured capabilities/
 * revisionState），并按 runtimeEvidenceKind 区分发布门禁：
 * - external_endpoint：不要求 Artifact Attestation（不伪造），但必须已有真实
 *   Conformance Run（conformance_run_id 非空）才提供发布入口，不发送 attestation；
 * - hosted_artifact：Artifact / Attestation 门禁不变。
 * Publish / Withdraw 复用现有 Runtime API Client（Idempotency-Key / If-Match）。
 *
 * 支持同页发布交接：refreshToken 变化重新拉取；preferredRuntimeRevisionId 只对
 * 真实 GET 返回中的版本显示“本次登记”聚焦标记，绝不凭 id 造假行。
 */
import {
  ControlPlaneRequestError,
  type PublishRuntimeRevisionResponse,
  type RuntimeDTO,
  type RuntimeRevisionDTO,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { useCallback, useEffect, useRef, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

/** External 三态投影形状（02 §10；hosted 为 string[]）。 */
interface CapabilitiesProjection {
  declared?: Record<string, boolean>;
  measured?: { features?: Record<string, string> };
  effective?: Record<string, boolean>;
}

const REVISION_STATE_LABELS: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  withdrawn: "已撤回",
};

const RUNTIME_KIND_LABELS: Record<string, string> = {
  external: "外部服务",
  hosted: "托管服务",
};

const LIFECYCLE_STATE_LABELS: Record<string, string> = {
  draft: "草稿",
  enabled: "已启用",
  disabled: "已停用",
  retired: "已退役",
};

const EVIDENCE_KIND_LABELS: Record<string, string> = {
  external_endpoint: "外部服务",
  hosted_artifact: "托管工件",
};

const VERIFICATION_LABELS: Record<string, string> = {
  passed: "验收通过",
  failed: "验收失败",
  error: "验收出错",
  cancelled: "已取消",
};

const IDENTITY_MODE_LABELS: Record<string, string> = {
  none: "无需认证",
  bearer: "访问令牌",
};

const FEATURE_LABELS: Record<string, string> = {
  streaming_transport: "流式传输",
  incremental_content: "增量内容",
  input_required: "需要补充信息",
  resume: "会话恢复",
  cancel: "任务取消",
  durable_task_recovery: "持久任务恢复",
};

const MEASURED_VALUE_LABELS: Record<string, string> = {
  pass: "通过",
  fail: "未通过",
  not_applicable: "不适用",
  not_measured: "未测量",
};

/** 未知值不得原样回显后台英文内部枚举，统一落到稳定中文兜底。 */
function label(
  map: Record<string, string>,
  value: string | null | undefined,
  fallback: string,
): string {
  if (value == null) return "—";
  return map[value] ?? fallback;
}

function classifyError(err: unknown): string {
  if (err instanceof ControlPlaneRequestError) {
    switch (err.code) {
      case "ETAG_MISMATCH":
        return "内容已被其他人修改，请刷新后重试";
      case "BUSINESS_CONSTRAINT_VIOLATION":
        return "缺少发布所需的验收结果或工件证明";
      case "ACTION_SCOPE_DENIED":
        return "无发布运行服务版本权限";
      default:
        return "操作失败，请稍后重试";
    }
  }
  return "操作失败";
}

function MeasuredMatrix({ revision }: { readonly revision: RuntimeRevisionDTO }) {
  const projection = revision.runtime_capabilities as CapabilitiesProjection | null;
  if (!projection || typeof projection !== "object" || !("measured" in projection)) {
    // hosted string[]：逐项映射为管理员可见中文，未知项不回显后台英文枚举。
    if (Array.isArray(projection)) {
      return (
        <div className="text-[12px] text-[var(--fg-muted)]">
          能力：
          {(projection as string[]).map((key, index) => (
            <span key={key}>
              {index > 0 && "、"}
              {label(FEATURE_LABELS, key, "其他能力")}
            </span>
          ))}
        </div>
      );
    }
    return <div className="text-[12px] text-[var(--fg-muted)]">能力：（不可解析）</div>;
  }
  const features = projection.measured?.features ?? {};
  return (
    <ul className="text-[12px] text-[var(--fg-muted)]">
      {Object.entries(features).map(([key, value]) => (
        <li key={key}>
          {label(FEATURE_LABELS, key, "其他能力")}：
          {label(MEASURED_VALUE_LABELS, value, "未知结果")}
        </li>
      ))}
    </ul>
  );
}

function RevisionRow({
  runtime,
  revision,
  canPublish,
  focused,
  onDone,
}: {
  readonly runtime: RuntimeDTO;
  readonly revision: RuntimeRevisionDTO;
  readonly canPublish: boolean;
  readonly focused: boolean;
  readonly onDone: (result: PublishRuntimeRevisionResponse | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // external_endpoint：发布门禁只认真实 Admin GET 投影里的 Candidate Conformance
  // （latest_valid_conformance_run_id + passed，02 §6）；failed/error/cancelled/null 均不放行。
  const canPublishRevision =
    canPublish &&
    revision.revision_state === "draft" &&
    (revision.runtime_evidence_kind === "external_endpoint"
      ? Boolean(revision.latest_valid_conformance_run_id) &&
        revision.latest_valid_conformance_overall_result === "passed"
      : true);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const result = await client.runtimes.publishRevision(
        revision.id,
        {
          expected_version_no: runtime.version_no,
          // 03 §4：external_endpoint 不得携带 Artifact Attestation（不伪造）。
          attestation_id:
            revision.runtime_evidence_kind === "hosted_artifact"
              ? (revision.attestation_ids[0] ?? null)
              : null,
          // Publish request 携带精确 evidence ID：Candidate Conformance（02 §6）。
          conformance_run_id: revision.latest_valid_conformance_run_id ?? "",
        },
        {
          idempotencyKey: crypto.randomUUID(),
          ifMatch: `runtime-revision-${revision.revision_no}`,
        },
      );
      onDone(result);
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await client.runtimes.withdrawRevision(
        revision.id,
        { reason_code: "studio_withdraw", reason: "Studio 撤回（07 §11）" },
        {
          idempotencyKey: crypto.randomUUID(),
          ifMatch: `runtime-revision-${revision.revision_no}`,
        },
      );
      onDone(null);
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1 border-t border-[var(--border)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 text-[12px] text-[var(--fg-muted)]">
        <span className="font-mono text-[var(--fg)]">第 {revision.revision_no} 版</span>
        <span>{label(REVISION_STATE_LABELS, revision.revision_state, "未知状态")}</span>
        <span className="font-mono">{revision.protocol_type}</span>
        <span>{label(EVIDENCE_KIND_LABELS, revision.runtime_evidence_kind, "未知状态")}</span>
        {revision.revision_state === "published" ? (
          // 已发布版本：管理员调试信息区分「已发布绑定验收」（02 §8）。
          <span>已发布绑定验收：{revision.publication_conformance_run_id ? "已绑定" : "未绑定"}</span>
        ) : (
          <span>
            本次可发布验收：
            {label(
              VERIFICATION_LABELS,
              revision.latest_valid_conformance_overall_result,
              "未知状态",
            )}
          </span>
        )}
        {focused && (
          <span className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[12px] text-[var(--fg)]">
            本次登记
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 text-[12px] text-[var(--fg-muted)]">
        <span>
          服务地址：<span className="font-mono">{revision.endpoint_ref}</span>
        </span>
        <span>
          身份验证：
          <span>{label(IDENTITY_MODE_LABELS, revision.identity_mode, "未知方式")}</span>
        </span>
        <span>
          访问凭证：<span>{revision.credential_ref_id ? "已配置" : "未配置"}</span>
        </span>
        <span>
          运行目标摘要：<span className="font-mono">{revision.runtime_target_digest}</span>
        </span>
        {revision.attestation_ids.length > 0 && (
          <span>
            工件证明：<span className="font-mono">{revision.attestation_ids.join(", ")}</span>
          </span>
        )}
      </div>
      <MeasuredMatrix revision={revision} />
      {canPublishRevision && (
        <button
          type="button"
          disabled={busy}
          onClick={publish}
          className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[12px] text-[var(--fg)] disabled:opacity-50"
        >
          发布运行服务版本
        </button>
      )}
      {canPublish && revision.revision_state === "published" && (
        <button
          type="button"
          disabled={busy}
          onClick={withdraw}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-[12px] text-[var(--fg)] disabled:opacity-50"
        >
          撤回
        </button>
      )}
      {error && <div className="text-[12px] text-[var(--danger)]">{error}</div>}
    </div>
  );
}

interface RuntimeControlPanelProps {
  readonly canPublish: boolean;
  /** 递增代次：上游（如同页 Runtime 登记）成功后要求重新拉取。 */
  readonly refreshToken?: number;
  /** 上游交接：真实 GET 返回包含该 revision 时显示“本次登记”聚焦标记。 */
  readonly preferredRuntimeRevisionId?: string | null;
  /** 发布成功回调（完整 PublishRuntimeRevisionResponse），发布动作仍由用户点击触发。 */
  readonly onPublished?: (result: PublishRuntimeRevisionResponse) => void;
}

export function RuntimeControlPanel({
  canPublish,
  refreshToken = 0,
  preferredRuntimeRevisionId = null,
  onPublished,
}: RuntimeControlPanelProps) {
  const [runtimes, setRuntimes] = useState<RuntimeDTO[] | null>(null);
  const [revisionsByRuntime, setRevisionsByRuntime] = useState<
    Record<string, RuntimeRevisionDTO[]>
  >({});
  const [error, setError] = useState<string | null>(null);
  // 递增代次：只有最新一次刷新的响应可以落地，过期响应不得覆盖新结果。
  const reloadGeneration = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    setError(null);
    try {
      const list = await client.runtimes.list();
      const entries = await Promise.all(
        list.items.map(async (runtime) => {
          const revisions = await client.runtimes.listRevisions(runtime.id);
          return [runtime.id, revisions.items] as const;
        }),
      );
      if (reloadGeneration.current !== generation) return;
      setRuntimes(list.items);
      setRevisionsByRuntime(Object.fromEntries(entries));
    } catch {
      if (reloadGeneration.current !== generation) return;
      // 不回显后端原始 message（可能含内部 endpoint / 令牌等诊断细节），只显示稳定中文。
      setError("运行服务列表加载失败");
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 是刷新代次信号（同页 Runtime 登记成功后重拉），非直接引用
  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  if (error) {
    return <div className="mt-4 text-[13px] text-[var(--danger)]">{error}</div>;
  }
  if (runtimes === null) {
    return <div className="mt-4 text-[13px] text-[var(--fg-muted)]">正在加载…</div>;
  }
  if (runtimes.length === 0) {
    return <div className="mt-4 text-[13px] text-[var(--fg-muted)]">暂无运行服务。</div>;
  }

  return (
    <div className="mt-4 space-y-4">
      {runtimes.map((runtime) => (
        <div
          key={runtime.id}
          className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]"
        >
          <div className="flex flex-wrap items-center gap-x-3 px-3 py-2 text-[13px]">
            <span className="text-[var(--fg)]">{runtime.display_name}</span>
            <span className="font-mono text-[12px] text-[var(--fg-muted)]">
              {runtime.runtime_key}
            </span>
            <span className="text-[12px] text-[var(--fg-muted)]">
              {label(RUNTIME_KIND_LABELS, runtime.kind, "未知状态")}
            </span>
            <span className="text-[12px] text-[var(--fg-muted)]">
              {label(LIFECYCLE_STATE_LABELS, runtime.lifecycle_state, "未知状态")}
            </span>
          </div>
          {(revisionsByRuntime[runtime.id] ?? []).length === 0 ? (
            <div className="border-t border-[var(--border)] px-3 py-2 text-[12px] text-[var(--fg-muted)]">
              暂无版本。
            </div>
          ) : (
            (revisionsByRuntime[runtime.id] ?? []).map((revision) => (
              <RevisionRow
                key={revision.id}
                runtime={runtime}
                revision={revision}
                canPublish={canPublish}
                focused={revision.id === preferredRuntimeRevisionId}
                onDone={(result) => {
                  if (result) onPublished?.(result);
                  void reload();
                }}
              />
            ))
          )}
        </div>
      ))}
    </div>
  );
}
