import type { GradedPrices } from "@grailcard/shared";
import { similarity } from "./similarity.js";

// PokemonPriceTracker: free tier includes PSA prices (100 credits/day).
// Set PPT_API_KEY (dashboard -> API) to activate; without a key this module
// quietly returns null and the UI simply omits graded prices.
const PPT_URL = process.env.PPT_API_URL ?? "https://www.pokemonpricetracker.com/api/v2";

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["medianPrice", "averagePrice", "avg", "average", "market", "price", "value"]) {
      if (typeof o[k] === "number") return o[k] as number;
    }
  }
  return null;
}

export async function fetchGradedPrices(
  cardName: string,
  localId?: string | null,
  setName?: string | null,
): Promise<GradedPrices | null> {
  const key = process.env.PPT_API_KEY;
  if (!key) return null;

  try {
    const query = [cardName, setName].filter(Boolean).join(" ");
    const url = `${PPT_URL}/cards?search=${encodeURIComponent(query)}&limit=10&includeEbay=true`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const items = (
      Array.isArray(body) ? body : (body.data ?? body.cards ?? body.results ?? [])
    ) as Record<string, unknown>[];
    if (items.length === 0) return null;

    // the WRONG card's graded prices are worse than none: accept only a
    // result whose collector number matches, or whose set name clearly does
    const wanted = localId ? String(Number(String(localId).split("/")[0])) : null;
    const numberMatches = (it: Record<string, unknown>) => {
      const n = it.number ?? it.localId ?? it.cardNumber;
      return (
        wanted != null &&
        n != null &&
        String(Number(String(n).split("/")[0])) === wanted
      );
    };
    const setMatches = (it: Record<string, unknown>) =>
      setName != null &&
      typeof it.setName === "string" &&
      similarity(setName, it.setName) >= 0.6;

    const pick =
      items.find((it) => numberMatches(it) && setMatches(it)) ??
      items.find(numberMatches) ??
      items.find(setMatches);
    if (!pick) return null;

    const ebayRoot = (pick.ebay ?? pick.gradedPrices ?? pick.psa ?? null) as Record<
      string,
      any
    > | null;
    if (!ebayRoot) return null;
    // PPT nests per-grade sales under ebay.salesByGrade
    const ebay = (ebayRoot.salesByGrade ?? ebayRoot) as Record<string, unknown>;

    const graded: GradedPrices = {
      source: "pokemonpricetracker",
      psa8: num(ebay.psa8),
      psa9: num(ebay.psa9),
      psa10: num(ebay.psa10),
    };
    return graded.psa8 == null && graded.psa9 == null && graded.psa10 == null
      ? null
      : graded;
  } catch {
    return null;
  }
}
