import type { CustomToolDeclaration } from "@/lib/custom-tools/registry";
import { computeArgFingerprint } from "@/lib/permission/approval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCustomTools, customPermissionKey } from "./custom";

/**
 * V3.4 Stage D：自定义工具经 executeToolRun + customEvaluate（默认 ask）+ executor 测试。
 *
 * 验收（命门）：
 * - 自定义工具默认 ask → awaitingApproval + permissionKey=custom.<name>
 * - webhook executor 走域名治理（mock executeWebhook）
 * - script executor 非白名单 scriptId 被拒（mock executeScript）
 * - 注入 buildTools 后白名单过滤正确（在 tools.test.ts 覆盖）
 */

const TID = "test-custom-tools";

const queryMocks = vi.hoisted(() => ({
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  requestApprovalAtomic: vi.fn(),
  updateThreadStatus: vi.fn(),
}));
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({
  updateThreadStatus: queryMocks.updateThreadStatus,
  createToolRun: queryMocks.createToolRun,
  appendThreadEvent: queryMocks.appendThreadEvent,
  finishToolRunSuccess: queryMocks.finishToolRunSuccess,
  finishToolRunFailure: queryMocks.finishToolRunFailure,
  listPermissionRules: queryMocks.listPermissionRules,
  findMatchingApprovals: queryMocks.findMatchingApprovals,
  consumeOnceApproval: queryMocks.consumeOnceApproval,
  requestApprovalAtomic: queryMocks.requestApprovalAtomic,
}));

const registryMocks = vi.hoisted(() => ({
  executeWebhook: vi.fn(),
  executeScript: vi.fn(),
}));
vi.mock("@/lib/custom-tools/registry", () => ({
  executeWebhook: registryMocks.executeWebhook,
  executeScript: registryMocks.executeScript,
}));

type ToolLike = { execute?: (...args: never[]) => unknown };
async function callExecute(tool: ToolLike, input: unknown): Promise<Record<string, unknown>> {
  if (!tool.execute) throw new Error("tool.execute missing");
  return (await tool.execute(
    input as never,
    {
      toolCallId: "t",
      messages: [],
    } as never,
  )) as Record<string, unknown>;
}

const webhookDecl: CustomToolDeclaration = {
  name: "deploy",
  description: "部署",
  inputSchema: { type: "object" },
  executorType: "webhook",
  executorConfig: { url: "https://example.com/hook", method: "POST" },
};
const scriptDecl: CustomToolDeclaration = {
  name: "echoTool",
  description: "echo",
  inputSchema: { type: "object" },
  executorType: "script",
  executorConfig: { scriptId: "echo" },
};

beforeEach(() => {
  vi.clearAllMocks();
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  queryMocks.createToolRun.mockResolvedValue({ id: "tr-1" });
  queryMocks.requestApprovalAtomic.mockResolvedValue({
    run: { id: "run-ask", status: "awaiting_approval" },
    approval: { id: "apr-1" },
  });
  queryMocks.finishToolRunSuccess.mockResolvedValue(undefined);
  queryMocks.finishToolRunFailure.mockResolvedValue(undefined);
  queryMocks.appendThreadEvent.mockResolvedValue(undefined);
  queryMocks.updateThreadStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildCustomTools 注入 + 默认 ask", () => {
  it("webhook 自定义工具默认 ask → awaitingApproval + permissionKey=custom.deploy", async () => {
    const tools = buildCustomTools(TID, [webhookDecl]);
    expect(tools.deploy).toBeDefined();
    const out = await callExecute(tools.deploy as ToolLike, { args: { env: "prod" } });
    expect(out.ok).toBe(false);
    expect(out.awaitingApproval).toBe(true);
    expect(queryMocks.requestApprovalAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "deploy", permissionKey: "custom.deploy" }),
    );
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "awaiting_approval");
    expect(registryMocks.executeWebhook).not.toHaveBeenCalled();
  });

  it("webhook 既定批准 → 升级 allow → executeWebhook 调用成功", async () => {
    const fp = computeArgFingerprint("custom.deploy", { args: { env: "prod" } });
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-old",
        threadId: TID,
        permissionKey: "custom.deploy",
        argFingerprint: fp,
        status: "approved",
        approvedScope: "always",
        expiresAt: null,
      },
    ]);
    registryMocks.executeWebhook.mockResolvedValue({ ok: true, content: "deployed" });
    const tools = buildCustomTools(TID, [webhookDecl]);
    const out = await callExecute(tools.deploy as ToolLike, { args: { env: "prod" } });
    expect(out.ok).toBe(true);
    expect(registryMocks.executeWebhook).toHaveBeenCalled();
  });

  it("webhook executor 返回域名治理失败 → 透传 ok:false（业务失败）", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-old",
        threadId: TID,
        permissionKey: "custom.deploy",
        argFingerprint: computeArgFingerprint("custom.deploy", { args: {} }),
        status: "approved",
        approvedScope: "always",
        expiresAt: null,
      },
    ]);
    registryMocks.executeWebhook.mockResolvedValue({
      ok: false,
      error: "webhook 域名未在 allowlist",
    });
    const tools = buildCustomTools(TID, [webhookDecl]);
    const out = await callExecute(tools.deploy as ToolLike, { args: {} });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("allowlist");
  });

  it("script 自定义工具既定批准 → executeScript 调用", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-old",
        threadId: TID,
        permissionKey: "custom.echoTool",
        argFingerprint: computeArgFingerprint("custom.echoTool", { args: { x: 1 } }),
        status: "approved",
        approvedScope: "always",
        expiresAt: null,
      },
    ]);
    registryMocks.executeScript.mockResolvedValue({ ok: true, content: { x: 1 } });
    const tools = buildCustomTools(TID, [scriptDecl]);
    const out = await callExecute(tools.echoTool as ToolLike, { args: { x: 1 } });
    expect(out.ok).toBe(true);
    expect(registryMocks.executeScript).toHaveBeenCalledWith("echo", { x: 1 });
  });

  it("script executor 非白名单 scriptId → executeScript 返回拒绝（业务失败）", async () => {
    const evilDecl: CustomToolDeclaration = {
      name: "evil",
      description: "evil",
      inputSchema: { type: "object" },
      executorType: "script",
      executorConfig: { scriptId: "rm-rf" },
    };
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-old",
        threadId: TID,
        permissionKey: "custom.evil",
        argFingerprint: computeArgFingerprint("custom.evil", { args: {} }),
        status: "approved",
        approvedScope: "always",
        expiresAt: null,
      },
    ]);
    registryMocks.executeScript.mockResolvedValue({
      ok: false,
      error: "script scriptId 不在白名单: rm-rf",
    });
    const tools = buildCustomTools(TID, [evilDecl]);
    const out = await callExecute(tools.evil as ToolLike, { args: {} });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("白名单");
  });

  it("空 declarations → 无自定义工具（零回归）", () => {
    const tools = buildCustomTools(TID, []);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it("customPermissionKey 派生 custom.<name>", () => {
    expect(customPermissionKey("deploy")).toBe("custom.deploy");
  });
});

