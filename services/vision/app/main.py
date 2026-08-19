import base64
import json

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from .pipeline import run_pipeline
from .pipeline.match import dhash, fetch_image, similarity

app = FastAPI(title="grailcard-vision", version="0.1.0")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "vision"}


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    kind: str = Form("front"),
    include_images: bool = Form(True),
) -> dict:
    raw = await file.read()
    data = np.frombuffer(raw, np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=422, detail="could not decode image")
    # card text (name, collector number) is printed on the front only
    return run_pipeline(image, include_images=include_images, read_text=kind == "front")


@app.post("/similarity")
async def visual_similarity(
    imageB64: str = Form(...),
    urls: str = Form(...),  # JSON array of candidate image URLs
) -> dict:
    img = cv2.imdecode(
        np.frombuffer(base64.b64decode(imageB64), np.uint8), cv2.IMREAD_COLOR
    )
    if img is None:
        raise HTTPException(status_code=422, detail="could not decode image")
    reference = dhash(img)

    scores = []
    for url in json.loads(urls)[:6]:
        candidate = fetch_image(url)
        scores.append(
            {
                "url": url,
                "similarity": similarity(reference, dhash(candidate))
                if candidate is not None
                else None,
            }
        )
    return {"scores": scores}
