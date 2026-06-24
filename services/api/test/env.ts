// Test env loader — parses via contracts schema but throws (never exits) so the
// test runner reports failures instead of killing the process.
// Bun only auto-loads .env from the *cwd*; the repo .env lives at the monorepo
// root, so when `bun test` runs inside services/api the vars are absent. We load
// the root .env explicitly (idempotent) before parsing.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, type Env } from "@twenty4/contracts";

let loaded = false;

// Minimal .env loader: walk up from this file to the repo root and merge the
// first .env found into process.env (without clobbering already-set vars).
function loadRootDotenv(): void {
  if (loaded) return;
  loaded = true;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      const text = readFileSync(candidate, "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        const key = m[1]!;
        let val = m[2]!;
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
      return;
    }
    dir = dirname(dir);
  }
}

export function loadEnvForTest(): Env {
  loadRootDotenv();
  return parseEnv(process.env);
}
