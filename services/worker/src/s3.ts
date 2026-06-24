// S3 client for the worker (M4) — server-side ops via the INTERNAL endpoint.
// The worker only ever does HeadObject + GetObject (to read bytes for EXIF/probe);
// it never signs URLs, so a single internal-endpoint client suffices.
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Env } from "@twenty4/contracts";

export interface WorkerS3 {
  client: S3Client;
  rawBucket: string;
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
  return { client, rawBucket: env.S3_BUCKET_RAW };
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
