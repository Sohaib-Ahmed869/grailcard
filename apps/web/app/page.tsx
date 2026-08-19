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

const SCAN_STEPS = [
  "Detecting card…",
  "Checking photo quality…",
  "Measuring borders…",
  "Reading card text…",
  "Matching catalog…",
  "Fetching market prices…",
];

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
      <div className="slot-label">
        {label} {required ? "" : "(optional)"}
      </div>
      <div
        className="scan-frame"
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
    <div className="viewer">
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
    </div>
  );
}

function gradeColor(v: number) {
  if (v >= 9) return "#2fbf71";
  if (v >= 7) return "#4da3ff";
  if (v >= 5) return "#e8a13c";
  return "#e05252";
}

// semicircular gauge geometry: fraction 0..1 -> point on the arc
function gaugePoint(cx: number, cy: number, r: number, frac: number) {
  const a = Math.PI * (1 - frac);
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const;
}

function gaugeArc(cx: number, cy: number, r: number, f0: number, f1: number) {
  const [x0, y0] = gaugePoint(cx, cy, r, f0);
  const [x1, y1] = gaugePoint(cx, cy, r, f1);
  // a semicircular gauge arc never exceeds 180°, so large-arc is always 0
  return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
}

function GradeGauge({
  overall,
  band,
}: {
  overall: number;
  band: { low: number; high: number };
}) {
  // geometry padded so nothing (labels, rounded caps, ticks) clips the viewBox
  const cx = 120;
  const cy = 116;
  const r = 78;
  const frac = (v: number) => Math.min(1, Math.max(0, (v - 1) / 9));
  const ticks = [];
  for (let v = 1; v <= 10; v++) {
    const major = v === 1 || v === 5 || v === 10;
    const [x0, y0] = gaugePoint(cx, cy, r + 10, frac(v));
    const [x1, y1] = gaugePoint(cx, cy, r + (major ? 18 : 14), frac(v));
    const [lx, ly] = gaugePoint(cx, cy, r + 29, frac(v));
    ticks.push(
      <g key={v}>
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#3a4250" strokeWidth={major ? 2 : 1.5} />
        {major && (
          <text x={lx} y={ly + 4} textAnchor="middle" fontSize={11} fill="#9aa3ad">
            {v}
          </text>
        )}
      </g>,
    );
  }
  return (
    <svg viewBox="0 0 240 140" className="gauge">
      <path
        d={gaugeArc(cx, cy, r, 0, 1)}
        stroke="#242a33"
        strokeWidth={13}
        fill="none"
        strokeLinecap="round"
      />
      <path
        d={gaugeArc(cx, cy, r, frac(band.low), frac(band.high))}
        stroke={gradeColor(overall)}
        strokeOpacity={0.28}
        strokeWidth={13}
        fill="none"
        strokeLinecap="butt"
      />
      <path
        d={gaugeArc(cx, cy, r, 0, frac(overall))}
        stroke={gradeColor(overall)}
        strokeWidth={6}
        fill="none"
        strokeLinecap="round"
      />
      {ticks}
      <circle
        cx={gaugePoint(cx, cy, r, frac(overall))[0]}
        cy={gaugePoint(cx, cy, r, frac(overall))[1]}
        r={6.5}
        fill={gradeColor(overall)}
        stroke="#0e1013"
        strokeWidth={2.5}
      />
      <text x={cx} y={cy - 12} textAnchor="middle" fontSize={34} fontWeight={800} fill="#e8eaed">
        {overall.toFixed(1)}
      </text>
      <text x={cx} y={cy + 8} textAnchor="middle" fontSize={10} letterSpacing={2} fill="#9aa3ad">
        GC ESTIMATE
      </text>
    </svg>
  );
}

const RADAR_AXES = [
  ["Centering", "centering"],
  ["Corners", "corners"],
  ["Edges", "edges"],
  ["Surface", "surface"],
] as const;

