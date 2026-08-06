/**
 * ：内置工具统一元数据 registry。
 *
 * 目的：为后续权限引擎、context manifest、Studio 展示和审计提供稳定的工具元数据来源。
 * 只登记现有内置工具，**不新增 agent 可见工具**，不改变 `buildTools` 的可见集合
 * 与 skill `allowedTools` 过滤语义。
 *
 * 元数据来源是静态声明，而非运行时从 tool 实现推断——权限审计需要显式、可审查的来源。
 */

/** 工具分类。 */
export type ToolCategory =
 | "file"
 | "command"
 | "test"
 | "delivery"
 | "skill"
 | "preview"
 | "memory";

/**
 * 风险等级（取自蓝图 ）。
 * - read：只读
 * - write：写工作区
 * - execute：启动进程 / 执行命令
 * - network：外部网络访问（暂无工具使用）
 * - delivery：交付/发布动作
 */
export type ToolRisk = "read" | "write" | "execute" | "network" | "delivery";

/** 工具可见条件。 */
export type ToolAvailability = "always" | "skillContext" | "previewRuntime";

export type ToolMetadata = {
 /** 工具名，与 agent 可见 tool key 完全一致。 */
 name: string;
 /** UI 展示名。 */
 displayName: string;
 /** 简短用途。 */
 description: string;
 category: ToolCategory;
 risk: ToolRisk;
 /** 后续权限 matcher 使用的 key，如 tool.writeFile。 */
 permissionKey: string;
 /** 是否读 workspace。 */
 readsWorkspace: boolean;
 /** 是否写 workspace。 */
 writesWorkspace: boolean;
 /** 是否启动进程。 */
 startsProcess: boolean;
 /** 是否可能产生 artifact。 */
 createsArtifact: boolean;
 /** 可见条件。 */
 availableWhen: ToolAvailability;
 /**
 * 工具默认超时（ms）。execute 类工具的硬编码超时统一收口到元数据 +
 * `resolveToolTimeoutMs`，运维可经 env 覆盖。0/undefined=用全局默认。
 */
 defaultTimeoutMs?: number;
 /** 工具超时硬上限（ms），resolveToolTimeoutMs 取 min(caller, default, max)。 */
 maxTimeoutMs?: number;
};

/**
 * 全部内置工具的元数据。`readSkillFile` 仅在 skillContext 存在时挂载，
 * 其余 9 个常驻；与 `buildTools(allTools)` 的 key 集合保持一致。
 */
