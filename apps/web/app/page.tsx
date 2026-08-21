"use client";

import { useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8180";

type SideCentering = { lr: number; tb: number; measurable: boolean };
type Scan = {
  id: string;
  status: string;
  createdAt: string;
  rejection?: { reason: string; userMessage: string; retryHint: string } | null;
  backRejection?: { reason: string; userMessage: string; retryHint: string } | null;
  measurement?: {
    centering: {
      front: SideCentering;
      back?: SideCentering | null;
      passesAt: { psa10: boolean; psa9: boolean };
      overlayImageKey?: string | null;
    };
    confidence: { centering: number };
  } | null;
  grade?: {
    overall: number;
    band: { low: number; high: number };
    subgrades: {
      centering?: { value: number; confidence: number } | null;
      corners?: { value: number; confidence: number } | null;
      edges?: { value: number; confidence: number } | null;
      surface: { value: number; confidence: number };
    };
    findings?: {
      scratchesDetected: boolean;
      clusterCount: number;
      clusters: { x: number; y: number; w: number; h: number; areaPx: number }[];
      defectFrac: number;
    } | null;
    method: string;
    notes: string[];
  } | null;
  authenticity?: { digitalLikely: boolean; noiseFloor: number } | null;
  origin?: {
    language: "en" | "ja" | "unknown";
    japaneseTextDetected: boolean;
    note: string;
  } | null;
  recommendation?: {
    verdict: "grade" | "dont_grade" | "insufficient_data";
    reasoning: string;
    gradingCost: number;
    rawValue?: number | null;
    likelyGrade?: string | null;
    rows: { grade: string; value?: number | null; net?: number | null; inBand: boolean }[];
  } | null;
  identification?: {
    cardId: string;
    name: string;
    setName: string;
    localId: string;
    rarity?: string | null;
    imageUrl?: string | null;
    matchScore: number;
    ocrName: string;
    game?: string;
  } | null;
  ocrNames?: string[] | null;
  summary?: string | null;
  slab?: {
    company: string;
    gradeText: string;
    certNumber?: string | null;
    verifyUrl?: string | null;
  } | null;
  related?:
    | {
        name: string;
        localId: string;
        imageUrl?: string | null;
        price?: number | null;
        unit: string;
      }[]
    | null;
  valuation?: {
    updatedAt?: string | null;
    graded?: {
      source: string;
      psa8?: number | null;
      psa9?: number | null;
      psa10?: number | null;
      estimated?: boolean;
      citations?: { label: string; url: string }[] | null;
    } | null;
    webEstimate?: {
      value: number;
      sampleSize: number;
      citations: { label: string; url: string }[];
    } | null;
    tcgplayer?: {
      unit: string;
      variant: string;
      low?: number | null;
      mid?: number | null;
      high?: number | null;
      market?: number | null;
    } | null;
    cardmarket?: {
      unit: string;
      low?: number | null;
      trend?: number | null;
      avg30?: number | null;
    } | null;
    conditionAdjusted?: { value: number; multiplier: number } | null;
  } | null;
};

type PulseCard = {
  label: string;
  setName: string;
  game: string;
  price?: number | null;
  change24h?: number | null;
  change7d?: number | null;
  low7?: number | null;
  high7?: number | null;
  spark: number[];
};

function TickerItems({ cards }: { cards: PulseCard[] }) {
  return (
    <>
      {cards.map((c, i) => {
        const chg = c.change7d ?? c.change24h;
        const up = (chg ?? 0) >= 0;
        return (
          <span className="htick" key={c.label + i}>
            <b>{c.label}</b>
            {c.price != null && <span className="htick-price">${c.price.toFixed(2)}</span>}
            {chg != null && (
              <span className={up ? "up-text" : "down-text"}>
                {up ? "▲" : "▼"}{Math.abs(chg).toFixed(1)}%
              </span>
            )}
          </span>
        );
      })}
    </>
  );
}

function MarketTicker() {
  const [cards, setCards] = useState<PulseCard[]>([]);
  useEffect(() => {
    fetch(`${API}/market/pulse`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setCards)
      .catch(() => {});
  }, []);
  if (cards.length === 0) return <div className="hticker" />;
  return (
    <div className="hticker">
      <span className="label-mono accent-text">· MARKET</span>
      <div className="hticker-clip">
        <div className="hticker-track">
          <TickerItems cards={cards} />
          <TickerItems cards={cards} />
        </div>
      </div>
    </div>
  );
}

type NewsItem = { title: string; source: string; link: string; publishedAt: string };

function timeAgo(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

function NewsLineItems({ items }: { items: NewsItem[] }) {
  return (
    <>
      {items.map((n, i) => (
        <a className="newsline-item" href={n.link} target="_blank" rel="noreferrer" key={n.link + i}>
          <span className="news-source">{n.source}</span>
          {n.title.replace(/ - [^-]+$/, "")}
          <span className="muted small">{timeAgo(n.publishedAt)}</span>
        </a>
      ))}
    </>
  );
}

function NewsLine() {
  const [items, setItems] = useState<NewsItem[]>([]);
  useEffect(() => {
    fetch(`${API}/market/news`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setItems)
      .catch(() => {});
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="newsline">
      <span className="label-mono violet-text">HOBBY WIRE</span>
      <div className="newsline-clip">
        <div className="newsline-track">
          <NewsLineItems items={items} />
          <NewsLineItems items={items} />
        </div>
      </div>
      <span className="label-mono muted">{items.length} stories</span>
    </div>
  );
}

function BandTrack({ overall, band }: { overall: number; band: { low: number; high: number } }) {
  const pos = (v: number) => `${((v - 1) / 9) * 100}%`;
  return (
    <div className="band-track-wrap">
      <div className="band-track">
        <div
          className="band-track-band"
          style={{ left: pos(band.low), width: `calc(${pos(band.high)} - ${pos(band.low)})` }}
        />
        <div className="band-track-dot" style={{ left: pos(overall) }} />
      </div>
      <div className="band-track-labels label-mono">
        <span>1</span>
        <span>5</span>
        <span>10</span>
      </div>
    </div>
  );
}

function CritCard({
  label,
  sub,
  note,
}: {
  label: string;
  sub?: { value: number; confidence: number } | null;
  note?: string;
}) {
  return (
    <div className="crit-card">
      <div className="crit-head">
        <span className="crit-label">{label}</span>
        <span
          className="crit-value"
          style={{ color: sub ? gradeColor(sub.value) : "var(--muted)" }}
        >
          {sub ? sub.value.toFixed(1) : "not measurable"}
        </span>
      </div>
      {sub ? (
        <>
          <div className="crit-bar">
            <div
              style={{
                width: `${(sub.value / 10) * 100}%`,
                background: gradeColor(sub.value),
              }}
            />
          </div>
          <div className="muted small">
            {(sub.confidence * 100).toFixed(0)}% confidence{note ? ` · ${note}` : ""}
          </div>
        </>
      ) : (
        <div className="muted small">{note ?? "—"}</div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const saved = (localStorage.getItem("gc-theme") as "dark" | "light") || "dark";
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
  }, []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("gc-theme", next);
  };
  return (
    <button className="theme-toggle" onClick={flip}>
      {theme === "dark" ? "☀ Light" : "☾ Dark"}
    </button>
  );
}

const SCAN_STEPS = [
  "Detecting card…",
  "Checking photo quality…",
  "Measuring borders…",
  "Reading card text…",
  "Matching catalog…",
  "Fetching market prices…",
];

let fxPromise: Promise<number> | null = null;
function useAud(): number | null {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    fxPromise ??= fetch(`${API}/market/fx`)
      .then((r) => (r.ok ? r.json() : { usdToAud: null }))
      .then((b) => b.usdToAud ?? 1.5)
      .catch(() => 1.5);
    fxPromise.then(setRate);
  }, []);
  return rate;
}

function Money({ v, aud, unit = "USD" }: { v?: number | null; aud: number | null; unit?: string }) {
  if (v == null) return <>—</>;
  const main = unit === "USD" ? `$${v.toFixed(2)}` : `€${v.toFixed(2)}`;
  return (
    <>
      {main}
      {unit === "USD" && aud != null && (
        <span className="muted small"> · A${(v * aud).toFixed(v * aud >= 100 ? 0 : 2)}</span>
      )}
    </>
  );
}

function money(v: number | null | undefined, unit: string) {
  if (v == null) return "—";
  return unit === "USD" ? `$${v.toFixed(2)}` : `€${v.toFixed(2)}`;
}

function CaptureSlot({
  label,
  required,
  file,
  onPick,
  scanning,
}: {
  label: string;
  required?: boolean;
  file: File | null;
  onPick: (f: File) => void;
  scanning: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="slot">
      <div className="slot-label label-mono">
        {label} · {required ? "required" : "optional"}
      </div>
      <div
        className={`scan-frame${scanning ? " scanning" : ""}`}
        onClick={() => !scanning && inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f && !scanning) onPick(f);
        }}
      >
        <span className="bracket" />
        {preview ? <img src={preview} alt={label} /> : <span>Drop or tap to add the {label.toLowerCase()} photo</span>}
        {scanning && preview && <div className="scanline" />}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
          }}
        />
      </div>
    </div>
  );
}

