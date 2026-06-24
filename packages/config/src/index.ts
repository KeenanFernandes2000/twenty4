// @twenty4/config — shared tooling config package.
// ESLint and Prettier configs are exported via the package "exports" map
// ("@twenty4/config/eslint", "@twenty4/config/prettier"). This module exposes
// shared constants for programmatic consumers.

export const TWENTY4_CONFIG = {
  /** Internal packages are consumed as TS source — no build step. */
  tsSourcePackages: true,
} as const;
