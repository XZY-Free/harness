"use client";

import { apiFetch } from "@/lib/api-fetch";
import { ChevronDown, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WorkspaceFileIcon } from "./workspace-file-icon";

export const FILE_TREE_REFRESH_MS = 1500;

/**
 * V5-B2：工作区文件树。
 *
 * 调用前台 list API（`/api/v1/threads/{thread_id}/workspace`）拿扁平路径列表，前端构造树形结构。
 * 内部目录已在后端默认隐藏（listWorkspaceFiles skipInternal=true）。
 *
 * 文件节点点击 → onSelectPath(relPath)，由父级（WorkspacePanel file kind 分支）
 * 切换 FileViewer。选中状态由父级管理（selectedPath），便于外部程序化选中。
 */
type TreeNode = {
  name: string;
  path: string; // 完整相对路径
  isDir: boolean;
  children: Map<string, TreeNode>;
};

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = {
    name: "",
    path: "",
    isDir: true,
    children: new Map(),
  };
  for (const rel of files) {
    const segs = rel.split("/").filter(Boolean);
    let cur = root;
    segs.forEach((seg, i) => {
      const isLeaf = i === segs.length - 1;
      let next = cur.children.get(seg);
      if (!next) {
        next = {
          name: seg,
          path: segs.slice(0, i + 1).join("/"),
          isDir: !isLeaf,
          children: new Map(),
        };
        cur.children.set(seg, next);
      }
      cur = next;
    });
  }
  return root;
}

function sortTree(node: TreeNode) {
  const entries = Array.from(node.children.values());
  entries.sort((a, b) => {
    // 目录优先
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  node.children = new Map(entries.map((e) => [e.name, e]));
  for (const child of entries) sortTree(child);
}

function TreeRow({
  node,
  depth,
  selectedPath,
  expanded,
  toggle,
  onSelectPath,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  toggle: (path: string) => void;
  onSelectPath: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = selectedPath === node.path;

  if (node.isDir) {
    const children = Array.from(node.children.values());
    return (
      <div>
        <button
          type="button"
          onClick={() => toggle(node.path)}
          className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          aria-expanded={isOpen}
        >
          <ChevronDown
            aria-hidden="true"
            className={`size-3 shrink-0 text-foreground-subtle transition-transform ${
              isOpen ? "rotate-0" : "-rotate-90"
            }`}
          />
          {isOpen ? (
            <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen ? (
          <div>
            {children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                expanded={expanded}
                toggle={toggle}
                onSelectPath={onSelectPath}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // 文件节点
  return (
    <button
      type="button"
      onClick={() => onSelectPath(node.path)}
      className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors ${
        isSelected
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      style={{ paddingLeft: `${depth * 12 + 8 + 14}px` }}
      title={node.path}
    >
      <WorkspaceFileIcon name={node.name} className="size-4 shrink-0 text-foreground-subtle" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function FileTree({
  threadId,
  selectedPath,
  onSelectPath,
}: {
  threadId: string;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}) {
  const [files, setFiles] = useState<string[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // 初次打开立即加载；面板保持打开时静默轮询，同步 agent 后续写入的文件。
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let hasLoaded = false;
    setFiles(undefined);
    setError(null);

    const load = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const response = await apiFetch(`/api/v1/threads/${threadId}/workspace`, {
          cache: "no-store",
        });
        const json = (await response.json()) as {
          ok?: boolean;
          data?: { threadId: string; files: string[] };
        };
        if (cancelled) return;
        if (response.ok && json.ok && json.data && Array.isArray(json.data.files)) {
          const nextFiles = json.data.files;
          setFiles((prev) =>
            prev &&
            prev.length === nextFiles.length &&
            prev.every((file, index) => file === nextFiles[index])
              ? prev
              : nextFiles,
          );
          setError(null);
          hasLoaded = true;
        } else if (!hasLoaded) {
          setError("无法加载文件列表");
        }
      } catch {
        if (!cancelled && !hasLoaded) setError("无法加载文件列表");
      } finally {
        inFlight = false;
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), FILE_TREE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [threadId]);

  // 默认展开顶层目录：首次拿到列表后展开根节点的所有目录，方便浏览。
  useEffect(() => {
    if (!files || files.length === 0) return;
    setExpanded((prev) => {
      if (prev.size > 0) return prev;
      const next = new Set(prev);
      for (const rel of files) {
        const segs = rel.split("/").filter(Boolean);
        const top = segs[0];
        if (segs.length > 1 && top) next.add(top);
      }
      return next;
    });
  }, [files]);

  const tree = useMemo(() => {
    if (!files) return null;
    const root = buildTree(files);
    sortTree(root);
    return root;
  }, [files]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-[12px] text-[var(--danger)]">
        {error}
      </div>
    );
  }

  if (!tree) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-[12px] text-[var(--fg-subtle)]">
        加载中…
      </div>
    );
  }

  if (tree.children.size === 0) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-[12px] text-[var(--fg-subtle)]">
        工作区暂无可查看文件
      </div>
    );
  }

  return (
    <nav className="min-h-0 flex-1 overflow-y-auto py-2" aria-label="工作区文件列表">
      {Array.from(tree.children.values()).map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={0}
          selectedPath={selectedPath}
          expanded={expanded}
          toggle={toggle}
          onSelectPath={onSelectPath}
        />
      ))}
    </nav>
  );
}
