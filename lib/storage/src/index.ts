/**
 * @workspace/storage — thin, env-driven object-storage helper for the S3-compatible
 * driver (Cloudflare R2, AWS S3, MinIO, …). Used by the API (serve/upload property
 * photos & docs) and by importer scripts. Graceful: throws StorageNotConfiguredError
 * (HTTP 503) when env is absent, so callers can degrade instead of crashing.
 *
 * Env (read lazily so load-order with dotenv/`set -a` never matters):
 *   STORAGE_DRIVER=s3
 *   S3_BUCKET, S3_REGION (default "auto"), S3_ENDPOINT, S3_FORCE_PATH_STYLE
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   S3_PUBLIC_BASE_URL  (optional: a public/CDN base, e.g. an R2 custom domain or
 *                        *.r2.dev — when set, getObjectUrl returns a plain public URL;
 *                        otherwise it returns a time-limited presigned GET URL.)
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function env() {
  return {
    driver: process.env.STORAGE_DRIVER ?? "",
    bucket: process.env.S3_BUCKET ?? "",
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT ?? "",
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "false") === "true",
    publicBase: (process.env.S3_PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
  };
}

export class StorageNotConfiguredError extends Error {
  statusCode = 503;
  constructor() {
    super("Object storage is not configured (set STORAGE_DRIVER=s3 + S3_* / AWS_* env).");
    this.name = "StorageNotConfiguredError";
  }
}

export function isStorageConfigured(): boolean {
  const e = env();
  return e.driver === "s3" && !!e.bucket && !!e.endpoint && !!e.accessKeyId && !!e.secretAccessKey;
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (!isStorageConfigured()) throw new StorageNotConfiguredError();
  if (!_client) {
    const e = env();
    _client = new S3Client({
      region: e.region,
      endpoint: e.endpoint,
      forcePathStyle: e.forcePathStyle,
      credentials: { accessKeyId: e.accessKeyId, secretAccessKey: e.secretAccessKey },
    });
  }
  return _client;
}

/** Upload bytes under `key`. Returns the stored key. */
export async function putObject(key: string, body: Buffer | Uint8Array, contentType?: string): Promise<{ key: string }> {
  await client().send(new PutObjectCommand({ Bucket: env().bucket, Key: key, Body: body, ContentType: contentType }));
  return { key };
}

/** True if an object exists at `key`. */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await client().send(new HeadObjectCommand({ Bucket: env().bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: env().bucket, Key: key }));
}

/**
 * Resolve a browser-usable URL for `key`. If S3_PUBLIC_BASE_URL is set, returns a
 * stable public URL; otherwise a presigned GET URL valid for `ttlSeconds` (default 1h).
 */
export async function getObjectUrl(key: string, ttlSeconds = 3600): Promise<string> {
  const e = env();
  if (e.publicBase) return `${e.publicBase}/${key.replace(/^\/+/, "")}`;
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: e.bucket, Key: key }), { expiresIn: ttlSeconds });
}

/** Whether getObjectUrl returns stable public URLs (vs expiring presigned URLs). */
export function hasPublicBase(): boolean {
  return !!env().publicBase;
}

export function storageInfo() {
  const e = env();
  return { configured: isStorageConfigured(), driver: e.driver || null, bucket: e.bucket || null, publicBase: e.publicBase || null };
}