function CenteringBlock({ title, c }: { title: string; c: SideCentering }) {
  return (
    <div>
      <div className="muted">{title}</div>
      {c.measurable ? (
        <div className="centering-pair">
          <CenteringDiagram c={c} />
          <div>
            <div className="muted small">L / R</div>
            <div className="ratios">
              {c.lr.toFixed(0)}/{(100 - c.lr).toFixed(0)}
            </div>
          </div>
          <div>
            <div className="muted small">T / B</div>
            <div className="ratios">
              {c.tb.toFixed(0)}/{(100 - c.tb).toFixed(0)}
            </div>
          </div>
        </div>
      ) : (
        <p className="muted">
          No printed border to measure against (borderless / full-art) — we won&apos;t guess.
        </p>
      )}
    </div>
  );
}

function Viewer({ scan }: { scan: Scan }) {
  const [side, setSide] = useState<"front" | "back">("front");
  const [mode, setMode] = useState<"overlay" | "warped">("overlay");
  const [grid, setGrid] = useState(false);
  const hasBack = !!scan.measurement?.centering.back;
  const key = `${scan.id}/${side}_${mode === "overlay" ? "overlay" : "warped"}.png`;

  return (
    <div className="viewer" id="detection">
      <div className="viewer-tabs">
        <button className={mode === "overlay" ? "active" : ""} onClick={() => setMode("overlay")}>
          Detection lines
        </button>
        <button className={mode === "warped" ? "active" : ""} onClick={() => setMode("warped")}>
          Original
        </button>
        <button className={grid ? "active" : ""} onClick={() => setGrid((v) => !v)}>
          Grid
        </button>
        {hasBack && (
          <>
            <button className={side === "front" ? "active" : ""} onClick={() => setSide("front")}>
              Front
            </button>
            <button className={side === "back" ? "active" : ""} onClick={() => setSide("back")}>
              Back
            </button>
          </>
        )}
      </div>
      <div className="viewer-stage">
        <img src={`${API}/storage/${key}`} alt="scan" />
        {grid && <div className="measure-grid" />}
      </div>
      {mode === "overlay" && (
        <div className="muted small" style={{ marginTop: 6, lineHeight: 1.5 }}>
          <span style={{ color: "#28dcc8" }}>■</span> measured border lines &amp; points ·{" "}
          <span style={{ color: "#eb3c3c" }}>■</span> surface marks (scratches / print lines) ·{" "}
          <span style={{ color: "#3cc850" }}>●</span>/<span style={{ color: "#ebc83c" }}>●</span>/
          <span style={{ color: "#eb3c3c" }}>●</span> corner condition rings (score below each)
        </div>
      )}
    </div>
  );
}

