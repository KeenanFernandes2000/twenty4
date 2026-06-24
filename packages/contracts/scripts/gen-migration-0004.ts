// Generates the 0004_user_timezone migration via the drizzle-kit programmatic API
// (the CLI is blocked in this sandbox). Diffs the CURRENT schema against the 0003
// snapshot and writes drizzle/0004_user_timezone.sql + meta files. (M4 HIGH-3:
// adds user.timezone — the canonical server-anchored tz for day_bucket bucketing.)
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as schema from "../src/db/schema/index.ts";

const OUT = join(dirname(new URL(import.meta.url).pathname), "..", "drizzle");
const TAG = "0004_user_timezone";

const prevSnapshot = JSON.parse(await readFile(join(OUT, "meta", "0003_snapshot.json"), "utf8"));
const curJson = generateDrizzleJson(schema, prevSnapshot.id);
const sqlStatements = await generateMigration(prevSnapshot, curJson);

const sql = sqlStatements.join("\n");

await mkdir(join(OUT, "meta"), { recursive: true });
await writeFile(join(OUT, `${TAG}.sql`), sql + (sql ? "\n" : ""));
await writeFile(join(OUT, "meta", "0004_snapshot.json"), JSON.stringify(curJson, null, 2));

const journalPath = join(OUT, "meta", "_journal.json");
const journal = JSON.parse(await readFile(journalPath, "utf8"));
journal.entries.push({ idx: 4, version: "7", when: Date.now(), tag: TAG, breakpoints: true });
await writeFile(journalPath, JSON.stringify(journal, null, 2));

console.log("Generated migration:", TAG);
console.log("--- SQL ---");
console.log(sql || "(empty)");
