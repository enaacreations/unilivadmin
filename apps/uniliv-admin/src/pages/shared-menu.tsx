import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Soup, MapPin, CalendarDays, Loader2, UtensilsCrossed } from "lucide-react";

interface SharedDish { dishName: string; unit?: string; slotLabel?: string | null; sortOrder?: number }
interface SharedMeal { mealType: string; label: string; dishes: SharedDish[] }
interface SharedMenu { brand: string; date: string; propertyName: string | null; city: string | null; meals: SharedMeal[] }

/** Public, read-only menu view opened from a Share → Link (no login, no PII). */
export default function SharedMenuPage() {
  const params = useParams();
  const token = (params as Record<string, string>).token;

  const { data, isLoading, isError, error } = useQuery<{ data: SharedMenu }>({
    queryKey: ["shared-menu", token],
    queryFn: async () => {
      const r = await fetch(`/api/food/menu/shared/${token}`);
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error || "This menu link is invalid or has expired.");
      }
      return r.json();
    },
    retry: false,
    enabled: !!token,
  });

  const menu = data?.data;
  const dateLabel = menu?.date ? format(new Date(menu.date), "EEEE, dd MMM yyyy") : "";

  return (
    <div className="min-h-screen w-full bg-background text-foreground flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-lg">
        {/* Brand header */}
        <div className="flex items-center justify-center gap-2.5 mb-6">
          <div className="w-8 h-8 rounded-lg bg-brand-gradient flex items-center justify-center text-white font-display font-bold text-lg">U</div>
          <span className="font-display font-bold text-lg tracking-tight">Uniliv</span>
        </div>

        <div className="rounded-2xl border bg-card overflow-hidden">
          {isLoading ? (
            <div className="flex flex-col items-center gap-2 py-20 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-sm">Loading menu…</span>
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center px-6">
              <UtensilsCrossed className="h-9 w-9 text-muted-foreground" />
              <p className="text-base font-medium">Menu not available</p>
              <p className="text-sm text-muted-foreground">{(error as Error)?.message || "This menu link is invalid or has expired."}</p>
            </div>
          ) : (
            <>
              {/* Title */}
              <div className="bg-brand-gradient px-6 py-5 text-white">
                <div className="text-xs font-medium uppercase tracking-widest opacity-90">{menu?.brand || "Menu"}</div>
                <h1 className="font-display text-2xl font-bold mt-0.5">Today's Menu</h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-white/90">
                  {dateLabel && <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" /> {dateLabel}</span>}
                  {menu?.propertyName && (
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="h-4 w-4" /> {menu.propertyName}{menu.city ? `, ${menu.city}` : ""}
                    </span>
                  )}
                </div>
              </div>

              {/* Meals */}
              {!menu?.meals?.length ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center px-6">
                  <Soup className="h-9 w-9 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No menu is published for this day yet.</p>
                </div>
              ) : (
                <div className="divide-y">
                  {menu.meals.map((meal) => (
                    <section key={meal.mealType} className="px-6 py-5">
                      <h2 className="font-display text-base font-semibold flex items-center gap-2 mb-3">
                        <Soup className="h-4 w-4 text-accent" /> {meal.label}
                      </h2>
                      <ul className="space-y-2">
                        {[...meal.dishes]
                          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
                          .map((d, i) => (
                            <li key={i} className="flex items-baseline justify-between gap-3">
                              <span className="text-sm">{d.dishName}</span>
                              {d.slotLabel && <span className="text-xs text-muted-foreground shrink-0">{d.slotLabel}</span>}
                            </li>
                          ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-5">Shared by your Uniliv property · Menu may change subject to availability.</p>
      </div>
    </div>
  );
}
