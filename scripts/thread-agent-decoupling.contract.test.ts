import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EVENT_CATALOG_PATH = join(process.cwd(), "docs/contracts/event-catalog.json");

describe("Topic01 Thread 与 Agent 解耦合同", () => {
  it("正式事件目录不再声明 Thread 主 Agent 变更事件", () => {
    const catalog = JSON.parse(readFileSync(EVENT_CATALOG_PATH, "utf8")) as {
      events?: Record<string, unknown>;
    };

    expect(catalog.events).toBeDefined();
    expect(catalog.events).not.toHaveProperty("thread.primary_agent_changed");
  });
});
