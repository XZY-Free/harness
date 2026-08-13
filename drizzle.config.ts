import { dbConfig } from "@/lib/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./lib/persistence/schema/*.ts",
    "./lib/control-plane/events/control-plane-event-delivery.ts",
    "./lib/control-plane/events/control-plane-outbox.ts",
    "./lib/artifacts/persistence/artifact-record.ts",
    "./lib/publications/persistence/publication-record.ts",
    "./lib/routes/persistence/route-revision-record.ts",
    "./lib/routes/projection/route-eligibility-projection-record.ts",
    "./lib/runtime/persistence/runtime-conformance-run-record.ts",
    "./lib/runtime/persistence/hosted-provisioning-request-record.ts",
  ],
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: dbConfig.url,
  },
});
