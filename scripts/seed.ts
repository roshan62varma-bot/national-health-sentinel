/**
 * Loads the existing seeded scenario (buildDataset() in src/lib/aegis/data.ts —
 * Anantapur stressed, Kurnool healthy, Chittoor mixed) into real Supabase
 * tables, so the demo data becomes persisted rows instead of an in-memory
 * mock regenerated on every page load.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/seed.ts
 *
 * Safe to re-run — every insert is an upsert keyed on the same deterministic
 * ids buildDataset() always produces for a given seed.
 */
import { createClient } from "@supabase/supabase-js";
import { buildDataset, MEDICINES, WARD_TYPES, STAFF_ROLES } from "../src/lib/aegis/data";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running the seed script.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

async function main() {
  const dataset = buildDataset(42);

  console.log("Seeding nations/states...");
  await upsert("nations", [{ id: "nat-in", name: "India" }]);
  await upsert("states", [{ id: "st-ap", name: "Andhra Pradesh", nation_id: "nat-in" }]);

  console.log(`Seeding ${dataset.districts.length} districts...`);
  await upsert(
    "districts",
    dataset.districts.map((d) => ({
      id: d.id,
      name: d.name,
      state_id: d.stateId,
      emergency_mode: d.emergencyMode,
      red_hours_streak: d.redHoursStreak,
    })),
  );

  console.log(`Seeding ${dataset.facilities.length} facilities...`);
  await upsert(
    "facilities",
    dataset.facilities.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      district_id: f.districtId,
      state_id: f.stateId,
      nation_id: f.nationId,
      lat: f.lat,
      lng: f.lng,
      catchment_population: f.catchmentPopulation,
    })),
  );

  console.log(`Seeding ${MEDICINES.length} medicines...`);
  await upsert(
    "medicines",
    MEDICINES.map((m) => ({ id: m.id, name: m.name, who_essential: m.whoEssential, unit: m.unit })),
  );

  console.log(`Seeding ${dataset.stocks.length} stock snapshot rows...`);
  await upsert(
    "stock_snapshot",
    dataset.stocks.map((s) => ({
      facility_id: s.facilityId,
      medicine_id: s.medicineId,
      on_hand: s.onHand,
      on_order: s.onOrder,
      backorder: s.backorder,
      avg_daily_consumption: s.avgDailyConsumption,
      sigma_demand: s.sigmaDemand,
      lead_time_days: s.leadTimeDays,
      updated_at: s.updatedAt,
    })),
  );

  console.log("Seeding 120-day consumption history (this is the largest table)...");
  const historyRows: { facility_id: string; medicine_id: string; day: string; consumption: number }[] = [];
  const today = new Date();
  for (const [key, series] of Object.entries(dataset.history)) {
    const [facilityId, medicineId] = key.split(":");
    if (!facilityId || !medicineId) continue;
    series.forEach((consumption, i) => {
      const day = new Date(today);
      day.setDate(day.getDate() - (series.length - 1 - i));
      historyRows.push({
        facility_id: facilityId,
        medicine_id: medicineId,
        day: day.toISOString().slice(0, 10),
        consumption,
      });
    });
  }
  await upsert("stock_history", historyRows, "facility_id,medicine_id,day");

  console.log(`Seeding ${dataset.beds.length} bed rows across ${WARD_TYPES.length} ward types...`);
  await upsert(
    "beds",
    dataset.beds.map((b) => ({
      id: b.id,
      facility_id: b.facilityId,
      ward_type: b.wardType,
      total: b.total,
      occupied: b.occupied,
    })),
  );

  console.log(`Seeding ${dataset.staff.length} roster rows across ${STAFF_ROLES.length} roles...`);
  await upsert(
    "staff_roster",
    dataset.staff.map((s) => ({
      facility_id: s.facilityId,
      role: s.role,
      present: s.present,
      min_safe_staffing_count: s.minSafeStaffingCount,
    })),
  );

  console.log(`Seeding ${dataset.flRounds.length} FL rounds...`);
  await upsert(
    "fl_rounds",
    dataset.flRounds.map((r) => ({
      id: r.id,
      round_number: r.roundNumber,
      nation_id: r.nationId,
      nation: r.nation,
      dp_epsilon: r.dpEpsilon,
      weights_hash: r.weightsHash,
      aggregate_accuracy_delta: r.aggregateAccuracyDelta,
      created_at: r.timestamp,
    })),
  );

  console.log("Done. Facility ids you can sign field-staff test accounts into:");
  console.log(dataset.facilities.slice(0, 3).map((f) => f.id).join(", "), "...");
}

async function upsert(table: string, rows: Record<string, unknown>[], onConflict?: string) {
  if (rows.length === 0) return;
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).upsert(chunk, onConflict ? { onConflict } : undefined);
    if (error) throw new Error(`Seeding ${table} failed: ${error.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
