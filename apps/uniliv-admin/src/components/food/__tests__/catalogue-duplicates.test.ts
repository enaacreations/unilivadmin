/**
 * The client's idea of "already exists" must be the server's idea.
 *
 * This is the client half of a contract: the drawer and the ingredients grid
 * block Save on a duplicate, and POST/PUT /food/{dishes,ingredients} answers
 * 409 for one. If the two disagree the app contradicts itself in whichever
 * direction it drifted — a Save button greyed out over a dish the server would
 * have accepted, or an enabled Save whose only outcome is a red toast.
 *
 * The server-side half is pinned by
 * apps/api-server/src/lib/__tests__/food-catalogue-duplicates.test.ts. Both
 * files assert the same three rules, deliberately: name compared trimmed and
 * case-folded, course as part of a dish's identity, and a retired row still
 * counting.
 */
import { describe, expect, it } from "vitest";
import { catalogueKey, findDuplicateDish, findDuplicateIngredient } from "../menu-lib";
import type { Dish } from "@/lib/food-api";

const dish = (over: Partial<Dish> & { id: string; name: string; component: string }): Dish => ({
  unit: "SERVING", brands: ["UNILIV"], preparations: ["VEG"], photoUrl: null,
  isQtyLocked: false, lockedPersons: null, isActive: true,
  ingredients: [], sideDishIds: [],
  ...over,
} as Dish);

const CATALOGUE: Dish[] = [
  dish({ id: "d-aloo", name: "Aloo Gobi", component: "SABZI" }),
  dish({ id: "d-rice", name: "Rice", component: "RICE" }),
  dish({ id: "d-kheer", name: "Kheer", component: "DESSERT", isActive: false }),
];

const ING = [
  { id: "i-aloo", name: "Aloo" },
  { id: "i-jeera", name: "Jeera" },
];

describe("catalogueKey", () => {
  it("folds the differences a person does not see", () => {
    for (const v of ["Aloo Gobi", "aloo gobi", "  ALOO GOBI  ", "Aloo Gobi "]) {
      expect(catalogueKey(v), v).toBe("aloo gobi");
    }
  });

  it("keeps differences a person does see", () => {
    // Interior spacing is NOT collapsed — the server compares with lower(trim())
    // and would treat these as distinct too. Diverging here would grey out a
    // Save the server accepts.
    expect(catalogueKey("Aloo  Gobi")).not.toBe(catalogueKey("Aloo Gobi"));
  });

  it("treats a missing name as no key, so an empty draft matches nothing", () => {
    expect(catalogueKey("")).toBe("");
    expect(catalogueKey(null)).toBe("");
  });
});

describe("findDuplicateDish", () => {
  it("finds a case- and whitespace-variant of an existing dish", () => {
    expect(findDuplicateDish(CATALOGUE, "  aloo gobi ", "SABZI")?.id).toBe("d-aloo");
  });

  it("does NOT match the same name in another course", () => {
    // Course is half a dish's identity — Rice-the-rice and Rice-the-dessert are
    // two dishes, and blocking the second would make the catalogue unusable.
    expect(findDuplicateDish(CATALOGUE, "Rice", "DESSERT")).toBeNull();
    expect(findDuplicateDish(CATALOGUE, "Rice", "RICE")?.id).toBe("d-rice");
  });

  it("counts a RETIRED dish", () => {
    // Deleting only clears isActive, so the row is still there to collide with.
    const found = findDuplicateDish(CATALOGUE, "kheer", "DESSERT");
    expect(found?.id).toBe("d-kheer");
    expect(found?.isActive).toBe(false);
  });

  it("excludes the dish being edited, so a re-save never blocks itself", () => {
    expect(findDuplicateDish(CATALOGUE, "Aloo Gobi", "SABZI", "d-aloo")).toBeNull();
  });

  it("still catches a rename ONTO another dish", () => {
    expect(findDuplicateDish(CATALOGUE, "Aloo Gobi", "SABZI", "d-rice")?.id).toBe("d-aloo");
  });

  it("matches nothing for an empty or blank name", () => {
    // A new draft opens with an empty name; flagging it as a duplicate of every
    // other unnamed thing would block Save before a word is typed.
    expect(findDuplicateDish(CATALOGUE, "", "SABZI")).toBeNull();
    expect(findDuplicateDish(CATALOGUE, "   ", "SABZI")).toBeNull();
  });
});

describe("findDuplicateIngredient", () => {
  it("finds a case variant", () => {
    expect(findDuplicateIngredient(ING, "ALOO")?.id).toBe("i-aloo");
  });

  it("excludes the ingredient being edited", () => {
    expect(findDuplicateIngredient(ING, "Aloo", "i-aloo")).toBeNull();
  });

  it("catches a rename onto another ingredient", () => {
    expect(findDuplicateIngredient(ING, "aloo", "i-jeera")?.id).toBe("i-aloo");
  });

  it("matches nothing for an empty name", () => {
    expect(findDuplicateIngredient(ING, "  ")).toBeNull();
  });
});
