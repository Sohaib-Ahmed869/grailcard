import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scan, VisionAnalyzeResponse } from "@grailcard/shared";
import { db } from "../db.js";
import { identifyApiTcg } from "./apitcg.js";
import { fetchWebPrices } from "./geminiprice.js";
import { normaliseVisionUrl } from "./visionurl.js";
import { estimateGradedFromRaw, fetchCardGraderMarket } from "./cardgrader.js";
import { identifyWithGemini } from "./gemini.js";
import { fetchJustTcgPrice } from "./justtcg.js";
import { fetchGradedPrices, type GradePoint } from "./gradedprices.js";
import { fetchListings } from "./ebaylistings.js";
import { readPrinting } from "./printing.js";
import { writeGradePrices } from "../cards.store.js";

// Mirrors TIERS in services/vision/app/pipeline/slab.py. Never price across
// tiers: a BCCG 10 and a BGS 10 are not comparable goods.
const GRADER_TIER: Record<string, string> = {
  PSA: "premium", BGS: "premium", BVG: "premium", CGC: "premium", SGC: "premium",
  TAG: "emerging", ACE: "emerging", AGS: "emerging", MNT: "emerging",
  BCCG: "discount", GMA: "discount", KSA: "discount", HGA: "discount", CSG: "discount",
};
import {
  identifyDigimon,
  identifyLorcana,
  identifyOnePiece,
  identifyScryfall,
  identifySwu,
  identifyYgo,
} from "./othergames.js";
import { buildRecommendation, conditionMultiplier } from "./recommend.js";
import { similarity } from "./similarity.js";
import { fetchRelated } from "./related.js";
import { buildSummary } from "./summarize.js";
import { identifyCard, identifyFromSlabLabel } from "./tcgdex.js";
import { gradeWithXimilar } from "./ximilar.js";

const BRAND_HINTS: [RegExp, string][] = [
  [/top\s*trumps/i, "Top Trumps"],
  [/topps/i, "Topps"],
  [/panini/i, "Panini"],
  [/upper\s*deck/i, "Upper Deck"],
  [/marvel/i, "Marvel"],
  [/fleer/i, "Fleer"],
];

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s-])[a-z]/g, (m) => m.toUpperCase());
}

const VISION_URL = normaliseVisionUrl(process.env.VISION_URL);
const STORAGE_ROOT = join(process.cwd(), "storage");

// PSA centering standards for the BACK are looser than the front
const BACK_PSA10_MAX = 75;
const BACK_PSA9_MAX = 90;

@Injectable()
export class ScansService {
  async createFromUpload(
    front: Express.Multer.File,
    back?: Express.Multer.File,
  ): Promise<Scan> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    // free text gathered along the way that might name this copy's printing
    const printingHints: string[] = [];
    const dir = join(STORAGE_ROOT, id);
    mkdirSync(dir, { recursive: true });

    const frontKey = `${id}/front.jpg`;
    writeFileSync(join(STORAGE_ROOT, frontKey), front.buffer);
    if (back) {
      writeFileSync(join(STORAGE_ROOT, `${id}/back.jpg`), back.buffer);
    }

    const [frontRes, backRes] = await Promise.all([
      this.analyze(front, "front"),
      back ? this.analyze(back, "back") : Promise.resolve(null),
    ]);

