import { dbConfig } from "@/lib/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./lib/persistence/schema/index.ts"],
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: dbConfig.url,
  },
});
