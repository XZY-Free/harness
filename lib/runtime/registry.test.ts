import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetDockerAvailableForTest,
  __setDockerAvailableForTest,
} from "./container/availability";
import { resolveRuntimes } from "./registry";

afterEach(() => {
  __resetDockerAvailableForTest();
  Reflect.deleteProperty(process.env, "RUNTIME_DEGRADE_ON_DOCKER_UNAVAILABLE");
  vi.restoreAllMocks();
});

describe("resolveRuntimes docker availability", () => {
  it("container runtime 在 docker 不可用且未允许降级时 fail-closed", () => {
    __setDockerAvailableForTest(false);
    process.env.RUNTIME_DEGRADE_ON_DOCKER_UNAVAILABLE = "false";

    expect(() => resolveRuntimes("tid", "container")).toThrow(/拒绝降级 host/);
  });

  it("显式允许降级时返回 host capability 并记录 warn", () => {
    __setDockerAvailableForTest(false);
    process.env.RUNTIME_DEGRADE_ON_DOCKER_UNAVAILABLE = "true";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const runtime = resolveRuntimes("tid", "container");

    expect(runtime.capability.runtimeType).toBe("host");
    expect(runtime.capability.available).toBe(true);
    expect(runtime.capability.degradedFrom).toBe("container");
    expect(runtime.capability.degradedReason).toBe("docker_unavailable");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("按配置降级 host"));
  });
});