    const scan: Scan = {
      id,
      status: frontRes.ok ? "analyzed" : "rejected",
      createdAt,
      captures: [
        { kind: "front", imageKey: frontKey, quality: frontRes.quality ?? null },
        ...(back
          ? [
              {
                kind: "back" as const,
                imageKey: `${id}/back.jpg`,
                quality: backRes?.quality ?? null,
              },
            ]
          : []),
      ],
      rejection: frontRes.rejection ?? null,
      backRejection: backRes?.rejection ?? null,
      measurement: frontRes.measurement ?? null,
      grade: frontRes.grade ?? null,
      authenticity: frontRes.authenticity ?? null,
      identification: null,
      valuation: null,
      origin: frontRes.ocr
        ? {
            language: frontRes.ocr.language ?? "unknown",
            japaneseTextDetected: frontRes.ocr.japaneseTextDetected ?? false,
            note: frontRes.ocr.japaneseTextDetected
              ? "Japanese text detected on the card — this is (or includes) a Japanese-language printing."
              : (frontRes.ocr.language ?? "unknown") === "en"
                ? "Rules text reads as English — treated as an English-language printing. Stylized art lettering (which can be Japanese on promos) is not part of this call."
                : "Card language could not be determined from the photo.",
          }
        : null,
      recommendation: null,
    };

    this.saveImages(id, "front", frontRes, scan);
    if (backRes) this.saveImages(id, "back", backRes, scan);

    // trained grading (Ximilar) upgrades the heuristic grade when available.
    // Send the ORIGINAL photo — their detector handles perspective itself.
    // Only for gate-passing scans: each call costs real credits.
    if (frontRes.ok && scan.grade) {
      const trained = await gradeWithXimilar(front.buffer.toString("base64"));
      if (trained) {
        // keep our scratch findings (drawn on the overlay) and our honesty
        // notes about photo conditions alongside their trained sub-grades.
        // Drop heuristic bookkeeping notes that no longer apply — the trained
        // model fills sub-grades the heuristics had declared unassessable.
        trained.grade.findings = scan.grade.findings ?? null;
        trained.grade.notes.push(
          ...scan.grade.notes.filter(
            (n) =>
              !n.startsWith("Corner, edge, and surface") &&
              !n.includes("excluded from the overall grade"),
          ),
        );
        scan.grade = trained.grade;

        // their measured centering ratios fill in when our geometric
        // measurement declined (full-art designs)
        const front_ = scan.measurement?.centering.front;
        if (front_ && !front_.measurable && trained.centeringRatios) {
          front_.lr = trained.centeringRatios.lr;
          front_.tb = trained.centeringRatios.tb;
          front_.measurable = true;
          const worst = Math.max(
            front_.lr,
            100 - front_.lr,
            front_.tb,
            100 - front_.tb,
          );
          scan.measurement!.centering.passesAt.psa10 = worst <= 60;
          scan.measurement!.centering.passesAt.psa9 = worst <= 65;
          scan.measurement!.confidence.centering = 0.6;
        }
      }
    }

    // merge back centering into the front measurement + combined pass verdicts
    if (scan.measurement && backRes?.measurement) {
      const backCentering = backRes.measurement.centering.front;
      scan.measurement.centering.back = backCentering;
      if (backCentering.measurable) {
        const worst = Math.max(
          backCentering.lr,
          100 - backCentering.lr,
          backCentering.tb,
          100 - backCentering.tb,
        );
        scan.measurement.centering.passesAt.psa10 &&= worst <= BACK_PSA10_MAX;
        scan.measurement.centering.passesAt.psa9 &&= worst <= BACK_PSA9_MAX;
      }
    }

