/**
 * Data access layer — the ONLY place that knows about snake_case columns.
 * Everything downstream (logic.ts, engine.ts, every route) keeps working
 * against the exact same AegisDataset / camelCase shapes as before; this
 * file's job is purely to fill that shape from real rows instead of
 * buildDataset()'s seeded mock, and to write mutations back.
 *
 * Server-only (imports supabaseServer). Called exclusively from
 * src/server-fn/aegis.ts.
 */
import { supabaseServer } from "@/lib/supabase/server";
import { MEDICINES, WARD_TYPES } from "./data";
import type { AegisDataset } from "./data";
import type { Bed, District, Facility, FlRound, StaffRoster, StockSnapshot } from "./types";

type Db = ReturnType<typeof supabaseServer>;

/** Manifest.label is the medicine's display name (engine.ts sets label: med.name) — resolve it back to an id. */
async function shiftStock(db: Db, sourceFacilityId: string, destFacilityId: string, label: string, quantity: number) {
  const medicine = MEDICINES.find((m) => m.name === label);
  if (!medicine) return; // label didn't match a known medicine — nothing safe to move
  const [source, dest] = await Promise.all([
    db.from("stock_snapshot").select("on_hand").eq("facility_id", sourceFacilityId).eq("medicine_id", medicine.id).maybeSingle(),
    db.from("stock_snapshot").select("on_hand").eq("facility_id", destFacilityId).eq("medicine_id", medicine.id).maybeSingle(),
  ]);
  const sourceOnHand = (source.data?.on_hand as number | undefined) ?? 0;
  const destOnHand = (dest.data?.on_hand as number | undefined) ?? 0;
  const moved = Math.min(quantity, sourceOnHand);
  await Promise.all([
    db.from("stock_snapshot").update({ on_hand: Math.max(0, sourceOnHand - moved), updated_at: new Date().toISOString() })
      .eq("facility_id", sourceFacilityId).eq("medicine_id", medicine.id),
    db.from("stock_snapshot").update({ on_hand: destOnHand + moved, updated_at: new Date().toISOString() })
      .eq("facility_id", destFacilityId).eq("medicine_id", medicine.id),
  ]);
}

/** Manifest.label is `${wardType} ward beds` (engine.ts) — moves `occupied` source -> dest, see the direction note above. */
async function shiftBedOccupied(db: Db, sourceFacilityId: string, destFacilityId: string, label: string, quantity: number) {
  const wardType = WARD_TYPES.find((w) => label.startsWith(w));
  if (!wardType) return;
  const [source, dest] = await Promise.all([
    db.from("beds").select("occupied").eq("facility_id", sourceFacilityId).eq("ward_type", wardType).maybeSingle(),
    db.from("beds").select("occupied,total").eq("facility_id", destFacilityId).eq("ward_type", wardType).maybeSingle(),
  ]);
  const sourceOcc = (source.data?.occupied as number | undefined) ?? 0;
  const destOcc = (dest.data?.occupied as number | undefined) ?? 0;
  const destTotal = (dest.data?.total as number | undefined) ?? destOcc + quantity;
  const moved = Math.min(quantity, sourceOcc, Math.max(0, destTotal - destOcc));
  await Promise.all([
    db.from("beds").update({ occupied: Math.max(0, sourceOcc - moved), updated_at: new Date().toISOString() })
      .eq("facility_id", sourceFacilityId).eq("ward_type", wardType),
    db.from("beds").update({ occupied: destOcc + moved, updated_at: new Date().toISOString() })
      .eq("facility_id", destFacilityId).eq("ward_type", wardType),
  ]);
}

/**
 * engine.ts's staff matching works on an aggregate headcount across all four
 * roles, not a specific role — so on approval we move the quantity out of
 * the source's single most-overstaffed role and into the dest's single
 * most-understaffed role. An approximation, consistent with the aggregate
 * level the existing matching algorithm already operates at.
 */
async function shiftStaffPresent(db: Db, sourceFacilityId: string, destFacilityId: string, quantity: number) {
  const [source, dest] = await Promise.all([
    db.from("staff_roster").select("*").eq("facility_id", sourceFacilityId),
    db.from("staff_roster").select("*").eq("facility_id", destFacilityId),
  ]);
  const sourceRows = (source.data ?? []) as { role: string; present: number; min_safe_staffing_count: number }[];
  const destRows = (dest.data ?? []) as { role: string; present: number; min_safe_staffing_count: number }[];
  const givingRole = [...sourceRows].sort((a, b) => b.present - b.min_safe_staffing_count - (a.present - a.min_safe_staffing_count))[0];
  const receivingRole = [...destRows].sort((a, b) => (a.present - a.min_safe_staffing_count) - (b.present - b.min_safe_staffing_count))[0];
  if (!givingRole || !receivingRole) return;
  const moved = Math.min(quantity, Math.max(0, givingRole.present - givingRole.min_safe_staffing_count));
  if (moved <= 0) return;
  await Promise.all([
    db.from("staff_roster").update({ present: givingRole.present - moved, updated_at: new Date().toISOString() })
      .eq("facility_id", sourceFacilityId).eq("role", givingRole.role),
    db.from("staff_roster").update({ present: receivingRole.present + moved, updated_at: new Date().toISOString() })
      .eq("facility_id", destFacilityId).eq("role", receivingRole.role),
  ]);
}