function gradeColor(v: number) {
  if (v >= 9) return "#2fbf71";
  if (v >= 7) return "#4da3ff";
  if (v >= 5) return "#e8a13c";
  return "#e05252";
}


function GradePanel({ scan }: { scan: Scan }) {
  const g = scan.grade;
  const aud = useAud();
  const v = scan.valuation;
  // what THIS copy is plausibly worth as-is, best source first
  const asIs =
    v?.conditionAdjusted?.value ??
    v?.tcgplayer?.market ??
    v?.cardmarket?.trend ??
    v?.webEstimate?.value ??
    null;
  // and what it becomes in a slab, at the grade we actually expect
  const likely = scan.recommendation?.likelyGrade ?? null;
  const likelyValue =
    scan.recommendation?.rows?.find((r) => r.grade === likely)?.value ?? null;
  // an already-slabbed card's value IS its graded value — raw prices are the
  // wrong number for it, and conditionAdjusted is deliberately nulled upstream
  const slabNum = scan.slab ? Number(scan.slab.gradeText.match(/(\d+(?:\.\d)?)\s*$/)?.[1]) : NaN;
  const slabValue =
    scan.slab && v?.graded && Number.isFinite(slabNum)
      ? (slabNum >= 9.5 ? v.graded.psa10 : slabNum >= 9 ? v.graded.psa9 : v.graded.psa8) ?? null
      : null;
  // every price on this page is ours unless a feed verified it
  const priceIsEstimate =
    v?.conditionAdjusted != null || v?.webEstimate != null || (v?.graded?.estimated ?? false);
  if (!g) return null;
  const critNote = (key: "centering" | "corners" | "edges") => {
    if (g.subgrades[key]) return undefined;
    return key === "centering"
      ? "No printed border on this design — we don't guess."
      : "Art runs to the edge — no border stock to judge.";
  };
  return (
    <div className="panel verdict">
      {scan.status === "rejected" && (
        <div style={{ marginBottom: 12 }}>
          <span className="badge warn">provisional — photo failed the quality gate</span>
          <span className="muted small"> a rough impression only; re-shoot for a real grade</span>
        </div>
      )}
      <div className="verdict-head">
        <div>
          <div className="label-mono accent-text">GC ESTIMATE</div>
          <div className="gc-num" style={{ color: gradeColor(g.overall) }}>
            {g.overall.toFixed(1)}
          </div>
        </div>
        {(slabValue ?? asIs) != null && (
          <div className="gc-value">
            <div className="label-mono">ESTIMATED VALUE</div>
            <div className="gc-price">
              <Money v={slabValue ?? asIs} aud={aud} />
            </div>
            <div className="muted small">
              {slabValue != null
                ? `in its ${scan.slab!.company} ${scan.slab!.gradeText} slab`
                : v?.conditionAdjusted
                  ? `this copy, raw, at grade ${g.overall.toFixed(1)}`
                  : "near-mint market price"}
              {slabValue != null && asIs != null && (
                <>
                  {" · "}
                  <b style={{ color: "var(--text)" }}>${asIs.toFixed(2)}</b> raw
                </>
              )}
              {slabValue == null && likelyValue != null && likely && (
                <>
                  {" · "}
                  <b style={{ color: "var(--text)" }}>
                    {likely} ${likelyValue.toFixed(2)}
                  </b>{" "}
                  if graded
                </>
              )}
            </div>
            {priceIsEstimate && (
              <div className="gc-price-note">
                <span className="badge warn">estimated</span>
                <span>from system data — not a pricing API</span>
              </div>
            )}
          </div>
        )}
        <div className="verdict-side">
          <p className="muted" style={{ margin: 0 }}>
            Honest band <b style={{ color: "var(--text)" }}>{g.band.low.toFixed(1)} – {g.band.high.toFixed(1)}</b>.
            The band is the claim; the number is its midpoint.
          </p>
          <BandTrack overall={g.overall} band={g.band} />
          {scan.authenticity?.digitalLikely && (
            <span className="badge warn">possible digital image</span>
          )}
        </div>
      </div>
      <div className="crit-grid">
        <CritCard
          label="Surface"
          sub={g.subgrades.surface}
          note={
            g.findings?.scratchesDetected
              ? `${g.findings.clusterCount} marks flagged`
              : "no marks above threshold"
          }
        />
        <CritCard label="Corners" sub={g.subgrades.corners} note={critNote("corners")} />
        <CritCard label="Centering" sub={g.subgrades.centering} note={critNote("centering")} />
        <CritCard label="Edges" sub={g.subgrades.edges} note={critNote("edges")} />
      </div>
      {scan.status !== "rejected" && (
        <a className="see-detection" href="#detection">
          See detection view
        </a>
      )}
      {scan.summary && (
        <p style={{ margin: "14px 0 8px", lineHeight: 1.65 }}>{scan.summary}</p>
      )}
      <FindingsLine scan={scan} />
      {g.notes.map((n) => (
        <div key={n} className="muted small">
          {n}
        </div>
      ))}
    </div>
  );
}

