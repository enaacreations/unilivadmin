/**
 * Audit & Inspection — deterministic scoring engine (spec §6.1, FRD-SCR-01..04).
 *
 * Pure functions, no I/O. `earnedRaw = multiplierPct/100 × weight`; section and
 * overall = Σearned / Σpossible. Stored line scores round half-up to 2dp;
 * aggregates always compute from UNROUNDED values (FRD-SCR-01 AC: Good 94% on
 * w:5 → 4.70). N/A and unanswered items are excluded from numerator AND
 * denominator by default; the org flag flips N/A to count-against (D-1).
 * There are no overrides and no recompute paths (D-3) — this runs exactly once
 * inside the atomic submit transaction (and statelessly for sandbox dry-runs).
 */

export const NON_SCORED_TYPES = new Set([
  "TEXT",
  "PHOTO",
  "SIGNATURE",
  "DATE",
  "INSTRUCTION",
]);

export interface ScoringQuestion {
  id: string;
  sectionId: string;
  type: string;
  weight: number;
  mandatory: boolean;
  optionsJson?: { id: string; label: string; multiplierPct: number }[] | null;
  numericMin?: number | null;
  numericMax?: number | null;
}

export interface ScoringAnswer {
  questionId: string;
  /** Typed by question type — see resolveMultiplier. */
  answerJson: unknown;
}

export interface ScaleSnapshotOption {
  id: string;
  label: string;
  multiplierPct: number;
  isExcludedNa: boolean;
}

export interface RatingScaleSnapshot {
  scaleId: string;
  name: string;
  options: ScaleSnapshotOption[];
}

export interface ResolvedAnswer {
  /** null = does not contribute (non-scored type or unanswerable payload). */
  multiplierPct: number | null;
  isNa: boolean;
}

/** Half-up rounding to 2 decimal places with an epsilon guard (4.705 → 4.71). */
export function roundHalfUp2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve one answer to its score multiplier per question type. Returns
 * isNa=true for N/A-style answers (excluded or counted-against per org flag).
 */
export function resolveMultiplier(
  question: ScoringQuestion,
  answerJson: unknown,
  snapshot: RatingScaleSnapshot | null,
): ResolvedAnswer {
  if (NON_SCORED_TYPES.has(question.type)) {
    return { multiplierPct: null, isNa: false };
  }
  const a = (answerJson ?? {}) as Record<string, unknown>;

  switch (question.type) {
    case "YES_NO_NA": {
      const v = String(a["value"] ?? "").toUpperCase();
      if (v === "YES") return { multiplierPct: 100, isNa: false };
      if (v === "NO") return { multiplierPct: 0, isNa: false };
      if (v === "NA") return { multiplierPct: null, isNa: true };
      return { multiplierPct: null, isNa: false };
    }
    case "PASS_FAIL": {
      const v = String(a["value"] ?? "").toUpperCase();
      if (v === "PASS") return { multiplierPct: 100, isNa: false };
      if (v === "FAIL") return { multiplierPct: 0, isNa: false };
      return { multiplierPct: null, isNa: false };
    }
    case "RATING": {
      const optionId = a["optionId"] != null ? String(a["optionId"]) : null;
      if (!optionId || !snapshot) return { multiplierPct: null, isNa: false };
      const option = snapshot.options.find((o) => o.id === optionId);
      if (!option) return { multiplierPct: null, isNa: false };
      if (option.isExcludedNa) return { multiplierPct: null, isNa: true };
      return { multiplierPct: Number(option.multiplierPct), isNa: false };
    }
    case "SINGLE_CHOICE": {
      const optionId = a["optionId"] != null ? String(a["optionId"]) : null;
      const opts = Array.isArray(question.optionsJson) ? question.optionsJson : [];
      const option = opts.find((o) => o.id === optionId);
      if (!option) return { multiplierPct: null, isNa: false };
      const pct = Number(option.multiplierPct);
      return { multiplierPct: Number.isFinite(pct) ? pct : null, isNa: false };
    }
    case "MULTI_CHOICE": {
      const ids = Array.isArray(a["optionIds"]) ? (a["optionIds"] as unknown[]).map(String) : [];
      const opts = Array.isArray(question.optionsJson) ? question.optionsJson : [];
      const nums = opts
        .filter((o) => ids.includes(o.id))
        .map((o) => Number(o.multiplierPct))
        .filter((n) => Number.isFinite(n));
      if (nums.length === 0) return { multiplierPct: null, isNa: false };
      const avg = nums.reduce((sum, n) => sum + n, 0) / nums.length;
      return { multiplierPct: avg, isNa: false };
    }
    case "NUMERIC": {
      const value = a["value"];
      if (value == null || value === "" || Number.isNaN(Number(value))) {
        return { multiplierPct: null, isNa: false };
      }
      const n = Number(value);
      const min = question.numericMin != null ? Number(question.numericMin) : null;
      const max = question.numericMax != null ? Number(question.numericMax) : null;
      const inRange = (min == null || n >= min) && (max == null || n <= max);
      // Range rule (FRD-TAU-03): in-range = full marks, out-of-range = 0.
      if (min == null && max == null) return { multiplierPct: 100, isNa: false };
      return { multiplierPct: inRange ? 100 : 0, isNa: false };
    }
    default:
      return { multiplierPct: null, isNa: false };
  }
}

