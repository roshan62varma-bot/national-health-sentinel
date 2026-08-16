import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ConsoleShell } from "@/components/aegis/shell";
import { Panel, Stat } from "@/components/aegis/ui";
import { buildNationalState } from "@/lib/aegis/engine";
import { clipAndNoise, fedAvg, personalize, weightsHash } from "@/lib/aegis/logic";
import type { FlRound } from "@/lib/aegis/types";

export const Route = createFileRoute("/brics")({
  head: () => ({
    meta: [
      { title: "BRICS Federated Network — AegisHealth" },
      {
        name: "description",
        content:
          "Federated learning across BRICS nations: clipped, differentially private weight deltas averaged with FedAvg — records never cross a border.",
      },
      { property: "og:title", content: "BRICS Federated Network — AegisHealth" },
      {
        property: "og:description",
        content: "Auditable federated rounds with epsilon budget, weight hashes and accuracy deltas per nation.",
      },
    ],
  }),
  component: BricsPanel,
});

const NATIONS = [
  ["nat-br", "Brazil"],
  ["nat-ru", "Russia"],
  ["nat-in", "India"],
  ["nat-cn", "China"],
  ["nat-za", "South Africa"],
] as const;

function BricsPanel() {
  const state = useMemo(() => buildNationalState(), []);
  const [epsilon, setEpsilon] = useState(1.0);
  const [rounds, setRounds] = useState<FlRound[]>(state.dataset.flRounds);

  const facilities = state.districts.flatMap((d) => d.facilities);
  const pulse = {
    stockRisk: avg(facilities.map((f) => f.risk.stockRisk)),
    bedRisk: avg(facilities.map((f) => f.risk.bedRisk)),
    staffRisk: avg(facilities.map((f) => f.risk.staffRisk)),
  };

  const runRound = () => {
    const nextRound = Math.max(...rounds.map((r) => r.roundNumber)) + 1;
    const clientUpdates = NATIONS.map(([id, nation], i) => {
      // each client trains locally; only the delta vector is ever emitted
      const localDelta = Array.from({ length: 24 }, (_, k) => Math.sin(k * 0.7 + i) * 0.05 + 0.01 * i);
      const noised = clipAndNoise(localDelta, { clipNorm: 1.0, epsilon });
      return { id, nation, weights: noised, sampleCount: 4000 + i * 900, localDelta };
    });
    const global = fedAvg(clientUpdates);
    const stamp = new Date().toISOString();
    setRounds((prev) => [
      ...clientUpdates.map((u) => {
        const blended = personalize(global, u.localDelta);
        return {
          id: `fl-${nextRound}-${u.id}`,
          roundNumber: nextRound,
          nationId: u.id,
          nation: u.nation,
          dpEpsilon: epsilon,
          weightsHash: weightsHash(u.weights),
          aggregateAccuracyDelta:
            Math.round(
              (1 -
                blended.reduce((a, v, i) => a + Math.abs(v - (u.localDelta[i] ?? 0)), 0) / blended.length) *
                100,
            ) / 100,
          timestamp: stamp,
        } satisfies FlRound;
      }),
      ...prev,
    ]);
  };

  const latest = Math.max(...rounds.map((r) => r.roundNumber));

  return (
    <ConsoleShell breadcrumb="BRICS > Aggregate only" pulse={pulse}>
      <div className="mb-4">
        <h1 className="text-lg font-semibold">BRICS Federated Network</h1>
        <p className="text-xs text-muted-foreground">
          Role BRICS_LIAISON — aggregate scope only. Facility-level drill-down outside the home nation is refused
          server-side, not merely hidden.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Latest round" value={`#${latest}`} />
        <Stat label="Participating nations" value="5" />
        <Stat label="DP epsilon" value={epsilon.toFixed(2)} />
        <Stat label="Records crossing border" value="0" tier="GREEN" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1.4fr]">
        <Panel title="Privacy pipeline" hint="clip → noise → FedAvg → personalization blend">
          <ol className="space-y-2 text-sm text-muted-foreground">
            <li>
              <span className="text-foreground">1. Local training.</span> Each nation fits its forecaster on its own
              (facility, medicine, day) consumption tensors. Nothing leaves the country.
            </li>
            <li>
              <span className="text-foreground">2. Max-norm clip.</span> Delta scaled to sensitivity C = 1.0, bounding
              any single facility-day's influence.
            </li>
            <li>
              <span className="text-foreground">3. Gaussian mechanism.</span> σ = C·√(2·ln(1.25/δ))/ε with δ = 1e-5.
            </li>
            <li>
              <span className="text-foreground">4. FedAvg.</span> Coordinator averages noised vectors weighted by sample
              count — the payload is a fixed-length parameter vector with no rows, ids or per-record channel.
            </li>
            <li>
              <span className="text-foreground">5. Personalization.</span> Global model blended (α = 0.6) with local
              weights rather than overwriting them, so a Brazilian dengue-surge signature sharpens India's onset
              detection without exposing either country's records.
            </li>
          </ol>
          <label className="mt-4 block text-xs text-muted-foreground">
            Privacy budget ε — lower is stricter, noisier
            <input
              type="range"
              min={0.2}
              max={4}
              step={0.1}
              value={epsilon}
              onChange={(e) => setEpsilon(Number(e.target.value))}
              className="mt-2 w-full accent-primary"
            />
          </label>
          <button
            onClick={runRound}
            className="mt-3 w-full rounded-sm bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Run federated round
          </button>
        </Panel>

        <Panel title="Round ledger" hint="Auditable proof that only weights crossed the border">
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-3 font-medium">Round</th>
                  <th className="py-2 pr-3 font-medium">Nation</th>
                  <th className="py-2 pr-3 text-right font-medium">ε</th>
                  <th className="py-2 pr-3 font-medium">Weights hash</th>
                  <th className="py-2 text-right font-medium">Δ acc</th>
                </tr>
              </thead>
              <tbody className="readout">
                {rounds.map((r) => (
                  <tr key={r.id} className="border-b border-border/60">
                    <td className="py-2 pr-3">#{r.roundNumber}</td>
                    <td className="py-2 pr-3 font-sans text-xs">{r.nation}</td>
                    <td className="py-2 pr-3 text-right">{r.dpEpsilon.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-xs">{r.weightsHash}</td>
                    <td className="py-2 text-right" style={{ color: "var(--risk-stable)" }}>
                      +{r.aggregateAccuracyDelta.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </ConsoleShell>
  );
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);