function CenteringDiagram({ c }: { c: SideCentering }) {
  const W = 110;
  const H = 154;
  const bx = 26;
  const by = 30;
  const left = (bx * c.lr) / 100;
  const top = (by * c.tb) / 100;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="centering-diagram">
      <rect x={1} y={1} width={W - 2} height={H - 2} rx={6} fill="var(--panel-2)" stroke="var(--track-strong)" strokeWidth={1.5} />
      <line x1={W / 2} y1={4} x2={W / 2} y2={H - 4} stroke="var(--track)" strokeDasharray="3 4" />
      <line x1={4} y1={H / 2} x2={W - 4} y2={H / 2} stroke="var(--track)" strokeDasharray="3 4" />
      <rect
        x={1 + left}
        y={1 + top}
        width={W - 2 - bx}
        height={H - 2 - by}
        rx={3}
        fill="var(--radar-fill)"
        stroke="var(--accent)"
        strokeWidth={1.5}
      />
    </svg>
  );
}

const GAME_LABELS: Record<string, string> = {
  pokemon: "Pokémon TCG",
  mtg: "Magic: The Gathering",
  yugioh: "Yu-Gi-Oh!",
  onepiece: "One Piece TCG",
  lorcana: "Disney Lorcana",
  digimon: "Digimon Card Game",
  starwars: "Star Wars: Unlimited",
  sports: "Sports card",
  unionarena: "Union Arena",
  dragonball: "Dragon Ball Fusion",
  gundam: "Gundam Card Game",
  riftbound: "Riftbound",
  other: "Other card",
};

