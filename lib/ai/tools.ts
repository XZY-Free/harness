import { createHash } from "node:crypto";
import { reportThreadReady } from "@/lib/ai/preview-gate";
import { executeToolRun, resolveToolTimeoutMs } from "@/lib/ai/tool-runtime";
import { buildBrowserTools } from "@/lib/ai/tools/browser";
import { buildCommandBuildTools } from "@/lib/ai/tools/command-build";
import { buildCommandTaskTools } from "@/lib/ai/tools/command-tasks";
import { buildCustomTools } from "@/lib/ai/tools/custom";
import { buildDeployTools } from "@/lib/ai/tools/deploy";
import { buildFileEditTools } from "@/lib/ai/tools/file-edit";
import { buildFileSearchTools } from "@/lib/ai/tools/file-search";
import { buildGitTools } from "@/lib/ai/tools/git";
import { buildMemoryTools } from "@/lib/ai/tools/memory";
import { buildQaTools } from "@/lib/ai/tools/qa";
import { buildSubagentControlTools } from "@/lib/ai/tools/subagent";
import { buildWebTools } from "@/lib/ai/tools/web";
import type { RuntimeType } from "@/lib/config";
import type { CustomToolDeclaration } from "@/lib/custom-tools/registry";
import { buildMcpTools } from "@/lib/mcp/tools";
import { resolveRuntimes } from "@/lib/runtime/registry";
import type { RuntimeHandle } from "@/lib/runtime/types";
import { readSkillFileAtSha } from "@/lib/skill/repo";
import { withPathLock } from "@/lib/workspace";
import { tool } from "ai";
import { z } from "zod";

/**
 * 当前会话绑定的 skill 上下文（供 readSkillFile 工具读取本地 git 快照）。
 *
 * 02 文档 §六.3：readSkillFile 只读本地 commitSha 快照,不再有远程读取分支。
 * 同步 Skill 与本地自建 Skill 一样从本地 commitSha 读取,无差异。
 */
export type SkillContext = {
  source: "local";
  /** 本地 skill 目录名（skills/<name>/）。 */
  name: string;
  /** 本地 git commit sha（readSkillFile 读历史快照的键）。 */
  commitSha: string;
  /** 可选 skillVersionId,用于加载证据归属。 */
  skillVersionId?: string;
  /** readSkillFile 加载证据累积器（运行结束 flush 到 ContextSnapshot）。 */
  evidence?: SkillLoadEvidenceEntry[];
};

/** readSkillFile 加载证据条目（写入 ContextSnapshot.skillLoadEvidence）。 */
export type SkillLoadEvidenceEntry = {
  path: string;
  contentHash: string | null;
  truncated: boolean;
  skillVersionId: string;
  readAt: string;
};

/**
 * 全部 6 个工具（agent 全生命周期常驻，不再按 step 挂载）。
 *
 * Phase 1 工具：writeFile / readFile / listFiles / runCommand / runTests / reportReady
 * Phase 2 Stage B：全部经 executeToolRun 统一包裹，落 tool_runs + tool.* 事件。
 * 后续 Phase 补充：applyPatch / deleteFile / searchFiles 等
 *
 * Phase 3：抽成独立工厂，供 buildTools 按白名单收敛后返回；类型由 ReturnType 推导，
 * 保证无白名单调用方（如测试）仍享命名属性访问（noUncheckedIndexedAccess 下不丢精度）。
 *
 * Phase 5 Stage A：文件读写经 `WorkspaceStore`、命令执行经 `ExecutionRuntime`（resolveRuntimes
 * 注入），不再直接调 `lib/workspace` / execa。本轮恒 host 实现，行为零变更；container 模式
 * （Stage B）由 registry 切换 ExecutionRuntime 实现，本文件无感。
 */
