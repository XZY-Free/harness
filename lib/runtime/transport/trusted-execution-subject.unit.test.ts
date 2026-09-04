import {
  TrustedExecutionSubjectError,
  freezeTrustedExecutionSubject,
  recoverTrustedExecutionSubject,
  recoverTrustedExecutionSubjectForMigration,
} from "@/lib/runtime/transport/execution-subject";
import { describe, expect, it } from "vitest";

describe("trusted execution subject", () => {
  const frozenAt = new Date("2026-09-04T01:02:03.000Z");

  it.each([
    ["user", "employee-42", "authenticated_user"],
    ["service", "job-scheduler", "trusted_service"],
  ] as const)(
    "freezes %s identity into one binding authority",
    (subjectType, subjectId, source) => {
      expect(
        freezeTrustedExecutionSubject(
          { tenantId: "tenant-a", subjectType, subjectId },
          "tenant-a",
          frozenAt,
        ),
      ).toEqual({
        executionSubjectType: subjectType,
        executionSubjectId: subjectId,
        executionSubjectSource: source,
        executionSubjectFrozenAt: frozenAt,
      });
    },
  );

  it("rejects missing, cross-tenant, and source-conflicting subjects", () => {
    expect(() =>
      freezeTrustedExecutionSubject(
        { tenantId: "tenant-b", subjectType: "user", subjectId: "employee-42" },
        "tenant-a",
        frozenAt,
      ),
    ).toThrow(TrustedExecutionSubjectError);
    expect(() =>
      recoverTrustedExecutionSubject(
        {
          tenantId: "tenant-a",
          executionSubjectType: "user",
          executionSubjectId: "",
          executionSubjectSource: "authenticated_user",
          executionSubjectFrozenAt: frozenAt,
        },
        "tenant-a",
      ),
    ).toThrow(TrustedExecutionSubjectError);
    expect(() =>
      recoverTrustedExecutionSubject(
        {
          tenantId: "tenant-a",
          executionSubjectType: "user",
          executionSubjectId: "employee-42",
          executionSubjectSource: "trusted_service",
          executionSubjectFrozenAt: frozenAt,
        },
        "tenant-a",
      ),
    ).toThrow(TrustedExecutionSubjectError);
  });

  it("migration only backfills from immutable owner or service facts", () => {
    expect(
      recoverTrustedExecutionSubjectForMigration({
        tenantId: "tenant-a",
        executionState: "running",
        threadOwnerUserIdentityId: "employee-42",
        trustedServiceId: null,
      }),
    ).toEqual({ tenantId: "tenant-a", subjectType: "user", subjectId: "employee-42" });
    expect(
      recoverTrustedExecutionSubjectForMigration({
        tenantId: "tenant-a",
        executionState: "queued",
        threadOwnerUserIdentityId: null,
        trustedServiceId: "job-scheduler",
      }),
    ).toEqual({ tenantId: "tenant-a", subjectType: "service", subjectId: "job-scheduler" });
  });

  it("migration fails closed for unrecoverable active bindings and never invents a user", () => {
    expect(() =>
      recoverTrustedExecutionSubjectForMigration({
        tenantId: "tenant-a",
        executionState: "waiting_user",
        threadOwnerUserIdentityId: null,
        trustedServiceId: null,
      }),
    ).toThrow(TrustedExecutionSubjectError);
    expect(
      recoverTrustedExecutionSubjectForMigration({
        tenantId: "tenant-a",
        executionState: "completed",
        threadOwnerUserIdentityId: null,
        trustedServiceId: null,
      }),
    ).toBeNull();
  });
});
