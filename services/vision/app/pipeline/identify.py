"""OCR-based card identification hints.

Reads text off the warped card and extracts what the catalog lookup needs:
candidate names (prominent text near the top of the card) and the collector
number (e.g. "031/064"). Identification needs far less resolution than
grading, so this runs even on gate-rejected scans — a rejected photo can
still tell the user which card we saw.

The actual catalog match (TCGdex) happens in the API layer; this module only
reports what is printed on the card.
"""

import re

import cv2
import numpy as np

_ENGINE = None

COLLECTOR_RE = re.compile(r"\b(\d{1,3})\s*/\s*(\d{1,3})\b")
# game-specific set codes printed in Latin script even on Japanese cards
SET_CODE_RE = re.compile(r"\b((?:OP|ST|EB|PRB)\d{2})\s*[-–]\s*(\d{3})\b", re.IGNORECASE)

_SLAB_COMPANIES = re.compile(r"\b(PSA|BGS|BECKETT|CGC|SGC|TAG|AGS)\b", re.IGNORECASE)
_COMPANY_ALIAS = {"BECKETT": "BGS"}
_SLAB_GRADE = re.compile(
    r"\b(GEM\s*M(?:IN)?T|MINT|NM[-\s]?MT|NM|EX[-\s]?MT|PRISTINE)\b\s*(10|9(?:\.5)?|[1-8](?:\.5)?)?\b",
    re.IGNORECASE,
)
_CERT_RE = re.compile(r"\b(\d{7,10})\b")  # PSA 8-9 digits, BGS up to 10


_YEAR_RE = re.compile(r"\b(19[6-9]\d|20[0-4]\d)\b")
_LABEL_NUM_RE = re.compile(r"#\s*([A-Z]{0,3}\d{1,3})\b")
# grading-company furniture that is never part of the card or set name
_LABEL_NOISE = re.compile(
    r"\b(PSA|BGS|BECKETT|CGC|SGC|TAG|AGS|GEM|MINT|MT|NM|EX[-\s]?MT|PRISTINE|"
    r"AUTHENTIC|GRADE|POP|CERT|EDITION|1ST|UNLIMITED|SHADOWLESS)\b",
    re.IGNORECASE,
)
# OCR reads label caps badly: zero for O, one for I, five for S
_OCR_CONFUSIONS = str.maketrans({"0": "O", "1": "I", "5": "S", "8": "B"})


def _label_words(raw: str) -> str:
    """Undo OCR digit/letter confusions inside all-caps label words and split
    run-together tokens ("P0KEMONGAME" -> "POKEMON GAME")."""
    out = raw.translate(_OCR_CONFUSIONS)
    out = re.sub(r"[^A-Za-z\s'&.-]", " ", out)
    for word in ("POKEMON", "GAME", "SET", "SERIES", "HOLO"):
        out = re.sub(f"(?<=[A-Z]){word}", f" {word}", out)
    return re.sub(r"\s{2,}", " ", out).strip(" -.")


