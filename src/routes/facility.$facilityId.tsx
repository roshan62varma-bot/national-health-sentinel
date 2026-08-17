import { createFileRoute } from "@tanstack/react-router";
import { ConsoleShell } from "@/components/aegis/shell";
import { ErrorState, LoadingState, Panel, Stat, TierBadge } from "@/components/aegis/ui";
import { MEDICINES } from "@/lib/aegis/data";
import { forecastFor } from "@/lib/aegis/engine";
import { classifyStock, daysOfSupply, ropDays, tierOf } from "@/lib/aegis/logic";
import { useNationalState } from "@/lib/aegis/use-national-state";

export const Route = createFileRoute("/facility/$facilityId")({
  head: ({ params }) => {
    const title = `Facility ${params.facilityId} — AegisHealth BRICS`;
    const description =
      "Facility drill-down: medicine days of supply, ward occupancy, roster coverage and the composite early-warning score.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  component: FacilityDetail,
});

function FacilityDetail() {
  const { facilityId } = Route.useParams();
  const { data: state, isLoading, error } = useNationalState();

  if (isLoading || !state) {
    return (
      <ConsoleShell breadcrumb="Nation" pulse={{ stockRisk: 0, bedRisk: 0, staffRisk: 0 }}>
        <LoadingState />
      </ConsoleShell>
    );
  }
  if (error) {
    return (
      <ConsoleShell breadcrumb="Nation" pulse={{ stockRisk: 0, bedRisk: 0, staffRisk: 0 }}>
        <ErrorState error={error} />
      </ConsoleShell>
    );
  }

  const view = state.facilityIndex[facilityId];
  const district = state.districts.find((d) => d.id === view?.facility.districtId);

  if (!view || !district) {
    return (
      <ConsoleShell breadcrumb="Nation" pulse={{ stockRisk: 0, bedRisk: 0, staffRisk: 0 }}>
        <Panel title="Facility not found" hint="Check the facility id in the district heatmap">
          <p className="text-sm text-muted-foreground">No facility matches “{facilityId}”.</p>
        </Panel>
      </ConsoleShell>
    );
  }

  const manifests = state.manifests.filter(
    (m) => m.destFacilityId === facilityId || m.sourceFacilityId === facilityId,
  );

  return (
    <ConsoleShell
      breadcrumb={`Nation > AP > ${district.name} > ${view.facility.name}`}
      pulse={{ stockRisk: view.risk.stockRisk, bedRisk: view.risk.bedRisk, staffRisk: view.risk.staffRisk }}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">{view.facility.name}</h1>
          <p className="readout text-xs text-muted-foreground">
            {view.facility.type} · catchment {view.facility.catchmentPopulation.toLocaleString()} ·{" "}
            {view.facility.lat.toFixed(3)}, {view.facility.lng.toFixed(3)}
          </p>
        </div>
        <TierBadge tier={view.risk.tier}>Composite {view.risk.composite.toFixed(2)}</TierBadge>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Stock risk" value={view.risk.stockRisk.toFixed(2)} tier={tierOf(view.risk.stockRisk)} />
        <Stat label="Bed risk" value={view.risk.bedRisk.toFixed(2)} tier={tierOf(view.risk.bedRisk)} />
        <Stat label="Staff risk" value={view.risk.staffRisk.toFixed(2)} tier={tierOf(view.risk.staffRisk)} />
        <Stat label="Occupancy" value={view.occupancy.toFixed(1)} unit="%" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel title="Medicine lines" hint="7-day forecast per line, emergency flag applied when district escalates">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3 font-medium">Medicine</th>
                <th className="py-2 pr-3 text-right font-medium">On hand</th>
                <th className="py-2 pr-3 text-right font-medium">DoS</th>
                <th className="py-2 pr-3 text-right font-medium">ROP days</th>
                <th className="py-2 pr-3 text-right font-medium">7d demand</th>
                <th className="py-2 font-medium">Class</th>
              </tr>
            </thead>
            <tbody className="readout">
              {view.stocks.map((s) => {
                const med = MEDICINES.find((m) => m.id === s.medicineId);
                const cls = classifyStock(s, district.emergencyMode);
                return (
                  <tr key={s.medicineId} className="border-b border-border/60">
                    <td className="py-2 pr-3 font-sans text-xs">{med?.name}</td>
                    <td className="py-2 pr-3 text-right">{s.onHand}</td>
                    <td className="py-2 pr-3 text-right">{daysOfSupply(s).toFixed(1)}</td>
                    <td className="py-2 pr-3 text-right">{ropDays(s).toFixed(1)}</td>
                    <td className="py-2 pr-3 text-right">{forecastFor(state, facilityId, s.medicineId, 7).total}</td>
                    <td className="py-2">
                      <TierBadge tier={cls === "EMERGENCY" ? "RED" : cls === "WARNING" ? "AMBER" : "GREEN"}>{cls}</TierBadge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel title="Linked manifests" hint="Inbound and outbound movements involving this facility">
          {manifests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No movements queued — this facility is balanced.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {manifests.slice(0, 8).map((m) => (
                <li key={m.id} className="rounded-sm border border-border px-3 py-2">
                  <div className="flex justify-between gap-2">
                    <span>
                      {m.quantity} × {m.label}
                    </span>
                    <span className="readout text-xs text-muted-foreground">
                      {m.destFacilityId === facilityId ? "INBOUND" : "OUTBOUND"} · {m.distanceKm.toFixed(1)} km
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{m.rationale}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </ConsoleShell>
  );
}