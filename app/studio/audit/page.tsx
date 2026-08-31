import { AuditLogTable } from "@/components/studio/audit-log-table";
import { StudioGatePage } from "@/components/studio/gate-page";
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
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">审计</h1>
      <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
        后台敏感写操作审计（append-only）。展示最近 100 条；记录不含 secret / 文件内容 /
        完整命令输出。
      </p>
      <div className="mt-4">
        <AuditLogTable logs={logs} />
      </div>
    </div>
  );
}
