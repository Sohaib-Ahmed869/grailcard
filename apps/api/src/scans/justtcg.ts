import type { Valuation } from "@grailcard/shared";

// JustTCG: prices for 17+ TCGs — fills gaps where the free catalog has no
// prices (Digimon, Union Arena, ...). FREE tier: 1,000 req/mo, key signup at
// justtcg.com. Dormant until JUSTTCG_API_KEY is set in apps/api/.env.

const GAME_MAP: Record<string, string> = {
  pokemon: "pokemon",
  mtg: "magic-the-gathering",
  yugioh: "yugioh",
  onepiece: "one-piece-card-game",
  lorcana: "disney-lorcana",
  digimon: "digimon-card-game",
  starwars: "star-wars-unlimited",
};

export async function fetchJustTcgPrice(
  cardName: string,
  game: string,
): Promise<Valuation | null> {
  const key = process.env.JUSTTCG_API_KEY;
  const mapped = GAME_MAP[game];
  if (!key || !mapped) return null;

  try {
    const res = await fetch(
      `https://api.justtcg.com/v1/cards?q=${encodeURIComponent(cardName)}&game=${mapped}&limit=5`,
      { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as any;
    const items = (body?.data ?? body?.cards ?? []) as any[];
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
