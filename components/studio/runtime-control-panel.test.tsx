import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RuntimeControlPanel } from "@/components/studio/runtime-control-panel";
import type {
  PublishRuntimeRevisionResponse,
  RuntimeDTO,
  RuntimeRevisionDTO,
} from "@/lib/control-plane-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// ─── fixture：真实 RuntimeDTO / RuntimeRevisionDTO / PublishRuntimeRevisionResponse ──

const runtime: RuntimeDTO = {
  id: "rt-1",
  tenant_id: "tenant-1",
  runtime_key: "hr-runtime",
  display_name: "HR 外部运行服务",
  kind: "external",
  lifecycle_state: "draft",
  owner_user_id: "user-1",
  current_revision_id: "rtr-1",
  version_no: 3,
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z",
};

function revisionFixture(overrides?: Partial<RuntimeRevisionDTO>): RuntimeRevisionDTO {
  return {
    id: "rtr-1",
    runtime_id: "rt-1",
    revision_no: 1,
    revision_state: "draft",
    protocol_type: "a2a",
    protocol_contract_revision: "a2a@1",
    runtime_evidence_kind: "external_endpoint",
    runtime_target_digest: `sha256:${"d".repeat(64)}`,
    endpoint_ref: "https://agent.example.com",
    artifact_id: null,
    artifact_digest: null,
    artifact_ref: null,
    config_hash: `sha256:${"f".repeat(64)}`,
    runtime_capabilities: { measured: { features: { streaming_transport: "pass" } } },
    identity_mode: "bearer",
    credential_ref_id: "cred-1",
    network_zone: "public",
    attestation_ids: [],
    publication_record_id: null,
    withdrawal_record_id: null,
    latest_valid_conformance_run_id: "conf-1",
    latest_valid_conformance_overall_result: "passed",
    publication_conformance_run_id: null,
    execution_eligible: false,
    ineligibility_reasons: [],
    created_at: "2026-08-26T00:00:00.000Z",
    published_at: null,
    ...overrides,
  };
}

const draftRevision = revisionFixture();

const publishedRevision = revisionFixture({
  revision_state: "published",
  publication_record_id: "pub-1",
  published_at: "2026-08-26T01:00:00.000Z",
});

const publishResponse: PublishRuntimeRevisionResponse = {
  id: "rtr-1",
  revision_state: "published",
  published_at: "2026-08-26T01:00:00.000Z",
  publication_record_id: "pub-1",
  conformance_run_id: "conf-1",
  audit_event_id: "audit-1",
};

// ─── fetch mock ─────────────────────────────────────────────────────────────

interface BackendState {
  failRuntimes: boolean;
  revisions: RuntimeRevisionDTO[];
  published: boolean;
}

let backend: BackendState;

function stubBackend() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/admin/api/v1/runtimes") {
      if (backend.failRuntimes) throw new Error("temporary failure");
      return Response.json({ items: [runtime], total: 1 });
    }
    if (url === "/admin/api/v1/runtimes/rt-1/revisions") {
      return Response.json({
        items: backend.published ? [publishedRevision] : backend.revisions,
        total: 1,
      });
    }
    if (url === "/admin/api/v1/runtime-revisions/rtr-1/publish" && init?.method === "POST") {
      backend.published = true;
      return Response.json(publishResponse);
    }
    return Response.json({ items: [], total: 0 });
  });
}

function publishPosts(): Array<{ body: unknown; headers: Headers }> {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url) === "/admin/api/v1/runtime-revisions/rtr-1/publish" && init?.method === "POST",
    )
    .map(([, init]) => ({
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    }));
}

beforeEach(() => {
  fetchMock.mockReset();
  backend = { failRuntimes: false, revisions: [draftRevision], published: false };
  stubBackend();
});

afterEach(cleanup);

