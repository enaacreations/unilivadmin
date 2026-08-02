import { describe, expect, it } from "vitest";
import {
  resolveMultiplier,
  roundHalfUp2,
  scoreAudit,
  type RatingScaleSnapshot,
  type ScoringQuestion,
} from "../audit-scoring.js";

/** Seed scale from the live reference (spec A.3 / FRD-SCR-02). */
const SCALE: RatingScaleSnapshot = {
  scaleId: "scale-1",
  name: "UNILIV Standard",
  options: [
    { id: "excellent", label: "Excellent", multiplierPct: 100, isExcludedNa: false },
    { id: "good", label: "Good", multiplierPct: 94, isExcludedNa: false },
    { id: "average", label: "Average", multiplierPct: 79, isExcludedNa: false },
    { id: "poor", label: "Poor", multiplierPct: 0, isExcludedNa: false },
    { id: "na", label: "N/A", multiplierPct: 0, isExcludedNa: true },
  ],
};

const q = (over: Partial<ScoringQuestion> & { id: string }): ScoringQuestion => ({
  sectionId: "s1",
  type: "RATING",
  weight: 5,
  mandatory: false,
  ...over,
});

describe("FRD-SCR-01 worked example", () => {
  it("Good (94%) on weight 5 earns exactly 4.70, rounded half-up at line level", () => {
    const result = scoreAudit({
      questions: [q({ id: "q1" })],
      answers: [{ questionId: "q1", answerJson: { optionId: "good" } }],
      scaleSnapshot: SCALE,
      naCountsAgainst: false,
      passThresholdPct: null,
      criticalFailGate: false,
      hasCriticalNc: false,
      bands: [],
    });
    expect(result.lines[0]!.earned).toBe(4.7);
    expect(result.overall.maxRaw).toBe(5);
    expect(result.overall.pct).toBeCloseTo(94, 10);
  });

  it("Average (79%) on weight 3 earns 2.37 (observed reference value)", () => {
    const result = scoreAudit({
      questions: [q({ id: "q1", weight: 3 })],
      answers: [{ questionId: "q1", answerJson: { optionId: "average" } }],
      scaleSnapshot: SCALE,
      naCountsAgainst: false,
      passThresholdPct: null,
      criticalFailGate: false,
      hasCriticalNc: false,
      bands: [],
    });
    expect(result.lines[0]!.earned).toBe(2.37);
  });

  it("aggregates from unrounded values, not rounded lines", () => {
    // Three w:1 items at 33.335% each: lines round to 0.33 but the overall
    // must be 3 × 0.33335 / 3 = 33.335%, not 33% from summed rounded lines.
    const custom: RatingScaleSnapshot = {
      scaleId: "s",
      name: "custom",
      options: [{ id: "x", label: "X", multiplierPct: 33.335, isExcludedNa: false }],
    };
    const result = scoreAudit({
      questions: [q({ id: "q1", weight: 1 }), q({ id: "q2", weight: 1 }), q({ id: "q3", weight: 1 })],
      answers: ["q1", "q2", "q3"].map((id) => ({ questionId: id, answerJson: { optionId: "x" } })),
      scaleSnapshot: custom,
      naCountsAgainst: false,
      passThresholdPct: null,
      criticalFailGate: false,
      hasCriticalNc: false,
      bands: [],
    });
    expect(result.lines[0]!.earned).toBe(0.33);
    expect(result.overall.pct).toBeCloseTo(33.335, 6);
  });
});

describe("N/A handling (D-1)", () => {
  const questions = [q({ id: "q1" }), q({ id: "q2" })];
  const answers = [
    { questionId: "q1", answerJson: { optionId: "excellent" } },
    { questionId: "q2", answerJson: { optionId: "na" } },
  ];

  it("excludes N/A from numerator and denominator by default", () => {
    const result = scoreAudit({
      questions, answers,
      scaleSnapshot: SCALE,
      naCountsAgainst: false,
      passThresholdPct: null, criticalFailGate: false, hasCriticalNc: false, bands: [],
    });
    expect(result.overall.maxRaw).toBe(5); // only q1 counts
    expect(result.overall.pct).toBeCloseTo(100, 10);
    expect(result.lines[1]!.isNa).toBe(true);
    expect(result.lines[1]!.earned).toBeNull();
  });

  it("counts N/A against the score when the org flag is on", () => {
    const result = scoreAudit({
      questions, answers,
      scaleSnapshot: SCALE,
      naCountsAgainst: true,
      passThresholdPct: null, criticalFailGate: false, hasCriticalNc: false, bands: [],
    });
    expect(result.overall.maxRaw).toBe(10); // q2 stays in the denominator
    expect(result.overall.pct).toBeCloseTo(50, 10);
    expect(result.lines[1]!.earned).toBe(0);
  });
});

