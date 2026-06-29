import { expect, test } from "bun:test";
import {
  decodeCommentsCursor,
  decodeFeedCursor,
  encodeCommentsCursor,
  encodeFeedCursor,
} from "./feed.ts";

const publishedAt = "2026-06-26T12:00:00.000Z";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // valid RFC-4122 v4 uuid
// base64url of a JSON string with the right shape but wrong field types/values.
const b64 = (json: string) => Buffer.from(json, "utf8").toString("base64url");

test("feed cursor round-trips", () => {
  const c = { publishedAt, id };
  expect(decodeFeedCursor(encodeFeedCursor(c))).toEqual(c);
});

test("comments cursor round-trips", () => {
  const c = { createdAt: publishedAt, id };
  expect(decodeCommentsCursor(encodeCommentsCursor(c))).toEqual(c);
});

test("malformed feed cursors throw (never bubble to a 500)", () => {
  expect(() => decodeFeedCursor("")).toThrow(); // empty
  expect(() => decodeFeedCursor("!!!")).toThrow(); // non-base64 junk
  expect(() => decodeFeedCursor("eyJwdWJsaXNoZWRBdCI6")).toThrow(); // truncated base64 → bad JSON
  expect(() => decodeFeedCursor(b64('{"foo":"bar"}'))).toThrow(); // valid base64, wrong JSON
  expect(() => decodeFeedCursor(b64('{"publishedAt":"not-a-date","id":"x"}'))).toThrow(); // bad date + id
});

test("malformed comments cursors throw", () => {
  expect(() => decodeCommentsCursor("")).toThrow();
  expect(() => decodeCommentsCursor("!!!")).toThrow();
  expect(() => decodeCommentsCursor(b64('{"nope":1}'))).toThrow(); // missing fields
  expect(() => decodeCommentsCursor(b64('{"createdAt":"2026","id":"' + id + '"}'))).toThrow(); // bad date
});
