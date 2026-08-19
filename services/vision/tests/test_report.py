import base64

import cv2
import numpy as np

from app.pipeline import run_pipeline
from synth import make_card_photo


def test_full_pipeline_contract():
    result = run_pipeline(make_card_photo(lr=60, tb=45))
    assert result["ok"] is True
    assert result["rejection"] is None

    q = result["quality"]
    assert set(q) == {
        "blurScore",
        "glarePct",
        "glareRegions",
        "cardAreaPct",
        "resolutionOk",
        "lowDetail",
    }

    front = result["measurement"]["centering"]["front"]
    assert front["measurable"] is True
    assert abs(front["lr"] - 60) <= 3.0

    for key in ("warpedImageB64", "overlayImageB64"):
        raw = base64.b64decode(result[key])
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        assert img is not None and img.shape == (1050, 750, 3)


def test_rejection_contract():
    result = run_pipeline(make_card_photo(blur_sigma=6.0))
    assert result["ok"] is False
    assert result["measurement"] is None
    assert result["rejection"]["reason"] == "too_blurry"
    assert result["rejection"]["retryHint"]
