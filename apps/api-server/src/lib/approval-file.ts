/**
 * The APPROVAL behind a privilege — usually an exported email.
 *
 * `reason` is what the granter typed. This is the evidence behind it, which is
 * what an auditor actually asks for: "you gave this person delete rights for a
 * fortnight; show me who signed it off."
 *
 * Stored as an object KEY, never a URL. A stored URL goes stale when the bucket
 * moves, and a stored signed URL is a credential sitting in a table that many
 * people can read. The key is resolved to a short-lived link at read time, by
 * whoever is already allowed to read the privilege.
 *
 * Follows the same shape as audit evidence (see `storeEvidence`): a base64 data
 * URL over JSON rather than multipart, so there is one upload convention in the
 * codebase, and an inline dev fallback so the flow is testable without S3.
 */
import { putObject, getObjectUrl, isStorageConfigured } from "@workspace/storage";
import { httpError } from "./authz.js";
import { newId } from "./id.js";

export interface ApprovalFile {
  /** `data:<mime>;base64,<payload>` */
  dataUrl?: string;
  filename?: string;
}

export interface StoredApproval {
  key: string;
  filename: string;
  size: number;
}

/**
 * What an approval may be: an email export, a document, or a photo of a signed
 * note. Deliberately a list rather than "anything" — this is an upload reachable
 * by anyone who can administer access, and the store is served back out.
 */
const ALLOWED = new Map<string, string>([
  ["application/pdf", "pdf"],
  ["message/rfc822", "eml"],
  ["application/vnd.ms-outlook", "msg"],
  ["application/octet-stream", "bin"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["text/plain", "txt"],
]);

const MAX_BYTES = 10 * 1024 * 1024;
/** Without S3 (local dev) a small file is kept inline so the flow still works. */
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

/**
 * Store an approval, or return null when none was attached.
 *
 * Optional on purpose: most privileges are routine cover and need no paperwork.
 * Requiring a file would mean people attach a screenshot of nothing to get past
 * the form, which is worse than an empty field.
 */
export async function storeApproval(
  file: ApprovalFile | undefined,
  prefix: string,
): Promise<StoredApproval | null> {
  if (!file?.dataUrl) return null;

  const m = /^data:([^;,]+);base64,(.+)$/s.exec(file.dataUrl);
  if (!m) throw httpError(400, "The approval must be a base64 data URL", { code: "BAD_APPROVAL" });

  const contentType = m[1]!.toLowerCase();
  const ext = ALLOWED.get(contentType);
  if (!ext) {
    throw httpError(400, `Cannot accept ${contentType} as an approval — use a PDF, an email export or an image`, {
      code: "BAD_APPROVAL_TYPE",
    });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(m[2]!, "base64");
  } catch {
    throw httpError(400, "The approval file could not be read", { code: "BAD_APPROVAL" });
  }
  if (!buffer.length) throw httpError(400, "The approval file is empty", { code: "BAD_APPROVAL" });
  if (buffer.length > MAX_BYTES) {
    throw httpError(400, "The approval file is larger than 10MB", { code: "APPROVAL_TOO_LARGE" });
  }

  // The uploader's filename is shown, never used as the key: it is attacker-
  // controlled text and would otherwise decide where the object lands.
  const filename = (file.filename ?? `approval.${ext}`).slice(0, 180);
  const key = `${prefix}/${newId()}.${ext}`;

  if (isStorageConfigured()) {
    await putObject(key, buffer, contentType);
    return { key, filename, size: buffer.length };
  }
  if (buffer.length > MAX_INLINE_BYTES) {
    throw httpError(503, "File storage is not configured and the file exceeds the dev inline limit (2MB)", {
      code: "STORAGE_UNCONFIGURED",
    });
  }
  return { key: `inline:${file.dataUrl}`, filename, size: buffer.length };
}

/** A short-lived link to an approval, or null when there is none to link to. */
export async function approvalUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  if (key.startsWith("inline:")) return key.slice("inline:".length);
  if (!isStorageConfigured()) return null;
  return getObjectUrl(key, 900);
}
