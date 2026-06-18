// @twenty4/config — single source of Prettier config.
// Consumers: create `prettier.config.mjs` with
//   `export { default } from "@twenty4/config/prettier";`
/** @type {import("prettier").Config} */
export default {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
};
