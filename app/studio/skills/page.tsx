import { StudioGatePage } from "@/components/studio/gate-page";
import { SkillCreator } from "@/components/studio/skill-creator";
import { SkillSyncButton } from "@/components/studio/skill-sync-button";
import { listSkillsWithSync } from "@/lib/capability/skill-studio-queries";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";
import Link from "next/link";

/**
 * Agent Studio Skills 列表（Phase 4-4 Stage B + 02 文档 §7.1 同步来源展示）。
 * server component 取数（受 layout studio.access + skill.read 门禁；写操作走 /studio/api/*）。
 */
export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  local: "本地自建",
  "capability-market": "同步镜像",
};

const SYNC_STATE_LABEL: Record<string, string> = {
  active: "可用",
  blocked: "远端阻止",
  hidden: "远端隐藏",
  not_found: "远端已下线",
  name_conflict: "名称冲突",
  error: "同步失败",
};

export default async function SkillsPage() {
  const gate = await requireStudioPagePermission("skill.read");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  // S1（11-P2-6）：admin 看全部;member 只看自己的 + 公共
  const isSkillAdmin = await hasStudioAction(gate.principal, "skill.write");
  const tenantId = gate.principal.tenantId;
  const skills = isSkillAdmin
    ? await listSkillsWithSync(tenantId)
    : await listSkillsWithSync(tenantId, {
        ownerUserId: gate.principal.userIdentityId,
        includePublic: true,
      });
  const canWrite = await hasStudioAction(gate.principal, "skill.write");
  const canSync = await hasStudioAction(gate.principal, "skill.write");
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-[22px] font-semibold text-[var(--fg)]">技能</h1>
        <div className="flex items-center gap-3">
          {canSync && <SkillSyncButton />}
          {canWrite && <SkillCreator />}
        </div>
      </div>
      <div className="mt-4 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
        <table className="w-full min-w-[700px] overflow-x-auto text-[13px]">
          <thead className="bg-[var(--surface-2)] text-[var(--fg-subtle)]">
            <tr>
              <th className="px-3 py-2 text-left font-medium">名称</th>
              <th className="px-3 py-2 text-left font-medium">来源</th>
              <th className="px-3 py-2 text-left font-medium">分类</th>
              <th className="px-3 py-2 text-left font-medium">状态</th>
              <th className="px-3 py-2 text-left font-medium">同步状态</th>
              <th className="px-3 py-2 text-left font-medium">最近同步</th>
            </tr>
          </thead>
          <tbody>
            {skills.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-[var(--fg-muted)]">
                  暂无 skill（运行 pnpm db:seed 灌入示例 skill,或点击「同步
                  capability-market」拉取）
                </td>
              </tr>
            )}
            {skills.map((s) => (
              <tr key={s.id} className="border-t border-[var(--border)]">
                <td className="px-3 py-2">
                  <Link
                    href={`/studio/skills/${s.id}`}
                    className="text-[var(--primary)] hover:underline"
                  >
                    {s.skillKey}
                  </Link>
                </td>
                <td className="px-3 py-2 text-[var(--fg-muted)]">
                  {SOURCE_LABEL[s.sourceType] ?? s.sourceType}
                </td>
                <td className="px-3 py-2 text-[var(--fg-muted)]">—</td>
                <td className="px-3 py-2 text-[var(--fg-muted)]">{s.lifecycleState}</td>
                <td className="px-3 py-2 text-[var(--fg-muted)]">
                  {s.syncState ? (SYNC_STATE_LABEL[s.syncState] ?? s.syncState) : "—"}
                </td>
                <td className="px-3 py-2 text-[var(--fg-muted)]">
                  {s.lastSyncedAt ? s.lastSyncedAt.toLocaleString("zh-CN", { hour12: false }) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