describe("P1-7：args 结构性校验(挡恶意大对象/嵌套爆炸)", () => {
  it("args 体积超限 → ok:false,executor 不被调用", async () => {
    const tools = buildCustomTools(TID, [webhookDecl]);
    const big = "x".repeat(128 * 1024); // >64KB
    const out = await callExecute(tools.deploy as ToolLike, { args: { payload: big } });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("args 校验失败");
    expect(out.error).toContain("体积超限");
    expect(registryMocks.executeWebhook).not.toHaveBeenCalled();
  });

  it("args 嵌套深度超限 → ok:false", async () => {
    const tools = buildCustomTools(TID, [webhookDecl]);
    // 构造深度 >8 的嵌套对象
    let nested: unknown = "leaf";
    for (let i = 0; i < 12; i++) nested = { a: nested };
    const out = await callExecute(tools.deploy as ToolLike, { args: { deep: nested } });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("嵌套深度超限");
    expect(registryMocks.executeWebhook).not.toHaveBeenCalled();
  });

  it("args 循环引用 → ok:false(深度上限兜底,不无限循环)", async () => {
    // 循环引用会被深度上限(>8)先挡住,validateCustomArgs 不会无限遍历。
    // 核心断言:被拒 + executor 不被调用 + 不挂起
    const tools = buildCustomTools(TID, [webhookDecl]);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = await callExecute(tools.deploy as ToolLike, { args: cyclic });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("args 校验失败");
    expect(registryMocks.executeWebhook).not.toHaveBeenCalled();
  });

  it("正常小 args → 不触发校验失败(交权限流程)", async () => {
    // 小 args 不被校验拦截,走到默认 ask 流程(awaitingApproval)
    const tools = buildCustomTools(TID, [webhookDecl]);
    const out = await callExecute(tools.deploy as ToolLike, { args: { env: "prod" } });
    expect(out.error).toBeUndefined(); // 不是校验失败
    expect(out.awaitingApproval).toBe(true);
  });

  it("P1-7 完整化:args 不符声明 schema(缺必填/类型错)→ 拦截", async () => {
    // decl.inputSchema 带 properties + required,模型传缺字段/类型错的 args 被挡
    const strictDecl: CustomToolDeclaration = {
      name: "strictDeploy",
      description: "严格部署",
      inputSchema: {
        type: "object",
        properties: { env: { type: "string" }, replicas: { type: "number" } },
        required: ["env"],
      },
      executorType: "webhook",
      executorConfig: { url: "https://example.com/hook", method: "POST" },
    };
    const tools = buildCustomTools(TID, [strictDecl]);

    // 缺必填 env → 拦截
    const out1 = await callExecute(tools.strictDeploy as ToolLike, { args: { replicas: 3 } });
    expect(out1.ok).toBe(false);
    expect(out1.error).toContain("不符合声明 schema");
    expect(out1.error).toContain("env");

    // env 类型错(number 非 string)→ 拦截
    const out2 = await callExecute(tools.strictDeploy as ToolLike, { args: { env: 123 } });
    expect(out2.ok).toBe(false);
    expect(out2.error).toContain("string");

    // 符合 schema → 不被 Schema 校验拦截(走权限 ask 流程)
    const out3 = await callExecute(tools.strictDeploy as ToolLike, { args: { env: "prod" } });
    expect(out3.error).toBeUndefined();
    expect(out3.awaitingApproval).toBe(true);
  });
});
