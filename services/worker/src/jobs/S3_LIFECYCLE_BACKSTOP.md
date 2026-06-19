# S3 lifecycle backstop (defense in depth) — §6 Enforcement

The **application jobs in this directory are the AUTHORITATIVE deletion path** (they
remove DB rows + S3 objects + write audit tombstones + emit analytics). The S3
bucket lifecycle rules below are a **backstop only** — they catch any object an app
job somehow failed to delete, so no bytes can outlive the content's promised
lifetime even under a worst-case job failure. They never run first and never carry
the audit/DB semantics; they only guarantee "bytes are gone by T+slack".

## Configured lifecycle rules (set on the bucket, R2/S3/MinIO)

| Bucket        | Object lifetime in the app | **Backstop expiry rule** | Rationale |
|---------------|----------------------------|--------------------------|-----------|
| `raw`         | published-day +60min grace; unpublished purged at day close | **expire 2 days after creation** | Raw is short-lived. App purges in ~1h–~28h (worst case: capture at 04:01, day closes ~24h later). 2d covers every window + slack. |
| `montages`    | 24h from publish            | **expire ~25h after creation** | Montage lives exactly 24h; the +1h slack covers clock skew between publish time and object creation, and the gap before the expire job fires. |
| `thumbnails`  | tracks its montage (24h)    | **expire ~25h after creation** | Same 24h clock as the montage. |

> The montage/thumbnail backstop (~25h) is intentionally just over the 24h content
> lifetime so a leaked presigned GET cannot outlive the content even if the expire
> job AND the sweep both failed: the signed-URL TTL is already clamped to the
> remaining lifetime (`clampTtl`, api/src/storage/s3.ts), so the URL dies at 24h, and
> the bytes are gone by ~25h regardless.

## Example provider config (AWS S3 / R2 PutBucketLifecycleConfiguration)

```json
{
  "Rules": [
    { "ID": "raw-backstop",       "Filter": {}, "Status": "Enabled",
      "Expiration": { "Days": 2 } },
    { "ID": "montages-backstop",  "Filter": {}, "Status": "Enabled",
      "Expiration": { "Days": 2 } },
    { "ID": "thumbnails-backstop","Filter": {}, "Status": "Enabled",
      "Expiration": { "Days": 2 } }
  ]
}
```

(S3/R2 lifecycle Expiration granularity is **days**, not hours — 2 days is the
minimum that safely covers the 24h montage + skew. The ~25h precision is delivered
by the application expire job + sweep; the day-granularity rule is purely the
last-resort byte reaper.)

## Why app-authoritative (not lifecycle-authoritative)

- Lifecycle rules cannot delete DB rows, cascade social, or write audit tombstones.
- Lifecycle granularity is days; the promise is **24h**. The app jobs deliver the
  24h precision; lifecycle only guarantees eventual byte removal.
- The signed-URL TTL clamp (≤ remaining lifetime) is what makes leaked URLs 404 on
  time; the lifecycle rule is the final guarantee the underlying bytes are gone.

This file is config documentation; the live rules are applied to the buckets at
provisioning time (infra), not by the worker at runtime.
