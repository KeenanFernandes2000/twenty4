/**
 * Object storage — S3-compatible client (MinIO local / R2|S3 prod).
 *
 * Path-style addressing for MinIO; signed URLs only (no public read). This module
 * is the ONLY place that presigns; it enforces three security invariants so a
 * client can never presign arbitrary objects (§11 "no public URLs", Q7):
 *
 *   1. BUCKET ALLOW-LIST — every presign goes through `assertBucket`, which only
 *      accepts the three known buckets (raw | montages | thumbnails). A caller
 *      cannot target an unknown bucket.
 *   2. KEY NAMESPACING — raw keys are minted server-side as
 *      `<userId>/<dayBucket>/<uuid>.<ext>` via `rawObjectKey`; the userId segment
 *      is derived from the authenticated session, never from client input, so one
 *      user can't presign into another user's namespace.
 *   3. TTL CLAMP — `presignPut`/`presignGet` clamp the requested TTL to the
 *      content's REMAINING LIFETIME (`clampTtl`), so a leaked signed URL dies with
 *      the content (§6/§11: expired/deleted → 404). Never exceeds the default cap.
 *
 * Bucket map: raw uploads | rendered montages | thumbnails.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { env } from '../env.js';

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
});

/** Named bucket map, resolved from env. */
export const buckets = {
  raw: env.S3_BUCKET_RAW,
  montages: env.S3_BUCKET_MONTAGES,
  thumbnails: env.S3_BUCKET_THUMBNAILS,
} as const;

export type BucketKind = keyof typeof buckets;
export type BucketName = (typeof buckets)[BucketKind];

/** The allow-list: only these resolved bucket names may ever be presigned. */
const ALLOWED_BUCKETS: ReadonlySet<string> = new Set(Object.values(buckets));

const DEFAULT_PUT_TTL = 900; // 15 min — cap for upload PUTs.
const DEFAULT_GET_TTL = 3600; // 1 hour — cap for download/playback GETs.

/* --------------------------- security invariants --------------------------- */

/**
 * Assert `bucket` is one of the three known buckets and return it typed. Throws
 * (not a client-facing ApiError — this is an internal guard; callers only ever
 * pass `buckets.raw` etc.) if an unknown bucket somehow reaches here.
 */
export function assertBucket(bucket: string): BucketName {
  if (!ALLOWED_BUCKETS.has(bucket)) {
    throw new Error(`storage: bucket not in allow-list: ${bucket}`);
  }
  return bucket as BucketName;
}

/** Map an upload MIME to a safe file extension for the object key. */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

/** Resolve a safe extension from a MIME type (defaults to `bin`). */
export function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? 'bin';
}

/**
 * Mint a server-namespaced raw object key: `<userId>/<dayBucket>/<uuid>.<ext>`.
 *
 * The `userId` and `dayBucket` segments come from the authenticated session and
 * the server-resolved day window — NEVER from client input — so a client can't
 * presign into another user's (or another day's) namespace. The random uuid makes
 * keys unguessable and collision-free.
 */
export function rawObjectKey(args: {
  userId: string;
  dayBucket: string; // YYYY-MM-DD
  contentType: string;
}): string {
  // Defensive: the segments are server-derived, but strip anything that could
  // escape the namespace (path traversal / separators) belt-and-suspenders.
  const safeUser = sanitizeSegment(args.userId);
  const safeDay = sanitizeSegment(args.dayBucket);
  const ext = extForMime(args.contentType);
  return `${safeUser}/${safeDay}/${randomUUID()}.${ext}`;
}

/**
 * Strip path separators / traversal from a key segment: drop anything outside the
 * safe charset, then collapse any remaining dot-runs so a `..` traversal can never
 * survive (e.g. `../../etc` → `etc`). Leading/trailing dots are trimmed too.
 */
function sanitizeSegment(seg: string): string {
  return seg
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '') // collapse `..`, `...` → '' (no traversal)
    .replace(/^[.]+|[.]+$/g, ''); // trim leading/trailing dots
}

/**
 * Clamp a requested TTL (seconds) to BOTH a default cap AND the content's
 * remaining lifetime. Returns at least 1s (S3 rejects 0). When `expiryAt` is in
 * the past, the content is already gone → 0 → callers should 404 instead of
 * presigning, but we still return a clamped >=1 so a presign never outlives it.
 *
 * @param requested  Desired TTL in seconds.
 * @param cap        Hard upper bound (default PUT/GET caps).
 * @param expiryAt   When the underlying content expires (null = no known expiry,
 *                   so only the cap applies).
 */
export function clampTtl(
  requested: number,
  cap: number,
  expiryAt?: Date | null,
): number {
  let ttl = Math.min(requested, cap);
  if (expiryAt) {
    const remainingSec = Math.floor((expiryAt.getTime() - Date.now()) / 1000);
    ttl = Math.min(ttl, remainingSec);
  }
  // S3 presign requires expiresIn >= 1.
  return Math.max(1, ttl);
}

/* -------------------------------- presign ---------------------------------- */

