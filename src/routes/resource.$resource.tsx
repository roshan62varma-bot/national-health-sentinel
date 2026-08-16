import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { ConsoleShell } from "@/components/aegis/shell";
import { Panel, Stat, TierBadge } from "@/components/aegis/ui";
import { MEDICINES } from "@/lib/aegis/data";
import { buildNationalState, forecastFor } from "@/lib/aegis/engine";
import { classifyStock, daysOfSupply, inventoryPosition, reorderPoint, ropDays, safetyStock, tierOf } from "@/lib/aegis/logic";

export const Route = createFileRoute("/resource/$resource")({
  head: ({ params }) => {
    const title = `${cap(params.resource)} readout — AegisHealth BRICS`;
    const description = `Live ${params.resource} position across the PHC network with reorder points, days of supply and 7/30-day demand forecasts.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  component: ResourceDetail,
});

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function ResourceDetail() {
  const { resource } = Route.useParams();
  const state = useMemo(() => buildNationalState(), []);
  const facilities = state.districts.flatMap((d) => d.facilities);
  const pulse = {
    stockRisk: avg(facilities.map((f) => f.risk.stockRisk)),
    bedRisk: avg(facilities.map((f) => f.risk.bedRisk)),
    staffRisk: avg(facilities.map((f) => f.risk.staffRisk)),
  };

  return (
    <ConsoleShell breadcrumb={`Nation > ${cap(resource)}`} pulse={pulse}>
      <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
        {(["medicine", "beds", "staffing"] as const).map((r) => (
          <Link
            key={r}
            to="/resource/$resource"
            params={{ resource: r }}
            className="rounded-sm border border-border px-2.5 py-1.5 hover:bg-secondary"
            activeProps={{ className: "bg-secondary text-foreground" }}
          >
            {cap(r)}
          </Link>
        ))}
      </div>

      {resource === "beds" ? <BedBoard state={state} /> : resource === "staffing" ? <StaffBoard state={state} /> : <StockBoard state={state} />}
    </ConsoleShell>
  );
}

type St = ReturnType<typeof buildNationalState>;

function StockBoard({ state }: { state: St }) {
  const rows = state.districts
    .flatMap((d) => d.facilities.map((f) => ({ d, f })))
    .flatMap(({ d, f }) =>
      f.stocks.map((s) => ({
        district: d,
        facility: f.facility,
        stock: s,
        med: MEDICINES.find((m) => m.id === s.medicineId)!,
        dos: daysOfSupply(s),
        cls: classifyStock(s, d.emergencyMode),
      })),
    )
    .sort((a, b) => a.dos - b.dos)
    .slice(0, 24);
  const first = rows[0];
  const fc7 = first ? forecastFor(state, first.facility.id, first.stock.medicineId, 7) : null;
  const fc30 = first ? forecastFor(state, first.facility.id, first.stock.medicineId, 30) : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Lines tracked" value={String(state.dataset.stocks.length)} />
        <Stat label="Emergency lines" value={String(rows.filter((r) => r.cls === "EMERGENCY").length)} tier="RED" />
        <Stat label="7-day demand (top risk)" value={fc7 ? String(fc7.total) : "—"} unit={first?.med.unit ?? ""} />
        <Stat label="30-day demand (top risk)" value={fc30 ? String(fc30.total) : "—"} unit={first?.med.unit ?? ""} />
      </div>

      {first ? (
        <Panel
          title={`Forecast — ${first.med.name} @ ${first.facility.name}`}
          hint={`model ${fc7?.modelVersion} · monsoon/flu regressors + emergency_mode exogenous flag`}
        >
          <div className="flex h-24 items-end gap-1">
            {(fc30?.daily ?? []).map((v, i) => (
              <div
                key={i}
                className="flex-1 rounded-t-sm bg-primary/70"
                style={{ height: `${(v / Math.max(...(fc30?.daily ?? [1]))) * 100}%` }}
                title={`Day ${i + 1}: ${v} ${first.med.unit}`}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel title="Stock position — lowest days of supply first" hint="IP = OnHand + OnOrder − Backorder · ROP = ADC×LT + Z·σ·√LT">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3 font-medium">Facility</th>
                <th className="py-2 pr-3 font-medium">Medicine</th>
                <th className="py-2 pr-3 text-right font-medium">On hand</th>
                <th className="py-2 pr-3 text-right font-medium">IP</th>
                <th className="py-2 pr-3 text-right font-medium">ADC</th>
                <th className="py-2 pr-3 text-right font-medium">SS</th>
                <th className="py-2 pr-3 text-right font-medium">ROP</th>
                <th className="py-2 pr-3 text-right font-medium">DoS</th>
                <th className="py-2 font-medium">Class</th>
              </tr>
            </thead>
            <tbody className="readout">
              {rows.map((r) => (
                <tr key={`${r.facility.id}-${r.stock.medicineId}`} className="border-b border-border/60">
                  <td className="py-2 pr-3 font-sans text-xs">{r.facility.name}</td>
                  <td className="py-2 pr-3 font-sans text-xs">{r.med.name}</td>
                  <td className="py-2 pr-3 text-right">{r.stock.onHand}</td>
                  <td className="py-2 pr-3 text-right">{inventoryPosition(r.stock)}</td>
                  <td className="py-2 pr-3 text-right">{r.stock.avgDailyConsumption}</td>
                  <td className="py-2 pr-3 text-right">{safetyStock(r.stock).toFixed(0)}</td>
                  <td className="py-2 pr-3 text-right">
                    {reorderPoint(r.stock).toFixed(0)}
                    <span className="text-muted-foreground"> ({ropDays(r.stock).toFixed(1)}d)</span>
                  </td>
                  <td className="py-2 pr-3 text-right">{r.dos.toFixed(1)}</td>
                  <td className="py-2">
                    <TierBadge tier={r.cls === "EMERGENCY" ? "RED" : r.cls === "WARNING" ? "AMBER" : "GREEN"}>
                      {r.cls}
                    </TierBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function BedBoard({ state }: { state: St }) {
  const facilities = state.districts.flatMap((d) => d.facilities);
  return (
    <Panel title="Bed board" hint="BedRisk = clamp((Occupancy% − 70)/30, 0, 1) — transfers matched by ward type">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {facilities.map((f) => (
          <div key={f.facility.id} className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{f.facility.name}</span>
              <TierBadge tier={tierOf(f.risk.bedRisk)}>{f.occupancy.toFixed(0)}%</TierBadge>
            </div>
            <ul className="readout mt-2 space-y-1 text-xs">
              {f.beds.map((b) => {
                const occ = (b.occupied / b.total) * 100;
                return (
                  <li key={b.id} className="flex items-center gap-2">
                    <span className="w-20 font-sans text-muted-foreground">{b.wardType}</span>
                    <div className="h-2 flex-1 rounded-full bg-secondary">
                      <div
                        className="h-2 rounded-full"
                        style={{
                          width: `${occ}%`,
                          backgroundColor:
                            occ > 95 ? "var(--risk-critical)" : occ > 80 ? "var(--risk-warning)" : "var(--risk-stable)",
                        }}
                      />
                    </div>
                    <span className="w-14 text-right">
                      {b.occupied}/{b.total}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function StaffBoard({ state }: { state: St }) {
  const facilities = state.districts.flatMap((d) => d.facilities);
  return (
    <Panel title="Staffing coverage" hint="StaffRisk = clamp(1 − PresentStaff/MinSafeStaff, 0, 1)">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {facilities.map((f) => (
          <div key={f.facility.id} className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{f.facility.name}</span>
              <TierBadge tier={tierOf(f.risk.staffRisk)}>{f.risk.staffRisk.toFixed(2)}</TierBadge>
            </div>
            <ul className="readout mt-2 grid grid-cols-2 gap-1 text-xs">
              {f.staff.map((s) => (
                <li key={s.role} className="flex justify-between gap-2">
                  <span className="font-sans text-muted-foreground">{s.role}</span>
                  <span style={{ color: s.present < s.minSafeStaffingCount ? "var(--risk-critical)" : undefined }}>
                    {s.present}/{s.minSafeStaffingCount}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Panel>
  );
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);