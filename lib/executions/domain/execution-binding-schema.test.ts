import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("ExecutionBinding Attestation JSON 基线约束", () => {
 it("Drizzle Schema 与 0000 SQL 都限定为非空 JSON Array", () => {
 const schema = projectFile("lib/persistence/schema/runtime.ts");
 const baseline = projectFile("drizzle/0000_initial_schema.sql");

 for (const column of ["agentAttestationIds", "runtimeAttestationIds"]) {
 expect(schema).toContain(
 `JSON_TYPE(\${t.${column}}) = 'ARRAY' AND JSON_LENGTH(\${t.${column}}) >= 1`,
 );
 expect(baseline).toContain(
 `JSON_TYPE(\`${column}\`) = 'ARRAY' AND JSON_LENGTH(\`${column}\`) >= 1`,
 );
 }
 });
});
