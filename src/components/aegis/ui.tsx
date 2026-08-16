import { cn } from "@/lib/utils";
import type { Tier } from "@/lib/aegis/types";

export const tierVar = (t: Tier) =>
  t === "RED" ? "var(--risk-critical)" : t === "AMBER" ? "var(--risk-warning)" : "var(--risk-stable)";

export function TierBadge({ tier, children }: { tier: Tier; children?: React.ReactNode }) {
  return (
    <span
      className="readout inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color: tierVar(tier), backgroundColor: `color-mix(in oklab, ${tierVar(tier)} 16%, transparent)` }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: tierVar(tier) }} />
      {children ?? tier}
    </span>
  );
}

export function Panel({
  title,
  hint,
  actions,
  children,
  className,
}: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-md border border-border bg-card", className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, unit, tier }: { label: string; value: string; unit?: string; tier?: Tier }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="readout mt-1 text-2xl leading-none" style={tier ? { color: tierVar(tier) } : undefined}>
        {value}
        {unit ? <span className="ml-1 text-xs text-muted-foreground">{unit}</span> : null}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}