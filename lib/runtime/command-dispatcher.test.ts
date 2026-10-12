import {
  dispatchCancelCommand,
  dispatchResumeCommand,
  dispatchSteerCommand,
} from "@/lib/runtime/command-dispatcher";
import { describe, expect, it } from "vitest";

describe("InvocationCommand dispatcher canonical surface", () => {
  it("offers the three durable command deliveries without protocol-specific aliases", () => {
    expect(dispatchCancelCommand.name).toBe("dispatchCancelCommand");
    expect(dispatchResumeCommand.name).toBe("dispatchResumeCommand");
    expect(dispatchSteerCommand.name).toBe("dispatchSteerCommand");
  });
});
