/** Derived national state: runs the Section 3 logic over the seeded dataset. */
import { buildDataset, MEDICINES, type AegisDataset } from "./data";
import {
  CONFIG,
  classifyStock,
  computeRisk,
  daysOfSupply,
  forecastDemand,
  matchRedistribution,
  occupancyPct,
  reorderPoint,
  ropDays,
  shouldEscalate,
  tierOf,
} from "./logic";
import type { Bed, DispatchManifest, Facility, RiskScore, StaffRoster, StockSnapshot, Tier } from "./types";

export interface FacilityView {
  facility: Facility;
  risk: RiskScore;
  stocks: StockSnapshot[];
  beds: Bed[];
  staff: StaffRoster[];
  occupancy: number;
  worstMedicine: { name: string; dos: number } | null;
}

export interface DistrictView {
  id: string;
  name: string;
  emergencyMode: boolean;
  redHoursStreak: number;
  facilities: FacilityView[];
  redPct: number;
  composite: number;
  tier: Tier;
}

export interface NationalState {
  dataset: AegisDataset;
  districts: DistrictView[];
  facilityIndex: Record<string, FacilityView>;
  manifests: DispatchManifest[];
  national: { composite: number; tier: Tier; redFacilities: number; totalFacilities: number; occupancy: number; stockoutIn24h: number };
}

export function buildNationalState(seed = 42): NationalState {
  const dataset = buildDataset(seed);
  const byFacility = <T extends { facilityId: string }>(rows: T[]) => {
    const m: Record<string, T[]> = {};
    for (const r of rows) (m[r.facilityId] ??= []).push(r);
    return m;
  };
  const stockMap = byFacility(dataset.stocks);
  const bedMap = byFacility(dataset.beds);
  const staffMap = byFacility(dataset.staff);

  const facilityIndex: Record<string, FacilityView> = {};
  const views: FacilityView[] = dataset.facilities.map((facility) => {
    const stocks = stockMap[facility.id] ?? [];
    const beds = bedMap[facility.id] ?? [];
    const staff = staffMap[facility.id] ?? [];
    const risk = computeRisk(facility, stocks, beds, staff);
    const worst = [...stocks].sort((a, b) => daysOfSupply(a) - daysOfSupply(b))[0];
    const view: FacilityView = {
      facility,
      risk,
      stocks,
      beds,
      staff,
      occupancy: occupancyPct(beds),
      worstMedicine: worst
        ? { name: MEDICINES.find((m) => m.id === worst.medicineId)?.name ?? worst.medicineId, dos: daysOfSupply(worst) }
        : null,
    };
    facilityIndex[facility.id] = view;
    return view;
  });

  const districts: DistrictView[] = dataset.districts.map((d) => {
    const facilities = views.filter((v) => v.facility.districtId === d.id);
    const risks = facilities.map((f) => f.risk);
    const redPct = risks.length ? risks.filter((r) => r.tier === "RED").length / risks.length : 0;
    const composite = risks.length ? risks.reduce((n, r) => n + r.composite, 0) / risks.length : 0;
    return {
      id: d.id,
      name: d.name,
      emergencyMode: shouldEscalate(risks, d.redHoursStreak),
      redHoursStreak: d.redHoursStreak,
      facilities,
      redPct,
      composite,
      tier: tierOf(composite),
    };
  });

  const manifests = buildManifests(districts);
  const redFacilities = views.filter((v) => v.risk.tier === "RED").length;
  const stockoutIn24h = dataset.stocks.filter((s) => daysOfSupply(s) < 1).length;

  return {
    dataset,
    districts,
    facilityIndex,
    manifests,
    national: {
      composite: views.length ? views.reduce((n, v) => n + v.risk.composite, 0) / views.length : 0,
      tier: tierOf(views.length ? views.reduce((n, v) => n + v.risk.composite, 0) / views.length : 0),
      redFacilities,
      totalFacilities: views.length,
      occupancy: occupancyPct(dataset.beds),
      stockoutIn24h,
    },
  };
}

