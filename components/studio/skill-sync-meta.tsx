"use client";

import { StudioSettingsRow } from "@/components/studio/studio-settings-section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Unlink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type SkillSyncMetaProps = {
  skillId: string;
  skillName: string;
  syncState: string;
  remoteAssetId: string | null;
  remoteName: string | null;
  remoteDisplayName: string | null;
  remoteVersion: string | null;
  remoteContentHash: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
};

const SYNC_STATE_LABEL: Record<string, string> = {
  active: "已同步",
  blocked: "暂停更新",
  hidden: "来源已隐藏",
  not_found: "来源已下线",
  name_conflict: "名称冲突",
  error: "同步失败",
};

/** 展示同步来源摘要。同步技能的内容保持只读。 */
export function SkillSyncMeta({
  skillId,
  skillName,
  syncState,
  remoteName,
  remoteDisplayName,
  remoteVersion,
  lastSyncedAt,
  lastError,
}: SkillSyncMetaProps) {
  const router = useRouter();
  const [unsyncing, setUnsyncing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unsync() {
    if (unsyncing) return;
    setUnsyncing(true);
    setError(null);
    try {
      const res = await fetch(`/studio/api/skills/${skillId}/unsync`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? "停止同步失败，请稍后重试");
        return;
      }
      setConfirmOpen(false);
      router.refresh();
    } catch {
      setError("网络连接失败，未停止同步");
    } finally {
      setUnsyncing(false);
    }
  }

  return (
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <StudioSettingsRow
        title="同步状态"
        description="内容由技能库统一更新，因此不能在这里直接编辑或切换版本。"
      >
        <Badge variant={syncState === "error" ? "destructive" : "secondary"}>
          {SYNC_STATE_LABEL[syncState] ?? "状态未知"}
        </Badge>
      </StudioSettingsRow>
      <StudioSettingsRow title="来源名称">
        <span className="max-w-64 truncate text-sm text-muted-foreground">
          {remoteDisplayName ?? remoteName ?? "—"}
        </span>
      </StudioSettingsRow>
      <StudioSettingsRow title="来源版本">
        <span className="text-sm text-muted-foreground">{remoteVersion ?? "—"}</span>
      </StudioSettingsRow>
      <StudioSettingsRow title="最近同步">
        <span className="text-sm text-muted-foreground">{lastSyncedAt ?? "—"}</span>
      </StudioSettingsRow>
      {lastError && (
        <StudioSettingsRow title="最近一次同步失败">
          <span className="max-w-md text-right text-sm text-destructive">{lastError}</span>
        </StudioSettingsRow>
      )}
      <StudioSettingsRow
        title="停止同步"
        description="停止后会归档本地副本，但不会删除已有任务和历史版本。"
      >
        <Button
          type="button"
          variant="destructive"
          onClick={() => setConfirmOpen(true)}
          disabled={unsyncing}
        >
          <Unlink data-icon="inline-start" aria-hidden />
          {unsyncing ? "处理中…" : "停止同步"}
        </Button>
      </StudioSettingsRow>
      {error && (
        <div role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认停止同步“{skillName}”？</AlertDialogTitle>
          <AlertDialogDescription>
            停止后不会再用于新任务，已有任务和历史版本仍可查看。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={unsyncing}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={unsyncing}
            onClick={() => void unsync()}
          >
            {unsyncing ? "处理中…" : "确认停止同步"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
