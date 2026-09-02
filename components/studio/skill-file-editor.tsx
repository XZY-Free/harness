"use client";

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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { FileText, Save, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Message = { tone: "status" | "error"; text: string };

/** 文件编辑器：保存只更新工作副本，发布才生成可用版本。 */
export function SkillFileEditor({
  skillId,
  skillName,
  canWrite,
}: {
  skillId: string;
  skillName: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [files, setFiles] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busyAction, setBusyAction] = useState<"save" | "publish" | null>(null);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  async function loadFiles() {
    const res = await fetch(`/studio/api/skills/${skillId}/files`);
    const body = await res.json();
    if (res.ok) setFiles(body.data?.files ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/studio/api/skills/${skillId}/files`)
      .then(async (response) => ({ ok: response.ok, body: await response.json() }))
      .then(({ ok, body }) => {
        if (!cancelled && ok) setFiles(body.data?.files ?? []);
      })
      .catch(() => {
        if (!cancelled) setMessage({ tone: "error", text: "文件列表加载失败" });
      });
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  async function openFile(path: string) {
    setMessage(null);
    try {
      const res = await fetch(
        `/studio/api/skills/${skillId}/files?path=${encodeURIComponent(path)}`,
      );
      const body = await res.json();
      if (!res.ok) {
        setMessage({ tone: "error", text: body?.error?.message ?? "文件加载失败" });
        return;
      }
      setCurrent(path);
      setContent(body.data?.content ?? "");
      setDirty(false);
    } catch {
      setMessage({ tone: "error", text: "网络连接失败，无法打开文件" });
    }
  }

  function requestOpenFile(path: string) {
    if (path === current) return;
    if (dirty) {
      setPendingFile(path);
      return;
    }
    void openFile(path);
  }

  async function save() {
    if (!current || busyAction) return;
    setBusyAction("save");
    setMessage(null);
    try {
      const res = await fetch(`/studio/api/skills/${skillId}/files`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: current, content }),
      });
      if (res.ok) {
        setDirty(false);
        setMessage({ tone: "status", text: "工作副本已保存，尚未发布" });
      } else {
        const body = await res.json().catch(() => ({}));
        setMessage({ tone: "error", text: body?.error?.message ?? "保存失败" });
      }
    } catch {
      setMessage({ tone: "error", text: "网络连接失败，工作副本未保存" });
    } finally {
      setBusyAction(null);
    }
  }

  async function publish() {
    if (busyAction || dirty) return;
    setBusyAction("publish");
    setMessage(null);
    try {
      const res = await fetch(`/studio/api/skills/${skillId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `${skillName} 新版本` }),
      });
      const body = await res.json();
      if (res.ok) {
        setMessage({ tone: "status", text: `版本 ${body.data?.version} 已发布` });
        router.refresh();
        await loadFiles();
      } else {
        setMessage({ tone: "error", text: body?.error?.message ?? "发布失败" });
      }
    } catch {
      setMessage({ tone: "error", text: "网络连接失败，版本未发布" });
    } finally {
      setBusyAction(null);
    }
  }

  const statusText = message?.text ?? (dirty ? "有未保存的修改" : null);
  const statusTone = message?.tone ?? "status";

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">文件与工作副本</h3>
          <p className="text-xs leading-5 text-muted-foreground">
            保存工作副本不会影响当前版本，确认内容后再单独发布。
          </p>
        </div>
        {canWrite && (
          <Button
            type="button"
            onClick={publish}
            disabled={busyAction !== null || dirty}
            title={dirty ? "请先保存当前修改" : undefined}
          >
            <Upload data-icon="inline-start" aria-hidden />
            {busyAction === "publish" ? "发布中…" : "发布新版本"}
          </Button>
        )}
      </div>

      <div className="grid min-h-96 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          aria-label="技能文件"
          className="border-b border-border bg-muted/30 p-2 md:border-r md:border-b-0"
        >
          {files.length === 0 ? (
            <p className="px-3 py-5 text-xs text-muted-foreground">暂无可查看的文件</p>
          ) : (
            <ul className="space-y-1">
              {files.map((file) => (
                <li key={file}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-pressed={current === file}
                    onClick={() => requestOpenFile(file)}
                    className={cn(
                      "w-full justify-start overflow-hidden px-2 font-mono font-normal",
                      current === file && "bg-muted text-foreground",
                    )}
                  >
                    <FileText data-icon="inline-start" aria-hidden />
                    <span className="truncate">{file}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <div className="min-w-0 bg-background">
          {current ? (
            <Textarea
              aria-label="文件内容"
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setDirty(true);
                setMessage(null);
              }}
              readOnly={!canWrite}
              className="min-h-96 resize-y rounded-none border-0 bg-transparent p-4 font-mono text-xs shadow-none focus-visible:ring-0"
            />
          ) : (
            <div className="flex min-h-96 items-center justify-center p-8 text-center text-sm text-muted-foreground">
              从文件列表选择一项查看内容
            </div>
          )}
        </div>
      </div>

      {(statusText || (canWrite && current)) && (
        <div className="flex min-h-14 flex-col gap-3 border-t border-border bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          {statusText ? (
            <p
              role={statusTone === "error" ? "alert" : "status"}
              className={cn(
                "text-xs",
                statusTone === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {statusText}
            </p>
          ) : (
            <span />
          )}
          {canWrite && current && (
            <Button
              type="button"
              variant="outline"
              onClick={save}
              disabled={busyAction !== null || !dirty}
            >
              <Save data-icon="inline-start" aria-hidden />
              {busyAction === "save" ? "保存中…" : "保存工作副本"}
            </Button>
          )}
        </div>
      )}

      <AlertDialog
        open={pendingFile !== null}
        onOpenChange={(open) => {
          if (!open) setPendingFile(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
            <AlertDialogDescription>
              切换文件会丢失当前工作副本中尚未保存的内容。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const nextFile = pendingFile;
                setPendingFile(null);
                if (nextFile) void openFile(nextFile);
              }}
            >
              放弃修改并切换
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
