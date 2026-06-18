/**
 * Object storage — S3-compatible client (MinIO local / R2|S3 prod).
 *
 * Path-style addressing for MinIO; signed URLs only (no public read). This slice
 * keeps presign helpers real but simple — full TTL clamping to the content's
 * remaining lifetime (so leaked URLs 404 once deleted) lands in Slice 7.
 *
 * Bucket map: raw uploads | rendered montages | thumbnails.
 */
import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

export type BucketName = (typeof buckets)[keyof typeof buckets];

const DEFAULT_PUT_TTL = 900; // 15 min
const DEFAULT_GET_TTL = 3600; // 1 hour

/**
 * Presign a PUT for direct client upload.
 * TODO(slice 7): clamp `ttl` to the content's remaining lifetime.
 */
export function presignPut(
  bucket: BucketName,
  key: string,
  ttl: number = DEFAULT_PUT_TTL,
): Promise<string> {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: ttl,
  });
}

/**
 * Presign a GET for download/playback.
 * TODO(slice 7): clamp `ttl` to the content's remaining lifetime.
 */
export function presignGet(
  bucket: BucketName,
  key: string,
  ttl: number = DEFAULT_GET_TTL,
): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: ttl,
  });
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
