import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { Boxes, BedDouble, CalendarCheck, Mic, ArrowLeftRight, WifiOff, Wifi, Camera, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PulseStrip } from "@/components/aegis/pulse-strip";
import { EmptyState, ErrorState, LoadingState, TierBadge, tierVar } from "@/components/aegis/ui";
import { MEDICINES, WARD_TYPES } from "@/lib/aegis/data";
import { classifyStock, daysOfSupply } from "@/lib/aegis/logic";
import { useInvalidateNationalState, useNationalState } from "@/lib/aegis/use-national-state";
import { captureShelfPhoto, captureVoice, captureWardPhoto, markAttendance } from "@/server-fn/aegis";

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
  /** Present only for voice entries — lets flush() actually replay the capture once back online, not just flip a flag. */
  transcript?: string;
}

const QUEUE_KEY = "aegis.write-queue.v1";
const LANGUAGES = [
  { code: "en-IN", label: "English (IN)" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "pt-BR", label: "Português" },
  { code: "en-US", label: "English (US)" },
] as const;

function describeParsed(parsed: Record<string, unknown>): string {
  const intent = parsed.intent as string | undefined;
  if (intent === "INVENTORY") {
    const med = MEDICINES.find((m) => m.id === parsed.medicineId)?.name ?? String(parsed.medicineId ?? "medicine");
    return `${parsed.type ?? "INFLOW"} ${parsed.quantityChange ?? "?"} × ${med}`;
  }
  if (intent === "BED") return `${parsed.wardType ?? "ward"} — ${parsed.bedsOccupied ?? "?"} occupied`;
  if (intent === "ATTENDANCE") return `${parsed.role ?? "staff"} marked ${parsed.status ?? "PRESENT"}`;
  return "Could not classify this entry — try rephrasing or use a specific tab instead.";
}

function fileToBase64(file: File): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      resolve({ base64, mimeType: file.type || "image/jpeg" });
    };
    reader.onerror = () => reject(new Error("Could not read the captured photo."));
    reader.readAsDataURL(file);
  });
}

