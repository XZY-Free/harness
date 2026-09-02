"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** 新建技能并生成首个可用版本。 */
export function SkillCreator() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tools, setTools] = useState(
    "writeFile,readFile,listFiles,runCommand,runTests,reportReady",
  );
  const [promptMd, setPromptMd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeOpen(nextOpen: boolean) {
    if (busy) return;
    setOpen(nextOpen);
    if (nextOpen) setError(null);
  }

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/studio/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          tools: tools
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          promptMd,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? "创建失败，请稍后重试");
        return;
      }
      setOpen(false);
      setName("");
      setDescription("");
      setPromptMd("");
      router.refresh();
    } catch {
      setError("网络连接失败，技能未创建");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button />}>
        <Plus data-icon="inline-start" aria-hidden />
        新建技能
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建技能</DialogTitle>
          <DialogDescription>
            创建一项可复用的工作能力，创建后仍可继续编辑和发布版本。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <div className="space-y-2">
            <Label htmlFor="skill-name">技能标识</Label>
            <Input
              id="skill-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="build-from-idea"
              autoComplete="off"
              aria-describedby="skill-name-help"
            />
            <p id="skill-name-help" className="text-xs leading-5 text-muted-foreground">
              使用小写字母、数字和连字符，创建后不可修改。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="skill-description">描述</Label>
            <Input
              id="skill-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说明这项技能适合处理什么工作"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="skill-tools">可用工具</Label>
            <Input
              id="skill-tools"
              value={tools}
              onChange={(event) => setTools(event.target.value)}
              className="font-mono text-xs"
              aria-describedby="skill-tools-help"
            />
            <p id="skill-tools-help" className="text-xs leading-5 text-muted-foreground">
              多个工具使用英文逗号分隔。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="skill-instructions">工作说明</Label>
            <Textarea
              id="skill-instructions"
              value={promptMd}
              onChange={(event) => setPromptMd(event.target.value)}
              rows={8}
              placeholder="写下执行步骤、判断标准和需要遵守的边界。"
              className="min-h-44 resize-y font-mono text-xs"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />} disabled={busy}>
            取消
          </DialogClose>
          <Button type="button" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "创建中…" : "创建技能"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