function allTools(
  threadId: string,
  runtimeType: RuntimeType | undefined,
  skillContext: SkillContext | undefined,
  customDeclarations: CustomToolDeclaration[] = [],
  /**
   * V3.5：注入的 runtime handle（供子代理用 ScopedWorkspaceStore 收窄写范围）。
   * 缺省 → resolveRuntimes(threadId, runtimeType)（零回归，主链路行为不变）。
   */
  injectedRuntimes?: RuntimeHandle,
  /**
   * V6-Batch1-M1：AbortSignal 注入，让工具执行响应取消。
   * 缺省 → undefined（工具不响应取消，向后兼容）。
   */
  abortSignal?: AbortSignal,
) {
  const rt = injectedRuntimes ?? resolveRuntimes(threadId, runtimeType);
  const { workspace, execution, preview } = rt;
  return {
    // V3.1 Stage C：读与搜索工具（readFileRange/statFile/glob/grep）
    ...buildFileSearchTools(threadId, rt),
    // V3.1 Stage D：编辑、patch 与删除工具（editFile/multiEditFile/applyPatch/deleteFile）
    ...buildFileEditTools(threadId, rt),
    // V3.2 Stage C：后台任务四件套（startBackgroundTask/readTaskLogs/stopBackgroundTask/listBackgroundTasks）
    ...buildCommandTaskTools(threadId, rt, runtimeType),
    // V3.2 Stage D：工程命令工具（runBuild/installDependencies）
    ...buildCommandBuildTools(threadId, rt, runtimeType),
    // V3.7 Stage B/C：git / delivery 工具组（gitStatus/gitDiff/gitCheckpoint/gitRestoreCheckpoint/gitCreateBranch/gitCommit/gitPush + createPullRequest/deliverySummary）
    ...buildGitTools(threadId),
    // V3.3b Stage D：长期记忆工具（rememberFact，经 executeToolRun 收口）
    ...buildMemoryTools(threadId),
    // V3.4 Stage B：web / docs 工具（webFetch/webSearch/searchDocs，经 executeToolRun + 域名治理）
    ...buildWebTools(threadId),
    // V3.4 Stage C：MCP 通用入口（listMcpTools/callMcpTool，经 executeToolRun + mcpEvaluate 默认 ask）
    ...buildMcpTools(threadId),
    // V3.4 Stage D：自定义工具（webhook/script executor，经 executeToolRun + customEvaluate 默认 ask）
    // declarations 由调用方异步预加载后传入（保持 buildTools 同步、零回归）；空 → 无自定义工具
    ...buildCustomTools(threadId, customDeclarations),
    // V3.5 Stage C：子代理控制工具（spawnSubagent/joinSubagent，父 agent 派生并行子代理用）
    ...buildSubagentControlTools(threadId),
    // V3.6 Stage B/C：浏览器 QA 工具五件套（capturePreview/runBrowserCheck/runResponsiveCheck/
    // runAccessibilitySmoke/visualVerdict），Playwright 驱动，证据落 .snow/runtime artifact
    ...buildQaTools(threadId, rt, runtimeType),
    // V3.8 Stage D：部署工具（deployToEnvironment/deployStatus/rollback），经 CI/CD webhook 交接
    ...buildDeployTools(threadId),
    // V9 阶段 6：AI 浏览器工具（browserGetTabs/snapshot/getConsole/getNetwork/screenshot/
    // getPageText + navigate/click/type/scroll/pressKey/selectOption），经 executeToolRun + AI 操作锁
    ...buildBrowserTools(threadId),
    writeFile: tool({
      description: "在当前项目工作区写入或覆盖一个文件。生成项目代码时使用——每个文件调用一次。",
      inputSchema: z.object({
        path: z
          .string()
          .describe("相对工作区根的文件路径，如 index.html、src/main.js、package.json"),
        content: z.string().describe("文件的完整内容"),
      }),
      execute: async ({ path, content }) => {
        try {
          return await executeToolRun(
            threadId,
            "writeFile",
            { path, content },
            async (signal) => {
              // 审计修复：加 per-path 互斥锁，与 editFile/multiEditFile 对齐。
              // 原实现无锁 → 并发写入同路径时后者静默覆盖前者，数据丢失。
              return withPathLock(`${threadId}:${path}`, async () => {
                const written = await workspace.write(path, content);
                return { ok: true, path: written, bytes: content.length };
              });
            },
            { abortSignal },
          );
        } catch (error) {
          return { ok: false, path, error: (error as Error).message };
        }
      },
    }),

    readFile: tool({
      description:
        "读取工作区中的一个文件内容。用于查看已有文件、检查代码、或读取配置。" +
        "大文件(>2000 行或 >256KB)自动截断并返回 truncated:true,提示用 readFileRange 分段读。" +
        "二进制文件返回 ok:false(不支持)。避免一次性灌入超大文件撑爆上下文。",
      inputSchema: z.object({
        path: z.string().describe("相对工作区根的文件路径，如 src/main.js"),
      }),
      execute: async ({ path }) => {
        try {
          return await executeToolRun(
            threadId,
            "readFile",
            { path },
            async (signal) => {
              try {
                const content = await workspace.read(path);
                if (content === null) {
                  return { ok: false, path, error: "文件不存在" };
                }
                // P0 修复(01 AI Core P0-1): readFile 大小限制,防撑爆上下文。
                // 对齐 readFileRange 的 2000 行上限 + 加字节上限(256KB)防单行超长文件。
                const MAX_LINES = 2000;
                const MAX_BYTES = 256 * 1024;
                const byteLength = Buffer.byteLength(content, "utf8");
                if (byteLength > MAX_BYTES) {
                  // 按字节截断(不破坏 UTF-8 边界:从 MAX_BYTES 往前找到完整字符)
                  let cut = MAX_BYTES;
                  while (cut > 0 && (content.charCodeAt(cut) & 0xc0) === 0x80) cut--;
                  const truncated = content.slice(0, cut);
                  const lines = truncated.split("\n").length;
                  return {
                    ok: true,
                    path,
                    content: truncated,
                    truncated: true,
                    truncatedReason: `文件过大(${byteLength} bytes),已截断到 ${cut} bytes / ${lines} 行。用 readFileRange 分段读取完整内容`,
                  };
                }
                const lines = content.split("\n");
                if (lines.length > MAX_LINES) {
                  const truncated = lines.slice(0, MAX_LINES).join("\n");
                  return {
                    ok: true,
                    path,
                    content: truncated,
                    truncated: true,
                    truncatedReason: `文件行数超限(${lines.length} > ${MAX_LINES}),已截断前 ${MAX_LINES} 行。用 readFileRange 读取后续内容`,
                    totalLines: lines.length,
                  };
                }
                return { ok: true, path, content };
              } catch (error) {
                return { ok: false, path, error: (error as Error).message };
              }
            },
            { abortSignal },
          );
        } catch (error) {
          return { ok: false, path, error: (error as Error).message };
        }
      },
    }),

    listFiles: tool({
      description:
        "列出工作区中所有文件的相对路径。用于了解当前项目结构。" +
        "默认排除 node_modules/.git/dist/build 等依赖/产物目录,结果限 1000 条。" +
        "超限返回 truncated:true,提示用 glob 精确匹配。避免全量返回 10 万级文件撑爆上下文。",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return await executeToolRun(
            threadId,
            "listFiles",
            {},
            async (signal) => {
              // P0 修复(01 AI Core P0-2): listFiles 结果限制,防撑爆上下文。
              // 默认排除依赖/产物目录(对齐 .gitignore 常见项),结果限 1000 条。
              const EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", ".next", ".snow"];
              const MAX_FILES = 1000;
              const all = await workspace.list();
              const filtered = all.filter((f) => {
                const parts = f.split("/");
                return !parts.some((p) => EXCLUDE_DIRS.includes(p));
              });
              if (filtered.length > MAX_FILES) {
                return {
                  ok: true,
                  files: filtered.slice(0, MAX_FILES),
                  truncated: true,
                  truncatedReason: `文件数超限(${filtered.length} > ${MAX_FILES},已排除 node_modules/.git 等),已截断前 ${MAX_FILES} 条。用 glob 精确匹配`,
                  totalFiles: filtered.length,
                };
              }
              return { ok: true, files: filtered };
            },
            { abortSignal },
          );
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    }),

    runCommand: tool({
      description:
        "在工作区目录中执行一个 shell 命令。用于安装依赖、运行构建、启动开发服务器等。命令有 30 秒超时。",
      inputSchema: z.object({
        command: z.string().describe("要执行的 shell 命令，如 npm install、npx vite build"),
      }),
      execute: async ({ command }) => {
        try {
          return await executeToolRun(
            threadId,
            "runCommand",
            { command },
            async (signal) => {
              return await execution.exec(command, {
                timeoutMs: resolveToolTimeoutMs("runCommand"),
                signal,
              });
            },
            { abortSignal },
          );
        } catch (error) {
          return {
            ok: false,
            exitCode: -1,
            stdout: "",
            stderr: (error as Error).message,
            command,
          };
        }
      },
    }),

    runTests: tool({
      description: "运行项目测试。在工作区目录中执行测试命令（默认 npm test），返回结果。",
      inputSchema: z.object({
        command: z.string().optional().describe("自定义测试命令。不传则使用 npm test"),
      }),
      execute: async ({ command }) => {
        const testCmd = command ?? "npm test";
        try {
          return await executeToolRun(
            threadId,
            "runTests",
            { command: testCmd },
            async (signal) => {
              return await execution.exec(testCmd, {
                timeoutMs: resolveToolTimeoutMs("runTests"),
                signal,
              });
            },
            { abortSignal },
          );
        } catch (error) {
          return {
            ok: false,
            exitCode: -1,
            stdout: "",
            stderr: (error as Error).message,
            command: testCmd,
          };
        }
      },
    }),

    reportReady: tool({
      description:
        "当且仅当你已完成自检后调用，声明项目已经可以交付预览。后端会真实启动预览并探活；" +
        "通过才会打开预览，失败会把原因返回给你继续修复。",
      inputSchema: z.object({
        summary: z.string().describe("一句话说明做了什么，以及完成了哪些自检"),
      }),
      execute: async ({ summary }) => {
        try {
          return await executeToolRun(
            threadId,
            "reportReady",
            { summary },
            (signal) => reportThreadReady(threadId, summary, runtimeType),
            { abortSignal },
          );
        } catch (error) {
          return { ok: false, error: (error as Error).message, summary };
        }
      },
    }),

    // Skill 加载工具：仅在有 skillContext 时挂载（无 skill 的会话不暴露 readSkillFile，工具数不变）
    ...(skillContext
      ? {
          readSkillFile: tool({
            description:
              "读取当前 skill 目录中的文件。skill 的完整工作指令在 SKILL.md 中——**首先调用本工具读 SKILL.md**，" +
              "按其指引工作；需要参考资料时再读取目录内其他文件（如 references/xxx.md）。",
            inputSchema: z.object({
              path: z.string().describe("相对 skill 根的文件路径，如 SKILL.md、references/api.md"),
            }),
            execute: async ({ path }) => {
              try {
                return await executeToolRun(
                  threadId,
                  "readSkillFile",
                  { path },
                  async () => {
                    // 02 文档 §六.3：readSkillFile 只读本地 commitSha 快照。
                    const content = await readSkillFileAtSha(
                      skillContext.name,
                      path,
                      skillContext.commitSha,
                    );
                    if (content === null) return { ok: false, path, error: "文件不存在" };
                    const evidenceHash = createHash("sha256")
                      .update(content)
                      .digest("hex")
                      .slice(0, 16);
                    // 记录 Skill 文件加载证据（运行结束 flush 到 ContextSnapshot）
                    if (skillContext.evidence) {
                      skillContext.evidence.push({
                        path,
                        contentHash: evidenceHash,
                        truncated: false,
                        skillVersionId: skillContext.skillVersionId ?? "",
                        readAt: new Date().toISOString(),
                      });
                    }
                    return { ok: true, path, content };
                  },
                  { abortSignal },
                );
              } catch (error) {
                return { ok: false, path, error: (error as Error).message };
              }
            },
          }),
        }
      : {}),

    // Phase 5 Stage E：预览控制三工具（蓝图 §7.2 全集补齐）。经 executeToolRun 包裹，调 PreviewRuntime。
    startPreview: tool({
      description:
        "显式启动当前会话的预览（静态站点或 dev server，按 runtimeType 自动选择）。" +
        "返回可访问的预览相对路径 /preview/{threadId}/。reportReady 已内置启动+探活，通常无需手动调。",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return await executeToolRun(threadId, "startPreview", {}, async () => {
            const handle = await preview.start(threadId);
            return {
              ok: true,
              url: `/preview/${threadId}/`,
              port: handle.port,
              kind: handle.kind,
            };
          });
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    }),

    stopPreview: tool({
      description: "停止当前会话的预览（关闭静态 server 或回收容器）。释放端口与容器资源。",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return await executeToolRun(threadId, "stopPreview", {}, async () => {
            await preview.stop(threadId);
            return { ok: true };
          });
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    }),

    getPreviewStatus: tool({
      description: "查询当前会话预览状态（idle / starting / ready / failed）与端口、类型。",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return await executeToolRun(threadId, "getPreviewStatus", {}, async () => {
            const status = preview.status(threadId);
            return { ok: true, status: status ?? { state: "idle" } };
          });
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    }),
  };
}