/** Medicine + bed + personnel matching, per §3.2 — all three resource classes. */
function buildManifests(districts: DistrictView[]): DispatchManifest[] {
  const all = districts.flatMap((d) => d.facilities);
  const emergencyFacility = new Set(
    districts.filter((d) => d.emergencyMode).flatMap((d) => d.facilities.map((f) => f.facility.id)),
  );
  const out: DispatchManifest[] = [];

  for (const med of MEDICINES) {
    const deficits: Parameters<typeof matchRedistribution>[0]["deficits"] = [];
    const surpluses: typeof deficits = [];
    for (const v of all) {
      const s = v.stocks.find((x) => x.medicineId === med.id);
      if (!s) continue;
      const em = emergencyFacility.has(v.facility.id);
      const cls = classifyStock(s, em);
      const dos = daysOfSupply(s);
      if (cls === "EMERGENCY" || cls === "WARNING") {
        const target = s.avgDailyConsumption * (ropDays(s) + 2);
        deficits.push({
          facility: v.facility,
          need: Math.max(1, target - s.onHand),
          severity: cls === "EMERGENCY" ? 1 : 0.6,
          daysToStockout: dos,
        });
      } else if (cls === "SURPLUS") {
        const spare = s.onHand - reorderPoint(s) - s.avgDailyConsumption * CONFIG.surplusBufferDays;
        if (spare > 0) surpluses.push({ facility: v.facility, need: spare, severity: 0, daysToStockout: dos });
      }
    }
    out.push(
      ...matchRedistribution({
        resourceType: "MEDICINE",
        label: med.name,
        deficits,
        surpluses,
        radiusKm: CONFIG.medicineRadiusKm,
        emergencyMode: districts.some((d) => d.emergencyMode),
      }),
    );
  }

  // Beds — matched by ward type (patient transfer routing)
  for (const ward of ["General", "ICU", "Maternity", "Isolation"] as const) {
    const deficits: Parameters<typeof matchRedistribution>[0]["deficits"] = [];
    const surpluses: typeof deficits = [];
    for (const v of all) {
      const b = v.beds.find((x) => x.wardType === ward);
      if (!b || b.total === 0) continue;
      const occ = (b.occupied / b.total) * 100;
      if (occ > 95) deficits.push({ facility: v.facility, need: Math.ceil(b.total * 0.1), severity: 1, daysToStockout: 0.5 });
      else if (occ < 60) surpluses.push({ facility: v.facility, need: b.total - b.occupied - 2, severity: 0, daysToStockout: 9 });
    }
    out.push(
      ...matchRedistribution({
        resourceType: "BED",
        label: `${ward} ward beds`,
        deficits,
        surpluses,
        radiusKm: CONFIG.bedRadiusKm,
      }),
    );
  }

  // Personnel — short-term secondment from roster surplus
  const staffDeficits: Parameters<typeof matchRedistribution>[0]["deficits"] = [];
  const staffSurpluses: typeof staffDeficits = [];
  for (const v of all) {
    const present = v.staff.reduce((n, s) => n + s.present, 0);
    const minSafe = v.staff.reduce((n, s) => n + s.minSafeStaffingCount, 0);
    if (present < minSafe) staffDeficits.push({ facility: v.facility, need: minSafe - present, severity: 1 - present / minSafe, daysToStockout: 1 });
    else if (present > minSafe + 2) staffSurpluses.push({ facility: v.facility, need: present - minSafe - 2, severity: 0, daysToStockout: 9 });
  }
  out.push(
    ...matchRedistribution({
      resourceType: "STAFF",
      label: "Clinical personnel secondment",
      deficits: staffDeficits,
      surpluses: staffSurpluses,
      radiusKm: CONFIG.staffRadiusKm,
    }),
  );

  return out.sort((a, b) => b.severity - a.severity || a.daysToStockout - b.daysToStockout);
}

/** 7 / 30 day forecast for a facility+medicine pair from seeded history. */
export function forecastFor(state: NationalState, facilityId: string, medicineId: string, horizonDays: number) {
  const view = state.facilityIndex[facilityId];
  const district = state.districts.find((d) => d.id === view?.facility.districtId);
  return forecastDemand({
    history: state.dataset.history[`${facilityId}:${medicineId}`] ?? [],
    horizonDays,
    monthIndex: new Date().getMonth(),
    emergencyMode: Boolean(district?.emergencyMode),
    catchmentPopulation: view?.facility.catchmentPopulation,
  });
}