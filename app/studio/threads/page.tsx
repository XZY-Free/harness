import { getCurrentUserFromRequest } from "@/lib/auth";
import { listAllThreads, listThreadsForUser } from "@/lib/db/studio-queries";
import { STATUS_LABEL as STATUS_LABEL_DICT, t } from "@/lib/i18n";
import { hasPermission } from "@/lib/rbac";
import { headers } from "next/headers";
import Link from "next/link";

/**
 * Agent Studio Threads 列表（Phase 4-4 Stage D，只读）。
 * member 只见自己的；admin（thread.read.all）见全部（含 owner 列）。
 */
export const dynamic = "force-dynamic";

// P2 i18n: STATUS_LABEL 改用 lib/i18n 共享字典。
const STATUS_LABEL = STATUS_LABEL_DICT.zh;

export default async function ThreadsPage() {
  const user = await getCurrentUserFromRequest({ headers: await headers() });
  const canAll = await hasPermission(user.id, "thread.read.all");
  const threads = canAll ? await listAllThreads() : await listThreadsForUser(user.id);

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">
        {t("studio.threads.title")}{" "}
        {canAll && (
          <span className="text-[13px] text-[var(--fg-muted)]">
            {t("studio.overview.scope.global_tag")}
          </span>
        )}
      </h1>

      {/* 12-P2-6：小屏 card 视图，md+ 表格视图 */}
      {threads.length === 0 ? (
        <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-8 text-center text-[13px] text-[var(--fg-muted)]">
          {t("studio.threads.empty")}
        </div>
      ) : (
        <>
          {/* 移动端 card 视图（< md） */}
          <ul className="mt-4 flex flex-col gap-2 md:hidden">
            {threads.map((t) => (
              <li
                key={t.id}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[13px]"
              >
                <Link
                  href={`/studio/threads/${t.id}`}
                  className="block truncate font-medium text-[var(--primary)]"
                >
                  {t.title || (
                    <span className="font-mono text-[var(--fg-muted)]">{t.id.slice(0, 8)}</span>
                  )}
                </Link>
                <div className="mt-1 flex items-center gap-2 text-[12px] text-[var(--fg-muted)]">
                  <span>{STATUS_LABEL[t.status] ?? t.status}</span>
                  <span>·</span>
                  <span className="truncate">—</span>
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--fg-subtle)]">
                  {new Date(t.createdAt).toLocaleString()}
                </div>
                {canAll && (
                  <div className="mt-0.5 text-[11px] text-[var(--fg-subtle)]">
                    {t.ownerName ?? t.ownerEmail ?? (
                      <span className="font-mono">{t.userId.slice(0, 8)}</span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {/* md+ 表格视图 */}
          <div className="mt-4 hidden overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] md:block">
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--surface-2)] text-[var(--fg-subtle)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("studio.threads.col.thread")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("studio.threads.col.status")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("studio.threads.col.skill")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("studio.threads.col.created")}
                  </th>
                  {canAll && (
                    <th className="px-3 py-2 text-left font-medium">
                      {t("studio.threads.col.owner")}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {threads.map((t) => (
                  <tr key={t.id} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2">
                      <Link
                        href={`/studio/threads/${t.id}`}
                        className="text-[var(--primary)] hover:underline"
                      >
                        {t.title || (
                          <span className="font-mono text-[var(--fg-muted)]">
                            {t.id.slice(0, 8)}
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-[var(--fg-muted)]">
                      {STATUS_LABEL[t.status] ?? t.status}
                    </td>
                    <td className="px-3 py-2 text-[var(--fg-muted)]">—</td>
                    <td className="px-3 py-2 text-[var(--fg-muted)]">
                      {new Date(t.createdAt).toLocaleString()}
                    </td>
                    {canAll && (
                      <td className="px-3 py-2 text-[var(--fg-muted)]">
                        {t.ownerName ?? t.ownerEmail ?? (
                          <span className="font-mono">{t.userId.slice(0, 8)}</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
