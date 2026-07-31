import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

describe("globals.css 表单控件重置", () => {
  it("不在 Tailwind Preflight 之外重复颜色继承，组件文字色可以覆盖基础样式", () => {
    const formControlReset = globalsCss.search(/button,\s+input,\s+textarea,\s+select\s*{/);

    expect(formControlReset).toBe(-1);
  });
});
