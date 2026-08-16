import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConsoleShell } from "@/components/aegis/shell";
import { EmptyState, Panel, Stat, TierBadge, tierVar } from "@/components/aegis/ui";
import { buildNationalState } from "@/lib/aegis/engine";
import { CONFIG } from "@/lib/aegis/logic";
import type { DispatchManifest } from "@/lib/aegis/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "National Command — AegisHealth BRICS" },
      {
        name: "description",
        content:
          "Live PHC network command: stock, bed and staffing risk across districts, with cross-district redistribution manifests ready for one-tap approval.",
      },
      { property: "og:title", content: "National Command — AegisHealth BRICS" },
      {
        property: "og:description",
        content: "Real-time federated health resource and supply chain command for a national PHC network.",
      },
    ],
  }),
  component: NationalDashboard,
});

function NationalDashboard() {
  const state = useMemo(() => buildNationalState(), []);
  const [approved, setApproved] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<DispatchManifest | null>(state.manifests[0] ?? null);

  const pulse = {
    stockRisk: avg(state.districts.flatMap((d) => d.facilities.map((f) => f.risk.stockRisk))),
    bedRisk: avg(state.districts.flatMap((d) => d.facilities.map((f) => f.risk.bedRisk))),
    staffRisk: avg(state.districts.flatMap((d) => d.facilities.map((f) => f.risk.staffRisk))),
  };

  const approve = (m: DispatchManifest) => {
    const token = `SIG-${m.id.slice(3, 12)}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
    setApproved((a) => ({ ...a, [m.id]: token }));
    toast.success("Dispatched", {
      description: `${m.quantity} × ${m.label} → ${state.facilityIndex[m.destFacilityId]?.facility.name}. Signature ${token} written to audit log.`,
    });
  };

  const pending = state.manifests.filter((m) => !approved[m.id]);

  return (
    <ConsoleShell breadcrumb="Nation > All states" pulse={pulse}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">National Command Dashboard</h1>
          <p className="text-xs text-muted-foreground">
            Nation &gt; Andhra Pradesh &gt; 3 districts &gt; {state.national.totalFacilities} facilities
          </p>
        </div>
        <TierBadge tier={state.national.tier}>National composite {state.national.composite.toFixed(2)}</TierBadge>
      </div>

      {state.districts.some((d) => d.emergencyMode) ? (
        <div
          className="mb-4 rounded-md border px-4 py-3 text-sm"
          style={{
            borderColor: tierVar("RED"),
            backgroundColor: "color-mix(in oklab, var(--risk-critical) 14%, transparent)",
          }}
        >
          <strong className="font-semibold">EMERGENCY MODE active</strong> —{" "}
          {state.districts
            .filter((d) => d.emergencyMode)
            .map((d) => d.name)
            .join(", ")}{" "}
          held &gt;{Math.round(CONFIG.emergency.facilityPct * 100)}% Red facilities for &gt;{CONFIG.emergency.hours}h.
          Forecast horizon cut to 3-day granularity, thresholds tightened 20%, dispatch radius widened 50%. Push alerts
          sent to State and National roles.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Red facilities"
          value={`${state.national.redFacilities}/${state.national.totalFacilities}`}
          tier="RED"
        />
        <Stat label="Bed occupancy" value={state.national.occupancy.toFixed(1)} unit="%" />
        <Stat label="Stock-out < 24h" value={String(state.national.stockoutIn24h)} unit="lines" tier="AMBER" />
        <Stat label="Pending manifests" value={String(pending.length)} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <Panel title="District heatmap" hint="Colour = RiskScore tier (Green <0.3 · Amber 0.3–0.6 · Red >0.6)">
            <div className="grid gap-3 sm:grid-cols-3">
              {state.districts.map((d) => (
                <div key={d.id} className="rounded-md border p-3" style={{ borderColor: tierVar(d.tier) }}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{d.name}</span>
                    <TierBadge tier={d.tier}>{d.composite.toFixed(2)}</TierBadge>
                  </div>
                  <p className="readout mt-1 text-[11px] text-muted-foreground">
                    {Math.round(d.redPct * 100)}% red · {d.redHoursStreak}h streak
                    {d.emergencyMode ? " · EMERGENCY" : ""}
                  </p>
                  <div className="mt-3 grid grid-cols-5 gap-1">
                    {d.facilities.map((f) => (
                      <Link
                        key={f.facility.id}
                        to="/facility/$facilityId"
                        params={{ facilityId: f.facility.id }}
                        title={`${f.facility.name} — ${f.risk.composite.toFixed(2)}`}
                        className="h-8 rounded-sm"
                        style={{ backgroundColor: tierVar(f.risk.tier) }}
                        aria-label={`${f.facility.name}, risk ${f.risk.composite.toFixed(2)}`}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel
            title="Pending dispatch manifests"
            hint="Deficit/surplus matching within radius — human approval required, nothing auto-executes"
          >
            {pending.length === 0 ? (
              <EmptyState>No pending manifests — every district is balanced.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    <tr className="border-b border-border text-left">
                      <th className="py-2 pr-3 font-medium">Resource</th>
                      <th className="py-2 pr-3 font-medium">Route</th>
                      <th className="py-2 pr-3 text-right font-medium">Qty</th>
                      <th className="py-2 pr-3 text-right font-medium">km</th>
                      <th className="py-2 pr-3 text-right font-medium">ETA</th>
                      <th className="py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {pending.slice(0, 12).map((m) => (
                      <tr key={m.id} className="border-b border-border/60 align-middle">
                        <td className="py-2 pr-3">
                          <button className="text-left hover:text-primary" onClick={() => setSelected(m)}>
                            {m.label}
                          </button>
                          <div className="readout text-[10px] text-muted-foreground">{m.resourceType}</div>
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {short(state.facilityIndex[m.sourceFacilityId]?.facility.name)} →{" "}
                          <span className="text-foreground">
                            {short(state.facilityIndex[m.destFacilityId]?.facility.name)}
                          </span>
                        </td>
                        <td className="readout py-2 pr-3 text-right">{m.quantity}</td>
                        <td className="readout py-2 pr-3 text-right">{m.distanceKm.toFixed(1)}</td>
                        <td className="readout py-2 pr-3 text-right">{m.etaHours.toFixed(1)}h</td>
                        <td className="py-2 text-right">
                          <button
                            onClick={() => approve(m)}
                            className="rounded-sm bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                          >
                            Approve &amp; Dispatch
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Manifest detail" hint="The algorithm decides quantity; the draft explains it">
            {selected ? (
              <div className="space-y-3 text-sm">
                <div className="readout text-xs text-muted-foreground">{selected.id}</div>
                <div className="font-medium">
                  {selected.quantity} × {selected.label}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{selected.rationale}</p>
                <dl className="readout grid grid-cols-2 gap-2 text-xs">
                  <Row k="Severity" v={selected.severity.toFixed(2)} />
                  <Row k="Days to stock-out" v={selected.daysToStockout.toFixed(1)} />
                  <Row k="Haversine" v={`${selected.distanceKm.toFixed(1)} km`} />
                  <Row k="ETA @40km/h" v={`${selected.etaHours.toFixed(1)} h`} />
                </dl>
                {approved[selected.id] ? (
                  <div
                    className="readout rounded-sm border border-border px-3 py-2 text-xs"
                    style={{ color: tierVar("GREEN") }}
                  >
                    APPROVED · {approved[selected.id]}
                  </div>
                ) : (
                  <button
                    onClick={() => approve(selected)}
                    className="w-full rounded-sm bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Approve &amp; Dispatch
                  </button>
                )}
              </div>
            ) : (
              <EmptyState>Select a manifest to review its routing and rationale.</EmptyState>
            )}
          </Panel>

          <Panel title="Approved today" hint="Simulated digital signatures written to audit_log">
            {Object.keys(approved).length === 0 ? (
              <EmptyState>Nothing dispatched yet in this session.</EmptyState>
            ) : (
              <ul className="readout space-y-1 text-xs">
                {Object.entries(approved).map(([id, token]) => (
                  <li key={id} className="flex justify-between gap-2 border-b border-border/60 pb-1">
                    <span className="truncate">{id}</span>
                    <span style={{ color: tierVar("GREEN") }}>{token}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </ConsoleShell>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const short = (n?: string) => (n ?? "—").replace("District Hospital ", "DH ").replace("PHC ", "");