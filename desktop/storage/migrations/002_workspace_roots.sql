-- 本地 WorkspaceBinding 到绝对目录的设备内映射；绝对路径不上传到 Server。
CREATE TABLE IF NOT EXISTS workspace_roots (
  binding_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_roots_workspace_id ON workspace_roots(workspace_id);
