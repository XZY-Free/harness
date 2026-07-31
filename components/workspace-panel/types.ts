/**
 * V5 工作区产物面板：统一对象描述。
 *
 * - artifact：首选产物视图，适合后续把文档、报告、截图、页面入口统一登记。
 * - app：项目运行页，统一在内置浏览器打开（V9 阶段 5 替代旧 preview iframe）。
 * - preview：只表示网页预览（保留兼容，主流程已改用 app）。
 * - file：兜底视图，员工主动点文件时打开。
 * - progress：只展示业务化进度，不展示终端日志。
 *
 * 当前阶段 `app` 与 `file` 在前台落地；`artifact` / `progress` 为后续阶段预留，
 * 先固化类型以便组件按 kind 切换。
 */
export type WorkspacePanelView =
  | { kind: "artifact"; artifactId: string; title?: string }
  | { kind: "app" }
  | { kind: "preview"; url: string; title?: string }
  | { kind: "file"; path: string; title?: string }
  | { kind: "progress"; title?: string };
