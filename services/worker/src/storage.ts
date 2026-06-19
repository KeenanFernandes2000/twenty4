/**
 * Worker object storage — downloads raw media from MinIO/S3 for validation +
 * rendering. Read-only side of the bucket map (the API mints keys + presigns).
 */
import {
  GetObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
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

/** Download an S3 object to a local file path. */
export async function downloadObject(
  bucket: string,
  key: string,
  destPath: string,
): Promise<void> {
  const res: GetObjectCommandOutput = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!res.Body) throw new Error(`storage: empty body for ${bucket}/${key}`);
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
