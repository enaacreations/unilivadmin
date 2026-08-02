import { describe, expect, it } from "vitest";
import {
  MEAL_LABEL,
  ORDER_STATUS_PILL,
  PREPARATION_LABEL,
  foodApi,
  fmtQty,
  groupLabel,
  isFractionalUnit,
  serviceDayKey,
  shortMeal,
} from "@/lib/food-api";

describe("fmtQty — quantity formatter", () => {
  it("renders an em-dash for empty/invalid input", () => {
    expect(fmtQty(null)).toBe("—");
    expect(fmtQty(undefined)).toBe("—");
    expect(fmtQty("")).toBe("—");
    expect(fmtQty("not-a-number")).toBe("—");
  });

  it("rounds to 3 decimals (half-up) and appends the lower-cased unit", () => {
    expect(fmtQty(1.5, "KG")).toBe("1.5 kg");
    expect(fmtQty("1.2345", "LITRE")).toBe("1.235 litre"); // 1234.5 → 1235
    expect(fmtQty(1.23449, "KG")).toBe("1.234 kg"); // 1234.49 → 1234
  });

  it("omits the unit when none is given", () => {
    expect(fmtQty(25)).toBe("25");
    expect(fmtQty("25")).toBe("25");
  });
});

describe("isFractionalUnit — 0.5-step units", () => {
  it("is true only for KG and LITRE (case/space-insensitive)", () => {
    expect(isFractionalUnit("KG")).toBe(true);
    expect(isFractionalUnit("kg")).toBe(true);
    expect(isFractionalUnit(" litre ")).toBe(true);
    expect(isFractionalUnit("LITRE")).toBe(true);
  });

  it("is false for whole-count units", () => {
    for (const u of ["G", "ML", "PCS", "PLATE", "SERVING"]) {
      expect(isFractionalUnit(u)).toBe(false);
    }
  });
});

describe("label helpers", () => {
  it("shortMeal trims the compound High Tea label, leaves simple ones", () => {
    expect(shortMeal("SNACKS")).toBe("High Tea"); // "High Tea / Evening Snacks"
    expect(shortMeal("LUNCH")).toBe("Lunch");
    expect(shortMeal("BREAKFAST")).toBe(MEAL_LABEL.BREAKFAST);
  });

  it("groupLabel rewrites the internal BATCH- token to the user-facing GROUP-", () => {
    expect(groupLabel("BATCH-2026-000123")).toBe("GROUP-2026-000123");
    expect(groupLabel("batch-2026-000001")).toBe("GROUP-2026-000001"); // case-insensitive prefix
    expect(groupLabel("ORD-2026-000123")).toBe("ORD-2026-000123"); // non-batch untouched
  });

  it("serviceDayKey normalises an ISO timestamp to its local yyyy-MM-dd", () => {
    // Local (no-Z) timestamp keeps the calendar day regardless of the runner TZ.
    expect(serviceDayKey("2026-07-18T09:30:00")).toBe("2026-07-18");
    expect(serviceDayKey("2026-01-05T23:59:00")).toBe("2026-01-05");
  });

  it("PREPARATION_LABEL / ORDER_STATUS_PILL expose the canonical display strings", () => {
    expect(PREPARATION_LABEL.NON_VEG).toBe("Non-veg");
    expect(ORDER_STATUS_PILL.PREPARING.label).toBe("In kitchen");
    expect(ORDER_STATUS_PILL.DELIVERED.label).toBe("Delivered ✓");
  });
});

describe("export-URL builders — qs() serialisation", () => {
  it("returns a bare path when no params are given", () => {
    expect(foodApi.reportsExportUrl()).toBe("/api/food/reports/export");
    expect(foodApi.reportsExportCsvUrl()).toBe("/api/food/reports/export.csv");
  });

  it("drops undefined / null / empty / ALL-sentinel filters", () => {
    const url = foodApi.reportsExportUrl({
      propertyId: "p1",
      brand: "ALL", // sentinel → dropped
      mealType: "", // empty → dropped
      status: undefined, // → dropped
      clusterId: null, // → dropped
    });
    expect(url).toBe("/api/food/reports/export?propertyId=p1");
  });

  it("keeps real filters and interpolates the format into the path", () => {
    expect(foodApi.reportsExportFmtUrl("csv", { report: "variance" })).toBe(
      "/api/food/reports/export.csv?report=variance",
    );
    expect(foodApi.guestsExportPdfUrl({ propertyId: "p9", search: "raj" })).toBe(
      "/api/food/guests/export.pdf?propertyId=p9&search=raj",
    );
  });

  it("waste-analytics builder injects the widget alongside the (filtered) params", () => {
    expect(
      foodApi.wasteAnalyticsExportUrl("xlsx", "property", { brand: "UNILIV", cityId: "ALL" }),
    ).toBe("/api/food/waste-analytics/export.xlsx?brand=UNILIV&widget=property");
  });
});
