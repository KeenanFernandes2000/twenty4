// S3 client for the worker — server-side ops via the INTERNAL endpoint.
//
// M4: validate-media only Head/Get's raw media. M7 adds the render path: download
// raw media to a temp FILE (for Remotion), PUT the rendered mp4 to the montages
// bucket + the poster/thumbnail jpg to the thumbnails bucket, and DELETE objects on
// cleanup (no orphaned S3 objects on render failure). The worker binds all three
// buckets but still NEVER signs URLs (the API owns presigning).
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { writeFile } from "node:fs/promises";
import type { Env } from "@twenty4/contracts";

export interface WorkerS3 {
  client: S3Client;
  rawBucket: string;
  montagesBucket: string; // rendered montage mp4s (M7)
  thumbnailsBucket: string; // video poster frames + montage thumbnails (M7)
}

export interface HeadResult {
  contentLength: number;
  contentType: string | undefined;
  etag: string | undefined;
}

export function createWorkerS3(env: Env): WorkerS3 {
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    forcePathStyle: true,
  });
  return {
    client,
    rawBucket: env.S3_BUCKET_RAW,
    montagesBucket: env.S3_BUCKET_MONTAGES,
    thumbnailsBucket: env.S3_BUCKET_THUMBNAILS,
  };
}

// ── object keys (mirror the api side: media/<userId>/<itemId> family) ────────────
// NOTE: these MATCH the pre-built services/api/src/media/s3.ts helpers exactly (no
// file extension) so a presigned GET resolves whether the API reads the stored
// column or recomputes the key. The rendered objects' content-type is set on PUT.

// Rendered montage mp4: montages/<userId>/<montageId>.
export function montageKey(userId: string, montageId: string): string {
  return `montages/${userId}/${montageId}`;
}

// Per-item video poster frame (M7 §12): thumbnails/<userId>/<itemId>.
export function thumbnailKey(userId: string, itemId: string): string {
  return `thumbnails/${userId}/${itemId}`;
}

// Montage poster/thumbnail (distinct from the per-item poster): thumbnails/
// <userId>/montage-<montageId>.
export function montageThumbnailKey(userId: string, montageId: string): string {
  return `thumbnails/${userId}/montage-${montageId}`;
}

export async function headObject(s3: WorkerS3, key: string): Promise<HeadResult | null> {
  try {
    const res = await s3.client.send(new HeadObjectCommand({ Bucket: s3.rawBucket, Key: key }));
    return {
      contentLength: Number(res.ContentLength ?? 0),
      contentType: res.ContentType,
      etag: res.ETag ? res.ETag.replace(/"/g, "") : undefined,
    };
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (name === "NotFound" || status === 404) return null;
    throw err;
  }
}

// Download the full object bytes into a Buffer (small media; EXIF/probe need them).
export async function getObjectBytes(s3: WorkerS3, key: string): Promise<Buffer> {
  const res = await s3.client.send(new GetObjectCommand({ Bucket: s3.rawBucket, Key: key }));
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) throw new Error("S3 GetObject returned no readable body");
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes);
}

// Download a raw-bucket object to a local temp FILE (for Remotion's media server).
export async function getObjectToFile(s3: WorkerS3, key: string, destPath: string): Promise<void> {
  const bytes = await getObjectBytes(s3, key);
  await writeFile(destPath, bytes);
}

// PutObject into an arbitrary bucket (montages / thumbnails) with a content-type.
export async function putObject(
  s3: WorkerS3,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

// DeleteObject from an arbitrary bucket. Idempotent (deleting a missing key is a
// no-op success) — used for cleanup-on-failure (no orphaned objects).
export async function deleteObject(s3: WorkerS3, bucket: string, key: string): Promise<void> {
  await s3.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
