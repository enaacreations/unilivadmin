import * as React from "react";
import {
  Coffee, Milk, CupSoda, Egg, CookingPot, Wheat, Soup, Salad, Apple,
  Croissant, Dessert, Drumstick, Fish, Utensils, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MealType } from "@/lib/food-api";

/* Colourful "liquid glass" meal/dish icons — crisp SVG replacements for the
 * platform emojis (which render differently on every device). MealIcon draws a
 * bespoke food glyph per meal; DishIcon maps a dish name to a white lucide glyph
 * on a tinted glass chip. Both share the same glossy squircle so the set reads
 * as one family. These replaced the old MEAL_EMOJI/dishEmoji emoji maps. */

type Palette = { from: string; to: string };

const MEAL_PALETTE: Record<MealType, Palette> = {
  BREAKFAST: { from: "#FFD36E", to: "#FF9A2E" }, // warm amber sunrise
  LUNCH:     { from: "#FF9E5A", to: "#EF4E3C" }, // curry orange-red
  SNACKS:    { from: "#FF93BC", to: "#EC4F93" }, // high-tea rose
  DINNER:    { from: "#8E8CFF", to: "#5A46D6" }, // evening indigo
};

/** Glossy translucent chip that hosts a meal or dish glyph. */
function GlassChip({
  from, to, size, radius, className, children,
}: {
  from: string; to: string; size: number; radius: number;
  className?: string; children: React.ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-grid shrink-0 place-items-center overflow-hidden", className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(150deg, ${from} 0%, ${to} 100%)`,
        boxShadow:
          "inset 0 1px 1px rgba(255,255,255,.55), inset 0 0 0 1px rgba(255,255,255,.28), 0 3px 8px rgba(17,12,40,.16)",
      }}
    >
      {/* top sheen — the "liquid glass" highlight */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{ height: "52%", background: "linear-gradient(to bottom, rgba(255,255,255,.5), rgba(255,255,255,0))" }}
      />
      <span className="relative grid place-items-center text-white">{children}</span>
    </span>
  );
}

const MEAL_GLYPH: Record<MealType, React.ReactNode> = {
  // fried egg — white blob + orange yolk
  BREAKFAST: (
    <>
      <ellipse cx="11.5" cy="14" rx="8.5" ry="6.4" fill="#fff" />
      <ellipse cx="16" cy="10.5" rx="4.2" ry="3.6" fill="#fff" />
      <circle cx="10.5" cy="13" r="3.7" fill="#FF7A17" />
      <circle cx="9.1" cy="11.7" r="1.1" fill="#FFD98A" />
    </>
  ),
  // curry bowl with a rice mound + steam
  LUNCH: (
    <>
      <path d="M8.5 4.2c1 .9-1 2 0 3M12.5 3.4c1 .9-1 2 0 3" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" fill="none" opacity=".85" />
      <path d="M5.3 13c0-3.5 3-5.6 6.7-5.6S18.7 9.5 18.7 13Z" fill="#FFE1B0" />
      <path d="M4.3 13h15.4a7.7 7.7 0 0 1-15.4 0Z" fill="#fff" />
    </>
  ),
  // cookie with chips
  SNACKS: (
    <>
      <circle cx="12" cy="12" r="8.6" fill="#FBE6C4" />
      <circle cx="9" cy="9.4" r="1.5" fill="#8A4B26" />
      <circle cx="14.6" cy="9" r="1.3" fill="#8A4B26" />
      <circle cx="12.6" cy="13.6" r="1.5" fill="#8A4B26" />
      <circle cx="8.4" cy="14.6" r="1.2" fill="#8A4B26" />
      <circle cx="15.6" cy="14.2" r="1.3" fill="#8A4B26" />
    </>
  ),
  // noodle bowl with chopsticks
  DINNER: (
    <>
      <path d="M13.8 3.4 19 8M16.4 2.7 20.6 6.6" stroke="#FFE1B0" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5.3 12.5c0-3.5 3-5.6 6.7-5.6s6.7 2.1 6.7 5.6Z" fill="#FFF2D6" />
      <path d="M7.4 11.4c1-1.3 2-1.3 3 0s2 1.3 3 0 2-1.3 3 0" stroke="#E8B36A" strokeWidth=".9" fill="none" strokeLinecap="round" />
      <path d="M4 12.5h16a8 8 0 0 1-16 0Z" fill="#fff" />
    </>
  ),
};

