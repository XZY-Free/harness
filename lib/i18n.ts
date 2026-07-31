/**
 * P2 修复（12 Studio P1-6 i18n）：轻量 i18n 字典。
 *
 * 12-P1-6：系统性迁移——DICT 字典覆盖 Studio 各面板 + chat-panel 用户可见文案。
 * 各组件用 t("key") 替代硬编码中文。STATUS_LABEL / TOOL_LABELS 保留独立导出（高频共享）。
 *
 * 不引入 next-intl 重框架,用简单字典 + t() 函数,按 locale 切换（当前仅 zh,预留 en 扩展）。
 *
 * 用法：
 *   import { t, STATUS_LABEL, TOOL_LABELS } from "@/lib/i18n";
 *   STATUS_LABEL[thread.status] // "执行中" (zh) / "Executing" (en)
 *   t("studio.subagent.empty") // "当前 thread 无子代理。"
 *
 * 缺 key 回退：t() 返回 key 本身（fail-open,不抛），便于发现遗漏。
 */

export type Locale = "zh" | "en";

/** 当前 locale（默认 zh,后续可从 cookie/header/user preference 读）。 */
export function getCurrentLocale(): Locale {
  // 预留：从 request cookie / Accept-Language / user preference 读
  // 当前固定 zh,全站中文,后续接 next-intl 或自建 locale 切换
  return "zh";
}

/** Thread 状态标签（各页面/面板共享）。 */
export const STATUS_LABEL: Record<Locale, Record<string, string>> = {
  zh: {
    idle: "空闲",
    executing: "执行中",
    ready_for_review: "待审核",
    failed: "失败",
    planning: "规划中",
    awaiting_input: "等待输入",
    awaiting_approval: "待审批",
    delivering: "交付中",
    completed: "已交付",
    verifying: "验证中",
    cancelled: "已取消",
  },
  en: {
    idle: "Idle",
    executing: "Executing",
    ready_for_review: "Ready for Review",
    failed: "Failed",
    planning: "Planning",
    awaiting_input: "Awaiting Input",
    awaiting_approval: "Awaiting Approval",
    delivering: "Delivering",
    completed: "Completed",
    verifying: "Verifying",
    cancelled: "Cancelled",
  },
};

/**
 * S1（12-P1-6）：子代理 run 状态标签（subagent-panel 共享,收敛局部硬编码字典）。
 * 与 thread STATUS_LABEL 不同——subagent run 有独立的 queued/timed_out 态。
 */
export const SUBAGENT_STATUS_LABEL: Record<Locale, Record<string, string>> = {
  zh: {
    queued: "排队",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    timed_out: "超时",
  },
  en: {
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    timed_out: "Timed Out",
  },
};