export async function fetchDataset(): Promise<AegisDataset> {
  const db = supabaseServer();

  const [districtsRes, facilitiesRes, stocksRes, bedsRes, staffRes, historyRes, flRoundsRes] = await Promise.all([
    db.from("districts").select("*"),
    db.from("facilities").select("*"),
    db.from("stock_snapshot").select("*"),
    db.from("beds").select("*"),
    db.from("staff_roster").select("*"),
    // 120 days is enough for logic.ts's forecastDemand() cold-start check (>=90d).
    db.from("stock_history").select("*").order("day", { ascending: true }).limit(20000),
    db.from("fl_rounds").select("*").order("round_number", { ascending: false }).limit(200),
  ]);

  for (const [name, res] of Object.entries({
    districts: districtsRes,
    facilities: facilitiesRes,
    stocks: stocksRes,
    beds: bedsRes,
    staff: staffRes,
    history: historyRes,
    flRounds: flRoundsRes,
  })) {
    if (res.error) throw new Error(`fetchDataset: ${name} query failed — ${res.error.message}`);
  }

  const districts: District[] = (districtsRes.data ?? []).map((d) => ({
    id: d.id as string,
    name: d.name as string,
    stateId: d.state_id as string,
    emergencyMode: d.emergency_mode as boolean,
    redHoursStreak: d.red_hours_streak as number,
  }));

  const facilities: Facility[] = (facilitiesRes.data ?? []).map((f) => ({
    id: f.id as string,
    name: f.name as string,
    type: f.type as Facility["type"],
    districtId: f.district_id as string,
    stateId: f.state_id as string,
    nationId: f.nation_id as string,
    lat: f.lat as number,
    lng: f.lng as number,
    catchmentPopulation: f.catchment_population as number,
  }));

  const stocks: StockSnapshot[] = (stocksRes.data ?? []).map((s) => ({
    facilityId: s.facility_id as string,
    medicineId: s.medicine_id as string,
    onHand: s.on_hand as number,
    onOrder: s.on_order as number,
    backorder: s.backorder as number,
    avgDailyConsumption: s.avg_daily_consumption as number,
    sigmaDemand: s.sigma_demand as number,
    leadTimeDays: s.lead_time_days as number,
    updatedAt: s.updated_at as string,
  }));

  const beds: Bed[] = (bedsRes.data ?? []).map((b) => ({
    id: b.id as string,
    facilityId: b.facility_id as string,
    wardType: b.ward_type as Bed["wardType"],
    total: b.total as number,
    occupied: b.occupied as number,
  }));

  const staff: StaffRoster[] = (staffRes.data ?? []).map((s) => ({
    facilityId: s.facility_id as string,
    role: s.role as StaffRoster["role"],
    present: s.present as number,
    minSafeStaffingCount: s.min_safe_staffing_count as number,
  }));

  const history: Record<string, number[]> = {};
  for (const row of historyRes.data ?? []) {
    const key = `${row.facility_id as string}:${row.medicine_id as string}`;
    (history[key] ??= []).push(row.consumption as number);
  }

  const flRounds: FlRound[] = (flRoundsRes.data ?? []).map((r) => ({
    id: r.id as string,
    roundNumber: r.round_number as number,
    nationId: r.nation_id as string,
    nation: r.nation as string,
    dpEpsilon: r.dp_epsilon as number,
    weightsHash: r.weights_hash as string,
    aggregateAccuracyDelta: r.aggregate_accuracy_delta as number,
    timestamp: r.created_at as string,
  }));

  return { facilities, districts, stocks, beds, staff, history, flRounds };
}

