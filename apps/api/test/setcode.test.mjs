// Fixtures from the two PSA-graded Japanese cards our fuzzy matcher put in the
// wrong set: a A$1,500 Mega Charizard X ex SAR read as a $5 English Double Rare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSetCode, identifyBySetCode } from "../src/scans/setcode.js";

// exactly what the OCR returned for each card, label lines and card text
const CARD3 = ["2025POKEMONM2aJP", "#240", "MEGAGENGAReX", "GEMMT", "SPECIALARTRARE",
               "10", "144830132", "功竹力一ex", "350"];
const CARD4 = ["2025POKEMONM JP", "MEGACHARIZARDXeX", "GEMMT", "SPECIALARTRARE",
               "llus.danciao", "M2", "110/080SAR", "360"];

test("label spelling out the code wins", () => {
  const r = readSetCode(CARD3);
  assert.equal(r?.code, "M2a");
  assert.equal(r?.locale, "ja");
});

test("code read off the card when the label lost a digit", () => {
  // the label OCR'd as "POKEMONM JP" — the 2 of M2 did not survive. The card
  // prints the code itself in the bottom-left corner.
  const r = readSetCode(CARD4);
  assert.equal(r?.code, "M2");
  assert.equal(r?.number, "110");
  assert.equal(r?.printedNumber, "110/080");
  assert.equal(r?.rarity, "SAR");
});

test("an English card is never claimed as Japanese", () => {
  // no Japanese rarity suffix and no "<CODE> JP" — must decline
  assert.equal(readSetCode(["Charizard", "Base Set", "4/102", "PSA 9"]), null);
  assert.equal(readSetCode(["Pikachu", "#58", "Jungle", "1ST EDITION"]), null);
  assert.equal(readSetCode(["Stussy", "SPOP07-085SR", "CHARACTER"]), null);
});

test("no set code, no answer", () => {
  assert.equal(readSetCode([]), null);
  assert.equal(readSetCode(["240/193 SAR"]), null); // rarity but no code anywhere
});

test("resolves to the real card, not a similar-sounding one", { concurrency: false }, async () => {
  const r = readSetCode(CARD4);
  const id = await identifyBySetCode(r, "110", "Mega Charizard X ex");
  assert.equal(id?.cardId, "M2-110");
  assert.equal(id?.setId, "M2");
  assert.equal(id?.localId, "110/080");
  assert.equal(id?.rarity, "SAR");
  assert.equal(id?.matchScore, 1);
  // NOT the English Phantasmal Flames #013 the fuzzy matcher chose
  assert.notEqual(id?.setId, "me02");
});

test("resolves the second card too", { concurrency: false }, async () => {
  const id = await identifyBySetCode(readSetCode(CARD3), "240", "Mega Gengar ex");
  assert.equal(id?.cardId, "M2a-240");
  assert.equal(id?.setId, "M2a");
});

test("a code that does not exist resolves to nothing, never to a guess", async () => {
  const id = await identifyBySetCode(
    { code: "ZZ9", locale: "ja", number: "1", printedNumber: "1/1", rarity: "SAR" },
    "1", "Nothing",
  );
  assert.equal(id, null);
});

import { isSealedProduct } from "../src/scans/setcode.js";

test("a sealed pack is recognised through OCR's missing spaces", () => {
  // exactly the label lines the pack came back with
  assert.equal(isSealedProduct(["WOTC-POKEMON", "JUNGLEFOILPACK", "GEMMT", "IST -SCYTHER"]), true);
  assert.equal(isSealedProduct(["1999 WOTC POKEMON", "JUNGLE FOIL PACK"]), true);
  assert.equal(isSealedProduct(["POKEMON BOOSTER BOX", "BASE SET"]), true);
  // a single card must never be mistaken for sealed product
  assert.equal(isSealedProduct(["POKEMONM2aJP", "MEGAGENGAReX", "SPECIALARTRARE"]), false);
  assert.equal(isSealedProduct(["2025 ONE PIECE", "PORTGAS.D.ACE", "MANGA ART SEC"]), false);
  assert.equal(isSealedProduct([]), false);
});