    // identification runs even for rejected fronts — a bad photo can still
    // tell the user which card we saw (and what it's worth). All supported
    // game catalogs are searched in parallel; the best match wins.
    if (frontRes.ocr) {
      scan.ocrNames = frontRes.ocr.nameCandidates ?? [];
      // Every scrap of text that might name the PRINTING. The card number does
      // not identify a product — OP13-119 is four products — so the printing
      // has to come from somewhere else: the slab label (Beckett prints the
      // variant), the card's own text, and the vision model's read of the art.
      printingHints.push(...(frontRes.ocr.texts ?? []).map(String));
      if (frontRes.ocr.slab) {
        const L = frontRes.ocr.slab as Record<string, any>;
        printingHints.push(
          ...[L.setLine, L.name, L.gradeText, ...(L.setCandidates ?? [])]
            .filter(Boolean)
            .map(String),
        );
      }
      const names = scan.ocrNames.slice(0, 3);

      // A graded slab carries its own answer key: the label prints the set and
      // the collector number, which resolve to exactly one card. That beats
      // fuzzy name matching outright — name matching is what let a $970
      // "Charizard Star" resolve to a $13 "Charizard VSTAR".
      if (frontRes.ocr.slab) {
        const L = frontRes.ocr.slab;
        console.log(
          `[slab-label] ${L.company} ${L.gradeText} | year=${L.year ?? "-"} | set=${L.setLine ?? "-"} | num=${L.cardNumber ?? "-"} | name=${L.name ?? "-"}`,
        );
      }
      const labelMatch = frontRes.ocr.slab
        ? await identifyFromSlabLabel(frontRes.ocr.slab)
        : null;

      const matches = labelMatch
        ? [labelMatch]
        : (
        await Promise.all([
          identifyCard(frontRes.ocr, frontRes.warpedImageB64),
          identifyScryfall(names),
          identifyYgo(names),
          identifyOnePiece(frontRes.ocr.setCode),
          identifyLorcana(names),
          identifyDigimon(names),
          identifySwu(names),
          identifyApiTcg(names),
        ])
      ).filter((m): m is NonNullable<typeof m> => m != null);
      matches.sort((a, b) => b.identification.matchScore - a.identification.matchScore);
      let match = matches[0];

      // arbitration: anything short of a near-certain catalog match
      // ("LARA" -> Pokemon's "Klara" scored 0.86) gets a second opinion from
      // the vision LLM; a different game verdict means false positive — drop it
      if (match && match.identification.matchScore < 0.93) {
        const opinion = await identifyWithGemini(
          front.buffer.toString("base64"),
          front.mimetype,
        );
        if (opinion?.printing) printingHints.push(opinion.printing);
        if (opinion?.edition) printingHints.push(opinion.edition);
        if (opinion && opinion.game !== match.identification.game) {
          match = undefined as unknown as typeof match;
          scan.identification = {
            cardId: "llm",
            name: opinion.name,
            setId: "",
            setName:
              [opinion.setName, opinion.edition].filter(Boolean).join(" · ") || "Unknown set",
            localId: "",
            rarity: null,
            imageUrl: null,
            matchScore: 0.6,
            ocrName: names[0] ?? "(from image)",
            game: opinion.game,
          };
        } else if (
          opinion &&
          opinion.game === match.identification.game &&
          opinion.setName &&
          match.identification.setName &&
          similarity(opinion.name, match.identification.name) >= 0.75 &&
          similarity(opinion.setName, match.identification.setName) < 0.45
        ) {
          // same card name but the LLM sees a different SET — same-name cards
          // across sets differ in value by orders of magnitude (Base Set
          // Charizard vs Dragon Frontiers Charizard). The catalog row is the
          // wrong printing: keep the LLM identity, honest and price-less.
          match = undefined as unknown as typeof match;
          scan.identification = {
            cardId: "llm",
            name: opinion.name,
            setId: "",
            setName:
              [opinion.setName, opinion.edition].filter(Boolean).join(" · ") || "Unknown set",
            localId: "",
            rarity: null,
            imageUrl: null,
            matchScore: 0.6,
            ocrName: names[0] ?? "(from image)",
            game: opinion.game,
          };
        } else if (
          opinion &&
          opinion.game === match.identification.game &&
          similarity(opinion.name, match.identification.name) < 0.75
        ) {
          // same game but a very different card name: OCR fragments matched
          // the wrong card (generic "Charizard" beating "Mega Charizard X ex").
          // Redo the catalog lookup with the LLM's full name.
          const redoOcr = {
            nameCandidates: [opinion.name],
            collectorNumber: frontRes.ocr.collectorNumber ?? null,
            setCode: frontRes.ocr.setCode ?? null,
            texts: frontRes.ocr.texts ?? [],
            language: (frontRes.ocr.language ?? "unknown") as "en" | "ja" | "unknown",
            japaneseTextDetected: frontRes.ocr.japaneseTextDetected ?? false,
          };
          const redo =
            opinion.game === "pokemon"
              ? await identifyCard(redoOcr, frontRes.warpedImageB64)
              : opinion.game === "mtg"
                ? await identifyScryfall([opinion.name])
                : opinion.game === "yugioh"
                  ? await identifyYgo([opinion.name])
                  : opinion.game === "lorcana"
                    ? await identifyLorcana([opinion.name])
                    : null;
          if (redo) match = redo;
        } else if (!opinion && match.identification.matchScore < 0.72) {
          // no second opinion available and the match is weak — asserting it
          // would be guessing. Fall through to the described-from-text path.
          match = undefined as unknown as typeof match;
        }
        // the vision LLM reads Japanese art text the OCR model can't — its
        // language verdict outranks the OCR-based origin guess
        if (opinion?.language === "ja" && scan.origin) {
          scan.origin = {
            language: "ja",
            japaneseTextDetected: true,
            note: "Japanese text identified on the card by AI vision — this is (or includes) a Japanese-language printing.",
          };
        }
      }

      if (match) {
        scan.identification = match.identification;
        scan.valuation = match.valuation;
      } else if (!scan.identification) {
        // catalogs failed — ask the vision LLM to NAME the card (identification
        // only, never condition or price). If it names a catalog-supported
        // game, loop the name back through the real catalog for verified data.
        const llm = await identifyWithGemini(front.buffer.toString("base64"), front.mimetype);
        if (llm) {
          if (llm.printing) printingHints.push(llm.printing);
          if (llm.edition) printingHints.push(llm.edition);
          const pseudoOcr = {
            nameCandidates: [llm.name],
            collectorNumber: frontRes.ocr.collectorNumber ?? null,
            setCode: frontRes.ocr.setCode ?? null,
            texts: frontRes.ocr.texts ?? [],
            language: (frontRes.ocr.language ?? "unknown") as "en" | "ja" | "unknown",
            japaneseTextDetected: frontRes.ocr.japaneseTextDetected ?? false,
          };
          const verified =
            llm.game === "pokemon"
              ? await identifyCard(pseudoOcr, frontRes.warpedImageB64)
              : llm.game === "mtg"
                ? await identifyScryfall([llm.name])
                : llm.game === "yugioh"
                  ? await identifyYgo([llm.name])
                  : llm.game === "lorcana"
                    ? await identifyLorcana([llm.name])
                    : llm.game === "digimon"
                      ? await identifyDigimon([llm.name])
                      : llm.game === "starwars"
                        ? await identifySwu([llm.name])
                        : null;
          if (verified) {
            scan.identification = verified.identification;
            scan.valuation = verified.valuation;
          } else {
            scan.identification = {
              cardId: "llm",
              name: llm.name,
              setId: "",
              setName: [llm.setName, llm.edition].filter(Boolean).join(" · ") || "Unknown set",
              localId: "",
              rarity: null,
              imageUrl: null,
              matchScore: 0.6,
              ocrName: names[0] ?? "(from image)",
              game: llm.game,
            };
          }
        }
      }
      if (!scan.identification && names.length > 0) {
        // no catalog knows this card — describe it from what's printed on it,
        // clearly labeled as such (matchScore 0 = described, not matched)
        const allText = (frontRes.ocr.texts ?? []).join(" ");
        const brands = BRAND_HINTS.filter(([re]) => re.test(allText)).map(([, b]) => b);
        // name banners are usually caps, and person/card names are usually
        // multi-word — prefer multi-word caps over single logo words
        const caps = names.filter((n) => n === n.toUpperCase() && /[A-Z]{3,}/.test(n));
        const pick = caps.find((n) => n.trim().split(/\s+/).length >= 2) ?? caps[0] ?? names[0];
        scan.identification = {
          cardId: "described",
          name: titleCase(pick),
          setId: "",
          setName: brands.join(" ") || "Unknown set",
          localId: "",
          rarity: null,
          imageUrl: null,
          matchScore: 0,
          ocrName: names[0],
          game: "other",
        };
      }
    }