describe("RuntimeControlPanel（真实 Runtime 登记后的同页发布）", () => {
  it("使用统一界面组件、语义颜色与可识别状态呈现运行服务", async () => {
    const source = readFileSync(
      resolve(process.cwd(), "components/studio/runtime-control-panel.tsx"),
      "utf8",
    );
    expect(source).toContain("@/components/ui/button");
    expect(source).toContain("@/components/ui/badge");
    expect(source).toContain("@/components/ui/card");
    expect(source).not.toMatch(/<button\b/);
    expect(source).not.toMatch(/var\(--(?:fg|bg|surface|border|danger)/);
    expect(source).not.toMatch(/text-\[\d+(?:\.\d+)?px\]/);
    expect(source).not.toMatch(/emerald-/);

    render(<RuntimeControlPanel canPublish refreshToken={0} />);
    await waitFor(() => expect(screen.getByText("HR 外部运行服务")).toBeTruthy());

    expect(screen.getByRole("region", { name: "运行服务版本" })).toBeTruthy();
    expect(document.querySelector('[data-slot="card"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="badge"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="button"]')).toBeTruthy();
    expect(screen.getByText("服务地址")).toBeTruthy();
    expect(screen.getByText("发布校验")).toBeTruthy();
    expect(screen.getByText(/智能体通信/)).toBeTruthy();
    expect(screen.queryByText(/A2A/)).toBeNull();
    expect(screen.queryByText(runtime.runtime_key)).toBeNull();
    expect(document.body.textContent).not.toContain(draftRevision.runtime_target_digest);
  });

  it("refreshToken 改变必须重新 GET /admin/api/v1/runtimes 与 revisions；首次失败刷新成功后清除旧错误", async () => {
    backend.failRuntimes = true;
    const runtimesCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url) === "/admin/api/v1/runtimes").length;

    const view = render(<RuntimeControlPanel canPublish refreshToken={0} />);
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeTruthy());

    backend.failRuntimes = false;
    const callsBefore = runtimesCalls();
    view.rerender(<RuntimeControlPanel canPublish refreshToken={1} />);

    // refreshToken 变化触发重新拉取（不是只重放旧结果）。
    await waitFor(() => expect(runtimesCalls()).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(screen.getByText("HR 外部运行服务")).toBeTruthy());
    // 刷新成功后旧错误被清除。
    await waitFor(() => expect(screen.queryByText(/加载失败/)).toBeNull());
  });

  it("preferredRuntimeRevisionId 只在真实 GET 返回包含该 revision 时聚焦显示，不凭 id 造假", async () => {
    const view = render(
      <RuntimeControlPanel canPublish refreshToken={0} preferredRuntimeRevisionId="rtr-1" />,
    );
    await waitFor(() => expect(screen.getByText("HR 外部运行服务")).toBeTruthy());
    expect(screen.getByText("访问令牌")).toBeTruthy();
    expect(screen.queryByText("bearer")).toBeNull();
    expect(screen.queryByText("external_endpoint")).toBeNull();
    // 真实返回包含 rtr-1（第 1 版）→ 显示用户可见的“本次登记”聚焦标记。
    await waitFor(() => expect(screen.getByText("本次登记")).toBeTruthy());

    // 切换到一个后端并不存在的 preferred id：不得凭空制造聚焦标记或 revision 行。
    view.rerender(
      <RuntimeControlPanel canPublish refreshToken={0} preferredRuntimeRevisionId="rtr-404" />,
    );
    await waitFor(() => expect(screen.queryByText("本次登记")).toBeNull());
    // 仍然只渲染真实返回的一条版本行，没有凭空多出的版本。
    expect(screen.getAllByText("第 1 版")).toHaveLength(1);
    expect(screen.queryByText("第 404 版")).toBeNull();
  });

  it("draft external_endpoint + conf-1：点击中文“发布运行服务版本”精确 POST publish，onPublished 收到完整响应并刷新为已发布", async () => {
    const onPublished = vi.fn();
    render(<RuntimeControlPanel canPublish refreshToken={0} onPublished={onPublished} />);
    await waitFor(() => expect(screen.getByText("第 1 版")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "发布运行服务版本" }));

    await waitFor(() => expect(publishPosts()).toHaveLength(1));
    const post = publishPosts()[0];
    if (!post) throw new Error("publish POST 未发出");
    // external_endpoint 绝不携带 attestation id（03 §4）。
    expect(post.body).toEqual({
      expected_version_no: 3,
      attestation_id: null,
      conformance_run_id: "conf-1",
    });
    expect(post.headers.get("Idempotency-Key")).toBeTruthy();
    expect(post.headers.get("If-Match")).toBe("runtime-revision-1");

    // onPublished 恰好一次，携带完整 PublishRuntimeRevisionResponse。
    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(onPublished).toHaveBeenCalledWith(publishResponse);

    // 发布后重新拉取，版本显示为已发布并出现撤回入口。
    await waitFor(() => expect(screen.getByRole("button", { name: "撤回" })).toBeTruthy());
    expect(screen.getByText("已发布")).toBeTruthy();
  });

  it("external_endpoint 缺 latest_valid_conformance_run_id：发布按钮不出现且零 publish POST", async () => {
    backend.revisions = [revisionFixture({ id: "rtr-2", latest_valid_conformance_run_id: null })];

    render(<RuntimeControlPanel canPublish refreshToken={0} />);
    await waitFor(() => expect(screen.getByText("第 1 版")).toBeTruthy());

    expect(screen.queryByRole("button", { name: "发布运行服务版本" })).toBeNull();
    expect(publishPosts()).toHaveLength(0);
  });

  it("external_endpoint 验收未通过时即使有 run id 也不提供发布入口", async () => {
    backend.revisions = [revisionFixture({ latest_valid_conformance_overall_result: "failed" })];

    render(<RuntimeControlPanel canPublish refreshToken={0} />);
    await waitFor(() => expect(screen.getByText("本次可发布验收：验收失败")).toBeTruthy());

    expect(screen.queryByRole("button", { name: "发布运行服务版本" })).toBeNull();
    expect(publishPosts()).toHaveLength(0);
  });

  it("bearer 身份缺少访问凭证时 fail closed：展示中文原因且不提供发布入口", async () => {
    backend.revisions = [revisionFixture({ credential_ref_id: null })];

    render(<RuntimeControlPanel canPublish refreshToken={0} />);
    await waitFor(() => expect(screen.getByText("第 1 版")).toBeTruthy());

    expect(screen.getByText("缺少访问凭证")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "发布运行服务版本" })).toBeNull();
    expect(publishPosts()).toHaveLength(0);
  });

  it("hosted_artifact 必须同时具备通过的验收与工件证明，并精确提交首个证明 id", async () => {
    backend.revisions = [
      revisionFixture({
        runtime_evidence_kind: "hosted_artifact",
        artifact_id: "artifact-1",
        artifact_digest: `sha256:${"a".repeat(64)}`,
        artifact_ref: "oci://registry.example/runtime@sha256:deadbeef",
        attestation_ids: [],
      }),
    ];

    const view = render(<RuntimeControlPanel canPublish refreshToken={0} />);
    await waitFor(() => expect(screen.getByText("第 1 版")).toBeTruthy());
    expect(screen.getByText("缺少工件证明")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "发布运行服务版本" })).toBeNull();

    backend.revisions = [
      revisionFixture({
        runtime_evidence_kind: "hosted_artifact",
        artifact_id: "artifact-1",
        artifact_digest: `sha256:${"a".repeat(64)}`,
        artifact_ref: "oci://registry.example/runtime@sha256:deadbeef",
        attestation_ids: ["attestation-1"],
      }),
    ];
    view.rerender(<RuntimeControlPanel canPublish refreshToken={1} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "发布运行服务版本" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "发布运行服务版本" }));

    await waitFor(() => expect(publishPosts()).toHaveLength(1));
    expect(publishPosts()[0]?.body).toEqual({
      expected_version_no: 3,
      attestation_id: "attestation-1",
      conformance_run_id: "conf-1",
    });
  });

  it("刷新代次只允许最新响应落地，较慢旧响应不得覆盖新列表", async () => {
    let resolveOldList: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/admin/api/v1/runtimes") {
        if (!resolveOldList) {
          return await new Promise<Response>((resolvePromise) => {
            resolveOldList = resolvePromise;
          });
        }
        return Response.json({
          items: [{ ...runtime, id: "rt-new", display_name: "最新运行服务" }],
          total: 1,
        });
      }
      if (url === "/admin/api/v1/runtimes/rt-new/revisions") {
        return Response.json({ items: [], total: 0 });
      }
      if (url === "/admin/api/v1/runtimes/rt-old/revisions") {
        return Response.json({ items: [], total: 0 });
      }
      return Response.json({ items: [], total: 0 });
    });

    const view = render(<RuntimeControlPanel canPublish refreshToken={0} />);
    await waitFor(() => expect(resolveOldList).toBeTruthy());
    view.rerender(<RuntimeControlPanel canPublish refreshToken={1} />);
    await waitFor(() => expect(screen.getByText("最新运行服务")).toBeTruthy());

    resolveOldList?.(
      Response.json({
        items: [{ ...runtime, id: "rt-old", display_name: "过期运行服务" }],
        total: 1,
      }),
    );
    await waitFor(() => expect(screen.queryByText("过期运行服务")).toBeNull());
    expect(screen.getByText("最新运行服务")).toBeTruthy();
  });

  it("列表错误只显示稳定中文，不回显后端原始 endpoint 或令牌诊断", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "probe https://internal.example failed with Bearer leaked-token",
            request_id: "req-1",
            retryable: true,
          },
        },
        { status: 500 },
      ),
    );

    render(<RuntimeControlPanel canPublish refreshToken={0} />);
    await waitFor(() => expect(screen.getByText("运行服务列表加载失败")).toBeTruthy());
    expect(document.body.textContent).not.toContain("internal.example");
    expect(document.body.textContent).not.toContain("leaked-token");
  });

  it("已有列表刷新失败后立即降为只读，不允许对过期版本再次发布", async () => {
    const view = render(<RuntimeControlPanel canPublish refreshToken={0} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "发布运行服务版本" })).toBeTruthy(),
    );

    backend.failRuntimes = true;
    view.rerender(<RuntimeControlPanel canPublish refreshToken={1} />);

    await waitFor(() => expect(screen.getByText("运行服务列表加载失败")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "发布运行服务版本" })).toBeNull();
    expect(publishPosts()).toHaveLength(0);
  });

  it("空列表刷新失败时显示错误，不把失败遮成稳定空态", async () => {
    let listCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) !== "/admin/api/v1/runtimes") {
        return Response.json({ items: [], total: 0 });
      }
      listCalls += 1;
      if (listCalls === 1) return Response.json({ items: [], total: 0 });
      throw new Error("refresh failed");
    });

    const view = render(<RuntimeControlPanel canPublish refreshToken={0} />);
    await waitFor(() => expect(screen.getByText("暂无运行服务")).toBeTruthy());

    view.rerender(<RuntimeControlPanel canPublish refreshToken={1} />);
    await waitFor(() => expect(screen.getByText("运行服务列表加载失败")).toBeTruthy());
    expect(screen.queryByText("暂无运行服务")).toBeNull();
  });

  it("撤回已发布版本必须二次确认，确认前不发出写请求", async () => {
    backend.published = true;
    render(<RuntimeControlPanel canPublish refreshToken={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "撤回" }));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("确认撤回第 1 版？")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/withdraw") && init?.method === "POST",
      ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "确认撤回" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => String(url).endsWith("/withdraw") && init?.method === "POST",
        ),
      ).toHaveLength(1),
    );
  });
});
