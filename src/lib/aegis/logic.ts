/**
 * AegisHealth BRICS — normative decision logic (Sections 3.1 - 3.4).
 * Pure functions, no I/O. These formulas are the contract; the UI only renders them.
 */
import type {
  Bed,
  DispatchManifest,
  Facility,
  ResourceType,
  RiskScore,
  StaffRoster,
  StockSnapshot,
  Tier,
} from "./types";

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export const CONFIG = {
  serviceLevelZ: 1.65, // 95% service level
  surplusBufferDays: 14,
  medicineRadiusKm: 35,
  bedRadiusKm: 50,
  staffRadiusKm: 50,
  transportSpeedKmh: 40,
  weights: { stock: 0.33, bed: 0.33, staff: 0.33 },
  emergency: { facilityPct: 0.3, hours: 6, thresholdTighten: 0.2, radiusBoost: 0.5 },
};

/* ---------------------------------------------------------------- 3.2 formulas */

export const inventoryPosition = (s: StockSnapshot) => s.onHand + s.onOrder - s.backorder;
export const safetyStock = (s: StockSnapshot, z = CONFIG.serviceLevelZ) =>
  z * s.sigmaDemand * Math.sqrt(s.leadTimeDays);
export const reorderPoint = (s: StockSnapshot) =>
  s.avgDailyConsumption * s.leadTimeDays + safetyStock(s);
export const ropDays = (s: StockSnapshot) =>
  s.avgDailyConsumption > 0 ? reorderPoint(s) / s.avgDailyConsumption : 0;
export const daysOfSupply = (s: StockSnapshot) =>
  s.avgDailyConsumption > 0 ? s.onHand / s.avgDailyConsumption : 99;

export type StockClass = "EMERGENCY" | "WARNING" | "OK" | "SURPLUS";
export function classifyStock(s: StockSnapshot, emergencyMode = false): StockClass {
  const t = emergencyMode ? 1 + CONFIG.emergency.thresholdTighten : 1;
  const dos = daysOfSupply(s);
  if (dos < 1 * t) return "EMERGENCY";
  if (dos < 3 * t) return "WARNING";
  if (dos > ropDays(s) + CONFIG.surplusBufferDays) return "SURPLUS";
  return "OK";
}

/** Haversine great-circle distance in km. */
export function haversineKm(a: Facility, b: Facility) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------------------------------------------------------------- 3.3 risk score */

export function tierOf(score: number): Tier {
  if (score > 0.6) return "RED";
  if (score >= 0.3) return "AMBER";
  return "GREEN";
}

export function occupancyPct(beds: Bed[]) {
  const total = beds.reduce((n, b) => n + b.total, 0);
  const occ = beds.reduce((n, b) => n + b.occupied, 0);
  return total ? (occ / total) * 100 : 0;
}

export function computeRisk(
  facility: Facility,
  stocks: StockSnapshot[],
  beds: Bed[],
  staff: StaffRoster[],
  weights = CONFIG.weights,
): RiskScore {
  // worst-case medicine drives StockRisk: a nation runs out one drug at a time
  const stockRisk = stocks.length
    ? Math.max(...stocks.map((s) => clamp(1 - daysOfSupply(s) / 3)))
    : 0;
  const bedRisk = clamp((occupancyPct(beds) - 70) / 30);
  const present = staff.reduce((n, s) => n + s.present, 0);
  const minSafe = staff.reduce((n, s) => n + s.minSafeStaffingCount, 0);
  const staffRisk = minSafe ? clamp(1 - present / minSafe) : 0;
  const composite =
    weights.stock * stockRisk + weights.bed * bedRisk + weights.staff * staffRisk;
  return {
    facilityId: facility.id,
    stockRisk,
    bedRisk,
    staffRisk,
    composite,
    tier: tierOf(composite),
  };
}

