import { describe, expect, it } from "vitest";
import {
 assertAffectedRowsExactlyOne,
 assertClaimAffectedRows,
 extractClaimableRequestIds,
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

describe("claimRequests result authority", () => {
 it("extracts ids from the mysql2 [rows, fields] tuple", () => {
 const fields = [{ name: "id" }];

 expect(
 extractClaimableRequestIds([[{ id: "request-1" }, { id: "request-2" }], fields]),
 ).toEqual(["request-1", "request-2"]);
 });

 it.each([
 { rawResult: [] },
 { rawResult: [[{ missing: "request-1" }], []] },
 { rawResult: [[{ id: "" }], []] },
 { rawResult: [[{ id: "request-1" }, { id: "request-1" }], []] },
 ])("fails closed for malformed mysql2 rows: $rawResult", ({ rawResult }) => {
 expect(() => extractClaimableRequestIds(rawResult)).toThrow();
 });

 it("requires the claim update to affect every selected row", () => {
 expect(() => assertClaimAffectedRows(2, ["request-1", "request-2"])).not.toThrow();
 expect(() => assertClaimAffectedRows(1, ["request-1", "request-2"])).toThrow();
 expect(() => assertClaimAffectedRows(undefined, ["request-1"])).toThrow();
 });
});
