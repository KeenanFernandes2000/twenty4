// Fail-fast env parsing for @twenty4/api.
// Parses process.env via the shared contracts Zod schema. On any failure (missing
// var, bad type) we log a readable error and process.exit(1) — config errors die
// at boot, never mid-request. Also runs the prod-secret guard.
import { findPlaceholderSecrets, safeParseEnv, type Env } from "@twenty4/contracts";

export type { Env };

// Parse + guard. Exits the process on failure (fail fast). Returns the typed Env.
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = safeParseEnv(source);
  if (!result.success) {
    // Pretty, non-secret-leaking summary of what's wrong.
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    process.stderr.write(`[env] invalid environment — refusing to boot:\n${issues}\n`);
    process.exit(1);
  }

  const env = result.data;

  // Prod-secret guard: never boot prod with dev/placeholder secrets.
  const offenders = findPlaceholderSecrets(env);
  if (offenders.length > 0) {
    process.stderr.write(
      `[env] NODE_ENV=production but these secrets are empty/placeholder values: ${offenders.join(", ")}\n` +
        `[env] refusing to boot with insecure secrets.\n`,
    );
    process.exit(1);
  }

  return env;
}
