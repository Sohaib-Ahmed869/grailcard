// Market Pulse: live rates + trend data for a watchlist of iconic cards,
// powered by JustTCG's price-history fields. Cached hard (12h) to stay well
// inside the free tier alongside scan-time price lookups.

export type PulseCard = {
  label: string;
  setName: string;
  game: string;
  price: number | null;
  change24h: number | null; // percent
  change7d: number | null; // percent
  low7: number | null;
  high7: number | null;
  spark: number[]; // recent price points, oldest -> newest
};

const WATCHLIST: { q: string; game: string; label?: string }[] = [
  { q: "Charizard ex", game: "pokemon" },
  { q: "Pikachu", game: "pokemon" },
  { q: "Umbreon ex", game: "pokemon" },
  { q: "Monkey.D.Luffy", game: "one-piece-card-game", label: "Monkey.D.Luffy" },
  { q: "Elsa", game: "disney-lorcana" },
  { q: "Darth Vader", game: "star-wars-unlimited" },
  { q: "Blue-Eyes White Dragon", game: "yugioh" },
  { q: "Sol Ring", game: "magic-the-gathering" },
];

const TTL_MS = 12 * 3600 * 1000;
let cache: { at: number; data: PulseCard[] } | null = null;

function pct(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

export async function marketPulse(): Promise<PulseCard[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) return cache?.data ?? [];

  const out: PulseCard[] = [];
  for (const w of WATCHLIST) {
    try {
      const res = await fetch(
        `https://api.justtcg.com/v1/cards?q=${encodeURIComponent(w.q)}&game=${w.game}&limit=3`,
        { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as any;
      // pick the most-traded variant across the top hits — the one with the
      // richest price history makes a real trend line, not a flat placeholder
      let card: any = null;
      let v: any = null;
      let best = -1;
      for (const c of (body?.data ?? []) as any[]) {
        for (const variant of (c.variants ?? []) as any[]) {
          const richness =
            ((variant.priceHistory?.length ?? 0) as number) * 10 +
            ((variant.priceChangesCount30d ?? 0) as number);
          if (richness > best) {
            best = richness;
            card = c;
            v = variant;
          }
        }
      }
      if (!card || !v) continue;
      const spark = ((v.priceHistory ?? []) as { p: number }[])
        .map((h) => h.p)
        .filter((p) => Number.isFinite(p))
        .slice(-24);
      out.push({
        label: w.label ?? card.name,
        setName: card.set_name ?? "",
        game: card.game ?? w.game,
        price: pct(v.price),
        change24h: pct(v.priceChange24hr),
        change7d: pct(v.priceChange7d),
        low7: pct(v.minPrice7d),
        high7: pct(v.maxPrice7d),
        spark,
      });
    } catch {
      /* best-effort per card */
    }
  }
  if (out.length > 0) cache = { at: Date.now(), data: out };
  return out;
}