    // PPT graded + raw prices for the identification that actually survived.
    //
    // This runs ONCE here rather than inside a single identification branch.
    // It used to live in the `if (match)` arm only, so a card identified via
    // the vision-LLM fallback (catalogs return 0 matches on a cropped or
    // glare-heavy photo, then the LLM names it and we re-verify against the
    // catalog) reached the page with a correct card ID and no prices at all —
    // the same Gold Star priced fine from its slab photo and blank from a
    // hand-held one.
    let pptByGrade: Record<string, GradePoint> | null = null;
    let pptByGrader: Record<string, Record<string, GradePoint>> | null = null;
    const ident = scan.identification;
    if (
      ident &&
      ident.game === "pokemon" &&
      ident.cardId !== "llm" &&
      ident.cardId !== "described"
    ) {
      const ppt = await fetchGradedPrices(ident.name, ident.localId, ident.setName);
      pptByGrade = ppt.byGrade ?? null;
      pptByGrader = ppt.byGrader ?? null;
      if (ppt.graded) {
        scan.valuation ??= { source: "tcgdex", tcgplayer: null, cardmarket: null };
        scan.valuation.graded = ppt.graded;
      }
      // vintage sets often have NO price in the free catalogs — PPT's raw
      // market price fills the gap from the same call
      if (ppt.rawUsd != null && !scan.valuation?.tcgplayer?.market) {
        scan.valuation ??= { source: "tcgdex", tcgplayer: null, cardmarket: null };
        scan.valuation.source = "pokemonpricetracker";
        scan.valuation.tcgplayer = {
          unit: "USD",
          variant: "market",
          low: null,
          mid: null,
          high: null,
          market: ppt.rawUsd,
        };
      }
    }

