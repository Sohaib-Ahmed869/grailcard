import { recordUsage } from "./usage.js";
import { comparePrinting, describePrinting, readPrinting, type Printing } from "./printing.js";

// Live eBay listings for a card, shown in-product rather than as a link out.
//
// These are ASKS, not sales. That distinction matters and is carried through to
// the response so the interface can say it: a card listed at $30,000 for eight
// months is not a $30,000 card. The sold medians elsewhere in the valuation are
// the authority; this is here so a seller can see what the market is currently
// being offered at, and sanity-check our figure against real inventory.

const EBAY = "https://api.ebay.com";
const TTL_MS = 30 * 60 * 1000; // asks move slowly; half an hour is plenty

export type Listing = {
  title: string;
  price: number | null;
  currency: string;
  condition: string | null;
  imageUrl: string | null;
  url: string;
  seller: string | null;
  /** grader + grade parsed out of the title, where present */
  grader: string | null;
  grade: number | null;
  /** printing named in the title, e.g. "Manga Art · Alt Art · Japanese" */
  printing: string | null;
  /** how that printing compares to the card we scanned */
  printingMatch: "match" | "conflict" | "unknown";
};

export type ListingResult = {
  listings: Listing[];
  total: number;
  query: string;
  /** true when we filtered to the card's own grader and grade */
  filteredToGrade: boolean;
  /** listings that survived every filter, of which `listings` shows the first few */
  matched: number;
  /** median asking price of what survived filtering — a figure, not just a list.
   *  Median rather than mean: one aspirational listing should not move it. */
  medianAsk: number | null;
  askLow: number | null;
  askHigh: number | null;
  /** the printing these figures are for, where we could pin one down */
  printing: string | null;
  /** true when the listings were narrowed to that printing */
  filteredToPrinting: boolean;
  /** other printings of the same card number we saw and excluded, with the
   *  asking range for each — the card number alone does not identify a product
   *  and the interface should be able to say so */
  otherPrintings: { name: string; count: number; low: number; high: number }[];
};

const cache = new Map<string, { at: number; v: ListingResult }>();
let token: { value: string; expires: number } | null = null;

async function getToken(): Promise<string | null> {
  const id = process.env.EBAY_APP_ID;
  const secret = process.env.EBAY_CERT_ID;
  if (!id || !secret) return null;
  if (token && Date.now() < token.expires) return token.value;
  try {
    const res = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body:
        "grant_type=client_credentials&scope=" +
        encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!b.access_token) return null;
    // refresh a minute early rather than racing the expiry
    token = { value: b.access_token, expires: Date.now() + (b.expires_in ?? 7200) * 1000 - 60_000 };
    return token.value;
  } catch {
    return null;
  }
}

/** Pull the grading company and grade out of a listing title.
 *  Sellers write "BGS 8.5", "PSA 10 GEM MINT", "CGC 9.5" — enough to tell a
 *  listing for this exact slab from one for a different grade of the same card. */
function gradeFromTitle(title: string): { grader: string | null; grade: number | null } {
  const m = /\b(PSA|BGS|BECKETT|CGC|SGC|TAG|ACE|BVG|BCCG)\s*(\d{1,2}(?:\.5)?)\b/i.exec(title);
  if (!m) return { grader: null, grade: null };
  const grader = m[1].toUpperCase() === "BECKETT" ? "BGS" : m[1].toUpperCase();
  const grade = Number(m[2]);
  return { grader, grade: Number.isFinite(grade) && grade >= 1 && grade <= 10 ? grade : null };
}

