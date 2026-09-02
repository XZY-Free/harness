import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Studio 路由状态文件", () => {
  it.each(["loading.tsx", "error.tsx", "not-found.tsx"])("提供 %s", (filename) => {
    expect(existsSync(join(process.cwd(), "app/studio", filename))).toBe(true);
  });
});
