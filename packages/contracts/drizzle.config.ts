import { defineConfig } from "drizzle-kit";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://twenty4:twenty4@localhost:5433/twenty4";

export default defineConfig({
  dialect: "postgresql",
  // Glob MUST include enums.ts so pgEnums are emitted as CREATE TYPE.
  // See PHASE1_WORK_RECAP.md §5.
  schema: "./src/db/schema/*.ts",
  out: "./drizzle",
  dbCredentials: {
    url: DATABASE_URL,
  },
});
