// Root ESLint config — re-exports the shared flat config from @twenty4/config
// so every workspace lints identically. Run `bun run lint` at the root.
export { default } from "@twenty4/config/eslint";