/** District auto-escalation: >Y% of facilities Red for >X consecutive hours. */
export function shouldEscalate(risks: RiskScore[], redHoursStreak: number) {
  if (!risks.length) return false;
  const redPct = risks.filter((r) => r.tier === "RED").length / risks.length;
  return redPct > CONFIG.emergency.facilityPct && redHoursStreak > CONFIG.emergency.hours;
}

/* ---------------------------------------------------------------- 3.1 forecasting */

/**
 * SARIMA-lite: additive decomposition of level + linear trend + weekly seasonality
 * + monsoon/flu-season regressor + emergency_mode exogenous flag.
 * Cold start (<90 days history): fall back to state per-capita rate x catchment.
 */
export function forecastDemand(opts: {
  history: number[]; // daily consumption, oldest -> newest
  horizonDays: number;
  monthIndex: number;
  emergencyMode: boolean;
  statePerCapitaRate?: number;
  catchmentPopulation?: number;
}) {
  const { history, horizonDays, monthIndex, emergencyMode } = opts;
  if (history.length < 90) {
    const base = (opts.statePerCapitaRate ?? 0.0004) * (opts.catchmentPopulation ?? 20000);
    return {
      modelVersion: "cold-start/state-per-capita-v1",
      daily: Array.from({ length: horizonDays }, () => round1(base)),
      total: round1(base * horizonDays),
    };
  }
  const n = history.length;
  const level = mean(history.slice(-14));
  const prev = mean(history.slice(-28, -14));
  const trendPerDay = (level - prev) / 14;
  const weekly = Array.from({ length: 7 }, (_, d) => {
    const vals = history.filter((_, i) => (n - 1 - i) % 7 === d);
    return vals.length ? mean(vals) / (level || 1) : 1;
  });
  // monsoon (Jun-Sep) and flu (Dec-Feb) seasonal regressors
  const monsoon = monthIndex >= 5 && monthIndex <= 8 ? 1.18 : 1;
  const flu = monthIndex === 11 || monthIndex <= 1 ? 1.12 : 1;
  const emergency = emergencyMode ? 1.35 : 1;
  const daily = Array.from({ length: horizonDays }, (_, k) => {
    const seasonal = weekly[(6 - (k % 7) + 7) % 7] ?? 1;
    return round1(Math.max(0, (level + trendPerDay * (k + 1)) * seasonal * monsoon * flu * emergency));
  });
  return {
    modelVersion: "sarima-lite/v1.3+exog",
    daily,
    total: round1(daily.reduce((a, b) => a + b, 0)),
  };
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round1 = (v: number) => Math.round(v * 10) / 10;

/* ---------------------------------------------------------------- 3.2 redistribution */

interface Node {
  facility: Facility;
  need: number; // units of deficit (or surplus if source)
  severity: number;
  daysToStockout: number;
}

/**
 * Greedy nearest-surplus-first min-cost matching over a radius-constrained
 * bipartite graph. Deficits ordered severity DESC, time-to-stockout ASC.
 */
export function matchRedistribution(args: {
  resourceType: ResourceType;
  label: string;
  deficits: Node[];
  surpluses: Node[];
  radiusKm: number;
  emergencyMode?: boolean;
}): DispatchManifest[] {
  const radius = args.radiusKm * (args.emergencyMode ? 1 + CONFIG.emergency.radiusBoost : 1);
  const sources = args.surpluses.map((s) => ({ ...s, remaining: s.need }));
  const sinks = [...args.deficits].sort(
    (a, b) => b.severity - a.severity || a.daysToStockout - b.daysToStockout,
  );
  const manifests: DispatchManifest[] = [];
  for (const sink of sinks) {
    let outstanding = Math.ceil(sink.need);
    const candidates = sources
      .map((s) => ({ s, d: haversineKm(s.facility, sink.facility) }))
      .filter((c) => c.d <= radius && c.s.remaining > 0)
      .sort((a, b) => a.d - b.d);
    for (const c of candidates) {
      if (outstanding <= 0) break;
      const qty = Math.min(outstanding, Math.floor(c.s.remaining));
      if (qty <= 0) continue;
      c.s.remaining -= qty;
      outstanding -= qty;
      manifests.push({
        id: `MF-${args.resourceType.slice(0, 3)}-${args.label.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 10)}-${manifests.length + 1}-${sink.facility.id}-${c.s.facility.id}`,
        resourceType: args.resourceType,
        label: args.label,
        sourceFacilityId: c.s.facility.id,
        destFacilityId: sink.facility.id,
        quantity: qty,
        distanceKm: Math.round(c.d * 10) / 10,
        etaHours: Math.round((c.d / CONFIG.transportSpeedKmh) * 10) / 10,
        severity: sink.severity,
        daysToStockout: sink.daysToStockout,
        status: "PENDING_APPROVAL",
        rationale: `${sink.facility.name} holds ${sink.daysToStockout.toFixed(1)} days of supply of ${args.label}. ${c.s.facility.name} carries surplus beyond its reorder point + ${CONFIG.surplusBufferDays}-day buffer at ${(Math.round(c.d * 10) / 10).toFixed(1)} km — the nearest eligible source inside the ${Math.round(radius)} km dispatch radius.`,
      });
    }
  }
  return manifests;
}

/* ---------------------------------------------------------------- 3.4 federated learning */

/**
 * WHY RAW CROSS-BORDER DATA TRANSMISSION IS STRUCTURALLY IMPOSSIBLE HERE
 * --------------------------------------------------------------------
 * A nation's client only ever emits a weight delta vector. That vector is
 * (1) max-norm clipped to sensitivity C, which bounds how much any single
 * facility-day record can influence it, and (2) perturbed with Gaussian noise
 * calibrated to (epsilon, delta). The transmitted payload therefore has a fixed
 * shape equal to the model's parameter count — it carries no rows, no facility
 * ids, and no per-record channel through which a record could be reconstructed.
 * FedAvg on the coordinator only averages these vectors. There is no code path
 * that serialises a ledger row for export; privacy is a property of the payload
 * shape, not of a policy someone must remember to enforce.
 */
export function clipAndNoise(delta: number[], opts: { clipNorm: number; epsilon: number; delta?: number; rng?: () => number }) {
  const { clipNorm, epsilon } = opts;
  const deltaP = opts.delta ?? 1e-5;
  const rng = opts.rng ?? Math.random;
  const norm = Math.sqrt(delta.reduce((a, v) => a + v * v, 0));
  const scale = norm > clipNorm ? clipNorm / norm : 1;
  const clipped = delta.map((v) => v * scale);
  // Gaussian mechanism: sigma = C * sqrt(2 ln(1.25/delta)) / epsilon
  const sigma = (clipNorm * Math.sqrt(2 * Math.log(1.25 / deltaP))) / epsilon;
  return clipped.map((v) => v + gaussian(rng) * sigma);
}

function gaussian(rng: () => number) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** FedAvg: sample-count weighted mean of noised client updates. */
export function fedAvg(updates: { weights: number[]; sampleCount: number }[]) {
  const first = updates[0];
  if (!first) return [];
  const total = updates.reduce((n, u) => n + u.sampleCount, 0);
  return first.weights.map((_, i) =>
    updates.reduce((acc, u) => acc + ((u.weights[i] ?? 0) * u.sampleCount) / total, 0),
  );
}

/** Personalization blend: global model never overwrites local weights outright. */
export function personalize(global: number[], local: number[], alpha = 0.6) {
  return global.map((g, i) => alpha * g + (1 - alpha) * (local[i] ?? g));
}

export function weightsHash(weights: number[]) {
  let h = 2166136261;
  for (const w of weights) {
    const x = Math.round(w * 1e6);
    h ^= x;
    h = Math.imul(h, 16777619);
  }
  return `0x${(h >>> 0).toString(16).padStart(8, "0")}`;
}