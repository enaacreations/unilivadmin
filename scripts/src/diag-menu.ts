/**
 * READ-ONLY diagnostic: replicate resolveMenu() exactly (kitchen+brand, the
 * cycled rotationWeek, dayOfWeek, effective range) for TOMORROW, per property,
 * and report which have a menu vs not. Makes ZERO writes.
 *
 *   set -a; . ./.env; set +a
 *   pnpm --filter @workspace/scripts exec tsx ./src/diag-menu.ts
 */
import { db, pool, propertiesTable, kitchensTable, foodMenuRotationTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const isoDayOfWeek = (d: Date) => { const x = d.getDay(); return x === 0 ? 7 : x; };
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

async function main(): Promise<void> {
  const sd = new Date(); sd.setDate(sd.getDate() + 1); sd.setHours(0, 0, 0, 0); // tomorrow
  const dow = isoDayOfWeek(sd);
  const week = isoWeekNumber(sd);
  console.log(`\nService date = ${sd.toDateString()}  ·  ISO dow=${dow}  weekNo=${week}\n`);

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

  // Faithful resolveMenu "does this property have ANY meal tomorrow?" check.
  function mealsFor(kitchenId: string, brand: string): Set<string> {
    const rows = byCombo.get(`${kitchenId}|${brand}`) ?? [];
    const weeks = [...new Set(rows.map((r) => r.rotationWeek))].sort((a, b) => a - b);
    const rotationWeek = weeks.length ? weeks[(week - 1) % weeks.length]! : 1;
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
      const rw = weeks.length ? weeks[(week - 1) % weeks.length]! : 1;
      noMenu.push(`  no menu (weeks=[${weeks.join(",")}] → wk ${rw}, dow ${dow}) : ${tag}`);
    }
  }

  console.log(`Has menu tomorrow: ${withMenu} / ${props.length}\n`);
  if (noMenu.length) { console.log("NO menu tomorrow:"); noMenu.forEach((b) => console.log(b)); console.log(""); }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
