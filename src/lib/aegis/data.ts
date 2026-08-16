/**
 * Seeded national dataset: 3 districts, WHO essential medicines, 4 ward types,
 * doctor/nurse/ANM/pharmacist rosters — enough real data for the heatmap,
 * redistribution engine and emergency-mode escalation to demonstrate against.
 */
import type { Bed, District, Facility, FlRound, Medicine, StaffRoster, StockSnapshot } from "./types";

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MEDICINES: Medicine[] = [
  { id: "med-amox", name: "Amoxicillin 500mg", whoEssential: true, unit: "caps" },
  { id: "med-insulin", name: "Insulin Regular", whoEssential: true, unit: "vials" },
  { id: "med-ors", name: "ORS Sachets", whoEssential: true, unit: "sachets" },
  { id: "med-dpt", name: "DPT Vaccine", whoEssential: true, unit: "doses" },
  { id: "med-para", name: "Paracetamol 500mg", whoEssential: true, unit: "tabs" },
];

export const WARD_TYPES: Bed["wardType"][] = ["General", "ICU", "Maternity", "Isolation"];
export const STAFF_ROLES: StaffRoster["role"][] = ["Doctor", "Nurse", "ANM", "Pharmacist"];

export const DISTRICTS: District[] = [
  { id: "dist-anantapur", name: "Anantapur", stateId: "st-ap", emergencyMode: false, redHoursStreak: 9 },
  { id: "dist-kurnool", name: "Kurnool", stateId: "st-ap", emergencyMode: false, redHoursStreak: 2 },
  { id: "dist-chittoor", name: "Chittoor", stateId: "st-ap", emergencyMode: false, redHoursStreak: 7 },
];

const DISTRICT_CENTERS: Record<string, [number, number]> = {
  "dist-anantapur": [14.68, 77.6],
  "dist-kurnool": [15.83, 78.04],
  "dist-chittoor": [13.21, 79.1],
};

const PLACE_NAMES: Record<string, string[]> = {
  "dist-anantapur": ["Anantapur Town", "Guntakal", "Dharmavaram", "Kalyandurg", "Rayadurg"],
  "dist-kurnool": ["Kurnool City", "Nandyal", "Adoni", "Yemmiganur", "Dhone"],
  "dist-chittoor": ["Chittoor Town", "Tirupati Rural", "Madanapalle", "Palamaner", "Srikalahasti"],
};

export interface AegisDataset {
  facilities: Facility[];
  districts: District[];
  stocks: StockSnapshot[];
  beds: Bed[];
  staff: StaffRoster[];
  history: Record<string, number[]>; // `${facilityId}:${medicineId}` -> 120 days
  flRounds: FlRound[];
}

export function buildDataset(seed = 42): AegisDataset {
  const rand = mulberry(seed);
  const facilities: Facility[] = [];
  const stocks: StockSnapshot[] = [];
  const beds: Bed[] = [];
  const staff: StaffRoster[] = [];
  const history: Record<string, number[]> = {};

  DISTRICTS.forEach((district, di) => {
    const [clat, clng] = DISTRICT_CENTERS[district.id] ?? [14, 78];
    (PLACE_NAMES[district.id] ?? []).forEach((place, fi) => {
      const facility: Facility = {
        id: `phc-${district.id.slice(5)}-${fi + 1}`,
        name: fi === 0 ? `District Hospital ${place}` : `PHC ${place}`,
        type: fi === 0 ? "DISTRICT_HOSPITAL" : "PHC",
        districtId: district.id,
        stateId: district.stateId,
        nationId: "nat-in",
        lat: clat + (rand() - 0.5) * 0.55,
        lng: clng + (rand() - 0.5) * 0.55,
        catchmentPopulation: 14000 + Math.round(rand() * 46000),
      };
      facilities.push(facility);

      MEDICINES.forEach((med, mi) => {
        const adc = 12 + Math.round(rand() * 90);
        // engineer a plausible stress pattern: Anantapur strained, Kurnool healthy
        const stressed = di === 0 && fi % 2 === 1;
        const flush = di === 1 || (di === 2 && fi % 2 === 0);
        const dosTarget = stressed
          ? 0.4 + rand() * 2.4
          : flush
            ? 26 + rand() * 24
            : 3 + rand() * 12;
        stocks.push({
          facilityId: facility.id,
          medicineId: med.id,
          onHand: Math.round(adc * dosTarget),
          onOrder: Math.round(rand() * adc),
          backorder: rand() > 0.85 ? Math.round(rand() * adc * 0.5) : 0,
          avgDailyConsumption: adc,
          sigmaDemand: adc * (0.18 + rand() * 0.2),
          leadTimeDays: 3 + Math.floor(rand() * 4),
          updatedAt: new Date().toISOString(),
        });
        history[`${facility.id}:${med.id}`] = Array.from({ length: 120 }, (_, d) => {
          const weekly = 1 + 0.15 * Math.sin((d / 7) * 2 * Math.PI + mi);
          const drift = 1 + d * 0.0012;
          return Math.max(0, Math.round(adc * weekly * drift * (0.85 + rand() * 0.3)));
        });
      });

      WARD_TYPES.forEach((ward) => {
        const total = ward === "ICU" ? 4 + Math.floor(rand() * 8) : 10 + Math.floor(rand() * 30);
        const pressure = di === 0 ? 0.78 + rand() * 0.24 : 0.5 + rand() * 0.4;
        beds.push({
          id: `bed-${facility.id}-${ward}`,
          facilityId: facility.id,
          wardType: ward,
          total,
          occupied: Math.min(total, Math.round(total * pressure)),
        });
      });

      STAFF_ROLES.forEach((role) => {
        const minSafe = role === "Doctor" ? 2 : role === "Nurse" ? 6 : 3;
        const gap = di === 0 && fi % 2 === 1 ? rand() * 0.5 : rand() * 0.2;
        staff.push({
          facilityId: facility.id,
          role,
          minSafeStaffingCount: minSafe,
          present: Math.max(0, Math.round(minSafe * (1 - gap))),
        });
      });
    });
  });

  return { facilities, districts: DISTRICTS, stocks, beds, staff, history, flRounds: seedFlRounds() };
}

function seedFlRounds(): FlRound[] {
  const nations = [
    ["nat-br", "Brazil"],
    ["nat-ru", "Russia"],
    ["nat-in", "India"],
    ["nat-cn", "China"],
    ["nat-za", "South Africa"],
  ] as const;
  const rounds: FlRound[] = [];
  for (let r = 12; r >= 9; r--) {
    nations.forEach(([id, name], i) => {
      rounds.push({
        id: `fl-${r}-${id}`,
        roundNumber: r,
        nationId: id,
        nation: name,
        dpEpsilon: 1.0,
        weightsHash: `0x${(0x9e3779b9 ^ (r * 131 + i * 17)).toString(16).slice(-8)}`,
        aggregateAccuracyDelta: Math.round((0.4 + ((r * 7 + i * 3) % 11) / 10) * 100) / 100,
        timestamp: new Date(Date.UTC(2026, 7, 16 - (12 - r) * 7, 3, 0)).toISOString(),
      });
    });
  }
  return rounds;
}