def parse_slab(texts: list) -> dict | None:
    """Detect a grading-company slab label from OCR'd text near the top of
    the image (company name + condition wording + cert number)."""
    top_texts = [t for t in texts if t["top"] < 0.30]
    joined = " ".join(t["text"] for t in top_texts)
    company = _SLAB_COMPANIES.search(joined)
    grade = _SLAB_GRADE.search(joined)
    if not company and not grade:
        return None
    # require at least a condition phrase plus either company or cert
    cert = _CERT_RE.search(joined)
    if not grade or not (company or cert):
        return None
    grade_text = grade.group(0).upper().strip()
    if not grade.group(2):
        # PSA prints the numeric grade huge, as its own line — prefer a
        # standalone number token over digits embedded in nearby set names
        standalone = next(
            (
                t["text"].strip()
                for t in top_texts
                if re.fullmatch(r"(10|9(?:\.5)?|[1-8](?:\.5)?)", t["text"].strip())
            ),
            None,
        )
        if standalone:
            grade_text = f"{grade_text} {standalone}"
    if company:
        raw_company = _COMPANY_ALIAS.get(company.group(1).upper(), company.group(1).upper())
    else:
        # company logo often doesn't OCR — cert length is a strong tell:
        # BGS certs run to 10 digits, PSA are 8-9
        raw_company = "BGS" if cert and len(cert.group(1)) == 10 else "PSA"
    # The label is the answer key: year + set + collector number identify a
    # graded card exactly, with no fuzzy name matching needed. Harvesting it
    # is the difference between "Charizard, some set" and one specific card.
    def _clean_label(raw: str) -> str:
        out = _LABEL_NOISE.sub(" ", _label_words(_YEAR_RE.sub(" ", raw)))
        return re.sub(r"\s{2,}", " ", out).strip(" -.")

    year = None
    set_line = None
    label_number = None
    for idx, t in enumerate(top_texts):
        raw = t["text"].strip()
        m = _YEAR_RE.search(raw)
        if m and year is None:
            year = m.group(1)
            rest = _clean_label(raw)
            if len(rest) >= 3:
                set_line = rest
            else:
                # PSA prints "1999 POKEMON GAME" as one line, BGS splits the
                # year onto its own — look ahead for the set on the next lines
                for nxt in top_texts[idx + 1 : idx + 3]:
                    txt = nxt["text"].strip()
                    if _LABEL_NUM_RE.search(txt) or _CERT_RE.fullmatch(txt.replace(" ", "")):
                        continue
                    cand = _clean_label(txt)
                    if len(cand) >= 4 and sum(ch.isalpha() for ch in cand) >= 4:
                        set_line = cand
                        break
        n = _LABEL_NUM_RE.search(raw)
        if n and label_number is None:
            label_number = n.group(1).lstrip("#").strip()

    # the name line: most alphabetic label text that isn't the set line,
    # the company, or condition wording
    label_name = None
    best_len = 0
    for t in top_texts:
        raw = t["text"].strip()
        if _YEAR_RE.search(raw) or _CERT_RE.fullmatch(raw.replace(" ", "")):
            continue
        # drop the "#100" prefix first: _label_words would read its digits
        # as letters ("100" -> "IOO") and glue them onto the name
        without_num = _LABEL_NUM_RE.sub(" ", raw)
        without_num = re.sub(r"^\s*\d{1,3}\b", " ", without_num)
        cleaned = _LABEL_NOISE.sub(" ", _label_words(without_num))
        cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" -.")
        alpha = sum(ch.isalpha() for ch in cleaned)
        if alpha >= 4 and alpha > best_len and cleaned.upper() != (set_line or "").upper():
            best_len = alpha
            label_name = cleaned

    return {
        "company": raw_company,
        "gradeText": grade_text,
        "certNumber": cert.group(1) if cert else None,
        "year": year,
        "setLine": set_line,
        "cardNumber": label_number,
        "name": label_name,
    }
# tokens that are card stats, not part of the name
_NAME_STOP = re.compile(r"\b(hp|ex|gx|v|vmax|vstar)\b\s*\d*$", re.IGNORECASE)


def _engine():
    global _ENGINE
    if _ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR

        _ENGINE = RapidOCR()
    return _ENGINE


def _clean_name(text: str) -> str:
    # strip HP values and stray digits that OCR merges into the title line
    text = re.sub(r"\b\d{2,4}\b", " ", text)
    text = re.sub(r"\bHP\b", " ", text, flags=re.IGNORECASE)
    # OCR often loses spaces between words: "MegaSlowbroex" -> "Mega Slowbro ex"
    text = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", text)
    # drop trailing 1-2 char fragments (mangled "ex"/"GX" logos)
    tokens = text.split()
    while tokens and len(tokens[-1]) <= 2:
        tokens.pop()
    text = " ".join(tokens) if tokens else text
    return re.sub(r"\s{2,}", " ", text).strip(" -–—.·")


