import type { WorkspacePanelView } from "@/components/workspace-panel/types";

/**
 * V5-D1：会话产物选择规则。
 *
 * Agent 完成阶段后，右侧自动打开最适合员工验收的产物。规则（按优先级）：
 * 1. previewUrl 存在 → app 视图（reportReady 成功的站点 / dev server，
 * V9 阶段 5 起统一在内置浏览器打开，不再用 preview iframe）
 * 2. README.md / README.markdown → file 视图（员工最先想看的交付文档）
 * 3. 任意 *.md（非 README）→ file 视图（Markdown 交付文档）
 * 4. index.html → file 视图（静态页面，员工用 FileViewer 沙盒渲染预览效果；
 * 注意：这不是 previewUrl，员工要真正启动预览应调 reportReady）
 * 5. 任意 *.pdf → file 视图（PDF 交付物）
 * 6. 有文件但都是代码 / 配置 → file 视图但 path="" （打开文件列表，不预选内部文件，
 * 避免自动打开 src/app.js 这种员工不关心的中间产物）
 * 7. 无文件 → null（右侧保持空态，WorkspacePanel 不渲染）
 *
 * 内部目录文件（.snow/、node_modules/ 等）不应出现在 files 中——
 * list API 已默认 skipInternal=true。本函数不重复判定，信任入参。
 *
 * @param files 工作区文件相对路径列表（已排除内部目录）
 * @param previewUrl reportReady 成功后写入的预览 URL，无则 undefined
 * @param threadId 当前会话 ID（保留用于未来扩展）
 */
export function selectArtifactView({
 files,
 previewUrl,
 threadId,
}: {
 files: string[];
 previewUrl?: string;
 threadId: string;
}): WorkspacePanelView | null {
 // 1. previewUrl 最优先——reportReady 成功的站点。V9 阶段 5：改用 app 视图，
 // 在内置浏览器打开运行页（BrowserPanel 监听 openAppSignal 触发 openApp）
 if (previewUrl) {
 return { kind: "app" };
 }

 // 排除内部目录（防御：list API 已过滤，但本函数可能被其它路径调用）
 const visible = files.filter((f) => f && !f.startsWith("."));
 if (visible.length === 0) return null;

 // 2. README.md / README.markdown（任意大小写）
 const readme = visible.find((f) => /^readme\.(md|markdown)$/i.test(f));
 if (readme) return { kind: "file", path: readme };

 // 3. 任意 *.md（非 README）—— 取首个，按字母序
 const md = visible
 .filter((f) => f.endsWith(".md") || f.endsWith(".markdown"))
 .sort((a, b) => a.localeCompare(b))[0];
 if (md) return { kind: "file", path: md };

 // 4. index.html（员工用 FileViewer 沙盒预览静态页面）
 const indexHtml = visible.find((f) => f === "index.html" || f.endsWith("/index.html"));
 if (indexHtml) return { kind: "file", path: indexHtml };

 // 5. 任意 *.pdf
 const pdf = visible.filter((f) => f.endsWith(".pdf")).sort((a, b) => a.localeCompare(b))[0];
 if (pdf) return { kind: "file", path: pdf };

 // 6. 有文件但都是代码 / 配置 → 打开文件列表，不预选
 return { kind: "file", path: "" };
}

/**
 * V5-D1：判断给定状态是否为「run 结束」。
 * 用于触发自动产物选择；执行中不能扫文件，否则会把上一次 run 的旧产物自动打开。
 */
export function isRunFinished(status: string): boolean {
 return (
 status !== "submitted" &&
 status !== "streaming" &&
 status !== "executing" &&
 status !== "awaiting_approval" &&
 status !== "awaiting_input" &&
 status !== "delivering"
 );
}