/** S1（12-P1-6）：plan item 状态标签（thread-plan-panel 共享）。 */
export const PLAN_ITEM_STATUS_LABEL: Record<Locale, Record<string, string>> = {
  zh: {
    pending: "待处理",
    in_progress: "进行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  },
  en: {
    pending: "Pending",
    in_progress: "In Progress",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  },
};

/** S1（12-P1-6）：deployment 状态标签（deployment-panel 共享）。 */
export const DEPLOYMENT_STATUS_LABEL: Record<Locale, Record<string, string>> = {
  zh: {
    deployed: "已部署",
    deploying: "部署中",
    pending: "等待中",
    failed: "失败",
    rolled_back: "已回滚",
  },
  en: {
    deployed: "Deployed",
    deploying: "Deploying",
    pending: "Pending",
    failed: "Failed",
    rolled_back: "Rolled Back",
  },
};

/** 便捷：按当前 locale 取 SUBAGENT_STATUS_LABEL。 */
export function subagentStatusLabel(status: string, locale: Locale = getCurrentLocale()): string {
  return SUBAGENT_STATUS_LABEL[locale]?.[status] ?? status;
}

/** 便捷：按当前 locale 取 PLAN_ITEM_STATUS_LABEL。 */
export function planItemStatusLabel(status: string, locale: Locale = getCurrentLocale()): string {
  return PLAN_ITEM_STATUS_LABEL[locale]?.[status] ?? status;
}

/** 便捷：按当前 locale 取 DEPLOYMENT_STATUS_LABEL。 */
export function deploymentStatusLabel(status: string, locale: Locale = getCurrentLocale()): string {
  return DEPLOYMENT_STATUS_LABEL[locale]?.[status] ?? status;
}

/** 工具显示名（chat-panel / tool-trace 共享）。 */
export const TOOL_LABELS: Record<Locale, Record<string, string>> = {
  zh: {
    writeFile: "写入文件",
    editFile: "编辑文件",
    multiEditFile: "批量编辑",
    applyPatch: "应用补丁",
    deleteFile: "删除文件",
    readFile: "读取文件",
    readFileRange: "分段读取",
    statFile: "文件信息",
    glob: "文件搜索",
    grep: "内容搜索",
    listFiles: "列出文件",
    runCommand: "运行命令",
    runTests: "运行测试",
    runBuild: "构建",
    installDependencies: "安装依赖",
    reportReady: "提交预览自检",
    startPreview: "启动预览",
    stopPreview: "停止预览",
    getPreviewStatus: "预览状态",
    startBackgroundTask: "启动后台任务",
    readTaskLogs: "读取任务日志",
    stopBackgroundTask: "停止后台任务",
    listBackgroundTasks: "列出后台任务",
    gitStatus: "Git 状态",
    gitDiff: "Git 差异",
    gitCheckpoint: "创建检查点",
    gitRestoreCheckpoint: "恢复检查点",
    gitCreateBranch: "创建分支",
    gitCommit: "提交",
    gitPush: "推送",
    createPullRequest: "创建 PR",
    deliverySummary: "交付摘要",
    rememberFact: "记忆事实",
    webFetch: "抓取网页",
    webSearch: "网络搜索",
    searchDocs: "搜索文档",
    listMcpTools: "列出 MCP 工具",
    callMcpTool: "调用 MCP 工具",
    spawnSubagent: "派生子代理",
    joinSubagent: "汇合子代理",
    joinSubagents: "批量汇合",
    capturePreview: "预览截图",
    runBrowserCheck: "浏览器检查",
    runResponsiveCheck: "响应式检查",
    runAccessibilitySmoke: "a11y 检查",
    visualVerdict: "视觉评审",
    deployToEnvironment: "部署",
    deployStatus: "部署状态",
    rollback: "回滚",
    // V9 阶段 6：AI 浏览器工具
    browserGetTabs: "浏览器标签页",
    browserSnapshot: "页面快照",
    browserGetConsole: "控制台消息",
    browserGetNetwork: "网络请求",
    browserScreenshot: "页面截图",
    browserGetPageText: "页面文本",
    browserNavigate: "导航",
    browserClick: "点击",
    browserType: "输入文本",
    browserScroll: "滚动",
    browserPressKey: "按键",
    browserSelectOption: "选择选项",
    // V9 阶段 8：下载与上传工具
    browserListDownloads: "下载记录",
    browserUploadFile: "上传文件",
  },
  en: {
    writeFile: "Write File",
    editFile: "Edit File",
    multiEditFile: "Multi Edit",
    applyPatch: "Apply Patch",
    deleteFile: "Delete File",
    readFile: "Read File",
    readFileRange: "Read Range",
    statFile: "Stat File",
    glob: "Glob",
    grep: "Grep",
    listFiles: "List Files",
    runCommand: "Run Command",
    runTests: "Run Tests",
    runBuild: "Build",
    installDependencies: "Install Deps",
    reportReady: "Report Ready",
    startPreview: "Start Preview",
    stopPreview: "Stop Preview",
    getPreviewStatus: "Preview Status",
    startBackgroundTask: "Start Background",
    readTaskLogs: "Read Task Logs",
    stopBackgroundTask: "Stop Background",
    listBackgroundTasks: "List Background",
    gitStatus: "Git Status",
    gitDiff: "Git Diff",
    gitCheckpoint: "Checkpoint",
    gitRestoreCheckpoint: "Restore Checkpoint",
    gitCreateBranch: "Create Branch",
    gitCommit: "Commit",
    gitPush: "Push",
    createPullRequest: "Create PR",
    deliverySummary: "Delivery Summary",
    rememberFact: "Remember Fact",
    webFetch: "Web Fetch",
    webSearch: "Web Search",
    searchDocs: "Search Docs",
    listMcpTools: "List MCP Tools",
    callMcpTool: "Call MCP Tool",
    spawnSubagent: "Spawn Subagent",
    joinSubagent: "Join Subagent",
    joinSubagents: "Join Subagents",
    capturePreview: "Capture Preview",
    runBrowserCheck: "Browser Check",
    runResponsiveCheck: "Responsive Check",
    runAccessibilitySmoke: "A11y Smoke",
    visualVerdict: "Visual Verdict",
    deployToEnvironment: "Deploy",
    deployStatus: "Deploy Status",
    rollback: "Rollback",
    // V9 Phase 6: AI browser tools
    browserGetTabs: "Browser Tabs",
    browserSnapshot: "Page Snapshot",
    browserGetConsole: "Console",
    browserGetNetwork: "Network",
    browserScreenshot: "Screenshot",
    browserGetPageText: "Page Text",
    browserNavigate: "Navigate",
    browserClick: "Click",
    browserType: "Type",
    browserScroll: "Scroll",
    browserPressKey: "Press Key",
    browserSelectOption: "Select Option",
    // V9 Phase 8: download & upload tools
    browserListDownloads: "Downloads",
    browserUploadFile: "Upload File",
  },
};

/**
 * 翻译函数（轻量,后续可扩展嵌套 key / 插值 / 复数）。
 * @param key 字典 key（如 "studio.subagent.empty"）
 * @param locale 可选,默认 getCurrentLocale()
 * @returns 翻译文本；缺 key 返回 key 本身（fail-open,不抛）
 */
const DICT: Record<Locale, Record<string, string>> = {
  zh: {
    // ─── common ──────────────────────────────────────
    "common.refreshing": "实时刷新中",
    "common.realtime": "实时",
    "common.empty": "暂无数据",
    "common.error": "出错了",
    "common.retry": "重试",
    "common.cancel": "取消",
    "common.confirm": "确认",
    "common.loading": "加载中…",
    "common.detail": "详情",
    "common.view_all": "查看全部",
    "common.created": "创建",
    "common.updated": "更新",

    // ─── chat ────────────────────────────────────────
    "chat.empty.title": "想聊点什么？",
    "chat.empty.subtitle": "有什么我可以帮你的吗？无论是编写代码、回答问题，还是讨论想法，我随时准备着。",
    "chat.placeholder.send": "描述你想做的项目…（Shift+Enter 换行）",
    "chat.placeholder.newline": "描述你想做的项目…（⌘Enter 发送）",
    "chat.stop": "停止生成",
    "chat.sending": "发送中...",
    "chat.connection.reconnecting": "连接中断，正在重连…",
    "chat.connection.failed": "连接已断开且重连失败，请重试",
    "chat.error.default": "连接失败，请重试",
    "chat.error.generate_failed": "生成失败，请重试或调整需求",
    "chat.scroll_to_bottom": "回到底部",
    "chat.upload.attach":
      "上传附件（支持图片 PNG/JPG/GIF/WebP 及 PDF/DOCX/PPTX/XLSX/TXT/MD 等文档）",
    "chat.upload.max_files": "单次最多 {n} 个文件",
    "chat.upload.too_large": "{name} 超过 20MB 限制",
    "chat.upload.network_error": "网络错误，上传失败：{name}",
    "chat.upload.failed": "上传失败：{name}",
    "chat.chars": "字符",

    // ─── studio nav ──────────────────────────────────
    "studio.nav.title": "Agent Studio",
    "studio.nav.overview": "总览",
    "studio.nav.agents": "智能体",
    "studio.nav.capabilities": "能力与知识",
    "studio.nav.conversations": "会话与协作",
    "studio.nav.runtime": "Runtime 与环境",
    "studio.nav.observability": "观测与评测",
    "studio.nav.security": "安全与审计",
    "studio.nav.operations": "运营",
    "studio.nav.settings": "平台设置",
    "studio.nav.open": "展开导航",
    "studio.nav.close": "收起导航",

    // ─── studio overview page ────────────────────────
    "studio.overview.title": "总览",
    "studio.overview.scope.self": "自己",
    "studio.overview.scope.global": "全局",
    "studio.overview.scope.global_tag": "（全局）",
    "studio.overview.section.resources": "资源概况",
    "studio.overview.section.metrics": "运营指标",
    "studio.overview.section.recent_threads": "最近会话",
    "studio.overview.section.recent_artifacts": "最近产物",
    "studio.overview.section.analysis": "分析详情",
    "studio.overview.section.policy": "安全策略",
    "studio.overview.metric.active_skills": "技能（启用中）",
    "studio.overview.metric.agents": "智能体",
    "studio.overview.metric.providers": "模型提供方",
    "studio.overview.metric.threads": "会话",
    "studio.overview.metric.threads_self": "仅自己的",
    "studio.overview.metric.threads_global": "全局视角",
    "studio.overview.metric.agents_sub": "只读档案",
    "studio.overview.metric.providers_sub": "只读档案",
    "studio.overview.metric.thread_success": "会话成功率",
    "studio.overview.metric.preview_success": "预览成功率",
    "studio.overview.metric.avg_completion": "平均完成时长",
    "studio.overview.metric.policy_intercept": "策略拦截率",
    "studio.overview.empty.threads": "暂无会话。",
    "studio.overview.empty.artifacts": "暂无产物。",
    "studio.overview.empty.tool_failures": "无失败记录。",
    "studio.overview.empty.skill_threads": "暂无 skill 绑定的 thread 数据。",
    "studio.overview.empty.skill_matches": "暂无自动匹配记录。",
    "studio.overview.artifact.created": "创建",
    "studio.overview.artifact.updated": "更新",
    "studio.overview.tool_failures": "工具失败分布",
    "studio.overview.skill_performance": "各技能表现",
    "studio.overview.skill_matches": "自动匹配命中",
    "studio.overview.policy_summary": "策略摘要",
    "studio.overview.policy.configured": "已配置",
    "studio.overview.policy.not_configured": "未配置",

    // ─── studio threads list page ────────────────────
    "studio.threads.title": "会话",
    "studio.threads.empty": "暂无会话。",
    "studio.threads.col.thread": "会话",
    "studio.threads.col.status": "状态",
    "studio.threads.col.skill": "技能",
    "studio.threads.col.created": "创建时间",
    "studio.threads.col.owner": "所有者",

    // ─── subagent panel ──────────────────────────────
    "studio.subagent.loading": "加载子代理…",
    "studio.subagent.load_failed": "加载失败：{error}",
    "studio.subagent.empty": "当前 thread 无子代理。",
    "studio.subagent.goal": "目标",
    "studio.subagent.result": "结果",
    "studio.subagent.error": "错误",
    "studio.subagent.write_scope": "写范围",
    "studio.subagent.cancel": "取消",
    "studio.subagent.cancelling": "取消中…",
    "studio.subagent.transcript": "transcript",
    "studio.subagent.created": "创建",
    "studio.subagent.finished": "完成",

    // ─── approval panel ──────────────────────────────
    "studio.approval.loading": "加载审批…",
    "studio.approval.empty": "当前 thread 无待审批请求。",
    "studio.approval.scope_label": "批准复用范围：",
    "studio.approval.approve": "批准",
    "studio.approval.deny": "拒绝",
    "studio.approval.history": "历史决议",
    "studio.approval.resolved_approved": "✓ 批准",
    "studio.approval.resolved_denied": "✗ 拒绝",

    // ─── background task panel ───────────────────────
    "studio.task.loading": "加载后台任务…",
    "studio.task.empty": "当前 thread 无后台任务。",

    // ─── qa panel ────────────────────────────────────
    "studio.qa.empty": "当前会话无 QA 证据。",
    "studio.qa.passed": "✓ 通过",
    "studio.qa.failed": "✗ 失败",
    "studio.qa.viewports": "viewport",
    "studio.qa.report_json": "查看完整报告 JSON",

    // ─── thread auto refresh ─────────────────────────
    "studio.auto_refresh.label": "实时刷新中",
  },
  en: {
    // ─── common ──────────────────────────────────────
    "common.refreshing": "Refreshing",
    "common.realtime": "Live",
    "common.empty": "No data",
    "common.error": "Error",
    "common.retry": "Retry",
    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.loading": "Loading...",
    "common.detail": "Detail",
    "common.view_all": "View all",
    "common.created": "Created",
    "common.updated": "Updated",

    // ─── chat ────────────────────────────────────────
    "chat.empty.title": "What would you like to chat about?",
    "chat.empty.subtitle":
      "How can I help you today? Whether it's coding, answering questions, or brainstorming ideas, I'm ready.",
    "chat.placeholder.send": "Describe the project you want... (Shift+Enter for newline)",
    "chat.placeholder.newline": "Describe the project you want... (⌘Enter to send)",
    "chat.stop": "Stop",
    "chat.sending": "Sending...",
    "chat.connection.reconnecting": "Connection lost, reconnecting...",
    "chat.connection.failed": "Connection lost and reconnect failed, please retry",
    "chat.error.default": "Connection failed, please retry",
    "chat.error.generate_failed": "Generation failed, please retry or adjust requirements",
    "chat.scroll_to_bottom": "Scroll to bottom",
    "chat.upload.attach":
      "Upload attachment (images PNG/JPG/GIF/WebP and PDF/DOCX/PPTX/XLSX/TXT/MD docs)",
    "chat.upload.max_files": "Up to {n} files at once",
    "chat.upload.too_large": "{name} exceeds 20MB limit",
    "chat.upload.network_error": "Network error, upload failed: {name}",
    "chat.upload.failed": "Upload failed: {name}",
    "chat.chars": "chars",

    // ─── studio nav ──────────────────────────────────
    "studio.nav.title": "Agent Studio",
    "studio.nav.overview": "Overview",
    "studio.nav.agents": "Agents",
    "studio.nav.capabilities": "Capabilities & Knowledge",
    "studio.nav.conversations": "Conversations",
    "studio.nav.runtime": "Runtime & Environment",
    "studio.nav.observability": "Observability & Evaluation",
    "studio.nav.security": "Security & Audit",
    "studio.nav.operations": "Operations",
    "studio.nav.settings": "Platform Settings",
    "studio.nav.open": "Open navigation",
    "studio.nav.close": "Close navigation",

    // ─── studio overview page ────────────────────────
    "studio.overview.title": "Overview",
    "studio.overview.scope.self": "Self",
    "studio.overview.scope.global": "Global",
    "studio.overview.scope.global_tag": "(global)",
    "studio.overview.section.resources": "Resources",
    "studio.overview.section.metrics": "Operational Metrics",
    "studio.overview.section.recent_threads": "Recent Threads",
    "studio.overview.section.recent_artifacts": "Recent Artifacts",
    "studio.overview.section.analysis": "Analysis",
    "studio.overview.section.policy": "Security Policy",
    "studio.overview.metric.active_skills": "Skills (active)",
    "studio.overview.metric.agents": "Agents",
    "studio.overview.metric.providers": "Providers",
    "studio.overview.metric.threads": "Threads",
    "studio.overview.metric.threads_self": "self only",
    "studio.overview.metric.threads_global": "global view",
    "studio.overview.metric.agents_sub": "read-only",
    "studio.overview.metric.providers_sub": "read-only",
    "studio.overview.metric.thread_success": "Thread Success Rate",
    "studio.overview.metric.preview_success": "Preview Success Rate",
    "studio.overview.metric.avg_completion": "Avg Completion",
    "studio.overview.metric.policy_intercept": "Policy Intercept Rate",
    "studio.overview.empty.threads": "No threads.",
    "studio.overview.empty.artifacts": "No artifacts.",
    "studio.overview.empty.tool_failures": "No failures.",
    "studio.overview.empty.skill_threads": "No skill-bound thread data.",
    "studio.overview.empty.skill_matches": "No auto-match records.",
    "studio.overview.artifact.created": "created",
    "studio.overview.artifact.updated": "updated",
    "studio.overview.tool_failures": "Tool Failure Breakdown",
    "studio.overview.skill_performance": "Per-Skill Performance",
    "studio.overview.skill_matches": "Auto-Match Hits",
    "studio.overview.policy_summary": "Policy Summary",
    "studio.overview.policy.configured": "Configured",
    "studio.overview.policy.not_configured": "Not configured",

    // ─── studio threads list page ────────────────────
    "studio.threads.title": "Threads",
    "studio.threads.empty": "No threads.",
    "studio.threads.col.thread": "Thread",
    "studio.threads.col.status": "Status",
    "studio.threads.col.skill": "Skill",
    "studio.threads.col.created": "Created",
    "studio.threads.col.owner": "Owner",

    // ─── subagent panel ──────────────────────────────
    "studio.subagent.loading": "Loading subagents...",
    "studio.subagent.load_failed": "Load failed: {error}",
    "studio.subagent.empty": "No subagents in this thread.",
    "studio.subagent.goal": "Goal",
    "studio.subagent.result": "Result",
    "studio.subagent.error": "Error",
    "studio.subagent.write_scope": "Write scope",
    "studio.subagent.cancel": "Cancel",
    "studio.subagent.cancelling": "Cancelling...",
    "studio.subagent.transcript": "transcript",
    "studio.subagent.created": "Created",
    "studio.subagent.finished": "Finished",

    // ─── approval panel ──────────────────────────────
    "studio.approval.loading": "Loading approvals...",
    "studio.approval.empty": "No pending approvals.",
    "studio.approval.scope_label": "Approval scope:",
    "studio.approval.approve": "Approve",
    "studio.approval.deny": "Deny",
    "studio.approval.history": "Resolved history",
    "studio.approval.resolved_approved": "✓ Approved",
    "studio.approval.resolved_denied": "✗ Denied",

    // ─── background task panel ───────────────────────
    "studio.task.loading": "Loading background tasks...",
    "studio.task.empty": "No background tasks.",

    // ─── qa panel ────────────────────────────────────
    "studio.qa.empty": "No QA evidence for this thread.",
    "studio.qa.passed": "✓ Passed",
    "studio.qa.failed": "✗ Failed",
    "studio.qa.viewports": "viewport",
    "studio.qa.report_json": "View full report JSON",

    // ─── thread auto refresh ─────────────────────────
    "studio.auto_refresh.label": "Live refreshing",
  },
};

/**
 * 翻译函数（支持 {placeholder} 插值）。
 * @param key 字典 key（如 "studio.subagent.empty"）
 * @param vars 可选插值变量（如 { error: "HTTP 500" } 替换 {error}）
 * @param locale 可选,默认 getCurrentLocale()
 * @returns 翻译文本；缺 key 返回 key 本身（fail-open,不抛）
 */
export function t(
  key: string,
  vars?: Record<string, string | number>,
  locale: Locale = getCurrentLocale(),
): string {
  const template = DICT[locale]?.[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

/** 便捷：按当前 locale 取 STATUS_LABEL。 */
export function statusLabel(status: string, locale: Locale = getCurrentLocale()): string {
  return STATUS_LABEL[locale]?.[status] ?? status;
}

/** 便捷：按当前 locale 取 TOOL_LABELS。 */
export function toolLabel(toolName: string, locale: Locale = getCurrentLocale()): string {
  return TOOL_LABELS[locale]?.[toolName] ?? toolName;
}
