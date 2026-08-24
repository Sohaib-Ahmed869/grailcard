// Printing / variant identity.
//
// A card number is not a card. OP13-119 is sold on eBay as at least four
// different products whose asking prices do not overlap at all:
//
//   Alternate Art SEC     $82 - $600
//   Parallel             $300 - $395
//   Wanted Poster SP     $400 - $1,200
//   Manga Alt Art SEC    $900 - $8,200
//
// Taking one median across that set answers a question nobody asked. It is the
// same failure as pricing a Shadowless Charizard off Unlimited sales, or a
// reverse holo off the normal print — the catalog match was right and the
// price was still wrong by an order of magnitude.
//
// So printings are matched, not averaged. This module reads a printing out of
// free text (a slab label, a card's OCR, an eBay title) and decides whether two
// such reads describe the same product.

/** Mutually exclusive printing lines. A card belongs to at most one. */
const FAMILIES: [string, RegExp][] = [
  ["manga", /\bmanga\b/i],
  ["parallel", /\bparallel\b/i],
  // "Wanted Poster", "Wanted SP" — one line, written many ways
  ["wanted", /\bwanted\b/i],
  ["shadowless", /\bshadowless\b/i],
  ["1st", /\b(1st|first)\s*ed(ition)?\b/i],
  ["reverse", /\b(reverse|rev)\s*(holo|foil)\b/i],
  ["staff", /\bstaff\b/i],
];

/** Descriptors that CO-OCCUR with a family rather than replacing it.
 *  "Manga Alt Art" is one printing, not two, so alt-art cannot be a family. */
const MODIFIERS: [string, RegExp][] = [
  ["altart", /\b(alt|alternate|alternative)\s*art\b/i],
  ["fullart", /\bfull\s*art\b/i],
  ["error", /\b(error|misprint|err)\b/i],
  ["gold", /\bgold\b/i],
  ["promo", /\bpromo\b/i],
];

const JA = /\b(jpn|japanese|japan|jp)\b/i;
const EN = /\b(eng|english|en)\b/i;

export type Printing = {
  /** the exclusive printing line, where the text declares one */
  family: string | null;
  modifiers: string[];
  language: "ja" | "en" | null;
};

export function readPrinting(text: string | null | undefined): Printing {
  const t = text ?? "";
  const family = FAMILIES.find(([, re]) => re.test(t))?.[0] ?? null;
  const modifiers = MODIFIERS.filter(([, re]) => re.test(t)).map(([k]) => k);
  // English is the default assumption everywhere, so only an explicit marker
  // counts; "en" inside another word must not trigger it (the \b guards do).
  const language = JA.test(t) ? "ja" : EN.test(t) ? "en" : null;
  return { family, modifiers, language };
}

export type Verdict = "match" | "conflict" | "unknown";

/** Does `listing` describe the same printing as `card`?
 *
 *  "unknown" is a real and common answer — most sellers do not spell out the
 *  printing — and it is deliberately NOT folded into either other value. A
 *  listing that says nothing is weak evidence, not wrong evidence, and the
 *  caller decides whether it has enough positive matches to ignore it. */
export function comparePrinting(card: Printing, listing: Printing): Verdict {
  if (card.family && listing.family) {
    if (card.family !== listing.family) return "conflict";
  } else if (card.family && !listing.family) {
    return "unknown";
  } else if (!card.family && listing.family) {
    // We could not read a family off our own card. A listing that declares one
    // may still be ours, so this cannot be a conflict.
    return "unknown";
  }

  // Language is a hard split where both sides state it: a Japanese print and
  // an English print of the same art are different products at different
  // prices, which is exactly the Base Set / Japanese Base Set trap.
  if (card.language && listing.language && card.language !== listing.language) {
    return "conflict";
  }

  return card.family && listing.family === card.family ? "match" : "unknown";
}

/** Human-readable name for a printing, for the interface to show. */
export function describePrinting(p: Printing): string | null {
  const parts: string[] = [];
  if (p.family) {
    parts.push(
      { manga: "Manga Art", parallel: "Parallel", wanted: "Wanted Poster",
        shadowless: "Shadowless", "1st": "1st Edition", reverse: "Reverse Holo",
        staff: "Staff" }[p.family] ?? p.family,
    );
  }
  for (const m of p.modifiers) {
    parts.push(
      { altart: "Alt Art", fullart: "Full Art", error: "Error",
        gold: "Gold", promo: "Promo" }[m] ?? m,
    );
  }
  if (p.language === "ja") parts.push("Japanese");
  return parts.length ? parts.join(" · ") : null;
}
