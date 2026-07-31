-- V10 Phase 3：Desktop 本地 SQLite 初始 schema。
-- 存储设备信息、Thread tab 元数据、下载记录和 RPC 幂等记录。

CREATE TABLE IF NOT EXISTS device_info (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  server_origin TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS thread_tabs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  is_incognito INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(thread_id, tab_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_tabs_thread_id ON thread_tabs(thread_id);

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT,
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  total_bytes INTEGER,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  save_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_downloads_thread_id ON downloads(thread_id);

CREATE TABLE IF NOT EXISTS rpc_idempotency (
  request_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  thread_id TEXT,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_rpc_idempotency_device_thread ON rpc_idempotency(device_id, thread_id);
