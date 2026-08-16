import { createFileRoute, Link } from "@tanstack/react-router";
import { Boxes, BedDouble, CalendarCheck, Mic, ArrowLeftRight, WifiOff, Wifi } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PulseStrip } from "@/components/aegis/pulse-strip";
import { EmptyState, TierBadge, tierVar } from "@/components/aegis/ui";
import { MEDICINES } from "@/lib/aegis/data";
import { buildNationalState } from "@/lib/aegis/engine";
import { classifyStock, daysOfSupply } from "@/lib/aegis/logic";

export const Route = createFileRoute("/field")({
  head: () => ({
    meta: [
      { title: "Field capture — AegisHealth BRICS" },
      {
        name: "description",
        content:
          "Offline-first PHC field app: voice and shelf-audit capture for inventory, beds and attendance, queued locally until connectivity returns.",
      },
      { property: "og:title", content: "Field capture — AegisHealth BRICS" },
      {
        property: "og:description",
        content: "Mobile PHC capture with an offline write queue and live risk tiers.",
      },
    ],
  }),
  component: FieldApp,
});

type Tab = "inventory" | "beds" | "attendance" | "voice" | "rebalancer";

interface QueueItem {
  id: string;
  intent: string;
  payload: string;
  queuedAt: string;
  synced: boolean;
}

const QUEUE_KEY = "aegis.write-queue.v1";

