/**
 * Say — from the database, not from a comment — whether this environment can
 * actually serve an order yet.
 *
 * `seed:food` alone never can (see the WHY THIS IS ONE HALF OF A PAIR note at
 * the top of seed-food.ts), and for a release nothing said so: the run ended
 * "✅ Food domain seeded", the module returned empty menus, and a reviewer
 * reasonably read that as a CRITICAL bug in `resolveMenu`.
 *
 * A static "now run seed:food-extra" line would fix the wording but not the
 * class of problem: it would keep asserting the same thing whether or not it
 * was true, which is how the original claim ("seeded") came to mislead. So both
 * halves of the pair end by ASKING the question the app asks, and printing the
 * answer they get. The interesting case is the second one — `seed:food-extra`
 * reporting NOT ORDERABLE means the environment is broken for a reason nobody
 * has a comment for, e.g. no property tagged to a kitchen.
 *
 * The probe mirrors `resolveMenu`'s cell query (food-service.ts): exact
 * non-null kitchen match, brand, ISO day-of-week of the IST service date, the
 * seasonal window, `is_active` on the rotation row, and an INNER JOIN to an
 * ACTIVE dish. It deliberately stops at the cell rather than reproducing the
 * rotation-week cycle, because resolveMenu derives its week list FROM this same
 * cell — every week it can land on is one this query already proved has rows,
 * so a non-empty cell and a non-empty resolve are the same statement.
 */
import { pool } from "@workspace/db";

export interface OrderabilityOptions {
  /**
   * The command that is expected to make this environment orderable. Set by
   * `seed:food`, whose empty result is the DESIGNED half-way state; omitted by
   * `seed:food-extra`, where an empty result is a fault to investigate.
   */
  nextCommand?: string;
}

export async function reportOrderability(opts: OrderabilityOptions = {}): Promise<boolean> {
  // IST is a fixed UTC+5:30 (no DST), so the IST calendar day of "now" is the
  // UTC date of now+5:30 — the same day istCalendarDayUtc derives, and the same
  // midnight instant ymdToIstDayStart hands resolveMenu.
  const IST_MS = 5.5 * 3_600_000;
  const shifted = new Date(Date.now() + IST_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const ymd = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dow = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay(); // 1 = Mon … 7 = Sun
  const serviceDate = new Date(Date.UTC(y, m, d) - IST_MS);

  const { rows: shape } = await pool.query<{
    props: number; with_kitchen: number; with_brand: number; templates: number; per_kitchen: number;
  }>(
    `SELECT (SELECT count(*)::int FROM properties)                                      AS props,
            (SELECT count(*)::int FROM properties WHERE kitchen_id IS NOT NULL)         AS with_kitchen,
            (SELECT count(*)::int FROM properties WHERE brand IS NOT NULL)              AS with_brand,
            (SELECT count(*)::int FROM food_menu_rotation WHERE kitchen_id IS NULL)     AS templates,
            (SELECT count(*)::int FROM food_menu_rotation WHERE kitchen_id IS NOT NULL) AS per_kitchen`,
  );
  const s = shape[0]!;

  const { rows: meals } = await pool.query<{ meal: string; n: number }>(
    `SELECT r.meal_type::text AS meal, count(DISTINCT p.id)::int AS n
       FROM properties p
       JOIN food_menu_rotation r
         ON r.kitchen_id = p.kitchen_id
        AND r.brand = p.brand
        AND r.is_active
        AND r.day_of_week = $1
        AND (r.effective_from IS NULL OR r.effective_from <= $2)
        AND (r.effective_to   IS NULL OR r.effective_to   >= $2)
       JOIN dishes d ON d.id = r.dish_id AND d.is_active
      WHERE p.kitchen_id IS NOT NULL AND p.brand IS NOT NULL
      GROUP BY r.meal_type
      ORDER BY r.meal_type`,
    [dow, serviceDate],
  );
  const servable = meals.filter((mm) => mm.n > 0);
  const rule = "─".repeat(74);

  console.log(`\n${rule}`);
  if (servable.length) {
    const best = Math.max(...servable.map((mm) => mm.n));
    console.log(`✅ ORDERABLE — ${best} of ${s.props} properties resolve a menu for ${ymd} (IST):`);
    console.log(`     ${servable.map((mm) => `${mm.meal} ${mm.n}`).join(" · ")}`);
    console.log(`     ${s.templates} brand-level templates · ${s.per_kitchen} per-kitchen menu rows`);
    console.log(rule);
    return true;
  }

  console.log(`⚠  NOT ORDERABLE — no property resolves a menu for ${ymd} (IST). The module`);
  console.log(`   will return EMPTY menus and no order can be placed.`);
  console.log(`     properties: ${s.props} total · ${s.with_kitchen} tagged to a kitchen · ${s.with_brand} with a brand`);
  console.log(`     menu rows:  ${s.templates} brand-level templates (kitchen_id IS NULL, served to nobody)`);
  console.log(`                 ${s.per_kitchen} per-kitchen rows (the only kind resolveMenu matches)`);
  if (opts.nextCommand) {
    console.log(`\n   This is the EXPECTED half-way state — it is not a bug in resolveMenu.`);
    console.log(`   NEXT COMMAND — run this now, the environment is not usable until you do:`);
    console.log(`     ${opts.nextCommand}`);
  } else {
    console.log(`\n   This is NOT expected at this point. Check, in order: that properties`);
    console.log(`   carry a kitchen_id and a brand, that kitchens are active, and that the`);
    console.log(`   brand-level templates exist for seed:food-extra to copy down.`);
  }
  console.log(rule);
  return false;
}
