import { readWorkspaceFile, safeJoin } from "@/lib/workspace";

/**
 * S1 修复（06-P1-3）：文件级项目记忆（对标 Claude Code CLAUDE.md）。
 *
 * 从 workspace 根读取项目记忆文件（CLAUDE.md / SNOW.md / AGENTS.md），返回拼接文本供
 * 注入上下文（作为 protected note，类似 pinned facts）。文件不存在 → 空串（零回归）。
 *
 * 仅读 workspace 根的约定文件名，不递归、不执行文件内指令（仅作上下文文本）。
 * 安全：经 readWorkspaceFile（safeJoin + symlink 防护），不越界。
 */

/** 约定的项目记忆文件名（按优先级，先找到的先拼接）。 */
const PROJECT_MEMORY_FILES = ["CLAUDE.md", "SNOW.md", "AGENTS.md"];

/** 单文件最大读取字节（防超大文件灌爆上下文）。 */
const MAX_FILE_BYTES = 16_000;

/**
 * 加载 thread workspace 的项目记忆文件，返回拼接文本。
 * 多文件按 PROJECT_MEMORY_FILES 顺序拼接，每个带 `# {文件名}` 头。
 * 无任何文件 → 空串。
 */
export async function loadProjectMemoryFiles(threadId: string): Promise<string> {
  const sections: string[] = [];
  for (const name of PROJECT_MEMORY_FILES) {
    try {
      const content = await readWorkspaceFile(threadId, name);
      if (content && content.trim().length > 0) {
        const capped =
          content.length > MAX_FILE_BYTES
            ? `${content.slice(0, MAX_FILE_BYTES)}\n[...已截断...]`
            : content;
        sections.push(`# 项目记忆（${name}）\n${capped}`);
      }
    } catch {
      // 文件不存在 / 读失败 → 跳过（零回归）
    }
  }
  return sections.join("\n\n");
}

/** 仅供测试：暴露约定文件名。 */
export const __PROJECT_MEMORY_FILES = PROJECT_MEMORY_FILES;
