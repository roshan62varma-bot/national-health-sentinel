import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { tierOf } from "@/lib/aegis/logic";

const riskColor = (t: string) =>
  t === "RED" ? "var(--risk-critical)" : t === "AMBER" ? "var(--risk-warning)" : "var(--risk-stable)";

function Waveform({ base, label, hash }: { base: number; label: string; hash: number }) {
  // live-ish jitter around the computed RiskScore, so the strip reads as vitals
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2200);
    return () => clearInterval(id);
  }, []);
  const points = Array.from({ length: 40 }, (_, i) => {
    const wobble = Math.sin((i + tick) * 0.55 + hash) * 0.07 + Math.sin((i + tick) * 1.7 + hash) * 0.03;
    const v = Math.min(1, Math.max(0, base + wobble));
    return `${((i / 39) * 100).toFixed(2)},${(22 - v * 20).toFixed(2)}`;
  }).join(" ");
  const color = riskColor(tierOf(base));
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
        <span className="readout text-[11px]" style={{ color }}>
          {base.toFixed(2)}
        </span>
      </div>
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full" aria-hidden>
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/**
 * The Pulse Strip — the nation's supply chain rendered as vital signs.
 * Each waveform deep-links into that resource's detail view.
 */
export function PulseStrip({
  stockRisk,
  bedRisk,
  staffRisk,
  right,
}: {
  stockRisk: number;
  bedRisk: number;
  staffRisk: number;
  right?: React.ReactNode;
}) {
  const items = [
    { label: "Medicine stock", base: stockRisk, to: "/resource/$resource", params: { resource: "medicine" } },
    { label: "Bed occupancy", base: bedRisk, to: "/resource/$resource", params: { resource: "beds" } },
    { label: "Staffing coverage", base: staffRisk, to: "/resource/$resource", params: { resource: "staffing" } },
  ] as const;
  return (
    <div className="sticky top-0 z-30 border-b border-border bg-card/95 px-3 py-2 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {items.map((it, i) => (
            <Link
              key={it.label}
              to={it.to}
              params={it.params}
              className="min-w-0 flex-1 rounded-sm px-1 transition-colors hover:bg-secondary"
              aria-label={`Open ${it.label} detail`}
            >
              <Waveform base={it.base} label={it.label} hash={i * 2.1} />
            </Link>
          ))}
        </div>
        {right}
      </div>
    </div>
  );
}