function IdentityPanel({ scan }: { scan: Scan }) {
  const idn = scan.identification;
  if (!idn) {
    const read = (scan.ocrNames ?? []).filter(Boolean);
    return (
      <div className="panel">
        <span className="badge warn">card not identified</span>
        {read.length > 0 ? (
          <p className="muted">
            We read <b style={{ color: "var(--text)" }}>{read.map((n) => `“${n}”`).join(", ")}</b>{" "}
            off the card, but found no match in the catalogs we support — Pokémon TCG, Magic:
            The Gathering, Yu-Gi-Oh!, and One Piece. If this card is from another game (sports
            cards, Top Trumps, Lorcana…), it isn&apos;t in our database yet.
          </p>
        ) : (
          <p className="muted">
            We couldn&apos;t read enough text off this photo to search the catalog. A closer,
            sharper shot of the card name usually fixes this.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="panel identity">
      {idn.imageUrl && <img src={idn.imageUrl} alt={idn.name} />}
      <div>
        <h2>{idn.name}</h2>
        <div className="muted">
          {idn.game && (
            <span className="badge info" style={{ marginRight: 6 }}>
              {GAME_LABELS[idn.game] ?? idn.game}
            </span>
          )}
          {idn.setName} · #{idn.localId}
          {idn.rarity ? ` · ${idn.rarity}` : ""}
        </div>
        {scan.origin && (
          <div style={{ marginTop: 6 }}>
            <span className={`badge ${scan.origin.japaneseTextDetected ? "info" : "pass"}`}>
              {scan.origin.japaneseTextDetected
                ? "Japanese print"
                : scan.origin.language === "en"
                  ? "English print"
                  : "language unknown"}
            </span>
            <span className="muted small"> {scan.origin.note}</span>
          </div>
        )}
        <div className="muted small" style={{ marginTop: 4 }}>
          Identification is not authentication — we cannot detect counterfeits or
          reprints. High-value cards should be authenticated by a grading company.
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          {idn.cardId === "llm" ? (
            <>
              Identified by AI vision (world knowledge) — not catalog-verified, so treat the
              set/edition as a strong guess and there&apos;s no market data attached.
            </>
          ) : idn.cardId === "described" ? (
            <>
              Described from the card&apos;s own text — this card isn&apos;t in any catalog we
              support (Pokémon, Magic, Yu-Gi-Oh!, One Piece), so there&apos;s no market data
              for it.
            </>
          ) : (
            <>
              Read from card: “{idn.ocrName}” · match {(idn.matchScore * 100).toFixed(0)}%
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RecommendationPanel({ scan }: { scan: Scan }) {
  const r = scan.recommendation;
  const aud = useAud();
  if (!r) return null;
  const verdictBadge =
    r.verdict === "grade" ? (
      <span className="badge pass" style={{ fontSize: 16, padding: "6px 16px" }}>
        GRADE IT
      </span>
    ) : r.verdict === "dont_grade" ? (
      <span className="badge fail" style={{ fontSize: 16, padding: "6px 16px" }}>
        DON&apos;T GRADE IT
      </span>
    ) : (
      <span className="badge warn" style={{ fontSize: 16, padding: "6px 16px" }}>
        NOT ENOUGH DATA
      </span>
    );
  return (
    <div className="panel">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        {verdictBadge}
        {r.likelyGrade && (
          <span className="muted">
            most likely outcome: <b style={{ color: "var(--text)" }}>{r.likelyGrade}</b>
          </span>
        )}
      </div>
      <p style={{ margin: "6px 0 10px" }}>{r.reasoning}</p>
      <table className="rec-table">
        <thead>
          <tr>
            <th>If it grades</th>
            <th>Sells for</th>
            <th>Net after costs</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row) => (
            <tr key={row.grade} className={row.inBand ? "in-band" : ""}>
              <td>{row.grade}</td>
              <td><Money v={row.value} aud={aud} /></td>
              <td
                style={{
                  color:
                    row.net == null
                      ? undefined
                      : row.net >= 0
                        ? "var(--green)"
                        : "var(--red)",
                  fontWeight: 700,
                }}
              >
                {row.net != null
                  ? `${row.net >= 0 ? "+" : "−"}$${Math.abs(row.net).toFixed(2)}`
                  : "—"}
              </td>
              <td className="muted small">{row.inBand ? "in your grade band" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted small">
        Assumes ${r.gradingCost} grading cost
        {r.rawValue != null && <> · raw value ${r.rawValue.toFixed(2)}</>} · graded prices are
        eBay sales averages
      </div>
    </div>
  );
}

function FindingsLine({ scan }: { scan: Scan }) {
  const f = scan.grade?.findings;
  if (!f) return null;
  return (
    <div className="muted small" style={{ marginTop: 6 }}>
      {f.scratchesDetected ? (
        <>
          <span className="badge warn">
            {f.clusterCount} surface mark{f.clusterCount === 1 ? "" : "s"} flagged
          </span>{" "}
          possible scratches / print lines — boxed in red on the Detection lines view
          ({(f.defectFrac * 100).toFixed(2)}% of the face affected)
        </>
      ) : (
        <>
          <span className="badge pass">no scratches detected</span> no surface marks above
          the detection threshold on this photo
        </>
      )}
    </div>
  );
}

function ebaySoldUrl(query: string) {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`;
}

function EbayComps({ scan }: { scan: Scan }) {
  const idn = scan.identification;
  if (!idn) return null;
  const base = [idn.name, idn.setName, idn.localId].filter(Boolean).join(" ");
  return (
    <div className="panel">
      <div className="muted" style={{ marginBottom: 6 }}>
        eBay sold listings <span className="small">(real completed sales — the ground truth)</span>
      </div>
      {!scan.valuation && (
        <p className="muted small" style={{ margin: "0 0 8px" }}>
          No price database covers this card&apos;s game — these sold listings are the best
          pricing that exists for it, from any tool.
        </p>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <a className="ebay-link" href={ebaySoldUrl(base)} target="_blank" rel="noreferrer">
          Raw sold listings →
        </a>
        <a className="ebay-link" href={ebaySoldUrl(`${base} PSA`)} target="_blank" rel="noreferrer">
          PSA graded sold →
        </a>
        <a className="ebay-link" href={ebaySoldUrl(`${base} PSA 10`)} target="_blank" rel="noreferrer">
          PSA 10 sold →
        </a>
      </div>
    </div>
  );
}

/** Any price we produced ourselves says so, in plain words, right next to the
 *  number — never a bare figure the user could mistake for a market feed. */
function EstimateNote({ source }: { source: string }) {
  const text =
    source === "web-search"
      ? "Estimated from system data — read off public web pages by our own lookup, not a pricing API. Each figure was re-checked against the page it came from; confirm via the sources before acting."
      : source === "cardgrader"
        ? "Estimated from system data — a third-party model's comps, not a pricing API. Confirm with the eBay sold links before acting."
        : "Estimated from system data — our own multiples off the raw price, not a pricing API. Treat it as a ballpark and confirm with the eBay sold links below.";
  return (
    <div className="est-note">
      <span className="badge warn">estimated</span>
      <span>{text}</span>
    </div>
  );
}

function Sources({ items }: { items?: { label: string; url: string }[] | null }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="est-sources small">
      <span className="muted small">sources: </span>
      {items.map((c) => (
        <a key={c.url} href={c.url} target="_blank" rel="noreferrer">
          {c.label}
        </a>
      ))}
    </div>
  );
}

function ValuationPanel({ scan }: { scan: Scan }) {
  const v = scan.valuation;
  const aud = useAud();
  if (!v) return null;
  return (
    <div className="panel">
      <div className="muted" style={{ marginBottom: 6 }}>
        Market value <span className="small">(raw / ungraded · USD, AUD approx)</span>
      </div>
      {v.tcgplayer && (
        <>
          <div className="price-row">
            <span>TCGplayer market ({v.tcgplayer.variant})</span>
            <span className="v"><Money v={v.tcgplayer.market} aud={aud} /></span>
          </div>
          <div className="price-row">
            <span>TCGplayer low – high</span>
            <span className="v">
              {money(v.tcgplayer.low, v.tcgplayer.unit)} – {money(v.tcgplayer.high, v.tcgplayer.unit)}
            </span>
          </div>
        </>
      )}
      {v.cardmarket && (
        <>
          <div className="price-row">
            <span>Cardmarket trend</span>
            <span className="v">{money(v.cardmarket.trend, v.cardmarket.unit)}</span>
          </div>
          <div className="price-row">
            <span>Cardmarket 30-day avg</span>
            <span className="v">{money(v.cardmarket.avg30, v.cardmarket.unit)}</span>
          </div>
        </>
      )}
      {v.webEstimate && (
        <div className="price-row">
          <span>
            Raw, read from web sources{" "}
            <span className="muted small">
              ({v.webEstimate.sampleSize} verified {v.webEstimate.sampleSize === 1 ? "figure" : "figures"})
            </span>
          </span>
          <span className="v"><Money v={v.webEstimate.value} aud={aud} /></span>
        </div>
      )}
      {v.webEstimate && !v.graded && (
        <>
          <EstimateNote source="web-search" />
          <Sources items={v.webEstimate.citations} />
        </>
      )}
      {v.conditionAdjusted && (
        <div className="price-row" style={{ background: "rgba(77,163,255,0.06)" }}>
          <span>
            <b>This copy, in its estimated condition</b>{" "}
            <span className="muted small">(× {v.conditionAdjusted.multiplier} of NM)</span>
          </span>
          <span className="v" style={{ color: "var(--accent)" }}>
            <Money v={v.conditionAdjusted.value} aud={aud} />
          </span>
        </div>
      )}
      {v.graded && (
        <>
          <div className="muted" style={{ margin: "12px 0 6px" }}>
            Graded value{" "}
            <span className="small">
              {v.graded.estimated
                ? v.graded.source === "cardgrader"
                  ? "(third-party estimate — CardGrader comps)"
                  : v.graded.source === "web-search"
                    ? "(read from public web pages, verified against source)"
                    : "(estimated from raw price multiples)"
                : "(eBay sales medians)"}
            </span>
          </div>
          {([["PSA 10", v.graded.psa10], ["PSA 9", v.graded.psa9], ["PSA 8", v.graded.psa8]] as const).map(
            ([label, price]) =>
              price != null && (
                <div className="price-row" key={label}>
                  <span>
                    {label}
                    {v.graded!.estimated && <span className="muted small"> (est.)</span>}
                  </span>
                  <span className="v"><Money v={price} aud={aud} /></span>
                </div>
              ),
          )}
          {v.graded.estimated && <EstimateNote source={v.graded.source} />}
          <Sources items={v.graded.citations} />
        </>
      )}
      {scan.slab && (
        <div className="muted small" style={{ marginTop: 8 }}>
          <span className="badge info">slab premium</span> The prices above are for{" "}
          <b>raw, ungraded copies</b>. A {scan.slab.company}-certified{" "}
          {scan.slab.gradeText} slab sells for a large premium over raw —{" "}
          {scan.slab.verifyUrl ? (
            <a href={scan.slab.verifyUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              see {scan.slab.company}&apos;s own value estimate on the cert page
            </a>
          ) : (
            "check recent graded sales for its real value"
          )}
          .
        </div>
      )}
      {v.updatedAt && (
        <div className="muted small" style={{ marginTop: 8 }}>
          Prices updated {new Date(v.updatedAt).toLocaleDateString()}
        </div>
      )}
    </div>
  );
}

function Result({ scan }: { scan: Scan }) {
  const m = scan.measurement;
  return (
    <>
      {scan.slab && (
        <div className="panel" style={{ borderColor: "var(--green)" }}>
          <span className="badge pass" style={{ fontSize: 16, padding: "6px 16px" }}>
            {scan.slab.company} CERTIFIED — {scan.slab.gradeText}
          </span>
          {scan.slab.certNumber && (
            <span className="muted" style={{ marginLeft: 10 }}>
              cert #{scan.slab.certNumber}
            </span>
          )}
          <p className="muted" style={{ margin: "8px 0 0" }}>
            This card is already professionally graded — the label grade is authoritative.
            Any estimate below was made through the slab plastic and should be ignored.{" "}
            {scan.slab.verifyUrl && (
              <a href={scan.slab.verifyUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                Verify this cert on {scan.slab.company}&apos;s registry →
              </a>
            )}
          </p>
        </div>
      )}
      <IdentityPanel scan={scan} />
      <GradePanel scan={scan} />
      <RecommendationPanel scan={scan} />

      {scan.status === "rejected" && scan.rejection ? (
        <div className="result-grid">
          {scan.grade && <Viewer scan={scan} />}
          <div>
            <div className="panel">
              <span className="badge warn">not graded — no charge</span>
              <h3>{scan.rejection.userMessage}</h3>
              <p className="muted">{scan.rejection.retryHint}</p>
              {scan.grade && (
                <p className="muted small">
                  The detection view shows what the provisional impression is based on —
                  every box and ring is visible even on a rejected photo.
                </p>
              )}
            </div>
            {scan.grade && <FindingsLine scan={scan} />}
          </div>
        </div>
      ) : (
        m && (
          <div className="result-grid">
            <Viewer scan={scan} />
            <div>
              <div className="panel">
                {m.centering.front.measurable ? (
                  m.centering.passesAt.psa10 ? (
                    <span className="badge pass">passes PSA 10 centering</span>
                  ) : m.centering.passesAt.psa9 ? (
                    <span className="badge warn">PSA 9 centering — misses 10</span>
                  ) : (
                    <span className="badge fail">fails PSA 9 centering</span>
                  )
                ) : (
                  <span className="badge warn">centering not measurable</span>
                )}
                <div style={{ marginTop: 12 }}>
                  <CenteringBlock title="Front" c={m.centering.front} />
                  {m.centering.back && <CenteringBlock title="Back" c={m.centering.back} />}
                </div>
                <div className="muted small">
                  Measured from the printed border, not estimated. Confidence{" "}
                  {(m.confidence.centering * 100).toFixed(0)}%
                </div>
                <div className="confbar">
                  <div style={{ width: `${m.confidence.centering * 100}%` }} />
                </div>
              </div>
              {scan.backRejection && (
                <div className="panel">
                  <span className="badge warn">back photo not usable</span>
                  <p className="muted">
                    {scan.backRejection.userMessage} {scan.backRejection.retryHint}
                  </p>
                </div>
              )}
              <ValuationPanel scan={scan} />
            </div>
          </div>
        )
      )}
      {scan.status === "rejected" && <ValuationPanel scan={scan} />}
      <EbayComps scan={scan} />
      {scan.related && scan.related.length > 0 && (
        <div className="panel">
          <div className="muted" style={{ marginBottom: 10 }}>
            More from {scan.identification?.setName ?? "this set"}{" "}
            <span className="small">(live market prices)</span>
          </div>
          <div className="related-grid">
            {scan.related.map((c) => (
              <div className="related-card" key={c.localId + c.name}>
                {c.imageUrl && <img src={c.imageUrl} alt={c.name} loading="lazy" />}
                <div className="related-name">{c.name}</div>
                <div className="muted small">#{c.localId}</div>
                <div className="related-price">
                  {c.price != null ? `$${c.price.toFixed(2)}` : "—"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default function Home() {
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setStep((s) => (s + 1) % SCAN_STEPS.length), 900);
    return () => clearInterval(t);
  }, [busy]);

  async function runScan() {
    if (!front) return;
    setBusy(true);
    setError(null);
    setScan(null);
    try {
      const form = new FormData();
      form.append("front", front);
      if (back) form.append("back", back);
      const res = await fetch(`${API}/scans`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      setScan(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "scan failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="topbar">
        <span className="wordmark">GRAILCARD</span>
        <MarketTicker />
        <ThemeToggle />
      </div>
      <div className="capture-head">
        <h1>Place the card. We do the measuring.</h1>
        <p className="tagline">
          Centering, measured — not guessed. Bad photos get rejected, not graded.
        </p>
      </div>

      <div className="slots">
        <CaptureSlot label="Front" required file={front} onPick={setFront} scanning={busy} />
        <CaptureSlot label="Back" file={back} onPick={setBack} scanning={busy} />
      </div>
      <div className="scan-status">{busy ? SCAN_STEPS[step] : ""}</div>
      <div className="scan-actions" style={{ marginBottom: 24 }}>
        <button className="primary" disabled={!front || busy} onClick={runScan}>
          {busy ? "Scanning…" : "Scan card"}
        </button>
      </div>

      {error && (
        <div className="panel">
          <span className="badge fail">error</span> {error}
        </div>
      )}

      {scan && <Result scan={scan} />}
      <NewsLine />
    </main>
  );
}
