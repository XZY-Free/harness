"use client";

/**
 * Runtime 治理控制面板（07 §10/§11）。
 *
 * 展示 Runtime / RuntimeRevision 权威字段（runtimeKind/runtimeEvidenceKind/protocol/
 * endpoint/identityMode/credentialRefId 引用/verificationState/measured capabilities/
 * revisionState），并按 runtimeEvidenceKind 区分发布门禁：
 * - external_endpoint：不要求 Artifact Attestation（不伪造），仍要求正式 Conformance evidence；
 * - hosted_artifact：Artifact / Attestation 门禁不变。
 * Publish / Withdraw 复用现有 Runtime API Client（Idempotency-Key / If-Match）。
 */
import {
  ControlPlaneRequestError,
  type RuntimeDTO,
  type RuntimeRevisionDTO,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { useCallback, useEffect, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

/** External 三态投影形状（02 §10；hosted 为 string[]）。 */
interface CapabilitiesProjection {
  declared?: Record<string, boolean>;
  measured?: { features?: Record<string, string> };
  effective?: Record<string, boolean>;
}

function classifyError(err: unknown): string {
  if (err instanceof ControlPlaneRequestError) {
    switch (err.code) {
      case "ETAG_MISMATCH":
        return "ETag 冲突（他人已修改，请刷新后重试）";
      case "BUSINESS_CONSTRAINT_VIOLATION":
        return "发布前置条件未满足（证据门禁）";
      case "ACTION_SCOPE_DENIED":
        return "无 runtime.publish 操作权限";
      default:
        return `操作失败（${err.code ?? "未知错误"}）`;
    }
  }
  return "操作失败";
}

function MeasuredMatrix({ revision }: { readonly revision: RuntimeRevisionDTO }) {
  const projection = revision.runtime_capabilities as CapabilitiesProjection | null;
  if (!projection || typeof projection !== "object" || !("measured" in projection)) {
    // hosted string[]：直接列出能力名。
    if (Array.isArray(projection)) {
      return (
        <div className="text-[12px] text-[var(--fg-muted)]">
          capabilities：<span className="font-mono">{(projection as string[]).join(", ")}</span>
        </div>
      );
    }
    return <div className="text-[12px] text-[var(--fg-muted)]">capabilities：（不可解析）</div>;
  }
  const features = projection.measured?.features ?? {};
  return (
    <ul className="text-[12px] text-[var(--fg-muted)]">
      {Object.entries(features).map(([key, value]) => (
        <li key={key}>
          <span className="font-mono">{key}</span>：{value}
        </li>
      ))}
    </ul>
  );
}

function RevisionRow({
  runtime,
  revision,
  canPublish,
  onDone,
}: {
  readonly runtime: RuntimeDTO;
  readonly revision: RuntimeRevisionDTO;
  readonly canPublish: boolean;
  readonly onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      await client.runtimes.publishRevision(
        revision.id,
        {
          expected_version_no: runtime.version_no,
          // 03 §4：external_endpoint 不得携带 Artifact Attestation（不伪造）。
          attestation_id:
            revision.runtime_evidence_kind === "hosted_artifact"
              ? (revision.attestation_ids[0] ?? null)
              : null,
          conformance_run_id: revision.conformance_run_id ?? "",
        },
        {
          idempotencyKey: crypto.randomUUID(),
          ifMatch: `runtime-revision-${revision.revision_no}`,
        },
      );
      onDone();
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
      onDone();
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1 border-t border-[var(--border)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 text-[12px] text-[var(--fg-muted)]">
        <span className="font-mono text-[var(--fg)]">Revision #{revision.revision_no}</span>
        <span>{revision.revision_state}</span>
        <span className="font-mono">{revision.protocol_type}</span>
        <span className="font-mono">{revision.runtime_evidence_kind}</span>
        <span>
          verification：
          <span className="font-mono">{revision.conformance_overall_result ?? "—"}</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 text-[12px] text-[var(--fg-muted)]">
        <span>
          endpoint：<span className="font-mono">{revision.endpoint_ref}</span>
        </span>
        <span>
          identityMode：<span className="font-mono">{revision.identity_mode}</span>
        </span>
        <span>
          credentialRef：<span className="font-mono">{revision.credential_ref_id ?? "—"}</span>
        </span>
        <span>
          runtimeTargetDigest：<span className="font-mono">{revision.runtime_target_digest}</span>
        </span>
      </div>
      <MeasuredMatrix revision={revision} />
      {canPublish && revision.revision_state === "draft" && (
        <button
          type="button"
          disabled={busy}
          onClick={publish}
          className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[12px] text-[var(--fg)] disabled:opacity-50"
        >
          发布 RuntimeRevision
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

export function RuntimeControlPanel({ canPublish }: { readonly canPublish: boolean }) {
  const [runtimes, setRuntimes] = useState<RuntimeDTO[] | null>(null);
  const [revisionsByRuntime, setRevisionsByRuntime] = useState<
    Record<string, RuntimeRevisionDTO[]>
  >({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await client.runtimes.list();
      setRuntimes(list.items);
      const entries = await Promise.all(
        list.items.map(async (runtime) => {
          const revisions = await client.runtimes.listRevisions(runtime.id);
          return [runtime.id, revisions.items] as const;
        }),
      );
      setRevisionsByRuntime(Object.fromEntries(entries));
    } catch (err) {
      setError(err instanceof ControlPlaneRequestError ? err.message : "Runtime 列表加载失败");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) {
    return <div className="mt-4 text-[13px] text-[var(--danger)]">{error}</div>;
  }
  if (runtimes === null) {
    return <div className="mt-4 text-[13px] text-[var(--fg-muted)]">正在加载…</div>;
  }
  if (runtimes.length === 0) {
    return <div className="mt-4 text-[13px] text-[var(--fg-muted)]">暂无 Runtime。</div>;
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
            <span className="text-[12px] text-[var(--fg-muted)]">{runtime.kind}</span>
            <span className="text-[12px] text-[var(--fg-muted)]">{runtime.lifecycle_state}</span>
          </div>
          {(revisionsByRuntime[runtime.id] ?? []).length === 0 ? (
            <div className="border-t border-[var(--border)] px-3 py-2 text-[12px] text-[var(--fg-muted)]">
              暂无 Revision。
            </div>
          ) : (
            (revisionsByRuntime[runtime.id] ?? []).map((revision) => (
              <RevisionRow
                key={revision.id}
                runtime={runtime}
                revision={revision}
                canPublish={canPublish}
                onDone={() => void reload()}
              />
            ))
          )}
        </div>
      ))}
    </div>
  );
}
