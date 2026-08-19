import type { Grade, Recommendation, Valuation } from "@grailcard/shared";

const GRADING_COST = Number(process.env.GRADING_COST ?? 25); // PSA bulk-ish, USD

function bucketOf(v: number): string {
  if (v >= 9.5) return "PSA 10";
  if (v >= 8.5) return "PSA 9";
  return "PSA 8";
}

/** NM market price -> plausible value of THIS copy given its grade estimate. */
export function conditionMultiplier(overall: number): number {
  if (overall >= 9.5) return 1.0;
  if (overall >= 8.5) return 0.85;
  if (overall >= 7.5) return 0.7;
  if (overall >= 6.5) return 0.55;
  if (overall >= 5) return 0.4;
  return 0.25;
}

export function buildRecommendation(
  grade: Grade | null | undefined,
  valuation: Valuation | null | undefined,
): Recommendation | null {
  if (!grade) return null;

  // the grading math must use what THIS copy is worth raw, in its condition
  const raw =
    valuation?.conditionAdjusted?.value ??
    valuation?.tcgplayer?.market ??
    valuation?.cardmarket?.trend ??
    null;
  const graded = valuation?.graded ?? null;
  const likely = bucketOf(grade.overall);

  const rows = (
    [
      ["PSA 10", graded?.psa10],
      ["PSA 9", graded?.psa9],
      ["PSA 8", graded?.psa8],
    ] as const
  ).map(([label, value]) => ({
    grade: label,
    value: value ?? null,
    net: value != null && raw != null ? value - raw - GRADING_COST : null,
    inBand:
      label === bucketOf(grade.band.low) ||
      label === bucketOf(grade.band.high) ||
      label === likely,
  }));

  if (!graded || raw == null) {
    return {
      verdict: "insufficient_data",
      reasoning:
        raw == null
          ? "We're not recommending grading on this one. We couldn't find market prices for this exact card, and we won't tell you to pay for grading without real sales data to check the math against."
          : "We're not recommending grading yet. The raw price is known, but graded-sale prices aren't connected (free PSA price data activates with PPT_API_KEY) — and we won't recommend paying for grading off a guess.",
      gradingCost: GRADING_COST,
      rawValue: raw,
      likelyGrade: likely,
      rows,
    };
  }

  const likelyRow = rows.find((r) => r.grade === likely);
  const lowRow = rows.find((r) => r.grade === bucketOf(grade.band.low));
  const likelyNet = likelyRow?.net ?? null;
  const worstNet = lowRow?.net ?? null;

  // grade when the likely outcome clearly pays and even the low end of the
  // band doesn't lose money
  const verdict =
    likelyNet != null && likelyNet > Math.max(10, raw * 0.15) && (worstNet ?? 0) >= 0
      ? "grade"
      : "dont_grade";

  const fmt = (n: number | null | undefined) => (n == null ? "?" : `$${n.toFixed(2)}`);
  const reasoning =
    verdict === "grade"
      ? `Estimated grade band ${grade.band.low.toFixed(1)}–${grade.band.high.toFixed(1)} makes ${likely} the likely outcome. ` +
        `${likely} sells for ${fmt(likelyRow?.value)} vs ${fmt(raw)} raw; after ~$${GRADING_COST} grading cost that nets ${fmt(likelyNet)}, ` +
        `and even at the low end of the band the sale still covers costs.`
      : `Estimated grade band ${grade.band.low.toFixed(1)}–${grade.band.high.toFixed(1)} makes ${likely} the likely outcome, ` +
        `worth ${fmt(likelyRow?.value)} vs ${fmt(raw)} raw. After ~$${GRADING_COST} grading cost the expected net is ${fmt(likelyNet)}` +
        `${worstNet != null && worstNet < 0 ? `, and the low end of the band would lose ${fmt(Math.abs(worstNet))}` : ""}. ` +
        `The upside doesn't justify the cost and grading risk.`;

  return {
    verdict,
    reasoning,
    gradingCost: GRADING_COST,
    rawValue: raw,
    likelyGrade: likely,
    rows,
  };
}
