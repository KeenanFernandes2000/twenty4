// M9 cleanup — idempotent S3 delete across ALL THREE buckets (raw, montages,
// thumbnails). The base worker deleteObject (../s3.ts) already targets an arbitrary
// bucket and S3/MinIO DeleteObject is idempotent (deleting a missing key returns a
// 204 success), but the deletion pipeline is the single most correctness-critical
// path: we wrap it so ANY "already gone" signal (NotFound / NoSuchKey / 404) is
// treated as success and never aborts a delete. The §10 invariant is S3-FIRST: the
// object is removed BEFORE the DB tx, so a crash never leaves a tombstoned/gone row
// with live S3 media behind it (only — harmlessly — a still-live row whose media is
// already gone, which a sweep reclaims).
import type { WorkerS3 } from "../s3.ts";
import { deleteObject } from "../s3.ts";

// Delete `key` from `bucket`, converging on "already gone" as success. Idempotent:
// safe to re-run after a crash / under the sweep re-driving the same delete.
export async function deleteObjectIdempotent(
  s3: WorkerS3,
  bucket: string,
  key: string,
): Promise<void> {
  try {
    await deleteObject(s3, bucket, key);
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    const code = (err as { Code?: string })?.Code;
    if (name === "NotFound" || name === "NoSuchKey" || code === "NoSuchKey" || status === 404) {
      return; // already gone — converge
    }
    throw err;
  }
}
