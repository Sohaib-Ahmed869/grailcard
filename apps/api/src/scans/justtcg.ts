import type { Valuation } from "@grailcard/shared";
import { similarity } from "./similarity.js";

// JustTCG: prices for 18 TCGs — fills gaps where the free catalog has no
// prices (Digimon, Union Arena, Dragon Ball, ...). FREE tier: 1,000 req/mo.
// Dormant until JUSTTCG_API_KEY is set in apps/api/.env.

const GAME_MAP: Record<string, string> = {
  pokemon: "pokemon",
  mtg: "magic-the-gathering",
  yugioh: "yugioh",
  onepiece: "one-piece-card-game",
  lorcana: "disney-lorcana",
  digimon: "digimon-card-game",
  starwars: "star-wars-unlimited",
  dragonball: "dragon-ball-super-fusion-world",
  gundam: "gundam-card-game",
  unionarena: "union-arena",
  riftbound: "riftbound-league-of-legends-trading-card-game",
};

async function search(key: string, q: string, gameSlug?: string): Promise<any[]> {
  const game = gameSlug ? `&game=${gameSlug}` : "";
  const res = await fetch(
    `https://api.justtcg.com/v1/cards?q=${encodeURIComponent(q)}${game}&limit=8`,
    { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as any;
  return (body?.data ?? body?.cards ?? []) as any[];
}

export async function fetchJustTcgPrice(
  cardName: string,
  game: string,
): Promise<Valuation | null> {
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) return null;

  try {
    const mapped = GAME_MAP[game];
    let items = mapped ? await search(key, cardName, mapped) : [];
    // unmapped game (or no hit): cross-game search — but then only a STRONG
    // name match may be priced, wrong-card prices are worse than none
    if (items.length === 0) {
      items = (await search(key, cardName)).filter(
        (it) => similarity(cardName, String(it.name ?? "")) >= 0.8,
      );
    }
    const first = items[0];
    if (!first) return null;
    const variant = (first.variants ?? [])[0] ?? first;
    const price =
      variant.price ?? variant.marketPrice ?? variant.nm ?? first.price ?? null;
    if (price == null) return null;
    return {
      source: "justtcg",
      updatedAt: null,
      tcgplayer: {
        unit: "USD",
        variant: String(variant.condition ?? variant.printing ?? "normal"),
        low: null,
        mid: null,
        high: null,
        market: Number(price),
      },
      cardmarket: null,
    };
  } catch {
    return null;
  }
}
