"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RotateCcw, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type VersionLite = {
  id: string;
  version: number;
  status: string;
  createdAt: Date | string;
  commitSha?: string | null;
};

async function postAction(
  skillId: string,
  versionId: string,
  kind: "publish" | "rollback",
): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`/studio/api/skills/${skillId}/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: body?.error?.message ?? "操作失败" };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "网络连接失败" };
  }
}

export function SkillVersionTimeline({
  skillId,
  versions,
  currentVersionId,
  canWrite = false,
}: {
  skillId: string;
  versions: VersionLite[];
  currentVersionId: string | null;
  canWrite?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentVersion = versions.find((version) => version.id === currentVersionId)?.version;

  async function handle(version: VersionLite, kind: "publish" | "rollback") {
    setBusy(version.id);
    setError(null);
    const result = await postAction(skillId, version.id, kind);
    setBusy(null);
    if (!result.ok) {
      setError(`版本 ${version.version} 操作失败：${result.message ?? "请稍后重试"}`);
      return;
    }
    router.refresh();
  }

  if (versions.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">暂无已保存的版本。</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {versions.map((version) => {
        const isCurrent = version.id === currentVersionId;
        const isOlder = currentVersion !== undefined && version.version < currentVersion;
        const actionKind = isOlder ? "rollback" : "publish";
        return (
          <li
            key={version.id}
            className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-foreground">
                {version.version}
              </div>
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    版本 {version.version}
                  </span>
                  {isCurrent && <Badge variant="secondary">当前使用</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(version.createdAt).toLocaleString("zh-CN", { hour12: false })}
                </p>
              </div>
            </div>
            {canWrite && !isCurrent && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => handle(version, actionKind)}
              >
                {isOlder ? (
                  <RotateCcw data-icon="inline-start" aria-hidden />
                ) : (
                  <Send data-icon="inline-start" aria-hidden />
                )}
                {busy === version.id ? "处理中…" : isOlder ? "恢复此版本" : "设为当前版本"}
              </Button>
            )}
          </li>
        );
      })}
      {error && (
        <li role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </li>
      )}
    </ul>
  );
}
