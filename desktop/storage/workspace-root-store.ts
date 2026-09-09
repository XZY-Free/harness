import type { MigrationDb } from "./db-interface";

export interface WorkspaceRootRecord {
  bindingId: string;
  workspaceId: string;
  absolutePath: string;
  displayName: string;
}

interface WorkspaceRootRow {
  binding_id: string;
  workspace_id: string;
  absolute_path: string;
  display_name: string;
}

export class WorkspaceRootStore {
  constructor(private readonly db: MigrationDb) {}

  upsert(record: WorkspaceRootRecord): void {
    this.db
      .prepare(
        `INSERT INTO workspace_roots
          (binding_id, workspace_id, absolute_path, display_name, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(binding_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          absolute_path = excluded.absolute_path,
          display_name = excluded.display_name,
          updated_at = datetime('now')`,
      )
      .run(record.bindingId, record.workspaceId, record.absolutePath, record.displayName);
  }

  get(bindingId: string): WorkspaceRootRecord | null {
    const row = this.db
      .prepare<WorkspaceRootRow>(
        `SELECT binding_id, workspace_id, absolute_path, display_name
         FROM workspace_roots WHERE binding_id = ?`,
      )
      .get(bindingId);
    return row
      ? {
          bindingId: row.binding_id,
          workspaceId: row.workspace_id,
          absolutePath: row.absolute_path,
          displayName: row.display_name,
        }
      : null;
  }
}
