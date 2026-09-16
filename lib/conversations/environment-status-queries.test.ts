import type { EnvironmentDefinition, EnvironmentLease } from "@/lib/persistence/schema/environment";
import type { EnvironmentDefinitionRevision } from "@/lib/persistence/schema/environment-definition-revision";
import { describe, expect, it } from "vitest";
import { deriveAvailability } from "./environment-status-queries";

function definition(): EnvironmentDefinition {
  return {
    id: "def-1",
    tenantId: "tnt-1",
    environmentKey: "default",
    displayName: "Default",
    description: null,
    lifecycleState: "active",
    currentRevisionId: "revision-1",
    lastRevisionNo: 1,
    versionNo: 1,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    deletedAt: null,
  };
}

function revision(
  environmentType: EnvironmentDefinitionRevision["environmentType"],
): EnvironmentDefinitionRevision {
  return {
    id: "revision-1",
    tenantId: "tnt-1",
    definitionId: "def-1",
    revisionNo: 1,
    environmentType,
    filesystemPolicyJson: {},
    networkPolicyJson: {},
    resourceLimitsJson: {},
    secretPolicyJson: {},
    executionTarget: { kind: "managed_host", reference: "test-host" },
    requiredCapabilities: {},
    semanticDigest: `sha256:${"1".repeat(64)}`,
    createdByType: "user",
    createdById: "user-1",
    createdAt: new Date("2026-07-01T00:00:00Z"),
  };
}

function lease(state: EnvironmentLease["leaseState"] = "active"): EnvironmentLease {
  return {
    id: "lease-1",
    tenantId: "tnt-1",
    invocationId: "inv-1",
    attemptId: "attempt-1",
    environmentDefinitionRevisionId: "revision-1",
    deviceId: "device-1",
    workerRef: null,
    hostIdentity: null,
    storageIdentity: null,
    leaseState: state,
    readinessState: "ready",
    capabilitiesJson: {},
    complianceEvidence: null,
    complianceDigest: null,
    preparedEvidence: null,
    preparedDigest: null,
    preparedAt: null,
    activationOwnershipId: null,
    resourceManifest: {},
    cleanupLeaseOwner: null,
    cleanupLeaseExpiresAt: null,
    nextCleanupAt: null,
    cleanupCount: 0,
    lastErrorCode: null,
    versionNo: 1,
    allocatedAt: new Date("2026-07-01T00:00:00Z"),
    lastHeartbeatAt: new Date("2026-07-01T00:01:00Z"),
    expiresAt: new Date("2026-07-01T01:00:00Z"),
    releasedAt: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
  };
}

const input = (
  environmentType: EnvironmentDefinitionRevision["environmentType"],
  activeLease: EnvironmentLease | null,
  deviceOnline: boolean | null,
) => ({
  environmentDefinition: definition(),
  environmentRevision: revision(environmentType),
  activeLease,
  deviceOnline,
});

describe("deriveAvailability", () => {
  it("缺少 Definition 时返回 no_environment", () => {
    expect(
      deriveAvailability({ environmentDefinition: null, activeLease: null, deviceOnline: null }),
    ).toBe("no_environment");
  });

  it.each(["cloud", "remote", "sandbox"] as const)("非 Desktop Revision %s 返回 cloud", (type) => {
    expect(deriveAvailability(input(type, null, null))).toBe("cloud");
  });

  it("Desktop 无 Lease 返回 offline_desktop", () => {
    expect(deriveAvailability(input("desktop", null, null))).toBe("offline_desktop");
  });

  it.each(["released", "expired", "lost"] as const)(
    "Desktop 终态 Lease %s 返回 offline_desktop",
    (state) => {
      expect(deriveAvailability(input("desktop", lease(state), null))).toBe("offline_desktop");
    },
  );

  it.each(["allocated", "releasing"] as const)(
    "Desktop 非活动 Lease %s 返回 pending_device",
    (state) => {
      expect(deriveAvailability(input("desktop", lease(state), null))).toBe("pending_device");
    },
  );

  it("Desktop active Lease 且设备在线返回 online_desktop", () => {
    expect(deriveAvailability(input("desktop", lease(), true))).toBe("online_desktop");
  });

  it("Desktop active Lease 且设备离线或未知返回 pending_device", () => {
    expect(deriveAvailability(input("desktop", lease(), false))).toBe("pending_device");
    expect(deriveAvailability(input("desktop", lease(), null))).toBe("pending_device");
  });
});
