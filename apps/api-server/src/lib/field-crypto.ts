/**
 * field-crypto — application-layer encryption for sensitive KYC / e-sign fields.
 *
 * WS5 (security): Aadhaar/PAN numbers, ID images, selfies, signed PDFs and
 * document bodies are encrypted at rest with AES-256-GCM. Guest search by
 * Aadhaar/PAN still works via a deterministic HMAC "blind index" — an exact
 * (normalized) match column that never reveals the underlying value.
 *
 * Design goals:
 *   - SINGLE secret: only `ENCRYPTION_KEY` is required in ops. The blind-index
 *     key is derived from it via HKDF, so there is nothing else to manage.
 *   - LAZY key load: a missing key must NOT crash the process at import time
 *     (local dev boots without it); it only throws when encrypt/blindIndex is
 *     actually invoked.
 *   - BACKWARD COMPATIBILITY: `decrypt()` passes legacy plaintext through
 *     unchanged. This is mandatory so the app works before/while/after the
 *     backfill runs and on mixed plaintext+ciphertext data.
 *
 * Uses only Node's built-in `crypto` — no new dependency.
 */
import crypto from "node:crypto";

/** Self-describing envelope prefix. v1 = AES-256-GCM, 12-byte IV, 16-byte tag. */
const ENVELOPE_PREFIX = "enc:v1:";

/** HKDF info label that domain-separates the blind-index key from the cipher key. */
const BLIND_INDEX_INFO = "uniliv:kyc:blind-index:v1";

let cachedKey: Buffer | null = null;
let cachedBlindKey: Buffer | null = null;

/**
 * Resolve the 32-byte AES key from `ENCRYPTION_KEY` (hex). Throws a clear error
 * ONLY when called (lazy), so importing this module never crashes a keyless
 * local dev boot.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env["ENCRYPTION_KEY"];
  if (!hex) {
    throw new Error(
      "ENCRYPTION_KEY is not set. A 32-byte (64 hex chars) key is required to " +
        "encrypt/decrypt KYC fields or compute blind indexes.",
    );
  }
  const key = Buffer.from(hex.trim(), "hex");
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${key.length} bytes.`,
    );
  }
  cachedKey = key;
  return key;
}

/**
 * Derive the blind-index HMAC key from the master key via HKDF-SHA256 with a
 * fixed info label. Keeps ops to a single secret while keeping the index key
 * cryptographically separate from the encryption key.
 */
function getBlindIndexKey(): Buffer {
  if (cachedBlindKey) return cachedBlindKey;
  const master = getKey();
  const derived = crypto.hkdfSync("sha256", master, Buffer.alloc(0), BLIND_INDEX_INFO, 32);
  cachedBlindKey = Buffer.from(derived);
  return cachedBlindKey;
}

/** True when a stored value is a v1 ciphertext envelope (vs. legacy plaintext). */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypt plaintext with AES-256-GCM. Returns a self-describing envelope:
 *   enc:v1:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>
 * A fresh random 12-byte IV is used per call.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    ENVELOPE_PREFIX +
    iv.toString("base64") +
    ":" +
    tag.toString("base64") +
    ":" +
    ciphertext.toString("base64")
  );
}

/**
 * Decrypt a stored value.
 *   - null/empty → returned as-is.
 *   - enc:v1: envelope → decrypted to plaintext.
 *   - ANYTHING ELSE → returned UNCHANGED (LEGACY plaintext passthrough).
 *
 * The passthrough is the linchpin of backward compatibility: old rows that
 * still hold plaintext keep rendering correctly on read.
 */
export function decrypt(value: string | null): string | null {
  if (value === null || value === undefined || value === "") return value ?? null;
  if (!value.startsWith(ENVELOPE_PREFIX)) return value; // legacy plaintext
  const body = value.slice(ENVELOPE_PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encryption envelope (expected iv:tag:ciphertext).");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64!, "base64");
  const tag = Buffer.from(tagB64!, "base64");
  const ciphertext = Buffer.from(ctB64!, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Encrypt a nullable value: null/empty in → null out; otherwise encrypt. */
export function encryptNullable(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return encrypt(value);
}

/** Alias for {@link encryptNullable}. */
export const maybeEncrypt = encryptNullable;

/**
 * Normalize a government-id value for indexing: trim, strip every non-
 * alphanumeric char, uppercase. So "1234 5678 9012" and "123456789012" — and a
 * PAN in any case — collapse to the same canonical form and thus the same index.
 */
function normalizeForIndex(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/**
 * Deterministic HMAC-SHA256 blind index over the normalized value, keyed by the
 * HKDF-derived blind-index key. Returns hex. Equal normalized inputs always
 * yield the same index, enabling exact-match lookup without storing plaintext.
 */
export function blindIndex(value: string): string {
  const normalized = normalizeForIndex(value);
  return crypto.createHmac("sha256", getBlindIndexKey()).update(normalized, "utf8").digest("hex");
}
