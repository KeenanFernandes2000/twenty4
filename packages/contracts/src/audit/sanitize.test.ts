// M9 §7 — the sanitizer unit test: a content-free tombstone must drop any media
// path, comment/reaction text, raw PII (email/phone), and free text; only
// allow-listed ids / counts / action / reason codes survive.
import { expect, test } from "bun:test";
import { sanitizeAuditMetadata } from "./sanitize.ts";

test("drops media paths, urls, and free text", () => {
  const out = sanitizeAuditMetadata("expire-montage", {
    videoPath: "montages/abc/video.mp4",
    thumbnailPath: "thumbnails/abc/thumb.jpg",
    storagePath: "raw-media/xyz.jpg",
    previewUrl: "https://cdn.example.com/abc.mp4",
    commentText: "this is private user content",
    note: "free text the operator typed",
  });
  expect(out).toEqual({ action: "expire-montage" });
});

test("drops comment / reaction text", () => {
  const out = sanitizeAuditMetadata("delete-montage", {
    text: "secret comment body",
    reactionType: "fire", // not allow-listed -> dropped
    comment: "another body",
  });
  expect(out).toEqual({ action: "delete-montage" });
});

test("drops email / phone / PII", () => {
  const out = sanitizeAuditMetadata("purge-account", {
    email: "keenan@example.com",
    phone: "+15551234567",
    displayName: "Keenan",
    username: "keenan",
  });
  expect(out).toEqual({ action: "purge-account" });
});

test("keeps ids, counts, reason codes, and byte/row counts", () => {
  const out = sanitizeAuditMetadata("expire-montage", {
    montageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    reactionCount: 4,
    commentCount: 2,
    reason: "expired",
    reasonCode: "TTL_ELAPSED",
    targetType: "montage",
    bytes: 12345,
    rows: 6,
    objectsDeleted: 2,
  });
  expect(out).toEqual({
    action: "expire-montage",
    montageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    reactionCount: 4,
    commentCount: 2,
    reason: "expired",
    reasonCode: "TTL_ELAPSED",
    targetType: "montage",
    bytes: 12345,
    rows: 6,
    objectsDeleted: 2,
  });
});

test("keeps *Ids id arrays of primitives, drops object/content arrays", () => {
  const out = sanitizeAuditMetadata("replace", {
    sourceMediaIds: ["id-1", "id-2"],
    groupIds: ["g-1"],
    comments: [{ text: "leak" }], // object array -> dropped
    paths: ["montages/a.mp4"], // not an *Ids key -> dropped
  });
  expect(out).toEqual({
    action: "replace",
    sourceMediaIds: ["id-1", "id-2"],
    groupIds: ["g-1"],
  });
});

test("nested objects are dropped wholesale (no content recursion)", () => {
  const out = sanitizeAuditMetadata("delete-montage", {
    montageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    payload: { videoPath: "montages/a.mp4", text: "leak" },
  });
  expect(out).toEqual({
    action: "delete-montage",
    montageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
});

test("action argument always wins over a ctx.action", () => {
  const out = sanitizeAuditMetadata("authoritative", { action: "spoofed", id: "x" });
  expect(out.action).toBe("authoritative");
  expect(out.id).toBe("x");
});
