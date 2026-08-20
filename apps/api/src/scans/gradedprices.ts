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

export type PptPrices = { graded: GradedPrices | null; rawUsd: number | null };

const gradedCache = new Map<string, { at: number; v: PptPrices }>();
const GRADED_CACHE_TTL = 12 * 3600 * 1000;

/** Find a market-ish USD number anywhere in PPT's prices blob (its shape
 *  varies by card era/variant). */
function findMarket(prices: unknown, depth = 0): number | null {
  if (depth > 3 || prices == null) return null;
  if (typeof prices !== "object") return null;
  const o = prices as Record<string, unknown>;
  for (const k of ["market", "marketPrice", "mid", "midPrice"]) {
    if (typeof o[k] === "number" && (o[k] as number) > 0) return o[k] as number;
  }
  for (const v of Object.values(o)) {
    const found = findMarket(v, depth + 1);
    if (found != null) return found;
  }
  return null;
}

export async function fetchGradedPrices(
  cardName: string,
  localId?: string | null,
  setName?: string | null,
): Promise<PptPrices> {
  const empty: PptPrices = { graded: null, rawUsd: null };
  const key = process.env.PPT_API_KEY;
  if (!key) return empty;

  const cacheKey = `${cardName}|${localId ?? ""}|${setName ?? ""}`;
  const hit = gradedCache.get(cacheKey);
  if (hit && Date.now() - hit.at < GRADED_CACHE_TTL) return hit.v;

  try {
    // strip symbols (star/delta glyphs) that break text search
    const clean = (s: string) => s.replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
    const query = [clean(cardName), setName ? clean(setName) : null].filter(Boolean).join(" ");
    const url = `${PPT_URL}/cards?search=${encodeURIComponent(query)}&limit=10&includeEbay=true`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return empty; // 429s NOT cached — retried next scan
    const body = (await res.json()) as Record<string, unknown>;
    const items = (
      Array.isArray(body) ? body : (body.data ?? body.cards ?? body.results ?? [])
    ) as Record<string, unknown>[];
    if (items.length === 0) {
      gradedCache.set(cacheKey, { at: Date.now(), v: empty });
      return empty;
    }

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
    if (!pick) {
      gradedCache.set(cacheKey, { at: Date.now(), v: empty });
      return empty;
    }

    const rawUsd = findMarket(pick.prices);

    const ebayRoot = (pick.ebay ?? pick.gradedPrices ?? pick.psa ?? null) as Record<
      string,
      any
    > | null;
    if (!ebayRoot) {
      const v: PptPrices = { graded: null, rawUsd };
      gradedCache.set(cacheKey, { at: Date.now(), v });
      return v;
    }
    // PPT nests per-grade sales under ebay.salesByGrade
    const ebay = (ebayRoot.salesByGrade ?? ebayRoot) as Record<string, unknown>;

    const graded: GradedPrices = {
      source: "pokemonpricetracker",
      psa8: num(ebay.psa8),
      psa9: num(ebay.psa9),
      psa10: num(ebay.psa10),
      estimated: false,
    };
    const result: PptPrices = {
      graded:
        graded.psa8 == null && graded.psa9 == null && graded.psa10 == null ? null : graded,
      rawUsd,
    };
    gradedCache.set(cacheKey, { at: Date.now(), v: result });
    return result;
  } catch {
    // do NOT cache failures like 429s — retry on the next scan
    return empty;
  }
}