function FieldApp() {
  const { data: state, isLoading, error } = useNationalState();
  const invalidate = useInvalidateNationalState();
  const [tab, setTab] = useState<Tab>("voice");
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [typedTranscript, setTypedTranscript] = useState("");
  const [lang, setLang] = useState<(typeof LANGUAGES)[number]["code"]>("en-IN");
  const [selectedMedicineId, setSelectedMedicineId] = useState(MEDICINES[0]!.id);
  const [selectedWardType, setSelectedWardType] = useState<(typeof WARD_TYPES)[number]>(WARD_TYPES[0]!);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const shelfInputRef = useRef<HTMLInputElement>(null);
  const wardInputRef = useRef<HTMLInputElement>(null);

  // real connectivity, not just a demo flag — SSR-safe (navigator doesn't exist server-side)
  useEffect(() => {
    setOnline(navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

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

  const facilityId = state?.facilityIndex["phc-anantapur-2"] ? "phc-anantapur-2" : state?.districts[0]?.facilities[0]?.facility.id;

  const voiceMutation = useMutation({
    mutationFn: (transcript: string) => {
      if (!facilityId) throw new Error("No facility loaded yet");
      return captureVoice({ data: { facilityId, transcript } });
    },
  });
  const shelfMutation = useMutation({
    mutationFn: (args: { base64Image: string; mimeType: string; medicineId: string }) => {
      if (!facilityId) throw new Error("No facility loaded yet");
      return captureShelfPhoto({ data: { facilityId, ...args } });
    },
  });
  const wardMutation = useMutation({
    mutationFn: (args: { base64Image: string; mimeType: string; wardType: string }) => {
      if (!facilityId) throw new Error("No facility loaded yet");
      return captureWardPhoto({ data: { facilityId, ...args } });
    },
  });
  const attendanceMutation = useMutation({
    mutationFn: (args: { role: "Doctor" | "Nurse" | "ANM" | "Pharmacist"; status: "PRESENT" | "ABSENT" | "COVERING" }) => {
      if (!facilityId) throw new Error("No facility loaded yet");
      return markAttendance({ data: { facilityId, ...args } });
    },
  });

  if (isLoading || !state || !facilityId) {
    return (
      <div className="surface-field flex min-h-screen items-center justify-center">
        <LoadingState>Loading facility…</LoadingState>
      </div>
    );
  }
  if (error) {
    return (
      <div className="surface-field flex min-h-screen items-center justify-center p-4">
        <ErrorState error={error} />
      </div>
    );
  }

  const view = state.facilityIndex[facilityId]!;
  const district = state.districts.find((d) => d.id === view.facility.districtId)!;

  const enqueue = (item: QueueItem) => setQueue((q) => [item, ...q].slice(0, 40));

  const submitVoice = (transcript: string) => {
    const trimmed = transcript.trim();
    if (!trimmed) return;
    if (!online) {
      enqueue({ id: `q-${Date.now()}`, intent: "VOICE", payload: trimmed, transcript: trimmed, queuedAt: new Date().toISOString(), synced: false });
      toast.warning("Saved offline", { description: "Queued locally — it's sent to Gemini for parsing when connectivity returns." });
      setLiveTranscript("");
      setTypedTranscript("");
      return;
    }
    voiceMutation.mutate(trimmed, {
      onSuccess: (parsed) => {
        enqueue({ id: `q-${Date.now()}`, intent: (parsed.intent as string) ?? "VOICE", payload: describeParsed(parsed), transcript: trimmed, queuedAt: new Date().toISOString(), synced: true });
        toast.success("Entry recorded", { description: describeParsed(parsed) });
        void invalidate();
      },
      onError: (err) => toast.error("Voice parsing failed", { description: err instanceof Error ? err.message : "Unknown error" }),
    });
    setLiveTranscript("");
    setTypedTranscript("");
  };

  const startRecording = () => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      toast.error("Mic capture unsupported here", { description: "Try Chrome on Android, or use \"Type it instead\" below." });
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;
    let finalTranscript = "";
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const chunk = result[0]?.transcript ?? "";
        if (result.isFinal) finalTranscript += chunk;
        else interim += chunk;
      }
      setLiveTranscript((finalTranscript + " " + interim).trim());
    };
    recognition.onerror = () => {
      toast.error("Mic error", { description: "Check microphone permission and try again." });
      setIsRecording(false);
    };
    recognition.onend = () => {
      setIsRecording(false);
      if (finalTranscript.trim()) submitVoice(finalTranscript);
    };
    recognitionRef.current = recognition;
    setIsRecording(true);
    setLiveTranscript("");
    recognition.start();
  };

  const stopRecording = () => recognitionRef.current?.stop();

  const handleShelfFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!online) {
      toast.warning("Shelf scan needs connectivity", { description: "The photo is analysed by Gemini server-side — reconnect to scan." });
      return;
    }
    const { base64, mimeType } = await fileToBase64(file);
    const medicineName = MEDICINES.find((m) => m.id === selectedMedicineId)?.name ?? selectedMedicineId;
    toast.loading("Reading shelf photo…", { id: "shelf-audit" });
    shelfMutation.mutate(
      { base64Image: base64, mimeType, medicineId: selectedMedicineId },
      {
        onSuccess: (parsed) => {
          toast.dismiss("shelf-audit");
          const mismatch = parsed.mismatchFlag ? " ⚠ mismatch vs. ledger" : "";
          const desc = `${medicineName}: counted ${parsed.boxesCounted ?? "?"}${mismatch}`;
          enqueue({ id: `q-${Date.now()}`, intent: "VISION_SHELF", payload: desc, queuedAt: new Date().toISOString(), synced: true });
          toast.success("Shelf audited", { description: desc });
          void invalidate();
        },
        onError: (err) => {
          toast.dismiss("shelf-audit");
          toast.error("Shelf audit failed", { description: err instanceof Error ? err.message : "Unknown error" });
        },
      },
    );
  };

  const handleWardFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!online) {
      toast.warning("Ward scan needs connectivity", { description: "The photo is analysed by Gemini server-side — reconnect to scan." });
      return;
    }
    const { base64, mimeType } = await fileToBase64(file);
    toast.loading("Reading ward photo…", { id: "ward-audit" });
    wardMutation.mutate(
      { base64Image: base64, mimeType, wardType: selectedWardType },
      {
        onSuccess: (parsed) => {
          toast.dismiss("ward-audit");
          const mismatch = parsed.mismatchFlag ? " ⚠ mismatch vs. ledger" : "";
          const desc = `${selectedWardType} ward: ${parsed.occupiedEstimate ?? "?"} occupied${mismatch}`;
          enqueue({ id: `q-${Date.now()}`, intent: "VISION_WARD", payload: desc, queuedAt: new Date().toISOString(), synced: true });
          toast.success("Ward audited", { description: desc });
          void invalidate();
        },
        onError: (err) => {
          toast.dismiss("ward-audit");
          toast.error("Ward audit failed", { description: err instanceof Error ? err.message : "Unknown error" });
        },
      },
    );
  };

  const markPresent = (role: "Doctor" | "Nurse" | "ANM" | "Pharmacist") => {
    attendanceMutation.mutate(
      { role, status: "PRESENT" },
      {
        onSuccess: () => {
          toast.success("Marked present", { description: `${role} — covering roster gap` });
          void invalidate();
        },
        onError: (err) => toast.error("Couldn't update roster", { description: err instanceof Error ? err.message : "Unknown error" }),
      },
    );
  };

  const flush = async () => {
    setOnline(true);
    const unsynced = queue.filter((q) => !q.synced);
    for (const item of unsynced) {
      if (!item.transcript) {
        setQueue((q) => q.map((i) => (i.id === item.id ? { ...i, synced: true } : i)));
        continue;
      }
      try {
        const parsed = await captureVoice({ data: { facilityId, transcript: item.transcript } });
        setQueue((q) => q.map((i) => (i.id === item.id ? { ...i, synced: true, payload: describeParsed(parsed) } : i)));
      } catch {
        // stays unsynced — the next flush (or reconnect) retries it, server timestamp wins on conflict
      }
    }
    void invalidate();
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
            onClick={() => (online ? setOnline(false) : void flush())}
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
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Voice &amp; shelf capture</h2>
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value as (typeof LANGUAGES)[number]["code"])}
                className="readout rounded-sm border border-border bg-background px-2 py-1 text-[11px]"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Browser speech recognition transcribes what you say in the selected language; Gemini then classifies
              the transcript into a strict inventory / bed / attendance schema before it reaches the ledger.
            </p>

            <button
              onMouseDown={startRecording}
              onMouseUp={stopRecording}
              onTouchStart={startRecording}
              onTouchEnd={stopRecording}
              disabled={voiceMutation.isPending}
              className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-lg text-base font-semibold text-primary-foreground disabled:opacity-60"
              style={{ backgroundColor: isRecording ? "var(--risk-critical)" : "var(--primary)" }}
            >
              {isRecording ? <Square className="size-5" /> : <Mic className="size-5" />}
              {isRecording ? "Release to send" : voiceMutation.isPending ? "Parsing…" : "Hold to speak"}
            </button>
            {liveTranscript ? <p className="mt-2 text-xs italic text-muted-foreground">"{liveTranscript}"</p> : null}

            <div className="mt-3 flex gap-2">
              <input
                value={typedTranscript}
                onChange={(e) => setTypedTranscript(e.target.value)}
                placeholder='Or type it — e.g. "Received 200 ORS sachets"'
                className="min-h-11 flex-1 rounded-lg border border-border bg-background px-3 text-sm"
              />
              <button
                onClick={() => submitVoice(typedTranscript)}
                disabled={!typedTranscript.trim() || voiceMutation.isPending}
                className="min-h-11 rounded-lg border border-border px-3 text-sm font-medium disabled:opacity-50"
              >
                Parse
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <div>
                <select
                  value={selectedMedicineId}
                  onChange={(e) => setSelectedMedicineId(e.target.value)}
                  className="readout mb-1.5 w-full rounded-sm border border-border bg-background px-2 py-1 text-[11px]"
                >
                  {MEDICINES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => shelfInputRef.current?.click()}
                  disabled={shelfMutation.isPending}
                  className="flex min-h-12 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-background text-sm font-medium disabled:opacity-60"
                >
                  <Camera className="size-4" /> Scan shelf
                </button>
                <input ref={shelfInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleShelfFile} />
              </div>
              <div>
                <select
                  value={selectedWardType}
                  onChange={(e) => setSelectedWardType(e.target.value as (typeof WARD_TYPES)[number])}
                  className="readout mb-1.5 w-full rounded-sm border border-border bg-background px-2 py-1 text-[11px]"
                >
                  {WARD_TYPES.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => wardInputRef.current?.click()}
                  disabled={wardMutation.isPending}
                  className="flex min-h-12 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-background text-sm font-medium disabled:opacity-60"
                >
                  <Camera className="size-4" /> Scan ward
                </button>
                <input ref={wardInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleWardFile} />
              </div>
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
                  onClick={() => markPresent(s.role)}
                  disabled={attendanceMutation.isPending}
                  className="min-h-12 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
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
