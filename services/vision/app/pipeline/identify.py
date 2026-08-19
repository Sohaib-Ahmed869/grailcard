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

_SLAB_COMPANIES = re.compile(r"\b(PSA|BGS|CGC|SGC|TAG|AGS)\b", re.IGNORECASE)
_SLAB_GRADE = re.compile(
    r"\b(GEM\s*M(?:IN)?T|MINT|NM[-\s]?MT|NM|EX[-\s]?MT|PRISTINE)\b\s*(10|9(?:\.5)?|[1-8](?:\.5)?)?\b",
    re.IGNORECASE,
)
_CERT_RE = re.compile(r"\b(\d{7,9})\b")


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
    return {
        "company": company.group(1).upper() if company else "PSA",
        "gradeText": grade_text,
        "certNumber": cert.group(1) if cert else None,
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
    try:
        result, _ = _engine()(warped)
    except Exception:
        # OCR can fail under memory pressure — free what we can and retry
        # once before degrading to "unknown card" (grading still completes)
        import gc

        gc.collect()
        try:
            result, _ = _engine()(warped)
        except Exception:
            return empty
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

    # not every game puts the name at the top (Top Trumps banners it mid-card):
    # also consider unusually large name-like text in the upper 60%
    tallest = top_band[0]["height"] if top_band else 0.0
    banners = [
        t
        for t in texts
        if 0.15 <= t["top"] < 0.60
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
