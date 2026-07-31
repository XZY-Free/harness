/**
 * V10 Phase 6：审批策略模块单元测试。
 *
 * 覆盖 03-agent-bridge-security.md §7 风险矩阵与 02-desktop-browser-architecture.md §6.2
 * 的 Desktop 端审批校验逻辑。Desktop 不盲信 Server —— 必须对过期、不匹配、超范围
 * approval 一律拒绝。
 */
import {
  type ApprovalDecision,
  type ApprovalScope,
  type RiskLevel,
  SENSITIVE_ACTION_KEYWORDS,
  classifyCommandRisk,
  containsSensitiveKeyword,
  decideApproval,
  requiresApproval,
  validateApprovalScope,
} from "@/lib/desktop/approval";
import { describe, expect, it } from "vitest";

// ─── classifyCommandRisk ───

describe("classifyCommandRisk", () => {
  it("read 命令分类为 read", () => {
    expect(classifyCommandRisk("browser.getTabs", { threadId: "t1" })).toBe("read");
    expect(classifyCommandRisk("browser.getPageMetadata", { threadId: "t1", tabId: "tab1" })).toBe(
      "read",
    );
    expect(classifyCommandRisk("browser.screenshot", { threadId: "t1", tabId: "tab1" })).toBe(
      "read",
    );
    expect(classifyCommandRisk("browser.snapshot", { threadId: "t1", tabId: "tab1" })).toBe("read");
    expect(
      classifyCommandRisk("browser.getAccessibilityTree", { threadId: "t1", tabId: "tab1" }),
    ).toBe("read");
    expect(classifyCommandRisk("browser.getConsole", { threadId: "t1", tabId: "tab1" })).toBe(
      "read",
    );
    expect(classifyCommandRisk("browser.getNetwork", { threadId: "t1", tabId: "tab1" })).toBe(
      "read",
    );
  });

  it("navigation 命令分类为 navigation", () => {
    expect(
      classifyCommandRisk("browser.navigate", {
        threadId: "t1",
        tabId: "tab1",
        url: "https://example.com",
      }),
    ).toBe("navigation");
    expect(classifyCommandRisk("browser.reload", { threadId: "t1", tabId: "tab1" })).toBe(
      "navigation",
    );
    expect(classifyCommandRisk("browser.goBack", { threadId: "t1", tabId: "tab1" })).toBe(
      "navigation",
    );
    expect(classifyCommandRisk("browser.goForward", { threadId: "t1", tabId: "tab1" })).toBe(
      "navigation",
    );
    expect(
      classifyCommandRisk("browser.newTab", { threadId: "t1", url: "https://example.com" }),
    ).toBe("navigation");
    expect(classifyCommandRisk("browser.closeTab", { threadId: "t1", tabId: "tab1" })).toBe(
      "navigation",
    );
    expect(classifyCommandRisk("browser.switchTab", { threadId: "t1", tabId: "tab1" })).toBe(
      "navigation",
    );
  });

  it("browser.scroll 分类为 read", () => {
    expect(
      classifyCommandRisk("browser.scroll", {
        threadId: "t1",
        tabId: "tab1",
        deltaX: 0,
        deltaY: 100,
      }),
    ).toBe("read");
  });

  it("browser.click 不带敏感描述分类为 read", () => {
    expect(
      classifyCommandRisk("browser.click", { threadId: "t1", tabId: "tab1", x: 100, y: 200 }),
    ).toBe("read");
    expect(
      classifyCommandRisk("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "点击查看详情",
      }),
    ).toBe("read");
  });

  it("browser.click 含「删除」分类为 destructive", () => {
    expect(
      classifyCommandRisk("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "删除记录",
      }),
    ).toBe("destructive");
  });

  it("browser.click 含「提交」分类为 external_write", () => {
    expect(
      classifyCommandRisk("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "提交表单",
      }),
    ).toBe("external_write");
  });

  it("browser.click 含「付款」分类为 financial", () => {
    expect(
      classifyCommandRisk("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "付款结算",
      }),
    ).toBe("financial");
  });

  it("browser.doubleClick 同样遵循敏感关键词判定", () => {
    expect(
      classifyCommandRisk("browser.doubleClick", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "发布文章",
      }),
    ).toBe("external_write");
  });

  it("browser.type 默认分类为 local_write", () => {
    expect(
      classifyCommandRisk("browser.type", { threadId: "t1", tabId: "tab1", text: "hello" }),
    ).toBe("local_write");
  });

  it("browser.uploadWorkspaceFile 分类为 local_write", () => {
    expect(
      classifyCommandRisk("browser.uploadWorkspaceFile", {
        threadId: "t1",
        tabId: "tab1",
        selector: "input[type=file]",
        filePath: "downloads/report.pdf",
      }),
    ).toBe("local_write");
  });

  it("browser.select 分类为 local_write", () => {
    expect(
      classifyCommandRisk("browser.select", {
        threadId: "t1",
        tabId: "tab1",
        selector: "select",
        value: "a",
      }),
    ).toBe("local_write");
  });

  it("browser.press 分类为 local_write", () => {
    expect(
      classifyCommandRisk("browser.press", { threadId: "t1", tabId: "tab1", key: "Enter" }),
    ).toBe("local_write");
  });

  it("未知命令保守分类为 external_write", () => {
    expect(classifyCommandRisk("browser.evaluateArbitraryJavaScript", {})).toBe("external_write");
    expect(classifyCommandRisk("browser.readCookies", {})).toBe("external_write");
  });
});

