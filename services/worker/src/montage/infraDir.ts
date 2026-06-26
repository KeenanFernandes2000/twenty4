// infra/remotion directory resolver (M7 — adversarial-review L3). INFRA_REMOTION_DIR
// defaults to the repo-root-relative "infra/remotion", but the worker can run from
// differing cwds (repo root canonically via `bun services/worker/src/index.ts`, or
// services/worker under `bun test`). So for a RELATIVE dir we probe process.cwd()
// first, then walk up from THIS module until `<base>/<dir>/render.mjs` exists (the
// render driver + bundled music manifest live there). Mirrors the API's
// services/api/src/montage/manifest.ts probe.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "@twenty4/contracts";

export function resolveInfraDir(env: Env): string {
  const dir = env.INFRA_REMOTION_DIR;
  if (isAbsolute(dir)) return dir;

  const bases: string[] = [process.cwd()];
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    bases.push(cur);
    cur = dirname(cur);
  }
  for (const base of bases) {
    if (existsSync(join(base, dir, "render.mjs"))) return join(base, dir);
  }
  // Fall back to a cwd-relative path so downstream reads throw a clear ENOENT.
  return join(process.cwd(), dir);
}
