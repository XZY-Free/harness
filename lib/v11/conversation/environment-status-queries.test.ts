/**
 * S10-W06：deriveAvailability 纯函数单元测试。
 *
 * 覆盖：
 * - no_environment：EnvironmentDefinition 为 null。
 * - cloud：Environment 类型为 cloud/remote/sandbox。
 * - offline_desktop：Desktop 类型 + Lease 终态或无 Lease。
 * - pending_device：Desktop 类型 + Lease allocated/releasing，或 Lease active 但设备离线。
 * - online_desktop：Desktop 类型 + Lease active + 设备在线。
 *
 * 不覆盖 getEnvironmentStatus（需要真实 MySQL，由 environment.test.ts 覆盖底层 queries）。
 */
import type { V11EnvironmentDefinition, V11EnvironmentLease } from "@/lib/v11/schema/environment";
import { describe, expect, it } from "vitest";
import { deriveAvailability } from "./environment-status-queries";

function makeDefinition(
  overrides: Partial<V11EnvironmentDefinition> = {},
): V11EnvironmentDefinition {
  return {
    id: "def-1",
    tenantId: "tnt-1",
    environmentKey: "desktop-default",
    displayName: "Desktop 默认",
    description: null,
    environmentType: "desktop",
    filesystemPolicyJson: {},
    networkPolicyJson: {},
    resourceLimitsJson: {},
    secretPolicyJson: {},
    lifecycleState: "active",
    versionNo: 1,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

function makeLease(overrides: Partial<V11EnvironmentLease> = {}): V11EnvironmentLease {
  return {
    id: "lease-1",
    tenantId: "tnt-1",
    environmentDefinitionId: "def-1",
    invocationId: "inv-1",
    attemptId: "att-1",
    deviceId: "dev-1",
    workerRef: null,
    leaseState: "active",
    capabilitiesJson: null,
    allocatedAt: new Date("2026-07-01T00:00:00Z"),
    lastHeartbeatAt: new Date("2026-07-01T00:01:00Z"),
    releasedAt: null,
    expiresAt: new Date("2026-07-01T01:00:00Z"),
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

describe("deriveAvailability", () => {
  it("EnvironmentDefinition 为 null → no_environment", () => {
    expect(
      deriveAvailability({
        environmentDefinition: null,
        activeLease: null,
        deviceOnline: null,
      }),
    ).toBe("no_environment");
  });

  it("Environment 类型 cloud → cloud", () => {
    expect(
      deriveAvailability({
        environmentDefinition: makeDefinition({ environmentType: "cloud" }),
        activeLease: null,
        deviceOnline: null,
      }),
    ).toBe("cloud");
  });

  it("Environment 类型 remote → cloud", () => {
    expect(
      deriveAvailability({
        environmentDefinition: makeDefinition({ environmentType: "remote" }),
        activeLease: null,
        deviceOnline: null,
      }),
    ).toBe("cloud");
  });

  it("Environment 类型 sandbox → cloud", () => {
    expect(
      deriveAvailability({
        environmentDefinition: makeDefinition({ environmentType: "sandbox" }),
        activeLease: null,
        deviceOnline: null,
      }),
    ).toBe("cloud");
  });

  it("Desktop 类型 + 无 Lease → offline_desktop", () => {
    expect(
      deriveAvailability({
        environmentDefinition: makeDefinition({ environmentType: "desktop" }),
        activeLease: null,
        deviceOnline: null,
      }),
    ).toBe("offline_desktop");
  });

  it.each(["released", "expired", "lost"])(
    "Desktop 类型 + Lease 终态 %s → offline_desktop",
    (state) => {
      expect(
        deriveAvailability({
          environmentDefinition: makeDefinition({ environmentType: "desktop" }),
          activeLease: makeLease({ leaseState: state as V11EnvironmentLease["leaseState"] }),
          deviceOnline: null,
        }),
      ).toBe("offline_desktop");
    },
  );

  it.each(["allocated", "releasing"])("Desktop 类型 + Lease %s → pending_device", (state) => {
    expect(
      deriveAvailability({
        environmentDefinition: makeDefinition({ environmentType: "desktop" }),
        activeLease: makeLease({ leaseState: state as V11EnvironmentLease["leaseState"] }),
        deviceOnline: null,
      }),
    ).toBe("pending_device");
  });

  it("Desktop 类型 + Lease active + 设备在线 → online_desktop", () => {
    expect(
      deriveAvailability({
        environmentDefinition: makeDefinition({ environmentType: "desktop" }),
        activeLease: makeLease({ leaseState: "active" }),
        deviceOnline: true,
      }),
    ).toBe("online_desktop");
  });

  it("Desktop 类型 + Lease active + 设备离线 → pending_device", () => {
    expect(
      deriveAvailability({
        environmentDefinition: makeDefinition({ environmentType: "desktop" }),
        activeLease: makeLease({ leaseState: "active" }),
        deviceOnline: false,
      }),
    ).toBe("pending_device");
  });

  it("Desktop 类型 + Lease active + deviceOnline=null → pending_device（保守降级）", () => {
    expect(
      deriveAvailability({
        environmentDefinition: makeDefinition({ environmentType: "desktop" }),
        activeLease: makeLease({ leaseState: "active" }),
        deviceOnline: null,
      }),
    ).toBe("pending_device");
  });
});
