/**
 * Worker object storage — downloads raw media from MinIO/S3 for validation +
 * rendering. Read-only side of the bucket map (the API mints keys + presigns).
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { env } from './env.js';

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
});

export const buckets = {
  raw: env.S3_BUCKET_RAW,
  montages: env.S3_BUCKET_MONTAGES,
  thumbnails: env.S3_BUCKET_THUMBNAILS,
} as const;

/** The subset of HeadObject the worker needs to verify the TOCTOU pin. */
export interface ObjectHead {
  /** S3 ETag (quotes stripped) — pins the exact object validated at /complete. */
  etag: string | null;
  sizeBytes: number | null;
}

/**
 * HeadObject → its ETag + size, or `null` if the object is missing.
 *
 * Used by the validate-media job BEFORE downloading: the worker re-Heads the
 * object and compares the current ETag against the one persisted at /complete.
 * A mismatch means the object was swapped after passing the size/type gate
 * (the presigned PUT stays reusable until its TTL) → the worker refuses to
 * process it. ETag normalization strips the surrounding quotes S3 returns.
 */
export async function headObject(
  bucket: string,
  key: string,
): Promise<ObjectHead | null> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      etag: head.ETag ? head.ETag.replace(/^"+|"+$/g, '') : null,
      sizeBytes: head.ContentLength ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Download an S3 object to a local file path, capping the number of bytes pulled
 * at `maxBytes`. The cap is a defense-in-depth guard against a swapped oversize
 * object: even if the ETag pin somehow passed, we MUST NOT fully pull an object
 * bigger than the §10 ceiling. We trust neither the Content-Length header (a
 * pre-check) NOR the stream (the authoritative check): we reject up-front if the
 * header already exceeds the cap, then count bytes as they arrive and abort the
 * pipeline the moment the running total crosses `maxBytes`.
 */
export async function downloadObject(
  bucket: string,
  key: string,
  destPath: string,
  maxBytes?: number,
): Promise<void> {
  const res: GetObjectCommandOutput = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!res.Body) throw new Error(`storage: empty body for ${bucket}/${key}`);

  if (maxBytes !== undefined) {
    // Cheap pre-check: if the server already reports an oversize body, bail
    // before streaming a single byte.
    if (res.ContentLength !== undefined && res.ContentLength > maxBytes) {
      throw new Error(
        `storage: object ${bucket}/${key} exceeds size cap (${res.ContentLength} > ${maxBytes})`,
      );
    }
    let pulled = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        pulled += chunk.length;
        if (pulled > maxBytes) {
          // Authoritative: abort once the running total crosses the cap, so a
          // lying/absent Content-Length can't let an oversize object fully land.
          cb(new Error(`storage: object ${bucket}/${key} exceeds size cap during download`));
          return;
        }
        cb(null, chunk);
      },
    });
    await pipeline(res.Body as Readable, guard, createWriteStream(destPath));
    return;
  }

  await pipeline(res.Body as Readable, createWriteStream(destPath));
}

/** Download an S3 object fully into a Buffer (small files: thumbnails, headers). */
export async function downloadObjectBuffer(
  bucket: string,
  key: string,
): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`storage: empty body for ${bucket}/${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as Readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function closeStorage(): void {
  s3.destroy();
}
