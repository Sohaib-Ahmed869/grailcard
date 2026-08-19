# Grailcard

Card grading that tells the truth about what it knows. Guided capture, a quality
gate that refuses bad input, and a deterministic centering **measurement** —
not a model opinion.

## Layout

```
apps/web          Next.js PWA — capture/upload flow, scan report
apps/api          NestJS — scans, storage, orchestration (SQLite + local disk for M1)
services/vision   Python FastAPI — all computer vision (OpenCV). Stateless.
packages/shared   Scan contract: Zod schemas shared by web + api
```

## Quick start

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
```

Boots vision (:8100), api (:8180), web (:3000) in separate windows.
Keys live in `apps/api/.env` (XIMILAR_API_KEY, GEMINI_API_KEY, PPT_API_KEY).

## Run locally (manual — no Docker needed)

```sh
# 1. vision service (Python 3.12)
cd services/vision
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
cd ../..
npm run dev:vision          # -> http://localhost:8100

# 2. install JS deps once
npm install

# 3. api + web
npm run dev:api             # -> http://localhost:8180
npm run dev:web             # -> http://localhost:3000
```

Open http://localhost:3000, upload a card photo, get a report.

## Tests

```sh
npm run test:vision   # golden-fixture suite for the CV pipeline
```

## Pipeline (vision service)

1. **detect** — find the card quad, perspective-warp to canonical 750x1050
2. **quality gate** — blur (Laplacian variance), glare (specular clusters),
   resolution. Fails -> scan is REJECTED with a user-facing retry hint, no charge.
3. **centering** — gradient-profile scan finds the inner print border on each
   side; ratios are pure pixel arithmetic, returned with an annotated overlay.
