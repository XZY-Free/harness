import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_ROOTS = ["app", "components", "desktop", "lib", "scripts", "docs", "tests"];
const retiredVersion = `v${11}`;
const forbidden = new RegExp(
  [`/${retiredVersion}/`, `/${retiredVersion.toUpperCase()}/`, `${retiredVersion}-`, `use${retiredVersion.toUpperCase()}`, `build${retiredVersion.toUpperCase()}`].join("|"),
);

function sourceFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => {
    if (["node_modules", ".git", ".next", "build", "dist", "__pycache__"].includes(entry)) {
      return [];
    }
    return sourceFiles(join(path, entry));
  });
}

describe("repository architecture naming contract", () => {
  it("contains no retired version file names or source symbols", () => {
    const violations = SCAN_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root)))
      .filter((file) => !file.endsWith(".DS_Store"))
      .flatMap((file) => {
        const path = relative(ROOT, file);
        const source = readFileSync(file, "utf8");
        return forbidden.test(`/${path}`) || forbidden.test(source) ? [path] : [];
      });
    expect(violations).toEqual([]);
  });

  it("keeps permanent contracts and validation entry points", () => {
    expect(existsSync(join(ROOT, "docs/contracts/openapi.json"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts/contracts.mjs"))).toBe(true);
    expect(existsSync(join(ROOT, `scripts/${retiredVersion}-contracts.mjs`))).toBe(false);
  });
});