describe("pass threshold, critical-fail gate and bands (FRD-SCR-03)", () => {
  it("passes at/above the threshold, fails below", () => {
    const base = {
      questions: [q({ id: "q1" })],
      scaleSnapshot: SCALE,
      naCountsAgainst: false,
      criticalFailGate: false,
      hasCriticalNc: false,
      bands: [],
    };
    const pass = scoreAudit({ ...base, answers: [{ questionId: "q1", answerJson: { optionId: "good" } }], passThresholdPct: 80 });
    expect(pass.result).toBe("PASS");
    const fail = scoreAudit({ ...base, answers: [{ questionId: "q1", answerJson: { optionId: "average" } }], passThresholdPct: 80 });
    expect(fail.result).toBe("FAIL");
  });

  it("critical-fail gate forces FAIL regardless of score (zero tolerance)", () => {
    const result = scoreAudit({
      questions: [q({ id: "q1" })],
      answers: [{ questionId: "q1", answerJson: { optionId: "excellent" } }],
      scaleSnapshot: SCALE,
      naCountsAgainst: false,
      passThresholdPct: 80,
      criticalFailGate: true,
      hasCriticalNc: true,
      bands: [],
    });
    expect(result.overall.pct).toBeCloseTo(100, 10);
    expect(result.result).toBe("FAIL");
  });

  it("maps % to performance bands", () => {
    const result = scoreAudit({
      questions: [q({ id: "q1" })],
      answers: [{ questionId: "q1", answerJson: { optionId: "good" } }],
      scaleSnapshot: SCALE,
      naCountsAgainst: false,
      passThresholdPct: null,
      criticalFailGate: false,
      hasCriticalNc: false,
      bands: [
        { label: "Excellent", minPct: 90, maxPct: 100 },
        { label: "Good", minPct: 75, maxPct: 89.99 },
      ],
    });
    expect(result.band).toBe("Excellent");
  });
});

describe("question-type multipliers", () => {
  it("YES_NO_NA: yes=100, no=0, NA excluded", () => {
    const question = q({ id: "q1", type: "YES_NO_NA" });
    expect(resolveMultiplier(question, { value: "YES" }, null)).toEqual({ multiplierPct: 100, isNa: false });
    expect(resolveMultiplier(question, { value: "NO" }, null)).toEqual({ multiplierPct: 0, isNa: false });
    expect(resolveMultiplier(question, { value: "NA" }, null)).toEqual({ multiplierPct: null, isNa: true });
  });

  it("NUMERIC range rule: in-range 100, out-of-range 0 (2–8°C example)", () => {
    const question = q({ id: "q1", type: "NUMERIC", numericMin: 2, numericMax: 8 });
    expect(resolveMultiplier(question, { value: 4 }, null).multiplierPct).toBe(100);
    expect(resolveMultiplier(question, { value: 12 }, null).multiplierPct).toBe(0);
  });

  it("SINGLE_CHOICE uses per-option score; MULTI_CHOICE averages", () => {
    const options = [
      { id: "a", label: "A", multiplierPct: 100 },
      { id: "b", label: "B", multiplierPct: 50 },
    ];
    const single = q({ id: "q1", type: "SINGLE_CHOICE", optionsJson: options });
    expect(resolveMultiplier(single, { optionId: "b" }, null).multiplierPct).toBe(50);
    const multi = q({ id: "q2", type: "MULTI_CHOICE", optionsJson: options });
    expect(resolveMultiplier(multi, { optionIds: ["a", "b"] }, null).multiplierPct).toBe(75);
  });

  it("non-scored types and zero-weight items never contribute", () => {
    const result = scoreAudit({
      questions: [
        q({ id: "t1", type: "TEXT" }),
        q({ id: "i1", type: "INSTRUCTION", weight: 0 }),
        q({ id: "r1", weight: 0 }),
      ],
      answers: [{ questionId: "t1", answerJson: { value: "note" } }],
      scaleSnapshot: SCALE,
      naCountsAgainst: false,
      passThresholdPct: null, criticalFailGate: false, hasCriticalNc: false, bands: [],
    });
    expect(result.overall.maxRaw).toBe(0);
    expect(result.overall.pct).toBeNull();
  });
});

describe("roundHalfUp2", () => {
  it("rounds .005 up", () => {
    expect(roundHalfUp2(4.705)).toBe(4.71);
    expect(roundHalfUp2(2.365)).toBe(2.37);
    expect(roundHalfUp2(4.7)).toBe(4.7);
  });
});
