// Generates the 0000_init migration via the drizzle-kit programmatic API
// (the CLI is unavailable in this sandbox). Mirrors `drizzle-kit generate`:
// writes drizzle/0000_init.sql, drizzle/meta/_journal.json, drizzle/meta/0000_snapshot.json.
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as schema from "../src/db/schema/index.ts";

const OUT = join(dirname(new URL(import.meta.url).pathname), "..", "drizzle");
const TAG = "0000_init";

const prevJson = generateDrizzleJson({});
const curJson = generateDrizzleJson(schema, prevJson.id);
const sqlStatements = await generateMigration(prevJson, curJson);

const sql = sqlStatements.join("\n");

await mkdir(join(OUT, "meta"), { recursive: true });
await writeFile(join(OUT, `${TAG}.sql`), sql + (sql ? "\n" : ""));
await writeFile(join(OUT, "meta", `${TAG.split("_")[0]}_snapshot.json`), JSON.stringify(curJson, null, 2));

const journal = {
  version: "7",
  dialect: "postgresql",
  entries: [{ idx: 0, version: "7", when: Date.now(), tag: TAG, breakpoints: true }],
};
await writeFile(join(OUT, "meta", "_journal.json"), JSON.stringify(journal, null, 2));

console.log("Generated migration:", TAG);
console.log("--- SQL ---");
console.log(sql || "(empty — only enum scaffolding, no domain tables)");
