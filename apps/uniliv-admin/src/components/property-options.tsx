import * as React from "react";
import { SelectGroup, SelectLabel, SelectItem } from "@/components/ui/select";

type PropertyLike = { id: string; name: string; city?: string | null };

/** Property <SelectItem>s grouped by city, so a property picker reads
 *  "Noida → its properties, Ghaziabad → its properties" instead of one flat
 *  list. Cities are alphabetical; anything without a city falls under "Other".
 *  Render inside a <SelectContent> (after any "All …" item). */
export function PropertyOptions({ properties }: { properties: PropertyLike[] }) {
  const byCity = React.useMemo(() => {
    const map = new Map<string, PropertyLike[]>();
    for (const p of properties) {
      const city = p.city?.trim() || "Other";
      const arr = map.get(city) ?? [];
      arr.push(p);
      map.set(city, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [properties]);

  return (
    <>
      {byCity.map(([city, props]) => (
        <SelectGroup key={city}>
          <SelectLabel>{city}</SelectLabel>
          {props.map((p) => (
            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
          ))}
        </SelectGroup>
      ))}
    </>
  );
}