// ─── requiresApproval ───

describe("requiresApproval", () => {
  it("read 命令不需要审批", () => {
    expect(requiresApproval("browser.getTabs", { threadId: "t1" })).toBe(false);
    expect(requiresApproval("browser.screenshot", { threadId: "t1", tabId: "tab1" })).toBe(false);
  });

  it("navigation 命令不需要审批", () => {
    expect(
      requiresApproval("browser.navigate", {
        threadId: "t1",
        tabId: "tab1",
        url: "https://example.com",
      }),
    ).toBe(false);
    expect(requiresApproval("browser.reload", { threadId: "t1", tabId: "tab1" })).toBe(false);
  });

  it("browser.scroll 不需要审批", () => {
    expect(
      requiresApproval("browser.scroll", {
        threadId: "t1",
        tabId: "tab1",
        deltaX: 0,
        deltaY: 100,
      }),
    ).toBe(false);
  });

  it("browser.click 不带敏感描述不需要审批", () => {
    expect(
      requiresApproval("browser.click", { threadId: "t1", tabId: "tab1", x: 100, y: 200 }),
    ).toBe(false);
    expect(
      requiresApproval("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "查看详情",
      }),
    ).toBe(false);
  });

  it("browser.click 含「删除」需要审批", () => {
    expect(
      requiresApproval("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "删除记录",
      }),
    ).toBe(true);
  });

  it("browser.click 含「付款」需要审批", () => {
    expect(
      requiresApproval("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "付款结算",
      }),
    ).toBe(true);
  });

  it("browser.type 默认不需要审批", () => {
    expect(requiresApproval("browser.type", { threadId: "t1", tabId: "tab1", text: "hello" })).toBe(
      false,
    );
  });

  it("browser.click 含「提交」需要审批", () => {
    expect(
      requiresApproval("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "提交表单",
      }),
    ).toBe(true);
  });

  it("browser.click 含「转账」需要审批", () => {
    expect(
      requiresApproval("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "确认转账",
      }),
    ).toBe(true);
  });
});

// ─── decideApproval ───

describe("decideApproval", () => {
  it("read 命令返回 allow", () => {
    expect(decideApproval("browser.getTabs", { threadId: "t1" })).toBe("allow");
    expect(decideApproval("browser.snapshot", { threadId: "t1", tabId: "tab1" })).toBe("allow");
  });

  it("navigation 命令返回 allow", () => {
    expect(
      decideApproval("browser.navigate", {
        threadId: "t1",
        tabId: "tab1",
        url: "https://example.com",
      }),
    ).toBe("allow");
    expect(decideApproval("browser.reload", { threadId: "t1", tabId: "tab1" })).toBe("allow");
  });

  it("browser.scroll 返回 allow", () => {
    expect(
      decideApproval("browser.scroll", {
        threadId: "t1",
        tabId: "tab1",
        deltaX: 0,
        deltaY: 100,
      }),
    ).toBe("allow");
  });

  it("browser.click 不带敏感描述返回 allow", () => {
    expect(decideApproval("browser.click", { threadId: "t1", tabId: "tab1", x: 100, y: 200 })).toBe(
      "allow",
    );
  });

  it("click 含敏感关键词返回 require_approval", () => {
    expect(
      decideApproval("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "删除记录",
      }),
    ).toBe("require_approval");
    expect(
      decideApproval("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "付款",
      }),
    ).toBe("require_approval");
    expect(
      decideApproval("browser.click", {
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        description: "提交表单",
      }),
    ).toBe("require_approval");
  });

  it("credential 返回 deny", () => {
    expect(
      decideApproval("browser.type", {
        threadId: "t1",
        tabId: "tab1",
        text: "secret",
        selector: "input[type=password]",
      }),
    ).toBe("deny");
  });

  it("未知命令返回 require_approval（保守策略）", () => {
    expect(decideApproval("browser.evaluateArbitraryJavaScript", {})).toBe("require_approval");
  });
});