function RadarChart({ g }: { g: NonNullable<Scan["grade"]> }) {
  const cx = 110;
  const cy = 100;
  const R = 66;
  const angle = (i: number) => (Math.PI / 2) * i - Math.PI / 2; // top, right, bottom, left
  const pt = (i: number, radius: number) =>
    [cx + radius * Math.cos(angle(i)), cy + radius * Math.sin(angle(i))] as const;
  const rings = [0.25, 0.5, 0.75, 1].map((f) => (
    <polygon
      key={f}
      points={RADAR_AXES.map((_, i) => pt(i, R * f).join(",")).join(" ")}
      fill="none"
      stroke="#242a33"
      strokeWidth={f === 1 ? 1.5 : 1}
    />
  ));
  const subs = RADAR_AXES.map(([, key]) => g.subgrades[key]);
  const shape = RADAR_AXES.map((_, i) =>
    pt(i, ((subs[i]?.value ?? 0) / 10) * R).join(","),
  ).join(" ");
  return (
    <svg viewBox="0 0 220 200" className="radar">
      {rings}
      {RADAR_AXES.map((_, i) => {
        const [x, y] = pt(i, R);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#242a33" strokeWidth={1} />;
      })}
      <polygon points={shape} fill="rgba(77,163,255,0.22)" stroke="#4da3ff" strokeWidth={2} />
      {RADAR_AXES.map(([label], i) => {
        const sub = subs[i];
        const [vx, vy] = pt(i, ((sub?.value ?? 0) / 10) * R);
        const [lx, ly] = pt(i, R + 22);
        return (
          <g key={label}>
            {sub && <circle cx={vx} cy={vy} r={4} fill={gradeColor(sub.value)} stroke="#0e1013" strokeWidth={1.5} />}
            <text x={lx} y={ly} textAnchor="middle" fontSize={11} fill="#9aa3ad">
              {label}
            </text>
            <text x={lx} y={ly + 13} textAnchor="middle" fontSize={12} fontWeight={700}
              fill={sub ? gradeColor(sub.value) : "#5a6472"}>
              {sub ? sub.value.toFixed(1) : "n/a"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ScaleBar({
  label,
  sub,
}: {
  label: string;
  sub?: { value: number; confidence: number } | null;
}) {
  return (
    <div className="scalebar-row">
      <div className="scalebar-label">
        <span>{label}</span>
        <span style={{ color: sub ? gradeColor(sub.value) : "var(--muted)", fontWeight: 700 }}>
          {sub ? sub.value.toFixed(1) : "n/a"}
        </span>
      </div>
      <div className="scalebar-track">
        {sub && (
          <div
            className="scalebar-fill"
            style={{
              width: `${((sub.value - 1) / 9) * 100}%`,
              background: gradeColor(sub.value),
              opacity: 0.45 + sub.confidence * 0.55,
            }}
          />
        )}
      </div>
      <div className="muted small">
        {sub ? `${(sub.confidence * 100).toFixed(0)}% confidence` : "not assessable on this card"}
      </div>
    </div>
  );
}

function GradePanel({ scan }: { scan: Scan }) {
  const g = scan.grade;
  if (!g) return null;
  return (
    <div className="panel">
      {scan.status === "rejected" && (
        <div style={{ marginBottom: 10 }}>
          <span className="badge warn">provisional — photo failed the quality gate</span>
          <span className="muted small"> a rough impression only; re-shoot for a real grade</span>
        </div>
      )}
      <div className="grade-viz">
        <div>
          <GradeGauge overall={g.overall} band={g.band} />
          <div className="band-note">
            band <b>{g.band.low.toFixed(1)} – {g.band.high.toFixed(1)}</b> — the band is the
            honest claim; the number is its midpoint
          </div>
          {scan.authenticity?.digitalLikely && (
            <div style={{ marginTop: 8, textAlign: "center" }}>
              <span className="badge warn">possible digital image</span>
            </div>
          )}
        </div>
        <RadarChart g={g} />
        <div className="scalebars">
          <ScaleBar label="Centering" sub={g.subgrades.centering} />
          <ScaleBar label="Corners" sub={g.subgrades.corners} />
          <ScaleBar label="Edges" sub={g.subgrades.edges} />
          <ScaleBar label="Surface" sub={g.subgrades.surface} />
        </div>
      </div>
      {scan.summary && (
        <p style={{ margin: "10px 0", lineHeight: 1.6 }}>{scan.summary}</p>
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
      <rect x={1} y={1} width={W - 2} height={H - 2} rx={6} fill="#1d2127" stroke="#3a4250" strokeWidth={1.5} />
      <line x1={W / 2} y1={4} x2={W / 2} y2={H - 4} stroke="#242a33" strokeDasharray="3 4" />
      <line x1={4} y1={H / 2} x2={W - 4} y2={H / 2} stroke="#242a33" strokeDasharray="3 4" />
      <rect
        x={1 + left}
        y={1 + top}
        width={W - 2 - bx}
        height={H - 2 - by}
        rx={3}
        fill="rgba(77,163,255,0.14)"
        stroke="#4da3ff"
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
  sports: "Sports card",
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
              <td>{row.value != null ? `$${row.value.toFixed(2)}` : "—"}</td>
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

function ValuationPanel({ scan }: { scan: Scan }) {
  const v = scan.valuation;
  if (!v) return null;
  return (
    <div className="panel">
      <div className="muted" style={{ marginBottom: 6 }}>
        Market value <span className="small">(raw / ungraded)</span>
      </div>
      {v.tcgplayer && (
        <>
          <div className="price-row">
            <span>TCGplayer market ({v.tcgplayer.variant})</span>
            <span className="v">{money(v.tcgplayer.market, v.tcgplayer.unit)}</span>
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
      {v.conditionAdjusted && (
        <div className="price-row" style={{ background: "rgba(77,163,255,0.06)" }}>
          <span>
            <b>This copy, in its estimated condition</b>{" "}
            <span className="muted small">(× {v.conditionAdjusted.multiplier} of NM)</span>
          </span>
          <span className="v" style={{ color: "var(--accent)" }}>
            ${v.conditionAdjusted.value.toFixed(2)}
          </span>
        </div>
      )}
      {v.graded && (
        <>
          <div className="muted" style={{ margin: "12px 0 6px" }}>
            Graded value <span className="small">(eBay sales averages)</span>
          </div>
          {([["PSA 10", v.graded.psa10], ["PSA 9", v.graded.psa9], ["PSA 8", v.graded.psa8]] as const).map(
            ([label, price]) =>
              price != null && (
                <div className="price-row" key={label}>
                  <span>{label}</span>
                  <span className="v">${price.toFixed(2)}</span>
                </div>
              ),
          )}
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
        <div className="panel">
          <span className="badge warn">not graded — no charge</span>
          <h3>{scan.rejection.userMessage}</h3>
          <p className="muted">{scan.rejection.retryHint}</p>
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
      <h1>Grailcard</h1>
      <p className="tagline">
        Centering, measured — not guessed. Bad photos get rejected, not graded.
      </p>

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
    </main>
  );
}