export async function fetchListings(opts: {
  name: string;
  setName?: string | null;
  number?: string | null;
  grader?: string | null;
  grade?: number | null;
  limit?: number;
  /** everything we know in words about THIS copy — slab label lines, the card's
   *  own OCR, the vision model's printing call. Read for a printing, not
   *  searched on: adding "manga" to the query would hide untitled listings. */
  printingHint?: string | null;
  /** true when the card carries Japanese text */
  japanese?: boolean;
}): Promise<ListingResult | null> {
  const show = Math.min(opts.limit ?? 12, 24);
  // Fetch wide, show narrow. Printing and grade filtering discard most of what
  // comes back — on OP13-119 only 9 of 100 results are the printing we want —
  // so asking for 12 and filtering leaves nothing to compute a median from.
  const limit = 100;
  // strip glyphs that break eBay's text search the same way they break ours
  const clean = (s: string) => s.replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  // The card NUMBER is the single most valuable token in the query. Without it
  // "Portgas.D.Ace Carrying On His Will BGS 9.5" returned a $28 Leader card
  // from the same set; with "OP13-119" the same search returns the actual card
  // at $900-$1,700, which is where its market really is.
  const number = opts.number ? clean(opts.number) : null;
  const parts = [clean(opts.name)];
  if (number) parts.push(number);
  else if (opts.setName) parts.push(clean(opts.setName));
  if (opts.grader && opts.grade != null) parts.push(`${opts.grader} ${opts.grade}`);
  const query = parts.filter(Boolean).join(" ");

  const cardPrinting: Printing = readPrinting(opts.printingHint);
  if (opts.japanese && !cardPrinting.language) cardPrinting.language = "ja";
  const key = `${query}|${show}|${cardPrinting.family ?? ""}|${cardPrinting.language ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;

  const tok = await getToken();
  if (!tok) return null;

  try {
    recordUsage("ebay");
    const url =
      `${EBAY}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}` +
      `&limit=${limit}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[ebay] listings ${res.status} for "${query}"`);
      return null;
    }
    const body = (await res.json()) as any;
    const items: any[] = body.itemSummaries ?? [];

    const listings: Listing[] = items.map((it) => {
      const rawTitle = String(it.title ?? "");
      const { grader, grade } = gradeFromTitle(rawTitle);
      const p = readPrinting(rawTitle);
      return {
        title: rawTitle.slice(0, 140),
        price: it.price?.value != null ? Number(it.price.value) : null,
        currency: String(it.price?.currency ?? "USD"),
        condition: it.condition ?? null,
        imageUrl: it.thumbnailImages?.[0]?.imageUrl ?? it.image?.imageUrl ?? null,
        url: String(it.itemWebUrl ?? ""),
        seller: it.seller?.username ?? null,
        grader,
        grade,
        printing: describePrinting(p),
        printingMatch: comparePrinting(cardPrinting, p),
      };
    });

    let filtered = listings;

    // Drop listings whose title carries a DIFFERENT card number. Sellers put the
    // number in the title, so this is a cheap and reliable way to reject the
    // wrong card from the right set — which is most of the noise.
    if (number) {
      const wanted = number.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const sameCard = listings.filter((l) => {
        const t = l.title.toUpperCase().replace(/[^A-Z0-9]/g, "");
        return t.includes(wanted);
      });
      if (sameCard.length >= 2) filtered = sameCard;
    }

    // When we know the card's grade, surface listings for THAT grade —
    // a PSA 10 asking price tells the owner of a PSA 5 very little.
    let filteredToGrade = false;
    if (opts.grader && opts.grade != null) {
      const exact = filtered.filter(
        (l) => l.grader === opts.grader && l.grade === opts.grade,
      );
      if (exact.length >= 2) {
        filtered = exact;
        filteredToGrade = true;
      }
    }
    // Narrow to OUR printing. This is the difference between pricing a card and
    // pricing a card number: the four printings of OP13-119 that share a number
    // ask $82 and $8,200 for the same three digits.
    //
    // Only listings that positively declare our printing are kept, and only
    // when enough of them exist to stand on their own. Silent listings are not
    // evidence against us, but they are not evidence for us either, and a
    // median built mostly on silence is the mixed figure we set out to remove.
    let filteredToPrinting = false;
    const otherPrintings: ListingResult["otherPrintings"] = [];
    if (cardPrinting.family || cardPrinting.language) {
      const matched = filtered.filter((l) => l.printingMatch === "match");
      const conflicting = filtered.filter((l) => l.printingMatch === "conflict");
      if (matched.length >= 3) {
        // report what we set aside, so the interface can name the alternatives
        const byName = new Map<string, number[]>();
        for (const l of conflicting) {
          if (l.price == null) continue;
          const n = l.printing ?? "other printing";
          byName.set(n, [...(byName.get(n) ?? []), l.price]);
        }
        for (const [name, ps] of byName) {
          ps.sort((a, b) => a - b);
          otherPrintings.push({ name, count: ps.length, low: ps[0], high: ps[ps.length - 1] });
        }
        otherPrintings.sort((a, b) => b.count - a.count);
        filtered = matched;
        filteredToPrinting = true;
      }
    }

    filtered.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));

    const priced = filtered.filter((l) => l.price != null && l.url);
    const values = priced.map((l) => l.price as number).sort((a, b) => a - b);
    const median =
      values.length === 0
        ? null
        : values.length % 2
          ? values[(values.length - 1) / 2]
          : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;

    const v: ListingResult = {
      listings: priced.slice(0, show),
      total: Number(body.total ?? priced.length),
      matched: priced.length,
      query,
      filteredToGrade,
      medianAsk: median,
      askLow: values[0] ?? null,
      askHigh: values[values.length - 1] ?? null,
      printing: describePrinting(cardPrinting),
      filteredToPrinting,
      otherPrintings,
    };
    cache.set(key, { at: Date.now(), v });
    return v;
  } catch (err) {
    console.warn(`[ebay] listings failed for "${query}": ${(err as Error).message}`);
    return null;
  }
}