function FieldApp() {
  const state = useMemo(() => buildNationalState(), []);
  const view = state.facilityIndex["phc-anantapur-2"] ?? state.districts[0]!.facilities[0]!;
  const district = state.districts.find((d) => d.id === view.facility.districtId)!;
  const [tab, setTab] = useState<Tab>("voice");
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueueItem[]>([]);

  // hydrate the offline write queue after mount (never during render)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      if (raw) setQueue(JSON.parse(raw) as QueueItem[]);
    } catch {
      /* queue unreadable — start empty rather than block capture */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch {
      /* storage full — entries stay in memory for this session */
    }
  }, [queue]);

  const capture = (intent: string, payload: string) => {
    const item: QueueItem = {
      id: `q-${Date.now()}`,
      intent,
      payload,
      queuedAt: new Date().toISOString(),
      synced: online,
    };
    setQueue((q) => [item, ...q].slice(0, 40));
    if (online) toast.success("Entry recorded", { description: payload });
    else toast.warning("Saved offline", { description: "Queued locally — it uploads when connectivity returns." });
  };

  const flush = () => {
    setOnline(true);
    setQueue((q) => q.map((i) => ({ ...i, synced: true })));
    toast.success("Queue flushed", { description: "Background sync completed — server timestamp wins on conflict." });
  };

  const pending = queue.filter((q) => !q.synced).length;

  return (
    <div className="surface-field min-h-screen pb-24">
      <PulseStrip
        stockRisk={view.risk.stockRisk}
        bedRisk={view.risk.bedRisk}
        staffRisk={view.risk.staffRisk}
        right={
          <button
            onClick={() => (online ? setOnline(false) : flush())}
            className="readout flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px]"
            style={{ color: online ? tierVar("GREEN") : tierVar("AMBER") }}
          >
            {online ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
            {online ? "Online" : `Offline · ${pending}`}
          </button>
        }
      />

      <header className="border-b border-border bg-card px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-semibold">{view.facility.name}</h1>
            <p className="readout text-[11px] text-muted-foreground">
              {district.name} district · PHC_FIELD_STAFF
            </p>
          </div>
          <TierBadge tier={view.risk.tier}>{view.risk.composite.toFixed(2)}</TierBadge>
        </div>
        <Link to="/" className="readout mt-2 inline-block text-[11px] text-primary underline">
          Open officer console
        </Link>
      </header>

      {district.emergencyMode ? (
        <div
          className="px-4 py-2 text-xs font-medium"
          style={{ backgroundColor: tierVar("RED"), color: "white" }}
        >
          {district.name} is in EMERGENCY MODE — 3-day forecast granularity, tightened thresholds, wider dispatch radius.
        </div>
      ) : null}

      <main className="space-y-4 p-4">
        {tab === "voice" ? (
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Voice &amp; shelf capture</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Speak in any supported language — the transcript is parsed into a strict inventory / bed / attendance
              schema before it reaches the ledger.
            </p>
            <button
              onClick={() => capture("INVENTORY", "Received 200 ORS sachets, batch ORS-2291")}
              className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-lg bg-primary text-base font-semibold text-primary-foreground"
            >
              <Mic className="size-5" /> Hold to speak
            </button>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => capture("VISION_SHELF", "Shelf audit — Amoxicillin count 64 caps")}
                className="min-h-12 rounded-lg border border-border bg-background text-sm font-medium"
              >
                Scan shelf
              </button>
              <button
                onClick={() => capture("VISION_WARD", "Ward audit — General ward 27/30 occupied")}
                className="min-h-12 rounded-lg border border-border bg-background text-sm font-medium"
              >
                Scan ward
              </button>
            </div>
            <h3 className="mt-5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Recent entries
            </h3>
            {queue.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Nothing logged yet today — start with a stock receipt or a ward count.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {queue.slice(0, 6).map((q) => (
                  <li key={q.id} className="rounded-md border border-border px-3 py-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="readout text-[10px] uppercase tracking-widest text-muted-foreground">
                        {q.intent}
                      </span>
                      <span
                        className="readout text-[10px]"
                        style={{ color: q.synced ? tierVar("GREEN") : tierVar("AMBER") }}
                      >
                        {q.synced ? "SYNCED" : "QUEUED"}
                      </span>
                    </div>
                    {q.payload}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {tab === "inventory" ? (
          <section className="space-y-2">
            {view.stocks.map((s) => {
              const med = MEDICINES.find((m) => m.id === s.medicineId);
              const cls = classifyStock(s, district.emergencyMode);
              return (
                <div key={s.medicineId} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{med?.name}</span>
                    <TierBadge tier={cls === "EMERGENCY" ? "RED" : cls === "WARNING" ? "AMBER" : "GREEN"}>
                      {daysOfSupply(s).toFixed(1)}d
                    </TierBadge>
                  </div>
                  <p className="readout mt-1 text-xs text-muted-foreground">
                    {s.onHand} {med?.unit} on hand · {s.avgDailyConsumption}/day · lead time {s.leadTimeDays}d
                  </p>
                </div>
              );
            })}
          </section>
        ) : null}

        {tab === "beds" ? (
          <section className="space-y-2">
            {view.beds.map((b) => {
              const occ = (b.occupied / b.total) * 100;
              return (
                <div key={b.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{b.wardType}</span>
                    <span className="readout">
                      {b.occupied}/{b.total} · {occ.toFixed(0)}%
                    </span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-muted">
                    <div
                      className="h-2 rounded-full"
                      style={{
                        width: `${occ}%`,
                        backgroundColor:
                          occ > 95 ? tierVar("RED") : occ > 80 ? tierVar("AMBER") : tierVar("GREEN"),
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}

        {tab === "attendance" ? (
          <section className="space-y-2">
            {view.staff.map((s) => (
              <div key={s.role} className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
                <div>
                  <div className="text-sm font-medium">{s.role}</div>
                  <div className="readout text-xs text-muted-foreground">
                    {s.present} present · {s.minSafeStaffingCount} min safe
                  </div>
                </div>
                <button
                  onClick={() => capture("ATTENDANCE", `${s.role} marked present, covering roster gap`)}
                  className="min-h-12 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
                >
                  Mark present
                </button>
              </div>
            ))}
          </section>
        ) : null}

        {tab === "rebalancer" ? (
          <section className="space-y-2">
            {state.manifests.filter((m) => m.destFacilityId === view.facility.id).length === 0 ? (
              <EmptyState>No inbound transfers — this facility is balanced.</EmptyState>
            ) : (
              state.manifests
                .filter((m) => m.destFacilityId === view.facility.id)
                .map((m) => (
                  <div key={m.id} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex justify-between gap-2 text-sm">
                      <span className="font-medium">
                        {m.quantity} × {m.label}
                      </span>
                      <span className="readout text-xs text-muted-foreground">ETA {m.etaHours.toFixed(1)}h</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      From {state.facilityIndex[m.sourceFacilityId]?.facility.name} · {m.distanceKm.toFixed(1)} km
                    </p>
                  </div>
                ))
            )}
          </section>
        ) : null}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-card">
        {(
          [
            ["inventory", "Inv", Boxes],
            ["beds", "Bed", BedDouble],
            ["attendance", "Att", CalendarCheck],
            ["voice", "Voice", Mic],
            ["rebalancer", "Rebal", ArrowLeftRight],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="flex min-h-14 flex-col items-center justify-center gap-1 text-[11px]"
            style={{ color: tab === id ? "var(--primary)" : "var(--muted-foreground)" }}
            aria-current={tab === id}
          >
            <Icon className="size-5" />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}