// ─── containsSensitiveKeyword ───

describe("containsSensitiveKeyword", () => {
  it("「删除」返回 true", () => {
    expect(containsSensitiveKeyword("删除")).toBe(true);
  });

  it("「delete」不区分大小写返回 true", () => {
    expect(containsSensitiveKeyword("delete")).toBe(true);
    expect(containsSensitiveKeyword("DELETE")).toBe(true);
    expect(containsSensitiveKeyword("Delete")).toBe(true);
  });

  it("「付款」返回 true", () => {
    expect(containsSensitiveKeyword("付款")).toBe(true);
  });

  it("「提交」返回 true", () => {
    expect(containsSensitiveKeyword("提交")).toBe(true);
  });

  it("「转账」返回 true", () => {
    expect(containsSensitiveKeyword("转账")).toBe(true);
  });

  it("「点击按钮」返回 false", () => {
    expect(containsSensitiveKeyword("点击按钮")).toBe(false);
  });

  it("「查看详情」返回 false", () => {
    expect(containsSensitiveKeyword("查看详情")).toBe(false);
  });

  it("空字符串返回 false", () => {
    expect(containsSensitiveKeyword("")).toBe(false);
  });

  it("描述中包含敏感关键词子串返回 true", () => {
    expect(containsSensitiveKeyword("点击删除按钮")).toBe(true);
    expect(containsSensitiveKeyword("Click to delete record")).toBe(true);
  });
});

// ─── validateApprovalScope ───

describe("validateApprovalScope", () => {
  const NOW = 1700000000000;

  function makeScope(overrides: Partial<ApprovalScope> = {}): ApprovalScope {
    return {
      command: "browser.click",
      threadId: "thread-001",
      tabId: "tab-001",
      expiresAt: NOW + 60000,
      ...overrides,
    };
  }

  it("合法 scope 返回 ok", () => {
    const scope = makeScope();
    const payload = { threadId: "thread-001", tabId: "tab-001", x: 100, y: 200 };
    const result = validateApprovalScope(scope, "browser.click", payload, NOW);
    expect(result.ok).toBe(true);
  });

  it("过期返回 reason: expired", () => {
    const scope = makeScope({ expiresAt: NOW - 1000 });
    const payload = { threadId: "thread-001", tabId: "tab-001", x: 100, y: 200 };
    const result = validateApprovalScope(scope, "browser.click", payload, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }
  });

  it("expiresAt === now 视为过期", () => {
    const scope = makeScope({ expiresAt: NOW });
    const payload = { threadId: "thread-001", tabId: "tab-001", x: 100, y: 200 };
    const result = validateApprovalScope(scope, "browser.click", payload, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }
  });

  it("命令不匹配返回 reason: command_mismatch", () => {
    const scope = makeScope({ command: "browser.click" });
    const payload = { threadId: "thread-001", tabId: "tab-001", x: 100, y: 200 };
    const result = validateApprovalScope(scope, "browser.type", payload, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("command_mismatch");
    }
  });

  it("threadId 不匹配返回 reason: thread_mismatch", () => {
    const scope = makeScope({ threadId: "thread-001" });
    const payload = { threadId: "thread-002", tabId: "tab-001", x: 100, y: 200 };
    const result = validateApprovalScope(scope, "browser.click", payload, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("thread_mismatch");
    }
  });

  it("tabId 不匹配返回 reason: tab_mismatch", () => {
    const scope = makeScope({ tabId: "tab-001" });
    const payload = { threadId: "thread-001", tabId: "tab-002", x: 100, y: 200 };
    const result = validateApprovalScope(scope, "browser.click", payload, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("tab_mismatch");
    }
  });

  it("url 不匹配返回 reason: url_mismatch", () => {
    const scope: ApprovalScope = {
      command: "browser.navigate",
      threadId: "thread-001",
      tabId: "tab-001",
      url: "https://example.com",
      expiresAt: NOW + 60000,
    };
    const payload = {
      threadId: "thread-001",
      tabId: "tab-001",
      url: "https://evil.com",
    };
    const result = validateApprovalScope(scope, "browser.navigate", payload, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("url_mismatch");
    }
  });

  it("scope 无 tabId 时跳过 tabId 校验", () => {
    const scope = makeScope();
    const { tabId, ...rest } = scope;
    void tabId;
    const scopeWithoutTab: ApprovalScope = rest;
    const payload = { threadId: "thread-001", tabId: "tab-001", x: 100, y: 200 };
    const result = validateApprovalScope(scopeWithoutTab, "browser.click", payload, NOW);
    expect(result.ok).toBe(true);
  });

  it("payload 无 tabId 时跳过 tabId 校验", () => {
    const scope = makeScope({ tabId: "tab-001" });
    const payload = { threadId: "thread-001", x: 100, y: 200 };
    const result = validateApprovalScope(scope, "browser.click", payload, NOW);
    expect(result.ok).toBe(true);
  });

  it("url 匹配时 navigate 命令通过", () => {
    const scope: ApprovalScope = {
      command: "browser.navigate",
      threadId: "thread-001",
      tabId: "tab-001",
      url: "https://example.com",
      expiresAt: NOW + 60000,
    };
    const payload = {
      threadId: "thread-001",
      tabId: "tab-001",
      url: "https://example.com",
    };
    const result = validateApprovalScope(scope, "browser.navigate", payload, NOW);
    expect(result.ok).toBe(true);
  });
});

