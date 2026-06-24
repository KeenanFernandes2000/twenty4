// Generates the 0001_auth migration via the drizzle-kit programmatic API
// (the CLI is blocked in this sandbox). Diffs the CURRENT schema against the
// 0000 snapshot and writes drizzle/0001_auth.sql + meta files.
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as schema from "../src/db/schema/index.ts";

const OUT = join(dirname(new URL(import.meta.url).pathname), "..", "drizzle");
const TAG = "0001_auth";

// Previous state = the 0000 snapshot already written/applied.
const prevSnapshot = JSON.parse(await readFile(join(OUT, "meta", "0000_snapshot.json"), "utf8"));
const curJson = generateDrizzleJson(schema, prevSnapshot.id);
const sqlStatements = await generateMigration(prevSnapshot, curJson);

const sql = sqlStatements.join("\n");

await mkdir(join(OUT, "meta"), { recursive: true });
await writeFile(join(OUT, `${TAG}.sql`), sql + (sql ? "\n" : ""));
await writeFile(join(OUT, "meta", "0001_snapshot.json"), JSON.stringify(curJson, null, 2));

// Append to the journal.
const journalPath = join(OUT, "meta", "_journal.json");
const journal = JSON.parse(await readFile(journalPath, "utf8"));
journal.entries.push({ idx: 1, version: "7", when: Date.now(), tag: TAG, breakpoints: true });
await writeFile(journalPath, JSON.stringify(journal, null, 2));

console.log("Generated migration:", TAG);
console.log("--- SQL ---");
console.log(sql || "(empty)");
