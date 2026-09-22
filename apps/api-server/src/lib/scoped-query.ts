/**
 * Property-scoped query helpers.
 *
 * The recurring leak in this codebase is this shape:
 *
 *     const propertyId = req.query["propertyId"] as string | undefined;
 *     const where = propertyId ? eq(t.propertyId, propertyId) : undefined;
 *
 * which returns EVERY property's rows the moment a caller omits the filter.
 * `effectivePropertyFilter` fixes the read side; these helpers fix the rest:
 * a list that must be scoped, a row fetch that must 404 outside scope, and a
 * write whose target property the caller may not have.
 *
 * Deliberately thin. They wrap the existing `getPagination`/`buildMeta` and the
 * existing authz helpers rather than introducing a second query layer — the
 * point is to make the scoped form SHORTER than the unscoped one, so it is the
 * path of least resistance for the next handler someone writes.
 */
import type { Request } from "express";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import { getPagination, buildMeta } from "./paginate.js";
import { scopedPropertyId, forbidden, badRequest } from "./authz.js";

/**
 * A WHERE fragment restricting `column` to the caller's property, or undefined
 * when the caller is unrestricted.
 *
 * Returns `undefined` (no filter) and never `sql\`false\`` for the unrestricted
 * case, matching the null/[]/ids convention the food and audit resolvers use —
 * a helper that answered "match nothing" for an org-wide caller would silently
 * empty every admin list.
 */
export function propertyScopeCondition(req: Request, column: PgColumn): SQL | undefined {
  const scope = scopedPropertyId(req);
  return scope ? eq(column, scope) : undefined;
}

/**
 * Throw unless the caller may write to `propertyId`.
 *
 * Unlike `assertPropertyAccess`, which a caller can satisfy by passing nothing,
 * this REQUIRES a target: a create whose body omitted propertyId is the exact
 * case that used to sail through. Org-wide callers still pass anything,
 * including null, because for them a null property legitimately means "all".
 */
export function assertWritableProperty(req: Request, propertyId: string | null | undefined): void {
  const scope = scopedPropertyId(req);
  if (!scope) return;
  if (!propertyId) throw badRequest("propertyId is required", { code: "SCOPE_REQUIRED" });
  if (propertyId !== scope) throw forbidden("Outside your property scope");
}

/**
 * Force a write body's propertyId to the caller's own when they are scoped.
 * Returns the effective propertyId so the caller can 400 on a missing one.
 *
 * This is the create-path idiom already used by residents/rooms/employees,
 * extracted so it stops being re-typed (and occasionally forgotten).
 */
export function applyWriteScope(
  req: Request,
  body: Record<string, unknown>,
  key = "propertyId",
): string | null {
  const scope = scopedPropertyId(req);
  if (scope) body[key] = scope;
  const value = body[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * Scope a column where NULL means "applies to every property".
 *
 * Billing cycles, expenses, announcements and tariffs all use a nullable
 * propertyId that way: a NULL row is an org-wide rule that genuinely applies to
 * the scoped caller too. Filtering those out would hide the company-wide
 * billing cycle from the very warden it bills, so this matches
 * `propertyId IS NULL OR propertyId = <scope>` rather than a bare equality.
 *
 * Use `propertyScopeCondition` instead when NULL means "unassigned" — there,
 * excluding NULL is the fail-closed answer.
 */
export function propertyScopeOrGlobal(req: Request, column: PgColumn): SQL | undefined {
  const scope = scopedPropertyId(req);
  return scope ? or(isNull(column), eq(column, scope)) : undefined;
}

export interface ScopedListResult<T> {
  rows: T[];
  meta: ReturnType<typeof buildMeta>;
}

/**
 * Paginated list restricted to the caller's property scope.
 *
 * `nodeColumn` is the column carrying the propertyId. Extra conditions are
 * ANDed, so a handler's own filters compose rather than replace the scope —
 * the failure mode of hand-rolled scoping is a later edit dropping the scope
 * clause while keeping the filters.
 */
export async function scopedList<T extends PgTable>(
  req: Request,
  table: T,
  opts: {
    nodeColumn: PgColumn;
    where?: SQL | undefined;
    orderBy?: PgColumn | SQL;
  },
): Promise<ScopedListResult<T["$inferSelect"]>> {
  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
  const scope = propertyScopeCondition(req, opts.nodeColumn);
  const conds = [opts.where, scope].filter(Boolean) as SQL[];
  const where = conds.length ? and(...conds) : undefined;

  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table as PgTable)
    .where(where);

  let q = db.select().from(table as PgTable).where(where).limit(limit).offset(offset);
  if (opts.orderBy) q = (q as unknown as { orderBy: (c: unknown) => typeof q }).orderBy(opts.orderBy);
  const rows = (await q) as T["$inferSelect"][];

  return { rows, meta: buildMeta(count?.n ?? 0, page, limit) };
}

/**
 * Fetch one row and treat one outside the caller's scope as ABSENT.
 *
 * 404 rather than 403 on purpose: a scoped caller probing ids should not be
 * able to tell "exists elsewhere" from "does not exist". Write paths assert
 * separately, where 403 is the honest answer because the caller already knows
 * the row exists.
 */
export async function scopedFindOne<T extends PgTable>(
  req: Request,
  table: T,
  idColumn: PgColumn,
  id: string,
  nodeColumn: PgColumn,
): Promise<T["$inferSelect"] | null> {
  const scope = scopedPropertyId(req);
  const conds = [eq(idColumn, id)];
  if (scope) conds.push(eq(nodeColumn, scope));
  const [row] = await db.select().from(table as PgTable).where(and(...conds));
  return (row as T["$inferSelect"] | undefined) ?? null;
}

/** Restrict `column` to a resolved id set — `null` meaning unrestricted. */
export function idSetCondition(column: PgColumn, ids: string[] | null): SQL | undefined {
  if (ids === null) return undefined;
  if (ids.length === 0) return sql`false`;
  return inArray(column, ids);
}