export interface ScoreLine {
  questionId: string;
  sectionId: string;
  multiplierPct: number | null;
  isNa: boolean;
  /** Stored line value — rounded half-up 2dp; null = excluded from scoring. */
  earned: number | null;
  max: number | null;
  /** Unrounded, used for aggregates. */
  earnedRaw: number | null;
}

export interface SectionScore {
  sectionId: string;
  earnedRaw: number;
  maxRaw: number;
  pct: number | null;
}

export interface ScoreResult {
  lines: ScoreLine[];
  sections: SectionScore[];
  overall: { earnedRaw: number; maxRaw: number; pct: number | null };
  result: "PASS" | "FAIL" | null;
  band: string | null;
}

export interface ScoreInput {
  questions: ScoringQuestion[];
  answers: ScoringAnswer[];
  scaleSnapshot: RatingScaleSnapshot | null;
  /** D-1 org flag: N/A keeps max in the denominator with earned = 0. */
  naCountsAgainst: boolean;
  passThresholdPct: number | null;
  criticalFailGate: boolean;
  /** Any CRITICAL NC on the audit forces FAIL when the gate is on. */
  hasCriticalNc: boolean;
  bands: { label: string; minPct: number; maxPct: number }[];
}

export function scoreAudit(input: ScoreInput): ScoreResult {
  const answerByQ = new Map(input.answers.map((a) => [a.questionId, a]));
  const lines: ScoreLine[] = [];

  for (const q of input.questions) {
    if (NON_SCORED_TYPES.has(q.type) || q.weight <= 0) {
      lines.push({
        questionId: q.id,
        sectionId: q.sectionId,
        multiplierPct: null,
        isNa: false,
        earned: null,
        max: null,
        earnedRaw: null,
      });
      continue;
    }

    const answer = answerByQ.get(q.id);
    const resolved = answer
      ? resolveMultiplier(q, answer.answerJson, input.scaleSnapshot)
      : { multiplierPct: null, isNa: false };

    if (resolved.isNa) {
      if (input.naCountsAgainst) {
        lines.push({
          questionId: q.id,
          sectionId: q.sectionId,
          multiplierPct: 0,
          isNa: true,
          earned: 0,
          max: q.weight,
          earnedRaw: 0,
        });
      } else {
        // Default: excluded from numerator AND denominator (D-1).
        lines.push({
          questionId: q.id,
          sectionId: q.sectionId,
          multiplierPct: null,
          isNa: true,
          earned: null,
          max: null,
          earnedRaw: null,
        });
      }
      continue;
    }

    if (resolved.multiplierPct == null) {
      // Unanswered (or unresolvable) scorable item: excluded from both sums —
      // mandatory items can never reach here because the submit gate blocks.
      lines.push({
        questionId: q.id,
        sectionId: q.sectionId,
        multiplierPct: null,
        isNa: false,
        earned: null,
        max: null,
        earnedRaw: null,
      });
      continue;
    }

    const earnedRaw = (resolved.multiplierPct / 100) * q.weight;
    lines.push({
      questionId: q.id,
      sectionId: q.sectionId,
      multiplierPct: resolved.multiplierPct,
      isNa: false,
      earned: roundHalfUp2(earnedRaw),
      max: q.weight,
      earnedRaw,
    });
  }

  const sectionMap = new Map<string, { earnedRaw: number; maxRaw: number }>();
  let totalEarned = 0;
  let totalMax = 0;
  for (const line of lines) {
    if (line.max == null || line.earnedRaw == null) continue;
    const s = sectionMap.get(line.sectionId) ?? { earnedRaw: 0, maxRaw: 0 };
    s.earnedRaw += line.earnedRaw;
    s.maxRaw += line.max;
    sectionMap.set(line.sectionId, s);
    totalEarned += line.earnedRaw;
    totalMax += line.max;
  }

  const sections: SectionScore[] = [...sectionMap.entries()].map(([sectionId, s]) => ({
    sectionId,
    earnedRaw: s.earnedRaw,
    maxRaw: s.maxRaw,
    pct: s.maxRaw > 0 ? (s.earnedRaw / s.maxRaw) * 100 : null,
  }));

  const pct = totalMax > 0 ? (totalEarned / totalMax) * 100 : null;

  let result: "PASS" | "FAIL" | null = null;
  if (pct != null && input.passThresholdPct != null) {
    result = pct >= Number(input.passThresholdPct) ? "PASS" : "FAIL";
  }
  // Critical-fail gate overrides the numeric result (FRD-TAU-09/SCR-03).
  if (input.criticalFailGate && input.hasCriticalNc) result = "FAIL";

  let band: string | null = null;
  if (pct != null) {
    const rounded = roundHalfUp2(pct);
    band =
      input.bands.find((b) => rounded >= Number(b.minPct) && rounded <= Number(b.maxPct))
        ?.label ?? null;
  }

  return {
    lines,
    sections,
    overall: { earnedRaw: totalEarned, maxRaw: totalMax, pct },
    result,
    band,
  };
}
