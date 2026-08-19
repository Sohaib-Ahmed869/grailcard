import type { Identification, OcrReading, Valuation } from "@grailcard/shared";

const TCGDEX = process.env.TCGDEX_URL ?? "https://api.tcgdex.net/v2/en";
const MIN_MATCH_SCORE = 0.45;

type TcgdexBrief = { id: string; localId: string; name: string; image?: string };

/** Dice coefficient on character bigrams — tolerant of OCR mangling. */
function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const norm = s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const set = new Map<string, number>();
    for (let i = 0; i < norm.length - 1; i++) {
      const bg = norm.slice(i, i + 2);
      set.set(bg, (set.get(bg) ?? 0) + 1);
    }
    return set;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [bg, n] of A) {
    overlap += Math.min(n, B.get(bg) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function querySeeds(ocr: OcrReading): string[] {
  const seeds = new Set<string>();
  for (const name of ocr.nameCandidates.slice(0, 2)) {
    seeds.add(name);
    for (const token of name.split(/\s+/)) {
      if (token.length >= 4) seeds.add(token);
    }
  }
  return [...seeds].slice(0, 5);
}

const VISION_URL = process.env.VISION_URL ?? "http://localhost:8100";

/** dHash the scanned card against candidate catalog images (vision service). */
async function visualScores(
  warpedImageB64: string,
  urls: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const form = new FormData();
    form.append("imageB64", warpedImageB64);
    form.append("urls", JSON.stringify(urls));
    const res = await fetch(`${VISION_URL}/similarity`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      scores: { url: string; similarity: number | null }[];
    };
    for (const s of data.scores) {
      if (s.similarity != null) out.set(s.url, s.similarity);
    }
  } catch {
    /* visual verification is best-effort */
  }
  return out;
}

export async function identifyCard(
  ocr: OcrReading,
  warpedImageB64?: string | null,
): Promise<{ identification: Identification; valuation: Valuation | null } | null> {
  if (ocr.nameCandidates.length === 0) return null;
  const names = ocr.nameCandidates.slice(0, 3);
  const collectorLocalId = ocr.collectorNumber
    ? String(Number(ocr.collectorNumber.split("/")[0]))
    : null;

  const candidates = new Map<string, { card: TcgdexBrief; score: number; ocrName: string }>();
  for (const seed of querySeeds(ocr)) {
    const list = (await fetchJson(
      `${TCGDEX}/cards?name=${encodeURIComponent(seed)}`,
    )) as TcgdexBrief[] | null;
    if (!list) continue;
    for (const card of list) {
      // OCR ordering is unreliable — score against every candidate name
      let score = -1;
      let matchedName = names[0];
      for (const n of names) {
        const s = similarity(n, card.name);
        if (s > score) {
          score = s;
          matchedName = n;
        }
      }
      if (collectorLocalId && String(Number(card.localId)) === collectorLocalId) {
        score += 0.2;
      }
      const prev = candidates.get(card.id);
      if (!prev || score > prev.score) {
        candidates.set(card.id, { card, score, ocrName: matchedName });
      }
    }
  }

  let ranked = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 5);

  // visual cross-check: dHash the scan against the top candidates' images.
  // Confirms the name match and separates same-name cards from different sets.
  if (warpedImageB64 && ranked.length > 0) {
    const urlOf = (c: TcgdexBrief) => (c.image ? `${c.image}/low.png` : null);
    const urls = ranked.map((r) => urlOf(r.card)).filter((u): u is string => !!u);
    const visual = await visualScores(warpedImageB64, urls);
    if (visual.size > 0) {
      ranked = ranked
        .map((r) => {
          const url = urlOf(r.card);
          const sim = url ? visual.get(url) : undefined;
          return sim == null ? r : { ...r, score: 0.7 * r.score + 0.3 * sim };
        })
        .sort((a, b) => b.score - a.score);
    }
  }

  const best = ranked[0] ?? null;
  if (!best || best.score < MIN_MATCH_SCORE) return null;

  const detail = (await fetchJson(`${TCGDEX}/cards/${best.card.id}`)) as {
    set?: { id: string; name: string };
    rarity?: string;
    localId?: string | number;
    image?: string;
    pricing?: {
      cardmarket?: {
        updated?: string;
        unit?: string;
        low?: number;
        trend?: number;
        avg30?: number;
      };
      tcgplayer?: { unit?: string; updated?: string } & Record<string, unknown>;
    };
  } | null;

  const identification: Identification = {
    cardId: best.card.id,
    name: best.card.name,
    setId: detail?.set?.id ?? best.card.id.split("-")[0],
    setName: detail?.set?.name ?? "",
    localId: String(detail?.localId ?? best.card.localId),
    rarity: detail?.rarity ?? null,
    imageUrl: (detail?.image ?? best.card.image)
      ? `${detail?.image ?? best.card.image}/high.png`
      : null,
    matchScore: Math.min(best.score, 1),
    ocrName: best.ocrName,
    game: "pokemon",
  };

  let valuation: Valuation | null = null;
  const pricing = detail?.pricing;
  if (pricing) {
    // tcgplayer nests prices per print variant; take the first present
    let tcgplayer: Valuation["tcgplayer"] = null;
    const tp = pricing.tcgplayer;
    if (tp) {
      for (const variant of ["holofoil", "normal", "reverseHolofoil", "1stEditionHolofoil"]) {
        const v = tp[variant] as
          | { lowPrice?: number; midPrice?: number; highPrice?: number; marketPrice?: number }
          | undefined;
        if (v) {
          tcgplayer = {
            unit: tp.unit ?? "USD",
            variant,
            low: v.lowPrice ?? null,
            mid: v.midPrice ?? null,
            high: v.highPrice ?? null,
            market: v.marketPrice ?? null,
          };
          break;
        }
      }
    }
    const cm = pricing.cardmarket;
    valuation = {
      source: "tcgdex",
      updatedAt: pricing.cardmarket?.updated ?? pricing.tcgplayer?.updated ?? null,
      tcgplayer,
      cardmarket: cm
        ? {
            unit: cm.unit ?? "EUR",
            low: cm.low ?? null,
            trend: cm.trend ?? null,
            avg30: cm.avg30 ?? null,
          }
        : null,
    };
  }

  return { identification, valuation };
}
