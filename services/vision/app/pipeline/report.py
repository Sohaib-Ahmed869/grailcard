"""Pipeline orchestration: detect -> gate -> measure -> assemble the
VisionAnalyzeResponse (camelCase, mirrors packages/shared)."""

import base64
from dataclasses import asdict

import cv2
import numpy as np

from .authenticity import digital_source_check
from .centering import measure_centering
from .detect import detect_card
from .grade import compute_grade
from .identify import read_card_text
from .quality import run_gate


def _b64_png(image: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("png encode failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _quality_dict(q) -> dict:
    return {
        "blurScore": q.blur_score,
        "glarePct": q.glare_pct,
        "glareRegions": q.glare_regions,
        "cardAreaPct": q.card_area_pct,
        "resolutionOk": q.resolution_ok,
        "lowDetail": q.low_detail,
    }


def run_pipeline(
    image: np.ndarray, include_images: bool = True, read_text: bool = True
) -> dict:
    det = detect_card(image)
    gate = run_gate(det, image.shape)

    # identification hints need far less resolution than grading, so a
    # rejected scan can still tell the user which card we saw
    ocr = read_card_text(det.warped) if (det is not None and read_text) else None

    if gate.rejection is not None:
        return {
            "ok": False,
            "quality": _quality_dict(gate.quality) if det is not None else None,
            "rejection": gate.rejection,
            "measurement": None,
            "grade": None,
            "authenticity": digital_source_check(det.warped) if det is not None else None,
            "ocr": ocr,
            "warpedImageB64": _b64_png(det.warped) if include_images and det else None,
            "overlayImageB64": None,
        }

    cen = measure_centering(det.warped)
    grade = compute_grade(det.warped, cen, low_detail=gate.quality.low_detail)
    sub = lambda s: {"value": s.value, "confidence": s.confidence} if s else None
    grade_dict = {
        "overall": grade.overall,
        "band": {"low": grade.band_low, "high": grade.band_high},
        "subgrades": {
            "centering": sub(grade.centering),
            "corners": sub(grade.corners),
            "edges": sub(grade.edges),
            "surface": sub(grade.surface),
        },
        "findings": grade.findings,
        "method": "heuristic-v0",
        "notes": grade.notes,
    }

    # draw detected surface marks on the overlay so findings are visible
    oh, ow = cen.overlay.shape[:2]
    for c in grade.findings.get("clusters", []):
        x0, y0 = int(c["x"] * ow), int(c["y"] * oh)
        x1, y1 = x0 + max(int(c["w"] * ow), 6), y0 + max(int(c["h"] * oh), 6)
        cv2.rectangle(cen.overlay, (x0 - 4, y0 - 4), (x1 + 4, y1 + 4), (60, 60, 235), 2)
    measurement = {
        "centering": {
            "front": {"lr": cen.lr, "tb": cen.tb, "measurable": cen.measurable},
            "back": None,
            "passesAt": {"psa10": cen.passes_psa10, "psa9": cen.passes_psa9},
            "overlayImageKey": None,  # set by the API when it stores the overlay
        },
        "confidence": {"centering": cen.confidence},
    }
    return {
        "ok": True,
        "quality": _quality_dict(gate.quality),
        "rejection": None,
        "measurement": measurement,
        "grade": grade_dict,
        "authenticity": digital_source_check(det.warped),
        "ocr": ocr,
        "warpedImageB64": _b64_png(det.warped) if include_images else None,
        "overlayImageB64": _b64_png(cen.overlay) if include_images else None,
    }
