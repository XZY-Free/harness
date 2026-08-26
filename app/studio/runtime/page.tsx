import { StudioGatePage } from "@/components/studio/gate-page";
import { RuntimeControlPanel } from "@/components/studio/runtime-control-panel";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";
import Link from "next/link";

/**
 * 统一管理后台 — Runtime 治理页（07 §10/§11）。
 *
 * 替换 S11-W01 占位：接入 Runtime/RuntimeRevision 发布治理控制面板；
 * Route 操作按 07 §12 优先复用已有 DeploymentRoute/Activation UI，仅提供跳转。
 */
export const dynamic = "force-dynamic";

export default async function RuntimePage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canPublish = await hasStudioAction(gate.principal, "runtime.publish");

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">Runtime 与环境</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        RuntimeRevision 发布治理（按 runtimeEvidenceKind 区分证据门禁）、实例与 Environment 概览。
      </p>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        Route 操作复用既有治理入口：
        <Link href="/studio/operations" className="ml-1 underline">
          运维与部署
        </Link>
        。
      </p>
      <RuntimeControlPanel canPublish={canPublish} />
    </div>
  );
}
