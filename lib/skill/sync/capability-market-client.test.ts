import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * capability-market-client 测试（02 文档 §二、§三）。
 * mock fetch + capabilityMarketConfig,验证：
 * - listSyncableSkills 分页拉取,scope=syncable&asset_type=skill。
 * - checkUpdates / syncManifests POST body 正确。
 * - downloadArtifact 读响应头 X-Content-Hash / ETag,404 → null。
 * - endpoint 未配置 → 抛 CapabilityMarketClientError。
 */

const configState = vi.hoisted(() => ({
  endpoint: "https://cm.test/api",
  token: "tok-xyz" as string | null,
  timeoutMs: 5000,
}));

vi.mock("@/lib/config", () => ({
  capabilityMarketConfig: {
    get endpoint() {
      return configState.endpoint;
    },
    get token() {
      return configState.token;
    },
    get timeoutMs() {
      return configState.timeoutMs;
    },
  },
}));

import {
  CapabilityMarketClientError,
  checkUpdates,
  downloadArtifact,
  listSyncableSkills,
  syncManifests,
} from "@/lib/skill/sync/capability-market-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("capability-market-client", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    configState.endpoint = "https://cm.test/api";
    configState.token = "tok-xyz";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("listSyncableSkills", () => {
    it("单页返回（items < limit）→ 不再翻页", async () => {
      let calledUrl = "";
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        calledUrl = typeof input === "string" ? input : input.toString();
        return jsonResponse({
          items: [
            {
              asset_id: "a1",
              asset_type: "skill",
              name: "s1",
              display_name: null,
              description: null,
              category: null,
              latest_version: null,
              resolved_version: "1.0.0",
              resolved_version_id: "v1",
              resolved_content_hash: "h1",
              access_state: "allowed",
              restriction_type: null,
              rule_id: null,
              tags: null,
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        });
      }) as unknown as typeof globalThis.fetch;

      const items = await listSyncableSkills();
      expect(items).toHaveLength(1);
      expect(items[0]!.asset_id).toBe("a1");
      expect(calledUrl).toContain("asset_type=skill");
      expect(calledUrl).toContain("scope=syncable");
      expect(calledUrl).toContain("limit=100");
    });

    it("多页：items === limit 时继续翻页", async () => {
      let page = 0;
      globalThis.fetch = vi.fn(async () => {
        const offset = page * 100;
        page++;
        const items = Array.from({ length: 100 }, (_, i) => ({
          asset_id: `a${offset + i}`,
          asset_type: "skill",
          name: `s${offset + i}`,
          display_name: null,
          description: null,
          category: null,
          latest_version: null,
          resolved_version: "1.0.0",
          resolved_version_id: "v",
          resolved_content_hash: "h",
          access_state: "allowed",
          restriction_type: null,
          rule_id: null,
          tags: null,
        }));
        // 第二页只返回 50 条 → 停止
        return jsonResponse({
          items: page === 2 ? items.slice(0, 50) : items,
          total: 150,
          limit: 100,
          offset,
        });
      }) as unknown as typeof globalThis.fetch;

      const items = await listSyncableSkills();
      expect(items).toHaveLength(150);
    });

    it("endpoint 未配置 → 抛 CapabilityMarketClientError", async () => {
      configState.endpoint = "";
      globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;
      await expect(listSyncableSkills()).rejects.toBeInstanceOf(CapabilityMarketClientError);
    });

    it("非 2xx → 抛 CapabilityMarketClientError", async () => {
      globalThis.fetch = vi.fn(
        async () => new Response("err", { status: 500 }),
      ) as unknown as typeof globalThis.fetch;
      await expect(listSyncableSkills()).rejects.toBeInstanceOf(CapabilityMarketClientError);
    });
  });

  describe("checkUpdates", () => {
    it("POST 正确 body,返回 items", async () => {
      let body: unknown;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        body = init?.body ? JSON.parse(init.body as string) : null;
        return jsonResponse({
          items: [
            {
              asset_id: "a1",
              status: "unchanged",
              latest_version: "1.0.0",
              latest_content_hash: "h1",
              rule_id: null,
              restriction_type: null,
              error_code: null,
              requested_version: "1.0.0",
              requested_content_hash: "h1",
            },
          ],
        });
      }) as unknown as typeof globalThis.fetch;

      const result = await checkUpdates([{ asset_id: "a1", version: "1.0.0", content_hash: "h1" }]);
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe("unchanged");
      expect(body).toEqual({ items: [{ asset_id: "a1", version: "1.0.0", content_hash: "h1" }] });
    });

    it("空数组 → 不发请求,返回空", async () => {
      globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;
      const result = await checkUpdates([]);
      expect(result).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("syncManifests", () => {
    it("POST /capabilities/sync,返回 items", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({
          items: [
            {
              asset_id: "a1",
              asset_type: "skill",
              asset_name: "s1",
              resolved_version: "1.0.0",
              version_id: "v1",
              content_hash: "h1",
              version_state: "published",
              risk_level: null,
              package_size: 100,
              etag: "e1",
              artifact_download_path: "/api/capabilities/a1/versions/1.0.0/artifact",
              skill_detail: {
                entry_file: "SKILL.md",
                runtime_requirements: null,
                permission_policy: null,
                tags: null,
              },
              tool_detail: null,
              rule_id: null,
              restriction_type: null,
            },
          ],
        }),
      ) as unknown as typeof globalThis.fetch;

      const result = await syncManifests(["a1"]);
      expect(result).toHaveLength(1);
      expect(result[0]!.artifact_download_path).toContain(
        "/capabilities/a1/versions/1.0.0/artifact",
      );
    });
  });

  describe("downloadArtifact", () => {
    it("200 → 返回 buffer + contentHash + etag", async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { "x-content-hash": "sha256:abc", etag: "etag-1" },
          }),
      ) as unknown as typeof globalThis.fetch;

      const r = await downloadArtifact("a1", "1.0.0");
      expect(r).not.toBeNull();
      expect(r!.buffer).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(r!.contentHash).toBe("sha256:abc");
      expect(r!.etag).toBe("etag-1");
    });

    it("404 → 返回 null", async () => {
      globalThis.fetch = vi.fn(
        async () => new Response(null, { status: 404 }),
      ) as unknown as typeof globalThis.fetch;
      const r = await downloadArtifact("a1", "1.0.0");
      expect(r).toBeNull();
    });

    it("403 → 抛 CapabilityMarketClientError", async () => {
      globalThis.fetch = vi.fn(
        async () => new Response(null, { status: 403 }),
      ) as unknown as typeof globalThis.fetch;
      await expect(downloadArtifact("a1", "1.0.0")).rejects.toBeInstanceOf(
        CapabilityMarketClientError,
      );
    });
  });
});
