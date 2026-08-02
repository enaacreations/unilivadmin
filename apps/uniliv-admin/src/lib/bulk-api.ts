/**
 * Bulk-upload API client.
 *
 * Thin wrappers over apiFetch for the generic POST /api/bulk/:resource endpoint
 * used by the reusable <BulkUploadDialog />. The endpoint validates (dryRun) or
 * commits (all-or-nothing in one DB transaction) an array of plain row objects.
 *
 * Response envelope is always { success: true, data: {...} }. apiFetch unwraps
 * the HTTP layer; we return data.* here. Error indices in `errors` are 0-based
 * into the submitted `rows` array.
 */
import { apiFetch, getToken, refreshSession } from "@/lib/api-fetch";

export type BulkResource = "residents" | "users";

export interface BulkRowError {
  index: number;
  message: string;
}

/** Result of a dryRun=true validation pass — nothing is inserted. */
export interface BulkValidateResult {
  total: number;
  valid: number;
  invalid: number;
  errors: BulkRowError[];
}

/** Result of a commit (dryRun falsey). On 422 inserted=0 and errors is non-empty. */
export interface BulkCommitResult {
  total: number;
  inserted: number;
  errors: BulkRowError[];
}

type Envelope<T> = { success: boolean; data: T };

/**
 * Validate-only pass. POST /bulk/<resource> { rows, dryRun:true }.
 * Always 200; never inserts. Returns counts + per-row errors (0-based index).
 */
export async function bulkValidate(
  resource: BulkResource,
  rows: Array<Record<string, unknown>>,
): Promise<BulkValidateResult> {
  const res = await apiFetch<Envelope<BulkValidateResult>>(`/bulk/${resource}`, {
    method: "POST",
    body: JSON.stringify({ rows, dryRun: true }),
  });
  return res.data;
}

/**
 * Commit pass. POST /bulk/<resource> { rows, dryRun:false }.
 *
 * All-or-nothing: a fully-valid batch -> 200; any invalid row -> 422 with
 * inserted:0 and errors[]. Both responses carry the success:true envelope, but
 * 422 is a non-OK HTTP status — so we can't use apiFetch (it throws on !res.ok
 * and would drop the row-level errors[]). Instead we do a token-aware fetch,
 * retrying once through refreshSession on a 401, and treat 200 + 422 alike as
 * a valid envelope. A hard authz failure (403/middleware) surfaces success:false
 * and is thrown for the caller's catch.
 */
export async function bulkCommit(
  resource: BulkResource,
  rows: Array<Record<string, unknown>>,
): Promise<BulkCommitResult> {
  const doFetch = (token: string | null) =>
    fetch(`/api/bulk/${resource}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ rows, dryRun: false }),
    });

  let res = await doFetch(getToken());
  if (res.status === 401) {
    const token = await refreshSession();
    if (token) res = await doFetch(token);
  }

  const json = (await res.json().catch(() => null)) as Envelope<BulkCommitResult> | null;
  // A success:true envelope (200 commit or 422 all-or-nothing rejection) is a
  // valid business result. Anything else (no body, success:false) is an error.
  if (!json || json.success !== true || !json.data) {
    throw new Error((json as any)?.error || `Request failed (${res.status})`);
  }
  return json.data;
}
