"use client";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  type AgentDTO,
  ControlPlaneRequestError,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { useState } from "react";
const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });
export function AgentDeleteButton({
  agent,
  onDeleted,
  canDelete = false,
}: { agent: AgentDTO; onDeleted: () => void; canDelete?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    if (!canDelete) return;
    setBusy(true);
    setError(null);
    try {
      await client.agents.delete(agent.id, { ifMatch: `"agent-${agent.version_no}"` });
      setOpen(false);
      onDeleted();
    } catch (error) {
      setError(
        error instanceof ControlPlaneRequestError
          ? error.code === "BUSINESS_CONSTRAINT_VIOLATION"
            ? "此智能体已有服务连接或已退役，暂不能删除。请联系发布管理员处理连接；本次没有删除任何数据。"
            : error.code === "ACTION_SCOPE_DENIED"
              ? "当前账号没有删除此智能体的权限。"
              : error.code === "ETAG_MISMATCH"
                ? "智能体已发生变化，请刷新列表后重试。"
                : "删除未成功，请稍后重试。"
          : "连接中断，暂未确认删除结果。可以重试核实。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`删除${agent.display_name}`}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        删除
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除“{agent.display_name}”？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后将从管理列表移除，历史记录会保留。若已建立服务连接，系统会阻止删除。同一服务标识不能重新登记。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!canDelete && (
            <p className="text-sm text-muted-foreground">
              当前账号没有删除权限。请联系具有智能体登记和下架权限的平台管理员。
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <Button variant="destructive" disabled={busy || !canDelete} onClick={remove}>
              {busy ? "正在删除…" : "确认删除"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