def read_card_text(warped: np.ndarray) -> dict:
    h, w = warped.shape[:2]
    # normalize height for OCR: big enough to read, small enough to fit in
    # RAM on constrained machines (this box OOMs above ~1000px inference)
    target_h = 800
    if h != target_h:
        scale = target_h / h
        warped = cv2.resize(
            warped, (int(w * scale), target_h), interpolation=cv2.INTER_CUBIC
        )
        h, w = warped.shape[:2]

    empty = {
        "nameCandidates": [],
        "collectorNumber": None,
        "setCode": None,
        "slab": None,
        "texts": [],
        "language": "unknown",
        "japaneseTextDetected": False,
    }
    def _run(img):
        try:
            r, _ = _engine()(img)
            return r or []
        except Exception:
            # OCR can fail under memory pressure — free what we can, retry once
            import gc

            gc.collect()
            try:
                r, _ = _engine()(img)
                return r or []
            except Exception:
                return []

    result = _run(warped)
    # landscape-designed cards arrive rotated to portrait, making their text
    # vertical and unreadable — if the pass reads almost nothing, retry the
    # other orientation and keep whichever read more
    if sum(len(r[1]) for r in result) < 25:
        rotated = cv2.rotate(warped, cv2.ROTATE_90_COUNTERCLOCKWISE)
        alt = _run(rotated)
        if sum(len(r[1]) for r in alt) > sum(len(r[1]) for r in result):
            result = alt
            warped = rotated
            h, w = warped.shape[:2]
    if not result:
        return empty

    texts = []
    for box, text, score in result:
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        texts.append(
            {
                "text": text.strip(),
                "score": float(score),
                "top": float(min(ys) / h),
                "height": float((max(ys) - min(ys)) / h),
                "left": float(min(xs) / w),
            }
        )

    collector = None
    for t in texts:
        # collector number sits in the bottom band of the card
        if t["top"] > 0.80:
            m = COLLECTOR_RE.search(t["text"])
            if m:
                collector = f"{int(m.group(1)):03d}/{int(m.group(2)):03d}"
                break

    # set codes (e.g. OP07-109) identify the card exactly, even when the
    # name is printed in Japanese — search all read text
    set_code = None
    for t in texts:
        m = SET_CODE_RE.search(t["text"])
        if m:
            set_code = f"{m.group(1).upper()}-{m.group(2)}"
            break

    # name = prominent text in the top band, biggest glyphs first.
    # Filter card-frame furniture that outsizes the name on modern layouts:
    # HP values ("M360", "HP120"), evolution labels ("STAGE2", "BASIC").
    def _is_name_like(raw: str) -> bool:
        cleaned = _clean_name(raw)
        if len(cleaned) < 3:
            return False
        compact = re.sub(r"\s+", "", raw)
        digits = sum(ch.isdigit() for ch in compact)
        if digits / max(len(compact), 1) > 0.34:
            return False
        return not re.match(r"^(stage|basic|hp|lv)\W*\d*$", cleaned, re.IGNORECASE)

    top_band = [
        t
        for t in texts
        if t["top"] < 0.15 and t["score"] > 0.6 and _is_name_like(t["text"])
    ]
    top_band.sort(key=lambda t: t["height"], reverse=True)

    # not every game puts the name at the top (Top Trumps banners it mid-card,
    # sports cards often print it at the bottom): also consider unusually
    # large name-like text anywhere on the card
    tallest = top_band[0]["height"] if top_band else 0.0
    banners = [
        t
        for t in texts
        if 0.15 <= t["top"] < 0.92
        and t["score"] > 0.6
        and _is_name_like(t["text"])
        and t["height"] >= max(tallest, 0.02)
    ]
    banners.sort(key=lambda t: t["height"], reverse=True)

    names = []
    for t in top_band[:3] + banners[:2]:
        cleaned = _clean_name(t["text"])
        if cleaned and cleaned.lower() not in [n.lower() for n in names]:
            names.append(cleaned)

    all_text = " ".join(t["text"] for t in texts)
    # kana is unambiguous Japanese; CJK ideographs also appear when the OCR
    # model reads kana/kanji as Chinese glyphs, so both count as evidence
    japanese = bool(re.search(r"[぀-ヿ一-鿿]", all_text))
    latin = len(re.findall(r"[A-Za-z]", all_text))
    cjk = len(re.findall(r"[぀-ヿ一-鿿]", all_text))
    language = "ja" if cjk > latin * 0.5 else ("en" if latin > 0 else "unknown")

    return {
        "nameCandidates": names,
        "collectorNumber": collector,
        "setCode": set_code,
        "slab": parse_slab(texts),
        "texts": [t["text"] for t in texts],
        "language": language,
        "japaneseTextDetected": japanese,
    }