export interface PresignOptions {
  /** Desired TTL (seconds). Clamped to the cap and to `expiryAt`. */
  ttl?: number;
  /** Content expiry — clamps TTL so a leaked URL 404s with the content. */
  expiryAt?: Date | null;
}

/**
 * Presign a PUT for direct client upload. Enforces the bucket allow-list and the
 * TTL clamp (default cap 15 min, further clamped to `expiryAt`).
 */
export async function presignPut(
  bucket: BucketName,
  key: string,
  opts: PresignOptions = {},
): Promise<{ url: string; expiresIn: number }> {
  const b = assertBucket(bucket);
  const expiresIn = clampTtl(opts.ttl ?? DEFAULT_PUT_TTL, DEFAULT_PUT_TTL, opts.expiryAt);
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: b, Key: key }), {
    expiresIn,
  });
  return { url, expiresIn };
}

/**
 * Presign a GET for download/playback. Enforces the bucket allow-list and the TTL
 * clamp (default cap 1 hour, further clamped to `expiryAt` so the URL can't
 * outlive the content).
 */
export async function presignGet(
  bucket: BucketName,
  key: string,
  opts: PresignOptions = {},
): Promise<{ url: string; expiresIn: number }> {
  const b = assertBucket(bucket);
  const expiresIn = clampTtl(opts.ttl ?? DEFAULT_GET_TTL, DEFAULT_GET_TTL, opts.expiryAt);
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: b, Key: key }), {
    expiresIn,
  });
  return { url, expiresIn };
}

/** True if an object exists in `bucket` at `key` (used to verify upload completed). */
export async function objectExists(bucket: BucketName, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: assertBucket(bucket), Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Head an object → its size in bytes (or null if missing). */
export async function objectSize(
  bucket: BucketName,
  key: string,
): Promise<number | null> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: assertBucket(bucket), Key: key }),
    );
    return head.ContentLength ?? null;
  } catch {
    return null;
  }
}

/** The subset of HeadObject we use to post-validate a completed upload. */
export interface ObjectHead {
  sizeBytes: number | null;
  contentType: string | null;
  /**
   * S3 ETag (surrounding quotes stripped) of the EXACT object that landed. Pinned
   * on the row at /complete so the worker can re-Head before downloading and refuse
   * to process a swapped object (the presigned PUT stays reusable until its TTL).
   */
  etag: string | null;
}

/**
 * Head an object → its size + content-type, or `null` if it doesn't exist.
 *
 * Used on POST /media/:id/complete to enforce the §10 size cap and the declared
 * content-type AFTER the presigned PUT has landed: a presigned PUT can't cap size
 * up-front, so this is the pragmatic post-upload gate (the caller rejects + deletes
 * the object on a mismatch).
 */
export async function objectHead(
  bucket: BucketName,
  key: string,
): Promise<ObjectHead | null> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: assertBucket(bucket), Key: key }),
    );
    return {
      sizeBytes: head.ContentLength ?? null,
      contentType: head.ContentType ?? null,
      etag: head.ETag ? head.ETag.replace(/^"+|"+$/g, '') : null,
    };
  } catch {
    return null;
  }
}

/**
 * Delete an object (best-effort). Used so a media removal also drops the bytes —
 * a previously-issued presigned GET then 404s with the content (§6/§11: deleted
 * content is gone, not merely hidden). Returns true on a successful delete.
 *
 * S3/MinIO DELETE is idempotent (deleting a missing key succeeds), so this is safe
 * to call even if the upload never landed.
 */
export async function deleteObject(
  bucket: BucketName,
  key: string,
): Promise<boolean> {
  try {
    await s3.send(
      new DeleteObjectCommand({ Bucket: assertBucket(bucket), Key: key }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Object count + total bytes for a bucket (Slice 8 admin ops storage usage). */
export interface BucketUsageStats {
  bucket: BucketName;
  objectCount: number;
  bytes: number;
}

/**
 * Sum object count + bytes across a bucket via paginated ListObjectsV2. Used by
 * `GET /admin/ops` to surface per-bucket storage usage. Bounded by `maxPages` so a
 * pathological bucket can't make the ops call run unbounded; best-effort (a list
 * error yields zeros). Fine for the Phase-1 admin shell scale; a metrics export is
 * the production path. The bucket name is allow-list-checked.
 */
export async function bucketUsage(
  bucket: BucketName,
  maxPages = 50,
): Promise<BucketUsageStats> {
  assertBucket(bucket);
  let objectCount = 0;
  let bytes = 0;
  let token: string | undefined;
  try {
    for (let page = 0; page < maxPages; page++) {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
      for (const obj of res.Contents ?? []) {
        objectCount++;
        bytes += obj.Size ?? 0;
      }
      if (!res.IsTruncated) break;
      token = res.NextContinuationToken;
      if (!token) break;
    }
  } catch {
    // best-effort — return whatever was counted so far.
  }
  return { bucket, objectCount, bytes };
}

/** Liveness probe for storage — HeadBucket on the raw bucket. */
export async function pingStorage(): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: buckets.raw }));
    return true;
  } catch {
    return false;
  }
}

/** Close the S3 client (graceful shutdown). */
export function closeStorage(): void {
  s3.destroy();
}
