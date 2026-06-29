// M9 §7 — the BullMQ jobId guard at the CONTRACT level: every cleanup jobId must
// use '-' and never ':' (a ':' silently breaks delayed scheduling = the expiry
// mechanism). Also asserts the guard itself throws.
import { expect, test } from "bun:test";
import {
  assertNoColon,
  deleteMontageJobId,
  expireMontageJobId,
  purgeAccountJobId,
  rawPurgeJobId,
} from "./cleanup.ts";

const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dayBucket = "2026-06-29";

test("every cleanup jobId formatter produces NO ':' (uses '-')", () => {
  const ids = [
    expireMontageJobId(uuid),
    rawPurgeJobId(uuid, dayBucket),
    purgeAccountJobId(uuid),
    deleteMontageJobId(uuid),
  ];
  for (const id of ids) {
    expect(id).not.toContain(":");
    expect(id).toContain("-");
  }
});

test("formatters embed their inputs", () => {
  expect(expireMontageJobId(uuid)).toBe(`expire-montage-${uuid}`);
  expect(rawPurgeJobId(uuid, dayBucket)).toBe(`raw-purge-${uuid}-${dayBucket}`);
  expect(purgeAccountJobId(uuid)).toBe(`purge-account-${uuid}`);
  expect(deleteMontageJobId(uuid)).toBe(`delete-montage-${uuid}`);
});

test("assertNoColon throws on a ':' and is a no-op otherwise", () => {
  expect(() => assertNoColon("expire-montage:bad")).toThrow();
  expect(assertNoColon("expire-montage-ok")).toBe("expire-montage-ok");
});
