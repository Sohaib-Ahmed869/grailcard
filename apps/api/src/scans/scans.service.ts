import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scan, VisionAnalyzeResponse } from "@grailcard/shared";
import { db } from "../db.js";
import { identifyApiTcg } from "./apitcg.js";
import { identifyWithGemini } from "./gemini.js";
import { fetchJustTcgPrice } from "./justtcg.js";
import { fetchGradedPrices } from "./gradedprices.js";
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
import { identifyCard } from "./tcgdex.js";
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

const VISION_URL = process.env.VISION_URL ?? "http://localhost:8100";
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
      const names = scan.ocrNames.slice(0, 3);
      const matches = (
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
        if (match.identification.game === "pokemon") {
          const graded = await fetchGradedPrices(
            match.identification.name,
            match.identification.localId,
            match.identification.setName,
          );
          if (graded) {
            scan.valuation ??= { source: "tcgdex", tcgplayer: null, cardmarket: null };
            scan.valuation.graded = graded;
          }
        }
      } else if (!scan.identification) {
        // catalogs failed — ask the vision LLM to NAME the card (identification
        // only, never condition or price). If it names a catalog-supported
        // game, loop the name back through the real catalog for verified data.
        const llm = await identifyWithGemini(front.buffer.toString("base64"), front.mimetype);
        if (llm) {
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

    // market prices are near-mint; adjust to THIS copy's estimated condition
    const nmPrice = scan.valuation?.tcgplayer?.market ?? scan.valuation?.cardmarket?.trend;
    if (scan.valuation && scan.grade && nmPrice != null) {
      const multiplier = conditionMultiplier(scan.grade.overall);
      scan.valuation.conditionAdjusted = {
        value: Math.round(nmPrice * multiplier * 100) / 100,
        multiplier,
      };
    }

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
        verdict: "insufficient_data",
        reasoning:
          "This photo failed the quality gate, so the grade above is only a rough impression. " +
          "Re-shoot the card (closer, flat, even light) before making any grading decision.",
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
