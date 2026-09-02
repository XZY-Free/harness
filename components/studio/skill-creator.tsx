"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

const SKILL_TOOL_OPTIONS = [
  { value: "writeFile", label: "写入文件" },
  { value: "readFile", label: "读取文件" },
  { value: "listFiles", label: "浏览文件" },
  { value: "runCommand", label: "运行命令" },
  { value: "runTests", label: "运行测试" },
  { value: "reportReady", label: "标记完成" },
] as const;

const DEFAULT_SKILL_TOOLS = SKILL_TOOL_OPTIONS.map((tool) => tool.value);

/** 新建技能并生成首个可用版本。 */
export function SkillCreator() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tools, setTools] = useState<Set<string>>(() => new Set(DEFAULT_SKILL_TOOLS));
  const [promptMd, setPromptMd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeOpen(nextOpen: boolean) {
    if (busy) return;
    setOpen(nextOpen);
    if (nextOpen) setError(null);
  }

  function toggleTool(tool: string, checked: boolean) {
    setTools((current) => {
      const next = new Set(current);
      if (checked) next.add(tool);
      else next.delete(tool);
      return next;
    });
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
          tools: SKILL_TOOL_OPTIONS.filter((tool) => tools.has(tool.value)).map(
            (tool) => tool.value,
          ),
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
      setTools(new Set(DEFAULT_SKILL_TOOLS));
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

          <fieldset aria-describedby="skill-tools-help" className="space-y-2">
            <legend className="text-sm font-medium text-foreground">可用工具</legend>
            <p id="skill-tools-help" className="text-xs leading-5 text-muted-foreground">
              选择这项技能工作时可以使用的能力。
            </p>
            <div className="grid grid-cols-2 gap-2">
              {SKILL_TOOL_OPTIONS.map((tool) => (
                <div
                  key={tool.value}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted/50 has-data-[state=checked]:border-foreground/20 has-data-[state=checked]:bg-muted/60"
                >
                  <Checkbox
                    id={`skill-tool-${tool.value}`}
                    checked={tools.has(tool.value)}
                    onCheckedChange={(checked) => toggleTool(tool.value, checked === true)}
                  />
                  <label
                    htmlFor={`skill-tool-${tool.value}`}
                    className="min-w-0 flex-1 cursor-pointer"
                  >
                    {tool.label}
                  </label>
                </div>
              ))}
            </div>
          </fieldset>

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