/** 全部工具的命名类型（重载返回类型用）。 */
type AllTools = ReturnType<typeof allTools>;
type AnyTool = AllTools[keyof AllTools];

/**
 * 构造 agent 可见工具集（Phase 3 §6.2）。
 *
 * - 不传 / 传 null → 返回全部工具（无限制）
 * - 传入空数组 [] → 仅保留强制注入的 readSkillFile（审计修复：原 [] 等同 null 是安全漏洞）
 * - 传入 allowedTools → 只保留名字在白名单内的工具；agent 看不到白名单外工具
 *
 * V8 阶段 6：chat 路径不再传 allowedTools（Skill 的 allowedTools 不再作为工具可见性边界）；
 * 工具安全边界由 permission policy（fail-closed）处理，与 Skill 声明正交。
 * subagent 路径仍用此参数做子代理可见工具过滤（与 Skill 安全边界无关）。
 *
 * 实现层每个工具仍经 executeToolRun 包裹（Phase 2 不回归）。
 */
export function buildTools(
  threadId: string,
  allowedTools?: string[] | null,
  runtimeType?: RuntimeType,
  skillContext?: SkillContext,
  customDeclarations?: CustomToolDeclaration[],
  injectedRuntimes?: RuntimeHandle,
  /** V6-Batch1-M1：AbortSignal 注入，让工具执行响应取消。 */
  abortSignal?: AbortSignal,
): AllTools;
export function buildTools(
  threadId: string,
  allowedTools: string[] | null | undefined,
  runtimeType?: RuntimeType,
  skillContext?: SkillContext,
  customDeclarations?: CustomToolDeclaration[],
  injectedRuntimes?: RuntimeHandle,
  abortSignal?: AbortSignal,
): Record<string, AnyTool>;
export function buildTools(
  threadId: string,
  allowedTools?: string[] | null,
  runtimeType?: RuntimeType,
  skillContext?: SkillContext,
  customDeclarations?: CustomToolDeclaration[],
  injectedRuntimes?: RuntimeHandle,
  abortSignal?: AbortSignal,
) {
  const all = allTools(
    threadId,
    runtimeType,
    skillContext,
    customDeclarations ?? [],
    injectedRuntimes,
    abortSignal,
  );
  // 审计修复：区分 undefined/null（无限制 → 返回全部工具）与显式空数组（[] → 无工具可用，
  // 仅保留强制注入的 readSkillFile）。原代码把两者同等对待，导致 skill 声明 tools: [] 时
  // 反而拿到全部工具，形成 allowlist 绕过漏洞。
  if (allowedTools === undefined || allowedTools === null) return all;
  const allow = new Set(allowedTools);
  // readSkillFile 是 skill 加载机制本身，常驻可见，不受 skill.allowedTools 白名单限制
  allow.add("readSkillFile");
  const filtered: Record<string, AnyTool> = {};
  for (const [name, t] of Object.entries(all)) {
    if (allow.has(name)) filtered[name] = t;
  }
  return filtered;
}
