import { StudioGatePage } from "@/components/studio/gate-page";
import { SkillCreator } from "@/components/studio/skill-creator";
import { SkillSyncButton } from "@/components/studio/skill-sync-button";
import { StudioPage } from "@/components/studio/studio-page";
import { Badge } from "@/components/ui/badge";
import { listSkillsWithSync } from "@/lib/capability/skill-studio-queries";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  local: "本地创建",
  capability_market: "技能库同步",
  external: "外部导入",
};

const LIFECYCLE_LABEL: Record<string, string> = {
  draft: "草稿",
  enabled: "可用",
  disabled: "已归档",
  retired: "已停用",
};

const SYNC_STATE_LABEL: Record<string, string> = {
  active: "已同步",
  blocked: "暂停更新",
  hidden: "来源已隐藏",
  not_found: "来源已下线",
  name_conflict: "名称冲突",
  error: "同步失败",
};

export default async function SkillsPage() {
  const gate = await requireStudioPagePermission("skill.read");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canWrite = await hasStudioAction(gate.principal, "skill.write");
  const skills = canWrite
    ? await listSkillsWithSync(gate.principal.tenantId)
    : await listSkillsWithSync(gate.principal.tenantId, {
        ownerUserId: gate.principal.userIdentityId,
        includePublic: true,
      });

  return (
    <StudioPage
      title="技能"
      description="管理可复用的工作能力、文件内容和已发布版本。"
      actions={
        canWrite ? (
          <>
            <SkillSyncButton />
            <SkillCreator />
          </>
        ) : null
      }
      width="wide"
    >
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
        {skills.length === 0 ? (
          <div
            data-slot="skills-empty-state"
            className="px-5 py-12 text-center text-sm leading-6 text-muted-foreground"
          >
            暂无技能。可以新建技能，或从技能库同步已有内容。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-3xl w-full text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">名称</th>
                  <th className="px-4 py-3 text-left font-medium">来源</th>
                  <th className="px-4 py-3 text-left font-medium">状态</th>
                  <th className="px-4 py-3 text-left font-medium">同步状态</th>
                  <th className="px-4 py-3 text-left font-medium">最近同步</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {skills.map((skill) => (
                  <tr key={skill.id} className="transition-colors hover:bg-muted/30">
                    <td className="px-4 py-3.5">
                      <Link
                        href={`/studio/skills/${skill.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {skill.displayName || skill.skillKey}
                      </Link>
                      {skill.displayName && skill.displayName !== skill.skillKey && (
                        <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {skill.skillKey}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-muted-foreground">
                      {SOURCE_LABEL[skill.sourceType] ?? "其他来源"}
                    </td>
                    <td className="px-4 py-3.5">
                      <Badge variant="secondary">
                        {LIFECYCLE_LABEL[skill.lifecycleState] ?? "状态未知"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3.5 text-muted-foreground">
                      {skill.syncState ? (SYNC_STATE_LABEL[skill.syncState] ?? "状态未知") : "—"}
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap text-muted-foreground">
                      {skill.lastSyncedAt
                        ? skill.lastSyncedAt.toLocaleString("zh-CN", { hour12: false })
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </StudioPage>
  );
}
