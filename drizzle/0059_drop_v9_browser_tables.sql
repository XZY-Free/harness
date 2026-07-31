-- V10 Phase 2：删除 V9 远程浏览器链路的四张 DB 表。
-- SnowHarness V10 不再提供服务器用户浏览器，浏览器能力由 macOS Desktop
-- Electron + WebContentsView 本地承载（Phase 3+）。Desktop 的 Profile / Session /
-- Download 由 Desktop 本地 SQLite 管理，不经 Server MySQL。
--
-- 顺序（按 FK 依赖，先删子表后删父表）：
-- 1. BrowserTab（FK → BrowserSession, Thread；Phase 10 从 schema 代码删除但 DB 表仍在）
-- 2. BrowserDownload（FK → Thread）
-- 3. BrowserSession（FK → Thread, User）
-- 4. UserBrowserProfile（FK → User）
-- DROP TABLE IF EXISTS 保证幂等（表不存在时不报错）。
DROP TABLE IF EXISTS `BrowserTab`;
--> statement-breakpoint
DROP TABLE IF EXISTS `BrowserDownload`;
--> statement-breakpoint
DROP TABLE IF EXISTS `BrowserSession`;
--> statement-breakpoint
DROP TABLE IF EXISTS `UserBrowserProfile`;
