"use client";

import { useToast } from "@/components/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Archive } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** 归档技能；后端保留已有任务和历史版本。 */
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
  const [open, setOpen] = useState(false);
  async function del() {
    setBusy(true);
    try {
      const res = await fetch(`/studio/api/skills/${skillId}`, { method: "DELETE" });
      if (res.ok) {
        setOpen(false);
        router.push("/studio/skills");
        router.refresh();
      } else {
        toast.error("归档失败，请稍后重试");
      }
    } catch {
      toast.error("网络连接失败，技能未归档");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button type="button" disabled={busy} variant="destructive" />}>
        <Archive data-icon="inline-start" aria-hidden />
        {busy ? "归档中…" : "归档技能"}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认归档“{skillName}”？</AlertDialogTitle>
          <AlertDialogDescription>
            归档后不会再用于新任务，已有任务和历史版本仍可查看。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void del()}>
            {busy ? "归档中…" : "确认归档"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
