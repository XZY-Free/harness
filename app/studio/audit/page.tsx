"use client";

import { useApiData } from "@/components/hooks/use-api-data";
import { AuditLogTable } from "@/components/studio/audit-log-table";
import { StudioGatePage } from "@/components/studio/gate-page";
import { StudioPage } from "@/components/studio/studio-page";
import type { StudioAuditRow } from "@/lib/studio/admin-audit";

/**
 * Agent Studio Audit 页（Phase 4-4 切片 C · 页面数据 API 化）。
 *
 * - 数据来自 GET /studio/api/audit（服务端审计表，受 audit.read 守卫）。
 * - 员工无权时接口返回 403，页面展示门禁；server component 直读已移除。
 * - 审计 append-only：本页只读，不提供编辑/删除入口。
 */
export default function AuditPage() {
  const { data, loading, httpStatus, errorMessage } = useApiData<{ logs: StudioAuditRow[] }>(
    "/studio/api/audit",
  );
  const logs = data?.logs ?? [];

  return (
    <StudioPage
      title="操作记录"
      description="查看最近 100 条后台敏感操作。记录只读，且不会展示凭证、文件正文或完整命令输出。"
      width="wide"
    >
      <section aria-label="最近记录" className="space-y-3">
        <h2 className="px-0.5 text-sm font-semibold text-foreground">最近记录</h2>
        {httpStatus !== null ? (
          <StudioGatePage
            status={httpStatus === 0 ? 500 : httpStatus}
            message={errorMessage ?? "加载失败，请稍后重试"}
          />
        ) : loading ? (
          <div className="rounded-xl border border-border bg-card px-5 py-10 text-center text-sm text-muted-foreground">
            正在加载…
          </div>
        ) : (
          <AuditLogTable logs={logs} />
        )}
      </section>
    </StudioPage>
  );
}