    // sibling cards from the same set with live prices (free, best-effort)
    if (scan.identification && scan.identification.cardId !== "described") {
      scan.related = await fetchRelated(scan.identification);
    }

    // price gap-fill: catalogs without prices (Digimon, Union Arena...) get
    // them from JustTCG when its free key is present
    if (scan.identification && !scan.valuation?.tcgplayer && !scan.valuation?.cardmarket) {
      const filled = await fetchJustTcgPrice(
        scan.identification.name,
        scan.identification.game,
        scan.identification.setName,
      );
      if (filled) scan.valuation = { ...filled, graded: scan.valuation?.graded ?? null };
    }

    // graded-price fallback chain: PPT sold data (above) -> CardGrader
    // market module (their eBay comps; costs a credit) -> multiplier
    // estimate from raw (always available, clearly labeled estimated).
    // Every card gets SOME graded picture, with its provenance stated.
    if (scan.identification && !scan.valuation?.graded) {
      const backup = await fetchCardGraderMarket(
        front.buffer.toString("base64"),
        `gc-market-${id}`,
      );
      if (backup) {
        scan.valuation ??= { source: "tcgdex", tcgplayer: null, cardmarket: null };
        scan.valuation.graded = backup;
      }
    }
    // still nothing? read the open web: Gemini + Google Search reports prices
    // off pages it actually retrieved, and every figure is re-checked against
    // the page it cites before we keep it. Our own reading, not a price feed —
    // so it lands as `estimated` with its sources attached.
    if (
      scan.identification &&
      scan.identification.cardId !== "described" &&
      !scan.valuation?.graded
    ) {
      const web = await fetchWebPrices(scan.identification);
      if (web) {
        scan.valuation ??= { source: "tcgdex", tcgplayer: null, cardmarket: null };
        if (web.graded) {
          scan.valuation.graded = { ...web.graded, citations: web.citations };
        }
        if (web.rawUsd != null && web.rawUsd > 0) {
          scan.valuation.webEstimate = {
            value: web.rawUsd,
            sampleSize: web.sampleSize,
            citations: web.citations,
          };
        }
      }
    }

