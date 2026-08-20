// USD -> AUD via frankfurter.app (ECB rates, free, no key). Cached 24h.

let fxCache: { at: number; rate: number } | null = null;
const FX_TTL = 24 * 3600 * 1000;
const FALLBACK_RATE = 1.5;

export async function usdToAud(): Promise<number> {
  if (fxCache && Date.now() - fxCache.at < FX_TTL) return fxCache.rate;
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=USD&to=AUD", {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const body = (await res.json()) as { rates?: { AUD?: number } };
      const rate = body.rates?.AUD;
      if (typeof rate === "number" && rate > 0.5 && rate < 5) {
        fxCache = { at: Date.now(), rate };
        return rate;
      }
    }
  } catch {
    /* fall through */
  }
  return fxCache?.rate ?? FALLBACK_RATE;
}
