// Smoke test: proves the Bun test runner + TS-source resolution work, and that
// the schema module (incl. the placeholder enum) imports cleanly.
import { expect, test } from "bun:test";
import { scaffoldStatus } from "./enums.ts";
import * as schema from "./index.ts";

test("schema module imports", () => {
  expect(schema).toBeDefined();
});

test("placeholder pgEnum is wired", () => {
  expect(scaffoldStatus.enumName).toBe("scaffold_status");
  expect(scaffoldStatus.enumValues).toEqual(["ok"]);
});