/** Bespoke colourful glass icon for a meal slot. */
export function MealIcon({
  meal, size = 26, className,
}: { meal: MealType; size?: number; className?: string }) {
  const p = MEAL_PALETTE[meal];
  const g = Math.round(size * 0.66);
  return (
    <GlassChip from={p.from} to={p.to} size={size} radius={size * 0.32} className={className}>
      <svg width={g} height={g} viewBox="0 0 24 24" fill="none">
        {MEAL_GLYPH[meal]}
      </svg>
    </GlassChip>
  );
}

type DishStyle = { icon: LucideIcon; from: string; to: string };

/** Dish-name → glyph + palette. First match wins; else the meal's own palette. */
const DISH_RULES: Array<[RegExp, DishStyle]> = [
  [/\b(tea|chai|coffee)\b/, { icon: Coffee, from: "#C68A57", to: "#8A5A2E" }],
  [/\b(milk|lassi|buttermilk|curd|raita|yogurt|yoghurt|dahi)\b/, { icon: Milk, from: "#9CC0FF", to: "#5E86E6" }],
  [/\b(juice)\b/, { icon: CupSoda, from: "#FFC061", to: "#F0872E" }],
  [/\b(egg|omelette|omelet)\b/, { icon: Egg, from: "#FFD874", to: "#FF9F45" }],
  [/\b(rice|pulao|biryani|jeera|khichdi)\b/, { icon: CookingPot, from: "#FFCB82", to: "#F0913E" }],
  [/\b(roti|chapati|paratha|naan|puri|bread|toast|bakery|bun)\b/, { icon: Wheat, from: "#F0CE86", to: "#D89B3E" }],
  [/\b(dal|sambar|rajma|chole|curry|kadhi|sabzi|sabji|gravy)\b/, { icon: Soup, from: "#FFA76A", to: "#F0533B" }],
  [/\b(salad)\b/, { icon: Salad, from: "#93DD8E", to: "#4FA855" }],
  [/\b(fruits?|banana|apple)\b/, { icon: Apple, from: "#FF9385", to: "#F0483E" }],
  [/\b(samosa|pakora|vada|cutlet|snack)\b/, { icon: Croissant, from: "#E7A968", to: "#C77B3A" }],
  [/\b(sweet|halwa|kheer|gulab|dessert|laddu|ladoo|cake|muffin)\b/, { icon: Dessert, from: "#FFAECF", to: "#F06AA0" }],
  [/\b(chicken)\b/, { icon: Drumstick, from: "#E39468", to: "#C25A2E" }],
  [/\b(fish)\b/, { icon: Fish, from: "#87D6DE", to: "#3FA9B5" }],
  [/\b(paneer)\b/, { icon: Utensils, from: "#F2D9A0", to: "#D8B45E" }],
];

/** Colourful glass icon for a dish; falls back to the meal palette + a fork. */
export function DishIcon({
  name, meal, size = 40, className,
}: { name: string; meal: MealType; size?: number; className?: string }) {
  const n = name.toLowerCase();
  const match = DISH_RULES.find(([re]) => re.test(n))?.[1];
  const style: DishStyle = match ?? { icon: Utensils, ...MEAL_PALETTE[meal] };
  const Icon = style.icon;
  return (
    <GlassChip from={style.from} to={style.to} size={size} radius={size * 0.28} className={className}>
      <Icon style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }} strokeWidth={2.4} />
    </GlassChip>
  );
}
