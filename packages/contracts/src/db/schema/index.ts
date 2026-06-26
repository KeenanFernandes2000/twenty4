// Aggregate re-export of the Drizzle schema set.
// IMPORTANT: every schema module (incl. enums.ts) must be re-exported here AND
// matched by the drizzle.config.ts `schema` glob, so migrations include enums.
// M2 adds the auth tables (user + BA session/account/verification + audit_log).
export * from "./enums.ts";
export * from "./auth.ts";
export * from "./groups.ts";
export * from "./media.ts";
export * from "./montage.ts";