    // estimateGradedFromRaw is gone from the chain.
    //
    // It multiplied a raw price by a fixed constant to invent graded figures
    // where no sales existed. On a BGS 9.5 One Piece card that reported A$16.66
    // against a real market around A$1,750 — because our graded-price source
    // covers Pokemon only, so every One Piece, Magic, Yu-Gi-Oh and Lorcana card
    // fell through to the multiplier and got a number with no evidence behind
    // it whatsoever.
    //
    // Where we hold no sales for a card at its grade the correct answer is to
    // say so. The live listings panel still shows what the market is asking,
    // which is real data, and the interface names the gap instead of filling
    // it with arithmetic.
    void estimateGradedFromRaw;

    // Separate the graded prices by the company that actually issued them.
    // Everything we can buy today is PSA sale data, so PSA is the only key that
    // gets populated — and that is precisely the point: a Beckett card now
    // shows an empty Beckett tab rather than PSA numbers wearing a BGS badge.
    if (scan.valuation?.graded) {
      const g = scan.valuation.graded;
      // prefer the per-grade evidence from the provider (filtered price, sample
      // size, its own confidence); fall back to the bare number where a source
      // gives us nothing richer
      // every grading company the source tracks, not just PSA
      let byGrader: Record<string, Record<string, GradePoint>> =
        pptByGrader && Object.keys(pptByGrader).length ? { ...pptByGrader } : {};
      if (!Object.keys(byGrader).length) {
        const psa: Record<string, GradePoint> = {};
        if (g.psa8 != null) psa["8"] = { price: g.psa8 };
        if (g.psa9 != null) psa["9"] = { price: g.psa9 };
        if (g.psa10 != null) psa["10"] = { price: g.psa10 };
        if (Object.keys(psa).length) byGrader = { PSA: psa };
      }
      if (Object.keys(byGrader).length > 0) scan.valuation.pricesByGrader = byGrader;

      // Persist under the composite key so the grader survives storage. Until
      // this table existed the schema had psa8/psa9/psa10 columns and no
      // grader dimension at all, which is why a Beckett card could only ever
      // be shown a PSA figure — there was nowhere else to read one from.
      const catalogId = scan.identification?.cardId;
      if (catalogId && catalogId !== "llm" && catalogId !== "described") {
        const rows = Object.entries(byGrader).flatMap(([grader, grades]) =>
          Object.entries(grades).map(([grade, pt]) => ({ grader, grade, pt })),
        );
        void writeGradePrices(
          catalogId,
          rows.map(({ grader, grade, pt }) => ({
            grader,
            grade: Number(grade),
            tier: GRADER_TIER[grader] ?? null,
            price: pt.price ?? null,
            sampleSize: pt.count ?? null,
            confidence: pt.confidence ?? null,
            method: pt.method ?? null,
            low: pt.low ?? null,
            high: pt.high ?? null,
            median: pt.median ?? null,
            source: scan.valuation?.graded?.source ?? "unknown",
          })),
        );
      }
    }
    // the grader and grade as read off the label, so the UI never re-derives
    // them from a display string
    const labelSlab = frontRes.ocr?.slab as
      | { grader?: string | null; grade?: number | null }
      | undefined;
    if (scan.valuation && labelSlab?.grader) {
      scan.valuation.slabGrader = labelSlab.grader;
      scan.valuation.slabGrade = labelSlab.grade ?? null;
    }