// ─── Credential denial ───

describe("Credential denial", () => {
  it("browser.type 选择器含 password 视为 credential 并 deny", () => {
    const risk: RiskLevel = classifyCommandRisk("browser.type", {
      threadId: "t1",
      tabId: "tab1",
      text: "secret",
      selector: "input[type=password]",
    });
    expect(risk).toBe("credential");
    const decision: ApprovalDecision = decideApproval("browser.type", {
      threadId: "t1",
      tabId: "tab1",
      text: "secret",
      selector: "input[type=password]",
    });
    expect(decision).toBe("deny");
  });

  it("browser.type 选择器含 pwd 视为 credential", () => {
    const risk = classifyCommandRisk("browser.type", {
      threadId: "t1",
      tabId: "tab1",
      text: "secret",
      selector: "#pwd-field",
    });
    expect(risk).toBe("credential");
  });

  it("browser.type 选择器含 password（大写）视为 credential", () => {
    const risk = classifyCommandRisk("browser.type", {
      threadId: "t1",
      tabId: "tab1",
      text: "secret",
      selector: "#PASSWORD",
    });
    expect(risk).toBe("credential");
  });

  it("credential 不进入审批流程（requiresApproval 为 false，由 decideApproval 直接 deny）", () => {
    // credential 风险等级不通过 approval 放行 —— AI 不得代填密码
    expect(
      requiresApproval("browser.type", {
        threadId: "t1",
        tabId: "tab1",
        text: "secret",
        selector: "input[type=password]",
      }),
    ).toBe(false);
    expect(
      decideApproval("browser.type", {
        threadId: "t1",
        tabId: "tab1",
        text: "secret",
        selector: "input[type=password]",
      }),
    ).toBe("deny");
  });
});

// ─── SENSITIVE_ACTION_KEYWORDS ───

describe("SENSITIVE_ACTION_KEYWORDS", () => {
  it("包含规格要求的关键词", () => {
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("删除");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("delete");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("remove");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("destroy");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("提交");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("submit");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("send");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("发送");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("发布");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("publish");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("post");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("付款");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("pay");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("purchase");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("buy");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("checkout");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("取消");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("cancel");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("确认");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("confirm");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("转账");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("transfer");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("修改密码");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("change password");
    expect(SENSITIVE_ACTION_KEYWORDS).toContain("reset password");
  });
});
