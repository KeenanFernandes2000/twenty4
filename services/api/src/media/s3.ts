// S3 / MinIO client wiring (M4) — the presign-host-vs-connect-host split.
//
// THE v1 lesson (PHASE1_WORK_RECAP §5): SigV4 signs the Host header. A presigned
// URL signed against `localhost:9000` is unusable from the phone. So we keep TWO
// clients:
//  - `signer`   — endpoint = S3_PUBLIC_ENDPOINT (the LAN/Tailscale host the device
//                 connects to). ONLY used to generate presigned PUT/GET URLs.
//  - `internal` — endpoint = S3_ENDPOINT (localhost:9000). Used for server-side
//                 ops the API/worker make directly: HeadObject, DeleteObject.
//
// MinIO requires forcePathStyle:true (no virtual-host bucket addressing).
//
// Bucket aliasing (M4 decision): the spec calls the raw bucket "raw-media"; we
// REUSE the existing M0 bucket named `raw` (S3_BUCKET_RAW). Treat `raw` AS the
// spec's raw-media bucket — no separate bucket is created.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "@twenty4/contracts";

export interface S3Deps {
  signer: S3Client; // signs presigned URLs (public endpoint host)
  internal: S3Client; // server-side ops (internal endpoint host)
  rawBucket: string;
  uploadTtlSec: number;
  downloadTtlSec: number;
}

export interface HeadResult {
  contentLength: number;
  contentType: string | undefined;
  etag: string | undefined;
}

// Build the two S3 clients from env. The signer uses S3_PUBLIC_ENDPOINT (falling
// back to S3_ENDPOINT when unset, for single-host dev).
export function createS3(env: Env): S3Deps {
  const common = {
    region: env.S3_REGION,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    forcePathStyle: true,
  };
  const internal = new S3Client({ ...common, endpoint: env.S3_ENDPOINT });
  const signer = new S3Client({ ...common, endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT });
  return {
    signer,
    internal,
    rawBucket: env.S3_BUCKET_RAW,
    uploadTtlSec: env.MEDIA_UPLOAD_URL_TTL_SEC,
    downloadTtlSec: env.MEDIA_DOWNLOAD_URL_TTL_SEC,
  };
}

// Object key for a media item: media/<userId>/<itemId>.
export function rawKey(userId: string, itemId: string): string {
  return `media/${userId}/${itemId}`;
}

// Presigned PUT to raw/<key> — host = public endpoint. The client uploads bytes
// directly here; we set the declared content-type so the signature can include it.
export async function presignPut(s3: S3Deps, key: string, contentType: string): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: s3.rawBucket, Key: key, ContentType: contentType });
  return getSignedUrl(s3.signer, cmd, { expiresIn: s3.uploadTtlSec });
}

// Presigned GET to raw/<key> — host = public endpoint.
export async function presignGet(s3: S3Deps, key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: s3.rawBucket, Key: key });
  return getSignedUrl(s3.signer, cmd, { expiresIn: s3.downloadTtlSec });
}

// HeadObject via the INTERNAL endpoint — actual ContentLength/ContentType/ETag.
// Returns null when the object does not exist (404/NotFound/NoSuchKey).
export async function headObject(s3: S3Deps, key: string): Promise<HeadResult | null> {
  try {
    const res = await s3.internal.send(new HeadObjectCommand({ Bucket: s3.rawBucket, Key: key }));
    return {
      contentLength: Number(res.ContentLength ?? 0),
      contentType: res.ContentType,
      // ETag comes quoted from S3; strip the quotes for stable comparison.
      etag: res.ETag ? res.ETag.replace(/"/g, "") : undefined,
    };
  } catch (err) {
    const name = (err as { name?: string; Code?: string })?.name;
    const code = (err as { Code?: string })?.Code;
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (name === "NotFound" || code === "NoSuchKey" || code === "NotFound" || status === 404) {
      return null;
    }
    throw err;
  }
}

// DeleteObject via the INTERNAL endpoint. Idempotent (S3 delete of a missing key
// is a no-op success).
export async function deleteObject(s3: S3Deps, key: string): Promise<void> {
  await s3.internal.send(new DeleteObjectCommand({ Bucket: s3.rawBucket, Key: key }));
}
