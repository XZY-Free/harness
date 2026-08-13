import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

describe("final CI workflow contract", () => {
  it.each([
    ["Contract verification", "pnpm contracts:verify"],
    ["Architecture gate", "pnpm architecture:gate"],
    ["Dependency architecture", "pnpm architecture:check"],
    ["Type check", "pnpm typecheck"],
    ["Lint", "pnpm lint"],
    ["Empty MySQL migration", "pnpm db:migrate"],
    ["Seed", "pnpm db:seed"],
    ["Unit and MySQL integration tests", "pnpm test"],
    ["Control-plane and Hosted E2E", "lib/control-plane/end-to-end-acceptance.test.ts"],
    ["Web Playwright E2E", "pnpm test:e2e"],
    ["Desktop build", "pnpm build:desktop"],
    ["Desktop smoke", "desktop/main/local-renderer-server.test.ts"],
    ["Production Web build", "pnpm build:prod"],
    ["Security check", "pnpm security:check"],
  ])("declares %s as a visible check", (name, command) => {
    expect(workflow).toContain(`name: ${name}`);
    expect(workflow).toContain(command);
  });
});