    // Where we hold no SOLD comps at the card's own grade, fall back to what
    // the market is currently ASKING for the same slab.
    //
    // The alternative was quoting the raw price, and on a One Piece BGS 9.5 the
    // raw price is $1.99 while nine live listings for that exact card at that
    // exact grade sit between $109 and $2,374. Answering "$2.78" there is not
    // conservative, it is wrong by three orders of magnitude — and the evidence
    // contradicting it was already on the same screen, in our own listings
    // panel. An ask is weaker than a sale and is labelled as one, but it beats
    // a number drawn from a different market entirely.
    const askGrader = scan.valuation?.slabGrader ?? null;
    const askGrade = scan.valuation?.slabGrade ?? null;
    if (scan.valuation && askGrader && askGrader !== "UNKNOWN" && askGrade != null) {
      const sold = scan.valuation.pricesByGrader?.[askGrader]?.[String(askGrade)]?.price;
      if (sold == null && scan.identification) {
        try {
          // Which PRINTING is this copy? Nothing so far had to answer that:
          // the catalog match resolves a card NUMBER, and a number is not a
          // product. OP13-119 is sold as manga art, alternate art, parallel and
          // wanted-poster SP, asking $82 to $8,200 for the same three digits,
          // so pricing without the printing averages four different cards.
          //
          // The label and the card's own text usually do not name it — "manga
          // art" is a collector's term, not something printed on the card — so
          // where they come up empty we ask the vision model, which can see the
          // artwork. One extra call, spent only when it changes the answer.
          if (!readPrinting(printingHints.join(" ")).family) {
            const p = await identifyWithGemini(
              front.buffer.toString("base64"),
              front.mimetype,
            );
            if (p?.printing) printingHints.push(p.printing);
            if (p?.edition) printingHints.push(p.edition);
          }
          const live = await fetchListings({
            name: scan.identification.name,
            setName: scan.identification.setName,
            number: scan.identification.localId,
            grader: askGrader,
            grade: askGrade,
            limit: 24,
            printingHint: [...printingHints, scan.identification.rarity ?? ""].join(" "),
            japanese: scan.origin?.japaneseTextDetected ?? false,
          });
          // filteredToGrade is the condition, not a nicety: an unfiltered median
          // mixes a PSA 10 ask into a BGS 8 valuation, which is the cross-grader
          // error this whole redesign exists to stop.
          if (live?.medianAsk != null && live.filteredToGrade) {
            scan.valuation.liveAsk = {
              median: live.medianAsk,
              low: live.askLow ?? null,
              high: live.askHigh ?? null,
              count: live.listings.length,
              total: live.total,
              grader: askGrader,
              grade: askGrade,
              printing: live.filteredToPrinting ? live.printing : null,
              otherPrintings: live.otherPrintings,
            };
          }
        } catch {
          // asks are a fallback; failing to get them is not a failed scan
        }
      }
    }

    // market prices are near-mint; adjust to THIS copy's estimated condition
    const nmPrice =
      scan.valuation?.tcgplayer?.market ??
      scan.valuation?.cardmarket?.trend ??
      scan.valuation?.webEstimate?.value;
    // conditionAdjusted is gone with the grade that produced it. Discounting a
    // market price by our own condition opinion turned an $84 card into $21 on
    // the strength of a 2.5 the heuristics should never have issued. Raw cards
    // are now quoted at the raw market price, which is what that price is.
    void conditionMultiplier; // retained for reference; no longer applied

