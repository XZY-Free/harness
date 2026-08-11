import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("web formal thread route contract", () => {
  it("renders the shared Thread page without reading the legacy chat store", () => {
    const source = readFileSync(join(process.cwd(), "app/chat/[threadId]/page.tsx"), "utf8");

    expect(source).toContain("ThreadPage");
    expect(source).toContain("WebNewThreadPage");
    expect(source).not.toMatch(/Workspace|getMessagesByThreadId|ThreadStatus|lib\/db\/schema/);
  });

  it("removes the legacy chat execution route", () => {
    expect(existsSync(join(process.cwd(), "app/api/chat/route.ts"))).toBe(false);
  });
});
