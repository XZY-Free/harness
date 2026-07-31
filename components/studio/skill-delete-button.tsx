"use client";

import { useToast } from "@/components/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** 归档技能按钮（软删：status=archived,目录保留）。DELETE /studio/api/skills/[id]。 */
export function SkillDeleteButton({
  skillId,
  skillName,
}: {
  skillId: string;
  skillName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function del() {
    if (!confirm(`确认归档技能「${skillName}」?(软删,目录保留供历史 thread 读)`)) return;
    setBusy(true);
    const res = await fetch(`/studio/api/skills/${skillId}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) {
      router.push("/studio/skills");
      router.refresh();
    } else {
      toast.error("归档失败");
    }
  }
  return (
    <button
      type="button"
      onClick={del}
      disabled={busy}
      className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--danger)] transition hover:bg-[var(--surface-2)] disabled:opacity-40"
    >
      {busy ? "处理中…" : "归档"}
    </button>
  );
}
