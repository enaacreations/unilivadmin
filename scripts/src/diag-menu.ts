/**
 * READ-ONLY diagnostic: replicate resolveMenu() exactly (kitchen+brand, the
 * cycled rotationWeek, dayOfWeek, effective range) for TOMORROW, per property,
 * and report which have a menu vs not. Makes ZERO writes.
 *
 *   set -a; . ./.env.api; set +a
 *   pnpm --filter @workspace/scripts exec tsx ./src/diag-menu.ts
 */
import { db, pool, propertiesTable, kitchensTable, foodMenuRotationTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/* Both helpers mirror lib/food-service.ts exactly, and both were wrong before:
 *
 *  - the day was read through the HOST getters, so this reported a different
 *    plate than the server on any machine not running in IST (H9);
 *  - the cycle phase was the ISO WEEK NUMBER, which resets to 1 every January
 *    and jumped the menu an arbitrary number of weeks on 1 Jan (L11). The phase
 *    is a continuous Monday-week counter — istWeekIndex — instead.
 *
 * A diagnostic that disagrees with the server is worse than no diagnostic. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** The instant's IST calendar day, as a UTC-midnight Date. */
const istCalendarDayUtc = (date: Date) => {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const isoDayOfWeek = (date: Date) => { const x = istCalendarDayUtc(date).getUTCDay(); return x === 0 ? 7 : x; };
/** Continuous Monday-week index from Monday 1970-01-05 (= 0). Never resets. */
function istWeekIndex(date: Date): number {
  const days = Math.floor(istCalendarDayUtc(date).getTime() / 86400000);
  return Math.floor((days - 4) / 7);
}

async function main(): Promise<void> {
  const sd = new Date(); sd.setDate(sd.getDate() + 1); sd.setHours(0, 0, 0, 0); // tomorrow
  const dow = isoDayOfWeek(sd);
  const week = istWeekIndex(sd);
  console.log(`\nService date = ${sd.toDateString()}  ·  IST dow=${dow}  weekIndex=${week}\n`);

  const props = await db.select({
    id: propertiesTable.id, name: propertiesTable.name, city: propertiesTable.city,
    brand: propertiesTable.brand, kitchenId: propertiesTable.kitchenId,
  }).from(propertiesTable).orderBy(propertiesTable.name);
  const kitchens = await db.select({ id: kitchensTable.id, name: kitchensTable.name }).from(kitchensTable);
  const kName = new Map(kitchens.map((k) => [k.id, k.name]));

  const rot = await db.select({
    kitchenId: foodMenuRotationTable.kitchenId, brand: foodMenuRotationTable.brand,
    mealType: foodMenuRotationTable.mealType, dayOfWeek: foodMenuRotationTable.dayOfWeek,
    rotationWeek: foodMenuRotationTable.rotationWeek,
    effectiveFrom: foodMenuRotationTable.effectiveFrom, effectiveTo: foodMenuRotationTable.effectiveTo,
  }).from(foodMenuRotationTable).where(eq(foodMenuRotationTable.isActive, true));

  // Index rotation rows by kitchen|brand.
  const byCombo = new Map<string, typeof rot>();
  for (const r of rot) {
    const k = `${r.kitchenId}|${r.brand}`;
    (byCombo.get(k) ?? byCombo.set(k, []).get(k)!).push(r);
  }
  const inRange = (r: typeof rot[number]) =>
    (!r.effectiveFrom || r.effectiveFrom <= sd) && (!r.effectiveTo || r.effectiveTo >= sd);

  /** The rotation week resolveMenu would pick — phase anchored on the cell's
   *  earliest effectiveFrom (epoch Monday when it has none), exactly as
   *  food-service.ts does, so a seasonal window shifts this the same way. */
  function rotationWeekFor(rows: typeof rot, weeks: number[]): number {
    if (!weeks.length) return 1;
    const anchor = rows.reduce<Date | null>(
      (min, r) => (r.effectiveFrom && (!min || r.effectiveFrom < min) ? r.effectiveFrom : min),
      null,
    );
    const phase = week - (anchor ? istWeekIndex(anchor) : 0);
    return weeks[((phase % weeks.length) + weeks.length) % weeks.length]!;
  }

  // Faithful resolveMenu "does this property have ANY meal tomorrow?" check.
  function mealsFor(kitchenId: string, brand: string): Set<string> {
    const rows = byCombo.get(`${kitchenId}|${brand}`) ?? [];
    const weeks = [...new Set(rows.map((r) => r.rotationWeek))].sort((a, b) => a - b);
    const rotationWeek = rotationWeekFor(rows, weeks);
    const meals = new Set<string>();
    for (const r of rows) {
      if (r.rotationWeek === rotationWeek && r.dayOfWeek === dow && inRange(r)) meals.add(r.mealType);
    }
    return meals;
  }

  let withMenu = 0;
  const noMenu: string[] = [];
  for (const p of props) {
    const tag = `${p.name} (${p.city ?? "—"}) [${p.brand ?? "no-brand"} / ${p.kitchenId ? (kName.get(p.kitchenId) ?? "kitchen?") : "no-kitchen"}]`;
    if (!p.brand || !p.kitchenId) { noMenu.push(`  no kitchen/brand : ${tag}`); continue; }
    const weeks = [...new Set((byCombo.get(`${p.kitchenId}|${p.brand}`) ?? []).map((r) => r.rotationWeek))].sort((a, b) => a - b);
    const meals = mealsFor(p.kitchenId, p.brand);
    if (meals.size) { withMenu++; }
    else {
      const rw = rotationWeekFor(byCombo.get(`${p.kitchenId}|${p.brand}`) ?? [], weeks);
      noMenu.push(`  no menu (weeks=[${weeks.join(",")}] → wk ${rw}, dow ${dow}) : ${tag}`);
    }
  }

  console.log(`Has menu tomorrow: ${withMenu} / ${props.length}\n`);
  if (noMenu.length) { console.log("NO menu tomorrow:"); noMenu.forEach((b) => console.log(b)); console.log(""); }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
