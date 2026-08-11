import { describe, expect, it } from "vitest";
import {
 assertAffectedRowsExactlyOne,
 HostedProvisioningLeaseLostError,
} from "./mysql-hosted-provisioning-request-store";

describe("assertAffectedRowsExactlyOne", () => {
 it("accepts exactly one affected row", () => {
 expect(() =>
 assertAffectedRowsExactlyOne(1, {
 operation: "updateState",
 requestId: "request-1",
 workerId: "worker-1",
 }),
 ).not.toThrow();
 });

 it.each([0, undefined])("fails closed when affectedRows is %s", (affectedRows) => {
 expect(() =>
 assertAffectedRowsExactlyOne(affectedRows, {
 operation: "releaseLease",
 requestId: "request-1",
 workerId: "worker-1",
 }),
 ).toThrow(HostedProvisioningLeaseLostError);
 });
});
