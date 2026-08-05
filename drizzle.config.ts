import { dbConfig } from "@/lib/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./lib/persistence/schema/*.ts",
    "./lib/control-plane/events/*.ts",
    "./lib/artifacts/persistence/artifact-record.ts",
    "./lib/publications/persistence/publication-record.ts",
    "./lib/routes/persistence/route-revision-record.ts",
    "./lib/routes/projection/route-eligibility-projection-record.ts",
    "./lib/runtimes/persistence/runtime-conformance-run-record.ts",
    "./lib/runtimes/persistence/hosted-provisioning-request-record.ts",
  ],
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: dbConfig.url,
  },
});
