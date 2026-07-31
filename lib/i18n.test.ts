import { describe, expect, it } from "vitest";
import { STATUS_LABEL, TOOL_LABELS, getCurrentLocale, statusLabel, t, toolLabel } from "./i18n";

/**
 * 12-P1-6：i18n 字典完整性 + t() 回退测试。
 *
 * 验证：
 * - t() 缺 key 返回 key 本身（fail-open）
 * - t() 支持 {placeholder} 插值
 * - zh / en 字典 key 集合一致（避免 en 缺 key）
 * - STATUS_LABEL / TOOL_LABELS zh/en key 集合一致
 * - statusLabel / toolLabel 缺值回退原值
 * - zh 字典覆盖 Studio 各面板核心 key（迁移完整性抽样）
 */

describe("i18n t() 函数", () => {
  it("缺 key 返回 key 本身（fail-open，不抛）", () => {
    expect(t("nonexistent.key.such")).toBe("nonexistent.key.such");
  });

  it("已知 key 返回 zh 翻译", () => {
    expect(t("studio.subagent.empty")).toBe("当前 thread 无子代理。");
    expect(t("studio.approval.approve")).toBe("批准");
    expect(t("studio.threads.title")).toBe("会话");
  });

  it("支持 {placeholder} 插值", () => {
    expect(t("studio.subagent.load_failed", { error: "HTTP 500" })).toBe("加载失败：HTTP 500");
    expect(t("chat.upload.max_files", { n: 5 })).toBe("单次最多 5 个文件");
    expect(t("chat.upload.too_large", { name: "big.png" })).toBe("big.png 超过 20MB 限制");
  });

  it("插值缺变量保留 {name} 占位符", () => {
    expect(t("studio.subagent.load_failed", {})).toBe("加载失败：{error}");
  });

  it("getCurrentLocale 默认 zh", () => {
    expect(getCurrentLocale()).toBe("zh");
  });
});

describe("i18n 字典完整性（zh / en key 集合一致）", () => {
  // 从 t() 内部 DICT 抽 key 不便（DICT 未导出），改用已知 key 抽样验证 en 也有
  const SAMPLE_KEYS = [
    "common.refreshing",
    "common.cancel",
    "chat.empty.title",
    "chat.placeholder.send",
    "chat.stop",
    "chat.connection.reconnecting",
    "studio.nav.title",
    "studio.nav.overview",
    "studio.overview.title",
    "studio.overview.metric.threads",
    "studio.overview.empty.threads",
    "studio.threads.title",
    "studio.threads.col.thread",
    "studio.subagent.loading",
    "studio.subagent.empty",
    "studio.approval.approve",
    "studio.approval.deny",
    "studio.task.loading",
    "studio.qa.empty",
    "studio.auto_refresh.label",
  ];

  it("抽样 key 在 zh 字典都有值", () => {
    for (const key of SAMPLE_KEYS) {
      const value = t(key, undefined, "zh");
      expect(value, `zh key ${key} 应有翻译`).not.toBe(key);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("en 字典覆盖同 key 集合", () => {
    for (const key of SAMPLE_KEYS) {
      const value = t(key, undefined, "en");
      expect(value, `en key ${key} 应有翻译`).not.toBe(key);
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe("STATUS_LABEL / TOOL_LABELS", () => {
  it("zh / en 状态 key 集合一致", () => {
    const zhKeys = Object.keys(STATUS_LABEL.zh).sort();
    const enKeys = Object.keys(STATUS_LABEL.en).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("zh / en 工具 key 集合一致", () => {
    const zhKeys = Object.keys(TOOL_LABELS.zh).sort();
    const enKeys = Object.keys(TOOL_LABELS.en).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("statusLabel 已知值返回翻译", () => {
    expect(statusLabel("executing")).toBe("执行中");
    expect(statusLabel("executing", "en")).toBe("Executing");
  });

  it("statusLabel 未知值回退原值", () => {
    expect(statusLabel("unknown_status")).toBe("unknown_status");
  });

  it("toolLabel 已知值返回翻译", () => {
    expect(toolLabel("writeFile")).toBe("写入文件");
    expect(toolLabel("writeFile", "en")).toBe("Write File");
  });

  it("toolLabel 未知值回退原值", () => {
    expect(toolLabel("unknownTool")).toBe("unknownTool");
  });
});

describe("12-P1-6 迁移完整性：各面板核心 key 存在", () => {
  // 验证迁移过的面板都有对应 key（防止回退或遗漏）
  const PANEL_KEYS = {
    "subagent-panel": [
      "studio.subagent.loading",
      "studio.subagent.empty",
      "studio.subagent.goal",
      "studio.subagent.cancel",
    ],
    "approval-panel": [
      "studio.approval.loading",
      "studio.approval.empty",
      "studio.approval.approve",
      "studio.approval.deny",
    ],
    "background-task-panel": ["studio.task.loading", "studio.task.empty"],
    "qa-panel": ["studio.qa.empty", "studio.qa.passed", "studio.qa.failed"],
    "thread-auto-refresh": ["studio.auto_refresh.label", "common.realtime"],
    "chat-panel": [
      "chat.empty.title",
      "chat.empty.subtitle",
      "chat.placeholder.send",
      "chat.stop",
      "chat.connection.reconnecting",
    ],
    "studio nav": [
      "studio.nav.title",
      "studio.nav.overview",
      "studio.nav.agents",
      "studio.nav.capabilities",
      "studio.nav.conversations",
      "studio.nav.runtime",
      "studio.nav.observability",
      "studio.nav.security",
      "studio.nav.operations",
      "studio.nav.settings",
    ],
    "threads 列表页": ["studio.threads.title", "studio.threads.empty", "studio.threads.col.thread"],
    "studio 总览页": [
      "studio.overview.title",
      "studio.overview.metric.threads",
      "studio.overview.empty.threads",
    ],
  };

  for (const [panel, keys] of Object.entries(PANEL_KEYS)) {
    it(`${panel} 核心 key 在 zh 字典都有翻译`, () => {
      for (const key of keys) {
        const value = t(key, undefined, "zh");
        expect(value, `${panel} 缺 zh key: ${key}`).not.toBe(key);
      }
    });
    it(`${panel} 核心 key 在 en 字典都有翻译`, () => {
      for (const key of keys) {
        const value = t(key, undefined, "en");
        expect(value, `${panel} 缺 en key: ${key}`).not.toBe(key);
      }
    });
  }
});
