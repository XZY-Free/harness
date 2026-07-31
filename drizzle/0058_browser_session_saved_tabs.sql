-- 阶段九：BrowserSession 新增 savedTabs JSON 字段，存储 releaseIdle 时的 tab URL 列表。
-- 用于 runtime 重启/崩溃恢复后重新打开之前的标签页。
-- nullable：null = 无保存的 tabs（首次创建或已恢复）。JSON 数组格式：["url1", "url2", ...]
ALTER TABLE `BrowserSession` ADD COLUMN `savedTabs` json NULL;