const REGISTRY: readonly ToolMetadata[] = [
 {
 name: "writeFile",
 displayName: "写入文件",
 description: "在工作区新建或完整覆盖一个文件",
 category: "file",
 risk: "write",
 permissionKey: "tool.writeFile",
 readsWorkspace: false,
 writesWorkspace: true,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "editFile",
 displayName: "编辑文件",
 description: "对文件做唯一匹配的局部替换（最小 diff）",
 category: "file",
 risk: "write",
 permissionKey: "tool.editFile",
 readsWorkspace: true,
 writesWorkspace: true,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "multiEditFile",
 displayName: "批量编辑文件",
 description: "对文件顺序应用多处替换，任一非唯一则原子回滚",
 category: "file",
 risk: "write",
 permissionKey: "tool.multiEditFile",
 readsWorkspace: true,
 writesWorkspace: true,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "applyPatch",
 displayName: "应用补丁",
 description: "应用受约束的 unified diff patch（多文件局部改动）",
 category: "file",
 risk: "write",
 permissionKey: "tool.applyPatch",
 readsWorkspace: true,
 writesWorkspace: true,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "deleteFile",
 displayName: "删除文件",
 description: "删除工作区中一个文件（不可逆，默认需审批）",
 category: "file",
 risk: "write",
 permissionKey: "tool.deleteFile",
 readsWorkspace: false,
 writesWorkspace: true,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "readFile",
 displayName: "读取文件",
 description: "读取工作区中一个文件的内容",
 category: "file",
 risk: "read",
 permissionKey: "tool.readFile",
 readsWorkspace: true,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "readFileRange",
 displayName: "读取文件片段",
 description: "读取工作区中一个文件的指定行范围（带行号）",
 category: "file",
 risk: "read",
 permissionKey: "tool.readFileRange",
 readsWorkspace: true,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "statFile",
 displayName: "查看文件信息",
 description: "查看工作区中一个文件的大小、修改时间、是否目录",
 category: "file",
 risk: "read",
 permissionKey: "tool.statFile",
 readsWorkspace: true,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "glob",
 displayName: "文件名匹配",
 description: "按 glob 模式匹配工作区内文件路径（默认尊重 .gitignore）",
 category: "file",
 risk: "read",
 permissionKey: "tool.glob",
 readsWorkspace: true,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "grep",
 displayName: "内容搜索",
 description: "在工作区文件内容中搜索正则，返回结构化匹配（默认尊重 .gitignore）",
 category: "file",
 risk: "read",
 permissionKey: "tool.grep",
 readsWorkspace: true,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "listFiles",
 displayName: "列出文件",
 description: "列出工作区中所有文件的相对路径",
 category: "file",
 risk: "read",
 permissionKey: "tool.listFiles",
 readsWorkspace: true,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "runCommand",
 displayName: "执行命令",
 description: "在工作区执行 shell 命令，带超时",
 category: "command",
 risk: "execute",
 permissionKey: "tool.runCommand",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 defaultTimeoutMs: 30_000,
 maxTimeoutMs: 300_000,
 },
 {
 name: "runTests",
 displayName: "运行测试",
 description: "运行项目测试命令并返回结果",
 category: "test",
 risk: "execute",
 permissionKey: "tool.runTests",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 defaultTimeoutMs: 60_000,
 maxTimeoutMs: 300_000,
 },
 {
 name: "reportReady",
 displayName: "声明就绪",
 description: "声明项目可交付预览，后端启动预览并探活",
 category: "delivery",
 risk: "delivery",
 permissionKey: "tool.reportReady",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "readSkillFile",
 displayName: "读取 Skill 文件",
 description: "读取当前 skill 目录快照中的文件（按 commitSha）",
 category: "skill",
 risk: "read",
 permissionKey: "tool.readSkillFile",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "skillContext",
 },
 {
 name: "startPreview",
 displayName: "启动预览",
 description: "显式启动当前会话预览（静态站点或 dev server）",
 category: "preview",
 risk: "execute",
 permissionKey: "tool.startPreview",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "stopPreview",
 displayName: "停止预览",
 description: "停止当前会话预览，释放端口与容器资源",
 category: "preview",
 risk: "execute",
 permissionKey: "tool.stopPreview",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "getPreviewStatus",
 displayName: "预览状态",
 description: "查询当前会话预览状态与端口、类型",
 category: "preview",
 risk: "read",
 permissionKey: "tool.getPreviewStatus",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 // ─── Stage C：后台任务四件套（plan §7） ───────────────
 {
 name: "startBackgroundTask",
 displayName: "启动后台任务",
 description: "在后台启动长跑命令（dev server/watcher/worker），立即返回 taskId 不阻塞会话",
 category: "command",
 risk: "execute",
 permissionKey: "tool.startBackgroundTask",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "readTaskLogs",
 displayName: "读取任务日志",
 description: "读取后台任务日志片段（offset/tail/window），限长不灌入全量日志",
 category: "command",
 risk: "read",
 permissionKey: "tool.readTaskLogs",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "stopBackgroundTask",
 displayName: "停止后台任务",
 description: "停止一个后台任务并回收进程树（host tree-kill 整组）",
 category: "command",
 risk: "execute",
 permissionKey: "tool.stopBackgroundTask",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "listBackgroundTasks",
 displayName: "列出后台任务",
 description: "列出当前 thread 的所有后台任务及状态",
 category: "command",
 risk: "read",
 permissionKey: "tool.listBackgroundTasks",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 // ─── Stage D：工程命令工具（plan §8） ─────────────────
 {
 name: "runBuild",
 displayName: "运行构建",
 description: "运行项目构建命令（默认 npm run build），120s 超时；走既有 deny-list",
 category: "command",
 risk: "execute",
 permissionKey: "tool.runBuild",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 defaultTimeoutMs: 120_000,
 maxTimeoutMs: 300_000,
 },
 {
 name: "installDependencies",
 displayName: "安装依赖",
 description: "安装项目依赖（默认 npm install），默认需审批；postinstall/lockfile/联网高风险",
 category: "command",
 risk: "execute",
 permissionKey: "tool.installDependencies",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 defaultTimeoutMs: 180_000,
 maxTimeoutMs: 300_000,
 },
 // ─── Stage B/C：git / delivery 工具组（plan §6/§7） ────
 {
 name: "gitStatus",
 displayName: "Git 状态",
 description: "查看工作区 git 状态（staged/modified/untracked），只读",
 category: "delivery",
 risk: "read",
 permissionKey: "tool.gitStatus",
 readsWorkspace: true,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "gitDiff",
 displayName: "Git 差异",
 description: "查看工作区未暂存改动（限长 diff），只读",
 category: "delivery",
 risk: "read",
 permissionKey: "tool.gitDiff",
 readsWorkspace: true,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "gitCheckpoint",
 displayName: "创建 Checkpoint",
 description: "在当前 HEAD 打轻量 tag 快照（snow-checkpoint-*），供 rollback；默认需审批",
 category: "delivery",
 risk: "delivery",
 permissionKey: "tool.gitCheckpoint",
 readsWorkspace: false,
 writesWorkspace: true,
 startsProcess: false,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "gitRestoreCheckpoint",
 displayName: "回滚 Checkpoint",
 description: "git reset --hard 到指定 checkpoint（不可逆），默认需审批",
 category: "delivery",
 risk: "delivery",
 permissionKey: "tool.gitRestoreCheckpoint",
 readsWorkspace: false,
 writesWorkspace: true,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "gitCreateBranch",
 displayName: "创建分支",
 description: "从当前 HEAD 创建并切换到新分支；默认需审批",
 category: "delivery",
 risk: "delivery",
 permissionKey: "tool.gitCreateBranch",
 readsWorkspace: false,
 writesWorkspace: true,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "gitCommit",
 displayName: "Git 提交",
 description:
 "暂存并提交改动（Lore trailer 协议：Constraint/Rejected/Confidence 等）；默认需审批",
 category: "delivery",
 risk: "delivery",
 permissionKey: "tool.gitCommit",
 readsWorkspace: true,
 writesWorkspace: true,
 startsProcess: false,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "gitPush",
 displayName: "Git 推送",
 description: "推送到远程分支（默认非 force，设上游）；默认需审批",
 category: "delivery",
 risk: "delivery",
 permissionKey: "tool.gitPush",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "createPullRequest",
 displayName: "创建 Pull Request",
 description:
 "为已推送分支创建 Pull/Merge Request（GitHub gh/API、GitLab API，其他 remote 回退链接）；默认需审批",
 category: "delivery",
 risk: "delivery",
 permissionKey: "tool.createPullRequest",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "deliverySummary",
 displayName: "交付摘要",
 description: "聚合生成交付摘要（文件变更/测试/预览/commit/PR 链接/blindCommit），只读",
 category: "delivery",
 risk: "read",
 permissionKey: "tool.deliverySummary",
 readsWorkspace: true,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "rememberFact",
 displayName: "记住事实",
 description: "把一条高信号、可复用的事实写入长期记忆（带来源、可审计、可撤销）",
 category: "memory",
 risk: "read",
 permissionKey: "tool.rememberFact",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 // ─── Stage B：web / docs 工具（外部资料访问，蓝图 ） ────
 // category 复用 command（不扩 ToolCategory enum，§12 决策）；risk=network。
 // 权限经域名治理（domainEvaluate 覆盖 executeToolRun）：域内 allow / 域外 ask / 黑名单 deny。
 {
 name: "webFetch",
 displayName: "抓取网页",
 description:
 "抓取一个 URL 并确定性抽取正文（域名 allowlist 治理，原文落 artifact，带来源标记）",
 category: "command",
 risk: "network",
 permissionKey: "web.fetch",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "webSearch",
 displayName: "网络搜索",
 description: "网络搜索（DuckDuckGo，结果按域名 allowlist 过滤，带来源标记）",
 category: "command",
 risk: "network",
 permissionKey: "web.search",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "searchDocs",
 displayName: "搜索文档",
 description:
 "在官方文档域 allowlist 内搜索（优先本地全文索引，支持索引构建/刷新；未配置索引时降级域限定 webSearch）",
 category: "command",
 risk: "network",
 permissionKey: "docs.search",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 // ─── Stage C：MCP 通用入口（蓝图 ） ────
 // listMcpTools 列工具；callMcpTool 调用，permissionKey 动态派生 mcp.<server>.<tool>
 // （registry 记静态通用 key mcp.list/mcp.call；callMcpTool 运行时用 override 覆盖）。
 // 默认 ask（外部不可信），由 lib/mcp/tools.ts#mcpEvaluate 表达。
 {
 name: "listMcpTools",
 displayName: "列出 MCP 工具",
 description: "列出一个或全部已启用 MCP server 的工具，工具名归一 mcp.<server>.<tool>",
 category: "command",
 risk: "read",
 permissionKey: "mcp.list",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "callMcpTool",
 displayName: "调用 MCP 工具",
 description: "调用一个 MCP server 的工具（permissionKey=mcp.<server>.<tool>，默认需审批）",
 category: "command",
 risk: "execute",
 permissionKey: "mcp.call",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: false,
 availableWhen: "always",
 },
 // 子代理并行工作流（蓝图 ）。category 复用 command（不扩 ToolCategory enum）。
 // spawnSubagent 派生子代理（高资源：独立 streamText + 工具执行），默认 ask；joinSubagent 读结果，默认 allow。
 {
 name: "spawnSubagent",
 displayName: "派生子代理",
 description: "异步派生一个子代理执行有界工作单元（只读探索/研究/审查/验证），返回 runId",
 category: "command",
 risk: "execute",
 permissionKey: "tool.spawnSubagent",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "joinSubagent",
 displayName: "汇合子代理",
 description: "等待子代理 run 完成并返回结构化结果（经 outputSchema 校验）",
 category: "command",
 risk: "read",
 permissionKey: "tool.joinSubagent",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "joinSubagents",
 displayName: "批量汇合子代理",
 description:
 "P0 修复（真并行）：批量等待多个子代理 run 完成（Promise.all），实现真正并行子代理",
 category: "command",
 risk: "read",
 permissionKey: "tool.joinSubagents",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 // ─── Stage B/C：浏览器 QA 工具五件套（plan §6/§7） ────
 // category 复用 preview（不扩 ToolCategory enum，§12 决策）；QA 工具 host 侧跑 Playwright。
 // capturePreview/runBrowserCheck/runResponsiveCheck/runAccessibilitySmoke 风险 read + createsArtifact；
 // visualVerdict 是可选 LLM 自检，gate 不依赖它。
 {
 name: "capturePreview",
 displayName: "预览截图",
 description: "对当前会话预览用 Playwright 截图（指定 viewport），截图落 artifact",
 category: "preview",
 risk: "read",
 permissionKey: "tool.capturePreview",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "runBrowserCheck",
 displayName: "浏览器检查",
 description:
 "确定性浏览器检查：console error / 未捕获异常 / network 404 / 白屏，证据落 artifact",
 category: "preview",
 risk: "read",
 permissionKey: "tool.runBrowserCheck",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "runResponsiveCheck",
 displayName: "响应式检查",
 description: "多 viewport 响应式布局断言：水平溢出 / 内容不可见 / 响应式破坏，证据落 artifact",
 category: "preview",
 risk: "read",
 permissionKey: "tool.runResponsiveCheck",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "runAccessibilitySmoke",
 displayName: "a11y 烟雾检查",
 description:
 "a11y 烟雾检查：img alt / 表单 label / 对比度 / Tab 顺序 / landmark，证据落 artifact",
 category: "preview",
 risk: "read",
 permissionKey: "tool.runAccessibilitySmoke",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: true,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "visualVerdict",
 displayName: "视觉评审",
 description:
 "对截图做结构化视觉评审（可选 LLM，无配置退化为确定性判断）；agent 自检，gate 不依赖",
 category: "preview",
 risk: "read",
 permissionKey: "tool.visualVerdict",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: true,
 availableWhen: "always",
 },
 // 部署工具（CI/CD webhook 交接，默认 ask，prod 强制 ask）
 {
 name: "deployToEnvironment",
 displayName: "部署到环境",
 description: "经 CI/CD webhook 触发部署到指定环境（staging/prod），默认需审批，prod 强制审批",
 category: "delivery",
 risk: "delivery",
 permissionKey: "tool.deployToEnvironment",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "deployStatus",
 displayName: "查询部署状态",
 description: "查询 CI/CD job 部署状态与日志链接",
 category: "delivery",
 risk: "read",
 permissionKey: "tool.deployStatus",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "rollback",
 displayName: "回滚部署",
 description: "经 CI/CD webhook 触发回滚到上一版部署，默认需审批",
 category: "delivery",
 risk: "delivery",
 permissionKey: "tool.rollback",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: true,
 availableWhen: "always",
 },
 // ─── V9 阶段 6：AI 浏览器工具（方案 §阶段 6） ───────────────
 // category 复用 preview（不扩 ToolCategory enum，§12 决策）。
 // 读取类 risk=read，操作类 risk=execute（经 AI 操作锁 acquireBrowserSessionLock）。
 // 所有工具经 executeToolRun 收口，落 tool_runs + tool.* 事件。
 {
 name: "browserGetTabs",
 displayName: "浏览器标签页",
 description: "列出当前 Thread 内置浏览器的全部标签页状态",
 category: "preview",
 risk: "read",
 permissionKey: "tool.browserGetTabs",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserSnapshot",
 displayName: "页面快照",
 description: "获取当前 active tab 的页面标题、可见文本和 accessibility tree 摘要",
 category: "preview",
 risk: "read",
 permissionKey: "tool.browserSnapshot",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserGetConsole",
 displayName: "控制台消息",
 description: "获取当前 active tab 的 console 消息（error/warning/pageerror）",
 category: "preview",
 risk: "read",
 permissionKey: "tool.browserGetConsole",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserGetNetwork",
 displayName: "网络请求",
 description: "获取当前 active tab 的网络请求摘要（失败请求/慢请求）",
 category: "preview",
 risk: "read",
 permissionKey: "tool.browserGetNetwork",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserScreenshot",
 displayName: "页面截图",
 description: "对当前 active tab 截图（PNG），保存到工作区 .snow/screenshots/",
 category: "preview",
 risk: "read",
 permissionKey: "tool.browserScreenshot",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: true,
 availableWhen: "always",
 },
 {
 name: "browserGetPageText",
 displayName: "页面文本",
 description: "获取当前 active tab 的页面纯文本内容（轻量，不含 a11y tree）",
 category: "preview",
 risk: "read",
 permissionKey: "tool.browserGetPageText",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserNavigate",
 displayName: "导航",
 description: "在内置浏览器中导航 active tab 到指定 URL",
 category: "preview",
 risk: "execute",
 permissionKey: "tool.browserNavigate",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserClick",
 displayName: "点击",
 description: "在当前 active tab 的页面上点击指定视口坐标",
 category: "preview",
 risk: "execute",
 permissionKey: "tool.browserClick",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserType",
 displayName: "输入文本",
 description: "在当前 active tab 中输入文本到当前聚焦元素",
 category: "preview",
 risk: "execute",
 permissionKey: "tool.browserType",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserScroll",
 displayName: "滚动",
 description: "在当前 active tab 中滚动页面（鼠标滚轮）",
 category: "preview",
 risk: "execute",
 permissionKey: "tool.browserScroll",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserPressKey",
 displayName: "按键",
 description: "在当前 active tab 中按下键盘按键（支持组合键）",
 category: "preview",
 risk: "execute",
 permissionKey: "tool.browserPressKey",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserSelectOption",
 displayName: "选择选项",
 description: "在当前 active tab 中选择 select 元素的选项",
 category: "preview",
 risk: "execute",
 permissionKey: "tool.browserSelectOption",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserListDownloads",
 displayName: "下载记录",
 description: "列出当前 Thread 内置浏览器的下载记录（只读）",
 category: "preview",
 risk: "read",
 permissionKey: "tool.browserListDownloads",
 readsWorkspace: false,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
 {
 name: "browserUploadFile",
 displayName: "上传文件",
 description: "上传 Thread 工作区文件到当前页面 file input 元素（仅限工作区内文件）",
 category: "preview",
 risk: "execute",
 permissionKey: "tool.browserUploadFile",
 readsWorkspace: true,
 writesWorkspace: false,
 startsProcess: false,
 createsArtifact: false,
 availableWhen: "always",
 },
];

const BY_NAME: ReadonlyMap<string, ToolMetadata> = new Map(REGISTRY.map((m) => [m.name, m]));

/** 全部内置工具名（稳定顺序）。 */
export const BUILTIN_TOOL_NAMES: readonly string[] = REGISTRY.map((m) => m.name);

/** 按名取元数据；未登记返回 null。 */
export function getToolMetadata(name: string): ToolMetadata | null {
 return BY_NAME.get(name) ?? null;
}

/** 列出全部内置工具元数据。 */
export function listToolMetadata(): readonly ToolMetadata[] {
 return REGISTRY;
}

/**
 * 按「本轮模型可见工具名」生成精简 manifest 条目，供 context manifest / 事件 payload 复用。
 * 未登记的名称会被跳过（不抛错，便于兼容未来动态工具）。
 */
export function getToolManifest(names: Iterable<string>): Array<{
 name: string;
 category: ToolCategory;
 risk: ToolRisk;
 permissionKey: string;
}> {
 const out: Array<{
 name: string;
 category: ToolCategory;
 risk: ToolRisk;
 permissionKey: string;
 }> = [];
 for (const name of names) {
 const m = BY_NAME.get(name);
 if (!m) continue;
 out.push({ name: m.name, category: m.category, risk: m.risk, permissionKey: m.permissionKey });
 }
 return out;
}
