// Search by name.
//
// Scanning answers "what is this card in front of me". Search answers "what is
// this card worth" when the card is not in front of you — a want list, a deal
// on the phone, a collection being valued from a spreadsheet.
//
// The two paths must agree. A scan and a search that land on the same card have
// to produce the same figure, so search resolves to the SAME catalog identity a
// scan resolves to and hands it to the same pricing chain. Anything else and
// the product quotes two prices for one card.

import { similarity } from "./similarity.js";

const TCGDEX_ROOT = (process.env.TCGDEX_URL ?? "https://api.tcgdex.net/v2/en").replace(
  /\/(en|ja|fr|de|es|it|pt)$/,
  "",
);

export type SearchHit = {
  cardId: string;
  name: string;
  /** the catalog's own-language name where it differs — Japanese sets */
  nameLocal: string | null;
  setId: string;
  setName: string;
  localId: string;
  rarity: string | null;
  imageUrl: string | null;
  game: string;
  /** how well the name matched, 0..1 — shown so a weak hit reads as one */
  score: number;
};

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; v: SearchHit[] }>();

async function getJson(url: string, ms = 9000): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

type Brief = { id: string; localId?: string | number; name: string; image?: string };

/** Pokemon, in one locale. English and Japanese are separate catalogs with
 *  separate cards — the Japanese Mega Charizard X ex SAR does not exist in the
 *  English one — so both are searched and both can return hits. */
async function pokemon(q: string, locale: "en" | "ja"): Promise<SearchHit[]> {
  const list = (await getJson(
    `${TCGDEX_ROOT}/${locale}/cards?name=like:${encodeURIComponent(q)}`,
  )) as Brief[] | null;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).map((c) => ({
    cardId: c.id,
    name: c.name,
    nameLocal: null,
    setId: String(c.id).split("-")[0],
    setName: "",
    localId: String(c.localId ?? ""),
    rarity: null,
    imageUrl: c.image ? `${c.image}/high.png` : null,
    game: "pokemon",
    score: similarity(q, c.name),
  }));
}

/** Magic, via Scryfall's own search — it handles spelling far better than a
 *  name filter would, so the query is passed through rather than pre-matched. */
async function magic(q: string): Promise<SearchHit[]> {
  const body = await getJson(
    `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`,
  );
  const cards = (body?.data ?? []) as any[];
  return cards.slice(0, 20).map((c) => ({
    cardId: `scryfall-${c.id}`,
    name: c.name,
    nameLocal: null,
    setId: String(c.set ?? "").toUpperCase(),
    setName: c.set_name ?? "",
    localId: String(c.collector_number ?? ""),
    rarity: c.rarity ?? null,
    imageUrl: c.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal ?? null,
    game: "mtg",
    score: similarity(q, c.name ?? ""),
  }));
}

/** One Piece.
 *
 *  The catalog has no name search — only "give me one card by its code" and
 *  "give me a whole set" — so an index is built once from every set and kept.
 *  Thirty requests on the first search of the process, none after that. */
let opIndex: SearchHit[] | null = null;
let opBuilding: Promise<SearchHit[]> | null = null;

const OP_CODE = /\b((?:OP|ST|EB|PRB)\d{2})\s*-\s*(\d{3})\b/i;

async function buildOnePieceIndex(): Promise<SearchHit[]> {
  const sets = (await getJson("https://optcgapi.com/api/allSets/", 12000)) as
    | { set_id: string; set_name: string }[]
    | null;
  if (!Array.isArray(sets)) return [];
  const pages = await Promise.all(
    sets.map((s) => getJson(`https://optcgapi.com/api/sets/${encodeURIComponent(s.set_id)}/`, 15000)),
  );
  const out: SearchHit[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) continue;
    for (const c of page) {
      if (!c?.card_name || !c?.card_set_id) continue;
      out.push({
        cardId: `optcg-${c.card_set_id}`,
        // the catalog suffixes a disambiguating number: "Portgas.D.Ace (119)"
        name: String(c.card_name).replace(/\s*\(\d+\)\s*$/, ""),
        nameLocal: null,
        setId: String(c.card_set_id).split("-")[0],
        setName: c.set_name ?? "",
        localId: String(c.card_set_id),
        rarity: c.rarity ?? null,
        imageUrl: c.card_image ?? null,
        game: "onepiece",
        score: 0,
      });
    }
  }
  return out;
}

async function onePiece(q: string): Promise<SearchHit[]> {
  if (!opIndex) {
    opBuilding = opBuilding ?? buildOnePieceIndex();
    opIndex = await opBuilding;
  }
  const index = opIndex;
  if (!index.length) return [];

  // A card code is an exact address, not a name to be scored
  const code = OP_CODE.exec(q);
  if (code) {
    const want = `${code[1].toUpperCase()}-${code[2]}`;
    return index
      .filter((h) => h.localId.toUpperCase() === want)
      .map((h) => ({ ...h, score: 1 }));
  }

  const ql = q.toLowerCase();
  return index
    .map((h) => ({
      ...h,
      score: h.name.toLowerCase().includes(ql) ? Math.max(0.75, similarity(q, h.name)) : similarity(q, h.name),
    }))
    .filter((h) => h.score >= 0.55)
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);
}

/** Fill in the set name and rarity a list endpoint does not carry.
 *  Only for the handful actually shown — a detail call per result would turn
 *  one search into forty. */
async function enrich(hits: SearchHit[], locale: "en" | "ja"): Promise<void> {
  await Promise.all(
    hits.map(async (h) => {
      if (h.game !== "pokemon" || h.setName) return;
      const d = await getJson(`${TCGDEX_ROOT}/${locale}/cards/${h.cardId}`, 7000);
      if (!d) return;
      h.setName = d.set?.name ?? h.setId;
      h.rarity = d.rarity ?? null;
      if (locale === "ja" && d.name && d.name !== h.name) h.nameLocal = d.name;
    }),
  );
}

export async function searchCards(q: string, limit = 24): Promise<SearchHit[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const key = `${query.toLowerCase()}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;

  const [en, ja, mtg, op] = await Promise.all([
    pokemon(query, "en"),
    pokemon(query, "ja"),
    magic(query),
    onePiece(query),
  ]);

  // A Japanese hit is only worth showing when it is a real name match. The ja
  // catalog names cards in Japanese, so an English query scores near zero
  // against most of it and would otherwise fill the list with noise.
  const jaKept = ja.filter((h) => h.score >= 0.55);
  const all = [...en, ...jaKept, ...mtg, ...op]
    .filter((h) => h.score >= 0.4)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, limit);

  await Promise.all([
    enrich(all.filter((h) => en.includes(h)), "en"),
    enrich(all.filter((h) => jaKept.includes(h)), "ja"),
  ]);

  cache.set(key, { at: Date.now(), v: all });
  return all;
}