/** Approve & Dispatch — the only place a manifest's status actually changes. */
export async function approveManifestInDb(manifest: {
  id: string;
  resourceType: string;
  label: string;
  sourceFacilityId: string;
  destFacilityId: string;
  quantity: number;
  distanceKm: number;
  etaHours: number;
  severity: number;
  daysToStockout: number;
  rationale: string;
}, actorId: string | null) {
  const db = supabaseServer();
  const signatureToken = `SIG-${manifest.id.slice(3, 12)}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;

  // Upsert because manifests are recomputed by the matching algorithm on each
  // read rather than persisted ahead of time — the row is created here, at
  // the moment of approval, which is also the moment it needs to be durable.
  const { error } = await db.from("dispatch_manifests").upsert(
    {
      id: manifest.id,
      resource_type: manifest.resourceType,
      label: manifest.label,
      source_facility_id: manifest.sourceFacilityId,
      dest_facility_id: manifest.destFacilityId,
      quantity: manifest.quantity,
      distance_km: manifest.distanceKm,
      eta_hours: manifest.etaHours,
      severity: manifest.severity,
      days_to_stockout: manifest.daysToStockout,
      rationale: manifest.rationale,
      status: "APPROVED",
      signature_token: signatureToken,
      approved_by: actorId,
      approved_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(`approveManifestInDb failed: ${error.message}`);

  // Move the resource for real. Without this, the deficit that produced the
  // manifest is still a deficit on the next fetch — since manifests are
  // recomputed from live figures rather than stored ahead of time (see the
  // comment above), approval would otherwise just relabel a status flag
  // while the same shortage regenerates a fresh manifest next poll.
  //
  // NOTE on BED direction: this moves the quantity source -> dest exactly as
  // the manifest states, mirroring engine.ts's existing convention (surplus
  // facility = source, deficit facility = dest) uniformly across all three
  // resource types. For MEDICINE and STAFF that's unambiguous. For BED,
  // "surplus capacity facility -> over-occupied facility" doesn't literally
  // move beds — the master prompt's intent was patient-transfer routing
  // (patients move FROM the over-occupied facility TO the facility with
  // capacity), which is the reverse direction. Flagged, not silently
  // changed — decide which you want and adjust here + the deficit/surplus
  // push order in engine.ts's bed loop together.
  if (manifest.resourceType === "MEDICINE") {
    await shiftStock(db, manifest.sourceFacilityId, manifest.destFacilityId, manifest.label, manifest.quantity);
  } else if (manifest.resourceType === "STAFF") {
    await shiftStaffPresent(db, manifest.sourceFacilityId, manifest.destFacilityId, manifest.quantity);
  } else if (manifest.resourceType === "BED") {
    await shiftBedOccupied(db, manifest.sourceFacilityId, manifest.destFacilityId, manifest.label, manifest.quantity);
  }

  await db.from("audit_log").insert({
    entity: "dispatch_manifests",
    entity_id: manifest.id,
    action: "APPROVE",
    actor: actorId,
    after: { status: "APPROVED", signatureToken },
  });

  return { signatureToken };
}

export async function insertFlRounds(rounds: FlRound[]) {
  const db = supabaseServer();
  const { error } = await db.from("fl_rounds").upsert(
    rounds.map((r) => ({
      id: r.id,
      round_number: r.roundNumber,
      nation_id: r.nationId,
      nation: r.nation,
      dp_epsilon: r.dpEpsilon,
      weights_hash: r.weightsHash,
      aggregate_accuracy_delta: r.aggregateAccuracyDelta,
      created_at: r.timestamp,
    })),
    { onConflict: "id" },
  );
  if (error) throw new Error(`insertFlRounds failed: ${error.message}`);
}

/** Fetch just the ids of manifests already approved, so the engine can filter them out of "pending". */
export async function fetchApprovedManifestIds(): Promise<Set<string>> {
  const db = supabaseServer();
  const { data, error } = await db.from("dispatch_manifests").select("id").eq("status", "APPROVED");
  if (error) throw new Error(`fetchApprovedManifestIds failed: ${error.message}`);
  return new Set((data ?? []).map((r) => r.id as string));
}

export async function getStockOnHand(facilityId: string, medicineId: string): Promise<number> {
  const db = supabaseServer();
  const { data } = await db
    .from("stock_snapshot")
    .select("on_hand")
    .eq("facility_id", facilityId)
    .eq("medicine_id", medicineId)
    .maybeSingle();
  return (data?.on_hand as number | undefined) ?? 0;
}

export async function getBedOccupied(facilityId: string, wardType: string): Promise<number> {
  const db = supabaseServer();
  const { data } = await db
    .from("beds")
    .select("occupied")
    .eq("facility_id", facilityId)
    .eq("ward_type", wardType)
    .maybeSingle();
  return (data?.occupied as number | undefined) ?? 0;
}

/** Direct structured write for the "Mark present" tap — no Gemini call needed when the role is already known. */
export async function markAttendanceDirect(facilityId: string, role: StaffRoster["role"], status: "PRESENT" | "ABSENT" | "COVERING") {
  const db = supabaseServer();
  await db.from("attendance_log").insert({ facility_id: facilityId, role, status, source: "MANUAL" });
  if (status === "PRESENT" || status === "COVERING") {
    const { data: current } = await db
      .from("staff_roster")
      .select("present")
      .eq("facility_id", facilityId)
      .eq("role", role)
      .maybeSingle();
    const present = (current?.present as number | undefined) ?? 0;
    await db
      .from("staff_roster")
      .update({ present: present + 1, updated_at: new Date().toISOString() })
      .eq("facility_id", facilityId)
      .eq("role", role);
  }
}

interface CaptureRecord {
  facilityId: string;
  kind: "VOICE" | "VISION_SHELF" | "VISION_WARD";
  rawTranscript?: string;
  parsed: unknown;
  confidence: number;
}

/** Log the raw + structured capture, then apply the structured update to the live tables. */
export async function recordAndApplyCapture(rec: CaptureRecord) {
  const db = supabaseServer();

  const { data: inserted, error: insertErr } = await db
    .from("captures")
    .insert({
      facility_id: rec.facilityId,
      kind: rec.kind,
      raw_transcript: rec.rawTranscript ?? null,
      parsed: rec.parsed,
      confidence: rec.confidence,
      applied: false,
    })
    .select("id")
    .single();
  if (insertErr) throw new Error(`recordAndApplyCapture insert failed: ${insertErr.message}`);

  const parsed = rec.parsed as Record<string, unknown>;

  if (rec.kind === "VOICE" || rec.kind === "VISION_SHELF") {
    const intent = parsed.intent as string | undefined;
    if (intent === "INVENTORY" || rec.kind === "VISION_SHELF") {
      const medicineId = parsed.medicineId as string | undefined;
      const quantityChange = Number(parsed.quantityChange ?? 0);
      const type = (parsed.type as string | undefined) ?? "INFLOW";
      if (medicineId && quantityChange) {
        const { data: current } = await db
          .from("stock_snapshot")
          .select("on_hand")
          .eq("facility_id", rec.facilityId)
          .eq("medicine_id", medicineId)
          .maybeSingle();
        const onHand = (current?.on_hand as number | undefined) ?? 0;
        const delta = type === "OUTFLOW" ? -Math.abs(quantityChange) : Math.abs(quantityChange);
        await db
          .from("stock_snapshot")
          .update({ on_hand: Math.max(0, onHand + delta), updated_at: new Date().toISOString() })
          .eq("facility_id", rec.facilityId)
          .eq("medicine_id", medicineId);
      }
    } else if (intent === "BED") {
      const wardType = parsed.wardType as string | undefined;
      const bedsOccupied = parsed.bedsOccupied as number | undefined;
      if (wardType && bedsOccupied !== undefined) {
        await db
          .from("beds")
          .update({ occupied: bedsOccupied, updated_at: new Date().toISOString() })
          .eq("facility_id", rec.facilityId)
          .eq("ward_type", wardType);
      }
    } else if (intent === "ATTENDANCE") {
      const role = parsed.role as StaffRoster["role"] | undefined;
      const status = (parsed.status as string | undefined) ?? "PRESENT";
      if (role) {
        await db.from("attendance_log").insert({
          facility_id: rec.facilityId,
          role,
          status,
          covering_for: parsed.coveringForRole ?? null,
          source: rec.kind === "VOICE" ? "VOICE" : "MANUAL",
        });
        if (status === "PRESENT" || status === "COVERING") {
          const { data: current } = await db
            .from("staff_roster")
            .select("present")
            .eq("facility_id", rec.facilityId)
            .eq("role", role)
            .maybeSingle();
          const present = (current?.present as number | undefined) ?? 0;
          await db
            .from("staff_roster")
            .update({ present: present + 1, updated_at: new Date().toISOString() })
            .eq("facility_id", rec.facilityId)
            .eq("role", role);
        }
      }
    }
  } else if (rec.kind === "VISION_WARD") {
    const wardType = parsed.wardType as string | undefined;
    const occupiedEstimate = parsed.occupiedEstimate as number | undefined;
    if (wardType && occupiedEstimate !== undefined) {
      await db
        .from("beds")
        .update({ occupied: occupiedEstimate, updated_at: new Date().toISOString() })
        .eq("facility_id", rec.facilityId)
        .eq("ward_type", wardType);
    }
  }

  if (inserted?.id) {
    await db.from("captures").update({ applied: true }).eq("id", inserted.id as number);
  }
}
