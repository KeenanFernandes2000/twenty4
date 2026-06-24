// Aggregate re-export of the Drizzle schema set.
// IMPORTANT: every schema module (incl. enums.ts) must be re-exported here AND
// matched by the drizzle.config.ts `schema` glob, so migrations include enums.
// No domain tables yet (M2+). M0 = extensions bootstrap + enum scaffolding only.
export * from "./enums.ts";