    // a slabbed card is already professionally graded — say so, link the cert,
    // and mark our through-the-plastic estimate as non-authoritative
    const slab = frontRes.ocr?.slab;
    if (slab) {
      scan.slab = {
        company: slab.company,
        gradeText: slab.gradeText,
        certNumber: slab.certNumber ?? null,
        verifyUrl:
          slab.company === "PSA" && slab.certNumber
            ? `https://www.psacard.com/cert/${slab.certNumber}`
            : null,
      };
      scan.grade?.notes.unshift(
        `This card is in a ${slab.company} slab (label reads ${slab.gradeText}). ` +
          "Estimates below were made through the case plastic and are NOT authoritative — " +
          "the certified label grade takes precedence.",
      );
      // our through-plastic condition estimate must not discount a card whose
      // condition is CERTIFIED on the label — slab value ≠ raw value
      if (scan.valuation) scan.valuation.conditionAdjusted = null;
      scan.recommendation = {
        verdict: "dont_grade",
        reasoning:
          `Already professionally graded: ${slab.company} ${slab.gradeText}` +
          (slab.certNumber ? `, cert #${slab.certNumber}` : "") +
          ". There is no grading decision to make — the certified grade is the card's grade." +
          (scan.slab.verifyUrl ? " Verify the cert via the link above." : ""),
        gradingCost: 0,
        rawValue: scan.valuation?.tcgplayer?.market ?? null,
        likelyGrade: null,
        rows: [],
      };
      scan.summary = buildSummary(scan);
      db.prepare(
        "INSERT INTO scans (id, created_at, status, record) VALUES (?, ?, ?, ?)",
      ).run(id, createdAt, scan.status, JSON.stringify(scan));
      return scan;
    }

    scan.recommendation = buildRecommendation(scan.grade, scan.valuation);
    // a provisional grade from a gate-rejected photo must never drive a
    // grading decision — the money math needs a real grade first
    if (scan.status === "rejected" && scan.recommendation) {
      scan.recommendation = {
        verdict: "dont_grade",
        reasoning:
          "Don't act on this scan: the photo failed the quality gate, so the grade above is only a rough impression. " +
          "Re-shoot the card (closer, flat, even light) and decide from that scan.",
        gradingCost: scan.recommendation.gradingCost,
        rawValue: scan.recommendation.rawValue,
        likelyGrade: null,
        rows: [],
      };
    }
    scan.summary = buildSummary(scan);

    db.prepare(
      "INSERT INTO scans (id, created_at, status, record) VALUES (?, ?, ?, ?)",
    ).run(id, createdAt, scan.status, JSON.stringify(scan));

    return scan;
  }

  getById(id: string): Scan | null {
    const row = db.prepare("SELECT record FROM scans WHERE id = ?").get(id) as
      | { record: string }
      | undefined;
    return row ? (JSON.parse(row.record) as Scan) : null;
  }

  listRecent(limit = 20): Scan[] {
    const rows = db
      .prepare("SELECT record FROM scans ORDER BY created_at DESC LIMIT ?")
      .all(limit) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as Scan);
  }

  private saveImages(
    id: string,
    side: "front" | "back",
    res: VisionAnalyzeResponse,
    scan: Scan,
  ) {
    if (res.warpedImageB64) {
      writeFileSync(
        join(STORAGE_ROOT, `${id}/${side}_warped.png`),
        Buffer.from(res.warpedImageB64, "base64"),
      );
    }
    if (res.overlayImageB64) {
      const key = `${id}/${side}_overlay.png`;
      writeFileSync(join(STORAGE_ROOT, key), Buffer.from(res.overlayImageB64, "base64"));
      if (side === "front" && scan.measurement) {
        scan.measurement.centering.overlayImageKey = key;
      }
    }
  }

  private async analyze(
    file: Express.Multer.File,
    kind: "front" | "back",
  ): Promise<VisionAnalyzeResponse> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      file.originalname ?? `${kind}.jpg`,
    );
    form.append("kind", kind);

    let res: Response;
    try {
      res = await fetch(`${VISION_URL}/analyze`, { method: "POST", body: form });
    } catch {
      throw new ServiceUnavailableException(
        `vision service unreachable at ${VISION_URL}`,
      );
    }
    if (!res.ok) {
      throw new ServiceUnavailableException(`vision service error ${res.status}`);
    }
    return (await res.json()) as VisionAnalyzeResponse;
  }
}
