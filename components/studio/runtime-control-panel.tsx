"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
/**
 * Runtime 治理控制面板。
 *
 * 列表只展示权威 GET 返回的 Runtime / RuntimeRevision，发布门禁始终由真实候选
 * 验收结果驱动：external_endpoint 不伪造工件证明；hosted_artifact 必须带已有
 * 工件证明；bearer 必须引用已有访问凭证。Publish / Withdraw 继续携带
 * Idempotency-Key、If-Match 和 Runtime 版本号。
 *
 * refreshToken 变化会重新读取；generation 只允许最新请求落地，过期响应不得覆盖。
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ControlPlaneRequestError,
  type PublishRuntimeRevisionResponse,
  type RuntimeDTO,
  type RuntimeRevisionDTO,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

/** External 三态投影形状（hosted 为 string[]）。 */
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
  external_endpoint: "外部接入",
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

const PROTOCOL_LABELS: Record<string, string> = {
  a2a: "智能体通信",
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

interface PublicationGate {
  readonly ready: boolean;
  readonly message: string;
}

/** UI 门禁仅使用 Admin GET 权威投影；服务端仍会再次校验所有证据。 */
function publicationGate(revision: RuntimeRevisionDTO): PublicationGate {
  if (revision.revision_state !== "draft") {
    return { ready: false, message: "当前版本不可发布" };
  }
  if (
    !revision.latest_valid_conformance_run_id ||
    revision.latest_valid_conformance_overall_result !== "passed"
  ) {
    return { ready: false, message: "缺少通过的验收" };
  }
  if (revision.identity_mode === "bearer" && !revision.credential_ref_id) {
    return { ready: false, message: "缺少访问凭证" };
  }
  if (
    revision.runtime_evidence_kind === "hosted_artifact" &&
    revision.attestation_ids.length === 0
  ) {
    return { ready: false, message: "缺少工件证明" };
  }
  return { ready: true, message: "发布条件已满足" };
}

function revisionBadgeClass(state: RuntimeRevisionDTO["revision_state"]): string {
  if (state === "published") {
    return "border-success/20 bg-success/10 text-success";
  }
  if (state === "withdrawn") return "border-destructive/20 bg-destructive/10 text-destructive";
  return "border-border bg-muted text-muted-foreground";
}

function MeasuredMatrix({ revision }: { readonly revision: RuntimeRevisionDTO }) {
  const projection = revision.runtime_capabilities as CapabilitiesProjection | string[] | null;
  if (Array.isArray(projection)) {
    if (projection.length === 0) {
      return <p className="text-xs text-muted-foreground">未提供能力信息</p>;
    }
    return (
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">运行能力</p>
        <ul className="flex flex-wrap gap-1.5">
          {projection.map((key) => (
            <li key={key}>
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {label(FEATURE_LABELS, key, "其他能力")}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const features = projection?.measured?.features;
  if (!features || Object.keys(features).length === 0) {
    return <p className="text-xs text-muted-foreground">未提供能力验收结果</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-foreground">能力验收</p>
      <ul className="flex flex-wrap gap-1.5">
        {Object.entries(features).map(([key, value]) => (
          <li key={key}>
            <Badge
              variant="outline"
              className={cn(
                "gap-1 font-normal",
                value === "pass"
                  ? "border-success/20 bg-success/10 text-success"
                  : "text-muted-foreground",
              )}
            >
              {value === "pass" && <CheckCircle2 aria-hidden="true" />}
              {label(FEATURE_LABELS, key, "其他能力")} ·
              {label(MEASURED_VALUE_LABELS, value, "未知结果")}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
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
  readonly onDone: (
    result: PublishRuntimeRevisionResponse | null,
    action: "publish" | "withdraw",
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [withdrawConfirmOpen, setWithdrawConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = publicationGate(revision);
  const canPublishRevision = canPublish && gate.ready;

  async function publish() {
    if (!canPublishRevision) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.runtimes.publishRevision(
        revision.id,
        {
          expected_version_no: runtime.version_no,
          // external_endpoint 不携带 Artifact Attestation；hosted 只提交权威投影里的证明。
          attestation_id:
            revision.runtime_evidence_kind === "hosted_artifact"
              ? (revision.attestation_ids[0] ?? null)
              : null,
          // 发布请求携带精确 Candidate Conformance ID。
          conformance_run_id: revision.latest_valid_conformance_run_id ?? "",
        },
        {
          idempotencyKey: crypto.randomUUID(),
          ifMatch: `runtime-revision-${revision.revision_no}`,
        },
      );
      await onDone(result, "publish");
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
        { reason_code: "studio_withdraw", reason: "Studio 撤回" },
        {
          idempotencyKey: crypto.randomUUID(),
          ifMatch: `runtime-revision-${revision.revision_no}`,
        },
      );
      await onDone(null, "withdraw");
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={cn(
        "space-y-4 border-t border-border px-4 py-4 first:border-t-0 sm:px-5",
        focused && "bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">第 {revision.revision_no} 版</h4>
            <Badge variant="outline" className={revisionBadgeClass(revision.revision_state)}>
              {label(REVISION_STATE_LABELS, revision.revision_state, "未知状态")}
            </Badge>
            {focused && (
              <Badge variant="outline" className="border-primary/20 bg-primary/10 text-primary">
                本次登记
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {label(EVIDENCE_KIND_LABELS, revision.runtime_evidence_kind, "其他接入方式")} ·
            {label(PROTOCOL_LABELS, revision.protocol_type, "其他通信协议")}
          </p>
          <p className="text-xs text-muted-foreground">
            {revision.revision_state === "published"
              ? `已发布绑定验收：${revision.publication_conformance_run_id ? "已绑定" : "未绑定"}`
              : `本次可发布验收：${label(
                  VERIFICATION_LABELS,
                  revision.latest_valid_conformance_overall_result,
                  "尚无结果",
                )}`}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {canPublishRevision && (
            <Button type="button" size="sm" disabled={busy} onClick={publish}>
              {busy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck />
              )}
              {busy ? "发布中…" : "发布运行服务版本"}
            </Button>
          )}
          {canPublish && revision.revision_state === "published" && (
            <AlertDialog open={withdrawConfirmOpen} onOpenChange={setWithdrawConfirmOpen}>
              <AlertDialogTrigger
                render={<Button type="button" size="sm" variant="destructive" disabled={busy} />}
              >
                撤回
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认撤回第 {revision.revision_no} 版？</AlertDialogTitle>
                  <AlertDialogDescription>
                    撤回后，该版本不能再用于新的员工会话；已有记录仍会保留。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={busy}
                    onClick={async () => {
                      await withdraw();
                      setWithdrawConfirmOpen(false);
                    }}
                  >
                    {busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
                    {busy ? "撤回中…" : "确认撤回"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <dl className="grid overflow-hidden rounded-xl border border-border bg-muted/25 sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0 border-b border-border px-3.5 py-3 sm:border-r lg:border-b-0">
          <dt className="text-xs text-muted-foreground">服务地址</dt>
          <dd className="mt-1 truncate text-sm text-foreground" title={revision.endpoint_ref}>
            {revision.endpoint_ref}
          </dd>
        </div>
        <div className="border-b border-border px-3.5 py-3 lg:border-r lg:border-b-0">
          <dt className="text-xs text-muted-foreground">身份验证</dt>
          <dd className="mt-1 text-sm text-foreground">
            {label(IDENTITY_MODE_LABELS, revision.identity_mode, "其他方式")}
          </dd>
        </div>
        <div className="border-b border-border px-3.5 py-3 sm:border-r sm:border-b-0">
          <dt className="text-xs text-muted-foreground">访问凭证</dt>
          <dd className="mt-1 text-sm text-foreground">
            {revision.identity_mode === "none"
              ? "无需配置"
              : revision.credential_ref_id
                ? "已配置"
                : "未配置"}
          </dd>
        </div>
        <div className="px-3.5 py-3">
          <dt className="text-xs text-muted-foreground">发布校验</dt>
          <dd
            className={cn(
              "mt-1 flex items-center gap-1.5 text-sm",
              gate.ready ? "text-success" : "text-muted-foreground",
            )}
          >
            {gate.ready ? (
              <CheckCircle2 className="size-4" aria-hidden="true" />
            ) : (
              <AlertCircle className="size-4" aria-hidden="true" />
            )}
            <span>{gate.message}</span>
          </dd>
        </div>
      </dl>

      <MeasuredMatrix revision={revision} />

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4" aria-hidden="true" />
          {error}
        </div>
      )}
    </article>
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

function LoadingState() {
  return (
    <section aria-label="运行服务版本" className="space-y-3">
      <output className="sr-only">正在加载运行服务…</output>
      {[0, 1].map((item) => (
        <Card key={item} size="sm" className="gap-0 py-0 shadow-xs">
          <CardHeader className="border-b border-border py-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-xl" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 px-4 py-4 sm:px-5">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </CardContent>
        </Card>
      ))}
    </section>
  );
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
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  // 递增代次：只有最新一次刷新的响应可以落地，过期响应不得覆盖新结果。
  const reloadGeneration = useRef(0);

  const reload = useCallback(async (): Promise<boolean> => {
    const generation = ++reloadGeneration.current;
    setError(null);
    setRefreshing(true);
    try {
      const list = await client.runtimes.list();
      const entries = await Promise.all(
        list.items.map(async (runtime) => {
          const revisions = await client.runtimes.listRevisions(runtime.id);
          return [runtime.id, revisions.items] as const;
        }),
      );
      if (reloadGeneration.current !== generation) return false;
      setRuntimes(list.items);
      setRevisionsByRuntime(Object.fromEntries(entries));
      return true;
    } catch {
      if (reloadGeneration.current !== generation) return false;
      // 不回显后端原始 message（可能含内部 endpoint / 令牌等诊断细节），只显示稳定中文。
      setError("运行服务列表加载失败");
      return false;
    } finally {
      if (reloadGeneration.current === generation) setRefreshing(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 是刷新代次信号（同页 Runtime 登记成功后重拉），非直接引用
  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  if (runtimes === null && refreshing) return <LoadingState />;

  if (runtimes === null && error) {
    return (
      <section
        aria-label="运行服务版本"
        role="alert"
        className="flex flex-col items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 p-5"
      >
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="size-4" aria-hidden="true" />
          {error}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" />
          重新加载
        </Button>
      </section>
    );
  }

  if (runtimes?.length === 0 && !refreshing && !error) {
    return (
      <section
        aria-label="运行服务版本"
        className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-card px-6 py-10 text-center"
      >
        <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <ServerCog className="size-5" aria-hidden="true" />
        </span>
        <p className="text-sm font-medium text-foreground">暂无运行服务</p>
        <p className="mt-1 text-xs text-muted-foreground">
          登记运行服务后，可在这里查看验收与发布状态。
        </p>
      </section>
    );
  }

  return (
    <section aria-label="运行服务版本" className="space-y-3">
      {(refreshing || error) && (
        <div
          role={error ? "alert" : "status"}
          className={cn(
            "flex items-center gap-2 rounded-xl px-3 py-2 text-sm",
            error ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
          )}
        >
          {refreshing ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <AlertCircle className="size-4" aria-hidden="true" />
          )}
          {refreshing ? "正在刷新运行服务…" : error}
        </div>
      )}

      {notice && !refreshing && !error && (
        <output className="flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          {notice}
        </output>
      )}

      {runtimes?.map((runtime) => (
        <Card key={runtime.id} size="sm" className="gap-0 py-0 shadow-xs">
          <CardHeader className="border-b border-border py-4">
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <ServerCog className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-foreground">
                    {runtime.display_name}
                  </h3>
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    {label(RUNTIME_KIND_LABELS, runtime.kind, "其他服务")}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {label(LIFECYCLE_STATE_LABELS, runtime.lifecycle_state, "未知状态")}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-0">
            {(revisionsByRuntime[runtime.id] ?? []).length === 0 ? (
              <div className="px-5 py-6 text-center text-sm text-muted-foreground">暂无版本</div>
            ) : (
              (revisionsByRuntime[runtime.id] ?? []).map((revision) => (
                <RevisionRow
                  key={revision.id}
                  runtime={runtime}
                  revision={revision}
                  canPublish={canPublish && !refreshing && !error}
                  focused={revision.id === preferredRuntimeRevisionId}
                  onDone={async (result, action) => {
                    setNotice(null);
                    if (result) onPublished?.(result);
                    const refreshed = await reload();
                    if (refreshed) {
                      setNotice(
                        action === "publish" ? "运行服务版本已发布。" : "运行服务版本已撤回。",
                      );
                    }
                  }}
                />
              ))
            )}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
