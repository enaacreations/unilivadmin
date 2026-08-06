/**
 * Move legacy Razorpay wallet credits into the namespaces the new webhook
 * handler dedupes on.
 *
 *   pnpm --filter @workspace/scripts run migrate:wallet-namespace            # dry-run
 *   pnpm --filter @workspace/scripts run migrate:wallet-namespace -- --apply # write
 *
 * DEPLOY ORDER — run this BEFORE the new API image serves traffic. It is the
 * one step here that is not merely defensive: skipping it double-credits real
 * money.
 *
 * The pre-fix handler stamped every Razorpay credit `reference_type = 'RAZORPAY'`
 * (git show dev:apps/api-server/src/routes/webhooks.ts:231). The new handler
 * splits that single namespace in two — `RAZORPAY_PAYMENT` for a payment id and
 * `RAZORPAY_LINK` for a link reconciliation (webhooks.ts:192-193) — and its
 * idempotency check, plus `uq_wallet_transactions_reference`, both match on
 * (reference_type, reference_id). A legacy row therefore does not match, so a
 * Razorpay REDELIVERY of any pre-deploy event walks straight past the guard and
 * credits the wallet a second time.
 *
 * The mapping is the provider's own id prefix: `pay_…` is a payment,
 * `plink_…` is a payment link.
 *
 * Idempotent: it only touches rows still in the old namespace, so a second run
 * reports nothing. Collisions are reported, never overwritten — a legacy row
 * whose target key is already taken means the double credit has ALREADY
 * happened, and that is a reversal through the wallet API, not a data fix.
 */
import { pool } from "@workspace/db";

const APPLY = process.argv.includes("--apply");

const LEGACY = "RAZORPAY";

/** Provider id prefix → the namespace the new handler dedupes that event in. */
const MAPPINGS = [
  { prefix: "pay_", target: "RAZORPAY_PAYMENT", what: "payment.captured credits" },
  { prefix: "plink_", target: "RAZORPAY_LINK", what: "payment_link.paid reconciliations" },
] as const;

async function main(): Promise<void> {
  const before = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM wallet_transactions WHERE reference_type = $1`,
    [LEGACY],
  );
  const legacy = Number(before.rows[0]?.n ?? 0);
  console.log(`\nwallet_transactions in the '${LEGACY}' namespace: ${legacy} · mode ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}\n`);

  if (legacy === 0) {
    console.log(`✅ nothing to migrate — no credit is left in the '${LEGACY}' namespace`);
    await pool.end();
    return;
  }

  let moved = 0;
  let blocked = 0;

  for (const m of MAPPINGS) {
    // A legacy row whose (target, reference_id) already exists is a duplicate
    // credit that has already been written. Moving it would violate
    // uq_wallet_transactions_reference and abort the whole migration, so it is
    // separated out and reported instead.
    const collisions = await pool.query<{ id: string; reference_id: string; amount: string }>(
      `SELECT w.id, w.reference_id, w.amount
         FROM wallet_transactions w
        WHERE w.reference_type = $1 AND w.reference_id LIKE $2
          AND EXISTS (
            SELECT 1 FROM wallet_transactions d
             WHERE d.reference_type = $3 AND d.reference_id = w.reference_id
          )
        ORDER BY w.reference_id`,
      [LEGACY, `${m.prefix}%`, m.target],
    );

    const movable = await pool.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM wallet_transactions w
        WHERE w.reference_type = $1 AND w.reference_id LIKE $2
          AND NOT EXISTS (
            SELECT 1 FROM wallet_transactions d
             WHERE d.reference_type = $3 AND d.reference_id = w.reference_id
          )`,
      [LEGACY, `${m.prefix}%`, m.target],
    );
    const n = Number(movable.rows[0]?.n ?? 0);
    console.log(`  ${m.prefix.padEnd(7)} → ${m.target.padEnd(17)} ${n} row(s) (${m.what})`);

    if (collisions.rowCount) {
      blocked += collisions.rowCount;
      console.log(`      ⚠ ${collisions.rowCount} row(s) already have a ${m.target} twin — money credited twice:`);
      for (const r of collisions.rows) console.log(`          ${r.reference_id} · ₹${r.amount} · txn ${r.id}`);
    }

    if (APPLY && n > 0) {
      const res = await pool.query(
        `UPDATE wallet_transactions w
            SET reference_type = $3
          WHERE w.reference_type = $1 AND w.reference_id LIKE $2
            AND NOT EXISTS (
              SELECT 1 FROM wallet_transactions d
               WHERE d.reference_type = $3 AND d.reference_id = w.reference_id
            )`,
        [LEGACY, `${m.prefix}%`, m.target],
      );
      moved += res.rowCount ?? 0;
      console.log(`      ✓ moved ${res.rowCount} row(s)`);
    }
  }

  // Anything left carries an id the provider never minted (or a null id), so no
  // prefix rule can classify it. Report rather than guess: a wrong namespace is
  // a dedupe key that never matches.
  const leftover = await pool.query<{ id: string; reference_id: string | null; amount: string }>(
    `SELECT id, reference_id, amount
       FROM wallet_transactions
      WHERE reference_type = $1
        AND (reference_id IS NULL OR (reference_id NOT LIKE 'pay_%' AND reference_id NOT LIKE 'plink_%'))
      ORDER BY created_at`,
    [LEGACY],
  );
  if (leftover.rowCount) {
    console.log(`\n⚠ ${leftover.rowCount} '${LEGACY}' row(s) carry no recognisable Razorpay id and were left alone:`);
    for (const r of leftover.rows) console.log(`     ${r.id} · ref ${r.reference_id ?? "NULL"} · ₹${r.amount}`);
    console.log("  Classify them by hand — until they move, a redelivery of that event re-credits.");
  }

  if (APPLY) console.log(`\nMoved ${moved} row(s) out of the '${LEGACY}' namespace.`);
  else console.log(`\nRe-run with -- --apply to write.`);

  if (blocked > 0 || leftover.rowCount) {
    console.log("\n⚠ Not every legacy credit is namespaced. Resolve the rows above before the new handler goes live.");
    await pool.end();
    process.exit(1);
  }

  console.log(APPLY ? "\n✅ every Razorpay credit is namespaced — redeliveries now dedupe" : "");
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ Failed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
