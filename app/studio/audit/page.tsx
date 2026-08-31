import { AuditLogTable } from "@/components/studio/audit-log-table";
import { StudioGatePage } from "@/components/studio/gate-page";
import { StudioPage } from "@/components/studio/studio-page";
import { listStudioAuditEvents } from "@/lib/studio/admin-audit";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * Agent Studio Audit 页（Phase 4-4 切片 C）。
 *
 * - 页面守卫 requireStudioPagePermission("audit.read")：admin 可见，member 403。
 * - server component 直接加载最近 100 条审计日志，渲染密集只读表。
 * - 审计 append-only：本页只读，不提供编辑/删除入口。
 */
export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const gate = await requireStudioPagePermission("audit.read");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const logs = await listStudioAuditEvents({ tenantId: gate.principal.tenantId, limit: 100 });

  return (
    <StudioPage
      title="操作记录"
      description="查看最近 100 条后台敏感操作。记录只读，且不会展示凭证、文件正文或完整命令输出。"
      width="wide"
    >
      <section aria-label="最近记录" className="space-y-3">
        <h2 className="px-0.5 text-sm font-semibold text-foreground">最近记录</h2>
        <AuditLogTable logs={logs} />
      </section>
    </StudioPage>
  );
}
