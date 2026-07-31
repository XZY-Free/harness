"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * V3.4 Stage E：外部工具与来源审计面板。
 *
 * 三块：
 * 1. MCP server 列表（name/transport/enabled/tools 数）+ 启停/删除（admin 可写，POST/PUT/DELETE）
 * 2. 自定义工具列表（name/executorType/enabled）+ 启停/删除
 * 3. external 来源审计：本轮 thread 最近 external.fetched 事件（sourceUrl/contentHash/artifactPath/expiresAt）
 *
 * env 在 API 层已脱敏返回。无权限写时按钮无操作（API 返 403，前端静默刷新）。
 */

type McpServer = {
  id: string;
  name: string;
  transport: string;
  enabled: boolean;
  allowedTools: string[] | null;
  env: Record<string, string> | null;
};

type CustomTool = {
  id: string;
  name: string;
  executorType: string;
  enabled: boolean;
  description: string;
};

type ExternalEvent = {
  id: string;
  createdAt: string | Date;
  payload: {
    sourceUrl?: string;
    contentHash?: string;
    artifactPath?: string;
    expiresAt?: string | null;
    contentType?: string;
    bytes?: number;
    truncated?: boolean;
  };
};

export function ExternalToolsPanel({
  threadId,
  externalEvents,
}: {
  threadId: string;
  externalEvents: ExternalEvent[];
}) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [customs, setCustoms] = useState<CustomTool[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        fetch("/studio/api/mcp-servers").then((r) => r.json()),
        fetch("/studio/api/custom-tools").then((r) => r.json()),
      ]);
      setServers(s.data?.rows ?? []);
      setCustoms(c.data?.rows ?? []);
    } catch {
      setServers([]);
      setCustoms([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleServer(id: string, enabled: boolean) {
    await fetch(`/studio/api/mcp-servers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !enabled }),
    });
    void load();
  }

  async function deleteServer(id: string) {
    await fetch(`/studio/api/mcp-servers/${id}`, { method: "DELETE" });
    void load();
  }

  async function toggleCustom(id: string, enabled: boolean) {
    await fetch(`/studio/api/custom-tools/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !enabled }),
    });
    void load();
  }

  async function deleteCustom(id: string) {
    await fetch(`/studio/api/custom-tools/${id}`, { method: "DELETE" });
    void load();
  }

  if (loading) return <div className="text-sm text-gray-500">加载外部工具…</div>;

  return (
    <div className="space-y-4">
      {/* MCP server 列表 */}
      <section>
        <h3 className="text-sm font-semibold">
          MCP Server（permissionKey: mcp.&lt;name&gt;.&lt;tool&gt;，默认需审批）
        </h3>
        {servers.length === 0 ? (
          <div className="text-sm text-gray-500">无已注册 MCP server</div>
        ) : (
          <ul className="space-y-1">
            {servers.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded border border-gray-200 p-2 text-sm"
              >
                <span className="rounded bg-gray-100 px-1 text-xs">{s.transport}</span>
                <span className="font-mono flex-1">{s.name}</span>
                <span className="text-xs text-gray-500">
                  {s.allowedTools ? `${s.allowedTools.length} 工具` : "全部工具"}
                </span>
                <span className="text-xs">{s.enabled ? "启用" : "禁用"}</span>
                <button
                  type="button"
                  onClick={() => void toggleServer(s.id, s.enabled)}
                  className="rounded border border-gray-300 px-2 text-xs"
                >
                  {s.enabled ? "停用" : "启用"}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteServer(s.id)}
                  className="rounded border border-red-300 px-2 text-xs text-red-600"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 自定义工具列表 */}
      <section>
        <h3 className="text-sm font-semibold">
          自定义工具（permissionKey: custom.&lt;name&gt;，默认需审批）
        </h3>
        {customs.length === 0 ? (
          <div className="text-sm text-gray-500">无自定义工具</div>
        ) : (
          <ul className="space-y-1">
            {customs.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 rounded border border-gray-200 p-2 text-sm"
              >
                <span className="rounded bg-gray-100 px-1 text-xs">{c.executorType}</span>
                <span className="font-mono flex-1">{c.name}</span>
                <span className="text-xs text-gray-500">{c.description.slice(0, 40)}</span>
                <span className="text-xs">{c.enabled ? "启用" : "禁用"}</span>
                <button
                  type="button"
                  onClick={() => void toggleCustom(c.id, c.enabled)}
                  className="rounded border border-gray-300 px-2 text-xs"
                >
                  {c.enabled ? "停用" : "启用"}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteCustom(c.id)}
                  className="rounded border border-red-300 px-2 text-xs text-red-600"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* external 来源审计 */}
      <section>
        <h3 className="text-sm font-semibold">
          外部资料来源审计（webFetch/webSearch/searchDocs，本轮 thread）
        </h3>
        {externalEvents.length === 0 ? (
          <div className="text-sm text-gray-500">本轮无外部资料访问</div>
        ) : (
          <ul className="space-y-1">
            {externalEvents.map((e) => (
              <li key={e.id} className="rounded border border-gray-200 p-2 text-xs">
                <div className="font-mono break-all">{e.payload.sourceUrl ?? "?"}</div>
                <div className="text-gray-500">
                  hash: {e.payload.contentHash?.slice(0, 12) ?? "?"}
                  {e.payload.truncated ? " · 已截断" : ""}
                  {e.payload.bytes ? ` · ${e.payload.bytes}B` : ""}
                  {e.payload.contentType ? ` · ${e.payload.contentType}` : ""}
                </div>
                {e.payload.artifactPath ? (
                  <div className="text-gray-400">artifact: {e.payload.artifactPath}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
